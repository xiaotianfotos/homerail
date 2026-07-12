import {
  validateGenerativeUiDocument,
  validateGenerativeUiTransaction,
  validateGenerativeUiUserOverride,
  validateHomerailPluginUiProjection,
  type GenerativeUiCompositionV1,
  type GenerativeUiDocumentV1,
} from 'homerail-protocol'
import type {
  GenerativeUiProjectionV1,
  GenerativeUiSnapshotStreamEventV1,
  GenerativeUiStreamEventV1,
} from './types'
import { normalizePendingAgentToolConfirmations } from './tool-confirmation'

export type GenerativeUiProjectionEventResult = 'applied_snapshot' | 'ignored_replay' | 'refresh_required'

const DEVICES = new Set(['phone', 'desktop', 'tv'])
const INPUTS = new Set(['touch', 'mouse', 'gamepad', 'voice'])
const VIEWPORTS = new Set(['compact', 'regular', 'wide'])
const ATTENTION = new Set(['glance', 'focused'])
const SURFACES = new Set(['task', 'execution', 'result', 'ambient'])
const VARIANTS = new Set(['glance', 'summary', 'detail'])
const PLACEMENTS = new Set(['primary', 'overflow'])
const VISIBILITIES = new Set(['visible', 'minimized'])

function assertComposition(document: GenerativeUiDocumentV1, composition: GenerativeUiCompositionV1): void {
  if (
    !composition
    || composition.composition_version !== 1
    || composition.document_id !== document.document_id
    || composition.document_revision !== document.revision
    || !Array.isArray(composition.items)
    || !Array.isArray(composition.hidden_node_ids)
  ) throw new Error('Invalid Generative UI composition envelope')
  const context = composition.context
  if (
    !context
    || !DEVICES.has(context.device)
    || !INPUTS.has(context.input)
    || !VIEWPORTS.has(context.viewport)
    || !ATTENTION.has(context.attention)
  ) throw new Error('Invalid Generative UI composition context')
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const partition = new Set<string>()
  composition.items.forEach((item, index) => {
    const node = nodes.get(item.node_id)
    if (!node || node.revision !== item.node_revision) {
      throw new Error(`Generative UI composition references a stale node: ${item.node_id}`)
    }
    if (
      !SURFACES.has(item.surface)
      || !VARIANTS.has(item.variant)
      || !PLACEMENTS.has(item.placement)
      || !VISIBILITIES.has(item.visibility)
      || typeof item.pinned !== 'boolean'
    ) throw new Error(`Invalid Generative UI composition item: ${item.node_id}`)
    if (item.rank !== index + 1) throw new Error('Generative UI composition ranks are not contiguous')
    if (partition.has(item.node_id)) throw new Error(`Duplicate Generative UI composition node: ${item.node_id}`)
    partition.add(item.node_id)
  })
  for (const nodeId of composition.hidden_node_ids) {
    if (!nodes.has(nodeId) || partition.has(nodeId)) {
      throw new Error(`Invalid Generative UI hidden node partition: ${nodeId}`)
    }
    partition.add(nodeId)
  }
  if (partition.size !== nodes.size) throw new Error('Generative UI composition does not partition the document')
}

function assertProjection(projection: GenerativeUiProjectionV1): GenerativeUiProjectionV1 {
  if (
    projection.stream_version !== 1
    || !(
      (projection.mode === 'shadow'
        && projection.authoritative === false
        && projection.purpose === 'legacy_widget_shadow')
      || (projection.mode === 'prefer'
        && projection.authoritative === true
        && projection.purpose === 'canonical')
    )
    || !Number.isSafeInteger(projection.cursor)
    || projection.cursor < 0
  ) throw new Error('Invalid Generative UI projection envelope')
  const documentValidation = validateGenerativeUiDocument(projection.document)
  if (!documentValidation.valid) throw new Error('Invalid Generative UI projection document')
  for (const override of projection.overrides) {
    const validation = validateGenerativeUiUserOverride(override)
    if (!validation.valid || override.document_id !== projection.document.document_id) {
      throw new Error(`Invalid Generative UI projection override: ${override.node_id}`)
    }
  }
  const uiRegistryValidation = validateHomerailPluginUiProjection(projection.ui_registry)
  if (!uiRegistryValidation.valid) throw new Error('Invalid Generative UI plugin registry projection')
  assertComposition(projection.document, projection.composition)
  const pendingValue = (projection as unknown as Record<string, unknown>).pending_tool_confirmations
  if (projection.mode === 'prefer') {
    return {
      ...structuredClone(projection),
      pending_tool_confirmations: normalizePendingAgentToolConfirmations(pendingValue),
    }
  } else if (pendingValue !== undefined && (!Array.isArray(pendingValue) || pendingValue.length !== 0)) {
    throw new Error('Invalid Generative UI shadow projection Tool confirmation authority')
  }
  return structuredClone(projection)
}

function projectionFromSnapshot(event: GenerativeUiSnapshotStreamEventV1): GenerativeUiProjectionV1 {
  const base = {
    stream_version: event.stream_version,
    document: event.document,
    cursor: event.cursor,
    overrides: event.overrides,
    composition: event.composition,
    ui_registry: event.ui_registry,
  }
  return event.mode === 'prefer'
    ? {
        ...base,
        mode: event.mode,
        authoritative: event.authoritative,
        purpose: event.purpose,
        pending_tool_confirmations: event.pending_tool_confirmations,
      }
    : {
        ...base,
        mode: event.mode,
        authoritative: event.authoritative,
        purpose: event.purpose,
      }
}

/** Read-only projection cache. Manager remains the only document reducer and Composer. */
export class GenerativeUiProjectionCache {
  #projection: GenerativeUiProjectionV1 | null = null
  #stale = false

  get stale(): boolean {
    return this.#stale
  }

  get cursor(): number {
    return this.#projection?.cursor ?? 0
  }

  current(): GenerativeUiProjectionV1 | null {
    return this.#projection ? structuredClone(this.#projection) : null
  }

  acceptProjection(projection: GenerativeUiProjectionV1): void {
    this.#projection = assertProjection(projection)
    this.#stale = false
  }

  acceptStreamEvent(event: GenerativeUiStreamEventV1): GenerativeUiProjectionEventResult {
    if (event.event === 'snapshot') {
      this.acceptProjection(projectionFromSnapshot(event))
      return 'applied_snapshot'
    }
    if (!this.#projection) {
      this.#stale = true
      return 'refresh_required'
    }
    if (event.document_id !== this.#projection.document.document_id) {
      this.#stale = true
      return 'refresh_required'
    }
    if (event.seq <= this.#projection.cursor) return 'ignored_replay'
    const validation = validateGenerativeUiTransaction(event.transaction)
    if (
      !validation.valid
      || event.transaction.document_id !== event.document_id
      || event.transaction.transaction_id !== event.transaction_id
      || event.transaction.base_revision + 1 !== event.committed_revision
      || event.revision !== event.committed_revision
    ) throw new Error(`Invalid Generative UI transaction stream event: ${event.transaction_id}`)
    // The composition is Manager-owned. A new transaction invalidates both the
    // cached document and the composed placement; refetch the atomic projection.
    this.#stale = true
    return 'refresh_required'
  }

  clear(): void {
    this.#projection = null
    this.#stale = false
  }
}

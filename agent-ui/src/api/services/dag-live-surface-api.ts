import {
  validateGenerativeUiDocument,
  type GenerativeUiDocumentV1,
} from 'homerail-protocol'
import { http, type ApiResponse } from '@/api/clients/http-client'

export type DagLiveSurfaceActivityState =
  | 'started'
  | 'progress'
  | 'finding'
  | 'blocked'
  | 'completed'
  | 'failed'

export type DagLiveSurfaceVisibilityState = 'visible' | 'focused' | 'removed'

export interface DagLiveSurfaceProjectionRecord {
  run_id: string
  actor_id: string
  node_id: string
  surface_id: string
  document_id: string
  generation: number
  last_activity_sequence: number
  journal_cursor: number
  surface_revision: number
  activity_state: DagLiveSurfaceActivityState
  visibility_state: DagLiveSurfaceVisibilityState
  last_event_id?: string
  focused_until?: number
  created_at: number
  updated_at: number
}

export interface DagLiveSurfaceSnapshot {
  run_id: string
  projections: DagLiveSurfaceProjectionRecord[]
  document: GenerativeUiDocumentV1 | null
}

const ACTIVITY_STATES = new Set<DagLiveSurfaceActivityState>([
  'started',
  'progress',
  'finding',
  'blocked',
  'completed',
  'failed',
])
const VISIBILITY_STATES = new Set<DagLiveSurfaceVisibilityState>(['visible', 'focused', 'removed'])

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid DAG live surface response: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid DAG live surface response: ${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label)
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid DAG live surface response: ${label} must be a non-negative safe integer`)
  }
  return Number(value)
}

function activityState(value: unknown): DagLiveSurfaceActivityState {
  if (!ACTIVITY_STATES.has(value as DagLiveSurfaceActivityState)) {
    throw new Error('Invalid DAG live surface response: activity_state is invalid')
  }
  return value as DagLiveSurfaceActivityState
}

function visibilityState(value: unknown): DagLiveSurfaceVisibilityState {
  if (!VISIBILITY_STATES.has(value as DagLiveSurfaceVisibilityState)) {
    throw new Error('Invalid DAG live surface response: visibility_state is invalid')
  }
  return value as DagLiveSurfaceVisibilityState
}

function normalizeProjection(value: unknown): DagLiveSurfaceProjectionRecord {
  const record = objectValue(value, 'projection')
  return {
    run_id: requiredString(record.run_id, 'run_id'),
    actor_id: requiredString(record.actor_id, 'actor_id'),
    node_id: requiredString(record.node_id, 'node_id'),
    surface_id: requiredString(record.surface_id, 'surface_id'),
    document_id: requiredString(record.document_id, 'document_id'),
    generation: safeInteger(record.generation, 'generation'),
    last_activity_sequence: safeInteger(record.last_activity_sequence, 'last_activity_sequence'),
    journal_cursor: safeInteger(record.journal_cursor, 'journal_cursor'),
    surface_revision: safeInteger(record.surface_revision, 'surface_revision'),
    activity_state: activityState(record.activity_state),
    visibility_state: visibilityState(record.visibility_state),
    ...(optionalString(record.last_event_id, 'last_event_id')
      ? { last_event_id: String(record.last_event_id) }
      : {}),
    ...(record.focused_until === undefined
      ? {}
      : { focused_until: safeInteger(record.focused_until, 'focused_until') }),
    created_at: safeInteger(record.created_at, 'created_at'),
    updated_at: safeInteger(record.updated_at, 'updated_at'),
  }
}

function projectedData(node: GenerativeUiDocumentV1['nodes'][number]): Record<string, unknown> {
  const content = objectValue(node.content, `node ${node.id} content`)
  return objectValue(content.data, `node ${node.id} content.data`)
}

function verifyProjectedNode(
  node: GenerativeUiDocumentV1['nodes'][number],
  projection: DagLiveSurfaceProjectionRecord,
): void {
  const data = projectedData(node)
  const projector = objectValue(data.projector, `node ${node.id} projector`)
  const actor = objectValue(data.actor, `node ${node.id} actor`)
  const state = objectValue(data.state, `node ${node.id} state`)
  if (
    node.id !== projection.surface_id
    || node.kind !== 'com.homerail.core/generated_view'
    || node.kind_version !== 2
    || node.owner.id !== 'com.homerail.core'
    || node.provenance?.run_id !== projection.run_id
    || node.provenance?.actor_id !== projection.actor_id
    || projector.id !== 'dag-live-surface-projector'
    || projector.version !== 1
    || actor.id !== projection.actor_id
    || actor.node_id !== projection.node_id
    || state.activity !== projection.activity_state
    || state.visibility !== projection.visibility_state
    || state.surface_revision !== projection.surface_revision
  ) {
    throw new Error(`Invalid DAG live surface response: node ${node.id} does not match its projection`)
  }
}

export function normalizeDagLiveSurfaceSnapshot(
  value: unknown,
  expectedRunId?: string,
): DagLiveSurfaceSnapshot {
  const record = objectValue(value, 'snapshot')
  const runId = requiredString(record.run_id, 'run_id')
  if (expectedRunId && runId !== expectedRunId) {
    throw new Error(`Invalid DAG live surface response: expected run ${expectedRunId}, received ${runId}`)
  }
  if (!Array.isArray(record.projections)) {
    throw new Error('Invalid DAG live surface response: projections must be an array')
  }
  const projections = record.projections.map(normalizeProjection)
  const actorIds = new Set<string>()
  const surfaceIds = new Set<string>()
  for (const projection of projections) {
    if (projection.run_id !== runId) {
      throw new Error('Invalid DAG live surface response: projection run_id mismatch')
    }
    if (actorIds.has(projection.actor_id) || surfaceIds.has(projection.surface_id)) {
      throw new Error('Invalid DAG live surface response: duplicate actor or surface projection')
    }
    actorIds.add(projection.actor_id)
    surfaceIds.add(projection.surface_id)
  }

  let document: GenerativeUiDocumentV1 | null = null
  if (record.document === null) {
    if (projections.some(projection => projection.visibility_state !== 'removed')) {
      throw new Error('Invalid DAG live surface response: active projections require a document')
    }
  } else {
    const validation = validateGenerativeUiDocument(record.document)
    if (!validation.value || validation.errors.length) {
      throw new Error('Invalid DAG live surface response: document failed protocol validation')
    }
    document = structuredClone(validation.value)
    if (document.scope.type !== 'run' || document.scope.id !== runId) {
      throw new Error('Invalid DAG live surface response: document run scope mismatch')
    }
    const projectionBySurface = new Map(projections.map(projection => [projection.surface_id, projection]))
    const nodeIds = new Set(document.nodes.map(node => node.id))
    for (const node of document.nodes) {
      const projection = projectionBySurface.get(node.id)
      if (!projection || projection.visibility_state === 'removed') {
        throw new Error(`Invalid DAG live surface response: node ${node.id} has no active projection`)
      }
      if (projection.document_id !== document.document_id) {
        throw new Error('Invalid DAG live surface response: projection document_id mismatch')
      }
      verifyProjectedNode(node, projection)
    }
    for (const projection of projections) {
      if (projection.visibility_state === 'removed') continue
      if (projection.document_id !== document.document_id || !nodeIds.has(projection.surface_id)) {
        throw new Error(`Invalid DAG live surface response: active projection ${projection.surface_id} has no node`)
      }
    }
  }

  return { run_id: runId, projections, document }
}

export async function getDagLiveSurfaces(
  runId: string,
): Promise<ApiResponse<DagLiveSurfaceSnapshot>> {
  const response = await http.get<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/live-surfaces`,
  )
  return {
    ...response,
    data: normalizeDagLiveSurfaceSnapshot(response.data, runId),
  }
}

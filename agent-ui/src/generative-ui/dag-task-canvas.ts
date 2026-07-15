import type {
  GenerativeUiCompositionV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'
import type { DagLiveSurfaceSnapshot } from '@/api/services/dag-live-surface-api'

function activeNodes(snapshot: DagLiveSurfaceSnapshot): Map<string, GenerativeUiStoredNodeV1> {
  return new Map(snapshot.document?.nodes.map(node => [node.id, node]) ?? [])
}

function visibleNodeIds(snapshot: DagLiveSurfaceSnapshot): Set<string> {
  const nodes = activeNodes(snapshot)
  return new Set(snapshot.projections.flatMap(projection => (
    projection.visibility_state !== 'removed' && nodes.has(projection.surface_id)
      ? [projection.surface_id]
      : []
  )))
}

export function createDagTaskCanvasComposition(
  snapshot: DagLiveSurfaceSnapshot,
  context: GenerativeUiSurfaceContextV1,
): GenerativeUiCompositionV1 | null {
  if (!snapshot.document) return null
  const nodes = activeNodes(snapshot)
  const items = snapshot.projections.flatMap((projection) => {
    const node = nodes.get(projection.surface_id)
    if (!node || projection.visibility_state === 'removed') return []
    return [{
      node_id: node.id,
      node_revision: node.revision,
      surface: node.surface,
      variant: node.presentation?.density ?? 'summary',
      rank: 0,
      placement: 'primary' as const,
      pinned: projection.visibility_state === 'focused',
      visibility: 'visible' as const,
    }]
  }).map((item, rank) => ({ ...item, rank }))
  return {
    composition_version: 1,
    document_id: snapshot.document.document_id,
    document_revision: snapshot.document.revision,
    context,
    items,
    hidden_node_ids: [],
  }
}

export function projectorFocusedSurface(snapshot: DagLiveSurfaceSnapshot): {
  nodeId: string
  focusedUntil?: number
} | null {
  const nodes = activeNodes(snapshot)
  const focused = snapshot.projections
    .filter(projection => (
      projection.visibility_state === 'focused'
      && nodes.has(projection.surface_id)
      && (projection.focused_until === undefined || projection.focused_until >= Date.now())
    ))
    .sort((left, right) => right.updated_at - left.updated_at)[0]
  return focused
    ? { nodeId: focused.surface_id, ...(focused.focused_until === undefined ? {} : { focusedUntil: focused.focused_until }) }
    : null
}

export function resolveDagTaskCanvasSelection(
  snapshot: DagLiveSurfaceSnapshot,
  currentNodeId?: string | null,
  storedNodeId?: string | null,
): string {
  const visible = visibleNodeIds(snapshot)
  const focused = projectorFocusedSurface(snapshot)
  if (focused) return focused.nodeId
  if (currentNodeId && visible.has(currentNodeId)) return currentNodeId
  if (storedNodeId && visible.has(storedNodeId)) return storedNodeId
  return snapshot.projections
    .filter(projection => visible.has(projection.surface_id))
    .sort((left, right) => right.updated_at - left.updated_at)[0]?.surface_id ?? ''
}

export function dagTaskCanvasSnapshotVersion(snapshot: DagLiveSurfaceSnapshot): string {
  return [
    snapshot.run_id,
    snapshot.document?.document_id ?? '',
    snapshot.document?.revision ?? -1,
    ...snapshot.projections.map(projection => [
      projection.actor_id,
      projection.surface_id,
      projection.surface_revision,
      projection.activity_state,
      projection.visibility_state,
      projection.focused_until ?? '',
    ].join(':')),
    ...(snapshot.surface_states ?? []).map(state => [
      state.actor_id,
      state.surface_id,
      state.superseded_count,
      state.latest_intervention?.operation ?? '',
      state.latest_intervention?.status ?? '',
      state.latest_intervention?.created_at ?? '',
    ].join(':')),
  ].join('|')
}

function projectionVersion(projection: DagLiveSurfaceSnapshot['projections'][number]): string {
  return [
    projection.run_id,
    projection.actor_id,
    projection.node_id,
    projection.surface_id,
    projection.document_id,
    projection.generation,
    projection.last_activity_sequence,
    projection.journal_cursor,
    projection.surface_revision,
    projection.activity_state,
    projection.visibility_state,
    projection.last_event_id ?? '',
    projection.focused_until ?? '',
    projection.created_at,
    projection.updated_at,
  ].join(':')
}

function surfaceStateVersion(state: NonNullable<DagLiveSurfaceSnapshot['surface_states']>[number]): string {
  return [
    state.actor_id,
    state.surface_id,
    state.generation_state,
    state.superseded_count,
    state.latest_intervention?.intervention_id ?? '',
    state.latest_intervention?.operation ?? '',
    state.latest_intervention?.status ?? '',
    state.latest_intervention?.created_at ?? '',
  ].join(':')
}

/** Keep unaffected cards referentially stable while one Actor changes generation. */
export function reconcileDagTaskCanvasSnapshot(
  previous: DagLiveSurfaceSnapshot | null,
  next: DagLiveSurfaceSnapshot,
): DagLiveSurfaceSnapshot {
  if (!previous || previous.run_id !== next.run_id) return next

  const previousProjections = new Map(previous.projections.map(item => [item.actor_id, item]))
  const projections = next.projections.map((item) => {
    const prior = previousProjections.get(item.actor_id)
    return prior && projectionVersion(prior) === projectionVersion(item) ? prior : item
  })

  const previousStates = new Map((previous.surface_states ?? []).map(item => [item.actor_id, item]))
  const surfaceStates = (next.surface_states ?? []).map((item) => {
    const prior = previousStates.get(item.actor_id)
    return prior && surfaceStateVersion(prior) === surfaceStateVersion(item) ? prior : item
  })

  let document = next.document
  if (
    previous.document
    && document
    && previous.document.document_id === document.document_id
  ) {
    const previousNodes = new Map(previous.document.nodes.map(node => [node.id, node]))
    document = {
      ...document,
      nodes: document.nodes.map((node) => {
        const prior = previousNodes.get(node.id)
        return prior && prior.revision === node.revision ? prior : node
      }),
    }
  }

  return {
    ...next,
    projections,
    surface_states: surfaceStates,
    document,
  }
}

export function dagTaskCanvasSelectionStorageKey(runId: string): string {
  return `homerail.dag-task-canvas.selection.${runId}`
}

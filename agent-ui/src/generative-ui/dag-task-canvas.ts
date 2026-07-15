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
  ].join('|')
}

export function dagTaskCanvasSelectionStorageKey(runId: string): string {
  return `homerail.dag-task-canvas.selection.${runId}`
}

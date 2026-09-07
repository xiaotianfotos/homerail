export interface DagRuntimeSelectionSnapshot {
  loaded: boolean
  requestedRunId: string
  loadedRunId: string | null | undefined
  nodeCount: number
}

/** A failed selection must never reuse a graph retained from another run. */
export function hasLoadedDagRunGraph(
  snapshot: DagRuntimeSelectionSnapshot,
): boolean {
  return snapshot.loaded
    && snapshot.loadedRunId === snapshot.requestedRunId
    && snapshot.nodeCount > 0
}

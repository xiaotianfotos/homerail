import { describe, expect, it } from 'vitest'

import { hasLoadedDagRunGraph } from './dagRuntimeSelection'

describe('DAG runtime run selection', () => {
  it('rejects a retained graph when the requested run failed to load', () => {
    expect(hasLoadedDagRunGraph({
      loaded: false,
      requestedRunId: 'run-new',
      loadedRunId: 'run-old',
      nodeCount: 3,
    })).toBe(false)
  })

  it('accepts only a non-empty graph for the exact requested run', () => {
    expect(hasLoadedDagRunGraph({
      loaded: true,
      requestedRunId: 'run-new',
      loadedRunId: 'run-new',
      nodeCount: 2,
    })).toBe(true)
    expect(hasLoadedDagRunGraph({
      loaded: true,
      requestedRunId: 'run-new',
      loadedRunId: 'run-other',
      nodeCount: 2,
    })).toBe(false)
  })
})

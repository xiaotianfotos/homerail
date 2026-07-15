import { describe, expect, it, vi } from 'vitest'
import type { DagLiveSurfaceSnapshot } from '@/api/services/dag-live-surface-api'
import {
  createDagTaskCanvasComposition,
  dagTaskCanvasSelectionStorageKey,
  projectorFocusedSurface,
  resolveDagTaskCanvasSelection,
} from './dag-task-canvas'

function snapshot(): DagLiveSurfaceSnapshot {
  const actors = ['build', 'research', 'verify']
  return {
    run_id: 'run:one',
    projections: actors.map((actor, index) => ({
      run_id: 'run:one',
      actor_id: actor,
      node_id: `node:${actor}`,
      surface_id: `surface:${actor}`,
      document_id: 'document:run:one',
      generation: 1,
      last_activity_sequence: 1,
      journal_cursor: index + 1,
      surface_revision: 1,
      activity_state: 'progress',
      visibility_state: 'visible',
      created_at: 100,
      updated_at: 100 + index,
    })),
    document: {
      ir_version: 1,
      document_id: 'document:run:one',
      scope: { type: 'run', id: 'run:one' },
      revision: 1,
      nodes: actors.map(actor => ({
        ir_version: 1,
        id: `surface:${actor}`,
        kind: 'com.homerail.core/generated_view',
        kind_version: 2,
        owner: { id: 'com.homerail.core', version: '0.1.0' },
        surface: 'execution',
        importance: 'primary',
        content: {},
        presentation: { density: 'summary' },
        fallback: { title: actor },
        revision: 1,
        updated_at: '2026-07-15T10:00:00.000Z',
      })),
      updated_at: '2026-07-15T10:00:00.000Z',
    },
  }
}

const context = {
  device: 'desktop',
  input: 'mouse',
  viewport: 'wide',
  attention: 'focused',
  active_run_id: 'run:one',
} as const

describe('DAG task canvas composition', () => {
  it('creates three ordered 1x2 Worker Blocks from projector order', () => {
    const composition = createDagTaskCanvasComposition(snapshot(), context)
    expect(composition?.items.map(item => ({ id: item.node_id, variant: item.variant, rank: item.rank })))
      .toEqual([
        { id: 'surface:build', variant: 'summary', rank: 0 },
        { id: 'surface:research', variant: 'summary', rank: 1 },
        { id: 'surface:verify', variant: 'summary', rank: 2 },
      ])
  })

  it('restores Manager focus first, then current, stored, and latest selection', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const value = snapshot()
    value.projections[1]!.visibility_state = 'focused'
    value.projections[1]!.focused_until = 2_000
    expect(projectorFocusedSurface(value)).toEqual({ nodeId: 'surface:research', focusedUntil: 2_000 })
    expect(resolveDagTaskCanvasSelection(value, 'surface:build', 'surface:verify')).toBe('surface:research')

    value.projections[1]!.visibility_state = 'visible'
    expect(resolveDagTaskCanvasSelection(value, 'surface:build', 'surface:verify')).toBe('surface:build')
    expect(resolveDagTaskCanvasSelection(value, '', 'surface:verify')).toBe('surface:verify')
    expect(resolveDagTaskCanvasSelection(value)).toBe('surface:verify')
    vi.useRealTimers()
  })

  it('omits removed surfaces while keeping one task bounded to one Block', () => {
    const value = snapshot()
    value.projections[1]!.visibility_state = 'removed'
    value.document!.nodes.splice(1, 1)
    expect(createDagTaskCanvasComposition(value, context)?.items.map(item => item.node_id))
      .toEqual(['surface:build', 'surface:verify'])
    expect(dagTaskCanvasSelectionStorageKey('run:one')).toContain('run:one')
  })

  it('does not restore a current or stored selection after that Block is removed', () => {
    const value = snapshot()
    value.projections[0]!.visibility_state = 'removed'
    value.document!.nodes = value.document!.nodes.filter(node => node.id !== 'surface:build')

    expect(resolveDagTaskCanvasSelection(value, 'surface:build', 'surface:build'))
      .toBe('surface:verify')
  })
})

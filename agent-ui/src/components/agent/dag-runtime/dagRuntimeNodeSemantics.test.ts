import { describe, expect, it } from 'vitest'

import { resolveDagRuntimeNodeSemantic } from './dagRuntimeNodeSemantics'

describe('DAG runtime node semantics', () => {
  it('keeps agent tasks visually identified as workers', () => {
    expect(resolveDagRuntimeNodeSemantic('agent')).toMatchObject({
      kind: 'worker',
      shape: 'circle',
      label: 'WORKER',
      isWorker: true
    })
  })

  it('distinguishes deterministic condition gates from workers', () => {
    expect(resolveDagRuntimeNodeSemantic('condition_gateway')).toMatchObject({
      kind: 'condition',
      shape: 'diamond',
      label: 'GATE',
      glyph: '?',
      isWorker: false
    })
  })

  it('shows n-of-m joins as quorum nodes with their threshold', () => {
    expect(
      resolveDagRuntimeNodeSemantic('join_gateway', { mode: 'n_of_m', threshold: 2 })
    ).toMatchObject({
      kind: 'quorum',
      shape: 'hexagon',
      label: 'QUORUM',
      glyph: '2/n',
      isWorker: false
    })
    expect(resolveDagRuntimeNodeSemantic('join_gateway', { mode: 'all' })).toMatchObject({
      kind: 'join',
      label: 'JOIN'
    })
  })

  it.each([
    ['command_gateway', 'command', 'rounded-rect'],
    ['approval_gateway', 'approval', 'octagon'],
    ['state_gateway', 'state', 'square'],
    ['fanout_gateway', 'fanout', 'triangle'],
    ['loop_gateway', 'loop', 'capsule'],
    ['while_gateway', 'loop', 'capsule'],
    ['await_command_gateway', 'await', 'capsule']
  ])('maps %s to a distinct control primitive', (nodeType, kind, shape) => {
    expect(resolveDagRuntimeNodeSemantic(nodeType)).toMatchObject({ kind, shape, isWorker: false })
  })

  it('treats future gateway primitives as Manager-owned control nodes', () => {
    expect(resolveDagRuntimeNodeSemantic('future_gateway')).toMatchObject({
      kind: 'control',
      label: 'CONTROL',
      isWorker: false
    })
  })
})

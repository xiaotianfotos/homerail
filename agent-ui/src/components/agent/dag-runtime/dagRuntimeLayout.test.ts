import { describe, expect, it } from 'vitest'
import {
  dedupeDagRuntimeEdges,
  layoutDagRuntimeGraph,
  type DagRuntimeLayoutNode,
} from './dagRuntimeLayout'

describe('DAG runtime layout', () => {
  it('deduplicates coincident runtime port edges by node pair', () => {
    const edges = dedupeDagRuntimeEdges([
      { id: 'data', source: 'review', target: 'verify' },
      { id: 'after', source: 'review', target: 'verify' },
      { id: 'next', source: 'verify', target: 'consensus' },
    ])

    expect(edges.map(edge => edge.id)).toEqual(['data', 'next'])
  })

  it('keeps dense fan-out and fan-in nodes in non-overlapping visual bounds', () => {
    const nodes: DagRuntimeLayoutNode[] = [
      { id: 'prepare', width: 180, height: 116 },
      { id: 'review_a', width: 220, height: 124 },
      { id: 'review_b', width: 220, height: 124 },
      { id: 'review_c', width: 220, height: 124 },
      { id: 'arbitrate', width: 236, height: 124 },
      { id: 'verify_a', width: 220, height: 124 },
      { id: 'verify_b', width: 220, height: 124 },
      { id: 'verify_c', width: 220, height: 124 },
      { id: 'consensus', width: 190, height: 116 },
    ]
    const edges = [
      ...['review_a', 'review_b', 'review_c'].map(target => ({ source: 'prepare', target })),
      ...['review_a', 'review_b', 'review_c'].map(source => ({ source, target: 'arbitrate' })),
      ...['verify_a', 'verify_b', 'verify_c'].map(target => ({ source: 'arbitrate', target })),
      ...['verify_a', 'verify_b', 'verify_c'].map(source => ({ source, target: 'consensus' })),
    ]

    const positions = layoutDagRuntimeGraph(nodes, edges)

    expect(positions).toHaveLength(nodes.length)
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const aPosition = positions.get(a.id)!
        const bPosition = positions.get(b.id)!
        const overlapsX = Math.abs(aPosition.x - bPosition.x) < (a.width + b.width) / 2
        const overlapsY = Math.abs(aPosition.y - bPosition.y) < (a.height + b.height) / 2
        expect(overlapsX && overlapsY, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }

    expect(positions.get('prepare')!.x).toBeLessThan(positions.get('arbitrate')!.x)
    expect(positions.get('arbitrate')!.x).toBeLessThan(positions.get('consensus')!.x)
  })

  it('is deterministic regardless of duplicate runtime edges', () => {
    const nodes = [
      { id: 'a', width: 120, height: 100 },
      { id: 'b', width: 180, height: 110 },
    ]
    const once = layoutDagRuntimeGraph(nodes, [{ source: 'a', target: 'b' }])
    const duplicated = layoutDagRuntimeGraph(nodes, [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
    ])

    expect([...duplicated.entries()]).toEqual([...once.entries()])
  })

  it('keeps adjacent ranks compact while preserving their visual bounds', () => {
    const nodes = [
      { id: 'source', width: 120, height: 100 },
      { id: 'target', width: 180, height: 110 },
    ]
    const positions = layoutDagRuntimeGraph(nodes, [{ source: 'source', target: 'target' }])
    const centerDistance = positions.get('target')!.x - positions.get('source')!.x

    expect(centerDistance).toBeGreaterThanOrEqual((nodes[0].width + nodes[1].width) / 2)
    expect(centerDistance).toBeLessThanOrEqual(230)
  })
})

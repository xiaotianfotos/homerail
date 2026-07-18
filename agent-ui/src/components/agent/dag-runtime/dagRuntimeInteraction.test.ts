import { describe, expect, it } from 'vitest'

import { isDagCanvasClick, pinDagCanvasNode } from './dagRuntimeInteraction'

describe('DAG runtime canvas interaction', () => {
  it('treats a stationary pointer as a click regardless of node-center offset', () => {
    expect(isDagCanvasClick({ x: 480, y: 620 }, { x: 480, y: 620 })).toBe(true)
    expect(isDagCanvasClick({ x: 520, y: 660 }, { x: 521, y: 660 })).toBe(true)
  })

  it('treats pointer travel beyond the threshold as a drag', () => {
    expect(isDagCanvasClick({ x: 480, y: 620 }, { x: 483, y: 620 })).toBe(false)
  })

  it('pins a dragged node at its new position', () => {
    const node = {
      x: 100,
      y: 200,
      targetX: 120,
      targetY: 220,
      vx: 4,
      vy: -3,
      manuallyPositioned: false,
    }

    pinDagCanvasNode(node, { x: 360, y: 410 })

    expect(node).toEqual({
      x: 360,
      y: 410,
      targetX: 360,
      targetY: 410,
      vx: 0,
      vy: 0,
      manuallyPositioned: true,
    })
  })
})

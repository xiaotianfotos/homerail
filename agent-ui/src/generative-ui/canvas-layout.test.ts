import { describe, expect, it } from 'vitest'
import { canvasColumnCount, canvasRowCount, defaultCanvasSize, resolveCanvasSize } from './canvas-layout'

describe('generated UI canvas layout', () => {
  it('keeps legacy density hints useful when a Block has no explicit footprint', () => {
    expect(defaultCanvasSize('glance')).toBe('1x1')
    expect(defaultCanvasSize('summary')).toBe('1x2')
    expect(defaultCanvasSize('detail')).toBe('2x2')
  })

  it('honors every supported footprint on a wide desktop canvas', () => {
    const context = { device: 'desktop', viewport: 'wide' } as const
    for (const size of ['1x1', '1x2', '2x2', '3x3'] as const) {
      expect(resolveCanvasSize(size, 'detail', context)).toBe(size)
    }
  })

  it('downgrades footprints that cannot fit compact and TV surfaces', () => {
    expect(resolveCanvasSize('3x3', 'detail', { device: 'phone', viewport: 'compact' })).toBe('1x2')
    expect(resolveCanvasSize('1x1', 'glance', { device: 'phone', viewport: 'compact' })).toBe('1x1')
    expect(resolveCanvasSize('3x3', 'detail', { device: 'tv', viewport: 'wide' })).toBe('2x2')
  })

  it('keeps the 1080p-class wide canvas at three columns and two rows', () => {
    const wideDesktop = { device: 'desktop', viewport: 'wide' } as const
    expect(canvasColumnCount(wideDesktop)).toBe(3)
    expect(canvasRowCount(['1x1', '1x2', '2x2'])).toBe(2)
    expect(canvasRowCount(['1x1', '3x3'])).toBe(3)
  })

  it('reduces column count for TV and compact interaction distances', () => {
    expect(canvasColumnCount({ device: 'tv', viewport: 'wide' })).toBe(2)
    expect(canvasColumnCount({ device: 'desktop', viewport: 'compact' })).toBe(1)
    expect(canvasColumnCount({ device: 'phone', viewport: 'wide' })).toBe(1)
  })
})

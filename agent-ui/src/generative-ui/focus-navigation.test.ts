import { describe, expect, it } from 'vitest'
import { resolveGenerativeUiFocusIndex } from './focus-navigation'

describe('Generative UI focus navigation', () => {
  it('supports keyboard and Gamepad next/previous wrapping', () => {
    expect(resolveGenerativeUiFocusIndex(0, 3, 'next')).toBe(1)
    expect(resolveGenerativeUiFocusIndex(2, 3, 'next')).toBe(0)
    expect(resolveGenerativeUiFocusIndex(0, 3, 'previous')).toBe(2)
    expect(resolveGenerativeUiFocusIndex(1, 3, 'previous')).toBe(0)
  })

  it('supports first/last and empty surfaces', () => {
    expect(resolveGenerativeUiFocusIndex(1, 3, 'first')).toBe(0)
    expect(resolveGenerativeUiFocusIndex(1, 3, 'last')).toBe(2)
    expect(resolveGenerativeUiFocusIndex(0, 0, 'next')).toBe(-1)
  })
})

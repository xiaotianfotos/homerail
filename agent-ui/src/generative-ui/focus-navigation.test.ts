import { describe, expect, it } from 'vitest'
import { focusGenerativeUiNode, resolveGenerativeUiFocusIndex } from './focus-navigation'

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

  it('focuses the card without changing its internal reading position', () => {
    const target = document.createElement('article')
    const body = document.createElement('div')
    body.className = 'generative-ui-node-host__body'
    body.scrollTop = 72
    target.appendChild(body)
    const focusOptions: FocusOptions[] = []
    const scrollOptions: ScrollIntoViewOptions[] = []
    target.focus = options => { focusOptions.push(options ?? {}) }
    target.scrollIntoView = options => { scrollOptions.push(options ?? {}) }

    focusGenerativeUiNode(target, 'auto')

    expect(focusOptions).toEqual([{ preventScroll: true }])
    expect(scrollOptions).toEqual([{ behavior: 'auto', block: 'nearest', inline: 'start' }])
    expect(body.scrollTop).toBe(72)
  })
})

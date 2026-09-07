import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTouchActivation } from './touch-activation'

const TAP_X = 20
const TAP_Y = 20

function pointerEvent(
  type: string,
  init: Partial<PointerEvent> & { pointerId: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries({
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: TAP_X,
    clientY: TAP_Y,
    ...init,
  })) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

// The browser fires its touch compatibility click at the touch coordinates
// with MouseEvent.detail === click count (>= 1), so tests that emulate it must
// pass those coordinates. A MouseEvent built with no init has clientX/clientY
// === 0 and detail === 0, which on a real device only happens for keyboard /
// assistive-tech / programmatic activation — none of which are the
// compatibility click and none of which this bridge may suppress.
function compatClick(x: number = TAP_X, y: number = TAP_Y): MouseEvent {
  return new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y })
}

describe('touch activation bridge', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('activates a click-driven button on touch pointer-up exactly once', () => {
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1 }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    expect(onClick).toHaveBeenCalledOnce()

    button.dispatchEvent(compatClick())
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('passes through native mouse, keyboard, and programmatic click activation', () => {
    // Mouse pointer-up clears all pending suppressions and never arms one of
    // its own, so the following real mouse click (detail >= 1) is not
    // suppressed. Keyboard Enter/Space and programmatic el.click() dispatch
    // detail === 0 events, which the onClick early-return always exempts.
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 2,
      pointerType: 'mouse',
    }))
    button.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 2,
      pointerType: 'mouse',
    }))
    // Real mouse click (detail === 1) must pass through untouched.
    button.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: TAP_X,
      clientY: TAP_Y,
    }))
    // Programmatic el.click() (detail === 0) must also pass through.
    button.click()

    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('does not suppress a real mouse click (detail >= 1) that follows a touch tap', () => {
    // Pins the mouse-clear branch in onPointerUp: a touch tap arms a
    // suppression at the tap location, then a genuine mouse click at the same
    // coordinates must still run. The mouse pointer-up must clear the armed
    // touch suppression before the click arrives.
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    // Touch tap: synthetic click fires once.
    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 12 }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 12 }))
    expect(onClick).toHaveBeenCalledOnce()

    // A subsequent real mouse click at the same spot must NOT be swallowed.
    button.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 13,
      pointerType: 'mouse',
    }))
    button.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 13,
      pointerType: 'mouse',
    }))
    button.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: TAP_X,
      clientY: TAP_Y,
    }))
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('does not activate when a touch gesture becomes a scroll', () => {
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3 }))
    button.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 3,
      clientY: 80,
    }))
    button.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 3,
      clientY: 80,
    }))

    expect(onClick).not.toHaveBeenCalled()
  })

  it('supports role buttons and ignores disabled controls', () => {
    const roleButton = document.createElement('div')
    roleButton.setAttribute('role', 'button')
    const disabledButton = document.createElement('button')
    disabledButton.disabled = true
    const onRoleClick = vi.fn()
    const onDisabledClick = vi.fn()
    roleButton.addEventListener('click', onRoleClick)
    disabledButton.addEventListener('click', onDisabledClick)
    document.body.append(roleButton, disabledButton)
    cleanup = installTouchActivation(document)

    roleButton.dispatchEvent(pointerEvent('pointerdown', { pointerId: 4 }))
    roleButton.dispatchEvent(pointerEvent('pointerup', { pointerId: 4 }))
    disabledButton.dispatchEvent(pointerEvent('pointerdown', { pointerId: 5 }))
    disabledButton.dispatchEvent(pointerEvent('pointerup', { pointerId: 5 }))

    expect(onRoleClick).toHaveBeenCalledOnce()
    expect(onDisabledClick).not.toHaveBeenCalled()
  })

  it('does not swallow a non-compatibility activation of the same control within the suppression window', () => {
    // Regression for the prior target-identity matcher: if the browser never
    // emits a compatibility click for the tap (e.g. an upstream handler
    // preventDefaults touchstart), the bridge must leave genuine activations
    // — keyboard Enter/Space, programmatic el.click(), assistive-tech — intact.
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 6 }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 6 }))
    expect(onClick).toHaveBeenCalledOnce()

    // No compat click was emitted yet, so the suppression is still armed when
    // a keyboard-style activation (clientX/clientY === 0) arrives. It must run.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('consumes pending suppressions per tap rather than from a single shared slot (list mechanism)', () => {
    // Regression for the single-slot pendingNativeClick: two synthetic
    // activations that arm suppressions at different locations must each
    // suppress their own compatibility click instead of one overwriting the
    // other, which previously let the first control's handler double-fire.
    // Both taps here are primary pointers; this exercises the pending list
    // directly. Real multi-touch hardware only has one primary touch contact
    // at a time (see the next test for that realistic case).
    const buttonA = document.createElement('button')
    const buttonB = document.createElement('button')
    const onClickA = vi.fn()
    const onClickB = vi.fn()
    buttonA.addEventListener('click', onClickA)
    buttonB.addEventListener('click', onClickB)
    document.body.append(buttonA, buttonB)
    cleanup = installTouchActivation(document)

    buttonA.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, clientX: 10, clientY: 10 }))
    buttonB.dispatchEvent(pointerEvent('pointerdown', { pointerId: 8, clientX: 90, clientY: 90 }))
    buttonA.dispatchEvent(pointerEvent('pointerup', { pointerId: 7, clientX: 10, clientY: 10 }))
    buttonB.dispatchEvent(pointerEvent('pointerup', { pointerId: 8, clientX: 90, clientY: 90 }))
    expect(onClickA).toHaveBeenCalledOnce()
    expect(onClickB).toHaveBeenCalledOnce()

    // Both delayed compatibility clicks arrive; each must be matched to its own
    // tap location and suppressed, so neither handler runs a second time.
    buttonA.dispatchEvent(compatClick(10, 10))
    buttonB.dispatchEvent(compatClick(90, 90))
    expect(onClickA).toHaveBeenCalledOnce()
    expect(onClickB).toHaveBeenCalledOnce()
  })

  it('only the primary touch contact triggers synthetic activation; a second finger falls back to the native click', () => {
    // Per the Pointer Events model there is at most one primary pointer per
    // type, so a real second touch contact has isPrimary === false. It must
    // not fire a synthetic click (the onPointerDown guard skips it); its
    // activation is delivered later by the browser's native compatibility
    // click, and — because no pending suppression was armed for it — that
    // click runs the handler exactly once. This pins the intended
    // single-primary-finger behavior of the bridge.
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 30, clientY: 30, isPrimary: false }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 30, clientY: 30, isPrimary: false }))
    // No synthetic activation for the non-primary finger.
    expect(onClick).not.toHaveBeenCalled()

    // The browser's compatibility click then runs the handler once.
    button.dispatchEvent(compatClick(30, 30))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('suppresses a compatibility click retargeted to a different element after a DOM mutation', () => {
    // Regression for the ghost-click window: the synthetic click may mutate the
    // DOM under the tap point (open a popover, close the fullscreen gate), so
    // the browser can retarget the delayed compatibility click onto a different
    // element at the same coordinates. Matching by location — not target
    // identity — ensures it is still suppressed.
    const button = document.createElement('button')
    const onButtonClick = vi.fn()
    button.addEventListener('click', onButtonClick)
    document.body.appendChild(button)
    const laterSibling = document.createElement('a')
    laterSibling.setAttribute('href', '#')
    const onSiblingClick = vi.fn()
    laterSibling.addEventListener('click', onSiblingClick)
    document.body.appendChild(laterSibling)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10 }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 10 }))
    expect(onButtonClick).toHaveBeenCalledOnce()

    // The compatibility click lands at the original tap coordinates but on a
    // freshly rendered sibling element. It is the same physical tap, so it must
    // not cause a second navigation/activation.
    laterSibling.dispatchEvent(compatClick(TAP_X, TAP_Y))
    expect(onSiblingClick).not.toHaveBeenCalled()
  })

  it('still suppresses a real compatibility click landing at viewport (0,0)', () => {
    // Regression for the origin heuristic: a genuine touch tap at the extreme
    // top-left corner produces a compatibility click at clientX/Y === 0 with
    // detail === 1. Unlike keyboard/AT/programmatic activation (detail === 0),
    // this IS the compatibility click for an armed tap and must be suppressed,
    // otherwise the control would activate twice for one physical tap.
    const button = document.createElement('button')
    const onClick = vi.fn()
    button.addEventListener('click', onClick)
    document.body.appendChild(button)
    cleanup = installTouchActivation(document)

    button.dispatchEvent(pointerEvent('pointerdown', { pointerId: 11, clientX: 0, clientY: 0 }))
    button.dispatchEvent(pointerEvent('pointerup', { pointerId: 11, clientX: 0, clientY: 0 }))
    expect(onClick).toHaveBeenCalledOnce()

    button.dispatchEvent(compatClick(0, 0))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

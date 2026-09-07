const ACTIVATABLE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'summary',
].join(',')

const MAX_TAP_DISTANCE_PX = 12
const MAX_TAP_DURATION_MS = 800
const SYNTHETIC_CLICK_WINDOW_MS = 750
// The browser fires its compatibility click at (almost) exactly the touch
// coordinates, so we match pending suppressions by location rather than by
// target identity. This both lets us suppress a compat click that the browser
// retargets to a different element after the synthetic click mutates the DOM,
// and avoids swallowing a genuine activation of the same control (which is how
// the prior target-identity matcher mis-fired).
const COMPAT_CLICK_TOLERANCE_PX = MAX_TAP_DISTANCE_PX

interface ActiveTouchPointer {
  target: HTMLElement
  startX: number
  startY: number
  startedAt: number
}

interface PendingCompatClick {
  x: number
  y: number
  expiresAt: number
}

function isTouchPointer(event: PointerEvent): boolean {
  return event.pointerType === 'touch' || event.pointerType === 'pen'
}

function resolveActivatable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const activatable = target.closest<HTMLElement>(ACTIVATABLE_SELECTOR)
  if (!activatable || !activatable.isConnected) return null
  if (
    activatable.matches(':disabled') ||
    activatable.getAttribute('aria-disabled') === 'true' ||
    activatable.hasAttribute('inert') ||
    activatable.closest('[inert]')
  ) {
    return null
  }
  return activatable
}

function pointerTravelledTooFar(
  pointer: ActiveTouchPointer,
  event: PointerEvent,
): boolean {
  return Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > MAX_TAP_DISTANCE_PX
}

/**
 * Makes the app's existing click-driven controls respond directly to touch and
 * pen pointer-up events. The browser-generated compatibility click is then
 * suppressed so Vue handlers still run exactly once. Mouse clicks and keyboard
 * activation continue through the browser's native click path.
 */
export function installTouchActivation(root: Document | HTMLElement = document): () => void {
  const activePointers = new Map<number, ActiveTouchPointer>()
  // One entry per in-flight touch/pen tap whose compatibility click has not
  // been consumed yet. A list (rather than a single slot) is required so that
  // concurrent multi-touch taps each suppress their own compatibility click
  // instead of one tap overwriting another's pending suppression.
  const pendingCompatClicks: PendingCompatClick[] = []
  let dispatchingSyntheticClick = false

  const pruneExpired = (): void => {
    const now = performance.now()
    for (let i = pendingCompatClicks.length - 1; i >= 0; i--) {
      if (pendingCompatClicks[i].expiresAt <= now) {
        pendingCompatClicks.splice(i, 1)
      }
    }
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!isTouchPointer(event) || !event.isPrimary || event.button !== 0) return
    const target = resolveActivatable(event.target)
    if (!target) return
    activePointers.set(event.pointerId, {
      target,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
    })
  }

  const onPointerMove = (event: PointerEvent) => {
    const pointer = activePointers.get(event.pointerId)
    if (pointer && pointerTravelledTooFar(pointer, event)) {
      activePointers.delete(event.pointerId)
    }
  }

  const onPointerCancel = (event: PointerEvent) => {
    activePointers.delete(event.pointerId)
  }

  const onPointerUp = (event: PointerEvent) => {
    // A genuine mouse pointer-up means the user switched to mouse input; any
    // click that follows is a real activation and must never be suppressed.
    if (!isTouchPointer(event)) {
      pendingCompatClicks.length = 0
      return
    }
    const pointer = activePointers.get(event.pointerId)
    activePointers.delete(event.pointerId)
    if (!pointer || pointerTravelledTooFar(pointer, event)) return
    if (performance.now() - pointer.startedAt > MAX_TAP_DURATION_MS) return

    const target = resolveActivatable(event.target)
    if (!target || target !== pointer.target) return

    pendingCompatClicks.push({
      x: event.clientX,
      y: event.clientY,
      expiresAt: performance.now() + SYNTHETIC_CLICK_WINDOW_MS,
    })
    dispatchingSyntheticClick = true
    try {
      target.click()
    } finally {
      dispatchingSyntheticClick = false
    }
  }

  const onClick = (event: MouseEvent) => {
    if (dispatchingSyntheticClick) return
    pruneExpired()
    if (pendingCompatClicks.length === 0) return
    // Keyboard Enter/Space activation, assistive-tech activation, and
    // programmatic el.click() are not real pointer-driven clicks: per the UI
    // Events spec they carry MouseEvent.detail === 0, whereas a real mouse or
    // touch-compatibility click carries detail >= 1. Only the former must never
    // be suppressed (they are genuine activations of the focused control, even
    // when a recent touch tap armed a suppression at the same location). A real
    // compatibility click landing at the viewport corner (clientX/Y === 0) is
    // therefore still matched by location and suppressed.
    if (event.detail === 0) return
    for (let i = 0; i < pendingCompatClicks.length; i++) {
      const pending = pendingCompatClicks[i]
      if (
        performance.now() <= pending.expiresAt &&
        Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= COMPAT_CLICK_TOLERANCE_PX
      ) {
        pendingCompatClicks.splice(i, 1)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
    }
  }

  root.addEventListener('pointerdown', onPointerDown as EventListener, true)
  root.addEventListener('pointermove', onPointerMove as EventListener, true)
  root.addEventListener('pointercancel', onPointerCancel as EventListener, true)
  root.addEventListener('pointerup', onPointerUp as EventListener, true)
  root.addEventListener('click', onClick as EventListener, true)

  return () => {
    root.removeEventListener('pointerdown', onPointerDown as EventListener, true)
    root.removeEventListener('pointermove', onPointerMove as EventListener, true)
    root.removeEventListener('pointercancel', onPointerCancel as EventListener, true)
    root.removeEventListener('pointerup', onPointerUp as EventListener, true)
    root.removeEventListener('click', onClick as EventListener, true)
    activePointers.clear()
    pendingCompatClicks.length = 0
  }
}

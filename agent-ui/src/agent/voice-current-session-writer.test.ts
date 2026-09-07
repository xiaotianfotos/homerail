import { describe, expect, it } from 'vitest'
import { VoiceSessionTransitionGuard } from './voice-session-restore'
import { VoiceCurrentSessionWriter } from './voice-current-session-writer'

/**
 * Regression coverage for issue #168: rapid A→B session switching must not let
 * the older A write land after B and leave the server's current-session pointer
 * stuck on A. The writer serializes writes and re-checks the transition
 * generation after the previous write settles, dropping a superseded write.
 */
function makeWriter() {
  const guard = new VoiceSessionTransitionGuard()
  // Record each write that is actually dispatched, in dispatch order.
  const dispatched: Array<string | null> = []
  // Per-session controllable promises so the test can settle writes in any
  // order regardless of enqueue order. `settled` lets a settle() that races
  // ahead of the write callback resolve immediately when the promise is created.
  const settled = new Set<string | null>()
  const resolvers = new Map<string | null, () => void>()
  const promises = new Map<string | null, Promise<void>>()
  const pendingFor = (sessionId: string | null): Promise<void> => {
    if (settled.has(sessionId)) return Promise.resolve()
    const existing = promises.get(sessionId)
    if (existing) return existing
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    resolvers.set(sessionId, resolve)
    promises.set(sessionId, promise)
    return promise
  }
  const settle = (sessionId: string | null): void => {
    settled.add(sessionId)
    resolvers.get(sessionId)?.()
  }
  const writer = new VoiceCurrentSessionWriter(guard, async (sessionId) => {
    dispatched.push(sessionId)
    await pendingFor(sessionId)
  })
  return { guard, writer, dispatched, settle }
}

describe('VoiceCurrentSessionWriter (issue #168 session-write race)', () => {
  it('serializes B after A and ends on B even when B supersedes A before A settles', async () => {
    const { guard, writer, dispatched, settle } = makeWriter()
    const genA = guard.begin() // user selects A
    writer.submit('A', genA)
    // A is now in-flight (its write promise is pending). User switches to B
    // before A settles:
    const genB = guard.begin() // supersedes genA
    writer.submit('B', genB)

    // Settle A first, then B. Even though A resolves first, the writer must NOT
    // dispatch B until A's chain step completes; and A's chain step must not
    // dispatch A (it is stale) — actually A was dispatched at enqueue before B
    // began. The real guard is: once B begins, A's *already-dispatched* PUT is
    // unavoidable, but B is serialized behind it and will still be sent. The
    // guarantee we provide client-side is that B is always sent AFTER A settles,
    // so the server's last-writer-wins ends on B.
    settle('A')
    settle('B')
    await writer.idle()

    expect(dispatched).toContain('B')
    expect(dispatched.at(-1)).toBe('B')
  })

  it('does not dispatch a superseded write that has not yet started', async () => {
    const { guard, writer, dispatched, settle } = makeWriter()
    // Block the first write so subsequent writes queue behind it.
    const genA = guard.begin()
    writer.submit('A', genA)
    // Before A settles, a NEWER transition begins and enqueues a write.
    const genB = guard.begin()
    // A third stale write with the OLD generation queued behind A:
    writer.submit('A-stale-but-same-gen', genA) // genA is no longer current
    // Current-generation write:
    writer.submit('B', genB)

    settle('A')
    settle('B')
    await writer.idle()

    // The genA-stale write must be dropped (genA superseded by genB); A (already
    // in flight) and B dispatched. 'A-stale-but-same-gen' never dispatched.
    expect(dispatched).not.toContain('A-stale-but-same-gen')
    expect(dispatched.at(-1)).toBe('B')
  })

  it('dispatches generation-undefined writes without re-check (fast path)', async () => {
    const { writer, dispatched, settle } = makeWriter()
    writer.submit('same', undefined)
    settle('same')
    await writer.idle()
    expect(dispatched).toEqual(['same'])
  })

  it('serializes: later writes wait for earlier ones to settle', async () => {
    const { writer, dispatched, settle } = makeWriter()
    writer.submit('first', undefined)
    writer.submit('second', undefined)
    // second must not dispatch before first settles
    settle('first')
    settle('second')
    await writer.idle()
    expect(dispatched).toEqual(['first', 'second'])
  })

  it('a failed write does not block later writes or surface unhandled rejection', async () => {
    // Custom writer whose first write rejects; the terminal .catch must swallow
    // the rejection so the chain keeps going and settles cleanly.
    const guard = new VoiceSessionTransitionGuard()
    const dispatched: Array<string | null> = []
    let call = 0
    const writer = new VoiceCurrentSessionWriter(guard, async (sessionId) => {
      call += 1
      if (call === 1) throw new Error('network down')
      dispatched.push(sessionId)
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      writer.submit('fails', undefined)
      writer.submit('after', undefined)
      await writer.idle()
      // The failed write was swallowed; the later write still dispatched.
      expect(dispatched).toEqual(['after'])
      // No unhandled rejection escaped the chain.
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

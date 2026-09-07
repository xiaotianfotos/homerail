import type { VoiceSessionTransitionGuard } from './voice-session-restore'

/**
 * Serialized, generation-gated writer for PUT /api/voice-agent/current-session.
 *
 * The server write is a blind last-writer-wins UPSERT, so fire-and-forget
 * calls during rapid A→B session switching could let an older A request land
 * AFTER B and leave the server pointer stuck on A (issue #168).
 *
 * This writer chains every write onto the previous one and re-checks the
 * transition generation after the previous write settles: if a newer transition
 * has begun (the user switched again), the stale write is dropped instead of
 * dispatched. Extracted from AgentVoiceCockpit so the policy is unit-testable.
 */
export class VoiceCurrentSessionWriter {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly guard: VoiceSessionTransitionGuard,
    private readonly write: (sessionId: string | null) => Promise<unknown>,
  ) {}

  /**
   * Enqueue a current-session write.
   * - `generation === undefined`: skip the re-check (the "already current"
   *   fast path is mutually exclusive with the full switch flow).
   * - otherwise: re-check `guard.isCurrent(generation)` after the previous write
   *   settles and drop this write if a newer transition has superseded it.
   */
  submit(sessionId: string | null, generation: number | undefined): void {
    const run = async (): Promise<void> => {
      if (generation !== undefined && !this.guard.isCurrent(generation)) return
      await this.write(sessionId)
    }
    // `.then(run, run)` resumes the chain on rejection (so one failed write
    // never blocks later writes). The terminal `.catch` swallows any rejection
    // from the LAST queued write so it does not surface as an unhandled promise
    // rejection — the caller treats current-session writes as best-effort.
    this.pending = this.pending.then(run, run).catch(() => undefined)
  }

  /** Resolved only when every enqueued write has settled. Test-only helper. */
  idle(): Promise<unknown> {
    return this.pending
  }
}

/**
 * Deterministic ASR transcription deadline control for the Agent Voice Cockpit.
 *
 * The WebSocket connection timeout (5 s) and the transcription wait are separate
 * clocks. Native realtime and unknown strategies keep the historical 9 s deadline,
 * while batch-style strategies (`emulated_batch`, `ark_voice`) receive a bounded
 * adaptive deadline based on the audio duration actually sent:
 *
 *   clamp(15000 ms + 2 * capturedAudioMs, 30000 ms, 120000 ms)
 *
 * `session.ready` records the strategy for the connection; `transcription.processing`
 * may confirm or promote the pending utterance to the batch deadline recomputed from
 * the original finish timestamp. Repeated events are idempotent and can never slide
 * the absolute deadline past the formula. All per-utterance state (audio duration,
 * timer, resolver/rejector) is cleared on every terminal lifecycle path.
 */

export type AsrTranscriptionStrategy = 'native_realtime' | 'emulated_batch' | 'ark_voice'

/** WebSocket connection establishment budget; unrelated to transcription speed. */
export const ASR_CONNECTION_TIMEOUT_MS = 5000

/** Existing transcription deadline kept for native realtime and unknown strategies. */
export const NATIVE_ASR_TRANSCRIPTION_DEADLINE_MS = 9000

/** Batch-style deadline formula: clamp(base + factor * audio, min, max). */
export const BATCH_ASR_DEADLINE_BASE_MS = 15000
export const BATCH_ASR_DEADLINE_AUDIO_FACTOR = 2
export const BATCH_ASR_DEADLINE_MIN_MS = 30000
export const BATCH_ASR_DEADLINE_MAX_MS = 120000

export const ASR_TRANSCRIPTION_TIMEOUT_MESSAGE = 'ASR transcription timed out'
export const ASR_SESSION_DISCONNECTED_MESSAGE = 'ASR realtime session disconnected'
export const ASR_UTTERANCE_SUPERSEDED_MESSAGE = 'ASR transcription superseded by next utterance'

const ASR_TRANSCRIPTION_STRATEGIES: readonly AsrTranscriptionStrategy[] = [
  'native_realtime',
  'emulated_batch',
  'ark_voice'
]

/** True only for the exact protocol strategy literals; anything else fails closed. */
export function isAsrTranscriptionStrategy(value: unknown): value is AsrTranscriptionStrategy {
  return (
    typeof value === 'string' &&
    (ASR_TRANSCRIPTION_STRATEGIES as readonly string[]).includes(value)
  )
}

/** Normalizes an event-carried strategy; invalid, absent, or malformed values yield null. */
export function normalizeAsrStrategy(value: unknown): AsrTranscriptionStrategy | null {
  return isAsrTranscriptionStrategy(value) ? value : null
}

/** Batch-style strategies process the whole recording after `finish`. */
export function isBatchAsrStrategy(value: unknown): value is AsrTranscriptionStrategy {
  return value === 'emulated_batch' || value === 'ark_voice'
}

/** clamp(15000 + 2 * capturedAudioMs, 30000, 120000). */
export function computeBatchTranscriptionDeadlineMs(capturedAudioMs: number): number {
  const safeAudioMs =
    Number.isFinite(capturedAudioMs) && capturedAudioMs > 0 ? capturedAudioMs : 0
  const rawDeadlineMs =
    BATCH_ASR_DEADLINE_BASE_MS + BATCH_ASR_DEADLINE_AUDIO_FACTOR * safeAudioMs
  return Math.min(BATCH_ASR_DEADLINE_MAX_MS, Math.max(BATCH_ASR_DEADLINE_MIN_MS, rawDeadlineMs))
}

/** Deadline for an utterance: 9 s default, bounded adaptive formula for batch strategies. */
export function computeTranscriptionDeadlineMs(
  strategy: AsrTranscriptionStrategy | null,
  capturedAudioMs: number
): number {
  if (!isBatchAsrStrategy(strategy)) return NATIVE_ASR_TRANSCRIPTION_DEADLINE_MS
  return computeBatchTranscriptionDeadlineMs(capturedAudioMs)
}

/** Injectable clock/scheduler so tests stay deterministic without real waits. */
export interface AsrDeadlineScheduler {
  now(): number
  setTimeout(handler: () => void, delayMs: number): number
  clearTimeout(handle: number): void
}

export function createDefaultAsrDeadlineScheduler(): AsrDeadlineScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
    clearTimeout: handle => window.clearTimeout(handle)
  }
}

export interface AsrTranscriptionDeadlineOptions {
  scheduler?: AsrDeadlineScheduler
  defaultTimeoutMessage?: string
}

/** Promise and terminal callbacks scoped to the utterance created by finish(). */
export interface AsrTranscriptionAttempt {
  readonly utteranceId: number
  readonly promise: Promise<string>
  resolve(text: string): void
  reject(error: Error): void
}

interface PendingAsrUtterance {
  id: number
  resolve: (text: string) => void
  reject: (error: Error) => void
  finishedAt: number
  capturedAudioMs: number
  deadlineAt: number
  timer: number
  timeoutMessage: string
}

export class AsrTranscriptionDeadlineController {
  private readonly scheduler: AsrDeadlineScheduler
  private readonly defaultTimeoutMessage: string
  /** Session-scoped strategy recorded from session.ready / transcription.processing. */
  private sessionStrategy: AsrTranscriptionStrategy | null = null
  /** Audio duration (ms) actually sent to the active ASR socket for this utterance. */
  private capturedAudioMs = 0
  private pending: PendingAsrUtterance | null = null
  private utteranceSequence = 0

  constructor(options: AsrTranscriptionDeadlineOptions = {}) {
    this.scheduler = options.scheduler ?? createDefaultAsrDeadlineScheduler()
    this.defaultTimeoutMessage = options.defaultTimeoutMessage ?? ASR_TRANSCRIPTION_TIMEOUT_MESSAGE
  }

  getSessionStrategy(): AsrTranscriptionStrategy | null {
    return this.sessionStrategy
  }

  getCapturedAudioMs(): number {
    return this.capturedAudioMs
  }

  hasPendingUtterance(): boolean {
    return this.pending !== null
  }

  /** Records a valid strategy announced by `session.ready`; invalid values fail closed. */
  handleSessionReady(strategy: unknown): void {
    this.applyStrategy(strategy)
  }

  /**
   * Consumes `transcription.processing`. A valid strategy may confirm or promote the
   * pending utterance to the matching batch deadline, recomputed from the original
   * finish timestamp so repeated events never slide the absolute deadline.
   */
  handleTranscriptionProcessing(strategy: unknown): void {
    this.applyStrategy(strategy)
  }

  private applyStrategy(strategy: unknown): void {
    const normalized = normalizeAsrStrategy(strategy)
    if (!normalized) return
    this.sessionStrategy = normalized
    const pending = this.pending
    if (!pending || !isBatchAsrStrategy(normalized)) return
    const promotedDeadlineAt =
      pending.finishedAt + computeBatchTranscriptionDeadlineMs(pending.capturedAudioMs)
    if (promotedDeadlineAt <= pending.deadlineAt) return
    pending.deadlineAt = promotedDeadlineAt
    this.scheduler.clearTimeout(pending.timer)
    const remainingMs = Math.max(0, promotedDeadlineAt - this.scheduler.now())
    pending.timer = this.scheduler.setTimeout(() => this.handleTimeout(pending.id), remainingMs)
  }

  /** Starts a new utterance: settles any pending one and resets per-utterance audio. */
  beginUtterance(): void {
    this.supersedePending()
    this.capturedAudioMs = 0
  }

  /** Counts audio actually sent to the open ASR socket toward the current utterance. */
  recordSentAudio(sampleCount: number, sampleRate: number): void {
    if (!Number.isFinite(sampleCount) || !Number.isFinite(sampleRate)) return
    if (sampleCount <= 0 || sampleRate <= 0) return
    this.capturedAudioMs += (sampleCount / sampleRate) * 1000
  }

  /**
   * Ends capture and waits for the transcript. Any earlier pending utterance is
   * rejected deterministically so it is never orphaned.
   */
  finish(options: { timeoutMessage?: string } = {}): AsrTranscriptionAttempt {
    const finishedAt = this.scheduler.now()
    const capturedAudioMs = this.capturedAudioMs
    this.supersedePending()
    this.capturedAudioMs = 0
    const deadlineMs = computeTranscriptionDeadlineMs(this.sessionStrategy, capturedAudioMs)
    const deadlineAt = finishedAt + deadlineMs
    const utteranceId = ++this.utteranceSequence
    const timeoutMessage = options.timeoutMessage ?? this.defaultTimeoutMessage
    const promise = new Promise<string>((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => this.handleTimeout(utteranceId), deadlineMs)
      this.pending = {
        id: utteranceId,
        resolve,
        reject,
        finishedAt,
        capturedAudioMs,
        deadlineAt,
        timer,
        timeoutMessage
      }
    })
    return {
      utteranceId,
      promise,
      resolve: (text: string) => this.resolveUtterance(utteranceId, text),
      reject: (error: Error) => this.rejectUtterance(utteranceId, error)
    }
  }

  /** Settles only the matching pending utterance with the final transcript. */
  private resolveUtterance(utteranceId: number, text: string): void {
    const pending = this.takePending(utteranceId)
    if (!pending) return
    this.capturedAudioMs = 0
    pending.resolve(text)
  }

  /** Settles only the matching pending utterance with an error. */
  private rejectUtterance(utteranceId: number, error: Error): void {
    const pending = this.takePending(utteranceId)
    if (!pending) return
    this.capturedAudioMs = 0
    pending.reject(error)
  }

  /**
   * Terminal session path (disconnect/stop): clears strategy, audio, and timers, and
   * settles any pending utterance so nothing leaks into the next session.
   */
  resetSession(error?: Error): void {
    const pending = this.takePending()
    this.sessionStrategy = null
    this.capturedAudioMs = 0
    if (pending) pending.reject(error ?? new Error(ASR_SESSION_DISCONNECTED_MESSAGE))
  }

  private takePending(expectedUtteranceId?: number): PendingAsrUtterance | null {
    const pending = this.pending
    if (!pending || (expectedUtteranceId !== undefined && pending.id !== expectedUtteranceId)) {
      return null
    }
    this.pending = null
    this.scheduler.clearTimeout(pending.timer)
    return pending
  }

  private supersedePending(): void {
    const pending = this.takePending()
    if (!pending) return
    pending.reject(new Error(ASR_UTTERANCE_SUPERSEDED_MESSAGE))
  }

  private handleTimeout(utteranceId: number): void {
    const pending = this.pending
    // Stale callbacks from superseded utterances must not touch the current one.
    if (!pending || pending.id !== utteranceId) return
    this.pending = null
    this.capturedAudioMs = 0
    pending.reject(new Error(pending.timeoutMessage))
  }
}

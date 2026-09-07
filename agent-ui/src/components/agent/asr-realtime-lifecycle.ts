import {
  AsrTranscriptionDeadlineController,
  isBatchAsrStrategy,
  type AsrTranscriptionAttempt
} from './asr-transcription-deadline'

export interface AsrControlSocket {
  readonly readyState: number
  send(data: string): void
}

export interface BeginAsrRealtimeUtteranceOptions {
  controller: AsrTranscriptionDeadlineController
  socket: AsrControlSocket | null
  openReadyState: number
  onBegin: () => void
}

/** Begins one utterance and resets batch-style servers before audio is sent. */
export function beginAsrRealtimeUtterance({
  controller,
  socket,
  openReadyState,
  onBegin
}: BeginAsrRealtimeUtteranceOptions): void {
  controller.beginUtterance()
  if (!socket || socket.readyState !== openReadyState) return
  onBegin()
  // The batch server's initial state already represents the first `start`. If
  // `session.ready` arrives after audio begins, a retroactive start would discard
  // that buffered audio. The session-scoped strategy resets every later utterance.
  if (!isBatchAsrStrategy(controller.getSessionStrategy())) return
  socket.send(JSON.stringify({ type: 'start' }))
}

/** Monotonic fence used to reject events emitted by invalidated ASR sockets. */
export class AsrSocketGenerationFence {
  private generation = 0

  current(): number {
    return this.generation
  }

  invalidate(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}

/** Routes terminal events to the exact attempt currently owned by the cockpit. */
export class AsrTranscriptionAttemptRegistry {
  private pending: AsrTranscriptionAttempt | null = null

  track(attempt: AsrTranscriptionAttempt): Promise<string> {
    this.pending = attempt
    return attempt.promise.finally(() => {
      if (this.pending === attempt) this.pending = null
    })
  }

  resolve(text: string): void {
    this.pending?.resolve(text)
  }

  reject(error: Error): void {
    this.pending?.reject(error)
  }

  hasPending(): boolean {
    return this.pending !== null
  }
}

/** Identifies an upstream protocol response that reconnecting cannot itself resolve. */
export class AsrProtocolError extends Error {
  override name = 'AsrProtocolError'
}

export interface RecoverAsrRealtimeSessionOptions {
  shouldContinue: () => boolean
  connect: () => Promise<void>
  disconnect: () => void
  clearError: () => void
  clearErrorAfterReconnect?: boolean
  reportError: (error: unknown) => void
  closeInput: () => void
}

/** Reconnects only for the active voice session and clears recovered transport errors. */
export async function recoverAsrRealtimeSession({
  shouldContinue,
  connect,
  disconnect,
  clearError,
  clearErrorAfterReconnect = true,
  reportError,
  closeInput
}: RecoverAsrRealtimeSessionOptions): Promise<void> {
  if (!shouldContinue()) return
  try {
    await connect()
    if (!shouldContinue()) {
      disconnect()
      return
    }
    if (clearErrorAfterReconnect) clearError()
  } catch (error) {
    if (!shouldContinue()) return
    reportError(error)
    closeInput()
  }
}

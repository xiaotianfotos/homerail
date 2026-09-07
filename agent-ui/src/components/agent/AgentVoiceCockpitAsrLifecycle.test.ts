import { describe, expect, it } from 'vitest'

import {
  AsrProtocolError,
  AsrSocketGenerationFence,
  AsrTranscriptionAttemptRegistry,
  beginAsrRealtimeUtterance,
  recoverAsrRealtimeSession,
  type AsrControlSocket
} from './asr-realtime-lifecycle'
import {
  ASR_UTTERANCE_SUPERSEDED_MESSAGE,
  AsrTranscriptionDeadlineController,
  type AsrDeadlineScheduler
} from './asr-transcription-deadline'

class FakeDeadlineScheduler implements AsrDeadlineScheduler {
  private nextHandle = 1

  now(): number {
    return 0
  }

  setTimeout(): number {
    return this.nextHandle++
  }

  clearTimeout(): void {}
}

class FakeAsrSocket implements AsrControlSocket {
  readonly sent: string[] = []

  constructor(readonly readyState: number) {}

  send(data: string): void {
    this.sent.push(data)
  }
}

describe('Agent Voice Cockpit ASR lifecycle helpers', () => {
  it('keeps a late batch strategy on the initial server buffer and resets later utterances', async () => {
    const controller = new AsrTranscriptionDeadlineController({
      scheduler: new FakeDeadlineScheduler()
    })
    const socket = new FakeAsrSocket(1)
    let error = 'No transcript'

    beginAsrRealtimeUtterance({
      controller,
      socket,
      openReadyState: 1,
      onBegin: () => {
        error = ''
      }
    })
    expect(error).toBe('')
    expect(socket.sent).toEqual([])

    controller.recordSentAudio(16_000, 16_000)
    controller.handleSessionReady('emulated_batch')
    expect(socket.sent).toEqual([])
    const firstAttempt = controller.finish()
    firstAttempt.resolve('first transcript')
    await expect(firstAttempt.promise).resolves.toBe('first transcript')

    beginAsrRealtimeUtterance({ controller, socket, openReadyState: 1, onBegin: () => {} })
    expect(socket.sent).toEqual([JSON.stringify({ type: 'start' })])

    const closedSocket = new FakeAsrSocket(3)
    error = 'ASR disconnected'
    beginAsrRealtimeUtterance({
      controller,
      socket: closedSocket,
      openReadyState: 1,
      onBegin: () => {
        error = ''
      }
    })
    expect(error).toBe('ASR disconnected')
    expect(closedSocket.sent).toEqual([])

    beginAsrRealtimeUtterance({
      controller,
      socket: null,
      openReadyState: 1,
      onBegin: () => {
        error = ''
      }
    })
    expect(error).toBe('ASR disconnected')
  })

  it('invalidates events from earlier socket generations', () => {
    const fence = new AsrSocketGenerationFence()
    const firstGeneration = fence.current()
    expect(fence.isCurrent(firstGeneration)).toBe(true)

    fence.invalidate()
    expect(fence.isCurrent(firstGeneration)).toBe(false)
    expect(fence.isCurrent(fence.current())).toBe(true)
  })

  it('keeps a newer transcription registered when an older attempt settles', async () => {
    const controller = new AsrTranscriptionDeadlineController({
      scheduler: new FakeDeadlineScheduler()
    })
    const registry = new AsrTranscriptionAttemptRegistry()
    const firstAttempt = controller.finish()
    const firstPromise = registry.track(firstAttempt)
    const secondAttempt = controller.finish()
    const secondPromise = registry.track(secondAttempt)

    await expect(firstPromise).rejects.toThrow(ASR_UTTERANCE_SUPERSEDED_MESSAGE)
    expect(registry.hasPending()).toBe(true)

    firstAttempt.resolve('stale transcript')
    registry.resolve('current transcript')
    await expect(secondPromise).resolves.toBe('current transcript')
    expect(registry.hasPending()).toBe(false)
  })

  it('clears a stale error after reconnecting the active voice session', async () => {
    let active = true
    let error = 'ASR disconnected'
    let disconnected = 0
    let closed = 0

    await recoverAsrRealtimeSession({
      shouldContinue: () => active,
      connect: async () => {},
      disconnect: () => {
        disconnected += 1
      },
      clearError: () => {
        error = ''
      },
      reportError: reconnectError => {
        error = String(reconnectError)
      },
      closeInput: () => {
        closed += 1
      }
    })

    expect(error).toBe('')
    expect(disconnected).toBe(0)
    expect(closed).toBe(0)

    active = true
    await recoverAsrRealtimeSession({
      shouldContinue: () => active,
      connect: async () => {
        active = false
      },
      disconnect: () => {
        disconnected += 1
      },
      clearError: () => {
        error = ''
      },
      reportError: () => {},
      closeInput: () => {
        closed += 1
      }
    })
    expect(disconnected).toBe(1)
    expect(closed).toBe(0)
  })

  it('preserves an upstream protocol error after reconnecting', async () => {
    const protocolError = new AsrProtocolError('invalid upstream API key')
    let error = protocolError.message
    let cleared = 0

    await recoverAsrRealtimeSession({
      shouldContinue: () => true,
      connect: async () => {},
      disconnect: () => {},
      clearError: () => {
        cleared += 1
        error = ''
      },
      clearErrorAfterReconnect: false,
      reportError: () => {},
      closeInput: () => {}
    })

    expect(error).toBe('invalid upstream API key')
    expect(cleared).toBe(0)
  })

  it('reports a reconnect failure and closes only the still-active input', async () => {
    let error: unknown = null
    let closed = 0

    await recoverAsrRealtimeSession({
      shouldContinue: () => true,
      connect: async () => {
        throw new Error('reconnect failed')
      },
      disconnect: () => {},
      clearError: () => {},
      reportError: reconnectError => {
        error = reconnectError
      },
      closeInput: () => {
        closed += 1
      }
    })

    expect(error).toEqual(new Error('reconnect failed'))
    expect(closed).toBe(1)
  })
})

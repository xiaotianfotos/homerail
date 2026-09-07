import { describe, expect, it } from 'vitest'

import {
  ASR_CONNECTION_TIMEOUT_MS,
  ASR_SESSION_DISCONNECTED_MESSAGE,
  ASR_UTTERANCE_SUPERSEDED_MESSAGE,
  AsrTranscriptionDeadlineController,
  BATCH_ASR_DEADLINE_AUDIO_FACTOR,
  BATCH_ASR_DEADLINE_BASE_MS,
  BATCH_ASR_DEADLINE_MAX_MS,
  BATCH_ASR_DEADLINE_MIN_MS,
  NATIVE_ASR_TRANSCRIPTION_DEADLINE_MS,
  computeBatchTranscriptionDeadlineMs,
  computeTranscriptionDeadlineMs,
  isAsrTranscriptionStrategy,
  normalizeAsrStrategy,
  type AsrDeadlineScheduler
} from './asr-transcription-deadline'

class FakeDeadlineScheduler implements AsrDeadlineScheduler {
  nowMs = 0
  private nextHandle = 1
  private readonly timers = new Map<number, { at: number; handler: () => void }>()

  now(): number {
    return this.nowMs
  }

  setTimeout(handler: () => void, delayMs: number): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, { at: this.nowMs + Math.max(0, delayMs), handler })
    return handle
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle)
  }

  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      let dueHandle: number | null = null
      let dueAt = Number.POSITIVE_INFINITY
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at
          dueHandle = handle
        }
      }
      if (dueHandle === null) break
      const timer = this.timers.get(dueHandle)
      this.timers.delete(dueHandle)
      this.nowMs = dueAt
      timer?.handler()
    }
    this.nowMs = target
  }

  get activeTimerCount(): number {
    return this.timers.size
  }
}

type TrackedOutcome =
  | { status: 'pending' }
  | { status: 'resolved'; text: string }
  | { status: 'rejected'; error: Error }

function trackTranscription(
  transcription: Promise<string> | { promise: Promise<string> }
): () => TrackedOutcome {
  const promise = 'promise' in transcription ? transcription.promise : transcription
  let outcome: TrackedOutcome = { status: 'pending' }
  promise.then(
    text => {
      outcome = { status: 'resolved', text }
    },
    error => {
      outcome = {
        status: 'rejected',
        error: error instanceof Error ? error : new Error(String(error))
      }
    }
  )
  return () => outcome
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function rejectedMessage(outcome: TrackedOutcome): string {
  expect(outcome.status).toBe('rejected')
  return outcome.status === 'rejected' ? outcome.error.message : ''
}

describe('ASR transcription deadline constants and formula', () => {
  it('keeps the documented connection and native transcription budgets', () => {
    expect(ASR_CONNECTION_TIMEOUT_MS).toBe(5000)
    expect(NATIVE_ASR_TRANSCRIPTION_DEADLINE_MS).toBe(9000)
  })

  it('clamps the batch formula to the documented minimum and maximum', () => {
    expect(BATCH_ASR_DEADLINE_BASE_MS).toBe(15000)
    expect(BATCH_ASR_DEADLINE_AUDIO_FACTOR).toBe(2)
    expect(BATCH_ASR_DEADLINE_MIN_MS).toBe(30000)
    expect(BATCH_ASR_DEADLINE_MAX_MS).toBe(120000)
    expect(computeBatchTranscriptionDeadlineMs(0)).toBe(30000)
    expect(computeBatchTranscriptionDeadlineMs(7499)).toBe(30000)
    expect(computeBatchTranscriptionDeadlineMs(7500)).toBe(30000)
    expect(computeBatchTranscriptionDeadlineMs(20000)).toBe(55000)
    expect(computeBatchTranscriptionDeadlineMs(52500)).toBe(120000)
    expect(computeBatchTranscriptionDeadlineMs(120000)).toBe(120000)
    expect(computeBatchTranscriptionDeadlineMs(-100)).toBe(30000)
    expect(computeBatchTranscriptionDeadlineMs(Number.NaN)).toBe(30000)
  })

  it('keeps native realtime on the 9,000 ms deadline regardless of audio duration', () => {
    expect(computeTranscriptionDeadlineMs('native_realtime', 0)).toBe(9000)
    expect(computeTranscriptionDeadlineMs('native_realtime', 999999)).toBe(9000)
    expect(computeTranscriptionDeadlineMs(null, 20000)).toBe(9000)
  })

  it('applies the bounded batch formula to emulated_batch and ark_voice', () => {
    expect(computeTranscriptionDeadlineMs('emulated_batch', 1000)).toBe(30000)
    expect(computeTranscriptionDeadlineMs('emulated_batch', 20000)).toBe(55000)
    expect(computeTranscriptionDeadlineMs('emulated_batch', 90000)).toBe(120000)
    expect(computeTranscriptionDeadlineMs('ark_voice', 10000)).toBe(35000)
    expect(computeTranscriptionDeadlineMs('ark_voice', 60000)).toBe(120000)
  })

  it('fails closed for invalid strategy values', () => {
    const invalidValues: unknown[] = [
      undefined,
      null,
      '',
      'EMULATED_BATCH',
      'emulated',
      'batch',
      'native',
      'native_realtime_extra',
      42,
      {},
      ['emulated_batch']
    ]
    for (const value of invalidValues) {
      expect(isAsrTranscriptionStrategy(value)).toBe(false)
      expect(normalizeAsrStrategy(value)).toBeNull()
    }
    expect(normalizeAsrStrategy('native_realtime')).toBe('native_realtime')
    expect(normalizeAsrStrategy('emulated_batch')).toBe('emulated_batch')
    expect(normalizeAsrStrategy('ark_voice')).toBe('ark_voice')
  })
})

describe('AsrTranscriptionDeadlineController defaults', () => {
  it('times out native realtime at 9,000 ms even with long audio', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('native_realtime')
    controller.beginUtterance()
    controller.recordSentAudio(160000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(NATIVE_ASR_TRANSCRIPTION_DEADLINE_MS - 1)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
    expect(scheduler.activeTimerCount).toBe(0)
    expect(controller.hasPendingUtterance()).toBe(false)
  })

  it('times out an unknown strategy at 9,000 ms when session.ready never arrived', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(8999)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
    expect(controller.getSessionStrategy()).toBeNull()
  })

  it('fails closed when session.ready carries an invalid strategy', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('quantum_asr')
    expect(controller.getSessionStrategy()).toBeNull()
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(9000)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('gives short emulated audio the 30,000 ms minimum', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(16000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(BATCH_ASR_DEADLINE_MIN_MS - 1)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('scales longer audio with the formula and caps at 120,000 ms', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const scaled = trackTranscription(controller.finish())

    scheduler.advance(54999)
    await flushMicrotasks()
    expect(scaled().status).toBe('pending')
    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(scaled())).toBe('ASR transcription timed out')

    controller.handleSessionReady('ark_voice')
    controller.beginUtterance()
    controller.recordSentAudio(1920000, 16000)
    const capped = trackTranscription(controller.finish())

    scheduler.advance(BATCH_ASR_DEADLINE_MAX_MS - 1)
    await flushMicrotasks()
    expect(capped().status).toBe('pending')
    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(capped())).toBe('ASR transcription timed out')
  })

  it('honors a custom timeout message from the cockpit', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    const outcome = trackTranscription(controller.finish({ timeoutMessage: 'voice timeout' }))
    scheduler.advance(9000)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('voice timeout')
  })
})

describe('AsrTranscriptionDeadlineController promotion', () => {
  it('promotes a pending unknown deadline to the batch deadline from the original finish time', async () => {
    const scheduler = new FakeDeadlineScheduler()
    scheduler.nowMs = 100000
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())
    const finishedAt = scheduler.nowMs

    scheduler.advance(8000)
    controller.handleTranscriptionProcessing('emulated_batch')
    expect(controller.getSessionStrategy()).toBe('emulated_batch')

    scheduler.advance(1000)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(45999)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(scheduler.nowMs).toBe(finishedAt + 55000)
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('also promotes an in-flight deadline when session.ready arrives late', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(8000)
    controller.handleSessionReady('emulated_batch')
    expect(controller.getSessionStrategy()).toBe('emulated_batch')

    scheduler.advance(1000)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(45999)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(scheduler.nowMs).toBe(55000)
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('promotes a pending native deadline when the batch strategy arrives late', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('native_realtime')
    controller.beginUtterance()
    controller.recordSentAudio(160000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(4000)
    controller.handleTranscriptionProcessing('emulated_batch')

    scheduler.advance(5000)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(35000 - 9000 - 1)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(scheduler.nowMs).toBe(35000)
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('never slides the absolute deadline when processing events repeat', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(1000)
    controller.handleTranscriptionProcessing('emulated_batch')
    scheduler.advance(49000)
    controller.handleTranscriptionProcessing('emulated_batch')
    controller.handleTranscriptionProcessing('emulated_batch')
    controller.handleTranscriptionProcessing('ark_voice')
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(4999)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(scheduler.nowMs).toBe(55000)
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('does not shorten a batch deadline when processing confirms a native strategy', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(1000)
    controller.handleTranscriptionProcessing('native_realtime')

    scheduler.advance(53999)
    await flushMicrotasks()
    expect(outcome().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('does not promote for invalid processing strategies', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    scheduler.advance(1000)
    controller.handleTranscriptionProcessing('emulated')
    expect(controller.getSessionStrategy()).toBeNull()

    scheduler.advance(8000)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR transcription timed out')
  })

  it('records a processing strategy that arrives before any pending utterance', () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleTranscriptionProcessing('emulated_batch')
    expect(controller.getSessionStrategy()).toBe('emulated_batch')
    expect(controller.hasPendingUtterance()).toBe(false)
  })
})

describe('AsrTranscriptionDeadlineController terminal paths', () => {
  it('resolves on transcription.done exactly once and clears the timer', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const transcription = controller.finish()
    const outcome = trackTranscription(transcription)

    scheduler.advance(100)
    transcription.resolve('hello')
    transcription.resolve('second resolve')
    transcription.reject(new Error('late error'))
    await flushMicrotasks()

    const settled = outcome()
    expect(settled).toEqual({ status: 'resolved', text: 'hello' })
    expect(scheduler.activeTimerCount).toBe(0)
    expect(controller.hasPendingUtterance()).toBe(false)

    scheduler.advance(200000)
    await flushMicrotasks()
    expect(outcome()).toEqual({ status: 'resolved', text: 'hello' })
  })

  it('rejects on protocol error exactly once', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    const transcription = controller.finish()
    const outcome = trackTranscription(transcription)

    scheduler.advance(100)
    transcription.reject(new Error('boom'))
    transcription.resolve('late text')
    await flushMicrotasks()

    expect(rejectedMessage(outcome())).toBe('boom')
    expect(scheduler.activeTimerCount).toBe(0)

    scheduler.advance(200000)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('boom')
  })

  it('clears timer and state on disconnect via resetSession', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(320000, 16000)
    const outcome = trackTranscription(controller.finish())

    controller.resetSession(new Error('ASR disconnected'))
    await flushMicrotasks()

    expect(rejectedMessage(outcome())).toBe('ASR disconnected')
    expect(controller.getSessionStrategy()).toBeNull()
    expect(controller.getCapturedAudioMs()).toBe(0)
    expect(controller.hasPendingUtterance()).toBe(false)
    expect(scheduler.activeTimerCount).toBe(0)

    scheduler.advance(200000)
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe('ASR disconnected')

    controller.handleSessionReady('native_realtime')
    controller.beginUtterance()
    const nextOutcome = trackTranscription(controller.finish())
    scheduler.advance(9000)
    await flushMicrotasks()
    expect(rejectedMessage(nextOutcome())).toBe('ASR transcription timed out')
  })

  it('uses the default disconnect error when stop provides none', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.beginUtterance()
    const outcome = trackTranscription(controller.finish())
    controller.resetSession()
    await flushMicrotasks()
    expect(rejectedMessage(outcome())).toBe(ASR_SESSION_DISCONNECTED_MESSAGE)
    expect(scheduler.activeTimerCount).toBe(0)
  })

  it('clears strategy and captured audio when the socket closes before finish', () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')
    controller.beginUtterance()
    controller.recordSentAudio(32000, 16000)

    controller.resetSession(new Error('socket closed'))

    expect(controller.getSessionStrategy()).toBeNull()
    expect(controller.getCapturedAudioMs()).toBe(0)
    expect(controller.hasPendingUtterance()).toBe(false)
    expect(scheduler.activeTimerCount).toBe(0)
  })
})

describe('AsrTranscriptionDeadlineController per-utterance isolation', () => {
  it('does not let a stale callback from the previous utterance reject the next one', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    const first = trackTranscription(controller.finish())

    scheduler.advance(1000)
    controller.beginUtterance()
    await flushMicrotasks()
    expect(rejectedMessage(first())).toBe(ASR_UTTERANCE_SUPERSEDED_MESSAGE)
    expect(scheduler.activeTimerCount).toBe(0)

    controller.recordSentAudio(16000, 16000)
    const second = trackTranscription(controller.finish())

    scheduler.advance(8999)
    await flushMicrotasks()
    expect(second().status).toBe('pending')

    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(second())).toBe('ASR transcription timed out')
  })

  it('settles the earlier promise deterministically when finish is called twice', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    const firstTranscription = controller.finish()
    const first = trackTranscription(firstTranscription)
    const secondTranscription = controller.finish()
    const second = trackTranscription(secondTranscription)
    await flushMicrotasks()

    expect(rejectedMessage(first())).toBe(ASR_UTTERANCE_SUPERSEDED_MESSAGE)
    expect(second().status).toBe('pending')

    firstTranscription.resolve('stale text')
    firstTranscription.reject(new Error('stale error'))
    await flushMicrotasks()
    expect(second().status).toBe('pending')

    scheduler.advance(9000)
    await flushMicrotasks()
    expect(rejectedMessage(second())).toBe('ASR transcription timed out')
    expect(scheduler.activeTimerCount).toBe(0)
  })

  it('isolates captured audio duration between utterances', async () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.handleSessionReady('emulated_batch')

    controller.beginUtterance()
    controller.recordSentAudio(960000, 16000)
    const firstTranscription = controller.finish()
    const first = trackTranscription(firstTranscription)
    scheduler.advance(100)
    firstTranscription.resolve('done')
    await flushMicrotasks()
    expect(first()).toEqual({ status: 'resolved', text: 'done' })
    expect(controller.getCapturedAudioMs()).toBe(0)

    controller.beginUtterance()
    const second = trackTranscription(controller.finish())
    scheduler.advance(BATCH_ASR_DEADLINE_MIN_MS - 1)
    await flushMicrotasks()
    expect(second().status).toBe('pending')
    scheduler.advance(1)
    await flushMicrotasks()
    expect(rejectedMessage(second())).toBe('ASR transcription timed out')
  })

  it('counts only valid sent audio toward the captured duration', () => {
    const scheduler = new FakeDeadlineScheduler()
    const controller = new AsrTranscriptionDeadlineController({ scheduler })
    controller.recordSentAudio(0, 16000)
    controller.recordSentAudio(-5, 16000)
    controller.recordSentAudio(16000, 0)
    controller.recordSentAudio(Number.NaN, 16000)
    expect(controller.getCapturedAudioMs()).toBe(0)

    controller.recordSentAudio(24000, 48000)
    expect(controller.getCapturedAudioMs()).toBe(500)

    controller.beginUtterance()
    expect(controller.getCapturedAudioMs()).toBe(0)
  })
})

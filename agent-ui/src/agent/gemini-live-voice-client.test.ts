import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GeminiLiveVoiceClient,
  _resampleGeminiPcm16ChunksForTest,
  _resampleGeminiPcm16ForTest,
  type GeminiPcmAudioTransport,
} from './gemini-live-voice-client'
import type { CodexLiveVoiceState } from './codex-live-voice-client'

class FakeGeminiBrowserSocket extends EventTarget {
  readyState = WebSocket.CONNECTING
  binaryType: BinaryType = 'blob'
  jsonSent: Array<Record<string, unknown>> = []
  binarySent: ArrayBuffer[] = []

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  send(raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string') {
      this.binarySent.push(raw)
      return
    }
    const message = JSON.parse(raw) as Record<string, unknown>
    this.jsonSent.push(message)
    if (message.type === 'authenticate') {
      queueMicrotask(() => this.message({ type: 'ready', backend: 'gemini' }))
    }
    if (message.type === 'start') {
      queueMicrotask(() => this.message({ type: 'session.started' }))
    }
  }

  message(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  audio(pcm: ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent('message', { data: pcm }))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }))
  }
}

class FakeAudioTransport implements GeminiPcmAudioTransport {
  onPcm: ((pcm: ArrayBuffer) => void) | null = null
  played: ArrayBuffer[] = []
  interrupted = 0
  stopped = 0

  async start(_stream: MediaStream, onPcm: (pcm: ArrayBuffer) => void): Promise<void> {
    this.onPcm = onPcm
  }

  play(pcm: ArrayBuffer): void {
    this.played.push(pcm)
  }

  interrupt(): void {
    this.interrupted += 1
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }
}

function fakeMedia() {
  const track = { enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('GeminiLiveVoiceClient', () => {
  it('uses the shared HomeRail socket for PCM capture and playback', async () => {
    const socket = new FakeGeminiBrowserSocket()
    const transport = new FakeAudioTransport()
    const { stream, track } = fakeMedia()
    const states: CodexLiveVoiceState[] = []
    const client = new GeminiLiveVoiceClient({
      sessionId: 'gemini-browser-live',
      projectId: 'project-1',
      ticketProvider: async () => ({ ticket: 'one-time-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      getUserMedia: async () => stream,
      audioTransportFactory: () => transport,
      onState: state => states.push(state),
    })

    await client.start()
    expect(socket.binaryType).toBe('arraybuffer')
    expect(socket.jsonSent).toContainEqual({
      type: 'start',
      transport: 'pcm_s16le',
      project_id: 'project-1',
      selected_node_id: null,
      browser_tools_transport: 'none',
    })
    expect(client.currentState).toBe('listening')

    const microphonePcm = new Int16Array([1, -1, 200]).buffer
    transport.onPcm?.(microphonePcm)
    expect(socket.binarySent).toEqual([microphonePcm])

    const responsePcm = new Int16Array([3, 4, 5]).buffer
    socket.audio(responsePcm)
    expect(transport.played).toEqual([responsePcm])
    expect(client.currentState).toBe('assistant-speaking')

    socket.message({ type: 'audio.interrupted' })
    expect(transport.interrupted).toBe(1)
    expect(client.currentState).toBe('listening')

    await client.setMuted(true)
    expect(track.enabled).toBe(false)
    transport.onPcm?.(new Int16Array([9]).buffer)
    expect(socket.binarySent).toHaveLength(1)

    await client.stop()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(transport.stopped).toBe(1)
    expect(states.at(-1)).toBe('closed')
  })

  it('rejects a session when the server resolves a different Live backend', async () => {
    const socket = new FakeGeminiBrowserSocket()
    socket.send = function send(raw: string | ArrayBuffer): void {
      if (typeof raw !== 'string') return
      const message = JSON.parse(raw) as Record<string, unknown>
      this.jsonSent.push(message)
      if (message.type === 'authenticate') {
        queueMicrotask(() => this.message({ type: 'ready', backend: 'codex' }))
      }
    }
    const client = new GeminiLiveVoiceClient({
      sessionId: 'wrong-backend',
      ticketProvider: async () => ({ ticket: 'ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      getUserMedia: async () => fakeMedia().stream,
      audioTransportFactory: () => new FakeAudioTransport(),
    })

    await expect(client.start()).rejects.toThrow(/not configured for Gemini Live/i)
    expect(client.currentState).toBe('error')
  })

  it('resamples float microphone frames to signed 16-bit PCM', () => {
    const result = new Int16Array(_resampleGeminiPcm16ForTest(
      new Float32Array([-1, -0.5, 0, 0.5, 1, 0]),
      48_000,
      16_000,
    ))
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(-32768)
    expect(result[1]).toBeGreaterThan(16_000)
  })

  it('preserves the sample clock across AudioWorklet-sized chunks', () => {
    const chunks = Array.from({ length: 375 }, () => new Float32Array(128).fill(0.25))
    const result = _resampleGeminiPcm16ChunksForTest(chunks, 48_000, 16_000)
    expect(result.length).toBeGreaterThanOrEqual(15_999)
    expect(result.length).toBeLessThanOrEqual(16_000)
  })
})

import {
  codexLiveVoiceWebSocketUrl,
  requestCodexLiveVoiceTicket,
} from '@/api/services/voice-agent-api'
import { currentBrowserToolsTurnBinding } from '@/browser-tools/browser-renderer-bridge'
import type {
  CodexLiveVoiceEvent,
  CodexLiveVoiceState,
} from './codex-live-voice-client'

const GEMINI_INPUT_SAMPLE_RATE = 16_000
const GEMINI_OUTPUT_SAMPLE_RATE = 24_000

type LiveActivityState = 'listening' | 'user-speaking' | 'manager-working' | 'assistant-speaking'

export interface GeminiPcmAudioTransport {
  start(stream: MediaStream, onPcm: (pcm: ArrayBuffer) => void): Promise<void>
  play(pcm: ArrayBuffer): void
  interrupt(): void
  stop(): Promise<void>
}

export interface GeminiLiveVoiceClientOptions {
  sessionId: string
  projectId?: string | null
  selectedNodeId?: string | null
  audioInputDeviceId?: string | null
  onEvent?: (event: CodexLiveVoiceEvent) => void
  onState?: (state: CodexLiveVoiceState) => void
  ticketProvider?: (sessionId: string) => Promise<{ ticket: string }>
  webSocketFactory?: (url: string) => WebSocket
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  audioTransportFactory?: () => GeminiPcmAudioTransport
}

function resamplePcm16(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = GEMINI_INPUT_SAMPLE_RATE,
): ArrayBuffer {
  if (!input.length) return new ArrayBuffer(0)
  const ratio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio
    const lower = Math.min(input.length - 1, Math.floor(sourcePosition))
    const upper = Math.min(input.length - 1, lower + 1)
    const fraction = sourcePosition - lower
    const sample = input[lower] * (1 - fraction) + input[upper] * fraction
    const clamped = Math.max(-1, Math.min(1, sample))
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return output.buffer
}

class StreamingPcm16Resampler {
  private carry = new Float32Array(0)
  private position = 0

  constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate = GEMINI_INPUT_SAMPLE_RATE,
  ) {}

  push(input: Float32Array): ArrayBuffer {
    if (!input.length) return new ArrayBuffer(0)
    const combined = new Float32Array(this.carry.length + input.length)
    combined.set(this.carry)
    combined.set(input, this.carry.length)
    const ratio = this.inputSampleRate / this.outputSampleRate
    const samples: number[] = []
    while (this.position < combined.length - 1) {
      const lower = Math.floor(this.position)
      const upper = lower + 1
      const fraction = this.position - lower
      samples.push(combined[lower] * (1 - fraction) + combined[upper] * fraction)
      this.position += ratio
    }
    const consumed = Math.min(combined.length - 1, Math.floor(this.position))
    this.carry = combined.slice(consumed)
    this.position -= consumed
    const output = new Int16Array(samples.length)
    for (let index = 0; index < samples.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index]))
      output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    }
    return output.buffer
  }
}

class BrowserGeminiPcmAudioTransport implements GeminiPcmAudioTransport {
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private workletUrl: string | null = null
  private resampler: StreamingPcm16Resampler | null = null
  private pendingCapture = new Int16Array(0)
  private playbackCursor = 0
  private readonly scheduledSources = new Set<AudioBufferSourceNode>()

  async start(stream: MediaStream, onPcm: (pcm: ArrayBuffer) => void): Promise<void> {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) throw new Error('Gemini Live requires Web Audio support')
    const context = new AudioContextCtor() as AudioContext
    this.context = context
    this.resampler = new StreamingPcm16Resampler(context.sampleRate)
    await context.resume()
    this.source = context.createMediaStreamSource(stream)
    this.silentGain = context.createGain()
    this.silentGain.gain.value = 0
    this.silentGain.connect(context.destination)

    let workletReady = false
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const source = `
        class HomeRailGeminiPcmCapture extends AudioWorkletProcessor {
          process(inputs) {
            const channel = inputs[0] && inputs[0][0];
            if (channel && channel.length) {
              const copy = channel.slice();
              this.port.postMessage(copy.buffer, [copy.buffer]);
            }
            return true;
          }
        }
        registerProcessor('homerail-gemini-pcm-capture', HomeRailGeminiPcmCapture);
      `
      try {
        this.workletUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        await context.audioWorklet.addModule(this.workletUrl)
        const node = new AudioWorkletNode(context, 'homerail-gemini-pcm-capture')
        node.port.onmessage = event => {
          const samples = new Float32Array(event.data as ArrayBuffer)
          const pcm = this.resampler?.push(samples) ?? new ArrayBuffer(0)
          this.emitCaptureFrames(pcm, onPcm)
        }
        this.captureNode = node
        workletReady = true
      } catch {
        if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
        this.workletUrl = null
      }
    }
    if (!workletReady) {
      const node = context.createScriptProcessor(2048, 1, 1)
      node.onaudioprocess = event => {
        const samples = event.inputBuffer.getChannelData(0)
        const pcm = this.resampler?.push(samples) ?? new ArrayBuffer(0)
        this.emitCaptureFrames(pcm, onPcm)
      }
      this.captureNode = node
    }

    const captureNode = this.captureNode
    if (!captureNode) throw new Error('Unable to create a Gemini Live audio capture node')
    this.source.connect(captureNode)
    captureNode.connect(this.silentGain)
  }

  play(pcm: ArrayBuffer): void {
    const context = this.context
    if (!context || pcm.byteLength < 2) return
    const samples = new Int16Array(pcm)
    const buffer = context.createBuffer(1, samples.length, GEMINI_OUTPUT_SAMPLE_RATE)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] / (samples[index] < 0 ? 0x8000 : 0x7fff)
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime + 0.025, this.playbackCursor)
    this.playbackCursor = startAt + buffer.duration
    this.scheduledSources.add(source)
    source.onended = () => this.scheduledSources.delete(source)
    source.start(startAt)
  }

  interrupt(): void {
    for (const source of this.scheduledSources) {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
    }
    this.scheduledSources.clear()
    this.playbackCursor = this.context?.currentTime ?? 0
  }

  async stop(): Promise<void> {
    this.interrupt()
    this.source?.disconnect()
    this.captureNode?.disconnect()
    this.silentGain?.disconnect()
    if (this.captureNode && 'onaudioprocess' in this.captureNode) {
      this.captureNode.onaudioprocess = null
    }
    this.source = null
    this.captureNode = null
    this.silentGain = null
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
    this.workletUrl = null
    this.resampler = null
    this.pendingCapture = new Int16Array(0)
    const context = this.context
    this.context = null
    await context?.close().catch(() => undefined)
  }

  private emitCaptureFrames(pcm: ArrayBuffer, onPcm: (pcm: ArrayBuffer) => void): void {
    if (!pcm.byteLength) return
    const incoming = new Int16Array(pcm)
    const combined = new Int16Array(this.pendingCapture.length + incoming.length)
    combined.set(this.pendingCapture)
    combined.set(incoming, this.pendingCapture.length)
    const frameSamples = GEMINI_INPUT_SAMPLE_RATE / 50 // 20 ms
    let offset = 0
    while (combined.length - offset >= frameSamples) {
      onPcm(combined.slice(offset, offset + frameSamples).buffer)
      offset += frameSamples
    }
    this.pendingCapture = combined.slice(offset)
  }
}

export class GeminiLiveVoiceClient {
  private readonly options: GeminiLiveVoiceClientOptions
  private socket: WebSocket | null = null
  private localStream: MediaStream | null = null
  private audioTransport: GeminiPcmAudioTransport | null = null
  private state: CodexLiveVoiceState = 'idle'
  private activityState: LiveActivityState = 'listening'
  private muted = false
  private stopped = false
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private connectionGeneration = 0
  private sessionStarted:
    | { resolve: () => void; reject: (error: Error) => void; timer: number }
    | null = null

  constructor(options: GeminiLiveVoiceClientOptions) {
    this.options = options
  }

  get currentState(): CodexLiveVoiceState {
    return this.state
  }

  get isMuted(): boolean {
    return this.muted
  }

  async start(): Promise<void> {
    if (this.socket || this.localStream) throw new Error('Live Voice is already started')
    if (
      typeof window !== 'undefined' &&
      !window.isSecureContext &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'
    ) throw new Error('Live Voice requires HTTPS or localhost')
    this.stopped = false
    this.reconnectAttempts = 0
    const generation = ++this.connectionGeneration
    this.setState('connecting')
    try {
      await this.connect(false, generation)
    } catch (error) {
      if (this.stopped) throw error
      this.stopped = true
      this.connectionGeneration += 1
      await this.cleanupTransport()
      this.setState('error')
      throw error
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted
    this.sendJson({ type: 'mute', muted })
    this.setState(muted ? 'muted' : this.activityState)
  }

  async toggleMuted(): Promise<void> {
    await this.setMuted(!this.muted)
  }

  sendText(text: string): void {
    const value = text.trim()
    if (value && !this.sendJson({ type: 'text', text: value })) {
      throw new Error('Live Voice is reconnecting. Wait until it is listening before sending text.')
    }
  }

  async stop(notifyServer = true): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.connectionGeneration += 1
    this.clearReconnectTimer()
    if (notifyServer) this.sendJson({ type: 'stop' })
    await this.cleanupTransport()
    this.setState('closed')
  }

  private async connect(reconnecting: boolean, generation: number): Promise<void> {
    this.assertCurrent(generation)
    this.setState(reconnecting ? 'reconnecting' : 'connecting')
    const getUserMedia = this.options.getUserMedia
      ?? (constraints => navigator.mediaDevices.getUserMedia(constraints))
    const stream = await getUserMedia({
      audio: this.options.audioInputDeviceId
        ? { deviceId: { exact: this.options.audioInputDeviceId } }
        : true,
    })
    if (!this.isCurrent(generation)) {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('Live Voice connection attempt was superseded')
    }
    this.localStream = stream
    for (const track of stream.getAudioTracks()) track.enabled = !this.muted

    const ticket = await (this.options.ticketProvider ?? requestCodexLiveVoiceTicket)(
      this.options.sessionId,
    )
    this.assertCurrent(generation)
    await this.openSocket(ticket.ticket, generation)
    this.assertCurrent(generation)
    const started = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.sessionStarted = null
        reject(new Error('Timed out starting Gemini Live'))
      }, 45_000)
      this.sessionStarted = { resolve, reject, timer }
    })
    this.sendJson({
      type: 'start',
      transport: 'pcm_s16le',
      project_id: this.options.projectId || null,
      selected_node_id: this.options.selectedNodeId || null,
      ...currentBrowserToolsTurnBinding(),
    })
    await started
    this.assertCurrent(generation)

    const audioTransport = (this.options.audioTransportFactory
      ?? (() => new BrowserGeminiPcmAudioTransport()))()
    this.audioTransport = audioTransport
    await audioTransport.start(stream, pcm => {
      if (!this.isCurrent(generation) || this.muted) return
      this.sendPcm(pcm)
    })
    this.assertCurrent(generation)
    this.reconnectAttempts = 0
    this.setActivityState('listening')
  }

  private openSocket(ticket: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = (this.options.webSocketFactory ?? (url => new WebSocket(url)))(
        codexLiveVoiceWebSocketUrl(this.options.sessionId),
      )
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      let ready = false
      let settled = false
      const isCurrent = () => this.socket === socket && this.isCurrent(generation)
      const finish = () => {
        if (settled) return
        settled = true
        ready = true
        window.clearTimeout(timer)
        resolve()
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        reject(error)
      }
      const timer = window.setTimeout(() => fail(new Error('Timed out authenticating Live Voice')), 10_000)
      socket.addEventListener('open', () => {
        if (!isCurrent()) return fail(new Error('Live Voice connection attempt was superseded'))
        socket.send(JSON.stringify({ type: 'authenticate', ticket }))
      })
      socket.addEventListener('message', event => {
        if (!isCurrent()) return
        if (event.data instanceof ArrayBuffer) {
          this.audioTransport?.play(event.data)
          this.setActivityState('assistant-speaking')
          return
        }
        let message: CodexLiveVoiceEvent
        try {
          message = JSON.parse(String(event.data)) as CodexLiveVoiceEvent
        } catch {
          return
        }
        if (message.type === 'ready' && !ready) {
          if (message.backend !== 'gemini') {
            fail(new Error('The current Manager is not configured for Gemini Live'))
            return
          }
          finish()
        }
        void this.handleMessage(message, socket, generation)
      })
      socket.addEventListener('error', () => {
        if (isCurrent() && !ready) fail(new Error('Live Voice WebSocket connection failed'))
      })
      socket.addEventListener('close', event => {
        if (!isCurrent()) return
        if (!ready) fail(new Error(event.reason || 'Live Voice WebSocket closed'))
        if (!this.stopped && event.code !== 1000) {
          this.scheduleReconnect(new Error(event.reason || 'Live Voice connection closed unexpectedly'))
        }
      })
    })
  }

  private async handleMessage(
    message: CodexLiveVoiceEvent,
    socket: WebSocket,
    generation: number,
  ): Promise<void> {
    if (this.socket !== socket || !this.isCurrent(generation)) return
    if (message.type === 'session.started') {
      if (this.sessionStarted) {
        window.clearTimeout(this.sessionStarted.timer)
        this.sessionStarted.resolve()
        this.sessionStarted = null
      }
    } else if (message.type === 'manager.turn.started' || message.type === 'handoff') {
      this.setActivityState('manager-working')
    } else if (message.type === 'manager.turn.completed') {
      this.setActivityState('listening')
    } else if (message.type === 'transcript.delta') {
      const role = String(message.role || '').toLowerCase()
      if (role === 'user') this.setActivityState('user-speaking')
      if (role === 'assistant') this.setActivityState('assistant-speaking')
    } else if (message.type === 'transcript.done') {
      if (String(message.role || '').toLowerCase() === 'assistant') {
        this.setActivityState('listening')
      }
    } else if (message.type === 'audio.interrupted') {
      this.audioTransport?.interrupt()
      this.setActivityState('listening')
    } else if (message.type === 'session.error') {
      const error = new Error(
        typeof message.message === 'string' ? message.message : 'Gemini Live encountered an error',
      )
      if (message.recoverable === true) this.setActivityState('listening')
      else await this.failAndStop(error, false)
    } else if (message.type === 'session.closed' && !this.stopped) {
      this.scheduleReconnect(new Error('Gemini Live session closed'))
    }
    this.options.onEvent?.(message)
  }

  private sendJson(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private sendPcm(pcm: ArrayBuffer): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(pcm)
    return true
  }

  private async cleanupTransport(): Promise<void> {
    if (this.sessionStarted) {
      window.clearTimeout(this.sessionStarted.timer)
      this.sessionStarted.reject(new Error('Live Voice stopped'))
      this.sessionStarted = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
    const audioTransport = this.audioTransport
    this.audioTransport = null
    await audioTransport?.stop().catch(() => undefined)
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    this.localStream = null
  }

  private async failAndStop(error: Error, emitEvent = true): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.connectionGeneration += 1
      this.clearReconnectTimer()
      await this.cleanupTransport()
    }
    this.setState('error')
    if (emitEvent) {
      this.options.onEvent?.({
        type: 'session.error',
        message: error.message,
        recoverable: false,
      })
    }
  }

  private scheduleReconnect(error: Error): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.setState('reconnecting')
    const delay = Math.min(4_000, 500 * (2 ** this.reconnectAttempts))
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (this.reconnectAttempts >= 3) {
        void this.failAndStop(error)
        return
      }
      this.reconnectAttempts += 1
      const generation = ++this.connectionGeneration
      void this.cleanupTransport()
        .then(() => this.connect(true, generation))
        .catch(nextError => {
          if (!this.isCurrent(generation)) return
          this.scheduleReconnect(nextError instanceof Error ? nextError : new Error(String(nextError)))
        })
    }, delay)
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.connectionGeneration
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new Error('Live Voice connection attempt was superseded')
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private setActivityState(state: LiveActivityState): void {
    this.activityState = state
    this.setState(this.muted ? 'muted' : state)
  }

  private setState(state: CodexLiveVoiceState): void {
    if (this.state === state) return
    this.state = state
    this.options.onState?.(state)
  }
}

export const _resampleGeminiPcm16ForTest = resamplePcm16

export function _resampleGeminiPcm16ChunksForTest(
  chunks: Float32Array[],
  inputSampleRate: number,
  outputSampleRate: number,
): Int16Array {
  const resampler = new StreamingPcm16Resampler(inputSampleRate, outputSampleRate)
  const parts = chunks.map(chunk => new Int16Array(resampler.push(chunk)))
  const output = new Int16Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

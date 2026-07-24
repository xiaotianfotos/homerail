import {
  codexLiveVoiceWebSocketUrl,
  requestCodexLiveVoiceTicket,
} from '@/api/services/voice-agent-api'

export type CodexLiveVoiceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'manager-working'
  | 'assistant-speaking'
  | 'muted'
  | 'reconnecting'
  | 'error'
  | 'closed'

export interface CodexLiveVoiceEvent {
  type: string
  [key: string]: unknown
}

export interface CodexLiveVoiceClientOptions {
  sessionId: string
  projectId?: string | null
  selectedNodeId?: string | null
  audioInputDeviceId?: string | null
  onEvent?: (event: CodexLiveVoiceEvent) => void
  onState?: (state: CodexLiveVoiceState) => void
  ticketProvider?: (sessionId: string) => Promise<{ ticket: string }>
  webSocketFactory?: (url: string) => WebSocket
  peerConnectionFactory?: () => RTCPeerConnection
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  audioFactory?: () => HTMLAudioElement
}

function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 8_000): Promise<void> {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (peer.iceGatheringState === 'complete') finish()
    }
    const timer = window.setTimeout(finish, timeoutMs)
    peer.addEventListener('icegatheringstatechange', onChange)
  })
}

function waitForRealtimeTransport(
  peer: RTCPeerConnection,
  eventsChannel: RTCDataChannel,
  timeoutMs = 20_000,
): Promise<void> {
  const isReady = () => (
    peer.connectionState === 'connected'
    && eventsChannel.readyState === 'open'
  )
  if (isReady()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      peer.removeEventListener('connectionstatechange', onPeerStateChange)
      eventsChannel.removeEventListener('open', onChannelOpen)
      eventsChannel.removeEventListener('close', onChannelClose)
      eventsChannel.removeEventListener('error', onChannelError)
    }
    const finish = () => {
      if (settled || !isReady()) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onPeerStateChange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        fail(new Error(`Live Voice WebRTC connection ${peer.connectionState}`))
        return
      }
      finish()
    }
    const onChannelOpen = () => finish()
    const onChannelClose = () => fail(new Error('Live Voice event channel closed before connecting'))
    const onChannelError = () => fail(new Error('Live Voice event channel failed to open'))
    const timer = window.setTimeout(() => {
      fail(new Error('Timed out waiting for the Live Voice media connection'))
    }, timeoutMs)
    peer.addEventListener('connectionstatechange', onPeerStateChange)
    eventsChannel.addEventListener('open', onChannelOpen)
    eventsChannel.addEventListener('close', onChannelClose)
    eventsChannel.addEventListener('error', onChannelError)
    finish()
  })
}

export class CodexLiveVoiceClient {
  private readonly options: CodexLiveVoiceClientOptions
  private socket: WebSocket | null = null
  private peer: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private state: CodexLiveVoiceState = 'idle'
  private muted = false
  private stopped = false
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private remoteDescription:
    | { resolve: () => void; reject: (error: Error) => void; timer: number }
    | null = null

  constructor(options: CodexLiveVoiceClientOptions) {
    this.options = options
  }

  get currentState(): CodexLiveVoiceState {
    return this.state
  }

  get isMuted(): boolean {
    return this.muted
  }

  async start(): Promise<void> {
    if (this.socket || this.peer) throw new Error('Live Voice is already started')
    if (
      typeof window !== 'undefined' &&
      !window.isSecureContext &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'
    ) {
      throw new Error('Live Voice requires HTTPS or localhost')
    }
    this.stopped = false
    this.reconnectAttempts = 0
    this.setState('connecting')
    try {
      await this.connect(false)
    } catch (error) {
      await this.cleanupTransport()
      this.setState('error')
      throw error
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted
    this.send({ type: 'mute', muted })
    this.setState(muted ? 'muted' : 'listening')
  }

  async toggleMuted(): Promise<void> {
    await this.setMuted(!this.muted)
  }

  sendText(text: string): void {
    const value = text.trim()
    if (value) this.send({ type: 'text', text: value })
  }

  async stop(notifyServer = true): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (notifyServer) this.send({ type: 'stop' })
    await this.cleanupTransport()
    this.setState('closed')
  }

  private async connect(reconnecting: boolean): Promise<void> {
    this.setState(reconnecting ? 'reconnecting' : 'connecting')
    const getUserMedia = this.options.getUserMedia
      ?? (constraints => navigator.mediaDevices.getUserMedia(constraints))
    this.localStream = await getUserMedia({
      audio: this.options.audioInputDeviceId
        ? { deviceId: { exact: this.options.audioInputDeviceId } }
        : true,
    })
    const peer = (this.options.peerConnectionFactory ?? (() => new RTCPeerConnection()))()
    this.peer = peer
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.muted
      peer.addTrack(track, this.localStream)
    }
    const eventsChannel = peer.createDataChannel('oai-events')
    this.remoteAudio = (this.options.audioFactory ?? (() => new Audio()))()
    this.remoteAudio.autoplay = true
    peer.addEventListener('track', event => {
      if (this.peer !== peer) return
      const stream = event.streams[0]
      if (!stream || !this.remoteAudio) return
      this.remoteAudio.srcObject = stream
      void this.remoteAudio.play().catch(() => undefined)
    })
    let transportReady = false
    peer.addEventListener('connectionstatechange', () => {
      if (this.peer !== peer || this.stopped) return
      if (peer.connectionState === 'connected') {
        if (this.reconnectTimer !== null) {
          window.clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
        this.reconnectAttempts = 0
      }
      if (transportReady && peer.connectionState === 'disconnected') {
        this.scheduleReconnect(new Error('WebRTC connection was interrupted'), 1_500)
      }
      if (transportReady && peer.connectionState === 'failed') {
        this.scheduleReconnect(new Error('WebRTC connection failed'), 0)
      }
    })
    const offer = await peer.createOffer({ offerToReceiveAudio: true })
    await peer.setLocalDescription(offer)
    await waitForIceGathering(peer)
    const sdp = peer.localDescription?.sdp
    if (!sdp) throw new Error('Browser did not create a WebRTC SDP offer')

    const ticket = await (this.options.ticketProvider ?? requestCodexLiveVoiceTicket)(
      this.options.sessionId,
    )
    await this.openSocket(ticket.ticket)
    const remotePromise = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.remoteDescription = null
        reject(new Error('Timed out waiting for the Live Voice SDP answer'))
      }, 60_000)
      this.remoteDescription = { resolve, reject, timer }
    })
    this.send({
      type: 'start',
      sdp,
      project_id: this.options.projectId || null,
      selected_node_id: this.options.selectedNodeId || null,
    })
    await remotePromise
    await waitForRealtimeTransport(peer, eventsChannel)
    if (this.peer !== peer || this.stopped) {
      throw new Error('Live Voice stopped before the media connection was ready')
    }
    transportReady = true
    this.reconnectAttempts = 0
    this.setState(this.muted ? 'muted' : 'listening')
  }

  private async cleanupTransport(): Promise<void> {
    if (this.remoteDescription) {
      window.clearTimeout(this.remoteDescription.timer)
      this.remoteDescription.reject(new Error('Live Voice stopped'))
      this.remoteDescription = null
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
    const peer = this.peer
    this.peer = null
    peer?.close()
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    if (this.remoteAudio) {
      this.remoteAudio.pause()
      this.remoteAudio.srcObject = null
    }
    this.remoteAudio = null
  }

  private openSocket(ticket: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = (this.options.webSocketFactory ?? (url => new WebSocket(url)))(
        codexLiveVoiceWebSocketUrl(this.options.sessionId),
      )
      this.socket = socket
      let ready = false
      const timer = window.setTimeout(() => {
        if (!ready) reject(new Error('Timed out authenticating Live Voice'))
      }, 10_000)
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'authenticate', ticket }))
      })
      socket.addEventListener('message', event => {
        let message: CodexLiveVoiceEvent
        try {
          message = JSON.parse(String(event.data)) as CodexLiveVoiceEvent
        } catch {
          return
        }
        if (message.type === 'ready' && !ready) {
          ready = true
          window.clearTimeout(timer)
          resolve()
        }
        void this.handleMessage(message)
      })
      socket.addEventListener('error', () => {
        if (!ready) {
          window.clearTimeout(timer)
          reject(new Error('Live Voice WebSocket connection failed'))
        }
      })
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return
        if (!ready) {
          window.clearTimeout(timer)
          reject(new Error(event.reason || 'Live Voice WebSocket closed'))
        }
        if (!this.stopped && event.code !== 1000) {
          this.scheduleReconnect(
            new Error(event.reason || 'Live Voice connection closed unexpectedly'),
            0,
          )
        }
      })
    })
  }

  private async handleMessage(message: CodexLiveVoiceEvent): Promise<void> {
    if (message.type === 'session.sdp' && typeof message.sdp === 'string' && this.peer) {
      try {
        await this.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp })
        if (this.remoteDescription) {
          window.clearTimeout(this.remoteDescription.timer)
          this.remoteDescription.resolve()
          this.remoteDescription = null
        }
      } catch (error) {
        if (this.remoteDescription) {
          window.clearTimeout(this.remoteDescription.timer)
          this.remoteDescription.reject(
            error instanceof Error ? error : new Error(String(error)),
          )
        }
        this.remoteDescription = null
      }
    } else if (message.type === 'manager.turn.started' || message.type === 'handoff') {
      this.setState('manager-working')
    } else if (message.type === 'manager.turn.completed') {
      this.setState(this.muted ? 'muted' : 'listening')
    } else if (message.type === 'transcript.delta') {
      const role = String(message.role || '').toLowerCase()
      if (role === 'user') this.setState('user-speaking')
      if (role === 'assistant') this.setState('assistant-speaking')
    } else if (message.type === 'transcript.done') {
      if (!this.muted) this.setState('listening')
    } else if (message.type === 'session.error') {
      this.fail(new Error(
        typeof message.message === 'string'
          ? message.message
          : 'Live Voice encountered an error',
      ), false)
    } else if (message.type === 'session.closed') {
      if (!this.stopped) this.scheduleReconnect(new Error('Live Voice session closed'), 0)
    }
    this.options.onEvent?.(message)
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  private fail(error: Error, emitEvent = true): void {
    if (this.remoteDescription) {
      window.clearTimeout(this.remoteDescription.timer)
      this.remoteDescription.reject(error)
      this.remoteDescription = null
    }
    this.setState('error')
    if (emitEvent) this.options.onEvent?.({ type: 'session.error', message: error.message })
  }

  private scheduleReconnect(error: Error, delayMs: number): void {
    if (this.stopped || this.reconnectTimer !== null) return
    if (this.reconnectAttempts >= 3) {
      this.fail(error)
      void this.cleanupTransport()
      return
    }
    this.reconnectAttempts += 1
    this.setState('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.cleanupTransport()
        .then(() => this.connect(true))
        .catch(nextError => {
          this.scheduleReconnect(
            nextError instanceof Error ? nextError : new Error(String(nextError)),
            Math.min(4_000, 500 * (2 ** this.reconnectAttempts)),
          )
        })
    }, Math.max(500, delayMs))
  }

  private setState(state: CodexLiveVoiceState): void {
    if (this.state === state) return
    this.state = state
    this.options.onState?.(state)
  }
}

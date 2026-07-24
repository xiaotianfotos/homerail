import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexLiveVoiceClient,
  type CodexLiveVoiceState,
} from './codex-live-voice-client'

class FakeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING
  sent: Array<Record<string, unknown>> = []

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(message)
    if (message.type === 'authenticate') {
      queueMicrotask(() => this.message({ type: 'ready' }))
    }
    if (message.type === 'start') {
      queueMicrotask(() => this.message({ type: 'session.sdp', sdp: 'answer-sdp' }))
    }
  }

  message(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }))
  }
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  close(): void {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescription | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  dataChannelLabels: string[] = []
  dataChannel = new FakeDataChannel()
  addedTracks: MediaStreamTrack[] = []
  closed = false

  constructor(private readonly autoActivate = true) {
    super()
  }

  addTrack(track: MediaStreamTrack): void {
    this.addedTracks.push(track)
  }

  createDataChannel(label: string): RTCDataChannel {
    this.dataChannelLabels.push(label)
    return this.dataChannel as unknown as RTCDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    expect(this.dataChannelLabels).toEqual(['oai-events'])
    return { type: 'offer', sdp: 'offer-sdp' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
    if (this.autoActivate) this.activateTransport()
  }

  connectPeer(): void {
    this.connectionState = 'connected'
    this.dispatchEvent(new Event('connectionstatechange'))
  }

  activateTransport(): void {
    this.connectPeer()
    this.dataChannel.open()
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
    this.dispatchEvent(new Event('connectionstatechange'))
  }

  fail(): void {
    this.connectionState = 'failed'
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

class AlreadyFailedPeer extends FakePeer {
  constructor() {
    super(false)
  }

  override async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
    this.connectionState = 'failed'
  }
}

function fakeMedia() {
  const track = {
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

function fakeAudio(): HTMLAudioElement {
  return {
    autoplay: false,
    srcObject: null,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CodexLiveVoiceClient', () => {
  it('negotiates WebRTC, creates oai-events before the offer, and keeps text on the Live session', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer()
    const { stream, track } = fakeMedia()
    const states: CodexLiveVoiceState[] = []
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-1',
      projectId: 'project-1',
      ticketProvider: vi.fn(async () => ({ ticket: 'single-use-ticket' })),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: vi.fn(async () => stream),
      audioFactory: fakeAudio,
      onState: state => states.push(state),
    })

    await client.start()

    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' })
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'start',
      sdp: 'offer-sdp',
      project_id: 'project-1',
    }))
    expect(states).toContain('listening')

    await client.setMuted(true)
    expect(track.enabled).toBe(false)
    expect(socket.sent).toContainEqual({ type: 'mute', muted: true })
    client.sendText('inspect the workspace')
    expect(socket.sent).toContainEqual({ type: 'text', text: 'inspect the workspace' })

    await client.stop()
    expect(track.stop).toHaveBeenCalled()
    expect(peer.closed).toBe(true)
    expect(states.at(-1)).toBe('closed')
  })

  it('does not report listening until both WebRTC and the event channel are ready', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer(false)
    const { stream } = fakeMedia()
    const states: CodexLiveVoiceState[] = []
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-readiness',
      ticketProvider: async () => ({ ticket: 'single-use-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: async () => stream,
      audioFactory: fakeAudio,
      onState: state => states.push(state),
    })

    const startPromise = client.start()
    await vi.waitFor(() => expect(peer.remoteDescription).toEqual({
      type: 'answer',
      sdp: 'answer-sdp',
    }))
    expect(client.currentState).toBe('connecting')

    peer.connectPeer()
    await Promise.resolve()
    expect(client.currentState).toBe('connecting')

    peer.dataChannel.open()
    await startPromise
    expect(client.currentState).toBe('listening')
    expect(states.filter(state => state === 'listening')).toHaveLength(1)

    await client.stop()
  })

  it('rejects text instead of silently dropping it while the WebSocket is unavailable', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer()
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-text-unavailable',
      ticketProvider: async () => ({ ticket: 'single-use-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: async () => fakeMedia().stream,
      audioFactory: fakeAudio,
    })
    await client.start()
    socket.readyState = WebSocket.CONNECTING

    expect(() => client.sendText('do not lose this message')).toThrow(/reconnecting/i)
    expect(socket.sent).not.toContainEqual({
      type: 'text',
      text: 'do not lose this message',
    })

    await client.stop()
  })

  it('fails immediately when WebRTC is already in a terminal state', async () => {
    const socket = new FakeSocket()
    const peer = new AlreadyFailedPeer()
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-terminal-peer',
      ticketProvider: async () => ({ ticket: 'single-use-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: async () => fakeMedia().stream,
      audioFactory: fakeAudio,
    })

    await expect(client.start()).rejects.toThrow(/connection failed/i)
    expect(client.currentState).toBe('error')
  })

  it('reconnects with a fresh ticket after WebRTC fails', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const ticketProvider = vi.fn(async () => ({ ticket: `ticket-${sockets.length + 1}` }))
    const states: CodexLiveVoiceState[] = []
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-reconnect',
      ticketProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => {
        const peer = new FakePeer()
        peers.push(peer)
        return peer as unknown as RTCPeerConnection
      },
      getUserMedia: async () => fakeMedia().stream,
      audioFactory: fakeAudio,
      onState: state => states.push(state),
    })
    await client.start()

    peers[0].fail()
    expect(states).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(peers).toHaveLength(2))
    await vi.waitFor(() => expect(client.currentState).toBe('listening'))

    expect(ticketProvider).toHaveBeenCalledTimes(2)
    await client.stop()
  })

  it('stops retrying and cleans every transport after three reconnect failures', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const events: Array<Record<string, unknown>> = []
    const states: CodexLiveVoiceState[] = []
    let ticketRequest = 0
    const ticketProvider = vi.fn(async () => {
      ticketRequest += 1
      if (ticketRequest === 1) return { ticket: 'initial-ticket' }
      throw new Error('ticket service unavailable')
    })
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-reconnect-exhausted',
      ticketProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => {
        const peer = new FakePeer()
        peers.push(peer)
        return peer as unknown as RTCPeerConnection
      },
      getUserMedia: async () => fakeMedia().stream,
      audioFactory: fakeAudio,
      onEvent: event => events.push(event),
      onState: state => states.push(state),
    })
    await client.start()

    peers[0].fail()
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(client.currentState).toBe('error'))
    await vi.waitFor(() => expect(peers.every(peer => peer.closed)).toBe(true))

    expect(ticketProvider).toHaveBeenCalledTimes(4)
    expect(peers).toHaveLength(4)
    expect(sockets).toHaveLength(1)
    expect(states.at(-1)).toBe('error')
    expect(events).toContainEqual({
      type: 'session.error',
      message: 'ticket service unavailable',
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

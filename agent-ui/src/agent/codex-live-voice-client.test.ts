import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexLiveVoiceClient,
  type CodexLiveVoiceEvent,
  type CodexLiveVoiceState,
} from './codex-live-voice-client'

class FakeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING
  sent: Array<Record<string, unknown>> = []

  constructor(private readonly authenticate = true) {
    super()
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(message)
    if (message.type === 'authenticate') {
      queueMicrotask(() => {
        if (this.authenticate) this.message({ type: 'ready' })
        else this.closeWith(4401, 'Live Voice authentication rejected')
      })
    }
    if (message.type === 'start') {
      queueMicrotask(() => this.message({ type: 'session.sdp', sdp: 'answer-sdp' }))
    }
  }

  message(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
  }

  close(): void {
    this.closeWith(1000)
  }

  closeWith(code: number, reason = ''): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
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

class ConnectedWithoutDataChannelPeer extends FakePeer {
  constructor() {
    super(false)
  }

  override async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
    this.connectPeer()
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

  it('does not reconnect an abandoned client after initial authentication fails', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const { stream, track } = fakeMedia()
    const ticketProvider = vi.fn(async () => ({ ticket: 'rejected-ticket' }))
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-initial-auth-failure',
      ticketProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket(false)
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => {
        const peer = new FakePeer()
        peers.push(peer)
        return peer as unknown as RTCPeerConnection
      },
      getUserMedia: async () => stream,
      audioFactory: fakeAudio,
    })

    await expect(client.start()).rejects.toThrow('Live Voice authentication rejected')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.currentState).toBe('error')
    expect(ticketProvider).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    expect(peers).toHaveLength(1)
    expect(peers[0].closed).toBe(true)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
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

  it('ignores delayed messages from an old socket after reconnecting', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const events: CodexLiveVoiceEvent[] = []
    const ticketProvider = vi.fn(async () => ({ ticket: `ticket-${sockets.length + 1}` }))
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-stale-socket',
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
    })
    await client.start()

    peers[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(peers).toHaveLength(2))
    await vi.waitFor(() => expect(client.currentState).toBe('listening'))

    sockets[0].message({ type: 'session.sdp', sdp: 'stale-answer-sdp' })
    sockets[0].message({
      type: 'session.error',
      message: 'Stale fatal error',
      recoverable: false,
    })
    sockets[0].message({ type: 'session.closed' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.currentState).toBe('listening')
    expect(peers[1].remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' })
    expect(peers[1].closed).toBe(false)
    expect(sockets[1].readyState).toBe(WebSocket.OPEN)
    expect(ticketProvider).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
    expect(peers).toHaveLength(2)
    expect(events).not.toContainEqual({ type: 'session.sdp', sdp: 'stale-answer-sdp' })
    expect(events).not.toContainEqual({
      type: 'session.error',
      message: 'Stale fatal error',
      recoverable: false,
    })
    expect(events).not.toContainEqual({ type: 'session.closed' })
    expect(vi.getTimerCount()).toBe(0)

    await client.stop()
  })

  it('cancels a pending reconnect when the user stops the session', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const ticketProvider = vi.fn(async () => ({ ticket: `ticket-${sockets.length + 1}` }))
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-stop-before-reconnect',
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
    })
    await client.start()

    peers[0].fail()
    expect(client.currentState).toBe('reconnecting')
    await client.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(client.currentState).toBe('closed')
    expect(ticketProvider).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(1)
    expect(peers).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalidates a reconnect that is already waiting for a fresh ticket', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    let resolveReconnectTicket: ((ticket: { ticket: string }) => void) | undefined
    const ticketProvider = vi.fn(async () => {
      if (ticketProvider.mock.calls.length === 1) return { ticket: 'initial-ticket' }
      return new Promise<{ ticket: string }>(resolve => {
        resolveReconnectTicket = resolve
      })
    })
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-stop-during-reconnect',
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
    })
    await client.start()

    peers[0].fail()
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(ticketProvider).toHaveBeenCalledTimes(2))
    await client.stop()
    resolveReconnectTicket?.({ ticket: 'late-ticket' })
    await Promise.resolve()
    await Promise.resolve()

    expect(client.currentState).toBe('closed')
    expect(sockets).toHaveLength(1)
    expect(peers).toHaveLength(2)
    expect(peers.every(peer => peer.closed)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores the latest activity state after unmuting', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer()
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-muted-activity',
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

    socket.message({ type: 'transcript.delta', role: 'assistant', text: 'Working on it' })
    expect(client.currentState).toBe('assistant-speaking')
    await client.setMuted(true)
    socket.message({ type: 'manager.turn.started' })
    expect(client.currentState).toBe('muted')
    await client.setMuted(false)
    expect(client.currentState).toBe('manager-working')

    await client.stop()
  })

  it('releases the microphone and transport after a fatal session error', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer()
    const { stream, track } = fakeMedia()
    const events: CodexLiveVoiceEvent[] = []
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-fatal-session-error',
      ticketProvider: async () => ({ ticket: 'single-use-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: async () => stream,
      audioFactory: fakeAudio,
      onEvent: event => events.push(event),
    })
    await client.start()

    socket.message({
      type: 'session.error',
      message: 'Realtime access was revoked',
      recoverable: false,
    })
    await vi.waitFor(() => expect(client.currentState).toBe('error'))

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(peer.closed).toBe(true)
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    expect(events).toContainEqual({
      type: 'session.error',
      message: 'Realtime access was revoked',
      recoverable: false,
    })
  })

  it('keeps listening after an explicitly recoverable session error', async () => {
    const socket = new FakeSocket()
    const peer = new FakePeer()
    const { stream, track } = fakeMedia()
    const events: CodexLiveVoiceEvent[] = []
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-recoverable-session-error',
      ticketProvider: async () => ({ ticket: 'single-use-ticket' }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      getUserMedia: async () => stream,
      audioFactory: fakeAudio,
      onEvent: event => events.push(event),
    })
    await client.start()

    socket.message({
      type: 'session.error',
      message: 'Invalid Live Voice text input',
      recoverable: true,
    })
    await vi.waitFor(() => expect(events).toHaveLength(3))

    expect(client.currentState).toBe('listening')
    expect(track.stop).not.toHaveBeenCalled()
    expect(peer.closed).toBe(false)
    expect(socket.readyState).toBe(WebSocket.OPEN)

    await client.stop()
  })

  it('exhausts reconnects when WebRTC connects but the data channel never opens', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const peers: FakePeer[] = []
    const tracks: MediaStreamTrack[] = []
    const ticketProvider = vi.fn(async () => ({ ticket: `ticket-${sockets.length + 1}` }))
    const client = new CodexLiveVoiceClient({
      sessionId: 'voice-partial-reconnect-exhausted',
      ticketProvider,
      webSocketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
      peerConnectionFactory: () => {
        const peer = peers.length === 0
          ? new FakePeer()
          : new ConnectedWithoutDataChannelPeer()
        peers.push(peer)
        return peer as unknown as RTCPeerConnection
      },
      getUserMedia: async () => {
        const { stream, track } = fakeMedia()
        tracks.push(track)
        return stream
      },
      audioFactory: fakeAudio,
    })
    await client.start()

    peers[0].fail()
    await vi.runAllTimersAsync()
    await vi.waitFor(() => expect(client.currentState).toBe('error'))

    expect(ticketProvider).toHaveBeenCalledTimes(4)
    expect(peers).toHaveLength(4)
    expect(peers.every(peer => peer.closed)).toBe(true)
    expect(tracks.every(track => vi.mocked(track.stop).mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
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
      recoverable: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})

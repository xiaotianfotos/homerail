import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_RENDERER_TOOLS_TICKET_PATH,
  BROWSER_TOOLS_MAX_MESSAGE_BYTES,
  BROWSER_TOOLS_MAX_RESULT_BYTES,
  HOMERAIL_UI_TOOL_CONTRACTS,
  uiToolContractDigest,
} from 'homerail-protocol'
import { http } from '@/api/clients/http-client'
import type { HomeRailUiSurfaceController } from './ui-surface-controller'
import {
  createBrowserRendererPageIdentity,
  currentBrowserToolsTurnBinding,
  HomeRailBrowserRendererBridge,
} from './browser-renderer-bridge'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

class FakeSocket {
  readyState = WebSocket.CONNECTING
  sent: Array<Record<string, unknown>> = []
  closeCode: number | undefined
  closeReason = ''
  private listeners = new Map<string, Array<(event: any) => void>>()

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open', {})
  }

  message(message: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(message) })
  }

  close(code?: number, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.closeCode = code
    this.closeReason = reason
    this.emit('close', { code: code ?? 1000, reason })
  }

  disconnect(reason = 'network lost'): void {
    this.close(1006, reason)
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function controller(
  overrides: Partial<HomeRailUiSurfaceController> = {},
): HomeRailUiSurfaceController {
  return {
    getState: () => ({
      active_surface: null,
      dag_run_id: null,
      dag_status_view: null,
      widgets: [],
      widgets_truncated: false,
      ambiguous_widget_count: 0,
    }),
    listDagRuns: async () => [],
    openDagStatus: async () => undefined,
    closeDagStatus: () => undefined,
    describeWidget: () => { throw new Error('missing') },
    focusWidget: () => { throw new Error('missing') },
    setWidgetExpanded: () => { throw new Error('missing') },
    ...overrides,
  }
}

function readyMessage(
  bridge: HomeRailBrowserRendererBridge,
  connectionId = 'connection-1',
): Record<string, unknown> {
  return {
    type: 'auth.ready',
    version: 1,
    connection_id: connectionId,
    ...bridge.identity,
    capabilities: ['catalog', 'act'],
    max_message_bytes: BROWSER_TOOLS_MAX_MESSAGE_BYTES,
    max_result_bytes: BROWSER_TOOLS_MAX_RESULT_BYTES,
    max_concurrent_calls: 4,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function connectedBridge(
  surfaceController: HomeRailUiSurfaceController,
): Promise<{ bridge: HomeRailBrowserRendererBridge; socket: FakeSocket }> {
  const socket = new FakeSocket()
  const webSocketFactory = vi.fn(() => socket as unknown as WebSocket)
  const ids = ['ui-session-1', 'tab-1', 'navigation-1']
  const bridge = new HomeRailBrowserRendererBridge(surfaceController, {
    sessionStorage: new MemoryStorage(),
    randomUUID: () => ids.shift()!,
    ticketClient: {
      request: vi.fn(async () => ({ ticket: 'one-use-ticket', expires_in_ms: 60_000 as const })),
    },
    webSocketFactory,
  })
  const start = bridge.start()
  await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
  socket.open()
  socket.message(readyMessage(bridge))
  await start
  return { bridge, socket }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('browser renderer bridge', () => {
  it('keeps page and tab identities stable while rotating navigation identities', () => {
    const storage = new MemoryStorage()
    const values = ['ui-session', 'tab', 'navigation-a', 'navigation-b']
    const randomUUID = () => values.shift()!
    const first = createBrowserRendererPageIdentity({ sessionStorage: storage, randomUUID })
    const refreshed = createBrowserRendererPageIdentity({ sessionStorage: storage, randomUUID })

    expect(refreshed.ui_session_id).toBe(first.ui_session_id)
    expect(refreshed.tab_id).toBe(first.tab_id)
    expect(refreshed.navigation_id).not.toBe(first.navigation_id)
  })

  it('uses getRandomValues when randomUUID is unavailable and tolerates blocked sessionStorage', () => {
    const sessionStorage = vi.spyOn(window, 'sessionStorage', 'get')
      .mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    let seed = 0
    const identity = createBrowserRendererPageIdentity({
      crypto: {
        randomUUID: () => { throw new TypeError('non-secure context') },
        getRandomValues(array) {
          const base = seed++ * 16
          for (let index = 0; index < array.length; index += 1) {
            array[index] = (base + index) & 0xff
          }
          return array
        },
      },
    })
    sessionStorage.mockRestore()

    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(identity.ui_session_id).toMatch(uuidV4)
    expect(identity.tab_id).toMatch(uuidV4)
    expect(identity.navigation_id).toMatch(uuidV4)
    expect(identity.ui_session_id).not.toBe(identity.tab_id)
  })

  it('does not let an obsolete ticket completion clear or authenticate a newer start', async () => {
    const requests: Array<{
      signal: AbortSignal
      result: ReturnType<typeof deferred<{ ticket: string; expires_in_ms: 60_000 }>>
    }> = []
    const webSocketFactory = vi.fn(() => new FakeSocket() as unknown as WebSocket)
    const values = ['ui-session', 'tab', 'navigation']
    const bridge = new HomeRailBrowserRendererBridge(controller(), {
      sessionStorage: new MemoryStorage(),
      randomUUID: () => values.shift()!,
      ticketClient: {
        request: (_target, signal) => {
          const result = deferred<{ ticket: string; expires_in_ms: 60_000 }>()
          requests.push({ signal, result })
          return result.promise
        },
      },
      webSocketFactory,
    })

    const firstStart = bridge.start()
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    bridge.stop()
    const secondStart = bridge.start()
    await vi.waitFor(() => expect(requests).toHaveLength(2))

    requests[0].result.resolve({ ticket: 'old-ticket', expires_in_ms: 60_000 })
    await expect(firstStart).rejects.toMatchObject({ name: 'AbortError' })
    expect(webSocketFactory).not.toHaveBeenCalled()

    bridge.stop()
    expect(requests[1].signal.aborted).toBe(true)
    requests[1].result.resolve({ ticket: 'new-ticket', expires_in_ms: 60_000 })
    await expect(secondStart).rejects.toMatchObject({ name: 'AbortError' })
    expect(webSocketFactory).not.toHaveBeenCalled()
  })

  it('ignores late events from a stopped socket after a newer connection is ready', async () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const webSocketFactory = vi.fn()
      .mockReturnValueOnce(firstSocket as unknown as WebSocket)
      .mockReturnValueOnce(secondSocket as unknown as WebSocket)
    const statuses: string[] = []
    const values = ['ui-session', 'tab', 'navigation']
    const bridge = new HomeRailBrowserRendererBridge(controller(), {
      sessionStorage: new MemoryStorage(),
      randomUUID: () => values.shift()!,
      ticketClient: {
        request: async () => ({ ticket: 'ticket', expires_in_ms: 60_000 as const }),
      },
      webSocketFactory,
      onStatus: status => statuses.push(status.state),
    })

    const firstStart = bridge.start()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledTimes(1))
    bridge.stop()
    await expect(firstStart).rejects.toMatchObject({ name: 'AbortError' })

    const secondStart = bridge.start()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledTimes(2))
    secondSocket.open()
    secondSocket.message(readyMessage(bridge, 'connection-new'))
    await secondStart

    firstSocket.open()
    firstSocket.message(readyMessage(bridge, 'connection-old'))
    firstSocket.disconnect('late old close')

    expect(currentBrowserToolsTurnBinding()).toEqual({
      browser_tools_transport: 'renderer',
      browser_tools_target: {
        connection_id: 'connection-new',
        ...bridge.identity,
      },
    })
    expect(secondSocket.readyState).toBe(WebSocket.OPEN)
    expect(statuses.at(-1)).toBe('connected')
    bridge.stop()
  })

  it('always obtains the ticket and WebSocket through the current UI origin', async () => {
    const originalBaseUrl = http.getBaseURL()
    http.setBaseURL('http://127.0.0.1:19191')
    const canonicalTicket = 'A'.repeat(43)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { ticket: canonicalTicket, expires_in_ms: 60_000 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const socket = new FakeSocket()
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket)
    let socketUrl = ''
    const ids = ['ui-session', 'tab', 'navigation']
    const storage = new MemoryStorage()
    const bridge = new HomeRailBrowserRendererBridge(controller(), {
      sessionStorage: storage,
      randomUUID: () => ids.shift()!,
      webSocketFactory: (url) => {
        socketUrl = url
        return socket as unknown as WebSocket
      },
    })

    const start = bridge.start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith(BROWSER_RENDERER_TOOLS_TICKET_PATH, expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }))
    await vi.waitFor(() => expect(socketUrl).not.toBe(''))
    expect(socketUrl).toBe(`${window.location.origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/ws/browser-tools/renderer`)
    expect(socketUrl).not.toContain('ticket')

    socket.open()
    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]).toEqual({
      type: 'auth.ticket',
      version: 1,
      ticket: canonicalTicket,
      ...bridge.identity,
      contracts: HOMERAIL_UI_TOOL_CONTRACTS.map(contract => ({
        name: contract.name,
        contract_digest: uiToolContractDigest(contract),
      })),
    })
    expect([...Array(storage.length)].map((_, index) => storage.getItem(storage.key(index)!)))
      .not.toContain(canonicalTicket)

    socket.message(readyMessage(bridge))
    await start
    expect(currentBrowserToolsTurnBinding()).toEqual({
      browser_tools_transport: 'renderer',
      browser_tools_target: { connection_id: 'connection-1', ...bridge.identity },
    })

    bridge.stop('feature_disabled')
    expect(socket.sent.at(-1)).toEqual({
      type: 'page.invalidated',
      version: 1,
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      reason: 'feature_disabled',
    })
    expect(currentBrowserToolsTurnBinding()).toEqual({ browser_tools_transport: 'none' })
    http.setBaseURL(originalBaseUrl)
  })

  it('cancels an invocation before its first visible action and replies once', async () => {
    let resolveRuns: ((runs: []) => void) | undefined
    const openDagStatus = vi.fn(async () => undefined)
    const { bridge, socket } = await connectedBridge(controller({
      listDagRuns: signal => new Promise<[]>((resolve, reject) => {
        resolveRuns = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
      }),
      openDagStatus,
    }))
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(item => item.name === 'ui_open_surface')!
    socket.message({
      type: 'tool.invoke',
      version: 1,
      call_id: 'call-1',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      tool_name: contract.name,
      input: { surface: 'dag_status' },
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + 30_000,
    })
    socket.message({
      type: 'tool.cancel',
      version: 1,
      call_id: 'call-1',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      reason: 'cancelled',
    })
    resolveRuns?.([])
    await Promise.resolve()

    expect(openDagStatus).not.toHaveBeenCalled()
    expect(socket.sent.filter(message => message.type === 'tool.result')).toEqual([{
      type: 'tool.result',
      version: 1,
      call_id: 'call-1',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      ok: false,
      terminal_state: 'cancelled',
      error: 'cancelled',
    }])
    bridge.stop()
  })

  it('reports indeterminate instead of claiming cancellation after an action commits', async () => {
    let releaseAction: (() => void) | undefined
    const { bridge, socket } = await connectedBridge(controller({
      openDagStatus: (_runId, _signal, onActionCommitted) => new Promise<void>((resolve) => {
        onActionCommitted?.()
        releaseAction = resolve
      }),
    }))
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(item => item.name === 'ui_open_surface')!
    socket.message({
      type: 'tool.invoke',
      version: 1,
      call_id: 'call-2',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      tool_name: contract.name,
      input: { surface: 'dag_status' },
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + 30_000,
    })
    await vi.waitFor(() => expect(releaseAction).toBeTypeOf('function'))
    socket.message({
      type: 'tool.cancel',
      version: 1,
      call_id: 'call-2',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      reason: 'timeout',
    })
    releaseAction?.()
    await Promise.resolve()

    expect(socket.sent.filter(message => message.type === 'tool.result')).toEqual([expect.objectContaining({
      call_id: 'call-2',
      ok: false,
      terminal_state: 'indeterminate',
      error: 'indeterminate: action may have completed',
    })])
    bridge.stop()
  })

  it('reports indeterminate when a committed executor later rejects', async () => {
    const { bridge, socket } = await connectedBridge(controller({
      openDagStatus: async (_runId, _signal, onActionCommitted) => {
        onActionCommitted?.()
        throw new Error('renderer paint failed')
      },
    }))
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(item => item.name === 'ui_open_surface')!
    socket.message({
      type: 'tool.invoke',
      version: 1,
      call_id: 'call-reject-after-commit',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      tool_name: contract.name,
      input: { surface: 'dag_status' },
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + 30_000,
    })

    await vi.waitFor(() => expect(socket.sent.some(message => message.call_id === 'call-reject-after-commit')).toBe(true))
    expect(socket.sent.at(-1)).toMatchObject({
      call_id: 'call-reject-after-commit',
      ok: false,
      terminal_state: 'indeterminate',
      error: expect.stringContaining('renderer paint failed'),
    })
    bridge.stop()
  })

  it('reports indeterminate when a committed result exceeds the size limit', async () => {
    const hugeState = {
      active_surface: null,
      dag_run_id: null,
      dag_status_view: null,
      widgets: [],
      widgets_truncated: false,
      ambiguous_widget_count: 0,
      diagnostic: 'x'.repeat(BROWSER_TOOLS_MAX_RESULT_BYTES),
    }
    const { bridge, socket } = await connectedBridge(controller({
      getState: () => hugeState,
    }))
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(item => item.name === 'ui_close_surface')!
    socket.message({
      type: 'tool.invoke',
      version: 1,
      call_id: 'call-oversize-after-commit',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      tool_name: contract.name,
      input: { surface: 'dag_status' },
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + 30_000,
    })

    await vi.waitFor(() => expect(socket.sent.some(message => message.call_id === 'call-oversize-after-commit')).toBe(true))
    expect(socket.sent.at(-1)).toMatchObject({
      call_id: 'call-oversize-after-commit',
      ok: false,
      terminal_state: 'indeterminate',
      error: expect.stringContaining('result exceeded size limit'),
    })
    bridge.stop()
  })

  it('aborts pending execution and invalidates the page immediately when disabled', async () => {
    let invocationSignal: AbortSignal | undefined
    const { bridge, socket } = await connectedBridge(controller({
      listDagRuns: signal => new Promise<[]>((_resolve, reject) => {
        invocationSignal = signal
        signal?.addEventListener('abort', () => reject(new DOMException('disabled', 'AbortError')))
      }),
    }))
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(item => item.name === 'ui_open_surface')!
    socket.message({
      type: 'tool.invoke',
      version: 1,
      call_id: 'call-disable',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      tool_name: contract.name,
      input: { surface: 'dag_status' },
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + 30_000,
    })
    await vi.waitFor(() => expect(invocationSignal).toBeDefined())

    bridge.stop('feature_disabled')
    await Promise.resolve()

    expect(invocationSignal?.aborted).toBe(true)
    expect(socket.sent.filter(message => message.type === 'tool.result')).toHaveLength(0)
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'page.invalidated',
      reason: 'feature_disabled',
    })
  })

  it('fails closed on a cancellation reason outside the frozen enum', async () => {
    const statuses: string[] = []
    const socket = new FakeSocket()
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket)
    const ids = ['ui-session', 'tab', 'navigation']
    const bridge = new HomeRailBrowserRendererBridge(controller(), {
      sessionStorage: new MemoryStorage(),
      randomUUID: () => ids.shift()!,
      ticketClient: { request: async () => ({ ticket: 'ticket', expires_in_ms: 60_000 as const }) },
      webSocketFactory,
      onStatus: status => statuses.push(status.state),
    })
    const start = bridge.start()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
    socket.open()
    socket.message(readyMessage(bridge))
    await start

    socket.message({
      type: 'tool.cancel',
      version: 1,
      call_id: 'unknown-call',
      connection_id: 'connection-1',
      navigation_id: bridge.identity.navigation_id,
      reason: 'please-retry',
    })

    expect(socket.closeCode).toBe(4400)
    expect(statuses.at(-1)).toBe('error')
    bridge.stop()
  })

  it('clears the active target on disconnect and lets stop publish disabled after failure', async () => {
    const statuses: string[] = []
    const socket = new FakeSocket()
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket)
    const ids = ['ui-session', 'tab', 'navigation']
    const bridge = new HomeRailBrowserRendererBridge(controller(), {
      sessionStorage: new MemoryStorage(),
      randomUUID: () => ids.shift()!,
      ticketClient: { request: async () => ({ ticket: 'ticket', expires_in_ms: 60_000 as const }) },
      webSocketFactory,
      onStatus: status => statuses.push(status.state),
    })
    const start = bridge.start()
    await vi.waitFor(() => expect(webSocketFactory).toHaveBeenCalledOnce())
    socket.open()
    socket.message(readyMessage(bridge))
    await start
    socket.disconnect()

    expect(currentBrowserToolsTurnBinding()).toEqual({ browser_tools_transport: 'none' })
    expect(statuses.at(-1)).toBe('unavailable')
    bridge.stop()
    expect(statuses.at(-1)).toBe('disabled')
  })
})

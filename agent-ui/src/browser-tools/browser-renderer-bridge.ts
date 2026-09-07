import { sameOriginWebSocketUrl } from '@/api/clients/runtime-url'
import {
  BROWSER_RENDERER_TOOLS_TICKET_PATH,
  BROWSER_RENDERER_TOOLS_TICKET_TTL_MS,
  BROWSER_RENDERER_TOOLS_WS_PATH,
  BROWSER_TOOLS_CAPABILITIES,
  BROWSER_TOOLS_MAX_MESSAGE_BYTES,
  BROWSER_TOOLS_MAX_RESULT_BYTES,
  BROWSER_TOOLS_PROTOCOL_VERSION,
  HOMERAIL_UI_TOOL_CONTRACTS,
  type BrowserRendererConnectionRefV1,
  type BrowserRendererInvalidatedMessageV1,
  type BrowserRendererTargetV1,
  type BrowserRendererTicketResponseV1,
  uiToolContractDigest,
} from 'homerail-protocol'
import type { HomeRailUiSurfaceController } from './ui-surface-controller'
import { executeHomeRailUiTool } from './ui-surface-controller'

const UI_SESSION_ID_KEY = 'homerail.browserTools.uiSessionId.v1'
const TAB_ID_KEY = 'homerail.browserTools.tabId.v1'
const AUTH_TIMEOUT_MS = 10_000
const MAX_CALL_ID_CHARACTERS = 256
const MAX_CONNECTION_ID_CHARACTERS = 256
const MAX_ERROR_CHARACTERS = 2_000
const SOCKET_OPEN = 1
const CANONICAL_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_RENDERER_DEADLINE_MS = 30_000

export type BrowserRendererBridgeState =
  | 'disabled'
  | 'starting'
  | 'connected'
  | 'unavailable'
  | 'error'

export interface BrowserRendererBridgeStatus {
  state: BrowserRendererBridgeState
  target: BrowserRendererConnectionRefV1 | null
  error?: string
}

interface RendererTicketClient {
  request(
    target: BrowserRendererTargetV1,
    signal: AbortSignal,
  ): Promise<BrowserRendererTicketResponseV1>
}

interface BrowserCryptoSource {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

interface BrowserRendererBridgeDependencies {
  sessionStorage?: Storage | null
  randomUUID?: () => string
  crypto?: BrowserCryptoSource | null
  ticketClient?: RendererTicketClient
  webSocketFactory?: (url: string) => WebSocket
  now?: () => number
  onStatus?: (status: BrowserRendererBridgeStatus) => void
}

interface PendingInvocation {
  abortController: AbortController
  actionCommitted: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

let currentTarget: BrowserRendererConnectionRefV1 | null = null
let desktopTransportAvailable = false

export type BrowserToolsTransport = 'renderer' | 'desktop' | 'none'

export type BrowserToolsTurnBinding =
  | {
      browser_tools_transport: 'renderer'
      browser_tools_target: BrowserRendererConnectionRefV1
    }
  | {
      browser_tools_transport: 'desktop' | 'none'
    }

/**
 * Return the exact, authenticated renderer target for a new Manager turn.
 * Consumers receive a copy so a later navigation cannot mutate an in-flight
 * request after it has been serialized.
 */
export function currentBrowserRendererTarget(): BrowserRendererConnectionRefV1 | null {
  return currentTarget ? { ...currentTarget } : null
}

export function currentBrowserToolsTurnBinding(): BrowserToolsTurnBinding {
  const target = currentBrowserRendererTarget()
  if (target) return { browser_tools_transport: 'renderer', browser_tools_target: target }
  return { browser_tools_transport: desktopTransportAvailable ? 'desktop' : 'none' }
}

export function setDesktopBrowserToolsTransportAvailable(available: boolean): void {
  desktopTransportAvailable = available
}

function publishCurrentTarget(target: BrowserRendererConnectionRefV1 | null): void {
  currentTarget = target ? { ...target } : null
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function safeIdentifier(value: unknown, name: string, max = 256): string {
  if (
    typeof value !== 'string'
    || !value
    || [...value].length > max
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function exactKeys(message: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(message).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('Browser renderer message contains unsupported fields')
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
  if (error instanceof Error) return error.message.slice(0, MAX_ERROR_CHARACTERS)
  return String(error).slice(0, MAX_ERROR_CHARACTERS)
}

function abortError(message = 'Browser renderer operation was cancelled'): DOMException {
  return new DOMException(message, 'AbortError')
}

function randomIdentifier(
  randomUUID?: () => string,
  cryptoSource?: BrowserCryptoSource | null,
): string {
  if (randomUUID) return randomUUID()
  const secureCrypto = cryptoSource === undefined
    ? (typeof crypto === 'undefined' ? null : crypto)
    : cryptoSource
  if (typeof secureCrypto?.randomUUID === 'function') {
    try {
      return secureCrypto.randomUUID()
    } catch {
      // Some non-secure browser contexts expose the method but reject calls.
    }
  }
  if (typeof secureCrypto?.getRandomValues === 'function') {
    const bytes = secureCrypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error('Secure browser identifiers are unavailable')
}

function stableSessionIdentifier(
  storage: Storage | null,
  key: string,
  randomUUID?: () => string,
  cryptoSource?: BrowserCryptoSource | null,
): string {
  try {
    const existing = storage?.getItem(key)
    if (existing) return safeIdentifier(existing, key, 128)
  } catch {
    // A blocked sessionStorage still permits a safe in-memory page session.
  }
  const generated = safeIdentifier(randomIdentifier(randomUUID, cryptoSource), key, 128)
  try {
    storage?.setItem(key, generated)
  } catch {
    // Keep the generated identity in memory for this page load.
  }
  return generated
}

export interface BrowserRendererPageIdentity extends BrowserRendererTargetV1 {}

/**
 * ui_session_id and tab_id survive a same-tab refresh through sessionStorage;
 * navigation_id is deliberately regenerated for every loaded document.
 */
export function createBrowserRendererPageIdentity(
  dependencies: Pick<
    BrowserRendererBridgeDependencies,
    'sessionStorage' | 'randomUUID' | 'crypto'
  > = {},
): BrowserRendererPageIdentity {
  const storage = dependencies.sessionStorage === undefined
    ? currentSessionStorage()
    : dependencies.sessionStorage
  return {
    ui_session_id: stableSessionIdentifier(
      storage,
      UI_SESSION_ID_KEY,
      dependencies.randomUUID,
      dependencies.crypto,
    ),
    tab_id: stableSessionIdentifier(
      storage,
      TAB_ID_KEY,
      dependencies.randomUUID,
      dependencies.crypto,
    ),
    navigation_id: safeIdentifier(
      randomIdentifier(dependencies.randomUUID, dependencies.crypto),
      'navigation_id',
      128,
    ),
  }
}

function currentSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function defaultWebSocketUrl(): string {
  return sameOriginWebSocketUrl(undefined, BROWSER_RENDERER_TOOLS_WS_PATH)
}

const defaultTicketClient: RendererTicketClient = {
  async request(target, signal) {
    const response = await fetch(BROWSER_RENDERER_TOOLS_TICKET_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Browser renderer ticket request failed: HTTP ${response.status}`)
    }
    const payload = record(await response.json(), 'Browser renderer ticket response')
    if (payload.success !== true) throw new Error('Browser renderer ticket request failed')
    const data = record(payload.data, 'Browser renderer ticket data')
    const ticket = safeIdentifier(data.ticket, 'ticket', 256)
    if (!CANONICAL_TICKET_PATTERN.test(ticket)) {
      throw new Error('Browser renderer ticket format is invalid')
    }
    const expiresInMs = data.expires_in_ms
    if (
      !Number.isSafeInteger(expiresInMs)
      || Number(expiresInMs) <= 0
      || Number(expiresInMs) > BROWSER_RENDERER_TOOLS_TICKET_TTL_MS
    ) {
      throw new Error('Browser renderer ticket expiry is invalid')
    }
    return { ticket, expires_in_ms: BROWSER_RENDERER_TOOLS_TICKET_TTL_MS }
  },
}

export class HomeRailBrowserRendererBridge {
  readonly identity: BrowserRendererPageIdentity

  private readonly controller: HomeRailUiSurfaceController
  private readonly dependencies: BrowserRendererBridgeDependencies
  private socket: WebSocket | null = null
  private ticketAbort: AbortController | null = null
  private connectionId: string | null = null
  private maxConcurrentCalls = 0
  private stopped = true
  private generation = 0
  private pending = new Map<string, PendingInvocation>()
  private status: BrowserRendererBridgeStatus = { state: 'disabled', target: null }
  private startReject: ((error: Error) => void) | null = null

  constructor(
    controller: HomeRailUiSurfaceController,
    dependencies: BrowserRendererBridgeDependencies = {},
  ) {
    this.controller = controller
    this.dependencies = dependencies
    this.identity = createBrowserRendererPageIdentity(dependencies)
  }

  get currentStatus(): BrowserRendererBridgeStatus {
    return {
      ...this.status,
      target: this.status.target ? { ...this.status.target } : null,
    }
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    const generation = ++this.generation
    this.stopped = false
    this.updateStatus({ state: 'starting', target: null })
    const ticketAbort = new AbortController()
    this.ticketAbort = ticketAbort
    try {
      const ticket = await (this.dependencies.ticketClient ?? defaultTicketClient)
        .request(this.identity, ticketAbort.signal)
      if (!this.isCurrentGeneration(generation) || ticketAbort.signal.aborted) throw abortError()
      await this.authenticate(ticket.ticket, generation)
    } catch (error) {
      if (
        generation !== this.generation
        || (
          error instanceof DOMException
          && error.name === 'AbortError'
          && ticketAbort.signal.aborted
        )
      ) throw abortError()
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.failCurrent(normalized, generation)
      throw normalized
    } finally {
      if (this.ticketAbort === ticketAbort) this.ticketAbort = null
    }
  }

  stop(reason: BrowserRendererInvalidatedMessageV1['reason'] = 'feature_disabled'): void {
    this.generation += 1
    this.stopped = true
    this.ticketAbort?.abort()
    this.ticketAbort = null
    const rejectStart = this.startReject
    this.startReject = null
    rejectStart?.(abortError())
    const socket = this.socket
    const connectionId = this.connectionId
    if (socket?.readyState === SOCKET_OPEN && connectionId) {
      try {
        this.sendOnSocket(socket, {
          type: 'page.invalidated',
          version: BROWSER_TOOLS_PROTOCOL_VERSION,
          connection_id: connectionId,
          navigation_id: this.identity.navigation_id,
          reason,
        })
      } catch {
        // Local revocation and abort must still complete if the socket vanished.
      }
    }
    this.abortPending(false)
    this.clearConnectionTarget()
    this.socket = null
    socket?.close(1000, 'Browser renderer disabled')
    this.updateStatus({ state: 'disabled', target: null })
  }

  private authenticate(ticket: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let authTimer: ReturnType<typeof setTimeout> | null = null
      let rejectStart: (error: Error) => void = () => undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (this.startReject === rejectStart) this.startReject = null
        if (authTimer) clearTimeout(authTimer)
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        if (this.startReject === rejectStart) this.startReject = null
        if (authTimer) clearTimeout(authTimer)
        reject(error)
      }
      rejectStart = (error: Error): void => fail(error)
      this.startReject = rejectStart
      let socket: WebSocket
      try {
        socket = (this.dependencies.webSocketFactory ?? (url => new WebSocket(url)))(
          defaultWebSocketUrl(),
        )
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!this.isCurrentGeneration(generation)) {
        fail(abortError())
        socket.close()
        return
      }
      this.socket = socket
      authTimer = setTimeout(() => {
        const error = new Error('Browser renderer authentication timed out')
        fail(error)
        this.failCurrent(error, generation, socket)
      }, AUTH_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        if (!this.isCurrentSocket(generation, socket)) {
          fail(abortError())
          socket.close()
          return
        }
        this.sendOnSocket(socket, {
          type: 'auth.ticket',
          version: BROWSER_TOOLS_PROTOCOL_VERSION,
          ticket,
          ...this.identity,
          contracts: HOMERAIL_UI_TOOL_CONTRACTS.map(contract => ({
            name: contract.name,
            contract_digest: uiToolContractDigest(contract),
          })),
        })
      })
      socket.addEventListener('message', (event) => {
        if (!this.isCurrentSocket(generation, socket)) {
          fail(abortError())
          return
        }
        try {
          const message = this.parseMessage(event.data)
          if (!this.connectionId) {
            this.acceptReady(message)
            finish()
            return
          }
          this.handleAuthenticatedMessage(message)
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error))
          fail(normalized)
          this.failCurrent(normalized, generation, socket)
        }
      })
      socket.addEventListener('error', () => {
        if (!this.isCurrentSocket(generation, socket)) return
        const error = new Error('Browser renderer WebSocket failed')
        fail(error)
        this.failCurrent(error, generation, socket)
      })
      socket.addEventListener('close', (event) => {
        if (!this.isCurrentSocket(generation, socket)) {
          fail(abortError())
          return
        }
        if (authTimer) clearTimeout(authTimer)
        this.socket = null
        const wasStopped = this.stopped
        this.stopped = true
        this.abortPending(false)
        this.clearConnectionTarget()
        if (!wasStopped) {
          const message = event.reason || 'Browser renderer connection closed'
          const error = new Error(message)
          fail(error)
          this.updateStatus({ state: 'unavailable', target: null, error: message })
        }
      })
    })
  }

  private acceptReady(message: Record<string, unknown>): void {
    exactKeys(message, [
      'type',
      'version',
      'connection_id',
      'ui_session_id',
      'tab_id',
      'navigation_id',
      'capabilities',
      'max_message_bytes',
      'max_result_bytes',
      'max_concurrent_calls',
    ])
    if (message.type !== 'auth.ready' || message.version !== BROWSER_TOOLS_PROTOCOL_VERSION) {
      throw new Error('Expected browser renderer auth.ready')
    }
    const capabilities = message.capabilities
    if (
      !Array.isArray(capabilities)
      || capabilities.length !== BROWSER_TOOLS_CAPABILITIES.length
      || !BROWSER_TOOLS_CAPABILITIES.every(capability => capabilities.includes(capability))
    ) {
      throw new Error('Browser renderer capabilities are incompatible')
    }
    if (
      message.ui_session_id !== this.identity.ui_session_id
      || message.tab_id !== this.identity.tab_id
      || message.navigation_id !== this.identity.navigation_id
    ) {
      throw new Error('Browser renderer ready target mismatch')
    }
    if (
      message.max_message_bytes !== BROWSER_TOOLS_MAX_MESSAGE_BYTES
      || message.max_result_bytes !== BROWSER_TOOLS_MAX_RESULT_BYTES
    ) {
      throw new Error('Browser renderer size limits are incompatible')
    }
    if (
      !Number.isSafeInteger(message.max_concurrent_calls)
      || Number(message.max_concurrent_calls) < 1
      || Number(message.max_concurrent_calls) > 64
    ) {
      throw new Error('Browser renderer concurrency limit is invalid')
    }
    this.maxConcurrentCalls = Number(message.max_concurrent_calls)
    this.connectionId = safeIdentifier(
      message.connection_id,
      'connection_id',
      MAX_CONNECTION_ID_CHARACTERS,
    )
    const target: BrowserRendererConnectionRefV1 = {
      ...this.identity,
      connection_id: this.connectionId,
    }
    publishCurrentTarget(target)
    this.updateStatus({ state: 'connected', target })
  }

  private handleAuthenticatedMessage(message: Record<string, unknown>): void {
    if (message.version !== BROWSER_TOOLS_PROTOCOL_VERSION) {
      throw new Error('Unsupported browser renderer protocol version')
    }
    if (message.type === 'tool.invoke') {
      this.handleInvocation(message)
      return
    }
    if (message.type === 'tool.cancel') {
      this.handleCancellation(message)
      return
    }
    throw new Error('Unsupported browser renderer message')
  }

  private handleInvocation(message: Record<string, unknown>): void {
    exactKeys(message, [
      'type',
      'version',
      'call_id',
      'connection_id',
      'navigation_id',
      'tool_name',
      'input',
      'contract_digest',
      'deadline_ms',
    ])
    const callId = safeIdentifier(message.call_id, 'call_id', MAX_CALL_ID_CHARACTERS)
    this.assertTarget(message)
    if (this.pending.has(callId)) throw new Error('Duplicate browser renderer call_id')
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find(candidate => candidate.name === message.tool_name)
    if (!contract || contract.page_exposure !== 'webmcp_local') {
      throw new Error('Browser renderer tool is not in the frozen catalog')
    }
    if (message.contract_digest !== uiToolContractDigest(contract)) {
      throw new Error('Browser renderer contract digest mismatch')
    }
    if (this.pending.size >= this.maxConcurrentCalls) {
      this.sendResult(callId, false, 'failed', undefined, 'too many concurrent calls')
      return
    }
    const deadlineMs = message.deadline_ms
    if (!Number.isSafeInteger(deadlineMs)) throw new Error('Browser renderer deadline is invalid')
    const remainingMs = Number(deadlineMs) - (this.dependencies.now ?? Date.now)()
    if (remainingMs > MAX_RENDERER_DEADLINE_MS) {
      throw new Error('Browser renderer deadline exceeds the protocol limit')
    }
    if (remainingMs <= 0) {
      this.sendResult(callId, false, 'cancelled', undefined, 'deadline exceeded')
      return
    }
    const invocation: PendingInvocation = {
      abortController: new AbortController(),
      actionCommitted: false,
      settled: false,
      timer: null,
    }
    invocation.timer = setTimeout(() => {
      this.cancelInvocation(callId, invocation, 'deadline exceeded')
    }, remainingMs)
    this.pending.set(callId, invocation)
    void executeHomeRailUiTool(
      contract.name,
      message.input,
      this.controller,
      {
        signal: invocation.abortController.signal,
        onActionCommitted: () => { invocation.actionCommitted = true },
      },
    ).then((output) => {
      if (invocation.settled) return
      const serialized = JSON.stringify(output ?? null)
      if (utf8Bytes(serialized) > BROWSER_TOOLS_MAX_RESULT_BYTES) {
        this.finishExecutionFailure(callId, invocation, 'result exceeded size limit')
        return
      }
      this.finishInvocation(callId, invocation, true, 'completed', output)
    }).catch((error) => {
      if (invocation.settled) return
      this.finishExecutionFailure(callId, invocation, errorMessage(error))
    })
  }

  private handleCancellation(message: Record<string, unknown>): void {
    exactKeys(message, [
      'type',
      'version',
      'call_id',
      'connection_id',
      'navigation_id',
      'reason',
    ])
    this.assertTarget(message)
    const callId = safeIdentifier(message.call_id, 'call_id', MAX_CALL_ID_CHARACTERS)
    if (
      message.reason !== 'timeout'
      && message.reason !== 'cancelled'
      && message.reason !== 'connection_closed'
      && message.reason !== 'navigation_invalidated'
    ) {
      throw new Error('Browser renderer cancellation reason is invalid')
    }
    const invocation = this.pending.get(callId)
    if (!invocation) return
    this.cancelInvocation(callId, invocation, 'cancelled')
  }

  private cancelInvocation(
    callId: string,
    invocation: PendingInvocation,
    reason: string,
  ): void {
    if (invocation.settled) return
    invocation.abortController.abort()
    const terminalState = invocation.actionCommitted ? 'indeterminate' : 'cancelled'
    const error = invocation.actionCommitted
      ? 'indeterminate: action may have completed'
      : reason
    this.finishInvocation(callId, invocation, false, terminalState, undefined, error)
  }

  private finishInvocation(
    callId: string,
    invocation: PendingInvocation,
    ok: boolean,
    terminalState: 'completed' | 'failed' | 'cancelled' | 'indeterminate',
    output?: unknown,
    error?: string,
  ): void {
    if (invocation.settled) return
    invocation.settled = true
    if (invocation.timer) clearTimeout(invocation.timer)
    invocation.timer = null
    this.pending.delete(callId)
    this.sendResult(callId, ok, terminalState, output, error)
  }

  private finishExecutionFailure(
    callId: string,
    invocation: PendingInvocation,
    error: string,
  ): void {
    const indeterminate = invocation.actionCommitted
    this.finishInvocation(
      callId,
      invocation,
      false,
      indeterminate ? 'indeterminate' : 'failed',
      undefined,
      indeterminate
        ? `indeterminate: action may have completed (${error})`
        : error,
    )
  }

  private sendResult(
    callId: string,
    ok: boolean,
    terminalState: 'completed' | 'failed' | 'cancelled' | 'indeterminate',
    output?: unknown,
    error?: string,
  ): void {
    if (!this.connectionId || this.socket?.readyState !== SOCKET_OPEN) return
    this.send({
      type: 'tool.result',
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: callId,
      connection_id: this.connectionId,
      navigation_id: this.identity.navigation_id,
      ok,
      terminal_state: terminalState,
      ...(ok ? { output } : { error: (error || 'Browser renderer tool failed').slice(0, MAX_ERROR_CHARACTERS) }),
    })
  }

  private assertTarget(message: Record<string, unknown>): void {
    if (
      safeIdentifier(message.connection_id, 'connection_id') !== this.connectionId
      || safeIdentifier(message.navigation_id, 'navigation_id') !== this.identity.navigation_id
    ) {
      throw new Error('Browser renderer target mismatch')
    }
  }

  private parseMessage(data: unknown): Record<string, unknown> {
    if (typeof data !== 'string') throw new Error('Browser renderer requires text messages')
    if (utf8Bytes(data) > BROWSER_TOOLS_MAX_MESSAGE_BYTES) {
      throw new Error('Browser renderer message exceeded size limit')
    }
    return record(JSON.parse(data), 'Browser renderer message')
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new Error('Browser renderer WebSocket is unavailable')
    }
    this.sendOnSocket(socket, message)
  }

  private sendOnSocket(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== SOCKET_OPEN) {
      throw new Error('Browser renderer WebSocket is unavailable')
    }
    const serialized = JSON.stringify(message)
    if (utf8Bytes(serialized) > BROWSER_TOOLS_MAX_MESSAGE_BYTES) {
      throw new Error('Browser renderer message exceeded size limit')
    }
    socket.send(serialized)
  }

  private failCurrent(
    error: Error,
    generation: number,
    socket?: WebSocket,
  ): void {
    if (!this.isCurrentGeneration(generation)) return
    if (socket && this.socket !== socket) return
    this.stopped = true
    this.ticketAbort?.abort()
    this.ticketAbort = null
    this.abortPending(false)
    this.clearConnectionTarget()
    const activeSocket = this.socket
    this.socket = null
    activeSocket?.close(4400, 'Browser renderer protocol error')
    this.updateStatus({ state: 'error', target: null, error: error.message })
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  private isCurrentSocket(generation: number, socket: WebSocket): boolean {
    return this.isCurrentGeneration(generation) && this.socket === socket
  }

  private abortPending(sendResult: boolean): void {
    for (const [callId, invocation] of this.pending) {
      invocation.abortController.abort()
      invocation.settled = true
      if (invocation.timer) clearTimeout(invocation.timer)
      if (sendResult) {
        this.sendResult(
          callId,
          false,
          invocation.actionCommitted ? 'indeterminate' : 'cancelled',
          undefined,
          invocation.actionCommitted
          ? 'indeterminate: action may have completed'
          : 'cancelled',
        )
      }
    }
    this.pending.clear()
  }

  private clearConnectionTarget(): void {
    if (currentTarget?.connection_id === this.connectionId) publishCurrentTarget(null)
    this.connectionId = null
  }

  private updateStatus(status: BrowserRendererBridgeStatus): void {
    this.status = {
      ...status,
      target: status.target ? { ...status.target } : null,
    }
    this.dependencies.onStatus?.(this.currentStatus)
  }
}

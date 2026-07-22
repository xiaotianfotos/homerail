/**
 * ============================================================================
 * WebSocket Client - Reconnectable WebSocket client for real-time updates
 * ============================================================================
 *
 * Features:
 * - Auto reconnection with exponential backoff
 * - Heartbeat/ping-pong mechanism
 * - Event-based message handling
 * - Connection state management
 */

import { defaultWebSocketUrl } from './runtime-url'

// ============================================================================
// Types
// ============================================================================

export type WebSocketState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

export interface WebSocketMessage<T = unknown> {
  type: string
  /** Client-originated messages use data; Manager event messages use payload. */
  data?: T
  payload?: T
  event?: string
  timestamp?: number | string
}

export interface WebSocketClientConfig {
  url: string
  reconnect?: boolean
  reconnectInterval?: number
  maxReconnectAttempts?: number
  heartbeatInterval?: number
}

export type MessageHandler<T = unknown> = (message: WebSocketMessage<T>) => void
export type StateHandler = (state: WebSocketState) => void

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RECONNECT_INTERVAL = 3000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
const DEFAULT_HEARTBEAT_INTERVAL = 30000

// ============================================================================
// WebSocket Client Class
// ============================================================================

export class WebSocketClient {
  private ws: WebSocket | null = null
  private config: Required<WebSocketClientConfig>
  private state: WebSocketState = 'disconnected'
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Event handlers
  private messageHandlers: Map<string, Set<MessageHandler>> = new Map()
  private stateHandlers: Set<StateHandler> = new Set()

  constructor(config: WebSocketClientConfig) {
    this.config = {
      url: config.url,
      reconnect: config.reconnect ?? true,
      reconnectInterval: config.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      heartbeatInterval: config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
    }
  }

  // --------------------------------------------------------------------------
  // Connection Management
  // --------------------------------------------------------------------------

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    this.updateState('connecting')

    try {
      this.ws = new WebSocket(this.config.url)
      this.setupEventListeners()
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error)
      this.handleConnectionError()
    }
  }

  disconnect(): void {
    this.stopHeartbeat()
    this.clearReconnectTimer()
    this.reconnectAttempts = 0

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }

    this.updateState('disconnected')
  }

  // --------------------------------------------------------------------------
  // Event Listeners Setup
  // --------------------------------------------------------------------------

  private setupEventListeners(): void {
    if (!this.ws) return

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected')
      this.reconnectAttempts = 0
      this.updateState('connected')
      this.startHeartbeat()
    }

    this.ws.onclose = (event) => {
      console.log('[WebSocket] Disconnected:', event.code, event.reason)
      this.stopHeartbeat()

      if (this.config.reconnect && event.code !== 1000) {
        this.attemptReconnect()
      } else {
        this.updateState('disconnected')
      }
    }

    this.ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data)
    }
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as WebSocketMessage

      // Handle heartbeat response
      if (message.type === 'pong') {
        return
      }

      // Dispatch to type-specific handlers
      const handlers = this.messageHandlers.get(message.type)
      if (handlers) {
        handlers.forEach((handler) => handler(message))
      }

      // Dispatch to wildcard handlers
      const wildcardHandlers = this.messageHandlers.get('*')
      if (wildcardHandlers) {
        wildcardHandlers.forEach((handler) => handler(message))
      }
    } catch (error) {
      console.error('[WebSocket] Message parse error:', error)
    }
  }

  send<T>(type: string, data: T): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocket] Cannot send - not connected')
      return false
    }

    const message: WebSocketMessage<T> = {
      type,
      data,
      timestamp: Date.now(),
    }

    this.ws.send(JSON.stringify(message))
    return true
  }

  // --------------------------------------------------------------------------
  // Reconnection Logic
  // --------------------------------------------------------------------------

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnect attempts reached')
      this.updateState('disconnected')
      return
    }

    this.updateState('reconnecting')
    this.reconnectAttempts++

    // Exponential backoff
    const delay = this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1)

    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private handleConnectionError(): void {
    if (this.config.reconnect) {
      this.attemptReconnect()
    } else {
      this.updateState('disconnected')
    }
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat()

    this.heartbeatTimer = setInterval(() => {
      this.send('ping', {})
    }, this.config.heartbeatInterval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  private updateState(newState: WebSocketState): void {
    if (this.state !== newState) {
      this.state = newState
      this.stateHandlers.forEach((handler) => handler(newState))
    }
  }

  getState(): WebSocketState {
    return this.state
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  // --------------------------------------------------------------------------
  // Event Subscription
  // --------------------------------------------------------------------------

  on<T = unknown>(type: string, handler: MessageHandler<T>): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set())
    }

    this.messageHandlers.get(type)!.add(handler as MessageHandler)

    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(type)?.delete(handler as MessageHandler)
    }
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler)

    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  off(type: string, handler?: MessageHandler): void {
    if (handler) {
      this.messageHandlers.get(type)?.delete(handler)
    } else {
      this.messageHandlers.delete(type)
    }
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  setUrl(url: string): void {
    const wasConnected = this.isConnected()
    this.disconnect()
    this.config.url = url

    if (wasConnected) {
      this.connect()
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createWebSocketClient(config: WebSocketClientConfig): WebSocketClient {
  return new WebSocketClient(config)
}

// ============================================================================
// Default Instance
// ============================================================================

export const ws = new WebSocketClient({ url: defaultWebSocketUrl() })

export default WebSocketClient

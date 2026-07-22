// ============================================================================
// FRONTEND EVENT BUS
// ============================================================================
/**
 * 前端事件总线
 *
 * 基于 Mitt 实现的轻量级发布订阅系统，用于组件间通信。
 *
 * 事件类型:
 * - `run:*`: Run 相关事件
 * - `worker:*`: Worker 相关事件
 * - `manager:*`: Manager 相关事件
 * - `system:*`: 系统级事件
 *
 * @example
 * ```typescript
 * // 监听事件
 * eventBus.on('run:message', (data) => {
 *   console.log('New run message:', data)
 * })
 *
 * // 发送事件
 * eventBus.emit('run:message', { runId, message })
 *
 * // 取消监听
 * eventBus.off('run:message', handler)
 * ```
 */

import mitt, { type Emitter } from 'mitt'

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * 所有可用的事件类型
 */
export interface EventBusEvents {
  [key: string]: unknown
  [key: symbol]: unknown

  // ========================================================================
  // RUN 事件
  // ========================================================================
  /** Run 消息事件 */
  'run:message': RunMessageEvent
  /** Run 状态变化事件 (从 created/running/completed 推断) */
  'run:status': RunStatusEvent
  /** Run 状态变化事件 (后端推送的新事件) */
  'run:status_changed': RunStatusChangedEvent
  /** Run Phase 变化事件 (后端推送的新事件) */
  'run:phase_changed': RunPhaseChangedEvent
  /** Run 进度更新事件 */
  'run:progress': RunProgressEvent

  // ========================================================================
  // WORKER 事件
  // ========================================================================
  /** Worker 启动事件 */
  'worker:started': WorkerStartedEvent
  /** Worker 完成事件 */
  'worker:completed': WorkerCompletedEvent
  /** Worker 错误事件 */
  'worker:error': WorkerErrorEvent

  // ========================================================================
  // MANAGER 事件
  // ========================================================================
  /** Manager 消息事件 */
  'manager:message': ManagerMessageEvent

  // ========================================================================
  // DAG 事件
  // ========================================================================
  /** DAG 执行状态更新 */
  'dag:status_update': DAGStatusUpdateEvent
  /** DAG 节点状态变化 */
  'dag:node_state_changed': DAGNodeStateChangedEvent
  /** DAG 节点新消息 */
  'dag:node_message': DAGNodeMessageEvent
  /** DAG 节点聊天落库通知（正文仍通过 REST 获取） */
  'dag:node_chat_updated': DAGNodeChatUpdatedEvent
  /** DAG 节点调度事件 */
  'dag:node_dispatched': DAGNodeDispatchedEvent
  /** DAG 节点 handoff 事件 */
  'dag:handoff': DAGHandoffEvent

  // ========================================================================
  // TEMPLATE BUILD 事件 (Template Build Events)
  // ========================================================================
  /** 模板构建开始事件 */
  'template:build:started': TemplateBuildStartedEvent
  /** 模板构建进度事件 */
  'template:build:progress': TemplateBuildProgressEvent
  /** 模板构建完成事件 */
  'template:build:completed': TemplateBuildCompletedEvent
  /** 模板构建节点开始事件 */
  'template:build:node:started': TemplateBuildNodeStartedEvent
  /** 模板构建节点进度事件 */
  'template:build:node:progress': TemplateBuildNodeProgressEvent
  /** 模板构建节点完成事件 */
  'template:build:node:completed': TemplateBuildNodeCompletedEvent
  /** 模板构建节点失败事件 */
  'template:build:node:failed': TemplateBuildNodeFailedEvent
  /** 模板构建取消事件 */
  'template:build:cancelled': TemplateBuildCancelledEvent

  // ========================================================================
  // 系统事件
  // ========================================================================
  /** WebSocket 连接事件 */
  'ws:connected': WebSocketConnectedEvent
  /** WebSocket 断开事件 */
  'ws:disconnected': WebSocketDisconnectedEvent
  /** WebSocket 错误事件 */
  'ws:error': WebSocketErrorEvent
}

type EventBusKey = keyof EventBusEvents & string

// ============================================================================
// EVENT DATA TYPES
// ============================================================================

export interface RunMessageEvent {
  runId: string
  source: string  // 允许任意字符串（如 "manager" 或具体 worker 名字）
  workerName?: string
  message: any
  roundId?: string  // 🔧 添加轮次 ID
  timestamp: string
}

export interface RunStatusEvent {
  runId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  previousStatus?: string
  timestamp: string
}

export interface RunProgressEvent {
  runId: string
  stage: string
  progress: number
  message?: string
  timestamp: string
}

/** Run 状态变化事件数据 (来自后端 RunStatusChangedEvent) */
export interface RunStatusChangedEvent {
  runId: string
  previousStatus: string  // "created" | "starting" | "running" | "completed" | "failed"
  currentStatus: string
  reason?: string
  timestamp: string
}

/** Run Phase 变化事件数据 (来自后端 RunPhaseChangedEvent) */
export interface RunPhaseChangedEvent {
  runId: string
  previousPhase: string | null
  currentPhase: string
  phaseIndex: number
  reason?: string
  timestamp: string
}

export interface WorkerStartedEvent {
  runId: string
  workerName: string
  workerId: string
  timestamp: string
}

export interface WorkerCompletedEvent {
  runId: string
  workerName: string
  workerId: string
  result?: any
  timestamp: string
}

export interface WorkerErrorEvent {
  runId: string
  workerName: string
  workerId: string
  error: string
  timestamp: string
}

export interface ManagerMessageEvent {
  runId: string
  message: any
  timestamp: string
}

// ============================================================================
// DAG EVENT DATA TYPES
// ============================================================================

export interface DAGStatusUpdateEvent {
  run_id: string
  dag_run_id: string
  runId?: string
  status: string
  nodes: Array<{ id: string; name: string; status: string }>
  timestamp: string
}

export interface DAGNodeStateChangedEvent {
  run_id: string
  dag_run_id: string
  runId?: string
  node_id: string
  nodeId?: string
  node_name: string
  status: string
  previous_status?: string
  previousStatus?: string
  timestamp: string
}

export interface DAGNodeMessageEvent {
  dag_run_id: string
  node_id: string
  message: any
  timestamp: string
}

export interface DAGNodeChatUpdatedEvent {
  runId: string
  nodeId: string
  timestamp: string
}

export interface DAGNodeDispatchedEvent {
  dag_run_id: string
  node_id: string
  node_name: string
  worker_id?: string
  worker_name?: string
  timestamp: string
}

export interface DAGHandoffEvent {
  dag_run_id: string
  from_node: string
  from_port: string
  summary?: string
  timestamp: string
}

// ============================================================================
// TEMPLATE BUILD EVENT DATA TYPES
// ============================================================================

export interface TemplateBuildStartedEvent {
  template_id: string
  template_name: string
  target_nodes: string[]
  image_tag: string
  build_task_id: string
  timestamp: string
}

export interface TemplateBuildProgressEvent {
  template_id: string
  build_task_id: string
  total_nodes: number
  completed_nodes: number
  failed_nodes: number
  progress_percent: number
  current_phase: string
  message: string
  timestamp: string
}

export interface TemplateBuildCompletedEvent {
  template_id: string
  build_task_id: string
  total_nodes: number
  success_count: number
  failed_count: number
  duration_ms: number
  success: boolean
  node_results: Array<{
    node_id: string
    node_name: string
    status: string
    success: boolean
    error?: string
  }>
  timestamp: string
}

export interface TemplateBuildNodeStartedEvent {
  template_id: string
  build_task_id: string
  node_id: string
  node_name: string
  image_tag: string
  timestamp: string
}

export interface TemplateBuildNodeProgressEvent {
  template_id: string
  build_task_id: string
  node_id: string
  node_name: string
  stage: string
  progress_percent: number
  message: string
  timestamp: string
}

export interface TemplateBuildNodeCompletedEvent {
  template_id: string
  build_task_id: string
  node_id: string
  node_name: string
  success: boolean
  image_tag: string
  duration_ms: number
  error?: string
  output?: string
  timestamp: string
}

export interface TemplateBuildNodeFailedEvent {
  template_id: string
  build_task_id: string
  node_id: string
  node_name: string
  error_type: string
  error_message: string
  retry_count: number
  timestamp: string
}

export interface TemplateBuildCancelledEvent {
  template_id: string
  build_task_id: string
  cancelled_by: string
  reason: string
  timestamp: string
}

export interface WebSocketConnectedEvent {
  connectionId: string
  timestamp: string
}

export interface WebSocketDisconnectedEvent {
  connectionId: string
  reason?: string
  timestamp: string
}

export interface WebSocketErrorEvent {
  connectionId: string
  error: string
  timestamp: string
}

// ============================================================================
// EVENT BUS IMPLEMENTATION
// ============================================================================

/**
 * 全局事件总线实例
 */
export const eventBus: Emitter<EventBusEvents> = mitt<EventBusEvents>()

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * 便捷的监听函数
 *
 * @param type 事件类型
 * @param handler 事件处理函数
 * @returns 取消监听的函数
 */
export function onEvent<K extends EventBusKey>(
  type: K,
  handler: (event: EventBusEvents[K]) => void
): () => void {
  eventBus.on(type, handler)

  // 返回取消监听的函数
  return () => eventBus.off(type, handler)
}

/**
 * 便捷的一次性监听函数
 *
 * @param type 事件类型
 * @param handler 事件处理函数
 */
export function onceEvent<K extends EventBusKey>(
  type: K,
  handler: (event: EventBusEvents[K]) => void
): void {
  const wrappedHandler = (event: EventBusEvents[K]) => {
    handler(event)
    eventBus.off(type, wrappedHandler as any)
  }

  eventBus.on(type, wrappedHandler as any)
}

/**
 * 发送事件
 *
 * @param type 事件类型
 * @param data 事件数据
 */
export function emitEvent<K extends EventBusKey>(
  type: K,
  data: EventBusEvents[K]
): void {
  eventBus.emit(type, data)
}

/**
 * 清除所有监听器（谨慎使用）
 */
export function clearAllListeners(): void {
  eventBus.all.clear()
}

// ============================================================================
// VUE COMPOSABLE INTEGRATION
// ============================================================================

/**
 * Vue 3 composable: 在组件中自动清理事件监听
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useEventBus } from '@/utils/eventBus'
 *
 * const { on, emit } = useEventBus()
 *
 * on('run:message', (data) => {
 *   console.log('Run message:', data)
 * })
 * </script>
 * ```
 */
import { onUnmounted } from 'vue'

export interface UseEventBusReturn {
  on: <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => void
  once: <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => void
  emit: <K extends EventBusKey>(type: K, data: EventBusEvents[K]) => void
  off: <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => void
}

const activeHandlers = new Map<string, Function[]>()

export function useEventBus(): UseEventBusReturn {
  const on = <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => {
    eventBus.on(type, handler)

    if (!activeHandlers.has(type)) {
      activeHandlers.set(type, [])
    }
    activeHandlers.get(type)!.push(handler)

    // 组件卸载时自动清理
    onUnmounted(() => {
      eventBus.off(type, handler)
      const handlers = activeHandlers.get(type)
      if (handlers) {
        const index = handlers.indexOf(handler)
        if (index > -1) handlers.splice(index, 1)
      }
    })
  }

  const once = <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => {
    const wrappedHandler = (event: EventBusEvents[K]) => {
      handler(event)
      eventBus.off(type, wrappedHandler as any)
    }

    on(type, wrappedHandler as any)
  }

  const emit = <K extends EventBusKey>(
    type: K,
    data: EventBusEvents[K]
  ) => {
    eventBus.emit(type, data)
  }

  const off = <K extends EventBusKey>(
    type: K,
    handler: (event: EventBusEvents[K]) => void
  ) => {
    eventBus.off(type, handler)
    const handlers = activeHandlers.get(type)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index > -1) handlers.splice(index, 1)
    }
  }

  return { on, once, emit, off }
}

// ============================================================================
// DEBUGGING HELPERS
// ============================================================================

/**
 * 启用事件总线调试模式（仅在开发环境）
 */
export function enableEventBusDebug(): void {
  if (import.meta.env.DEV) {
    eventBus.on('*', (type, e) => {
      console.debug(`[EventBus] ${String(type)}:`, e)
    })
  }
}

/**
 * 获取当前所有活跃的监听器数量
 */
export function getActiveListenerCount(): number {
  let count = 0
  for (const handlers of activeHandlers.values()) {
    count += handlers.length
  }
  return count
}

// 默认导出
export default eventBus

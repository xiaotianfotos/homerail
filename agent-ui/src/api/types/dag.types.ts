/**
 * ============================================================================
 * DAG 相关 TypeScript 类型定义
 * ============================================================================
 *
 * 对应后端 dag_status/routes.py 和 graph_executor.py
 */

// ============================================================================
// DAG 节点状态
// ============================================================================

export type DAGNodeStatus = 'pending' | 'ready' | 'running' | 'waiting_for_command' | 'completed' | 'failed' | 'skipped'

export type DAGExecutionStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed'

// ============================================================================
// DAG 节点
// ============================================================================

export interface DAGTaskNode {
  id: string
  name: string
  status: DAGNodeStatus
  agent_id: string
  agent_name: string
  prompt?: string
  dependencies: string[]
  retry_count: number
  pool_count: number
  iteration: number
  image_name?: string
  container_id?: string
  started_at?: string
  completed_at?: string
  error_message?: string
  container_group?: string
  is_privileged?: boolean
  token_usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }
  context_limit?: number
  context_usage_pct?: number
  latest_todos?: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm?: string
  }>
}

export interface DAGManagerNode {
  id: string
  name: string
  status: DAGNodeStatus
  agent_name: string
}

export type DAGNode = DAGTaskNode | DAGManagerNode

// ============================================================================
// DAG 边
// ============================================================================

export type DAGEdgeCondition = 'always' | 'on_success' | 'on_failure'

export interface DAGEdge {
  id: string
  source: string
  target: string
  condition: DAGEdgeCondition
}

// ============================================================================
// DAG 执行状态（GET /dag-status/{id} 完整响应）
// ============================================================================

export interface DAGExecution {
  dag_run_id: string
  status: DAGExecutionStatus
  started_at?: string
  completed_at?: string
  nodes: DAGTaskNode[]
  edges: DAGEdge[]
}

export type DAGExperienceIngestJobStatus =
  | 'not_started'
  | 'pending'
  | 'running'
  | 'applied'
  | 'failed'
  | 'skipped'

export interface DAGExperienceIngestStatus {
  id?: string
  run_id: string
  status: DAGExperienceIngestJobStatus
  trigger_event?: string
  terminal_status?: string
  mode?: string
  summary_provider?: string
  summary_model?: string
  attempts?: number
  exit_code?: number
  error_message?: string
  output?: string
  created_at?: string
  updated_at?: string
  started_at?: string
  completed_at?: string
}

// ============================================================================
// DAG 聊天消息（后端格式）
// ============================================================================

export type DAGChatMessageType = 'text' | 'tool_use' | 'tool_result' | 'thinking'

export interface DAGChatMessage {
  role: 'user' | 'assistant' | 'system' | 'error'
  content: string
  type: DAGChatMessageType
  message_id?: string
  timestamp?: string
  worker_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_result?: unknown
  is_error?: boolean
  source?: 'session_store' | 'markdown'
}

// ============================================================================
// DAG 节点详情（GET /dag-status/{id}/node/{nid}）
// ============================================================================

export interface DAGNodeDetail {
  node_id: string
  node_name: string
  status: DAGNodeStatus
  agent_id: string
  agent_name: string
  container_id?: string
  started_at?: string
  completed_at?: string
  error_message?: string
}

// ============================================================================
// WebSocket DAG 事件数据
// ============================================================================

export interface DAGNodeStateChangedEvent {
  dag_run_id: string
  node_id: string
  node_name: string
  status: DAGNodeStatus
  timestamp: string
}

export interface DAGNodeMessageEvent {
  dag_run_id: string
  node_id: string
  message: DAGChatMessage
  timestamp: string
}

// ============================================================================
// DAG 事件日志
// ============================================================================

export type DAGEventType =
  | 'dispatched' | 'completed' | 'failed' | 'retried' | 'skipped'
  | 'backtrack' | 'handoff' | 'rejected' | 're_dispatched'
  // v2 引擎事件
  | 'handoff_v2' | 'send_message' | 'receive_message'
  | 'engine_started' | 'engine_completed' | 'node_dispatched'
  | 'gateway_executed'

export interface DAGEventEntry {
  timestamp: string
  event_type: DAGEventType
  node_id: string
  details?: Record<string, unknown>
}

// ============================================================================
// DAG 运行时指标（GET /dag-status/{id}/metrics）
// 用于 DAG Runtime 可视化覆盖层：每节点工具调用、失败、token 消耗。
// ============================================================================

export interface DAGNodeMetrics {
  node_id: string
  node_name: string
  agent_name: string
  status: DAGNodeStatus
  tool_calls: number
  tool_failures: number
  tokens: {
    input: number
    output: number
    cache_read: number
    cache_creation: number
  } | null
  usage_available: boolean
  duration_ms: number | null
  num_turns: number | null
  started_at: string | null
  completed_at: string | null
}

export interface DAGRunMetrics {
  run_id: string
  status: DAGExecutionStatus
  nodes: Record<string, DAGNodeMetrics>
  totals: {
    tool_calls: number
    tool_failures: number
    tokens: {
      input: number
      output: number
      cache_read: number
      cache_creation: number
    }
    usage_available: boolean
    cost_usd: number | null
  }
}

/**
 * ============================================================================
 * DAG Status API Service
 * ============================================================================
 *
 * 对应后端 dag_status/routes.py 的 REST 端点。
 * 后端返回分层结构（graph + execution），此处转换为前端扁平 DAGExecution 格式。
 */

import { http } from '../clients/http-client'
import type {
  DAGExecution,
  DAGExecutionStatus,
  DAGTaskNode,
  DAGEdge,
  DAGNodeDetail,
  DAGChatMessage,
  DAGEventEntry,
  DAGExperienceIngestStatus,
  DAGRunMetrics,
} from '../types/dag.types'

type BackendTokenUsage = Partial<NonNullable<DAGTaskNode['token_usage']>> & Record<string, number | undefined>

// ============================================================================
// 数据转换：后端格式 → 前端 DAGExecution
// ============================================================================

interface BackendDagResponse {
  instance_id: string
  graph: {
    nodes: Array<{
      node_id: string
      name: string
      node_type?: string
      agent?: string
      gateway_config?: Record<string, unknown>
    }>
    edges: Array<{ from_node: string; to_node: string; condition: string }>
  }
  execution: {
    status?: 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
    complete: boolean
    active_nodes: string[]
    completed_nodes: string[]
    failed_nodes: string[]
    ready_nodes: string[]
    waiting_nodes?: string[]
    node_count: number
    nodes: Record<string, {
      status: string
      retry_count: number
      started_at: string | null
      completed_at: string | null
      token_usage?: BackendTokenUsage
      context_limit?: number
      context_usage_pct?: number
      latest_todos?: Array<{
        content: string
        status: 'pending' | 'in_progress' | 'completed'
        activeForm?: string
      }>
    }>
  }
}

function transformDagResponse(raw: BackendDagResponse): DAGExecution {
  const graphNodes = raw.graph.nodes
  const graphEdges = raw.graph.edges
  const execNodes = raw.execution.nodes

  // 构建依赖关系映射：target → [source, ...]
  const depMap = new Map<string, string[]>()
  for (const edge of graphEdges) {
    const deps = depMap.get(edge.to_node) || []
    deps.push(edge.from_node)
    depMap.set(edge.to_node, deps)
  }

  // 合并 graph.nodes + execution.nodes → DAGTaskNode[]
  const nodes: DAGTaskNode[] = graphNodes.map(gn => {
    const execState = execNodes[gn.node_id]
    return {
      id: gn.node_id,
      name: gn.name,
      node_type: gn.node_type || 'agent',
      gateway_config: gn.gateway_config,
      status: (execState?.status || 'pending') as DAGTaskNode['status'],
      agent_id: gn.agent && gn.agent !== '__gateway__' ? gn.agent : '',
      agent_name: gn.agent && gn.agent !== '__gateway__' ? gn.agent : gn.name,
      dependencies: depMap.get(gn.node_id) || [],
      retry_count: execState?.retry_count || 0,
      pool_count: 0,
      iteration: 0,
      started_at: execState?.started_at || undefined,
      completed_at: execState?.completed_at || undefined,
      token_usage: normalizeTokenUsage(execState?.token_usage),
      context_limit: execState?.context_limit,
      context_usage_pct: execState?.context_usage_pct,
      latest_todos: execState?.latest_todos,
    }
  })

  // 转换边（过滤空 to_node 的终端边）
  const edges: DAGEdge[] = graphEdges
    .filter(ge => ge.from_node && ge.to_node)
    .map((ge, i) => ({
      id: `e-${i}`,
      source: ge.from_node,
      target: ge.to_node,
      condition: (ge.condition || 'always') as DAGEdge['condition'],
    }))

  // 推导整体状态
  let status: DAGExecutionStatus = 'pending'
  if (raw.execution.status === 'cancelled') {
    status = 'cancelled'
  } else if (raw.execution.status === 'failed') {
    status = 'failed'
  } else if (raw.execution.status === 'completed') {
    status = 'completed'
  } else if (raw.execution.status === 'waiting') {
    status = 'waiting'
  } else if (raw.execution.complete) {
    status = raw.execution.failed_nodes.length > 0 ? 'failed' : 'completed'
  } else if (raw.execution.active_nodes.length > 0) {
    status = 'running'
  } else if (raw.execution.ready_nodes.length > 0) {
    status = 'running'
  } else if (
    (raw.execution.waiting_nodes?.length ?? 0) > 0
    || Object.values(execNodes).some(node => node.status === 'waiting_for_command')
  ) {
    status = 'waiting'
  }

  return {
    dag_run_id: raw.instance_id,
    status,
    nodes,
    edges,
  }
}

function normalizeTokenUsage(tokenUsage?: BackendTokenUsage): DAGTaskNode['token_usage'] | undefined {
  if (!tokenUsage) return undefined
  return {
    input_tokens: tokenUsage.input_tokens ?? 0,
    output_tokens: tokenUsage.output_tokens ?? 0,
    cache_read_input_tokens: tokenUsage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: tokenUsage.cache_creation_input_tokens ?? 0,
  }
}

// ============================================================================
// API Functions
// ============================================================================

export async function getDagStatus(dagRunId: string): Promise<DAGExecution | null> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}`)
  // http client 已解包外层 { success, data } → res 就是 API body
  if (res.success === false || !res.data) {
    return null
  }
  const raw = res.data
  if (!raw?.graph?.nodes) return null
  return transformDagResponse(raw)
}

export async function getDagNodeDetail(
  dagRunId: string,
  nodeId: string
): Promise<DAGNodeDetail> {
  const res = await http.get<DAGNodeDetail>(`/api/dag-status/${dagRunId}/node/${nodeId}`)
  return res.data
}

// ============================================================================
// ChatEntry → DAGChatMessage 转换
// ============================================================================

/**
 * 后端 /node/:id/chat 返回的是原始 ChatEntry（{role, type, content, timestamp}），
 * 其中 content 是 worker stream 事件的原始 data（{event, text/tool_name/...}）。
 * 这里把它们转成 convertDagMessages 能消费的 DAGChatMessage 格式。
 * agent_debug / system / 调试类事件被过滤掉（不是聊天内容）。
 */
function transformChatEntries(entries: any[]): DAGChatMessage[] {
  const messages: DAGChatMessage[] = []
  for (const entry of entries) {
    const content = entry?.content
    if (!content || typeof content !== 'object') continue
    const event = content.event || content.type
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toISOString() : new Date().toISOString()

    // Worker sendContent() persists ordinary assistant output as a response
    // envelope without an event discriminator:
    // { role: "worker", type: "response", content: { text, run_id, node_id } }.
    // Keep the discriminator-based stream formats, but also accept that
    // production persistence contract without treating prompts/debug entries
    // as assistant messages.
    const isPersistedWorkerText = !event
      && entry?.type === 'response'
      && typeof content.text === 'string'
      && (
        entry?.role === 'worker'
        || entry?.role === 'node'
        || (typeof content.run_id === 'string' && typeof content.node_id === 'string')
      )

    if (event === 'text' || event === 'content' || isPersistedWorkerText) {
      // worker 的 sendContent 发 {type:"content", data:{text,...}} 或 stream {event:"text"...}
      const text = content.text ?? (typeof content.content === 'string' ? content.content : '')
      if (text) {
        messages.push({
          role: 'assistant',
          content: text,
          type: 'text',
          timestamp,
          worker_id: entry.targetId,
        })
      }
    } else if (event === 'thinking') {
      messages.push({
        role: 'assistant',
        content: content.summary || content.text || '',
        type: 'thinking',
        timestamp,
        worker_id: entry.targetId,
      })
    } else if (event === 'tool_use') {
      messages.push({
        role: 'assistant',
        content: '',
        type: 'tool_use',
        message_id: content.tool_id,
        timestamp,
        tool_name: (content.tool_name || '').replace(/^mcp__[^_]+__/, ''),
        tool_input: content.tool_input ?? {},
        worker_id: entry.targetId,
      })
    } else if (event === 'tool_result') {
      messages.push({
        role: 'assistant',
        content: '',
        type: 'tool_result',
        message_id: content.tool_use_id,
        timestamp,
        tool_name: 'tool_result',
        tool_result: content.result_preview ?? content.content,
        is_error: content.is_error === true,
        worker_id: entry.targetId,
      })
    }
    // agent_debug / usage / system / node_handoff / SESSION_END 等全部跳过
  }
  return messages
}

export async function getDagNodeChat(
  dagRunId: string,
  nodeId: string
): Promise<DAGChatMessage[]> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}/node/${nodeId}/chat`)
  const raw = res.data?.messages || []
  return transformChatEntries(raw)
}

export async function getDagManagerChat(
  dagRunId: string
): Promise<DAGChatMessage[]> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}/manager/chat`)
  return res.data?.messages || []
}

// ============================================================================
// Export API Object
// ============================================================================

export async function getDagEvents(dagRunId: string): Promise<DAGEventEntry[]> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}/events/history`)
  return res.data?.events || []
}

export async function getDagRunMetrics(dagRunId: string): Promise<DAGRunMetrics | null> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}/metrics`)
  if (res.success === false || !res.data) return null
  return res.data
}

export async function getDagExperienceIngestStatus(
  dagRunId: string
): Promise<DAGExperienceIngestStatus | null> {
  const res = await http.get<any>(`/api/dag-status/${dagRunId}/experience-ingest`)
  if (res.success === false || !res.data) return null
  return res.data
}

export async function retryDagExperienceIngest(
  dagRunId: string
): Promise<DAGExperienceIngestStatus | null> {
  const res = await http.post<any>(`/api/dag-status/${dagRunId}/experience-ingest/retry`)
  if (res.success === false || !res.data) return null
  return res.data
}

export const dagApi = {
  getDagStatus,
  getDagNodeDetail,
  getDagNodeChat,
  getDagManagerChat,
  getDagEvents,
  getDagRunMetrics,
  getDagExperienceIngestStatus,
  retryDagExperienceIngest,
}

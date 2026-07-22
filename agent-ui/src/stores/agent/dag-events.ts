import type { Ref } from 'vue'
import { watch } from 'vue'
import { eventBus, onEvent } from '@/utils/eventBus'
import { voiceWs } from '@/api/clients/events-ws'
import type { WebSocketMessage } from '@/api/clients/websocket-client'
import type { DAGEdge, DAGExecution, DAGNodeStatus, DAGTaskNode } from '@/api/types/dag.types'
import type { AgentChatMessage } from './types'

interface AgentDagEventBindings {
  currentRunId: Ref<string | null>
  dagExecution: Ref<DAGExecution | null>
  nodes: Ref<DAGTaskNode[]>
  edges: Ref<DAGEdge[]>
  selectedNodeId: Ref<string | null>
  chatMessages: Ref<AgentChatMessage[]>
  wsStreamedCount: Ref<number>
  persist: () => void
  setDagExecution: (execution: DAGExecution) => void
  selectNode: (nodeId: string | null) => void
}

export function bindAgentDagEvents(ctx: AgentDagEventBindings): () => void {
  let initialized = false

  function eventRunId(data: any): string | undefined {
    return data?.runId ?? data?.run_id ?? data?.dag_run_id
  }

  function eventNodeId(data: any): string | undefined {
    return data?.nodeId ?? data?.node_id
  }

  function isCurrentRun(data: any): boolean {
    return Boolean(ctx.currentRunId.value && eventRunId(data) === ctx.currentRunId.value)
  }

  function handleStatusUpdate(data: any): void {
    if (!isCurrentRun(data)) return
    if (data.status) {
      ctx.dagExecution.value = ctx.dagExecution.value
        ? { ...ctx.dagExecution.value, status: data.status }
        : null
    }
    if (data.nodes) {
      for (const update of data.nodes) {
        const node = ctx.nodes.value.find(n => n.id === update.id)
        if (node) node.status = update.status as DAGNodeStatus
      }
    }
  }

  function handleNodeStateChanged(data: any): void {
    if (!isCurrentRun(data)) return
    const node = ctx.nodes.value.find(n => n.id === eventNodeId(data))
    if (node) node.status = data.status as DAGNodeStatus
  }

  function handleNodeDispatched(data: any): void {
    if (!isCurrentRun(data)) return
    const node = ctx.nodes.value.find(n => n.id === eventNodeId(data))
    if (node) node.status = 'running'
  }

  function handleHandoff(data: any): void {
    if (!isCurrentRun(data)) return
    const node = ctx.nodes.value.find(n => n.id === (data.fromNode ?? data.from_node))
    if (node) node.status = 'completed'
  }

  function handleEngineStarted(data: any): void {
    if (!isCurrentRun(data)) return
    if (ctx.dagExecution.value) ctx.dagExecution.value.status = 'running'
  }

  function handleEngineCompleted(data: any): void {
    if (!isCurrentRun(data)) return
    if (ctx.dagExecution.value) ctx.dagExecution.value.status = 'completed'
    for (const node of ctx.nodes.value) {
      if (node.status === 'running') node.status = 'completed'
    }
  }

  function handleRunStatus(status: DAGExecution['status']) {
    return (data: any): void => {
      if (!isCurrentRun(data) || !ctx.dagExecution.value) return
      ctx.dagExecution.value.status = status
    }
  }

  async function refreshCurrentRun(): Promise<void> {
    const runId = ctx.currentRunId.value
    if (!runId) return
    try {
      const { getDagStatus } = await import('@/api/services/dag-api')
      const execution = await getDagStatus(runId)
      if (execution && ctx.currentRunId.value === runId) ctx.setDagExecution(execution)
    } catch {
      // Live events continue to apply if a reconnect snapshot is unavailable.
    }
  }

  function forwardManagerEvent(message: WebSocketMessage): void {
    const payload = message.payload ?? message.data
    if (payload === undefined) return
    eventBus.emit(message.type, payload)
  }

  function handleManagerChatEvent(data: any): void {
    const chatEventType = data?.chat_event_type
    const eventData = data?.data
    if (!chatEventType || !eventData) return

    if (chatEventType === 'assistant_text') {
      appendAssistantText(eventData.content || '')
    } else if (chatEventType === 'thinking') {
      appendThinking(eventData.summary || '')
    } else if (chatEventType === 'tool_call') {
      appendToolCall(eventData)
    } else if (chatEventType === 'tool_result') {
      appendToolResult(eventData)
    } else if (chatEventType === 'done' && eventData.run_id) {
      appendRunStarted(eventData.run_id)
    } else if (chatEventType === 'done') {
      ctx.persist()
    }
  }

  function appendAssistantText(content: string): void {
    ctx.wsStreamedCount.value++
    const lastMsg = ctx.chatMessages.value[ctx.chatMessages.value.length - 1]
    for (const msg of ctx.chatMessages.value) {
      if (msg.type === 'thinking' && msg.status === 'pending') msg.status = 'completed'
    }
    if (lastMsg?.role === 'assistant' && lastMsg?.type === 'text' && !lastMsg.toolName) {
      lastMsg.content += content
    } else {
      ctx.chatMessages.value.push({
        id: `stream-text-${Date.now()}`,
        role: 'assistant',
        content,
        type: 'text',
        timestamp: new Date().toISOString(),
      })
    }
    ctx.persist()
  }

  function appendToolCall(eventData: any): void {
    ctx.wsStreamedCount.value++
    for (const msg of ctx.chatMessages.value) {
      if (msg.type === 'thinking' && msg.status === 'pending') msg.status = 'completed'
    }
    const toolName = (eventData.name || '').replace(/^mcp__[^_]+__/, '')
    ctx.chatMessages.value.push({
      id: `stream-tool-${eventData.tool_id || Date.now()}`,
      role: 'assistant',
      content: JSON.stringify(eventData.input, null, 2),
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      toolId: eventData.tool_id,
      toolName,
      toolSummary: Object.keys(eventData.input || {}).slice(0, 4).join(', '),
      status: 'pending',
    })
  }

  function appendToolResult(eventData: any): void {
    ctx.wsStreamedCount.value++
    for (const msg of ctx.chatMessages.value) {
      if (msg.type === 'thinking' && msg.status === 'pending') msg.status = 'completed'
    }
    const toolId = eventData.tool_id
    const message = ctx.chatMessages.value
      .slice()
      .reverse()
      .find(msg => msg.type === 'tool_call' && msg.toolId === toolId)
    const result = String(eventData.content || '')
    if (message) {
      message.status = eventData.is_error ? 'failed' : 'completed'
      message.toolResult = result
    } else {
      ctx.chatMessages.value.push({
        id: `stream-tool-result-${toolId || Date.now()}`,
        role: 'assistant',
        content: result,
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        toolId,
        toolName: 'tool_result',
        status: eventData.is_error ? 'failed' : 'completed',
      })
    }
    ctx.persist()
  }

  function appendThinking(summary: string): void {
    if (!summary) return
    const lastMsg = ctx.chatMessages.value[ctx.chatMessages.value.length - 1]
    if (lastMsg?.role === 'assistant' && lastMsg?.type === 'thinking') {
      lastMsg.content = summary
      lastMsg.status = 'pending'
      ctx.persist()
      return
    }
    ctx.wsStreamedCount.value++
    ctx.chatMessages.value.push({
      id: `stream-thinking-${Date.now()}`,
      role: 'assistant',
      content: summary,
      type: 'thinking',
      timestamp: new Date().toISOString(),
      status: 'pending',
    })
  }

  function appendRunStarted(runId: string): void {
    ctx.chatMessages.value.push({
      id: `sys-run-${Date.now()}`,
      role: 'system',
      content: `DAG 已启动: run_id=${runId}`,
      type: 'status',
      timestamp: new Date().toISOString(),
    })
    ctx.currentRunId.value = runId
    ctx.persist()
    import('@/api/services/dag-api').then(({ getDagStatus }) => {
      getDagStatus(runId).then(dag => {
        if (dag) ctx.setDagExecution(dag)
      }).catch(() => {})
    })
  }

  function initialize(): void {
    if (initialized) return
    initialized = true
    onEvent('dag:status_update', handleStatusUpdate)
    onEvent('dag:node_state_changed', handleNodeStateChanged)
    onEvent('dag:node_dispatched', handleNodeDispatched)
    onEvent('dag:handoff', handleHandoff)
    onEvent('dag:engine_started', handleEngineStarted)
    onEvent('dag:engine_completed', handleEngineCompleted)
    onEvent('dag:run_completed', handleRunStatus('completed'))
    onEvent('dag:run_failed', handleRunStatus('failed'))
    onEvent('dag:run_cancelled', handleRunStatus('failed'))
    onEvent('dag:run_waiting', handleRunStatus('waiting'))
    onEvent('dag:run_resumed', handleRunStatus('running'))
    onEvent('manager:chat_event', handleManagerChatEvent)
    voiceWs.on('*', forwardManagerEvent)
    voiceWs.onStateChange((state) => {
      if (state === 'connected') void refreshCurrentRun()
    })
    voiceWs.connect()
  }

  watch(
    () => ctx.nodes.value.map(n => ({ id: n.id, status: n.status })),
    (newNodes) => {
      const runningNode = newNodes.find(n => n.status === 'running')
      if (runningNode && !ctx.selectedNodeId.value) {
        ctx.selectNode(runningNode.id)
      }
    },
  )

  return initialize
}

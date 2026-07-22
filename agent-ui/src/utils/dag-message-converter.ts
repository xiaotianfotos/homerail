import type { ClaudeMessage, ClaudeToolCall } from '@/api/types/run.types'
import type { DAGChatMessage } from '@/api/types/dag.types'

export function convertDagMessages(dagMessages: DAGChatMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = []
  const pendingToolCallsById = new Map<string, { msg: ClaudeMessage; name: string }>()
  const pendingToolCallsByName = new Map<string, Array<{ msg: ClaudeMessage; id: string }>>()

  function enqueueToolCall(name: string, msg: ClaudeMessage, id: string): void {
    const queue = pendingToolCallsByName.get(name) ?? []
    queue.push({ msg, id })
    pendingToolCallsByName.set(name, queue)
  }

  function removeQueuedToolCall(name: string, id: string): void {
    const queue = pendingToolCallsByName.get(name)
    if (!queue) return
    const index = queue.findIndex(pending => pending.id === id)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) pendingToolCallsByName.delete(name)
  }

  for (let i = 0; i < dagMessages.length; i++) {
    const dag = dagMessages[i]
    const id = dag.message_id || `dag-msg-${i}`
    const timestamp = dag.timestamp || new Date().toISOString()

    switch (dag.type) {
      case 'text': {
        result.push({
          id,
          type: dag.role === 'user' ? 'user_message' : 'assistant_message',
          timestamp,
          content: dag.content,
        })
        break
      }
      case 'thinking': {
        result.push({
          id,
          type: 'thinking',
          timestamp,
          content: dag.content || '',
        })
        break
      }
      case 'tool_use': {
        let toolInput = dag.tool_input
        if (!toolInput || Object.keys(toolInput).length === 0) {
          try {
            const parsed = typeof dag.content === 'string' ? JSON.parse(dag.content) : dag.content
            if (parsed?.input && typeof parsed.input === 'object') {
              toolInput = parsed.input as Record<string, unknown>
            }
          } catch {
            // Non-JSON tool content is expected for some worker messages.
          }
        }
        const toolId = dag.message_id || `dag-tool-${i}`
        const toolName = dag.tool_name || 'unknown'
        const toolCall: ClaudeToolCall = {
          id: toolId,
          name: toolName,
          input: toolInput || {},
        }
        const msg: ClaudeMessage = {
          id,
          type: 'tool_call',
          timestamp,
          content: '',
          tool_calls: [toolCall],
          status: 'pending',
        }
        result.push(msg)
        pendingToolCallsById.set(toolId, { msg, name: toolName })
        enqueueToolCall(toolName, msg, toolId)
        break
      }
      case 'tool_result': {
        const toolName = dag.tool_name || 'unknown'
        const isError = dag.is_error || (dag.role as string) === 'error'
        const matchById = dag.message_id ? pendingToolCallsById.get(dag.message_id) : undefined
        const matchByName = pendingToolCallsByName.get(toolName)?.[0]
        const match = matchById ?? (matchByName
          ? { msg: matchByName.msg, name: toolName }
          : undefined)
        if (match) {
          const tool = match.msg.tool_calls?.[0]
          if (tool) {
            tool.result = dag.tool_result != null
              ? (typeof dag.tool_result === 'string'
                ? { text: dag.tool_result }
                : (dag.tool_result as Record<string, unknown>))
              : undefined
            tool.status = isError ? 'failed' : 'success'
            match.msg.status = tool.status
          }
          const matchedId = match.msg.tool_calls?.[0]?.id
          if (matchedId) {
            pendingToolCallsById.delete(matchedId)
            removeQueuedToolCall(match.name, matchedId)
          }
        } else {
          result.push({
            id,
            type: 'tool_result',
            timestamp,
            content: typeof dag.tool_result === 'string'
              ? dag.tool_result
              : JSON.stringify(dag.tool_result),
            status: isError ? 'failed' : 'success',
          })
        }
        break
      }
      default: {
        result.push({
          id,
          type: 'assistant_message',
          timestamp,
          content: dag.content || '',
        })
      }
    }
  }

  return result
}

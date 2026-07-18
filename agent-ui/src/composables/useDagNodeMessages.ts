/**
 * ============================================================================
 * useDagNodeMessages — DAG 节点消息获取 + 实时更新
 * ============================================================================
 *
 * 选中节点时自动获取聊天记录，监听 EventBus 实时追加。
 * 使用 dev 的 MessageList 组件渲染（ClaudeMessage 格式）。
 */

import { ref, watch, computed, onUnmounted, type ComputedRef } from 'vue'
import { dagApi } from '@/api/services/dag-api'
import { convertDagMessages } from '@/utils/dag-message-converter'
import { eventBus } from '@/utils/eventBus'
import { formatRepositoryPayloadForDisplay } from '@/components/agent/dag-runtime/dagRuntimePresentation'
import type { ClaudeMessage } from '@/api/types/run.types'
import type { DAGChatMessage } from '@/api/types/dag.types'
import type { DAGNodeMessageEvent } from '@/utils/eventBus'

export function useDagNodeMessages(
  dagRunId: ComputedRef<string | undefined>,
  selectedNodeId: ComputedRef<string | null>,
  isSelectedManager: ComputedRef<boolean>
) {
  const messages = ref<ClaudeMessage[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const nodeName = ref('')

  // ==========================================================================
  // 获取聊天记录
  // ==========================================================================

  async function fetchChat(runId: string, nodeId: string, isManager: boolean) {
    loading.value = true
    error.value = null
    messages.value = []

    try {
      const chatMsgs: DAGChatMessage[] = isManager
        ? await dagApi.getDagManagerChat(runId)
        : await dagApi.getDagNodeChat(runId, nodeId)

      messages.value = formatRepositoryPayloadForDisplay(convertDagMessages(chatMsgs))
    } catch (e: any) {
      error.value = e?.message || 'Failed to load chat'
      messages.value = []
    } finally {
      loading.value = false
    }
  }

  // ==========================================================================
  // Watch 选中节点
  // ==========================================================================

  watch(
    [selectedNodeId, dagRunId],
    ([nodeId, runId]) => {
      if (!nodeId || !runId) {
        messages.value = []
        nodeName.value = ''
        return
      }
      fetchChat(runId, nodeId, isSelectedManager.value)
    },
    { immediate: true }
  )

  // ==========================================================================
  // EventBus 实时消息
  // ==========================================================================

  function onNodeMessage(event: DAGNodeMessageEvent) {
    const runId = dagRunId.value
    const nodeId = selectedNodeId.value
    if (!runId || !nodeId) return
    if (event.dag_run_id !== runId || event.node_id !== nodeId) return

    const converted = formatRepositoryPayloadForDisplay(convertDagMessages([event.message]))
    if (converted.length > 0) {
      messages.value = [...messages.value, ...converted]
    }
  }

  eventBus.on('dag:node_message', onNodeMessage)

  onUnmounted(() => {
    eventBus.off('dag:node_message', onNodeMessage)
  })

  return {
    messages: computed(() => messages.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    nodeName: computed(() => nodeName.value),
  }
}

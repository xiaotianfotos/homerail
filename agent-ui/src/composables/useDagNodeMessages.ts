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
import type { DAGNodeChatUpdatedEvent, DAGNodeMessageEvent } from '@/utils/eventBus'

export function useDagNodeMessages(
  dagRunId: ComputedRef<string | undefined>,
  selectedNodeId: ComputedRef<string | null>,
  isSelectedManager: ComputedRef<boolean>
) {
  const messages = ref<ClaudeMessage[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const nodeName = ref('')
  const REFRESH_INTERVAL_MS = 300
  let refreshTimer: number | undefined
  let refreshInFlight = false
  let refreshPending = false
  let lastRefreshStartedAt = Number.NEGATIVE_INFINITY
  let requestGeneration = 0
  let disposed = false

  // ==========================================================================
  // 获取聊天记录
  // ==========================================================================

  async function fetchChat(runId: string, nodeId: string, isManager: boolean, background = false) {
    const generation = ++requestGeneration
    if (!background) loading.value = true
    error.value = null
    if (!background) messages.value = []

    try {
      const chatMsgs: DAGChatMessage[] = isManager
        ? await dagApi.getDagManagerChat(runId)
        : await dagApi.getDagNodeChat(runId, nodeId)

      if (generation !== requestGeneration) return
      messages.value = formatRepositoryPayloadForDisplay(convertDagMessages(chatMsgs))
    } catch (e: any) {
      if (generation !== requestGeneration) return
      error.value = e?.message || 'Failed to load chat'
      if (!background) messages.value = []
    } finally {
      if (generation === requestGeneration && !background) loading.value = false
    }
  }

  function runScheduledRefresh() {
    refreshTimer = undefined
    if (disposed || refreshInFlight) return

    const runId = dagRunId.value
    const nodeId = selectedNodeId.value
    if (!runId || !nodeId) {
      refreshPending = false
      return
    }

    refreshPending = false
    refreshInFlight = true
    lastRefreshStartedAt = Date.now()
    void fetchChat(runId, nodeId, isSelectedManager.value, true).finally(() => {
      refreshInFlight = false
      if (refreshPending && !disposed) scheduleRefresh()
    })
  }

  function scheduleRefresh() {
    if (disposed) return
    refreshPending = true
    if (refreshTimer !== undefined || refreshInFlight) return

    const elapsed = Date.now() - lastRefreshStartedAt
    const delay = Math.max(0, REFRESH_INTERVAL_MS - elapsed)
    refreshTimer = window.setTimeout(runScheduledRefresh, delay)
  }

  // ==========================================================================
  // Watch 选中节点
  // ==========================================================================

  watch(
    [selectedNodeId, dagRunId],
    ([nodeId, runId]) => {
      refreshPending = false
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
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

  function onNodeChatUpdated(event: DAGNodeChatUpdatedEvent) {
    const runId = dagRunId.value
    const nodeId = selectedNodeId.value
    if (!runId || !nodeId || event.runId !== runId) return
    if (!isSelectedManager.value && event.nodeId !== nodeId) return
    scheduleRefresh()
  }

  eventBus.on('dag:node_message', onNodeMessage)
  eventBus.on('dag:node_chat_updated', onNodeChatUpdated)

  onUnmounted(() => {
    disposed = true
    eventBus.off('dag:node_message', onNodeMessage)
    eventBus.off('dag:node_chat_updated', onNodeChatUpdated)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  })

  return {
    messages: computed(() => messages.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    nodeName: computed(() => nodeName.value),
  }
}

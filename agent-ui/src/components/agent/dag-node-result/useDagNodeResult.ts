/**
 * ============================================================================
 * useDagNodeResult — DAG 节点结构化结果获取 + 实时刷新
 * ============================================================================
 *
 * 数据源：GET /api/dag-status/:runId/node/:nodeId/result（PR1）。
 * 非 worker 节点（command/join/condition 等网关）的结果 = 其 handoff 内容，
 * 每种 result_kind 都有默认渲染器，不需要生成式 UI。
 *
 * 实时性：订阅 EventBus 的 dag:gateway_executed / dag:handoff / dag:node_state_changed，
 * 命中当前节点时节流刷新。
 */

import { ref, computed, watch, onUnmounted, type ComputedRef, type Ref } from 'vue'
import { dagApi } from '@/api/services/dag-api'
import { eventBus } from '@/utils/eventBus'
import type { DAGNodeResult } from '@/api/types/dag.types'

const REFRESH_INTERVAL_MS = 300

export function useDagNodeResult(
  dagRunId: ComputedRef<string | undefined>,
  selectedNodeId: Ref<string | null>,
) {
  const result = ref<DAGNodeResult | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let refreshTimer: number | undefined
  let refreshInFlight = false
  let refreshPending = false
  let lastRefreshStartedAt = Number.NEGATIVE_INFINITY
  let requestGeneration = 0
  let foregroundGeneration = 0
  let disposed = false

  async function fetchResult(runId: string, nodeId: string, background = false): Promise<void> {
    const generation = ++requestGeneration
    if (!background) {
      foregroundGeneration = generation
      loading.value = true
      result.value = null
    }
    error.value = null
    try {
      const data = await dagApi.getDagNodeResult(runId, nodeId)
      if (generation !== requestGeneration) return
      result.value = data
    } catch (e: any) {
      if (generation !== requestGeneration) return
      error.value = e?.message || 'Failed to load node result'
      if (!background) result.value = null
    } finally {
      // 事件驱动的后台刷新会顶掉 requestGeneration；loading 只跟随
      // 最近一次前台请求，避免被后台请求覆盖后一直停在 true
      if (!background && generation === foregroundGeneration) loading.value = false
    }
  }

  function runScheduledRefresh(): void {
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
    void fetchResult(runId, nodeId, true).finally(() => {
      refreshInFlight = false
      if (refreshPending && !disposed) scheduleRefresh()
    })
  }

  function scheduleRefresh(): void {
    if (disposed) return
    refreshPending = true
    if (refreshTimer !== undefined || refreshInFlight) return
    const elapsed = Date.now() - lastRefreshStartedAt
    const delay = Math.max(0, REFRESH_INTERVAL_MS - elapsed)
    refreshTimer = window.setTimeout(runScheduledRefresh, delay)
  }

  watch(
    [selectedNodeId, dagRunId],
    ([nodeId, runId]) => {
      refreshPending = false
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
      if (!nodeId || !runId) {
        // 作废在途请求，防止其完成后把过期结果写回已清空的选中项
        requestGeneration += 1
        foregroundGeneration = requestGeneration
        loading.value = false
        result.value = null
        return
      }
      void fetchResult(runId, nodeId)
    },
    { immediate: true },
  )

  function matchesCurrent(eventNodeId: unknown): boolean {
    return typeof eventNodeId === 'string' && eventNodeId === selectedNodeId.value
  }

  function onGatewayExecuted(event: any): void {
    if (!dagRunId.value || event?.runId !== dagRunId.value) return
    if (matchesCurrent(event?.nodeId)) scheduleRefresh()
  }

  function onHandoff(event: any): void {
    const runId = dagRunId.value
    if (!runId || (event?.runId !== runId && event?.dag_run_id !== runId)) return
    const fromNode = event?.fromNode ?? event?.from_node
    if (matchesCurrent(fromNode)) scheduleRefresh()
  }

  function onNodeStateChanged(event: any): void {
    const runId = dagRunId.value
    if (!runId || (event?.runId !== runId && event?.run_id !== runId && event?.dag_run_id !== runId)) return
    const nodeId = event?.nodeId ?? event?.node_id
    if (matchesCurrent(nodeId)) scheduleRefresh()
  }

  eventBus.on('dag:gateway_executed', onGatewayExecuted)
  eventBus.on('dag:handoff', onHandoff)
  eventBus.on('dag:node_state_changed', onNodeStateChanged)

  onUnmounted(() => {
    disposed = true
    eventBus.off('dag:gateway_executed', onGatewayExecuted)
    eventBus.off('dag:handoff', onHandoff)
    eventBus.off('dag:node_state_changed', onNodeStateChanged)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  })

  return {
    result: computed(() => result.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
  }
}

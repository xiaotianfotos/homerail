/**
 * useDagExplorerSnapshot — dag_explorer widget 的 DAG 快照数据源。
 *
 * 拉取 GET /api/dag-status/:runId 的节点/边/状态，并订阅 EventBus 的
 * dag:node_state_changed / dag:gateway_executed / dag:handoff，命中当前
 * run 时节流刷新，避免轮询闪烁。指标维度仍由 useDagRuntime 负责。
 */

import { ref, computed, watch, onUnmounted, type ComputedRef } from 'vue'
import { dagApi } from '@/api/services/dag-api'
import { eventBus } from '@/utils/eventBus'
import type { DAGExecution } from '@/api/types/dag.types'

const REFRESH_INTERVAL_MS = 300

export function useDagExplorerSnapshot(dagRunId: ComputedRef<string | undefined>) {
  const execution = ref<DAGExecution | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let refreshTimer: number | undefined
  let refreshInFlight = false
  let refreshPending = false
  let lastRefreshStartedAt = Number.NEGATIVE_INFINITY
  let requestGeneration = 0
  let foregroundGeneration = 0
  let disposed = false

  async function fetchSnapshot(runId: string, background = false): Promise<void> {
    const generation = ++requestGeneration
    if (!background) {
      foregroundGeneration = generation
      loading.value = true
    }
    error.value = null
    try {
      const data = await dagApi.getDagStatus(runId)
      if (generation !== requestGeneration) return
      execution.value = data
    } catch (e: any) {
      if (generation !== requestGeneration) return
      error.value = e?.message || 'Failed to load DAG run'
      if (!background) execution.value = null
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
    if (!runId) {
      refreshPending = false
      return
    }
    refreshPending = false
    refreshInFlight = true
    lastRefreshStartedAt = Date.now()
    void fetchSnapshot(runId, true).finally(() => {
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

  watch(dagRunId, (runId) => {
    refreshPending = false
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
    if (!runId) {
      // 作废在途请求，防止其完成后把过期数据写回已清空的快照
      requestGeneration += 1
      foregroundGeneration = requestGeneration
      loading.value = false
      execution.value = null
      return
    }
    void fetchSnapshot(runId)
  }, { immediate: true })

  function matchesRun(event: any): boolean {
    const runId = dagRunId.value
    if (!runId) return false
    return event?.runId === runId || event?.run_id === runId || event?.dag_run_id === runId
  }

  function onDagEvent(event: any): void {
    if (matchesRun(event)) scheduleRefresh()
  }

  eventBus.on('dag:node_state_changed', onDagEvent)
  eventBus.on('dag:gateway_executed', onDagEvent)
  eventBus.on('dag:handoff', onDagEvent)

  onUnmounted(() => {
    disposed = true
    eventBus.off('dag:node_state_changed', onDagEvent)
    eventBus.off('dag:gateway_executed', onDagEvent)
    eventBus.off('dag:handoff', onDagEvent)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  })

  return {
    execution: computed(() => execution.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
  }
}

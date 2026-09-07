<script setup lang="ts">
/**
 * DagExplorerWidget — Voice Cockpit 的 2x2 DAG 面板（widget type: dag_explorer）。
 *
 * 布局：左列（占 1x2）为按拓扑序竖向排列的节点列表，右列为选中节点的详情。
 * - worker 节点只展示关键指标：工具调用/失败、耗时、token 用量、模型，不显示聊天日志；
 * - 非 worker 节点（command/join/condition 等 Manager 逻辑节点）展示 DagNodeResultView
 *   的结构化结果，无需生成式 UI。
 *
 * widget.data 契约：{ run_id: string, focus_node_id?: string }。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Clock, Maximize2, Wrench } from 'lucide-vue-next'
import type { VoiceWidget } from '@/api/services/voice-agent-api'
import type { DAGNodeStatus, DAGTaskNode } from '@/api/types/dag.types'
import { useAgentStore } from '@/stores/agent-store'
import { fmtTokens } from '@/lib/agentPersonas'
import DagNodeResultView from '@/components/agent/dag-node-result/DagNodeResultView.vue'
import { useDagNodeResult } from '@/components/agent/dag-node-result/useDagNodeResult'
import { useDagRuntime } from '@/components/agent/dag-runtime/useDagRuntime'
import { buildDagTraversalOrder } from '@/components/agent/dag-runtime/dagTraversal'
import { resolveDagRuntimeNodeSemantic } from '@/components/agent/dag-runtime/dagRuntimeNodeSemantics'
import { useDagExplorerSnapshot } from './useDagExplorerSnapshot'

const props = defineProps<{
  widget: VoiceWidget
}>()

const { t } = useI18n()
const store = useAgentStore()

const runId = computed(() => {
  const data = props.widget.data ?? {}
  const raw = data.run_id ?? data.runId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
})
const focusNodeId = computed(() => {
  const raw = props.widget.data?.focus_node_id
  return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
})

const metricsRunId = computed(() => runId.value ?? null)
const { execution, loading, error } = useDagExplorerSnapshot(runId)
const { metrics } = useDagRuntime(metricsRunId)

const orderedNodes = computed<DAGTaskNode[]>(() => {
  const nodes = execution.value?.nodes ?? []
  if (!nodes.length) return []
  const order = buildDagTraversalOrder(nodes, execution.value?.edges ?? [])
  const byId = new Map(nodes.map(node => [node.id, node]))
  return order.map(id => byId.get(id)).filter((node): node is DAGTaskNode => Boolean(node))
})

const selectedNodeId = ref<string | null>(null)

function pickDefaultNodeId(): string | null {
  const nodes = orderedNodes.value
  if (!nodes.length) return null
  if (focusNodeId.value && nodes.some(node => node.id === focusNodeId.value)) {
    return focusNodeId.value
  }
  return (
    nodes.find(node => node.status === 'failed')
    ?? nodes.find(node => node.status === 'running' || node.status === 'waiting_for_command')
    ?? nodes[0]
  ).id
}

// 快照刷新（事件驱动，运行中约每 300ms 一次）只在选中项失效
// （节点从图中消失）时补选默认；用户手动浏览期间不被覆盖
watch(
  orderedNodes,
  () => {
    if (selectedNodeId.value && orderedNodes.value.some(node => node.id === selectedNodeId.value)) return
    selectedNodeId.value = pickDefaultNodeId()
  },
  { immediate: true },
)

// 只有 focus_node_id 本身变化（manager agent 更新 widget 聚焦出错节点）才重新聚焦
watch(focusNodeId, (focus) => {
  if (focus && orderedNodes.value.some(node => node.id === focus)) {
    selectedNodeId.value = focus
  }
})

const selectedNode = computed(() =>
  orderedNodes.value.find(node => node.id === selectedNodeId.value) ?? null,
)
const selectedSemantic = computed(() => resolveDagRuntimeNodeSemantic(
  selectedNode.value?.node_type,
  selectedNode.value?.gateway_config,
))
const selectedMetrics = computed(() =>
  (selectedNodeId.value && metrics.value?.nodes[selectedNodeId.value]) || null,
)
const selectedExecution = computed(() => selectedMetrics.value?.execution ?? null)

const { result: nodeResult, loading: resultLoading } = useDagNodeResult(runId, selectedNodeId)

function semanticOf(node: DAGTaskNode) {
  return resolveDagRuntimeNodeSemantic(node.node_type, node.gateway_config)
}

function nodeMetricsOf(nodeId: string) {
  return metrics.value?.nodes[nodeId] ?? null
}

function statusLabel(status: DAGNodeStatus): string {
  const map: Record<string, string> = {
    pending: t('dag.status.pending'),
    ready: t('dag.status.ready'),
    running: t('dag.status.running'),
    waiting_for_command: t('dag.status.waitingForCommand'),
    completed: t('dag.status.completed'),
    failed: t('dag.status.failed'),
    cancelled: t('dag.status.cancelled'),
    skipped: t('dag.status.skipped'),
  }
  return map[status] ?? status
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
}

function selectNode(nodeId: string): void {
  selectedNodeId.value = nodeId
}

function openRuntimeOverlay(): void {
  store.runtimeOverlayOpen = true
}
</script>

<template>
  <div class="dag-explorer" data-testid="dag-explorer">
    <div v-if="!runId" class="dag-explorer__empty">{{ t('dag.explorer.noRun') }}</div>
    <div v-else-if="loading && !execution" class="dag-explorer__empty">{{ t('dag.explorer.loading') }}</div>
    <div v-else-if="!execution" class="dag-explorer__empty" data-testid="dag-explorer-error">
      {{ error || t('dag.explorer.runNotFound') }}
    </div>

    <div v-else class="dag-explorer__body">
      <aside class="dag-explorer__list">
        <div class="dag-explorer__list-head">
          <span>{{ t('dag.explorer.nodes') }}</span>
          <span class="dag-explorer__list-count">{{ orderedNodes.length }}</span>
        </div>
        <div class="dag-explorer__list-scroll">
          <button
            v-for="node in orderedNodes"
            :key="node.id"
            type="button"
            class="dag-explorer__node"
            :class="{ 'dag-explorer__node--active': node.id === selectedNodeId }"
            :data-status="node.status"
            :data-testid="`dag-explorer-node-${node.id}`"
            @click="selectNode(node.id)"
          >
            <span class="dag-explorer__node-dot" />
            <span class="dag-explorer__node-main">
              <span class="dag-explorer__node-name">{{ node.name || node.id }}</span>
              <span
                v-if="semanticOf(node).isWorker && nodeMetricsOf(node.id)"
                class="dag-explorer__node-mini"
              >
                <Wrench class="dag-explorer__node-mini-icon" />
                {{ nodeMetricsOf(node.id)?.tool_calls ?? 0 }}
                <template v-if="nodeMetricsOf(node.id)?.tokens">
                  · {{ fmtTokens(nodeMetricsOf(node.id)!.tokens!.total) }}
                </template>
              </span>
            </span>
            <span
              class="dag-explorer__node-kind"
              :class="{ 'dag-explorer__node-kind--worker': semanticOf(node).isWorker }"
            >{{ semanticOf(node).label }}</span>
          </button>
        </div>
      </aside>

      <section class="dag-explorer__detail" data-testid="dag-explorer-detail">
        <header class="dag-explorer__detail-head">
          <div class="dag-explorer__detail-title">
            <strong>{{ selectedNode?.name || selectedNode?.id || '—' }}</strong>
            <span v-if="selectedNode" class="dag-explorer__detail-kind">
              {{ selectedSemantic.isWorker ? t('dag.nodeTypes.worker') : selectedSemantic.label }}
            </span>
          </div>
          <div class="dag-explorer__detail-actions">
            <span
              v-if="selectedNode"
              class="dag-explorer__status"
              :data-status="selectedNode.status"
            >{{ statusLabel(selectedNode.status) }}</span>
            <button
              type="button"
              class="dag-explorer__expand"
              data-testid="dag-explorer-expand"
              :title="t('dag.explorer.expand')"
              @click="openRuntimeOverlay"
            >
              <Maximize2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div v-if="!selectedNode" class="dag-explorer__empty">{{ t('dag.explorer.noSelection') }}</div>

        <div v-else-if="selectedSemantic.isWorker" class="dag-explorer__worker" data-testid="dag-explorer-worker">
          <div class="dag-explorer__metric-strip">
            <span class="dag-explorer__metric">
              <Wrench class="h-3.5 w-3.5" />
              <strong>{{ selectedMetrics?.tool_calls ?? 0 }}</strong>
              <em>{{ t('dag.explorer.toolCalls') }}</em>
            </span>
            <span
              v-if="(selectedMetrics?.tool_failures ?? 0) > 0"
              class="dag-explorer__metric dag-explorer__metric--danger"
            >
              <AlertTriangle class="h-3.5 w-3.5" />
              <strong>{{ selectedMetrics?.tool_failures }}</strong>
              <em>{{ t('dag.explorer.toolFailures') }}</em>
            </span>
            <span class="dag-explorer__metric">
              <Clock class="h-3.5 w-3.5" />
              <strong>{{ fmtDuration(selectedMetrics?.duration_ms ?? null) }}</strong>
            </span>
          </div>

          <div class="dag-explorer__tokens">
            <div class="dag-explorer__token">
              <span>{{ t('dag.detail.inputTokens') }}</span>
              <strong>{{ selectedMetrics?.tokens ? fmtTokens(selectedMetrics.tokens.input) : t('dag.detail.unknown') }}</strong>
            </div>
            <div class="dag-explorer__token">
              <span>{{ t('dag.detail.outputTokens') }}</span>
              <strong>{{ selectedMetrics?.tokens ? fmtTokens(selectedMetrics.tokens.output) : t('dag.detail.unknown') }}</strong>
            </div>
            <div class="dag-explorer__token">
              <span>{{ t('dag.detail.cacheReadTokens') }}</span>
              <strong>{{ selectedMetrics?.tokens ? fmtTokens(selectedMetrics.tokens.cache_read) : t('dag.detail.unknown') }}</strong>
            </div>
            <div class="dag-explorer__token">
              <span>{{ t('dag.detail.cacheCreationTokens') }}</span>
              <strong>{{ selectedMetrics?.tokens ? fmtTokens(selectedMetrics.tokens.cache_creation) : t('dag.detail.unknown') }}</strong>
            </div>
            <div class="dag-explorer__token dag-explorer__token--total" :title="t('dag.detail.totalTokensHint')">
              <span>{{ t('dag.detail.totalTokens') }}</span>
              <strong data-testid="dag-explorer-total-tokens">{{ selectedMetrics?.tokens ? fmtTokens(selectedMetrics.tokens.total) : t('dag.detail.unknown') }}</strong>
            </div>
          </div>

          <div class="dag-explorer__exec">
            <div>
              <span>{{ t('dag.detail.model') }}</span>
              <strong>{{ selectedExecution?.model_display_name || selectedExecution?.model_name || t('dag.detail.unknown') }}</strong>
            </div>
            <div>
              <span>{{ t('dag.detail.provider') }}</span>
              <strong>{{ selectedExecution?.provider_display_name || selectedExecution?.provider_id || t('dag.detail.unknown') }}</strong>
            </div>
          </div>
        </div>

        <div v-else class="dag-explorer__result" data-testid="dag-explorer-result">
          <DagNodeResultView :result="nodeResult" :loading="resultLoading" />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dag-explorer {
  display: flex;
  min-height: 0;
  min-width: 0;
  flex: 1;
  margin-top: 12px;
  flex-direction: column;
}

.dag-explorer__empty {
  display: grid;
  min-height: 120px;
  flex: 1;
  place-items: center;
  color: var(--hr-text-4);
  font-size: 13px;
}

.dag-explorer__body {
  display: grid;
  min-height: 0;
  flex: 1;
  gap: 12px;
  grid-template-columns: minmax(180px, 232px) minmax(0, 1fr);
}

.dag-explorer__list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border: 1px solid var(--hr-border);
  border-radius: 14px;
  background: var(--hr-surface-1);
  overflow: hidden;
}

.dag-explorer__list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--hr-border);
  padding: 8px 12px;
  color: var(--hr-text-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dag-explorer__list-count {
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--hr-text-2);
  background: var(--hr-control);
  font-size: 10px;
}

.dag-explorer__list-scroll {
  display: grid;
  align-content: start;
  gap: 4px;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.dag-explorer__node {
  display: grid;
  align-items: center;
  gap: 8px;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 7px 8px;
  background: transparent;
  color: var(--hr-text-2);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.dag-explorer__node:hover {
  background: var(--hr-surface-2);
}

.dag-explorer__node--active {
  border-color: var(--hr-accent-border);
  background: var(--hr-accent-soft);
}

.dag-explorer__node-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--hr-text-4);
}

.dag-explorer__node[data-status='running'] .dag-explorer__node-dot {
  background: var(--hr-success);
  box-shadow: 0 0 8px var(--hr-focus-ring);
}

.dag-explorer__node[data-status='completed'] .dag-explorer__node-dot {
  background: var(--hr-info);
}

.dag-explorer__node[data-status='failed'] .dag-explorer__node-dot {
  background: var(--hr-danger);
}

.dag-explorer__node[data-status='waiting_for_command'] .dag-explorer__node-dot,
.dag-explorer__node[data-status='ready'] .dag-explorer__node-dot {
  background: var(--hr-warning);
}

.dag-explorer__node-main {
  display: grid;
  min-width: 0;
}

.dag-explorer__node-name {
  overflow: hidden;
  color: var(--hr-text-1);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dag-explorer__node-mini {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 2px;
  color: var(--hr-text-3);
  font-family: var(--hr-font-mono, ui-monospace, monospace);
  font-size: 10px;
}

.dag-explorer__node-mini-icon {
  width: 10px;
  height: 10px;
  color: var(--hr-info);
}

.dag-explorer__node-kind {
  border-radius: 999px;
  padding: 2px 6px;
  color: var(--hr-accent);
  background: var(--hr-accent-soft);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0;
}

.dag-explorer__node-kind--worker {
  color: var(--hr-text-3);
  background: var(--hr-control);
}

.dag-explorer__detail {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border: 1px solid var(--hr-border);
  border-radius: 14px;
  background: var(--hr-surface-1);
  overflow: hidden;
}

.dag-explorer__detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--hr-border);
  padding: 10px 12px;
}

.dag-explorer__detail-title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.dag-explorer__detail-title strong {
  overflow: hidden;
  color: var(--hr-text-1);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dag-explorer__detail-kind {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 8px;
  color: var(--hr-text-3);
  background: var(--hr-control);
  font-size: 10px;
  font-weight: 700;
}

.dag-explorer__detail-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}

.dag-explorer__status {
  border-radius: 999px;
  padding: 3px 9px;
  background: var(--hr-control);
  color: var(--hr-text-3);
  font-size: 10px;
  font-weight: 700;
}

.dag-explorer__status[data-status='running'] {
  background: var(--hr-success-soft);
  color: var(--hr-success);
}

.dag-explorer__status[data-status='completed'] {
  background: var(--hr-info-soft);
  color: var(--hr-info);
}

.dag-explorer__status[data-status='failed'] {
  background: var(--hr-danger-soft);
  color: var(--hr-danger);
}

.dag-explorer__status[data-status='waiting_for_command'],
.dag-explorer__status[data-status='ready'],
.dag-explorer__status[data-status='cancelled'],
.dag-explorer__status[data-status='skipped'] {
  background: var(--hr-warning-soft);
  color: var(--hr-warning);
}

.dag-explorer__expand {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--hr-border);
  border-radius: 8px;
  background: var(--hr-panel);
  color: var(--hr-text-3);
  cursor: pointer;
}

.dag-explorer__expand:hover {
  border-color: var(--hr-accent-border);
  color: var(--hr-accent);
}

.dag-explorer__worker,
.dag-explorer__result {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 12px;
}

.dag-explorer__metric-strip {
  display: flex;
  align-items: center;
  gap: 16px;
}

.dag-explorer__metric {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--hr-info);
  font-size: 12px;
}

.dag-explorer__metric strong {
  color: var(--hr-text-1);
  font-family: var(--hr-font-mono, ui-monospace, monospace);
}

.dag-explorer__metric em {
  color: var(--hr-text-3);
  font-size: 11px;
  font-style: normal;
}

.dag-explorer__metric--danger {
  color: var(--hr-danger);
}

.dag-explorer__metric--danger strong {
  color: var(--hr-danger);
}

.dag-explorer__tokens {
  display: grid;
  gap: 6px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.dag-explorer__token {
  border: 1px solid var(--hr-border);
  border-radius: 10px;
  padding: 7px 8px;
  background: var(--hr-panel);
}

.dag-explorer__token span {
  display: block;
  color: var(--hr-text-4);
  font-size: 9px;
}

.dag-explorer__token strong {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--hr-text-1);
  font-family: var(--hr-font-mono, ui-monospace, monospace);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dag-explorer__token--total {
  border-color: var(--hr-success-border);
  background: var(--hr-success-soft);
}

.dag-explorer__token--total span,
.dag-explorer__token--total strong {
  color: var(--hr-success);
}

.dag-explorer__exec {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.dag-explorer__exec span {
  display: block;
  color: var(--hr-text-4);
  font-size: 9px;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dag-explorer__exec strong {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--hr-text-2);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

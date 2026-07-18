<script setup lang="ts">
/**
 * DagRuntimeToolbar — DAG Runtime 覆盖层顶部工具栏。
 *
 * 展示 run 摘要（id/状态/节点进度）、全局指标汇总（token/工具/失败）、
 * 图例、布局操作（重置视图/暂停物理）和关闭按钮。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { fmtTokens } from '@/lib/agentPersonas'
import { cn } from '@/lib/utils'
import type { DAGRunMetrics } from '@/api/types/dag.types'
import { X, Maximize2, Pause, Play, Wrench, AlertTriangle, Coins, ArrowLeft, Network } from 'lucide-vue-next'

const props = defineProps<{
  metrics: DAGRunMetrics | null
  showBack?: boolean
  /** 'run_list' = 列表态（精简，只显示标题）；'dag_graph' = 图态（显示 run 详情 + 指标） */
  view?: 'run_list' | 'dag_graph'
  /** run 列表总数（列表态显示） */
  runsCount?: number
}>()

const emit = defineEmits<{
  close: []
  back: []
  'fit-view': []
  'toggle-physics': []
}>()

const store = useAgentStore()
const { t } = useI18n()
const physicsPaused = defineModel<boolean>('physicsPaused', { default: false })

const completedCount = computed(() => store.statusSummary.completed + store.statusSummary.skipped)
const progressPct = computed(() => {
  if (!store.nodes.length) return 0
  return Math.round((completedCount.value / store.nodes.length) * 100)
})

const executionStatusLabel = computed(() => {
  const status = store.dagExecution?.status
  if (!status) return 'idle'
  if (status === 'waiting') return t('dag.status.waitingForCommand')
  return t(`dag.status.${status}`)
})

const totals = computed(() => {
  if (props.metrics) {
    return {
      tokens: props.metrics.totals.tokens.input + props.metrics.totals.tokens.output + props.metrics.totals.tokens.cache_read,
      toolCalls: props.metrics.totals.tool_calls,
      failures: props.metrics.totals.tool_failures,
      available: props.metrics.totals.usage_available,
    }
  }
  // 降级：从 store.nodes 本地累加（无 usage 时）
  let tokens = 0, calls = 0, fails = 0
  for (const n of store.nodes) {
    if (n.token_usage) tokens += n.token_usage.input_tokens + n.token_usage.output_tokens + n.token_usage.cache_read_input_tokens
  }
  return { tokens, toolCalls: calls, failures: fails, available: tokens > 0 }
})

const statusItems = computed(() => [
  { key: 'running', label: t('dag.toolbar.legend.running'), color: 'bg-[var(--hr-success)]' },
  { key: 'waiting_for_command', label: t('dag.status.waitingForCommand'), color: 'bg-[var(--hr-warning)]' },
  { key: 'completed', label: t('dag.toolbar.legend.completed'), color: 'bg-[var(--hr-info)]' },
  { key: 'failed', label: t('dag.toolbar.legend.failed'), color: 'bg-[var(--hr-danger)]' },
  { key: 'ready', label: t('dag.toolbar.legend.ready'), color: 'bg-[var(--hr-info)]' },
  { key: 'pending', label: t('dag.toolbar.legend.pending'), color: 'bg-[var(--hr-text-3)]' },
  { key: 'skipped', label: t('dag.toolbar.legend.skipped'), color: 'bg-[var(--hr-warning)]' },
])
</script>

<template>
  <div class="dag-runtime-toolbar pointer-events-auto absolute left-0 right-0 top-0 z-20 flex items-center gap-5 border-b-2 border-[var(--hr-border)] bg-[var(--hr-panel)] px-6 py-4 backdrop-blur-2xl">
    <!-- 列表态：精简，只显示大标题 + 数量 -->
    <template v-if="view === 'run_list'">
      <div class="flex items-center gap-3">
        <Network class="h-7 w-7 text-[var(--hr-accent)]" />
        <span class="text-2xl font-bold tracking-wide text-[var(--hr-text-1)]">{{ t('dag.runList.title') }}</span>
        <span class="rounded-full border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-3 py-1 text-base font-medium text-[var(--hr-accent)]">
          {{ runsCount ?? 0 }}
        </span>
      </div>
    </template>

    <!-- 图态：完整 run 标识 + 进度 + 指标 -->
    <template v-else>
    <!-- 左：run 标识 + 进度 -->
    <div class="flex min-w-0 items-center gap-3">
      <div class="flex flex-col">
        <div class="flex items-center gap-2.5">
          <span class="text-base font-bold uppercase tracking-[0.18em] text-[var(--hr-accent)]">{{ t('dag.toolbar.runtime') }}</span>
          <span
            :class="cn(
              'rounded-full border px-3 py-1 text-sm font-medium',
              store.isRunning ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]' :
              store.isWaiting ? 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] text-[var(--hr-warning)]' :
              store.isCompleted ? 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]' :
              store.isFailed ? 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]' :
              'border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-3)]'
            )"
          >
            {{ executionStatusLabel }}
          </span>
        </div>
        <div class="mt-1 flex items-center gap-2 text-sm text-[var(--hr-text-3)]">
          <span class="font-mono">{{ store.currentRunId ? store.currentRunId.slice(-12) : '—' }}</span>
          <span class="text-[var(--hr-text-4)]">·</span>
          <span>{{ t('dag.toolbar.nodesProgress', { completed: completedCount, total: store.nodes.length }) }}</span>
        </div>
      </div>
      <!-- 进度条 -->
      <div v-if="store.nodes.length" class="hidden w-40 md:block">
        <div class="h-2 overflow-hidden rounded-full bg-[var(--hr-surface-2)]">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="store.isFailed ? 'bg-[var(--hr-danger)]' : 'bg-gradient-to-r from-[var(--hr-accent)] to-[var(--hr-success)]'"
            :style="{ width: `${progressPct}%` }"
          />
        </div>
      </div>
    </div>

    <!-- 中：全局指标 -->
    <div class="ml-auto hidden items-center gap-6 lg:flex">
      <div class="flex items-center gap-2">
        <Coins class="h-4 w-4 text-[var(--hr-success)]" />
        <span class="text-xs text-[var(--hr-text-3)]">tokens</span>
        <span class="font-mono text-sm font-semibold text-[var(--hr-text-1)]">
          {{ totals.available ? fmtTokens(totals.tokens) : '—' }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <Wrench class="h-4 w-4 text-[var(--hr-info)]" />
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('dag.toolbar.tools') }}</span>
        <span class="font-mono text-sm font-semibold text-[var(--hr-text-1)]">{{ totals.toolCalls }}</span>
      </div>
      <div class="flex items-center gap-2">
        <AlertTriangle class="h-4 w-4" :class="totals.failures > 0 ? 'text-[var(--hr-danger)]' : 'text-[var(--hr-text-4)]'" />
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('dag.toolbar.failures') }}</span>
        <span
          class="font-mono text-sm font-semibold"
          :class="totals.failures > 0 ? 'text-[var(--hr-danger)]' : 'text-[var(--hr-text-1)]'"
        >{{ totals.failures }}</span>
      </div>
    </div>

    <!-- 图例 -->
    <div class="hidden items-center gap-2.5 xl:flex">
      <div v-for="item in statusItems" :key="item.key" class="flex items-center gap-1">
        <span :class="cn('h-2 w-2 rounded-full', item.color)" />
        <span class="text-[9px] text-[var(--hr-text-4)]">{{ item.label }}</span>
      </div>
    </div>

    <!-- 右：操作按钮 -->
    <div class="flex items-center gap-1.5">
      <button
        v-if="showBack"
        data-testid="dag-run-list"
        class="flex h-9 items-center gap-1.5 rounded-full border border-[var(--hr-border)] px-3 text-xs text-[var(--hr-text-2)] transition-colors hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
        :title="t('dag.toolbar.back')"
        @click="emit('back')"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
        <span class="hidden sm:inline">{{ t('dag.toolbar.runList') }}</span>
      </button>
      <button
        data-testid="dag-physics-toggle"
        class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] transition-colors hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
        :title="physicsPaused ? t('dag.toolbar.resumePhysics') : t('dag.toolbar.pausePhysics')"
        @click="physicsPaused = !physicsPaused"
      >
        <Play v-if="physicsPaused" class="h-3.5 w-3.5" />
        <Pause v-else class="h-3.5 w-3.5" />
      </button>
      <button
        data-testid="dag-reset-view"
        class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] transition-colors hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
        :title="t('dag.toolbar.resetView')"
        @click="emit('fit-view')"
      >
        <Maximize2 class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex items-center gap-1.5 rounded-full border border-[var(--hr-border)] px-3 py-2 text-xs text-[var(--hr-text-2)] transition-colors hover:bg-[var(--hr-danger-soft)] hover:text-[var(--hr-danger)]"
        :title="t('dag.toolbar.closeEsc')"
        @click="emit('close')"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
    </template><!-- /图态 -->

    <!-- 列表态的关闭按钮（图态的在上方 template 内） -->
    <button
      v-if="view === 'run_list'"
      class="ml-auto flex items-center gap-1.5 rounded-full border border-[var(--hr-border)] px-4 py-2 text-sm text-[var(--hr-text-2)] transition-colors hover:bg-[var(--hr-danger-soft)] hover:text-[var(--hr-danger)]"
      :title="t('dag.toolbar.closeEsc')"
      @click="emit('close')"
    >
      <X class="h-4 w-4" />
      <span>{{ t('dag.toolbar.close') }}</span>
    </button>
  </div>
</template>

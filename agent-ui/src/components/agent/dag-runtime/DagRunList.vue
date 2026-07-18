<script setup lang="ts">
/**
 * DagRunList — DAG Runtime 覆盖层的 run 列表态。
 *
 * 垂直滚动卡片列表，每张卡片 = 一个历史/活跃 run。
 * 手柄：focusedIndex 控制焦点（青色高亮+左侧指示条），× 确认打开。
 * 触摸/鼠标：直接点卡片。
 */

import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RunListItem } from './useRunList'
import { getAgentPersona } from '@/lib/agentPersonas'
import { cn } from '@/lib/utils'
import { CheckCircle2, XCircle, Loader2, Clock, ChevronRight, Network, CirclePause } from 'lucide-vue-next'

const props = defineProps<{
  runs: RunListItem[]
  loading: boolean
  focusedIndex: number
  currentRunId: string | null
}>()

const emit = defineEmits<{
  'select-run': [runId: string]
}>()

const { t } = useI18n()

const listRef = ref<HTMLElement | null>(null)

const statusMeta = computed(() => (status: string) => {
  switch (status) {
    case 'active':
      return { icon: Loader2, color: 'text-[var(--hr-success)]', bg: 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)]', spin: true, label: t('dag.status.active') }
    case 'waiting':
      return { icon: CirclePause, color: 'text-[var(--hr-warning)]', bg: 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)]', spin: false, label: t('dag.status.waitingForCommand') }
    case 'completed':
      return { icon: CheckCircle2, color: 'text-[var(--hr-info)]', bg: 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)]', spin: false, label: t('dag.status.completed') }
    case 'failed':
      return { icon: XCircle, color: 'text-[var(--hr-danger)]', bg: 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)]', spin: false, label: t('dag.status.failed') }
    case 'cancelled':
      return { icon: XCircle, color: 'text-[var(--hr-warning)]', bg: 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)]', spin: false, label: t('dag.status.cancelled') }
    default:
      return { icon: Clock, color: 'text-[var(--hr-text-3)]', bg: 'border-[var(--hr-border)] bg-[var(--hr-surface-1)]', spin: false, label: status }
  }
})

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return t('dag.runList.justNow')
  if (diff < 3_600_000) return t('dag.runList.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('dag.runList.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  return d.toLocaleString()
}

// 手柄焦点变化时，滚动到可见
watch(() => props.focusedIndex, async (idx) => {
  if (idx < 0 || idx >= props.runs.length) return
  await nextTick()
  const el = listRef.value?.querySelector<HTMLElement>(`[data-run-idx="${idx}"]`)
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})
</script>

<template>
  <div class="dag-run-list flex h-full flex-col">
    <!-- 标题 -->
    <div class="flex items-center gap-3 px-8 pb-4 pt-24 flex-shrink-0">
      <Network class="h-6 w-6 text-[var(--hr-accent)]" />
      <h2 class="text-xl font-semibold tracking-wide text-[var(--hr-text-1)]">{{ t('dag.runList.title') }}</h2>
      <span class="ml-1 rounded-full border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-1 text-sm text-[var(--hr-text-3)]">
        {{ runs.length }}
      </span>
    </div>

    <!-- 列表 -->
    <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
      <!-- 加载态 -->
      <div v-if="loading && !runs.length" class="flex items-center justify-center py-12">
        <Loader2 class="h-5 w-5 animate-spin text-[var(--hr-accent)]" />
      </div>

      <!-- 空态 -->
      <div v-else-if="!runs.length" class="flex flex-col items-center justify-center py-16 text-center">
        <Network class="mb-3 h-10 w-10 text-[var(--hr-text-4)]" />
        <div class="text-sm text-[var(--hr-text-3)]">{{ t('dag.runList.empty') }}</div>
        <div class="mt-1 max-w-xs text-xs leading-5 text-[var(--hr-text-4)]">
          {{ t('dag.runList.emptyDescription') }}
        </div>
      </div>

      <!-- run 卡片 -->
      <button
        v-for="(run, idx) in runs"
        :key="run.runId"
        :data-run-idx="idx"
        :data-run-id="run.runId"
        :data-testid="`dag-run-${run.runId}`"
        :class="cn(
          'group relative mb-3 flex w-full items-center gap-4 rounded-2xl border px-5 py-5 text-left transition-all duration-150',
          'min-h-[76px]',
          idx === focusedIndex
            ? 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] scale-[1.015] shadow-[var(--hr-shadow-accent)]'
            : run.runId === currentRunId
              ? 'border-[var(--hr-border-strong)] bg-[var(--hr-surface-1)] hover:border-[var(--hr-accent-border)]'
              : 'border-[var(--hr-border)] bg-[var(--hr-surface-1)] hover:border-[var(--hr-border-strong)] hover:bg-[var(--hr-surface-2)]'
        )"
        @click="emit('select-run', run.runId)"
      >
        <!-- 焦点指示条 -->
        <span
          v-if="idx === focusedIndex"
          class="absolute left-0 top-1/2 h-10 w-[4px] -translate-y-1/2 rounded-r-full bg-[var(--hr-accent)] shadow-[0_0_10px_color-mix(in_srgb,var(--hr-accent)_70%,transparent)]"
        />

        <!-- 状态图标 -->
        <div
          :data-status="run.status"
          :class="cn(
            'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border',
            statusMeta(run.status).bg
          )"
        >
          <component
            :is="statusMeta(run.status).icon"
            :class="cn('h-5 w-5', statusMeta(run.status).color, statusMeta(run.status).spin && 'animate-spin')"
          />
        </div>

        <!-- 主体信息 -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2.5">
            <span class="truncate text-base font-medium text-[var(--hr-text-1)]">
              {{ run.workflowName || 'DAG Run' }}
            </span>
            <span
              v-if="run.runId === currentRunId"
              class="rounded-full border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--hr-accent)]"
            >
              {{ t('dag.runList.current') }}
            </span>
          </div>
          <div class="mt-1 flex items-center gap-2.5 text-sm text-[var(--hr-text-3)]">
            <span class="font-mono">{{ run.runId.slice(-12) }}</span>
            <span class="text-[var(--hr-text-4)]">·</span>
            <span>{{ t('dag.runList.nodes', { count: run.nodeCount ?? '?' }) }}</span>
            <span class="text-[var(--hr-text-4)]">·</span>
            <span>{{ fmtTime(run.createdAt) }}</span>
          </div>
        </div>

        <!-- 右侧状态标签 + 箭头 -->
        <div class="flex flex-shrink-0 items-center gap-3">
          <span
            :class="cn('rounded-full border px-3 py-1 text-sm font-medium', statusMeta(run.status).bg, statusMeta(run.status).color)"
          >
            {{ statusMeta(run.status).label }}
          </span>
          <ChevronRight
            class="h-6 w-6 text-[var(--hr-text-4)] transition-colors group-hover:text-[var(--hr-text-2)]"
          />
        </div>
      </button>
    </div>
  </div>
</template>

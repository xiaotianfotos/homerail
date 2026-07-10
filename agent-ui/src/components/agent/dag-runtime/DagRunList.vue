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
import { CheckCircle2, XCircle, Loader2, Clock, ChevronRight, Network } from 'lucide-vue-next'

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
      return { icon: Loader2, color: 'text-emerald-300', bg: 'border-emerald-300/25 bg-emerald-300/10', spin: true, label: t('dag.status.active') }
    case 'completed':
      return { icon: CheckCircle2, color: 'text-blue-300', bg: 'border-blue-300/25 bg-blue-300/10', spin: false, label: t('dag.status.completed') }
    case 'failed':
      return { icon: XCircle, color: 'text-red-300', bg: 'border-red-400/30 bg-red-500/15', spin: false, label: t('dag.status.failed') }
    case 'cancelled':
      return { icon: XCircle, color: 'text-amber-300', bg: 'border-amber-300/25 bg-amber-300/10', spin: false, label: t('dag.status.cancelled') }
    default:
      return { icon: Clock, color: 'text-white/40', bg: 'border-white/10 bg-white/[0.04]', spin: false, label: status }
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
      <Network class="h-6 w-6 text-cyan-200/60" />
      <h2 class="text-xl font-semibold tracking-wide text-white/85">{{ t('dag.runList.title') }}</h2>
      <span class="ml-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm text-white/45">
        {{ runs.length }}
      </span>
    </div>

    <!-- 列表 -->
    <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
      <!-- 加载态 -->
      <div v-if="loading && !runs.length" class="flex items-center justify-center py-12">
        <Loader2 class="h-5 w-5 animate-spin text-cyan-200/40" />
      </div>

      <!-- 空态 -->
      <div v-else-if="!runs.length" class="flex flex-col items-center justify-center py-16 text-center">
        <Network class="mb-3 h-10 w-10 text-cyan-200/15" />
        <div class="text-sm text-white/45">{{ t('dag.runList.empty') }}</div>
        <div class="mt-1 max-w-xs text-xs leading-5 text-white/25">
          {{ t('dag.runList.emptyDescription') }}
        </div>
      </div>

      <!-- run 卡片 -->
      <button
        v-for="(run, idx) in runs"
        :key="run.runId"
        :data-run-idx="idx"
        :class="cn(
          'group relative mb-3 flex w-full items-center gap-4 rounded-2xl border px-5 py-5 text-left transition-all duration-150',
          'min-h-[76px]',
          idx === focusedIndex
            ? 'border-cyan-200/45 bg-cyan-200/[0.10] scale-[1.015] shadow-[0_0_28px_rgba(103,232,249,0.16)]'
            : run.runId === currentRunId
              ? 'border-cyan-200/22 bg-cyan-200/[0.04] hover:border-cyan-200/32'
              : 'border-white/10 bg-white/[0.03] hover:border-white/18 hover:bg-white/[0.05]'
        )"
        @click="emit('select-run', run.runId)"
      >
        <!-- 焦点指示条 -->
        <span
          v-if="idx === focusedIndex"
          class="absolute left-0 top-1/2 h-10 w-[4px] -translate-y-1/2 rounded-r-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.7)]"
        />

        <!-- 状态图标 -->
        <div
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
            <span class="truncate text-base font-medium text-white/90">
              {{ run.workflowName || 'DAG Run' }}
            </span>
            <span
              v-if="run.runId === currentRunId"
              class="rounded-full border border-cyan-200/30 bg-cyan-200/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-100"
            >
              {{ t('dag.runList.current') }}
            </span>
          </div>
          <div class="mt-1 flex items-center gap-2.5 text-sm text-white/45">
            <span class="font-mono">{{ run.runId.slice(-12) }}</span>
            <span class="text-white/20">·</span>
            <span>{{ t('dag.runList.nodes', { count: run.nodeCount ?? '?' }) }}</span>
            <span class="text-white/20">·</span>
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
            class="h-6 w-6 text-white/25 transition-colors group-hover:text-white/60"
          />
        </div>
      </button>
    </div>
  </div>
</template>

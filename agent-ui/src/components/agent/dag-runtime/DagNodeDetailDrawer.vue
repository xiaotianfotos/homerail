<script setup lang="ts">
/**
 * DagNodeDetailDrawer — DAG Runtime 覆盖层右侧浮出的节点详情抽屉。
 *
 * 双面板结构：
 *  - 任务详情（节点职责 system prompt + 用户任务 inputs.prompt）
 *  - 聊天日志（气泡式，worker 响应流）
 *
 * 手柄：■(square) 展开/折叠当前聚焦面板，dpad↑↓ 切面板焦点。
 * 聊天日志面板展开时自动滚到底部（最新记录）。
 */

import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { useDagNodeMessages } from '@/composables/useDagNodeMessages'
import { getAgentPersona, fmtTokens, contextBarColor, contextUsageText } from '@/lib/agentPersonas'
import { cn } from '@/lib/utils'
import { http } from '@/api/clients/http-client'
import { renderMarkdown } from '@/utils/message-formatter'
import { formatRepositoryReferencesForDisplay } from './dagRuntimePresentation'
import MessageList from '@/components/message/MessageList.vue'
import type { DAGRunMetrics } from '@/api/types/dag.types'
import { X, ChevronDown, ChevronUp, FileText, MessageSquare, Wrench, AlertTriangle, Coins, Clock } from 'lucide-vue-next'

type PanelKey = 'task' | 'logs'

const props = defineProps<{
  metrics: DAGRunMetrics | null
  selectedNodeId: string | null
  open: boolean
  /** 当前聚焦的面板（手柄 dpad↑↓ 切换） */
  panelFocus: PanelKey
  /** 展开的面板集合（■ 切换） */
  expandedPanels: Set<PanelKey>
}>()

const emit = defineEmits<{
  close: []
  'toggle-panel': [panel: PanelKey]
}>()

const store = useAgentStore()
const { t } = useI18n()
const dagRunId = computed(() => store.currentRunId ?? undefined)
const isSelectedManager = computed(() => store.selectedNodeIsManager)

const { messages, loading } = useDagNodeMessages(
  dagRunId,
  computed(() => props.selectedNodeId),
  isSelectedManager,
)

const logScrollRef = ref<HTMLElement | null>(null)
const taskScrollRef = ref<HTMLElement | null>(null)

const node = computed(() => {
  if (!props.selectedNodeId) return null
  return store.nodes.find(n => n.id === props.selectedNodeId) ?? null
})

const nodeMetrics = computed(() => {
  if (!props.selectedNodeId || !props.metrics) return null
  return props.metrics.nodes[props.selectedNodeId] ?? null
})

const persona = computed(() => {
  return node.value ? getAgentPersona(node.value.agent_name) : null
})

// 任务详情：从原始 chat entries 提取 manager 发的 prompt（inputs + system）
const taskPrompt = ref<string>('')
const taskSystem = ref<string>('')

async function fetchTaskDetail(runId: string, nodeId: string): Promise<void> {
  try {
    const res = await http.get<any>(`/api/dag-status/${runId}/node/${nodeId}/chat`)
    const entries = res.data?.messages || []
    const promptEntry = entries.find((e: any) => e?.role === 'manager' && e?.type === 'prompt')
    if (promptEntry?.content) {
      const c = promptEntry.content
      // inputs.prompt 是用户任务（数组），agentConfig.system 是节点职责
      const inputs = c.inputs ?? {}
      const promptArr = inputs.prompt
      const prompt = Array.isArray(promptArr)
        ? promptArr.map(String).join('\n')
        : (typeof promptArr === 'string' ? promptArr : '')
      taskPrompt.value = formatRepositoryReferencesForDisplay(prompt)
      taskSystem.value = typeof c.agentConfig?.system === 'string'
        ? formatRepositoryReferencesForDisplay(c.agentConfig.system)
        : ''
    } else {
      taskPrompt.value = ''
      taskSystem.value = ''
    }
  } catch {
    taskPrompt.value = ''
    taskSystem.value = ''
  }
}

// 节点切换时重新拉取任务详情
watch(
  () => [props.selectedNodeId, dagRunId.value] as const,
  ([nid, rid]) => {
    if (nid && rid) void fetchTaskDetail(rid, nid)
  },
  { immediate: true },
)

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: t('dag.status.pending'), ready: t('dag.status.ready'), running: t('dag.status.running'),
    waiting_for_command: t('dag.status.waitingForCommand'),
    completed: t('dag.status.completed'), failed: t('dag.status.failed'), skipped: t('dag.status.skipped'),
  }
  return map[status] ?? status
}

function statusClass(status: string): string {
  switch (status) {
    case 'running': return 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
    case 'waiting_for_command': return 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] text-[var(--hr-warning)]'
    case 'completed': return 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] text-[var(--hr-info)]'
    case 'failed': return 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'
    case 'ready': return 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]'
    case 'skipped': return 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] text-[var(--hr-warning)]'
    default: return 'border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-3)]'
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.floor(s % 60)}s`
}

// 日志面板展开时滚到底部（最新记录）
watch(
  () => [props.expandedPanels.has('logs'), props.selectedNodeId, messages.value.length] as const,
  ([logsExpanded]) => {
    if (!logsExpanded) return
    void nextTick(() => {
      const el = logScrollRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
  { flush: 'post' },
)

/** 手柄右摇杆滚动（overlay 通过 ref 调用）：跟随当前聚焦的面板 */
function scrollBy(delta: number): void {
  // 聚焦哪个面板就滚哪个；若该面板未展开，退而滚日志
  const target = props.panelFocus === 'task' && props.expandedPanels.has('task')
    ? taskScrollRef.value
    : logScrollRef.value
  if (target) target.scrollBy({ top: delta, behavior: 'auto' })
}

function isPanelFocused(key: PanelKey): boolean {
  return props.panelFocus === key
}

function isPanelExpanded(key: PanelKey): boolean {
  return props.expandedPanels.has(key)
}

defineExpose({ scrollBy })
</script>

<template>
  <transition name="drawer-slide">
    <aside
      v-if="open && node"
      class="dag-detail-drawer pointer-events-auto absolute bottom-0 right-0 top-[88px] z-30 flex w-[min(94vw,520px)] flex-col border-l-2 border-t border-[var(--hr-border-strong)] bg-[var(--hr-panel)] backdrop-blur-2xl"
    >
      <!-- 头部 -->
      <div class="flex items-center gap-3 border-b-2 border-[var(--hr-border)] px-6 py-4 flex-shrink-0">
        <div
          class="flex h-12 w-12 items-center justify-center rounded-2xl flex-shrink-0"
          :style="{ backgroundColor: persona?.color ? `${persona.color}22` : 'var(--hr-surface-2)' }"
        >
          <component
            :is="persona?.icon"
            class="h-5 w-5"
            :style="{ color: persona?.color ?? 'var(--hr-text-3)' }"
          />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-base font-semibold text-[var(--hr-text-1)] truncate">{{ persona?.name }}</div>
          <div class="text-sm text-[var(--hr-text-3)] truncate">{{ node.name }}</div>
        </div>
        <span
          :class="cn('rounded-full border px-3 py-1 text-xs font-medium', statusClass(node.status))"
        >
          {{ statusLabel(node.status) }}
        </span>
        <button
          class="rounded-full p-2 text-[var(--hr-text-3)] transition-colors hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
          :title="t('dag.detail.close')"
          @click="emit('close')"
        >
          <X class="h-5 w-5" />
        </button>
      </div>

      <!-- 指标条（紧凑） -->
      <div v-if="nodeMetrics" class="flex items-center gap-4 px-6 py-2.5 flex-shrink-0 border-b border-[var(--hr-border)] text-sm">
        <span class="flex items-center gap-1.5">
          <Wrench class="h-3.5 w-3.5 text-[var(--hr-info)]" />
          <span class="font-mono font-semibold text-[var(--hr-text-1)]">{{ nodeMetrics.tool_calls }}</span>
        </span>
        <span v-if="nodeMetrics.tool_failures > 0" class="flex items-center gap-1.5">
          <AlertTriangle class="h-3.5 w-3.5 text-[var(--hr-danger)]" />
          <span class="font-mono font-semibold text-[var(--hr-danger)]">{{ nodeMetrics.tool_failures }}</span>
        </span>
        <span class="flex items-center gap-1.5">
          <Coins class="h-3.5 w-3.5 text-[var(--hr-success)]" />
          <span class="font-mono font-semibold text-[var(--hr-text-1)]">
            {{ nodeMetrics.tokens ? fmtTokens(nodeMetrics.tokens.input + nodeMetrics.tokens.output + nodeMetrics.tokens.cache_read) : '—' }}
          </span>
        </span>
        <span class="flex items-center gap-1.5">
          <Clock class="h-3.5 w-3.5 text-[var(--hr-text-3)]" />
          <span class="font-mono text-[var(--hr-text-2)]">{{ fmtDuration(nodeMetrics.duration_ms) }}</span>
        </span>
      </div>

      <!-- 面板：任务详情 -->
      <button
        data-testid="dag-detail-task-toggle"
        :class="cn(
          'flex items-center gap-2.5 px-6 py-3 text-left transition-colors flex-shrink-0 border-b border-[var(--hr-border)]',
          isPanelFocused('task') ? 'bg-[var(--hr-accent-soft)]' : 'hover:bg-[var(--hr-surface-1)]'
        )"
        @click="emit('toggle-panel', 'task')"
      >
        <FileText class="h-4 w-4 flex-shrink-0" :class="isPanelFocused('task') ? 'text-[var(--hr-accent)]' : 'text-[var(--hr-text-3)]'" />
        <span class="flex-1 text-sm font-medium" :class="isPanelFocused('task') ? 'text-[var(--hr-accent)]' : 'text-[var(--hr-text-2)]'">{{ t('dag.detail.task') }}</span>
        <span v-if="isPanelExpanded('task')" class="rounded bg-[var(--hr-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--hr-accent)]">{{ t('dag.detail.collapse') }}</span>
        <component :is="isPanelExpanded('task') ? ChevronUp : ChevronDown" class="h-4 w-4 text-[var(--hr-text-3)]" />
      </button>
      <div v-if="isPanelExpanded('task')" ref="taskScrollRef" class="dag-task-detail flex-shrink-0 overflow-y-auto border-b border-[var(--hr-border)] px-6 py-4 max-h-[40vh]">
        <div v-if="taskSystem" class="mb-4">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--hr-text-3)]">{{ t('dag.detail.role') }}</div>
          <div class="agent-markdown text-[15px] leading-relaxed text-[var(--hr-text-2)]" v-html="renderMarkdown(taskSystem)" />
        </div>
        <div v-if="taskPrompt">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--hr-text-3)]">{{ t('dag.detail.userTask') }}</div>
          <div class="rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-5 py-4">
            <div class="agent-markdown text-[15px] leading-relaxed text-[var(--hr-text-1)]" v-html="renderMarkdown(taskPrompt)" />
          </div>
        </div>
        <div v-if="!taskSystem && !taskPrompt" class="py-6 text-center text-sm text-[var(--hr-text-4)]">
          {{ t('dag.detail.noTask') }}
        </div>
      </div>

      <!-- 面板：聊天日志 -->
      <button
        data-testid="dag-detail-logs-toggle"
        :class="cn(
          'flex items-center gap-2.5 px-6 py-3 text-left transition-colors flex-shrink-0 border-b border-[var(--hr-border)]',
          isPanelFocused('logs') ? 'bg-[var(--hr-accent-soft)]' : 'hover:bg-[var(--hr-surface-1)]'
        )"
        @click="emit('toggle-panel', 'logs')"
      >
        <MessageSquare class="h-4 w-4 flex-shrink-0" :class="isPanelFocused('logs') ? 'text-[var(--hr-accent)]' : 'text-[var(--hr-text-3)]'" />
        <span class="flex-1 text-sm font-medium" :class="isPanelFocused('logs') ? 'text-[var(--hr-accent)]' : 'text-[var(--hr-text-2)]'">{{ t('dag.detail.logs') }}</span>
        <span v-if="isPanelExpanded('logs')" class="rounded bg-[var(--hr-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--hr-accent)]">{{ t('dag.detail.collapse') }}</span>
        <component :is="isPanelExpanded('logs') ? ChevronUp : ChevronDown" class="h-4 w-4 text-[var(--hr-text-3)]" />
      </button>
      <div v-if="isPanelExpanded('logs')" ref="logScrollRef" class="dag-chat-log min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <MessageList
          :messages="messages"
          :loading="loading"
          :empty-text="t('dag.detail.noLogs')"
        />
      </div>

      <!-- 两个都折叠时填充 -->
      <div v-if="!isPanelExpanded('task') && !isPanelExpanded('logs')" class="flex-1" />
    </aside>
  </transition>
</template>

<style scoped>
.dag-detail-drawer {
  box-shadow: var(--hr-shadow-floating);
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* 放大 MessageList 内部字号，强化气泡左右布局 */
.dag-chat-log :deep(.message-list) {
  gap: 0.75rem;
}
.dag-chat-log :deep(.text-message-item) {
  font-size: 1rem;
  line-height: 1.7;
}
.dag-chat-log :deep(.text-message-item .text-content) {
  font-size: 1rem;
}
.dag-chat-log :deep(.user-message) {
  background: var(--hr-accent-soft);
  border: 1px solid var(--hr-accent-border);
  border-radius: 16px 16px 16px 4px;
  padding: 12px 16px;
  max-width: 92%;
  align-self: flex-start;
}
.dag-chat-log :deep(.text-message-item:not(.user-message):not(.thinking-message) .text-content) {
  background: var(--hr-surface-1);
  border: 1px solid var(--hr-border);
  border-radius: 16px 16px 4px 16px;
  padding: 12px 16px;
  margin-left: auto;
  max-width: 92%;
  display: block;
}
.dag-chat-log :deep(.thinking-message .thinking-header) {
  font-size: 0.875rem;
}
.dag-chat-log :deep(.thinking-content) {
  font-size: 0.9rem;
}
.dag-chat-log :deep(.tool-message-item) {
  font-size: 0.95rem;
}
.dag-chat-log :deep(.tool-message-item .tool-name) {
  font-size: 1rem;
}

/* 任务详情 markdown 渲染样式（agent-markdown 复用全局类名，字号放大） */
.dag-task-detail .agent-markdown {
  word-break: break-word;
}
.dag-task-detail .agent-markdown :deep(h1),
.dag-task-detail .agent-markdown :deep(h2),
.dag-task-detail .agent-markdown :deep(h3) {
  font-weight: 600;
  margin: 0.6em 0 0.3em;
  color: var(--hr-text-1);
}
.dag-task-detail .agent-markdown :deep(h1) { font-size: 1.15rem; }
.dag-task-detail .agent-markdown :deep(h2) { font-size: 1.05rem; }
.dag-task-detail .agent-markdown :deep(h3) { font-size: 1rem; }
.dag-task-detail .agent-markdown :deep(p) {
  margin: 0.4em 0;
}
.dag-task-detail .agent-markdown :deep(ul),
.dag-task-detail .agent-markdown :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.4em;
}
.dag-task-detail .agent-markdown :deep(li) {
  margin: 0.2em 0;
}
.dag-task-detail .agent-markdown :deep(code) {
  background: var(--hr-accent-soft);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.9em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dag-task-detail .agent-markdown :deep(pre) {
  background: var(--hr-code-bg);
  border: 1px solid var(--hr-border);
  border-radius: 8px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.dag-task-detail .agent-markdown :deep(pre code) {
  background: none;
  padding: 0;
}
.dag-task-detail .agent-markdown :deep(strong) {
  color: var(--hr-text-1);
  font-weight: 600;
}
.dag-task-detail .agent-markdown :deep(a) {
  color: var(--hr-accent);
  text-decoration: underline;
}
</style>

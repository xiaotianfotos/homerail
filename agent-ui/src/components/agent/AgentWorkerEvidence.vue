<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  TerminalSquare,
  Wrench,
  XCircle,
} from 'lucide-vue-next'
import { getDagNodeChat } from '@/api/services/dag-api'
import type { DAGChatMessage, DAGTaskNode } from '@/api/types/dag.types'
import { useAgentStore } from '@/stores/agent-store'
import { getAgentPersona } from '@/lib/agentPersonas'
import { cn } from '@/lib/utils'

interface NodeEvidence {
  node: DAGTaskNode
  messages: DAGChatMessage[]
  latestText: string
  toolCalls: DAGChatMessage[]
  toolResults: DAGChatMessage[]
  handoffs: DAGChatMessage[]
  errors: DAGChatMessage[]
}

const store = useAgentStore()
const { t } = useI18n()

const loading = ref(false)
const error = ref<string | null>(null)
const evidenceByNode = ref<Record<string, NodeEvidence>>({})
let pollTimer: number | undefined

const selectedEvidence = computed(() => {
  if (!store.selectedNodeId) return null
  return evidenceByNode.value[store.selectedNodeId] ?? null
})

const evidenceList = computed(() => {
  return store.nodes.map(node => {
    return evidenceByNode.value[node.id] ?? emptyEvidence(node)
  })
})

const totals = computed(() => {
  return evidenceList.value.reduce((acc, item) => {
    acc.toolCalls += item.toolCalls.length
    acc.toolResults += item.toolResults.length
    acc.handoffs += item.handoffs.length
    acc.errors += item.errors.length
    return acc
  }, { toolCalls: 0, toolResults: 0, handoffs: 0, errors: 0 })
})

async function loadEvidence(): Promise<void> {
  if (!store.currentRunId || store.nodes.length === 0) {
    evidenceByNode.value = {}
    return
  }
  loading.value = true
  error.value = null
  try {
    const entries = await Promise.all(store.nodes.map(async node => {
      const messages = await getDagNodeChat(store.currentRunId!, node.id).catch(() => [])
      return [node.id, buildEvidence(node, messages)] as const
    }))
    evidenceByNode.value = Object.fromEntries(entries)
    if (!store.selectedNodeId && store.nodes[0]) {
      store.selectNode(store.nodes[0].id)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('agent.evidence.loadFailed')
  } finally {
    loading.value = false
  }
}

function buildEvidence(node: DAGTaskNode, messages: DAGChatMessage[]): NodeEvidence {
  const toolCalls = messages.filter(message => message.type === 'tool_use')
  const toolResults = messages.filter(message => message.type === 'tool_result')
  const handoffs = messages.filter(isHandoff)
  const errors = messages.filter(isError)
  const latestText = [...messages].reverse().find(message => (
    (message.type === 'text' || message.type === 'thinking') && messageText(message).trim()
  ))
  return {
    node,
    messages,
    latestText: latestText ? compact(messageText(latestText), 420) : '',
    toolCalls,
    toolResults,
    handoffs,
    errors,
  }
}

function emptyEvidence(node: DAGTaskNode): NodeEvidence {
  return buildEvidence(node, [])
}

function isHandoff(message: DAGChatMessage): boolean {
  const text = `${message.tool_name ?? ''} ${message.content ?? ''}`.toLowerCase()
  return text.includes('handoff') || text.includes('node_handoff')
}

function isError(message: DAGChatMessage): boolean {
  if (message.is_error || message.role === 'error') return true
  if (message.type !== 'tool_result') return false
  return /\b(error|failed|exception|traceback|permission denied|not found)\b/i.test(messageText(message))
}

function messageText(message: DAGChatMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) return message.content
  if (message.tool_result != null) return stringify(message.tool_result)
  if (message.tool_input != null) return stringify(message.tool_input)
  return ''
}

function toolLabel(message: DAGChatMessage): string {
  return (message.tool_name || 'tool').replace(/^mcp__[^_]+__/, '')
}

function toolDetail(message: DAGChatMessage): string {
  if (message.type === 'tool_use' && message.tool_input) return stringify(message.tool_input)
  return messageText(message)
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function compact(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized
}

function statusIcon(status: string) {
  switch (status) {
    case 'running': return Loader2
    case 'completed': return CheckCircle2
    case 'failed': return XCircle
    default: return Clock
  }
}

function selectNode(nodeId: string): void {
  store.selectNode(nodeId)
}

function restartPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  if (store.currentRunId && store.isRunning) {
    pollTimer = window.setInterval(() => {
      void loadEvidence()
    }, 8000)
  }
}

watch(() => store.currentRunId, () => {
  void loadEvidence()
  restartPolling()
}, { immediate: true })

watch(() => store.nodes.map(node => `${node.id}:${node.status}`).join('|'), () => {
  void loadEvidence()
  restartPolling()
})

onMounted(restartPolling)

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex-shrink-0 border-b border-[var(--hr-border)] px-3 py-2">
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-text-1)]">
          <FileText class="h-3.5 w-3.5 text-[var(--hr-info)]" />
          {{ t('agent.evidence.title') }}
        </div>
        <div v-if="loading" class="flex items-center gap-1 text-[10px] text-[var(--hr-text-3)]">
          <Loader2 class="h-3 w-3 animate-spin" />
          {{ t('agent.evidence.loading') }}
        </div>
      </div>

      <div class="grid grid-cols-4 gap-1.5 text-[10px]">
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.evidence.toolCalls') }}</div>
          <div class="mt-0.5 text-[var(--hr-text-1)]">{{ totals.toolCalls }}</div>
        </div>
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.evidence.toolResults') }}</div>
          <div class="mt-0.5 text-[var(--hr-text-1)]">{{ totals.toolResults }}</div>
        </div>
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.evidence.handoffs') }}</div>
          <div class="mt-0.5 text-[var(--hr-info)]">{{ totals.handoffs }}</div>
        </div>
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.evidence.errors') }}</div>
          <div :class="cn('mt-0.5', totals.errors ? 'text-[var(--hr-danger)]' : 'text-[var(--hr-text-1)]')">{{ totals.errors }}</div>
        </div>
      </div>
      <div v-if="error" class="mt-2 rounded border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-2 py-1 text-[10px] text-[var(--hr-danger)]">
        {{ error }}
      </div>
    </div>

    <div v-if="store.nodes.length === 0" class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <Bot class="mx-auto h-8 w-8 text-[var(--hr-text-4)]" />
        <div class="mt-2 text-xs text-[var(--hr-text-4)]">{{ t('agent.inspector.noNodes') }}</div>
      </div>
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[160px_minmax(0,1fr)]">
      <div class="min-h-0 overflow-y-auto border-r border-[var(--hr-border)] py-1">
        <button
          v-for="item in evidenceList"
          :key="item.node.id"
          :class="cn(
            'w-full px-2 py-2 text-left transition-colors',
            store.selectedNodeId === item.node.id ? 'bg-[var(--hr-info-soft)]' : 'hover:bg-[var(--hr-surface-2)]'
          )"
          @click="selectNode(item.node.id)"
        >
          <div class="flex items-center gap-2">
            <div
              class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded"
              :style="{ backgroundColor: getAgentPersona(item.node.agent_name).color + '22' }"
            >
              <component
                :is="getAgentPersona(item.node.agent_name).icon"
                class="h-3 w-3"
                :style="{ color: getAgentPersona(item.node.agent_name).color }"
              />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-[11px] font-medium text-[var(--hr-text-1)]">{{ item.node.name }}</div>
              <div class="truncate text-[10px] text-[var(--hr-text-4)]">{{ item.node.id }}</div>
            </div>
            <component
              :is="statusIcon(item.node.status)"
              :class="cn(
                'h-3.5 w-3.5 flex-shrink-0',
                item.node.status === 'failed' ? 'text-[var(--hr-danger)]' :
                item.node.status === 'completed' ? 'text-[var(--hr-info)]' :
                item.node.status === 'running' ? 'text-[var(--hr-success)] animate-spin' :
                'text-[var(--hr-text-3)]'
              )"
            />
          </div>
          <div class="mt-1 flex items-center gap-1 text-[9px] text-[var(--hr-text-3)]">
            <span>{{ item.toolCalls.length }} tools</span>
            <span v-if="item.handoffs.length" class="text-[var(--hr-info)]">{{ item.handoffs.length }} handoff</span>
            <span v-if="item.errors.length" class="text-[var(--hr-danger)]">{{ item.errors.length }} error</span>
          </div>
        </button>
      </div>

      <div class="min-h-0 overflow-y-auto">
        <div v-if="!selectedEvidence" class="flex h-full items-center justify-center text-xs text-[var(--hr-text-4)]">
          {{ t('agent.evidence.selectNode') }}
        </div>

        <div v-else class="space-y-3 p-3">
          <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
            <div class="mb-2 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate text-xs font-medium text-[var(--hr-text-1)]">{{ selectedEvidence.node.name }}</div>
                <div class="mt-0.5 truncate text-[10px] text-[var(--hr-text-4)]">{{ selectedEvidence.node.id }}</div>
              </div>
              <span
                :class="cn(
                  'rounded-full px-2 py-0.5 text-[10px]',
                  selectedEvidence.node.status === 'failed' ? 'bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]' :
                  selectedEvidence.node.status === 'completed' ? 'bg-[var(--hr-info-soft)] text-[var(--hr-info)]' :
                  selectedEvidence.node.status === 'running' ? 'bg-[var(--hr-success-soft)] text-[var(--hr-success)]' :
                  'bg-[var(--hr-surface-2)] text-[var(--hr-text-2)]'
                )"
              >
                {{ selectedEvidence.node.status }}
              </span>
            </div>
            <div class="text-[11px] leading-relaxed text-[var(--hr-text-2)]">
              {{ selectedEvidence.latestText || t('agent.evidence.noText') }}
            </div>
          </section>

          <section v-if="selectedEvidence.handoffs.length" class="rounded-md border border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] p-3">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-info)]">
              <ArrowRightLeft class="h-3.5 w-3.5" />
              {{ t('agent.evidence.handoffs') }}
            </div>
            <div class="space-y-1.5">
              <pre
                v-for="(message, index) in selectedEvidence.handoffs"
                :key="`${message.message_id ?? index}-handoff`"
                class="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--hr-bg)] p-2 text-[10px] leading-relaxed text-[var(--hr-info)]"
              >{{ compact(toolDetail(message), 900) }}</pre>
            </div>
          </section>

          <section v-if="selectedEvidence.errors.length" class="rounded-md border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] p-3">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-danger)]">
              <AlertTriangle class="h-3.5 w-3.5" />
              {{ t('agent.evidence.errors') }}
            </div>
            <div class="space-y-1.5">
              <pre
                v-for="(message, index) in selectedEvidence.errors"
                :key="`${message.message_id ?? index}-error`"
                class="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--hr-bg)] p-2 text-[10px] leading-relaxed text-[var(--hr-danger)]"
              >{{ compact(toolDetail(message), 1100) }}</pre>
            </div>
          </section>

          <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-text-1)]">
              <TerminalSquare class="h-3.5 w-3.5" />
              {{ t('agent.evidence.toolCalls') }}
            </div>
            <div v-if="selectedEvidence.toolCalls.length" class="space-y-1.5">
              <details
                v-for="(message, index) in selectedEvidence.toolCalls"
                :key="`${message.message_id ?? index}-tool`"
                class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5"
              >
                <summary class="cursor-pointer text-[11px] text-[var(--hr-text-1)]">
                  <Wrench class="mr-1 inline h-3 w-3 text-[var(--hr-text-3)]" />
                  {{ toolLabel(message) }}
                </summary>
                <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--hr-text-2)]">{{ compact(toolDetail(message), 1200) }}</pre>
              </details>
            </div>
            <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.evidence.noToolCalls') }}</div>
          </section>

          <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
            <div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-text-1)]">
              <FileText class="h-3.5 w-3.5" />
              {{ t('agent.evidence.timeline') }}
            </div>
            <div v-if="selectedEvidence.messages.length" class="space-y-1.5">
              <div
                v-for="(message, index) in selectedEvidence.messages"
                :key="message.message_id ?? index"
                :class="cn(
                  'rounded border px-2 py-1.5',
                  isError(message) ? 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)]' :
                  isHandoff(message) ? 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)]' :
                  'border-[var(--hr-border)] bg-[var(--hr-surface-1)]'
                )"
              >
                <div class="mb-1 flex items-center justify-between gap-2 text-[9px] text-[var(--hr-text-4)]">
                  <span>{{ message.type }} · {{ toolLabel(message) }}</span>
                  <span>{{ message.timestamp ? new Date(message.timestamp).toLocaleTimeString() : '' }}</span>
                </div>
                <pre class="max-h-24 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--hr-text-2)]">{{ compact(toolDetail(message), 900) }}</pre>
              </div>
            </div>
            <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.evidence.noMessages') }}</div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

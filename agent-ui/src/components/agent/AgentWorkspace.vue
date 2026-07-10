<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { useDagNodeMessages } from '@/composables/useDagNodeMessages'
import { getDagExperienceIngestStatus, retryDagExperienceIngest } from '@/api/services/dag-api'
import type { DAGExperienceIngestStatus } from '@/api/types/dag.types'
import { getAgentPersona, contextBarColor, contextUsageText, fmtTokens } from '@/lib/agentPersonas'
import { cn } from '@/lib/utils'
import MessageList from '@/components/message/MessageList.vue'
import AgentDagOverlay from '@/components/agent/AgentDagOverlay.vue'
import AgentProgressPanel from '@/components/agent/AgentProgressPanel.vue'
import AgentGitArtifactPanel from '@/components/agent/AgentGitArtifactPanel.vue'
import AgentWorkerEvidence from '@/components/agent/AgentWorkerEvidence.vue'
import {
  Network,
  List,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Bot,
  Activity,
  ClipboardList,
  GitPullRequest,
  Database,
  RefreshCw,
} from 'lucide-vue-next'

const store = useAgentStore()
const { t } = useI18n()

const dagRunId = computed(() => store.currentRunId ?? undefined)
const selectedNodeId = computed(() => store.selectedNodeId)
const isSelectedManager = computed(() => store.selectedNodeIsManager)
const experienceIngest = ref<DAGExperienceIngestStatus | null>(null)
const experienceIngestLoading = ref(false)
let experienceIngestPoll: number | undefined

const { messages: nodeMessages, loading: nodeLoading } = useDagNodeMessages(
  dagRunId,
  selectedNodeId,
  isSelectedManager,
)

const hasDagContext = computed(() => Boolean(
  store.currentRunId || store.dagExecution || store.nodes.length > 0 || store.edges.length > 0,
))

const tabs = computed(() => [
  { key: 'progress' as const, label: t('agent.inspector.tabs.progress'), icon: Activity },
  { key: 'artifacts' as const, label: t('agent.inspector.tabs.artifacts'), icon: GitPullRequest },
  { key: 'evidence' as const, label: t('agent.inspector.tabs.evidence'), icon: ClipboardList },
  { key: 'nodes' as const, label: t('agent.inspector.tabs.nodes'), icon: List },
  { key: 'topology' as const, label: t('agent.inspector.tabs.topology'), icon: Network },
  { key: 'logs' as const, label: t('agent.inspector.tabs.logs'), icon: FileText },
])

function selectNode(nodeId: string): void {
  if (store.selectedNodeId === nodeId) {
    store.selectNode(null)
  } else {
    store.selectNode(nodeId)
    store.inspectorTab = 'logs'
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'running': return Loader2
    case 'completed': return CheckCircle2
    case 'failed': return XCircle
    default: return Clock
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'text-emerald-400'
    case 'completed': return 'text-blue-400'
    case 'failed': return 'text-red-400'
    default: return 'text-gray-500'
  }
}

const experienceIngestLabel = computed(() => {
  const status = experienceIngest.value?.status
  if (!status || status === 'not_started') return t('shell.workspace.experience.notStarted')
  if (status === 'applied') return t('shell.workspace.experience.applied')
  if (status === 'failed') return t('shell.workspace.experience.failed')
  if (status === 'skipped') return t('shell.workspace.experience.skipped')
  return t('shell.workspace.experience.status', { status })
})

const experienceIngestClass = computed(() => {
  const status = experienceIngest.value?.status
  if (status === 'applied') return 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200'
  if (status === 'failed') return 'border-red-300/25 bg-red-500/15 text-red-300'
  if (status === 'pending' || status === 'running') return 'border-amber-300/20 bg-amber-300/10 text-amber-200'
  return 'border-white/10 bg-white/[0.04] text-white/45'
})

function isExperienceIngestActive(status?: string): boolean {
  return status === 'pending' || status === 'running'
}

function stopExperienceIngestPoll(): void {
  if (experienceIngestPoll !== undefined) {
    window.clearTimeout(experienceIngestPoll)
    experienceIngestPoll = undefined
  }
}

function scheduleExperienceIngestPoll(status?: string): void {
  stopExperienceIngestPoll()
  if (!dagRunId.value || !isExperienceIngestActive(status)) return
  experienceIngestPoll = window.setTimeout(() => {
    void refreshExperienceIngest()
  }, 3000)
}

async function refreshExperienceIngest(): Promise<void> {
  if (!dagRunId.value) {
    experienceIngest.value = null
    stopExperienceIngestPoll()
    return
  }
  const requestRunId = dagRunId.value
  try {
    experienceIngestLoading.value = true
    const status = await getDagExperienceIngestStatus(requestRunId)
    if (dagRunId.value !== requestRunId) return
    experienceIngest.value = status
    if (status) scheduleExperienceIngestPoll(status.status)
  } catch {
    if (dagRunId.value !== requestRunId) return
    experienceIngest.value = {
      run_id: requestRunId,
      status: 'not_started',
      error_message: 'status unavailable',
    }
    stopExperienceIngestPoll()
  } finally {
    experienceIngestLoading.value = false
  }
}

async function retryExperienceIngest(): Promise<void> {
  if (!dagRunId.value) return
  try {
    experienceIngestLoading.value = true
    const status = await retryDagExperienceIngest(dagRunId.value)
    experienceIngest.value = status
    if (status) scheduleExperienceIngestPoll(status.status)
  } finally {
    experienceIngestLoading.value = false
  }
}

watch(
  () => [dagRunId.value, store.dagExecution?.status],
  () => {
    stopExperienceIngestPoll()
    void refreshExperienceIngest()
  },
  { immediate: true },
)

onBeforeUnmount(stopExperienceIngestPoll)
</script>

<template>
  <div class="agent-workspace flex h-full flex-col bg-transparent">
    <!-- Header: title + DAG summary -->
    <div class="flex-shrink-0 border-b border-cyan-200/10 px-4 py-3">
      <div class="mb-2 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-200/45">{{ t('agent.inspector.title') }}</div>

      <!-- DAG run summary (compact) -->
      <div v-if="store.dagExecution" class="flex flex-wrap items-center gap-2 text-[10px]">
        <span
          :class="cn(
            'rounded-full border px-2 py-1 font-medium',
            store.isRunning ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200' :
            store.isCompleted ? 'border-cyan-200/20 bg-cyan-200/10 text-cyan-100' :
            store.isFailed ? 'bg-red-500/15 text-red-400' :
            'border-white/10 bg-white/[0.04] text-white/45'
          )"
        >
          {{ store.dagExecution.status }}
        </span>
        <span class="font-mono text-white/35">{{ store.currentRunId?.slice(-8) }}</span>
        <span class="text-white/20">·</span>
        <span class="text-white/35">{{ t('shell.workspace.nodes', { count: store.nodes.length }) }}</span>
        <span class="text-white/20">·</span>
        <span class="text-white/35">
          {{ t('shell.workspace.progress', { running: store.statusSummary.running, completed: store.statusSummary.completed }) }}
        </span>
        <span class="text-white/20">·</span>
        <span
          :class="cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-1 font-medium',
            experienceIngestClass,
          )"
          :title="experienceIngest?.error_message || `${experienceIngest?.summary_provider || 'provider'} ${experienceIngest?.summary_model || ''}`"
        >
          <Database class="h-3 w-3" />
          {{ experienceIngestLabel }}
        </span>
        <button
          v-if="experienceIngest?.status === 'failed'"
          class="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-1 font-medium text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/75"
          :disabled="experienceIngestLoading"
          :title="t('shell.workspace.experience.retryTitle')"
          @click="retryExperienceIngest"
        >
          <RefreshCw :class="cn('h-3 w-3', experienceIngestLoading && 'animate-spin')" />
          retry
        </button>
      </div>
      <div v-else class="text-[11px] text-white/35">{{ t('agent.inspector.noDag') }}</div>
    </div>

    <!-- Tab bar -->
    <div class="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-cyan-200/10 px-3 py-2">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        :class="cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-[11px] transition-colors border-b-2',
          store.inspectorTab === tab.key
            ? 'rounded-full border-cyan-200/20 bg-cyan-200/12 text-cyan-100'
            : 'rounded-full border-transparent text-white/[0.42] hover:bg-white/[0.08] hover:text-white/70'
        )"
        @click="store.inspectorTab = tab.key"
      >
        <component :is="tab.icon" class="h-3 w-3" />
        {{ tab.label }}
      </button>
    </div>

    <!-- Content area -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="!hasDagContext"
        class="flex h-full items-center justify-center px-4"
      >
        <div class="max-w-[220px] text-center">
          <Activity class="mx-auto mb-3 h-7 w-7 text-cyan-100/25" />
          <div class="text-xs font-medium text-white/45">{{ t('shell.workspace.emptyTitle') }}</div>
          <div class="mt-1 text-[11px] leading-5 text-white/32">
            {{ t('shell.workspace.emptyDescription') }}
          </div>
          <button
            class="mt-4 rounded-full border border-cyan-200/14 px-3 py-1.5 text-[11px] text-cyan-100/55 transition-colors hover:bg-cyan-200/10 hover:text-white"
            @click="store.settingsPageOpen = true"
          >
            {{ t('shell.workspace.openSettings') }}
          </button>
        </div>
      </div>

      <!-- Progress tab: run health, audit, usage -->
      <div v-else-if="store.inspectorTab === 'progress'">
        <AgentProgressPanel />
      </div>

      <!-- Artifacts tab: branch, issue, PR, changed files -->
      <div v-else-if="store.inspectorTab === 'artifacts'" class="h-full">
        <AgentGitArtifactPanel />
      </div>

      <!-- Evidence tab: structured worker evidence -->
      <div v-else-if="store.inspectorTab === 'evidence'" class="h-full">
        <AgentWorkerEvidence />
      </div>

      <!-- Nodes tab: vertical node list -->
      <div v-else-if="store.inspectorTab === 'nodes'">
        <div v-if="store.nodes.length === 0" class="flex items-center justify-center h-full">
          <div class="text-center space-y-2">
            <Bot class="h-8 w-8 mx-auto opacity-15 text-gray-600" />
            <div class="text-xs text-gray-600">{{ t('agent.inspector.noNodes') }}</div>
          </div>
        </div>

        <div v-else class="py-1">
          <button
            v-for="node in store.nodes"
            :key="node.id"
            :class="cn(
            'mx-2 my-1 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition-colors',
            store.selectedNodeId === node.id
                ? 'border-cyan-200/24 bg-cyan-200/10'
                : 'border-transparent hover:border-white/10 hover:bg-white/[0.04]'
            )"
            @click="selectNode(node.id)"
          >
            <!-- Agent icon -->
            <div
              class="w-7 h-7 rounded-2xl flex items-center justify-center flex-shrink-0"
              :style="{ backgroundColor: getAgentPersona(node.agent_name).color + '22' }"
            >
              <component
                :is="getAgentPersona(node.agent_name).icon"
                class="h-3 w-3"
                :style="{ color: getAgentPersona(node.agent_name).color }"
              />
            </div>

            <!-- Name + status -->
            <div class="flex-1 min-w-0">
              <div class="text-xs font-medium text-white/[0.82] truncate">
                {{ getAgentPersona(node.agent_name).name }}
              </div>
              <div class="text-[10px] text-white/35 truncate">{{ node.name }}</div>
            </div>

            <!-- Status + context -->
            <div class="flex items-center gap-2 flex-shrink-0">
              <!-- Context bar -->
              <div v-if="node.context_usage_pct != null" class="w-10">
                <div class="flex justify-between text-[9px] mb-0.5">
                  <span class="text-white/30">ctx</span>
                  <span :class="contextUsageText(node.context_usage_pct)">
                    {{ node.context_usage_pct }}%
                  </span>
                </div>
                <div class="h-1 rounded-full bg-white/10">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="contextBarColor(node.context_usage_pct)"
                    :style="{ width: `${Math.min(node.context_usage_pct, 100)}%` }"
                  />
                </div>
              </div>

              <!-- Status icon -->
              <component
                :is="statusIcon(node.status)"
                :class="cn(
                  'h-3.5 w-3.5 flex-shrink-0',
                  statusColor(node.status),
                  node.status === 'running' && 'animate-spin'
                )"
              />
            </div>
          </button>
        </div>
      </div>

      <!-- Topology tab: DAG overlay -->
      <div v-else-if="store.inspectorTab === 'topology'" class="h-full">
        <AgentDagOverlay @node-click="selectNode" />
      </div>

      <!-- Logs tab: selected node's messages -->
      <div v-else-if="store.inspectorTab === 'logs'" class="flex flex-col h-full">
        <!-- No node selected -->
        <div v-if="!store.selectedNode" class="flex-1 flex items-center justify-center">
          <div class="text-center space-y-2">
            <FileText class="h-8 w-8 mx-auto opacity-20 text-cyan-100" />
            <div class="text-xs text-white/35">{{ t('agent.inspector.selectNodeLogs') }}</div>
          </div>
        </div>

        <!-- Node selected: show log header + messages -->
        <template v-else>
          <!-- Log header with node info -->
          <div class="flex items-center gap-2 border-b border-cyan-200/10 bg-white/[0.025] px-3 py-2.5 flex-shrink-0">
            <div
              class="w-6 h-6 rounded-xl flex items-center justify-center"
              :style="{ backgroundColor: getAgentPersona(store.selectedNode.agent_name).color + '22' }"
            >
              <component
                :is="getAgentPersona(store.selectedNode.agent_name).icon"
                class="h-2.5 w-2.5"
                :style="{ color: getAgentPersona(store.selectedNode.agent_name).color }"
              />
            </div>
            <div class="flex-1 min-w-0">
              <span class="text-[11px] font-medium text-white/[0.82]">
                {{ getAgentPersona(store.selectedNode.agent_name).name }}
              </span>
              <span class="text-[10px] text-white/35 ml-1">{{ store.selectedNode.name }}</span>
            </div>
            <div
              v-if="store.selectedNode.context_usage_pct != null"
              class="flex items-center gap-1"
            >
              <span :class="cn('text-[10px]', contextUsageText(store.selectedNode.context_usage_pct))">
                {{ store.selectedNode.context_usage_pct }}%
              </span>
              <div class="w-10 h-1 rounded-full bg-gray-700">
                <div
                  class="h-full rounded-full transition-all"
                  :class="contextBarColor(store.selectedNode.context_usage_pct)"
                  :style="{ width: `${Math.min(store.selectedNode.context_usage_pct, 100)}%` }"
                />
              </div>
            </div>
          </div>

          <!-- Messages -->
          <div class="flex-1 min-h-0 overflow-y-auto">
            <MessageList
              :messages="nodeMessages"
              :loading="nodeLoading"
              :empty-text="t('agent.inspector.noLogs')"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- Bottom: token summary for selected node -->
    <div
      v-if="store.selectedNode?.token_usage"
      class="flex-shrink-0 border-t border-gray-800/40 px-3 py-1.5 bg-gray-900/40"
    >
      <div class="flex items-center gap-3 text-[10px] text-gray-500">
        <span>Tokens:</span>
        <span>in {{ fmtTokens(store.selectedNode.token_usage.input_tokens) }}</span>
        <span>out {{ fmtTokens(store.selectedNode.token_usage.output_tokens) }}</span>
        <span>cache {{ fmtTokens(store.selectedNode.token_usage.cache_read_input_tokens) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-workspace {
  --workspace-radius: 22px;
}

.agent-workspace :deep(button),
.agent-workspace :deep(.rounded-md),
.agent-workspace :deep(.rounded-lg),
.agent-workspace :deep(.rounded-xl),
.agent-workspace :deep(.rounded-2xl) {
  border-radius: var(--workspace-radius);
}

.agent-workspace :deep(.border-b) {
  border-color: rgba(103, 232, 249, 0.1);
}

.agent-workspace :deep(.px-3.py-2),
.agent-workspace :deep(.px-3[class~="py-2.5"]) {
  padding: 12px 14px;
}
</style>

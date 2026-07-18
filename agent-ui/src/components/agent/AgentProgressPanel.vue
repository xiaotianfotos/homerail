<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { getRunAuditSummary } from '@/api/agent'
import { getDagEvents, getDagNodeChat } from '@/api/services/dag-api'
import { cn } from '@/lib/utils'
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  CircleDollarSign,
  Clock,
  Loader2,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-vue-next'

type ProgressState = 'done' | 'running' | 'failed' | 'pending'

interface AuditAgent {
  agent_id?: string
  agent_name?: string
  status?: string
  cost_usd?: number | null
  duration_ms?: number | null
  token_usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  message_counts?: Record<string, number>
  is_error?: boolean
}

interface AuditSummary {
  total_cost_usd?: number
  total_agents?: number
  agents?: AuditAgent[]
}

interface ScorecardFailure {
  rule: string
  message: string
  node?: string
}

interface ScorecardSummary {
  passed: boolean
  score: number
  total: number
  error_count: number
  warning_count: number
  failures: ScorecardFailure[]
}

const store = useAgentStore()
const { t } = useI18n()

const audit = ref<AuditSummary | null>(null)
const auditLoading = ref(false)
const auditError = ref<string | null>(null)
const scorecard = ref<ScorecardSummary | null>(null)
const scorecardLoading = ref(false)
const scorecardError = ref<string | null>(null)
let pollTimer: number | undefined

const completedCount = computed(() => store.statusSummary.completed + store.statusSummary.skipped)
const failedNodes = computed(() => store.nodes.filter(node => node.status === 'failed'))
const runningNodes = computed(() => store.nodes.filter(node => node.status === 'running' || node.status === 'ready'))

const progressPercent = computed(() => {
  if (store.nodes.length === 0) return 0
  return Math.round((completedCount.value / store.nodes.length) * 100)
})

const tokenTotals = computed(() => {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const agents = audit.value?.agents ?? []
  if (agents.length > 0) {
    for (const agent of agents) {
      totals.input += Number(agent.token_usage?.input_tokens ?? 0)
      totals.output += Number(agent.token_usage?.output_tokens ?? 0)
      totals.cacheRead += Number(agent.token_usage?.cache_read_input_tokens ?? 0)
      totals.cacheWrite += Number(agent.token_usage?.cache_creation_input_tokens ?? 0)
    }
    return totals
  }
  for (const node of store.nodes) {
    totals.input += Number(node.token_usage?.input_tokens ?? 0)
    totals.output += Number(node.token_usage?.output_tokens ?? 0)
    totals.cacheRead += Number(node.token_usage?.cache_read_input_tokens ?? 0)
    totals.cacheWrite += Number(node.token_usage?.cache_creation_input_tokens ?? 0)
  }
  return totals
})

const toolTotals = computed(() => {
  let toolUse = 0
  let toolResult = 0
  for (const agent of audit.value?.agents ?? []) {
    toolUse += Number(agent.message_counts?.tool_use ?? 0)
    toolResult += Number(agent.message_counts?.tool_result ?? 0)
  }
  return { toolUse, toolResult }
})

const progressItems = computed(() => {
  const hasRun = Boolean(store.currentRunId)
  const hasNodes = store.nodes.length > 0
  const hasAudit = Boolean(audit.value?.agents?.length)
  const hasScorecard = Boolean(scorecard.value)
  return [
    {
      key: 'run',
      label: t('agent.progress.items.run'),
      detail: store.currentRunId ? store.currentRunId.slice(-12) : t('agent.progress.noRun'),
      state: (hasRun ? 'done' : 'pending') as ProgressState,
    },
    {
      key: 'dag',
      label: t('agent.progress.items.dag'),
      detail: store.dagExecution?.status ?? t('agent.progress.noDag'),
      state: (store.isFailed ? 'failed' : store.isCompleted ? 'done' : store.isRunning ? 'running' : 'pending') as ProgressState,
    },
    {
      key: 'workers',
      label: t('agent.progress.items.workers'),
      detail: hasNodes
        ? t('agent.progress.workerRatio', { completed: completedCount.value, total: store.nodes.length })
        : t('agent.progress.noNodes'),
      state: (failedNodes.value.length ? 'failed' : runningNodes.value.length ? 'running' : hasNodes ? 'done' : 'pending') as ProgressState,
    },
    {
      key: 'audit',
      label: t('agent.progress.items.audit'),
      detail: auditError.value || (hasAudit ? t('agent.progress.auditReady') : t('agent.progress.auditPending')),
      state: (auditError.value ? 'failed' : hasAudit ? 'done' : auditLoading.value ? 'running' : 'pending') as ProgressState,
    },
    {
      key: 'scorecard',
      label: t('agent.progress.items.scorecard'),
      detail: scorecardError.value || (hasScorecard
        ? t('agent.progress.scorecardResult', {
          result: scorecard.value?.passed ? 'PASS' : 'FAIL',
          score: scorecard.value?.score ?? 0,
          total: scorecard.value?.total ?? 0,
        })
        : t('agent.progress.scorecardPending')),
      state: (scorecardError.value ? 'failed' : scorecardLoading.value ? 'running' : scorecard.value?.passed ? 'done' : hasScorecard ? 'failed' : 'pending') as ProgressState,
    },
  ]
})

function stateIcon(state: ProgressState) {
  if (state === 'done') return CheckCircle2
  if (state === 'running') return Loader2
  if (state === 'failed') return AlertCircle
  return Circle
}

function stateColor(state: ProgressState): string {
  if (state === 'done') return 'text-[var(--hr-success)]'
  if (state === 'running') return 'text-[var(--hr-info)]'
  if (state === 'failed') return 'text-[var(--hr-danger)]'
  return 'text-[var(--hr-text-4)]'
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function fmtCost(value?: number): string {
  if (!value) return '$0'
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`
}

async function loadAudit(): Promise<void> {
  if (!store.currentRunId) {
    audit.value = null
    auditError.value = null
    return
  }
  auditLoading.value = true
  auditError.value = null
  try {
    const response = await getRunAuditSummary(store.currentRunId)
    const payload = (response.data ?? response) as any
    if (payload?.success === false) {
      audit.value = null
      auditError.value = payload.message || t('agent.progress.auditUnavailable')
    } else {
      audit.value = payload?.data ?? payload
    }
  } catch (error) {
    audit.value = null
    auditError.value = error instanceof Error ? error.message : t('agent.progress.auditUnavailable')
  } finally {
    auditLoading.value = false
  }
}

async function loadScorecard(): Promise<void> {
  if (!store.currentRunId || store.nodes.length === 0) {
    scorecard.value = null
    scorecardError.value = null
    return
  }
  scorecardLoading.value = true
  scorecardError.value = null
  try {
    const [events, chats] = await Promise.all([
      getDagEvents(store.currentRunId),
      Promise.all(store.nodes.map(async node => ({
        node,
        messages: await getDagNodeChat(store.currentRunId!, node.id).catch(() => []),
      }))),
    ])
    scorecard.value = buildUiScorecard(events, chats)
  } catch (error) {
    scorecard.value = null
    scorecardError.value = error instanceof Error ? error.message : t('agent.progress.scorecardUnavailable')
  } finally {
    scorecardLoading.value = false
  }
}

function buildUiScorecard(events: any[], chats: Array<{ node: any; messages: any[] }>): ScorecardSummary {
  const failures: ScorecardFailure[] = []
  let total = 0
  let score = 0

  function check(rule: string, passed: boolean, message: string, node?: string): void {
    total += 1
    if (passed) {
      score += 1
    } else {
      failures.push({ rule, message, node })
    }
  }

  check(
    'dag.no_failed_nodes',
    failedNodes.value.length === 0,
    t('agent.progress.scorecardFailures.failedNodes', { count: failedNodes.value.length }),
  )

  const tester = chats.find(item => roleText(item.node).includes('tester'))
  if (tester) {
    const text = chatText(tester.messages)
    check(
      'tester.runs_validation',
      /\b(pytest|uv\s+run\s+pytest|npm\s+(run\s+)?(test|build|type-?check|lint)|pnpm\s+(run\s+)?(test|build|type-?check|lint)|yarn\s+(test|build|type-?check|lint)|vue-tsc|tsc\s+--noEmit|git\s+diff\s+--check)\b/i.test(text),
      t('agent.progress.scorecardFailures.testerValidation'),
      tester.node.id,
    )
    check(
      'tester.includes_output',
      /\b(pass(ed)?|succeed(ed|s)?|built\s+in|fail(ed)?|error|collected|exit\s+code|[0-9]+\s+passed)\b/i.test(text),
      t('agent.progress.scorecardFailures.testerOutput'),
      tester.node.id,
    )
  }

  const reviewer = chats.find(item => roleText(item.node).includes('reviewer'))
  if (reviewer) {
    check(
      'reviewer.checks_diff',
      /\bgit\s+diff\b|\bdiff\b/i.test(chatText(reviewer.messages)),
      t('agent.progress.scorecardFailures.reviewerDiff'),
      reviewer.node.id,
    )
  }

  const committer = chats.find(item => roleText(item.node).includes('committer'))
  if (committer) {
    check(
      'committer.no_git_add_dot',
      !/(^|[;&|]\s*)git\s+add\s+(\.|-A|--all)(?![\w./-])/im.test(chatText(committer.messages)),
      t('agent.progress.scorecardFailures.gitAddDot'),
      committer.node.id,
    )
  }

  const hookEvents = events.filter(event => event?.event_type === 'hook:handoff_contract')
  const enforced = hookEvents.some(event => event?.details?.enforced)
  if (hookEvents.length) {
    check(
      'artifact.contract_hooks_pass',
      hookEvents.every(event => event?.details?.passed !== false),
      t('agent.progress.scorecardFailures.contractHook'),
    )
    if (enforced) {
      check(
        'artifact.contract_hooks_enforced',
        hookEvents.every(event => event?.details?.enforced),
        t('agent.progress.scorecardFailures.contractSkipped'),
      )
    }
  }

  return {
    passed: failures.length === 0,
    score,
    total,
    error_count: failures.length,
    warning_count: 0,
    failures: failures.slice(0, 4),
  }
}

function roleText(node: any): string {
  return `${node?.id ?? ''} ${node?.name ?? ''} ${node?.agent_name ?? ''}`.toLowerCase()
}

function chatText(messages: any[]): string {
  return messages.map(message => JSON.stringify(message)).join('\n')
}

function openFailureEvidence(failure: ScorecardFailure): void {
  if (!failure.node) return
  store.selectNode(failure.node)
  store.inspectorTab = 'evidence'
}

function restartPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  if (store.currentRunId && store.isRunning) {
    pollTimer = window.setInterval(() => {
      void loadAudit()
      void loadScorecard()
    }, 8000)
  }
}

watch(() => store.currentRunId, () => {
  void loadAudit()
  void loadScorecard()
  restartPolling()
}, { immediate: true })

watch(() => store.nodes.map(node => `${node.id}:${node.status}`).join('|'), () => {
  void loadScorecard()
})

watch(() => store.dagExecution?.status, restartPolling)

onMounted(() => {
  restartPolling()
})

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="space-y-4 p-3">
    <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-xs font-medium text-[var(--hr-text-1)]">{{ t('agent.progress.title') }}</div>
          <div class="mt-0.5 text-[10px] text-[var(--hr-text-4)]">
            {{ store.currentRunId ? store.currentRunId.slice(-12) : t('agent.progress.noRun') }}
          </div>
        </div>
        <div
          :class="cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            store.isFailed ? 'bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]' :
            store.isCompleted ? 'bg-[var(--hr-success-soft)] text-[var(--hr-success)]' :
            store.isRunning ? 'bg-[var(--hr-info-soft)] text-[var(--hr-info)]' :
            'bg-[var(--hr-surface-2)] text-[var(--hr-text-3)]'
          )"
        >
          {{ store.dagExecution?.status ?? 'idle' }}
        </div>
      </div>

      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--hr-surface-2)]">
        <div
          :class="cn('h-full rounded-full transition-all', store.isFailed ? 'bg-[var(--hr-danger)]' : 'bg-[var(--hr-success)]')"
          :style="{ width: `${progressPercent}%` }"
        />
      </div>
      <div class="mt-2 flex justify-between text-[10px] text-[var(--hr-text-3)]">
        <span>{{ progressPercent }}%</span>
        <span>{{ t('agent.progress.workerRatio', { completed: completedCount, total: store.nodes.length }) }}</span>
      </div>
    </section>

    <section class="space-y-1.5">
      <div
        v-for="item in progressItems"
        :key="item.key"
        class="flex items-start gap-2 rounded-md px-2 py-2 hover:bg-[var(--hr-surface-2)]"
      >
        <component
          :is="stateIcon(item.state)"
          :class="cn('mt-0.5 h-3.5 w-3.5 flex-shrink-0', stateColor(item.state), item.state === 'running' && 'animate-spin')"
        />
        <div class="min-w-0 flex-1">
          <div class="text-[11px] font-medium text-[var(--hr-text-1)]">{{ item.label }}</div>
          <div class="mt-0.5 truncate text-[10px] text-[var(--hr-text-4)]">{{ item.detail }}</div>
        </div>
      </div>
    </section>

    <section
      v-if="failedNodes.length"
      class="rounded-md border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] p-3"
    >
      <div class="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--hr-danger)]">
        <AlertCircle class="h-3.5 w-3.5" />
        {{ t('agent.progress.failedNodes') }}
      </div>
      <button
        v-for="node in failedNodes"
        :key="node.id"
        class="flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] text-[var(--hr-danger)] hover:bg-[var(--hr-danger-soft)]"
        @click="store.selectNode(node.id); store.inspectorTab = 'evidence'"
      >
        <span class="truncate">{{ node.name }}</span>
        <span class="ml-2 text-[10px] text-[var(--hr-danger)]">{{ t('agent.progress.viewEvidence') }}</span>
      </button>
    </section>

    <section class="grid grid-cols-2 gap-2">
      <div class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
        <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
          <TerminalSquare class="h-3 w-3" />
          {{ t('agent.progress.tokens') }}
        </div>
        <div class="space-y-1 text-[11px] text-[var(--hr-text-1)]">
          <div class="flex justify-between"><span>in</span><span>{{ fmtTokens(tokenTotals.input) }}</span></div>
          <div class="flex justify-between"><span>out</span><span>{{ fmtTokens(tokenTotals.output) }}</span></div>
          <div class="flex justify-between"><span>cache</span><span>{{ fmtTokens(tokenTotals.cacheRead + tokenTotals.cacheWrite) }}</span></div>
        </div>
      </div>
      <div class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
        <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
          <CircleDollarSign class="h-3 w-3" />
          {{ t('agent.progress.cost') }}
        </div>
        <div class="text-lg font-semibold text-[var(--hr-text-1)]">{{ fmtCost(audit?.total_cost_usd) }}</div>
        <div class="mt-1 text-[10px] text-[var(--hr-text-4)]">
          {{ t('agent.progress.agents', { count: audit?.total_agents ?? store.nodes.length }) }}
        </div>
      </div>
    </section>

    <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
          <ShieldCheck class="h-3 w-3" />
          {{ t('agent.progress.items.scorecard') }}
        </div>
        <div
          :class="cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            !scorecard ? 'bg-[var(--hr-surface-2)] text-[var(--hr-text-3)]' :
            scorecard.passed ? 'bg-[var(--hr-success-soft)] text-[var(--hr-success)]' :
            'bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'
          )"
        >
          {{ scorecard ? (scorecard.passed ? 'PASS' : 'FAIL') : 'N/A' }}
          <span v-if="scorecard" class="ml-1 opacity-70">{{ scorecard.score }}/{{ scorecard.total }}</span>
        </div>
      </div>
      <div v-if="scorecard?.failures.length" class="mb-3 space-y-1">
        <button
          v-for="failure in scorecard.failures"
          :key="`${failure.rule}-${failure.node ?? 'run'}`"
          class="w-full rounded bg-[var(--hr-danger-soft)] px-2 py-1.5 text-left hover:bg-[var(--hr-danger-soft)]"
          @click="openFailureEvidence(failure)"
        >
          <div class="truncate text-[11px] text-[var(--hr-danger)]">{{ failure.message }}</div>
          <div class="mt-0.5 truncate text-[10px] text-[var(--hr-danger)]">{{ failure.rule }}</div>
        </button>
      </div>
      <div v-else class="mb-3 text-[11px] text-[var(--hr-text-3)]">
        {{ scorecardLoading ? t('agent.progress.scorecardLoading') : scorecardError || t('agent.progress.scorecardClean') }}
      </div>

      <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
        <ShieldCheck class="h-3 w-3" />
        {{ t('agent.progress.workerEvidence') }}
      </div>
      <div class="grid grid-cols-2 gap-2 text-[11px]">
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.progress.toolCalls') }}</div>
          <div class="mt-0.5 text-[var(--hr-text-1)]">{{ toolTotals.toolUse }}</div>
        </div>
        <div class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5">
          <div class="text-[var(--hr-text-3)]">{{ t('agent.progress.toolResults') }}</div>
          <div class="mt-0.5 text-[var(--hr-text-1)]">{{ toolTotals.toolResult }}</div>
        </div>
      </div>
    </section>

    <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
      <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
        <Clock class="h-3 w-3" />
        {{ t('agent.progress.background') }}
      </div>
      <div class="text-[11px] text-[var(--hr-text-3)]">
        {{ auditLoading ? t('agent.progress.auditLoading') : auditError || t('agent.progress.backgroundQuiet') }}
      </div>
    </section>
  </div>
</template>

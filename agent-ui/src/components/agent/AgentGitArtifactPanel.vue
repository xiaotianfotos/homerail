<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  ScrollText,
} from 'lucide-vue-next'
import { getChange, getRun } from '@/api/agent'
import { getDagNodeChat } from '@/api/services/dag-api'
import type { DAGChatMessage } from '@/api/types/dag.types'
import { useAgentStore } from '@/stores/agent-store'
import { cn } from '@/lib/utils'

interface GitArtifactSummary {
  branch?: string
  baseBranch?: string
  changeTitle?: string
  prUrls: string[]
  issueUrls: string[]
  changedFiles: string[]
  reviewStatus: 'approved' | 'changes_requested' | 'unknown'
}

const store = useAgentStore()
const { t } = useI18n()

const loading = ref(false)
const error = ref<string | null>(null)
const summary = ref<GitArtifactSummary>(emptySummary())
let pollTimer: number | undefined

const primaryPrUrl = computed(() => summary.value.prUrls[0])
const primaryIssueUrl = computed(() => summary.value.issueUrls[0])

async function loadArtifacts(): Promise<void> {
  if (!store.currentRunId) {
    summary.value = emptySummary()
    return
  }
  loading.value = true
  error.value = null
  try {
    const runResponse = await getRun(store.currentRunId)
    const run = (runResponse as any)?.data ?? runResponse
    const chats = await Promise.all(store.nodes.map(node => (
      getDagNodeChat(store.currentRunId!, node.id).catch(() => [])
    )))
    const allMessages = chats.flat()
    const text = allMessages.map(messageText).join('\n')
    const change = await loadChange(run)

    summary.value = {
      branch: firstString(run?.git_branch, change?.git_branch, extractBranch(text)),
      baseBranch: firstString(run?.base_branch, change?.base_branch),
      changeTitle: firstString(change?.title, run?.change_title),
      prUrls: extractUrls(text, /https?:\/\/[^\s)>"']+\/pulls\/\d+/g),
      issueUrls: unique([
        ...extractUrls(text, /https?:\/\/[^\s)>"']+\/issues\/\d+/g),
        ...extractUrls(`${change?.description ?? ''}\n${change?.content ?? ''}`, /https?:\/\/[^\s)>"']+\/issues\/\d+/g),
      ]),
      changedFiles: extractChangedFiles(text),
      reviewStatus: inferReviewStatus(allMessages),
    }
  } catch (err) {
    summary.value = emptySummary()
    error.value = err instanceof Error ? err.message : t('agent.artifacts.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadChange(run: any): Promise<any | null> {
  const projectId = run?.project_id
  const changeId = run?.change_id
  if (!projectId || !changeId) return null
  try {
    const response = await getChange(projectId, changeId)
    return (response as any)?.data ?? null
  } catch {
    return null
  }
}

function emptySummary(): GitArtifactSummary {
  return {
    prUrls: [],
    issueUrls: [],
    changedFiles: [],
    reviewStatus: 'unknown',
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function messageText(message: DAGChatMessage): string {
  const parts = [
    message.content,
    message.tool_name,
    message.tool_input ? stringify(message.tool_input) : '',
    message.tool_result ? stringify(message.tool_result) : '',
  ]
  return parts.filter(Boolean).join('\n')
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractUrls(text: string, pattern: RegExp): string[] {
  return unique([...text.matchAll(pattern)].map(match => match[0].replace(/[.,;]+$/, '')))
}

function extractBranch(text: string): string | undefined {
  const patterns = [
    /branch\s+['"`]?([A-Za-z0-9._/-]+)['"`]?/i,
    /pushed\s+(?:to\s+)?['"`]?([A-Za-z0-9._/-]+)['"`]?/i,
    /head['"`]?\s*:\s*['"`]?([A-Za-z0-9._/-]+)['"`]?/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function extractChangedFiles(text: string): string[] {
  const files = new Set<string>()
  for (const line of text.split('\n')) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\//)
    const statusMatch = line.match(/^\s*(?:A|M|D|R\d*|C\d*)\s+(.+)$/)
    const changedMatch = line.match(/^\s*(?:modified|new file|deleted):\s+(.+)$/i)
    const value = diffMatch?.[1] ?? statusMatch?.[1] ?? changedMatch?.[1]
    if (value && looksLikePath(value)) files.add(value.trim())
    if (files.size >= 16) break
  }
  return [...files]
}

function looksLikePath(value: string): boolean {
  return /^[\w./-]+\.[A-Za-z0-9]+$/.test(value.trim()) && !value.includes('://')
}

function inferReviewStatus(messages: DAGChatMessage[]): GitArtifactSummary['reviewStatus'] {
  const reviewerText = messages
    .filter(message => /review/i.test(`${message.worker_id ?? ''} ${message.tool_name ?? ''} ${message.role}`) || /review/i.test(messageText(message)))
    .map(messageText)
    .join('\n')
    .toLowerCase()
  if (/\b(approved|approve|lgtm|pass|通过|同意合并)\b/.test(reviewerText)) return 'approved'
  if (/\b(changes requested|request changes|block|fail|失败|需要修改)\b/.test(reviewerText)) return 'changes_requested'
  return 'unknown'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function restartPolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = undefined
  if (store.currentRunId && store.isRunning) {
    pollTimer = window.setInterval(() => {
      void loadArtifacts()
    }, 10000)
  }
}

watch(() => store.currentRunId, () => {
  void loadArtifacts()
  restartPolling()
}, { immediate: true })

watch(() => store.nodes.map(node => `${node.id}:${node.status}`).join('|'), () => {
  void loadArtifacts()
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
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-text-1)]">
          <GitPullRequest class="h-3.5 w-3.5 text-[var(--hr-success)]" />
          {{ t('agent.artifacts.title') }}
        </div>
        <div v-if="loading" class="flex items-center gap-1 text-[10px] text-[var(--hr-text-3)]">
          <Loader2 class="h-3 w-3 animate-spin" />
          {{ t('agent.artifacts.loading') }}
        </div>
      </div>
      <div v-if="error" class="mt-2 rounded border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-2 py-1 text-[10px] text-[var(--hr-danger)]">
        {{ error }}
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <div class="space-y-3">
        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
            <GitBranch class="h-3 w-3" />
            {{ t('agent.artifacts.branch') }}
          </div>
          <div class="space-y-1 text-[11px]">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[var(--hr-text-3)]">{{ t('agent.artifacts.current') }}</span>
              <span class="truncate font-mono text-[var(--hr-text-1)]">{{ summary.branch || t('agent.artifacts.unavailable') }}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-[var(--hr-text-3)]">{{ t('agent.artifacts.base') }}</span>
              <span class="truncate font-mono text-[var(--hr-text-2)]">{{ summary.baseBranch || t('agent.artifacts.unavailable') }}</span>
            </div>
          </div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <GitPullRequest class="h-3 w-3" />
              {{ t('agent.artifacts.pullRequest') }}
            </div>
            <span
              :class="cn(
                'rounded-full px-2 py-0.5 text-[10px]',
                summary.reviewStatus === 'approved' ? 'bg-[var(--hr-success-soft)] text-[var(--hr-success)]' :
                summary.reviewStatus === 'changes_requested' ? 'bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]' :
                'bg-[var(--hr-surface-2)] text-[var(--hr-text-3)]'
              )"
            >
              {{ t(`agent.artifacts.review.${summary.reviewStatus}`) }}
            </span>
          </div>
          <a
            v-if="primaryPrUrl"
            :href="primaryPrUrl"
            target="_blank"
            rel="noreferrer"
            class="flex items-center gap-1.5 truncate text-[11px] text-[var(--hr-info)] hover:text-[var(--hr-info)]"
          >
            <ExternalLink class="h-3 w-3 flex-shrink-0" />
            <span class="truncate">{{ primaryPrUrl }}</span>
          </a>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.artifacts.noPullRequest') }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
            <MessageSquareText class="h-3 w-3" />
            {{ t('agent.artifacts.sourceIssue') }}
          </div>
          <a
            v-if="primaryIssueUrl"
            :href="primaryIssueUrl"
            target="_blank"
            rel="noreferrer"
            class="flex items-center gap-1.5 truncate text-[11px] text-[var(--hr-info)] hover:text-[var(--hr-info)]"
          >
            <ExternalLink class="h-3 w-3 flex-shrink-0" />
            <span class="truncate">{{ primaryIssueUrl }}</span>
          </a>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.artifacts.noIssue') }}</div>
          <div v-if="summary.changeTitle" class="mt-2 line-clamp-2 text-[11px] text-[var(--hr-text-2)]">
            {{ summary.changeTitle }}
          </div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <FileCode2 class="h-3 w-3" />
              {{ t('agent.artifacts.changedFiles') }}
            </div>
            <span class="text-[10px] text-[var(--hr-text-4)]">{{ summary.changedFiles.length }}</span>
          </div>
          <div v-if="summary.changedFiles.length" class="space-y-1">
            <div
              v-for="file in summary.changedFiles"
              :key="file"
              class="truncate rounded bg-[var(--hr-surface-2)] px-2 py-1 font-mono text-[10px] text-[var(--hr-text-1)]"
            >
              {{ file }}
            </div>
          </div>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.artifacts.noChangedFiles') }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
            <ScrollText class="h-3 w-3" />
            {{ t('agent.artifacts.moreLinks') }}
          </div>
          <div class="space-y-1">
            <a
              v-for="url in [...summary.prUrls.slice(1), ...summary.issueUrls.slice(1)]"
              :key="url"
              :href="url"
              target="_blank"
              rel="noreferrer"
              class="flex items-center gap-1.5 truncate text-[10px] text-[var(--hr-info)] hover:text-[var(--hr-info)]"
            >
              <ExternalLink class="h-3 w-3 flex-shrink-0" />
              <span class="truncate">{{ url }}</span>
            </a>
            <div v-if="summary.prUrls.length + summary.issueUrls.length <= 1" class="text-[11px] text-[var(--hr-text-4)]">
              {{ t('agent.artifacts.noMoreLinks') }}
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

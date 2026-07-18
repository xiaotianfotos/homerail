<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { managerChat, listProjects } from '@/api/agent'
import { getDagStatus } from '@/api/services/dag-api'
import { Send, Loader2, History, Mic } from 'lucide-vue-next'

const store = useAgentStore()
const { t } = useI18n()

const inputValue = ref('')
const isSending = ref(false)
const taskHints = computed(() => [
  t('shell.landing.hints.demo'),
  t('shell.landing.hints.projects'),
  t('shell.landing.hints.review'),
])

onMounted(async () => {
  void store.loadManagerRuntimeOptions()
  try {
    const res = await listProjects({ limit: 50 })
    const projects = res.data?.projects ?? []
    if (projects.length > 0 && !store.managerProjectId) {
      store.managerProjectId = projects[0].id
    }
  } catch { /* ignore */ }
})

async function send(): Promise<void> {
  const text = inputValue.value.trim()
  if (!text || isSending.value) return

  // Clear any previous session state, start fresh
  store.currentRunId = null
  store.dagExecution = null
  store.nodes = []
  store.edges = []
  store.selectedNodeId = null
  store.chatMessages = []

  store.addChatMessage({
    id: `user-${Date.now()}`,
    role: 'user',
    content: text,
    type: 'text',
    timestamp: new Date().toISOString(),
  })
  inputValue.value = ''
  isSending.value = true
  store.hasStarted = true
  store.resetWsStreamed()
  store.managerResponding = true

  try {
    const response = await managerChat({
      message: text,
      project_id: store.managerProjectId ?? undefined,
      session_id: store.managerSessionId ?? undefined,
      continue_chat: true,
    })

    const data = response.data

    if (data?.session_id) {
      store.managerSessionId = data.session_id
      // Refresh sidebar session list after creating a new session
      store.fetchManagerSessions()
    }

    // Streaming events via WS handle tool_calls/text rendering.
    // HTTP response is a fallback: only render if WS events didn't arrive.
    if (!store.hasWsStreamed()) {
      // No WS events received — render from HTTP response
      const toolCalls = data?.tool_calls ?? []
      for (const tc of toolCalls) {
        const toolName = (tc.name || '').replace(/^mcp__[^_]+__/, '')
        store.addChatMessage({
          id: `tool-${Date.now()}-${tc.tool_id}`,
          role: 'assistant',
          content: JSON.stringify(tc.input, null, 2),
          type: 'tool_call',
          timestamp: new Date().toISOString(),
          toolId: tc.tool_id,
          toolName,
          toolSummary: Object.keys(tc.input || {}).slice(0, 4).join(', '),
          status: 'pending',
        })
      }

      for (const tr of data?.tool_results ?? []) {
        const existing = store.chatMessages
          .slice()
          .reverse()
          .find(msg => msg.type === 'tool_call' && msg.toolId === tr.tool_id)
        if (existing) {
          existing.status = tr.is_error ? 'failed' : 'completed'
          existing.toolResult = String(tr.content || '')
        }
      }

      const assistantText = data?.text ?? ''
      if (assistantText) {
        store.addChatMessage({
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: assistantText,
          type: 'text',
          timestamp: new Date().toISOString(),
        })
      }

      let spawnedRunId: string | null | undefined = data?.run_id
      if (!spawnedRunId) {
        for (const tc of toolCalls) {
          if ((tc.name || '').endsWith('invoke_run') && tc.input?.run_id) {
            spawnedRunId = tc.input.run_id as string
            break
          }
        }
      }

      if (spawnedRunId) {
        store.setRunId(spawnedRunId)
        store.addChatMessage({
          id: `sys-run-${Date.now()}`,
          role: 'system',
          content: t('shell.chat.runStarted', { runId: spawnedRunId }),
          type: 'status',
          timestamp: new Date().toISOString(),
        })
        try {
          const dag = await getDagStatus(spawnedRunId)
          if (dag) store.setDagExecution(dag)
        } catch { /* ignore */ }
      }
    } else {
      // WS events already rendered — just handle run_id from HTTP
      if (data?.run_id && !store.currentRunId) {
        store.setRunId(data.run_id)
        try {
          const dag = await getDagStatus(data.run_id)
          if (dag) store.setDagExecution(dag)
        } catch { /* ignore */ }
      }
    }

    if (!response.success) {
      store.updateManagerSessionStatus(data?.session_id ?? store.managerSessionId, 'failed')
      store.addChatMessage({
        id: `assistant-error-${Date.now()}`,
        role: 'assistant',
        content: response.message || t('shell.chat.requestFailed'),
        type: 'text',
        timestamp: new Date().toISOString(),
      })
    } else {
      store.updateManagerSessionStatus(data?.session_id ?? store.managerSessionId, 'completed', data?.run_id ?? undefined)
    }
    if (store.managerProjectId) {
      window.setTimeout(() => { void store.fetchManagerSessions() }, 1200)
    }
  } catch (error: any) {
    store.updateManagerSessionStatus(store.managerSessionId, 'failed')
    store.addChatMessage({
      id: `assistant-error-${Date.now()}`,
      role: 'assistant',
      content: t('shell.chat.error', { message: error.message || t('shell.chat.requestFailed') }),
      type: 'text',
      timestamp: new Date().toISOString(),
    })
  } finally {
    isSending.value = false
    store.managerResponding = false
    if (store.managerProjectId) {
      window.setTimeout(() => { void store.fetchManagerSessions() }, 2500)
    }
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) return
  if ((event.ctrlKey && event.key === 'Enter') || (!event.shiftKey && event.key === 'Enter')) {
    event.preventDefault()
    if (!isSending.value) send()
  }
}

function handleProviderChange(event: Event): void {
  store.setManagerRuntime((event.target as HTMLSelectElement).value)
}

function handleModelChange(event: Event): void {
  store.setManagerRuntime(store.managerProviderName, (event.target as HTMLSelectElement).value)
}

function enterHistory(): void {
  store.hasStarted = true
  store.fetchManagerSessions()
}

function openVoiceCockpit(): void {
  store.hasStarted = true
  store.voiceCockpitOpen = true
}
</script>

<template>
  <div class="flex flex-col items-center justify-center h-screen bg-[var(--hr-bg)] px-4">
    <!-- Title -->
    <div class="text-center mb-10">
      <h1 class="text-4xl font-bold text-[var(--hr-text-1)] tracking-tight mb-2">
        HomeRail
      </h1>
      <p class="text-sm text-[var(--hr-text-3)]">
        {{ t('shell.landing.tagline') }}
      </p>
    </div>

    <!-- Input -->
    <div class="w-full max-w-[620px]">
      <div class="mb-2 flex items-center justify-end gap-2 text-xs">
        <span class="text-[var(--hr-text-4)]">Manager</span>
        <select
          :value="store.managerProviderName"
          class="h-8 rounded-md border border-[var(--hr-border)] bg-[var(--hr-bg-raised)] px-2 text-[var(--hr-text-2)] outline-none"
          :disabled="isSending || store.managerRuntimeLoading"
          @change="handleProviderChange"
        >
          <option
            v-for="provider in store.managerProviderOptions"
            :key="provider"
            :value="provider"
          >
            {{ store.managerProviderLabel(provider) }}
          </option>
        </select>
        <select
          v-model="store.managerModelName"
          class="h-8 rounded-md border border-[var(--hr-border)] bg-[var(--hr-bg-raised)] px-2 text-[var(--hr-text-2)] outline-none"
          :disabled="isSending || store.managerRuntimeLoading"
          @change="handleModelChange"
        >
          <option
            v-for="model in store.managerModelOptions"
            :key="model"
            :value="model"
          >
            {{ store.managerModelLabel(store.managerProviderName, model) }}
          </option>
        </select>
      </div>
      <div class="flex items-end gap-2 bg-[var(--hr-surface-1)] rounded-2xl border border-[var(--hr-border)] p-3">
        <textarea
          v-model="inputValue"
          class="flex-1 resize-none bg-transparent text-sm text-[var(--hr-text-1)] placeholder-[var(--hr-text-3)] outline-none max-h-32 min-h-[48px] py-2 px-2"
          :rows="2"
          :placeholder="t('shell.landing.placeholder')"
          :disabled="isSending"
          @keydown="handleKeyDown"
        />
        <button
          class="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
          :class="isSending
            ? 'bg-[var(--hr-surface-2)] text-[var(--hr-text-3)]'
            : 'bg-[var(--hr-accent)] text-[var(--hr-on-accent)] hover:opacity-85'"
          @click="isSending ? undefined : send()"
        >
          <Loader2 v-if="isSending" class="h-5 w-5 animate-spin" />
          <Send v-else class="h-5 w-5" />
        </button>
      </div>
      <button
        class="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-4 py-3 text-sm text-[var(--hr-accent)] transition hover:bg-[color-mix(in_srgb,var(--hr-accent)_15%,transparent)]"
        @click="openVoiceCockpit"
      >
        <Mic class="h-4 w-4" />
        {{ t('shell.landing.voiceCockpit') }}
      </button>
    </div>

    <!-- Suggestions -->
    <div class="flex flex-wrap gap-2 mt-6 max-w-[620px] justify-center">
      <button
        v-for="hint in taskHints"
        :key="hint"
        class="px-3 py-1.5 rounded-lg text-xs text-[var(--hr-text-3)] bg-[var(--hr-surface-1)] border border-[var(--hr-border)] hover:text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-2)] transition-colors"
        @click="inputValue = hint"
      >
        {{ hint }}
      </button>
    </div>

    <!-- History entry -->
    <button
      class="flex items-center gap-1.5 mt-6 text-xs text-[var(--hr-text-4)] hover:text-[var(--hr-text-3)] transition-colors"
      @click="enterHistory"
    >
      <History class="h-3.5 w-3.5" />
      {{ t('shell.landing.history') }}
    </button>
  </div>
</template>

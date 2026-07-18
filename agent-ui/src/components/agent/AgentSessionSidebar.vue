<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useAgentStore, type ManagerSessionItem } from '@/stores/agent-store'
import { useI18n } from 'vue-i18n'
import { cn } from '@/lib/utils'
import { listProjects } from '@/api/agent'
import {
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Trash2,
  GitBranch,
  Folder,
  Search,
  Settings,
} from 'lucide-vue-next'

const store = useAgentStore()
const { t } = useI18n()

const projectOpen = ref(false)
const projects = ref<Array<{ id: string; name: string; description?: string }>>([])

onMounted(async () => {
  try {
    const res = await listProjects({ limit: 50 })
    projects.value = res.data?.projects ?? []
    if (projects.value.length > 0 && !store.managerProjectId) {
      store.setManagerProjectId(projects.value[0].id)
    }
  } catch {
    projects.value = []
  }
  if (store.managerProjectId) {
    store.fetchManagerSessions()
  }
})

watch(() => store.managerProjectId, (pid) => {
  if (pid) store.fetchManagerSessions()
})

const selectedProject = () =>
  projects.value.find(p => p.id === store.managerProjectId)

function statusIcon(status: string) {
  switch (status) {
    case 'running': return Loader2
    case 'completed': return CheckCircle2
    case 'failed': return XCircle
    default: return MessageSquare
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'text-[var(--hr-info)]'
    case 'completed': return 'text-[var(--hr-success)]'
    case 'failed': return 'text-[var(--hr-danger)]'
    default: return 'text-[var(--hr-text-3)]'
  }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('shell.sidebar.justNow')
  if (mins < 60) return t('shell.sidebar.minutesAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('shell.sidebar.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('shell.sidebar.daysAgo', { count: days })
}

function sessionLabel(s: ManagerSessionItem): string {
  if (s.prompt) {
    const first = s.prompt.split('\n')[0]
    return first.length > 40 ? first.slice(0, 40) + '...' : first
  }
  return s.session_id.slice(-8)
}

function selectSessionItem(s: ManagerSessionItem): void {
  if (s.session_id === store.managerSessionId) return
  store.selectSession(s.session_id)
}

function selectRun(runId: string): void {
  if (runId === store.currentRunId) return
  store.switchToRun(runId, store.managerProjectId ?? undefined)
}

function newSession(): void {
  store.startNewSession()
}

function openSettings(): void {
  store.settingsPageOpen = true
}

async function handleDelete(s: ManagerSessionItem, e: MouseEvent): Promise<void> {
  e.stopPropagation()
  await store.deleteSession(s.session_id)
}

const collapsed = () => store.sidebarCollapsed
const toggle = () => store.sidebarCollapsed = !store.sidebarCollapsed
</script>

<template>
  <div
    class="agent-session-sidebar flex h-full flex-col border-r border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-1)] transition-all duration-200"
    :class="collapsed() ? 'w-14' : 'w-[292px]'"
  >
    <template v-if="collapsed()">
      <div class="flex h-full flex-col items-center py-4">
        <button class="mb-3 rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" @click="toggle">
          <PanelLeftOpen class="h-4 w-4" />
        </button>
        <button class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" :title="t('agent.sidebar.newSession')" @click="newSession">
          <Plus class="h-4 w-4" />
        </button>
        <div class="mt-3 flex flex-1 flex-col items-center gap-1 overflow-hidden">
          <button
            v-for="s in store.managerSessions.slice(0, 10)"
            :key="s.session_id"
            :class="cn(
              'rounded-full p-2 transition-colors',
              s.session_id === store.managerSessionId ? 'bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]' : 'text-[var(--hr-text-3)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]'
            )"
            :title="sessionLabel(s)"
            @click="selectSessionItem(s)"
          >
            <component :is="statusIcon(s.status)" :class="cn('h-4 w-4', s.status === 'running' && 'animate-spin')" />
          </button>
        </div>
        <button class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" :title="t('shell.settings')" @click="openSettings">
          <Settings class="h-4 w-4" />
        </button>
      </div>
    </template>

    <template v-else>
      <div class="flex h-16 flex-shrink-0 items-center justify-between px-4">
        <div>
          <div class="text-[11px] uppercase tracking-[0.22em] text-[var(--hr-text-3)]">Agent</div>
          <div class="mt-1 text-lg font-semibold text-[var(--hr-text-1)]">{{ t('shell.sidebar.history') }}</div>
        </div>
        <div class="flex items-center gap-2">
          <button class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" @click="toggle">
            <PanelLeftClose class="h-4 w-4" />
          </button>
          <button class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" @click="newSession">
            <Plus class="h-4 w-4" />
          </button>
        </div>
      </div>

      <div class="space-y-2 px-4">
        <button
          class="flex w-full items-center gap-2 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2.5 text-sm text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-2)]"
          @click="newSession"
        >
          <MessageSquare class="h-4 w-4 text-[var(--hr-accent)]" />
          {{ t('shell.sidebar.newChat') }}
        </button>
        <div class="relative">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--hr-text-4)]" />
          <input
            v-model="store.sidebarSearch"
            type="text"
            :placeholder="t('shell.sidebar.search')"
            class="h-10 w-full rounded-full border border-[var(--hr-border)] bg-[var(--hr-surface-1)] pl-9 pr-3 text-sm text-[var(--hr-text-1)] outline-none placeholder:text-[var(--hr-text-4)] hover:bg-[var(--hr-surface-2)] focus:border-[var(--hr-border-strong)]"
          />
        </div>
      </div>

      <div class="mt-6 px-4">
        <div class="mb-2 px-1 text-xs text-[var(--hr-text-3)]">{{ t('shell.sidebar.projects') }}</div>
        <div class="relative">
          <button
            class="flex w-full items-center gap-2 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2.5 text-sm text-[var(--hr-text-2)] hover:border-[var(--hr-border-strong)] hover:bg-[var(--hr-surface-2)]"
            @click="projectOpen = !projectOpen"
          >
            <Folder class="h-4 w-4 flex-shrink-0 text-[var(--hr-accent)]" />
            <span class="flex-1 truncate text-left">{{ selectedProject()?.name ?? t('agent.sidebar.selectProject') }}</span>
            <span v-if="store.managerProjectId" class="h-2 w-2 rounded-full bg-[var(--hr-success)]" />
          </button>

          <div v-if="projectOpen" class="fixed inset-0 z-10" @click="projectOpen = false" />
          <div
            v-if="projectOpen"
            class="absolute left-0 right-0 top-full z-20 mt-2 max-h-56 overflow-y-auto rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-panel)] py-1 shadow-2xl"
          >
            <div v-if="projects.length === 0" class="px-3 py-2 text-xs text-[var(--hr-text-3)]">
              {{ t('agent.sidebar.noProjects') }}
            </div>
            <button
              v-for="p in projects"
              :key="p.id"
              :class="cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                store.managerProjectId === p.id ? 'bg-[var(--hr-accent-soft)] text-[var(--hr-text-1)]' : 'text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]'
              )"
              @click="store.setManagerProjectId(p.id); projectOpen = false"
            >
              <Folder class="h-3.5 w-3.5 flex-shrink-0" />
              <span class="truncate">{{ p.name }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="mt-6 px-4">
        <div class="mb-2 px-1 text-xs text-[var(--hr-text-3)]">{{ t('shell.sidebar.conversations') }}</div>
      </div>

      <div class="flex-1 overflow-y-auto px-4 pb-4">
        <div
          v-for="s in store.filteredSessions"
          :key="s.session_id"
          :class="cn(
            'group rounded-2xl border transition-colors',
            s.session_id === store.managerSessionId ? 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)]' : 'border-transparent hover:border-[var(--hr-border)] hover:bg-[var(--hr-surface-1)]'
          )"
        >
          <button class="w-full px-2.5 py-2 text-left" @click="selectSessionItem(s)">
            <div class="flex items-center gap-2">
              <component
                :is="statusIcon(s.status)"
                :class="cn('h-3.5 w-3.5 flex-shrink-0', statusColor(s.status), s.status === 'running' && 'animate-spin')"
              />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm text-[var(--hr-text-1)]">{{ sessionLabel(s) }}</div>
              </div>
              <span class="text-xs text-[var(--hr-text-4)]">{{ timeAgo(s.start_time) }}</span>
              <button
                class="rounded-full p-1 text-[var(--hr-text-4)] opacity-0 transition-all hover:bg-[var(--hr-danger-soft)] hover:text-[var(--hr-danger)] group-hover:opacity-100"
                :title="t('agent.sidebar.delete')"
                @click="handleDelete(s, $event)"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </button>

          <div v-if="s.run_ids?.length && s.session_id === store.managerSessionId" class="space-y-1 px-3 pb-2">
            <button
              v-for="rid in s.run_ids"
              :key="rid"
              :class="cn(
                'flex w-full items-center gap-1.5 rounded-xl px-2 py-1.5 text-xs transition-colors',
                rid === store.currentRunId ? 'bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]' : 'text-[var(--hr-text-3)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-2)]'
              )"
              @click="selectRun(rid)"
            >
              <GitBranch class="h-3 w-3 flex-shrink-0" />
              <span class="truncate font-mono">{{ rid.slice(-8) }}</span>
            </button>
          </div>
        </div>

        <div v-if="store.sessionsLoading" class="flex items-center justify-center py-6">
          <Loader2 class="h-4 w-4 animate-spin text-[var(--hr-text-3)]" />
        </div>
        <div v-if="!store.sessionsLoading && store.managerSessions.length === 0" class="rounded-2xl border border-[var(--hr-border)] px-3 py-4 text-center text-xs text-[var(--hr-text-4)]">
          {{ t('agent.sidebar.empty') }}
        </div>
        <div v-if="!store.sessionsLoading && store.managerSessions.length > 0 && store.filteredSessions.length === 0" class="rounded-2xl border border-[var(--hr-border)] px-3 py-4 text-center text-xs text-[var(--hr-text-4)]">
          {{ t('agent.sidebar.noMatch') }}
        </div>
      </div>

      <div class="flex-shrink-0 px-4 pb-4">
        <button
          class="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-sm text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
          @click="openSettings"
        >
          <Settings class="h-4 w-4 text-[var(--hr-text-2)]" />
          {{ t('shell.settings') }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-session-sidebar {
  --sidebar-radius: 20px;
  --sidebar-radius-large: 24px;
}

.agent-session-sidebar :deep(button),
.agent-session-sidebar :deep(input) {
  border-radius: var(--sidebar-radius);
}

.agent-session-sidebar :deep(input) {
  min-height: 42px;
}

.agent-session-sidebar :deep([role="button"]),
.agent-session-sidebar :deep(.group) {
  border-radius: var(--sidebar-radius-large);
}
</style>

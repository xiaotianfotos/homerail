<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Folder,
  GitBranch,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
  XCircle
} from 'lucide-vue-next'
import {
  deleteProject,
  listGitServerRepos,
  listGitServers,
  listProjects,
  updateProject,
  listVoiceSessions,
  closeVoiceSession,
  type VoiceSessionItem
} from '@/api/agent'
import type { Project } from '@/api/types/project.types'
import type { GitRepositoryInfo, GitServer } from '@/api/types/infrastructure.types'
import { useAgentStore } from '@/stores/agent-store'
import { cn } from '@/lib/utils'
import VoiceDirectoryProjectModal from './VoiceDirectoryProjectModal.vue'

const props = defineProps<{
  activeSessionId?: string | null
}>()

const emit = defineEmits<{
  projectSelected: [projectId: string]
  sessionSelected: [sessionId: string]
  sessionDeleted: [sessionId: string]
  newSession: []
  collapse: []
}>()

const store = useAgentStore()
const { t } = useI18n()
const projects = ref<Project[]>([])
const loadingProjects = ref(false)
const projectQuery = ref('')
const createOpen = ref(false)
const editingProject = ref<Project | null>(null)
const editName = ref('')
const editDescription = ref('')
const editWorkspacePath = ref('')
const gitServers = ref<GitServer[]>([])
const selectedGitServerId = ref<string | null>(null)
const selectedRepoFullName = ref<string | null>(null)
const availableRepos = ref<GitRepositoryInfo[]>([])
const loadingRepos = ref(false)
const savingProject = ref(false)
const deletingProjectId = ref<string | null>(null)
const deletingSessionId = ref<string | null>(null)
const confirmDeleteProjectId = ref<string | null>(null)
const confirmDeleteSessionId = ref<string | null>(null)
const voiceSessions = ref<VoiceSessionItem[]>([])
const voiceSessionsLoading = ref(false)
const expandedProjectIds = ref<Set<string>>(new Set())
const gamepadFocusedItemId = ref('')

type GamepadSidebarItem =
  | { id: string; kind: 'project'; project: Project }
  | { id: string; kind: 'new-session'; project: Project }
  | { id: string; kind: 'session'; project: Project; session: VoiceSessionItem }
  | { id: string; kind: 'toggle-sessions'; project: Project }

const filteredProjects = computed(() => {
  const q = projectQuery.value.trim().toLowerCase()
  if (!q) return projects.value
  return projects.value.filter(project => {
    const path = projectPath(project).toLowerCase()
    const sessionMatches = (sessionsByProject.value.get(project.id) ?? []).some(session =>
      sessionLabel(session).toLowerCase().includes(q)
    )
    return project.name.toLowerCase().includes(q) || path.includes(q) || sessionMatches
  })
})

const sessionsByProject = computed(() => {
  const grouped = new Map<string, VoiceSessionItem[]>()
  for (const session of voiceSessions.value) {
    const projectId = session.project_id || ''
    if (!projectId) continue
    const sessions = grouped.get(projectId) ?? []
    sessions.push(session)
    grouped.set(projectId, sessions)
  }
  for (const sessions of grouped.values()) {
    sessions.sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
  }
  return grouped
})

const gamepadSidebarItems = computed<GamepadSidebarItem[]>(() => {
  const items: GamepadSidebarItem[] = []
  for (const project of filteredProjects.value) {
    items.push({ id: projectGamepadId(project), kind: 'project', project })
    if (project.id === store.managerProjectId) {
      items.push({ id: newSessionGamepadId(project), kind: 'new-session', project })
    }
    for (const session of visibleProjectSessions(project)) {
      items.push({ id: sessionGamepadId(session), kind: 'session', project, session })
    }
    if (hiddenProjectSessionCount(project)) {
      items.push({ id: toggleSessionsGamepadId(project), kind: 'toggle-sessions', project })
    }
  }
  return items
})

onMounted(() => {
  void loadProjects()
  void loadVoiceSessions()
  document.addEventListener('click', closeDeleteConfirmOnOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeDeleteConfirmOnOutside)
})

function closeDeleteConfirmOnOutside(event: MouseEvent): void {
  if (!confirmDeleteProjectId.value && !confirmDeleteSessionId.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-project-delete-confirm]')) return
  if (target?.closest('[data-session-delete-confirm]')) return
  confirmDeleteProjectId.value = null
  confirmDeleteSessionId.value = null
}

watch(
  () => store.managerProjectId,
  () => {
    void loadVoiceSessions()
  }
)

watch(
  () => gamepadSidebarItems.value.map(item => item.id).join('|'),
  () => {
    if (!gamepadFocusedItemId.value) return
    if (!gamepadSidebarItems.value.some(item => item.id === gamepadFocusedItemId.value)) {
      gamepadFocusedItemId.value = ''
    }
  }
)

async function loadProjects(): Promise<void> {
  loadingProjects.value = true
  try {
    const res = await listProjects({ limit: 80 })
    projects.value = res.data?.projects ?? []
    if (!store.managerProjectId && projects.value[0]) {
      store.setManagerProjectId(projects.value[0].id)
    }
  } catch {
    projects.value = []
  } finally {
    loadingProjects.value = false
  }
}

async function loadVoiceSessions(): Promise<void> {
  voiceSessionsLoading.value = true
  try {
    const res = await listVoiceSessions(null, 160)
    voiceSessions.value = res.data?.sessions ?? []
  } catch {
    voiceSessions.value = []
  } finally {
    voiceSessionsLoading.value = false
  }
}

function projectPath(project: Project): string {
  return String(
    project.workspace_path ||
      project.metadata?.workspace_path ||
      project.metadata?.project_root ||
      project.git_repo_name ||
      project.git_repository ||
      ''
  )
}

function selectProject(project: Project): void {
  if (project.id === store.managerProjectId) return
  store.setManagerProjectId(project.id)
  emit('projectSelected', project.id)
}

function projectSessions(project: Project): VoiceSessionItem[] {
  return sessionsByProject.value.get(project.id) ?? []
}

function visibleProjectSessions(project: Project): VoiceSessionItem[] {
  const sessions = projectSessions(project)
  return expandedProjectIds.value.has(project.id) ? sessions : sessions.slice(0, 2)
}

function hiddenProjectSessionCount(project: Project): number {
  return Math.max(0, projectSessions(project).length - 2)
}

function toggleProjectSessions(project: Project, event?: Event): void {
  event?.stopPropagation()
  const next = new Set(expandedProjectIds.value)
  if (next.has(project.id)) next.delete(project.id)
  else next.add(project.id)
  expandedProjectIds.value = next
}

function projectGamepadId(project: Project): string {
  return `project:${project.id}`
}

function newSessionGamepadId(project: Project): string {
  return `new-session:${project.id}`
}

function sessionGamepadId(session: VoiceSessionItem): string {
  return `session:${session.session_id}`
}

function toggleSessionsGamepadId(project: Project): string {
  return `toggle-sessions:${project.id}`
}

function isGamepadFocused(itemId: string): boolean {
  return gamepadFocusedItemId.value === itemId
}

function ensureGamepadFocus(): void {
  const items = gamepadSidebarItems.value
  if (!items.length) {
    gamepadFocusedItemId.value = ''
    return
  }
  if (items.some(item => item.id === gamepadFocusedItemId.value)) {
    scrollFocusedGamepadItemIntoView()
    return
  }
  const activeSessionItem = props.activeSessionId
    ? items.find(
        item => item.kind === 'session' && item.session.session_id === props.activeSessionId
      )
    : null
  const activeProjectItem = items.find(
    item => item.kind === 'project' && item.project.id === store.managerProjectId
  )
  gamepadFocusedItemId.value = (activeSessionItem || activeProjectItem || items[0]).id
  scrollFocusedGamepadItemIntoView()
}

function focusNextGamepadItem(delta: number): void {
  const items = gamepadSidebarItems.value
  if (!items.length) return
  const currentIndex = items.findIndex(item => item.id === gamepadFocusedItemId.value)
  const nextIndex =
    currentIndex >= 0
      ? (currentIndex + delta + items.length) % items.length
      : delta < 0
        ? items.length - 1
        : 0
  gamepadFocusedItemId.value = items[nextIndex]?.id || ''
  scrollFocusedGamepadItemIntoView()
}

function confirmFocusedGamepadItem(): void {
  ensureGamepadFocus()
  const item = gamepadSidebarItems.value.find(
    candidate => candidate.id === gamepadFocusedItemId.value
  )
  if (!item) return
  if (item.kind === 'project') selectProject(item.project)
  else if (item.kind === 'new-session') emit('newSession')
  else if (item.kind === 'session') selectSession(item.session)
  else if (item.kind === 'toggle-sessions') toggleProjectSessions(item.project)
}

function toggleFocusedProjectSessions(): void {
  ensureGamepadFocus()
  const item = gamepadSidebarItems.value.find(
    candidate => candidate.id === gamepadFocusedItemId.value
  )
  if (!item) return
  toggleProjectSessions(item.project)
}

function scrollFocusedGamepadItemIntoView(): void {
  const itemId = gamepadFocusedItemId.value
  if (!itemId || typeof document === 'undefined') return
  void nextTick(() => {
    const selector = `[data-gamepad-sidebar-id="${cssEscape(itemId)}"]`
    document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'nearest' })
  })
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function openProjectSettings(project: Project, event: Event): void {
  event.stopPropagation()
  editingProject.value = project
  editName.value = project.name
  editDescription.value = project.description || ''
  editWorkspacePath.value = projectPath(project)
  selectedGitServerId.value = project.git_server_id || null
  selectedRepoFullName.value = project.git_repo_name || project.git_repository || null
  void loadGitServers(project.git_server_id || null, project.git_repo_name || project.git_repository || null)
}

function closeProjectSettings(): void {
  editingProject.value = null
  editName.value = ''
  editDescription.value = ''
  editWorkspacePath.value = ''
  selectedGitServerId.value = null
  selectedRepoFullName.value = null
  availableRepos.value = []
}

async function loadGitServers(serverId: string | null, repoName: string | null): Promise<void> {
  const res = await listGitServers(true)
  gitServers.value = (res.data?.servers ?? []).filter(server => server.is_active)
  if (serverId) await loadRepos(serverId, repoName)
}

async function loadRepos(serverId: string, repoName: string | null = null): Promise<void> {
  loadingRepos.value = true
  try {
    const res = await listGitServerRepos(serverId, 1, 100)
    availableRepos.value = res.data?.repositories ?? []
    if (repoName && availableRepos.value.some(repo => repo.full_name === repoName)) {
      selectedRepoFullName.value = repoName
    }
  } finally {
    loadingRepos.value = false
  }
}

async function handleGitServerChange(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  selectedGitServerId.value = value || null
  selectedRepoFullName.value = null
  availableRepos.value = []
  if (selectedGitServerId.value) await loadRepos(selectedGitServerId.value)
}

async function saveProjectSettings(): Promise<void> {
  const project = editingProject.value
  if (!project || !editName.value.trim()) return
  savingProject.value = true
  try {
    const updatePayload: Record<string, any> = {
      name: editName.value.trim(),
      description: editDescription.value.trim(),
      workspace_path: editWorkspacePath.value.trim()
    }
    if (selectedGitServerId.value) {
      updatePayload.git_server_id = selectedGitServerId.value
      if (selectedRepoFullName.value) {
        const [owner, ...repoParts] = selectedRepoFullName.value.split('/')
        const repo = repoParts.join('/')
        updatePayload.git_repository = selectedRepoFullName.value
        updatePayload.git_owner = owner
        updatePayload.git_repo_name = repo || selectedRepoFullName.value
      }
    } else {
      updatePayload.git_server_id = null
      updatePayload.git_owner = null
      updatePayload.git_repo_name = null
      updatePayload.git_repository = null
    }
    const res = await updateProject(project.id, updatePayload)
    if (res.data) {
      projects.value = projects.value.map(item => (item.id === project.id ? res.data : item))
    }
    closeProjectSettings()
  } finally {
    savingProject.value = false
  }
}

function openProjectDeleteConfirm(project: Project, event: Event): void {
  event.stopPropagation()
  if (deletingProjectId.value) return
  confirmDeleteSessionId.value = null
  confirmDeleteProjectId.value = project.id
}

function cancelProjectDelete(): void {
  confirmDeleteProjectId.value = null
}

async function confirmProjectDelete(project: Project): Promise<void> {
  if (deletingProjectId.value) return
  deletingProjectId.value = project.id
  try {
    await deleteProject(project.id)
    projects.value = projects.value.filter(item => item.id !== project.id)
    if (store.managerProjectId === project.id) {
      const next = projects.value[0]
      store.setManagerProjectId(next?.id ?? null)
      if (next) emit('projectSelected', next.id)
    }
  } finally {
    deletingProjectId.value = null
    confirmDeleteProjectId.value = null
  }
}

function openSessionDeleteConfirm(session: VoiceSessionItem, event: Event): void {
  event.stopPropagation()
  if (deletingSessionId.value) return
  confirmDeleteProjectId.value = null
  confirmDeleteSessionId.value = session.session_id
}

function cancelSessionDelete(): void {
  confirmDeleteSessionId.value = null
}

async function confirmSessionDelete(session: VoiceSessionItem): Promise<void> {
  if (deletingSessionId.value) return
  deletingSessionId.value = session.session_id
  try {
    await closeVoiceSession(session.session_id)
    voiceSessions.value = voiceSessions.value.filter(item => item.session_id !== session.session_id)
    emit('sessionDeleted', session.session_id)
  } finally {
    deletingSessionId.value = null
    confirmDeleteSessionId.value = null
  }
}

async function handleCreated(project: Project): Promise<void> {
  await loadProjects()
  await loadVoiceSessions()
  store.setManagerProjectId(project.id)
  emit('projectSelected', project.id)
}

function sessionTimestamp(session: VoiceSessionItem): number {
  const raw = session.start_time || session.end_time || ''
  const value = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(value) ? value : 0
}

function statusIcon(status: string) {
  switch (status) {
    case 'running':
      return Loader2
    case 'completed':
      return CheckCircle2
    case 'failed':
      return XCircle
    default:
      return MessageSquare
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return 'text-cyan-200'
    case 'completed':
      return 'text-emerald-300'
    case 'failed':
      return 'text-red-300'
    default:
      return 'text-white/35'
  }
}

function timeAgo(dateStr: string | null | undefined): string {
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

function sessionLabel(session: VoiceSessionItem): string {
  const raw = String(session.title || session.prompt || '').trim()
  if (!raw) return t('voice.sidebar.newSession')
  const firstSentence = raw.split(/[。！？!?；;\r\n]/)[0]?.trim() || raw
  return firstSentence.length > 8 ? `${firstSentence.slice(0, 8)}...` : firstSentence
}

function sessionTitle(session: VoiceSessionItem): string {
  return String(session.title || session.prompt || t('voice.sidebar.newSession')).trim() || t('voice.sidebar.newSession')
}

function selectSession(session: VoiceSessionItem): void {
  emit('sessionSelected', session.session_id)
}

function selectRun(runId: string): void {
  void store.switchToRun(runId, store.managerProjectId ?? undefined)
}

async function refresh(): Promise<void> {
  await Promise.all([loadProjects(), loadVoiceSessions()])
}

defineExpose({
  focusNextGamepadItem,
  confirmFocusedGamepadItem,
  toggleFocusedProjectSessions,
  ensureGamepadFocus,
  refresh
})
</script>

<template>
  <aside
    class="voice-left-rail flex h-full min-h-0 w-[292px] shrink-0 flex-col border-r border-cyan-200/10 bg-black/20 px-4 py-5"
  >
    <div class="mb-4 flex items-center justify-between">
      <div class="min-w-0">
        <div class="truncate text-xl font-semibold text-white">{{ t('voice.sidebar.workspace') }}</div>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="rounded-full border border-cyan-200/15 p-2 text-cyan-100/70 hover:bg-cyan-200/10 hover:text-white"
          :title="t('voice.sidebar.collapse')"
          @click="emit('collapse')"
        >
          <PanelLeftClose class="h-4 w-4" />
        </button>
        <button
          class="rounded-full border border-cyan-200/15 p-2 text-cyan-100/70 hover:bg-cyan-200/10 hover:text-white"
          :title="t('voice.sidebar.addDirectory')"
          @click="createOpen = true"
        >
          <Plus class="h-4 w-4" />
        </button>
      </div>
    </div>

    <div class="relative mb-4">
      <Search
        class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
      />
      <input
        v-model="projectQuery"
        class="h-10 w-full rounded-full border border-white/10 bg-white/[0.035] pl-9 pr-3 text-sm text-white/80 outline-none placeholder:text-white/30 focus:border-cyan-200/35"
        :placeholder="t('voice.sidebar.search')"
      />
    </div>

    <section class="flex min-h-0 flex-1 flex-col">
      <div class="mb-2 flex items-center justify-between px-1 text-xs text-white/40">
        <span>{{ t('voice.sidebar.directories') }}</span>
        <Loader2 v-if="loadingProjects || voiceSessionsLoading" class="h-3.5 w-3.5 animate-spin" />
      </div>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div v-for="project in filteredProjects" :key="project.id" class="group rounded-2xl">
          <div
            :class="
              cn(
                'relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2.5 pr-16 text-left transition',
                isGamepadFocused(projectGamepadId(project)) &&
                  'voice-session-sidebar__gamepad-focus',
                project.id === store.managerProjectId
                  ? 'border-cyan-200/35 bg-cyan-200/12 text-white'
                  : 'border-transparent text-white/62 hover:border-cyan-200/15 hover:bg-white/[0.045] hover:text-white'
              )
            "
            :data-gamepad-sidebar-id="projectGamepadId(project)"
            role="button"
            tabindex="0"
            @click="selectProject(project)"
            @keydown.enter.prevent="selectProject(project)"
          >
            <Folder class="h-4 w-4 shrink-0 text-cyan-200/65" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ project.name }}</div>
              <div class="mt-0.5 truncate text-[11px] text-white/35">
                {{ projectPath(project) || project.id }}
              </div>
            </div>
            <div
              class="absolute right-2 top-2 flex opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <button
                class="rounded-full p-1.5 text-cyan-50/45 hover:bg-cyan-200/10 hover:text-cyan-100"
                :title="t('voice.sidebar.configureDirectory')"
                @click="openProjectSettings(project, $event)"
              >
                <Settings class="h-3.5 w-3.5" />
              </button>
              <button
                class="rounded-full p-1.5 text-cyan-50/35 hover:bg-red-400/10 hover:text-red-200 disabled:opacity-45"
                :class="confirmDeleteProjectId === project.id ? 'bg-red-400/10 text-red-200 opacity-100' : ''"
                :title="t('voice.sidebar.deleteDirectory')"
                :disabled="deletingProjectId === project.id"
                @click="openProjectDeleteConfirm(project, $event)"
              >
                <Loader2 v-if="deletingProjectId === project.id" class="h-3.5 w-3.5 animate-spin" />
                <Trash2 v-else class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div
            v-if="confirmDeleteProjectId === project.id"
            data-project-delete-confirm
            class="mt-2 rounded-2xl border border-red-300/20 bg-[#170d10]/95 p-4 text-white shadow-xl shadow-black/25"
            @click.stop
          >
            <div class="flex items-start gap-3">
              <div class="mt-0.5 rounded-full bg-red-400/15 p-2 text-red-200">
                <Trash2 class="h-4 w-4" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-semibold text-white">{{ t('voice.sidebar.removeDirectoryConfirm', { name: project.name }) }}</div>
                <div class="mt-1 break-all font-mono text-xs text-white/42">
                  {{ projectPath(project) || project.id }}
                </div>
                <div class="mt-3 space-y-1.5 text-xs leading-relaxed text-white/58">
                  <p>{{ t('voice.sidebar.removeDirectoryOnly') }}</p>
                  <p>{{ t('voice.sidebar.removeDirectoryKeepsData') }}</p>
                  <p>{{ t('voice.sidebar.removeDirectoryKeepsDag') }}</p>
                </div>
              </div>
            </div>
            <div class="mt-4 flex gap-2">
              <button
                class="flex-1 rounded-full bg-red-500/20 px-4 py-2 text-sm font-medium text-red-100 transition hover:bg-red-500/30 disabled:opacity-45"
                :disabled="deletingProjectId === project.id"
                @click.stop="confirmProjectDelete(project)"
              >
                <Loader2
                  v-if="deletingProjectId === project.id"
                  class="mr-1 inline h-3.5 w-3.5 animate-spin"
                />
                {{ t('voice.sidebar.removeReference') }}
              </button>
              <button
                class="flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/68 transition hover:bg-white/[0.08]"
                @click.stop="cancelProjectDelete"
              >
                {{ t('settings.actions.cancel') }}
              </button>
            </div>
          </div>

          <div class="ml-7 mt-1 space-y-1">
            <button
              v-if="project.id === store.managerProjectId"
              :class="
                cn(
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-cyan-100/58 transition hover:bg-cyan-200/10 hover:text-cyan-50',
                  isGamepadFocused(newSessionGamepadId(project)) &&
                    'voice-session-sidebar__gamepad-focus'
                )
              "
              :data-gamepad-sidebar-id="newSessionGamepadId(project)"
              @click="emit('newSession')"
            >
              <Plus class="h-3.5 w-3.5" />
              {{ t('voice.sidebar.newSession') }}
            </button>
            <div
              v-for="session in visibleProjectSessions(project)"
              :key="session.session_id"
              :class="
                cn(
                  'group/session relative flex items-center rounded-2xl border transition',
                  isGamepadFocused(sessionGamepadId(session)) &&
                    'voice-session-sidebar__gamepad-focus',
                  session.session_id === props.activeSessionId
                    ? 'border-cyan-200/25 bg-cyan-200/10'
                    : 'border-transparent hover:border-white/10 hover:bg-white/[0.04]'
                )
              "
              :data-gamepad-sidebar-id="sessionGamepadId(session)"
            >
              <button
                class="flex w-full min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
                :title="sessionTitle(session)"
                @click="selectSession(session)"
              >
                <component
                  :is="statusIcon(session.status)"
                  :class="
                    cn(
                      'h-3.5 w-3.5 shrink-0',
                      statusColor(session.status),
                      session.status === 'running' && 'animate-spin'
                    )
                  "
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm text-white/76">{{ sessionLabel(session) }}</div>
                </div>
                <span class="shrink-0 text-xs text-white/35">{{
                  timeAgo(session.start_time)
                }}</span>
              </button>
              <button
                class="shrink-0 rounded-full p-1.5 text-white/30 transition hover:bg-red-400/10 hover:text-red-200 group-hover/session:opacity-100 disabled:opacity-45"
                :class="confirmDeleteSessionId === session.session_id ? 'opacity-100' : 'opacity-0'"
                :title="t('voice.sidebar.deleteSession')"
                :disabled="deletingSessionId === session.session_id"
                @click="openSessionDeleteConfirm(session, $event)"
              >
                <Loader2
                  v-if="deletingSessionId === session.session_id"
                  class="h-3.5 w-3.5 animate-spin"
                />
                <Trash2 v-else class="h-3.5 w-3.5" />
              </button>
              <div
                v-if="confirmDeleteSessionId === session.session_id"
                data-session-delete-confirm
                class="absolute right-0 top-full z-30 mt-1 w-48 rounded-2xl border border-cyan-200/15 bg-black/40 p-3 backdrop-blur-md"
              >
                <p class="pb-2.5 text-xs leading-relaxed text-white/55">
                  {{ t('voice.sidebar.deleteSessionConfirm') }}
                </p>
                <div class="flex gap-2">
                  <button
                    class="flex-1 rounded-full bg-red-500/20 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-500/30 disabled:opacity-45"
                    :disabled="deletingSessionId === session.session_id"
                    @click.stop="confirmSessionDelete(session)"
                  >
                    <Loader2
                      v-if="deletingSessionId === session.session_id"
                      class="mr-1 inline h-3 w-3 animate-spin"
                    />
                    {{ t('voice.sidebar.delete') }}
                  </button>
                  <button
                    class="flex-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/[0.08]"
                    @click.stop="cancelSessionDelete"
                  >
                    {{ t('settings.actions.cancel') }}
                  </button>
                </div>
              </div>
              <div
                v-if="session.run_ids?.length && session.session_id === props.activeSessionId"
                class="space-y-1 px-4 pb-2"
              >
                <button
                  v-for="runId in session.run_ids"
                  :key="runId"
                  :class="
                    cn(
                      'flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-xs transition',
                      runId === store.currentRunId
                        ? 'bg-cyan-200/12 text-cyan-100'
                        : 'text-white/40 hover:bg-white/10 hover:text-white/70'
                    )
                  "
                  @click="selectRun(runId)"
                >
                  <GitBranch class="h-3 w-3" />
                  <span class="truncate font-mono">{{ runId.slice(-10) }}</span>
                </button>
              </div>
            </div>
            <button
              v-if="hiddenProjectSessionCount(project)"
              :class="
                cn(
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-white/42 transition hover:bg-white/[0.045] hover:text-white/70',
                  isGamepadFocused(toggleSessionsGamepadId(project)) &&
                    'voice-session-sidebar__gamepad-focus'
                )
              "
              :data-gamepad-sidebar-id="toggleSessionsGamepadId(project)"
              @click="toggleProjectSessions(project, $event)"
            >
              <ChevronDown
                class="h-3.5 w-3.5 transition-transform"
                :class="expandedProjectIds.has(project.id) ? 'rotate-180' : ''"
              />
              {{ expandedProjectIds.has(project.id) ? t('voice.sidebar.collapseSessions') : t('voice.sidebar.expandSessions') }}
              <span v-if="!expandedProjectIds.has(project.id)"
                >({{ hiddenProjectSessionCount(project) }})</span
              >
            </button>
            <div
              v-if="!voiceSessionsLoading && !projectSessions(project).length"
              class="px-3 py-2 text-xs text-white/28"
            >
              {{ t('voice.sidebar.directoryEmpty') }}
            </div>
          </div>
        </div>
        <div
          v-if="!loadingProjects && !filteredProjects.length"
          class="rounded-2xl border border-white/10 p-4 text-center text-xs text-white/35"
        >
          {{ t('voice.sidebar.noDirectories') }}
        </div>
      </div>
    </section>
  </aside>

  <VoiceDirectoryProjectModal v-model:open="createOpen" @created="handleCreated" />

  <div
    v-if="editingProject"
    class="fixed inset-0 z-[75] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
  >
    <section
      class="w-[min(520px,92vw)] rounded-[24px] border border-cyan-200/15 bg-[#0b1518] p-5 text-white shadow-2xl"
    >
      <div class="mb-5 flex items-start justify-between gap-4">
        <div>
          <div class="text-xs tracking-[0.18em] text-cyan-200/45">{{ t('voice.sidebar.directories') }}</div>
          <h2 class="mt-1 text-xl font-semibold">{{ t('voice.project.configuration') }}</h2>
        </div>
        <button
          class="rounded-full p-2 text-white/45 hover:bg-white/10 hover:text-white"
          @click="closeProjectSettings"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <label class="mb-1 block text-xs text-white/45">{{ t('voice.project.name') }}</label>
      <input
        v-model="editName"
        class="mb-3 h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm outline-none focus:border-cyan-200/45"
        :placeholder="t('voice.project.namePlaceholder')"
      />

      <label class="mb-1 block text-xs text-white/45">{{ t('voice.project.description') }}</label>
      <textarea
        v-model="editDescription"
        class="mb-3 h-20 w-full resize-none rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none focus:border-cyan-200/45"
        :placeholder="t('voice.project.optional')"
      />

      <label class="mb-1 block text-xs text-white/45">{{ t('voice.project.path') }}</label>
      <input
        v-model="editWorkspacePath"
        class="mb-2 h-10 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 font-mono text-sm outline-none focus:border-cyan-200/45"
        placeholder="/path/to/directory"
      />
      <div class="mb-5 text-xs text-white/35">
        {{ t('voice.project.contextHint') }}
      </div>

      <div class="mb-5 rounded-2xl border border-white/10 bg-white/[0.025] p-3">
        <div class="mb-3 flex items-center gap-2 text-sm font-medium text-white/80">
          <GitBranch class="h-4 w-4 text-cyan-200/70" />
          {{ t('voice.project.gitRepository') }}
        </div>
        <label class="mb-1 block text-xs text-white/45">Git Token</label>
        <select
          :value="selectedGitServerId || ''"
          class="mb-3 h-10 w-full rounded-xl border border-white/10 bg-[#0f1a1d] px-3 text-sm text-white/80 outline-none focus:border-cyan-200/45"
          @change="handleGitServerChange"
        >
          <option value="">{{ t('voice.project.noGitToken') }}</option>
          <option
            v-for="server in gitServers"
            :key="server.server_id"
            :value="server.server_id"
            :disabled="!server.token_valid"
          >
            {{ server.name }} · {{ server.platform_type
            }}{{ server.token_valid ? '' : ` · ${t('voice.project.invalidToken')}` }}
          </option>
        </select>

        <label class="mb-1 block text-xs text-white/45">{{ t('voice.project.repository') }}</label>
        <select
          v-model="selectedRepoFullName"
          class="h-10 w-full rounded-xl border border-white/10 bg-[#0f1a1d] px-3 text-sm text-white/80 outline-none focus:border-cyan-200/45 disabled:opacity-45"
          :disabled="!selectedGitServerId || loadingRepos"
        >
          <option :value="null">{{ loadingRepos ? t('voice.project.loadingRepositories') : t('voice.project.noRepository') }}</option>
          <option v-for="repo in availableRepos" :key="repo.full_name" :value="repo.full_name">
            {{ repo.full_name }}
          </option>
        </select>
        <div class="mt-2 text-xs text-white/35">
          {{ t('voice.project.gitHint') }}
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <button
          class="rounded-full px-4 py-2 text-sm text-white/55 hover:bg-white/10 hover:text-white"
          @click="closeProjectSettings"
        >
          {{ t('settings.actions.cancel') }}
        </button>
        <button
          class="flex items-center gap-2 rounded-full bg-cyan-300 px-4 py-2 text-sm font-medium text-black hover:bg-cyan-200 disabled:opacity-45"
          :disabled="savingProject || !editName.trim()"
          @click="saveProjectSettings"
        >
          <Loader2 v-if="savingProject" class="h-4 w-4 animate-spin" />
          <Check v-else class="h-4 w-4" />
          {{ t('settings.actions.save') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.voice-session-sidebar__gamepad-focus {
  outline: 2px solid rgba(103, 232, 249, 0.88);
  outline-offset: 2px;
  box-shadow:
    0 0 0 1px rgba(34, 211, 238, 0.18),
    0 0 22px rgba(34, 211, 238, 0.16);
}
</style>

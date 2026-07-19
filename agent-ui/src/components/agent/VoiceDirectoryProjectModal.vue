<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronLeft, CornerUpLeft, Folder, FolderOpen, GitBranch, Loader2, Server, X } from 'lucide-vue-next'
import {
  browseProjectDirectories,
  createProject,
  listGitServerRepos,
  listGitServers,
  listProjectDirectoryRoots,
} from '@/api/agent'
import type {
  CreateProjectRequest,
  Project,
  ProjectDirectoryEntry,
  ProjectDirectoryRoot,
  ProjectDirectoryServer,
} from '@/api/types/project.types'
import type { GitRepositoryInfo, GitServer } from '@/api/types/infrastructure.types'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  created: [project: Project]
}>()

const { t } = useI18n()

const servers = ref<ProjectDirectoryServer[]>([])
const roots = ref<ProjectDirectoryRoot[]>([])
const entries = ref<ProjectDirectoryEntry[]>([])
const serverId = ref('manager')
const currentPath = ref('')
const pathInput = ref('')
const parentPath = ref<string | null>(null)
const pathWritable = ref(false)
const pathIsGitRepo = ref(false)
const projectName = ref('')
const projectNameAuto = ref(true)
const description = ref('')
const showHidden = ref(false)
const loading = ref(false)
const creating = ref(false)
const error = ref('')
const gitServers = ref<GitServer[]>([])
const gitServersLoading = ref(false)
const selectedGitServerId = ref('')
const selectedRepoFullName = ref('')
const availableRepos = ref<GitRepositoryInfo[]>([])
const loadingRepos = ref(false)
const gitError = ref('')

const selectedServer = computed(() => servers.value.find(item => item.id === serverId.value))
const canCreate = computed(() => currentPath.value.trim() && projectName.value.trim() && !creating.value)

watch(() => props.open, (open) => {
  if (open) {
    void loadRoots()
    void loadGitServers()
  }
  else reset()
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  emit('update:open', false)
}

function reset(): void {
  entries.value = []
  currentPath.value = ''
  pathInput.value = ''
  parentPath.value = null
  pathWritable.value = false
  pathIsGitRepo.value = false
  error.value = ''
  projectName.value = ''
  projectNameAuto.value = true
  description.value = ''
  showHidden.value = false
  selectedGitServerId.value = ''
  selectedRepoFullName.value = ''
  availableRepos.value = []
  gitError.value = ''
}

function inferName(path: string): string {
  const clean = path.replace(/[\\/]+$/g, '')
  const last = clean.split(/[\\/]/).filter(Boolean).pop()
  if (last && !/^[A-Za-z]:$/.test(last)) return last
  if (/^[A-Za-z]:$/.test(last || clean)) return `${(last || clean).slice(0, 1).toUpperCase()} Drive`
  return 'Untitled Directory'
}

async function loadRoots(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await listProjectDirectoryRoots()
    servers.value = res.data?.servers ?? []
    roots.value = res.data?.roots ?? []
    serverId.value = servers.value[0]?.id || 'manager'
    const path = res.data?.default_path || roots.value[0]?.path || ''
    if (path) await browse(path)
  } catch (err: any) {
    error.value = err?.message || t('voice.directoryPicker.rootLoadFailed')
  } finally {
    loading.value = false
  }
}

async function loadGitServers(): Promise<void> {
  gitServersLoading.value = true
  gitError.value = ''
  try {
    const res = await listGitServers(true)
    gitServers.value = (res.data?.servers ?? []).filter(server => server.is_active)
  } catch (err: any) {
    gitServers.value = []
    gitError.value = err?.message || t('voice.directoryPicker.gitServerLoadFailed')
  } finally {
    gitServersLoading.value = false
  }
}

async function loadRepos(serverId: string): Promise<void> {
  loadingRepos.value = true
  gitError.value = ''
  try {
    const res = await listGitServerRepos(serverId, 1, 100)
    availableRepos.value = res.data?.repositories ?? []
  } catch (err: any) {
    availableRepos.value = []
    gitError.value = err?.message || t('voice.directoryPicker.repositoryLoadFailed')
  } finally {
    loadingRepos.value = false
  }
}

async function handleGitServerChange(event: Event): Promise<void> {
  selectedGitServerId.value = (event.target as HTMLSelectElement).value
  selectedRepoFullName.value = ''
  availableRepos.value = []
  if (selectedGitServerId.value) await loadRepos(selectedGitServerId.value)
}

async function browse(path: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await browseProjectDirectories({
      path,
      server_id: serverId.value,
      show_hidden: showHidden.value,
      limit: 300,
    })
    currentPath.value = res.data?.path || path
    pathInput.value = currentPath.value
    parentPath.value = res.data?.parent ?? null
    pathWritable.value = Boolean(res.data?.writable)
    pathIsGitRepo.value = Boolean(res.data?.is_git_repo)
    entries.value = res.data?.entries ?? []
    if (projectNameAuto.value || !projectName.value.trim()) {
      projectName.value = inferName(currentPath.value)
      projectNameAuto.value = true
    }
  } catch (err: any) {
    error.value = err?.message || t('voice.directoryPicker.browseFailed')
  } finally {
    loading.value = false
  }
}

async function submitPathInput(): Promise<void> {
  const next = pathInput.value.trim()
  if (!next || next === currentPath.value || loading.value) return
  await browse(next)
}

async function toggleHidden(event: Event): Promise<void> {
  showHidden.value = (event.target as HTMLInputElement).checked
  if (currentPath.value) await browse(currentPath.value)
}

async function handleCreate(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  error.value = ''
  try {
    const payload: CreateProjectRequest = {
      name: projectName.value.trim(),
      description: description.value.trim() || undefined,
      project_root: currentPath.value,
      workspace_path: currentPath.value,
      metadata: {
        workspace_path: currentPath.value,
        project_root: currentPath.value,
        directory_source: serverId.value,
      },
    }
    if (selectedGitServerId.value) {
      payload.git_server_id = selectedGitServerId.value
      if (selectedRepoFullName.value) {
        const [owner, ...repoParts] = selectedRepoFullName.value.split('/')
        const repo = repoParts.join('/')
        payload.git_repository = selectedRepoFullName.value
        if (owner && repo) {
          payload.git_owner = owner
          payload.git_repo_name = repo
        } else {
          payload.git_repo_name = selectedRepoFullName.value
        }
      }
    }
    const res = await createProject(payload)
    emit('created', res.data)
    emit('update:open', false)
  } catch (err: any) {
    error.value = err?.message || t('voice.directoryPicker.createFailed')
  } finally {
    creating.value = false
  }
}

function handleProjectNameInput(event: Event): void {
  projectName.value = (event.target as HTMLInputElement).value
  projectNameAuto.value = !projectName.value.trim()
}
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--hr-overlay)] px-6 backdrop-blur-sm">
    <section class="flex h-[min(720px,82vh)] w-[min(980px,92vw)] overflow-hidden rounded-[24px] border border-[var(--hr-border-strong)] bg-[var(--hr-panel)] text-[var(--hr-text-1)]" :style="{ boxShadow: 'var(--hr-shadow-floating)' }">
      <aside class="flex w-64 shrink-0 flex-col border-r border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-4">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <div class="text-xs tracking-[0.18em] text-[var(--hr-accent)]">{{ t('voice.sidebar.directories') }}</div>
            <div class="mt-1 text-lg font-semibold">{{ t('voice.directoryPicker.select') }}</div>
          </div>
          <button class="rounded-full p-2 text-[var(--hr-text-3)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]" @click="$emit('update:open', false)">
            <X class="h-4 w-4" />
          </button>
        </div>

        <label class="mb-2 text-xs text-[var(--hr-text-3)]">{{ t('voice.directoryPicker.server') }}</label>
        <div class="mb-4 flex items-center gap-2 rounded-xl border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 py-2">
          <Server class="h-4 w-4 text-[var(--hr-accent)]" />
          <select v-model="serverId" class="min-w-0 flex-1 bg-transparent text-sm text-[var(--hr-text-1)] outline-none">
            <option v-for="server in servers" :key="server.id" :value="server.id" class="bg-[var(--hr-bg-raised)] text-[var(--hr-text-1)]">
              {{ server.name }}
            </option>
          </select>
        </div>
        <div class="mb-3 text-xs text-[var(--hr-text-4)]">
          {{ selectedServer?.kind || 'manager' }} · {{ selectedServer?.can_browse ? t('voice.directoryPicker.browsable') : t('voice.directoryPicker.notBrowsable') }}
        </div>

        <div v-if="roots.length" class="min-h-0 flex-1" data-testid="voice-directory-existing-projects">
          <div class="mb-2 text-xs text-[var(--hr-text-3)]">{{ t('voice.directoryPicker.existingProjects') }}</div>
          <div class="space-y-1 overflow-y-auto">
            <button
              v-for="root in roots"
              :key="root.id"
              data-testid="voice-directory-project-root"
              class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
              @click="browse(root.path)"
            >
              <Folder class="h-4 w-4 shrink-0 text-[var(--hr-accent)]" />
              <span class="min-w-0 flex-1 truncate">{{ root.name }}</span>
            </button>
          </div>
        </div>
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <header class="flex shrink-0 items-center gap-3 border-b border-[var(--hr-border)] px-5 py-4">
          <button
            class="flex items-center gap-2 rounded-full border border-[var(--hr-border)] px-3 py-2 text-sm text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)] disabled:opacity-35"
            :disabled="!parentPath || loading"
            :title="t('voice.directoryPicker.parentTitle')"
            @click="parentPath && browse(parentPath)"
          >
            <ChevronLeft class="h-4 w-4" />
            {{ t('voice.directoryPicker.parent') }}
          </button>
          <input
            v-model="pathInput"
            class="min-w-0 flex-1 rounded-xl border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 py-2 font-mono text-sm text-[var(--hr-accent)] outline-none focus:border-[var(--hr-accent-border)]"
            :placeholder="currentPath || t('voice.directoryPicker.pathPlaceholder')"
            :disabled="loading"
            spellcheck="false"
            @keydown.enter.prevent="submitPathInput"
            @blur="submitPathInput"
          />
          <label class="flex items-center gap-2 rounded-full border border-[var(--hr-border)] px-3 py-2 text-xs text-[var(--hr-text-3)]">
            <input :checked="showHidden" type="checkbox" class="accent-cyan-300" @change="toggleHidden" />
            {{ t('voice.directoryPicker.hidden') }}
          </label>
        </header>

        <main class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
          <div class="min-h-0 overflow-y-auto p-4">
            <div v-if="loading" class="flex h-full items-center justify-center text-[var(--hr-text-3)]">
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
              {{ t('voice.directoryPicker.loading') }}
            </div>
            <div v-else-if="error" class="rounded-2xl border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] p-4 text-sm text-[var(--hr-danger)]">
              {{ error }}
            </div>
            <div v-else class="space-y-1.5">
              <button
                v-if="parentPath"
                class="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-3 py-2.5 text-left hover:border-[var(--hr-accent-border)] hover:bg-[var(--hr-accent-soft)]"
                :title="t('voice.directoryPicker.parentTitle')"
                @click="browse(parentPath)"
              >
                <CornerUpLeft class="h-4 w-4 shrink-0 text-[var(--hr-accent)]" />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold text-[var(--hr-accent)]">{{ t('voice.directoryPicker.parentDirectory') }}</div>
                  <div class="mt-0.5 break-all font-mono text-[10px] leading-4 text-[var(--hr-text-4)]">{{ parentPath }}</div>
                </div>
              </button>
              <button
                v-for="entry in entries"
                :key="entry.path"
                class="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2.5 text-left hover:border-[var(--hr-accent-border)] hover:bg-[var(--hr-accent-soft)]"
                @click="browse(entry.path)"
              >
                <FolderOpen class="h-4 w-4 shrink-0 text-[var(--hr-accent)]" />
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <div class="min-w-0 flex-1 break-all text-sm leading-5 text-[var(--hr-text-1)] group-hover:text-[var(--hr-text-1)]">{{ entry.name }}</div>
                  <div class="flex shrink-0 gap-2 text-[10px] text-[var(--hr-text-4)]">
                    <span v-if="entry.is_git_repo">git</span>
                    <span>{{ entry.writable ? 'writable' : 'read only' }}</span>
                  </div>
                </div>
              </button>
            </div>
          </div>

          <aside class="overflow-y-auto border-l border-[var(--hr-border)] bg-[var(--hr-control)] p-5">
            <div class="mb-4">
              <div class="text-xs tracking-[0.18em] text-[var(--hr-accent)]">{{ t('voice.directoryPicker.add') }}</div>
              <h2 class="mt-1 text-xl font-semibold">{{ t('voice.directoryPicker.newDirectory') }}</h2>
            </div>
            <label class="mb-1 block text-xs text-[var(--hr-text-3)]">{{ t('voice.project.namePlaceholder') }}</label>
            <input
              :value="projectName"
              class="mb-3 h-10 w-full rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
              :placeholder="t('voice.project.namePlaceholder')"
              @input="handleProjectNameInput"
            />
            <label class="mb-1 block text-xs text-[var(--hr-text-3)]">{{ t('voice.project.description') }}</label>
            <textarea
              v-model="description"
              class="mb-4 h-24 w-full resize-none rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2 text-sm outline-none focus:border-[var(--hr-accent-border)]"
              :placeholder="t('voice.project.optional')"
            />
            <div class="mb-4 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3 text-xs text-[var(--hr-text-3)]">
              <div class="mb-1 text-[var(--hr-text-2)]">{{ t('voice.directoryPicker.currentDirectory') }}</div>
              <div class="break-all font-mono">{{ currentPath }}</div>
              <div class="mt-2 flex gap-2">
                <span>{{ pathWritable ? t('voice.directoryPicker.writable') : t('voice.directoryPicker.readOnly') }}</span>
                <span v-if="pathIsGitRepo">{{ t('voice.directoryPicker.gitRepository') }}</span>
              </div>
            </div>
            <div class="mb-4 rounded-2xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
              <div class="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--hr-text-1)]">
                <GitBranch class="h-4 w-4 text-[var(--hr-accent)]" />
                Git Token
              </div>
              <label class="mb-1 block text-xs text-[var(--hr-text-3)]">Gitea / Git Server</label>
              <select
                :value="selectedGitServerId"
                class="mb-3 h-10 w-full rounded-xl border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm text-[var(--hr-text-1)] outline-none focus:border-[var(--hr-accent-border)] disabled:opacity-45"
                :disabled="gitServersLoading"
                data-testid="voice-directory-create-git-server"
                @change="handleGitServerChange"
              >
                <option value="">{{ gitServersLoading ? t('voice.directoryPicker.loadingGitServers') : t('voice.project.noGitToken') }}</option>
                <option
                  v-for="server in gitServers"
                  :key="server.server_id"
                  :value="server.server_id"
                  :disabled="!server.token_valid"
                >
                  {{ server.name }} · {{ server.platform_type }}{{ server.token_valid ? '' : ` · ${t('voice.project.invalidToken')}` }}
                </option>
              </select>

              <label class="mb-1 block text-xs text-[var(--hr-text-3)]">{{ t('voice.project.repository') }}</label>
              <select
                v-model="selectedRepoFullName"
                class="h-10 w-full rounded-xl border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm text-[var(--hr-text-1)] outline-none focus:border-[var(--hr-accent-border)] disabled:opacity-45"
                :disabled="!selectedGitServerId || loadingRepos"
                data-testid="voice-directory-create-git-repo"
              >
                <option value="">{{ loadingRepos ? t('voice.project.loadingRepositories') : t('voice.project.noRepository') }}</option>
                <option v-for="repo in availableRepos" :key="repo.full_name" :value="repo.full_name">
                  {{ repo.full_name }}
                </option>
              </select>
              <div v-if="gitError" class="mt-2 text-xs text-[var(--hr-danger)]">{{ gitError }}</div>
              <div v-else class="mt-2 text-xs text-[var(--hr-text-4)]">
                {{ t('voice.directoryPicker.tokenHint') }}
              </div>
            </div>
            <button
              class="sticky bottom-0 z-10 mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--hr-accent)] font-medium text-[var(--hr-on-accent)] shadow-[var(--hr-shadow-panel)] transition hover:bg-[var(--hr-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              :disabled="!canCreate"
              @click="handleCreate"
            >
              <Loader2 v-if="creating" class="h-4 w-4 animate-spin" />
              <Check v-else class="h-4 w-4" />
              {{ t('voice.sidebar.addDirectory') }}
            </button>
          </aside>
        </main>
      </div>
    </section>
  </div>
</template>

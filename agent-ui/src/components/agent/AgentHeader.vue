<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import { listProjects } from '@/api/agent'
import { cn } from '@/lib/utils'
import { Terminal, Folder, ChevronDown } from 'lucide-vue-next'

const store = useAgentStore()
const { t } = useI18n()
const projectOpen = ref(false)
const projects = ref<Array<{ id: string; name: string; description?: string }>>([])

onMounted(async () => {
  try {
    const res = await listProjects({ limit: 50 })
    projects.value = res.data?.projects ?? []
    if (projects.value.length > 0 && !store.managerProjectId) {
      store.managerProjectId = projects.value[0].id
    }
  } catch {
    projects.value = []
  }
})

const selectedProject = () =>
  projects.value.find(p => p.id === store.managerProjectId)
</script>

<template>
  <div class="flex items-center justify-between px-4 py-2.5 border-b border-[var(--hr-border)] bg-[var(--hr-panel)] flex-shrink-0">
    <div class="flex items-center gap-3">
      <div class="flex items-center gap-2">
        <Terminal class="h-4 w-4 text-[var(--hr-accent)]" />
        <h1 class="text-sm font-semibold text-[var(--hr-text-1)] tracking-wide">HomeRail Workspace</h1>
      </div>

      <div class="relative">
        <button
          :class="cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
            store.managerProjectId
              ? 'text-[var(--hr-text-1)] bg-[var(--hr-surface-2)]'
              : 'text-[var(--hr-text-3)] hover:text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-2)]'
          )"
          @click="projectOpen = !projectOpen"
        >
          <Folder class="h-3 w-3" />
          <span class="max-w-[120px] truncate">
            {{ selectedProject()?.name ?? t('shell.header.selectProject') }}
          </span>
          <ChevronDown class="h-3 w-3" />
        </button>

        <div v-if="projectOpen" class="fixed inset-0 z-10" @click="projectOpen = false" />
        <div
          v-if="projectOpen"
          class="absolute top-full left-0 mt-1 w-56 max-h-64 overflow-y-auto bg-[var(--hr-bg-raised)] border border-[var(--hr-border)] rounded-lg shadow-xl z-20 py-1"
        >
          <div v-if="projects.length === 0" class="px-3 py-2 text-xs text-[var(--hr-text-3)]">{{ t('shell.header.noProjects') }}</div>
          <button
            v-for="p in projects"
            :key="p.id"
            :class="cn(
              'w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2',
              store.managerProjectId === p.id
                ? 'bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]'
                : 'text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]'
            )"
            @click="store.managerProjectId = p.id; projectOpen = false"
          >
            <Folder class="h-3 w-3 flex-shrink-0" />
            <div class="min-w-0">
              <div class="truncate font-medium">{{ p.name }}</div>
              <div v-if="p.description" class="truncate text-[10px] opacity-60">{{ p.description }}</div>
            </div>
          </button>
        </div>
      </div>
    </div>

    <div class="text-xs text-[var(--hr-text-4)]">
      {{ store.currentRunId ? store.currentRunId.slice(-8) : '' }}
    </div>
  </div>
</template>

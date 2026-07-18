<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  Server,
  Settings,
} from 'lucide-vue-next'
import { http } from '@/api/clients/http-client'
import { listGitServers, listProviders, verifyGitServer } from '@/api/agent'
import { listLLMSettings } from '@/api/services/llm-settings-api'
import { useAgentStore } from '@/stores/agent-store'
import type { GitServer } from '@/api/types/infrastructure.types'
import type { Provider } from '@/api/types/orchestration-v2.types'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import { cn } from '@/lib/utils'

const { t } = useI18n()
const store = useAgentStore()

const loading = ref(false)
const healthLoading = ref(false)
const verifyLoading = ref<string | null>(null)
const error = ref<string | null>(null)
const health = ref<'unknown' | 'healthy' | 'failed'>('unknown')
const gitServers = ref<GitServer[]>([])
const providers = ref<Provider[]>([])
const llmSettings = ref<LLMSetting[]>([])

const apiBaseUrl = computed(() => http.getBaseURL())
const activeModels = computed(() => llmSettings.value.filter(setting => setting.is_active))

async function loadSettings(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [gitResponse, providerResponse, settingsResponse] = await Promise.all([
      listGitServers(false).catch(() => null),
      listProviders().catch(() => null),
      listLLMSettings().catch(() => null),
    ])
    gitServers.value = (gitResponse as any)?.data?.servers ?? []
    providers.value = (providerResponse as any)?.data?.providers ?? []
    llmSettings.value = (settingsResponse as any)?.data?.settings ?? []
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('agent.settings.loadFailed')
  } finally {
    loading.value = false
  }
}

async function checkHealth(): Promise<void> {
  healthLoading.value = true
  try {
    const response = await fetch(`${apiBaseUrl.value}/health`)
    health.value = response.ok ? 'healthy' : 'failed'
  } catch {
    health.value = 'failed'
  } finally {
    healthLoading.value = false
  }
}

async function verifyServer(server: GitServer): Promise<void> {
  verifyLoading.value = server.server_id
  try {
    const result = await verifyGitServer(server.server_id)
    server.token_valid = Boolean((result as any)?.data?.valid)
    server.last_verified = new Date().toISOString()
  } catch {
    server.token_valid = false
  } finally {
    verifyLoading.value = null
  }
}

function masked(value?: string | null): string {
  if (!value) return t('agent.settings.unavailable')
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

function healthClass(value: 'unknown' | 'healthy' | 'failed'): string {
  if (value === 'healthy') return 'bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
  if (value === 'failed') return 'bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'
  return 'bg-[var(--hr-surface-2)] text-[var(--hr-text-3)]'
}

onMounted(() => {
  void store.loadManagerRuntimeOptions()
  void loadSettings()
  void checkHealth()
})

function handleManagerProviderChange(event: Event): void {
  store.setManagerRuntime((event.target as HTMLSelectElement).value)
}

function handleManagerModelChange(event: Event): void {
  store.setManagerRuntime(store.managerProviderName, (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex-shrink-0 border-b border-[var(--hr-border)] px-3 py-2">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 text-[11px] font-medium text-[var(--hr-text-1)]">
          <Settings class="h-3.5 w-3.5 text-[var(--hr-accent)]" />
          {{ t('agent.settings.title') }}
        </div>
        <button
          class="rounded p-1 text-[var(--hr-text-3)] hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
          :title="t('agent.settings.refresh')"
          @click="loadSettings(); checkHealth()"
        >
          <Loader2 v-if="loading || healthLoading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
        </button>
      </div>
      <div v-if="error" class="mt-2 rounded border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-2 py-1 text-[10px] text-[var(--hr-danger)]">
        {{ error }}
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <div class="space-y-3">
        <section class="rounded-md border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-accent)]">
              <Settings class="h-3 w-3" />
              Manager runtime
            </div>
            <span class="text-[10px] text-[var(--hr-text-2)]">{{ store.managerRuntimeLabel }}</span>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <select
              :value="store.managerProviderName"
              class="h-8 rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 text-[11px] text-[var(--hr-text-1)] outline-none"
              :disabled="store.managerRuntimeLoading"
              @change="handleManagerProviderChange"
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
              class="h-8 rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 text-[11px] text-[var(--hr-text-1)] outline-none"
              :disabled="store.managerRuntimeLoading"
              @change="handleManagerModelChange"
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
          <div class="mt-2 text-[10px] leading-relaxed text-[var(--hr-text-3)]">
            New Manager sessions use this runtime. Changing it while a session is selected starts a forked session on the next message.
          </div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <Server class="h-3 w-3" />
              {{ t('agent.settings.managerApi') }}
            </div>
            <span :class="cn('rounded-full px-2 py-0.5 text-[10px]', healthClass(health))">
              {{ t(`agent.settings.health.${health}`) }}
            </span>
          </div>
          <div class="truncate font-mono text-[11px] text-[var(--hr-text-1)]">{{ apiBaseUrl }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <GitBranch class="h-3 w-3" />
              {{ t('agent.settings.gitServers') }}
            </div>
            <span class="text-[10px] text-[var(--hr-text-4)]">{{ gitServers.length }}</span>
          </div>
          <div v-if="gitServers.length" class="space-y-2">
            <div
              v-for="server in gitServers"
              :key="server.server_id"
              class="rounded bg-[var(--hr-surface-2)] p-2"
            >
              <div class="mb-1 flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="truncate text-[11px] font-medium text-[var(--hr-text-1)]">{{ server.name }}</div>
                  <div class="truncate text-[10px] text-[var(--hr-text-4)]">{{ server.platform_type }} · {{ server.api_endpoint }}</div>
                </div>
                <button
                  class="rounded border border-[var(--hr-border)] px-2 py-1 text-[10px] text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-2)]"
                  @click="verifyServer(server)"
                >
                  <Loader2 v-if="verifyLoading === server.server_id" class="inline h-3 w-3 animate-spin" />
                  <span v-else>{{ t('agent.settings.verify') }}</span>
                </button>
              </div>
              <div class="flex items-center justify-between gap-2 text-[10px]">
                <span class="text-[var(--hr-text-3)]">{{ masked(server.git_user_name) }} / {{ masked(server.git_user_email) }}</span>
                <span :class="server.token_valid ? 'text-[var(--hr-success)]' : 'text-[var(--hr-danger)]'">
                  <CheckCircle2 v-if="server.token_valid" class="mr-1 inline h-3 w-3" />
                  <AlertCircle v-else class="mr-1 inline h-3 w-3" />
                  {{ server.token_valid ? t('agent.settings.valid') : t('agent.settings.invalid') }}
                </span>
              </div>
            </div>
          </div>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.settings.noGitServers') }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <Server class="h-3 w-3" />
              {{ t('agent.settings.providers') }}
            </div>
            <span class="text-[10px] text-[var(--hr-text-4)]">{{ providers.length }}</span>
          </div>
          <div v-if="providers.length" class="space-y-1.5">
            <div
              v-for="provider in providers"
              :key="provider.id"
              class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-[11px] text-[var(--hr-text-1)]">{{ provider.name }}</span>
                <span :class="provider.is_active ? 'text-[var(--hr-success)]' : 'text-[var(--hr-text-4)]'" class="text-[10px]">
                  {{ provider.is_active ? t('agent.settings.active') : t('agent.settings.inactive') }}
                </span>
              </div>
              <div class="mt-0.5 truncate text-[10px] text-[var(--hr-text-4)]">{{ provider.base_url }}</div>
            </div>
          </div>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.settings.noProviders') }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] p-3">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 text-[10px] text-[var(--hr-text-3)]">
              <Server class="h-3 w-3" />
              {{ t('agent.settings.models') }}
            </div>
            <span class="text-[10px] text-[var(--hr-text-4)]">{{ activeModels.length }}/{{ llmSettings.length }}</span>
          </div>
          <div v-if="activeModels.length" class="space-y-1.5">
            <div
              v-for="setting in activeModels.slice(0, 8)"
              :key="setting.id"
              class="rounded bg-[var(--hr-surface-2)] px-2 py-1.5"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-[11px] text-[var(--hr-text-1)]">{{ setting.display_name || setting.model_name }}</span>
                <span class="text-[10px] text-[var(--hr-text-3)]">{{ setting.provider_name }}</span>
              </div>
              <div class="mt-0.5 truncate text-[10px] text-[var(--hr-text-4)]">{{ setting.model_name }} · {{ setting.api_key_display || '••••' }}</div>
            </div>
          </div>
          <div v-else class="text-[11px] text-[var(--hr-text-4)]">{{ t('agent.settings.noModels') }}</div>
        </section>

        <section class="rounded-md border border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] p-3">
          <div class="mb-1 text-[11px] font-medium text-[var(--hr-warning)]">{{ t('agent.settings.defaults') }}</div>
          <div class="text-[11px] leading-relaxed text-[var(--hr-warning)]">
            {{ t('agent.settings.defaultsGap') }}
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

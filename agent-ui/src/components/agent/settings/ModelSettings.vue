<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot,
  ChevronDown,
  Loader2,
  LockKeyhole,
  Mic,
  Pencil,
  Plus,
  Trash2,
  Volume2
} from 'lucide-vue-next'
import { agentSettingsApi } from '@/api/agent'
import type { CodexModel, VoiceAgentConfig } from '@/api/agent'
import { useAgentStore } from '@/stores/agent-store'
import { useToast } from '@/components/controls/useToast'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import type { Provider } from '@/api/types/orchestration-v2.types'
import { createProtocolLabels } from '@/lib/protocol-labels'
import CapabilityBadge from './CapabilityBadge.vue'
import CustomProviderManager from './CustomProviderManager.vue'
import EditModelForm from './EditModelForm.vue'
import type { EditModelPayload } from './EditModelForm.vue'
import InlineDeleteConfirm from './InlineDeleteConfirm.vue'
import ModelForm from './ModelForm.vue'
import type { ModelFormPayload, ModelPurpose } from './ModelForm.vue'

const props = defineProps<{
  providers: Provider[]
  llmSettings: LLMSetting[]
  managerConfig: VoiceAgentConfig | null
  codexModels: CodexModel[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'set-notice', message: string): void
}>()

const store = useAgentStore()
const { t } = useI18n()
const { planLabel: localizedPlanLabel } = createProtocolLabels(t)
const { showToast } = useToast()

const dialogOpen = ref(false)
const editingSetting = ref<LLMSetting | null>(null)
const savingId = ref<string | null>(null)
const createMenuOpen = ref(false)
const createPurpose = ref<ModelPurpose>('llm')
const createProviderId = ref('')
const deleteConfirmId = ref<string | null>(null)

const activeSettings = computed(() => props.llmSettings.filter(s => s.is_active))
const inactiveSettings = computed(() => props.llmSettings.filter(s => !s.is_active))
const currentManagerUsesCodex = computed(() => props.managerConfig?.harness === 'codex_appserver')
const showCodexRuntime = computed(
  () => currentManagerUsesCodex.value || props.codexModels.length > 0
)
const activeManagerSettings = computed(() =>
  activeSettings.value.filter(
    setting => setting.supports_llm && !setting.supports_asr && !setting.supports_tts
  )
)
const availableManagerModelCount = computed(
  () => activeManagerSettings.value.length + props.codexModels.length
)
const configuredModelCount = computed(
  () => props.llmSettings.length + (showCodexRuntime.value ? 1 : 0)
)

function codexModelLabel(modelName: string | null | undefined): string {
  if (!modelName) return '-'
  const model = props.codexModels.find(item => item.model === modelName || item.id === modelName)
  return model?.display_name || modelName
}

const currentCodexModelName = computed(() => {
  if (currentManagerUsesCodex.value && props.managerConfig?.model_name) {
    return props.managerConfig.model_name
  }
  return (
    props.codexModels.find(model => model.is_default)?.model || props.codexModels[0]?.model || null
  )
})
const currentCodexModelLabel = computed(() => codexModelLabel(currentCodexModelName.value))
const currentCodexServiceTierLabel = computed(() => {
  const serviceTier = props.managerConfig?.service_tier
  if (!serviceTier) return t('settings.models.standardServiceTier')
  const model = props.codexModels.find(item => item.model === currentCodexModelName.value)
  return model?.service_tiers.find(tier => tier.id === serviceTier)?.name || serviceTier
})
const codexModelSummary = computed(() =>
  props.codexModels.map(model => model.display_name || model.model).join(', ')
)

function handleManagerProviderChange(event: Event): void {
  store.setManagerRuntime((event.target as HTMLSelectElement).value)
}

function handleManagerModelChange(event: Event): void {
  store.setManagerRuntime(store.managerProviderName, (event.target as HTMLSelectElement).value)
}

const purposeOptions = computed(() => [
  { id: 'llm' as const, label: t('settings.models.purposes.llm'), icon: Bot },
  { id: 'asr' as const, label: t('settings.models.purposes.asr'), icon: Mic },
  { id: 'tts' as const, label: t('settings.models.purposes.tts'), icon: Volume2 }
])

function toggleCreateMenu(): void {
  createMenuOpen.value = !createMenuOpen.value
}

function openCreate(purpose: ModelPurpose, providerId = ''): void {
  createPurpose.value = purpose
  createProviderId.value = providerId
  createMenuOpen.value = false
  editingSetting.value = null
  dialogOpen.value = true
}

function openEdit(setting: LLMSetting): void {
  editingSetting.value = setting
  dialogOpen.value = true
}

function closeDialog(): void {
  if (savingId.value === 'dialog') return
  dialogOpen.value = false
  editingSetting.value = null
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return String(err || t('settings.actions.operationFailed'))
}

async function runAction<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
  savingId.value = key
  try {
    return await action()
  } catch (err) {
    showToast(messageOf(err), 'error', 6000)
    return undefined
  } finally {
    savingId.value = null
  }
}

async function handleSubmit(payload: ModelFormPayload): Promise<void> {
  await runAction('dialog', async () => {
    if (!props.providers.some(provider => provider.id === payload.providerId)) {
      throw new Error(t('settings.models.providers.createFirst'))
    }
    const modelConfigs = payload.modelConfigs?.length
      ? payload.modelConfigs
      : [
          {
            modelName: payload.modelName,
            displayName: payload.displayName,
            endpointId: payload.endpointId,
            endpointName: payload.endpointName,
            protocol: payload.protocol,
            baseUrl: payload.baseUrl,
            chatCompletionsBaseUrl: payload.chatCompletionsBaseUrl,
            responsesBaseUrl: payload.responsesBaseUrl,
            anthropicBaseUrl: payload.anthropicBaseUrl,
            resourceId: payload.resourceId,
            voiceAdapter: payload.voiceAdapter,
            ttsHttpUrl: payload.ttsHttpUrl,
            ttsRealtimeUrl: payload.ttsRealtimeUrl,
            ttsBidirectionalUrl: payload.ttsBidirectionalUrl,
            asrRealtimeUrl: payload.asrRealtimeUrl,
            asrAsyncUrl: payload.asrAsyncUrl,
            ttsVoice: payload.ttsVoice,
            ttsFormat: payload.ttsFormat,
            ttsSampleRate: payload.ttsSampleRate,
            capabilities: payload.capabilities
          }
        ]
    for (const [index, model] of modelConfigs.entries()) {
      await agentSettingsApi.createLLMSetting({
        provider_id: payload.providerId,
        model_name: model.modelName,
        display_name: model.displayName || undefined,
        endpoint_id: model.endpointId,
        endpoint_name: model.endpointName,
        plan_type: payload.planType,
        protocol: model.protocol,
        auth_type: payload.authType,
        key_hint: payload.keyHint,
        base_url: model.baseUrl,
        chat_completions_base_url: model.chatCompletionsBaseUrl,
        responses_base_url: model.responsesBaseUrl,
        anthropic_base_url: model.anthropicBaseUrl,
        resource_id: model.resourceId,
        voice_adapter: model.voiceAdapter,
        tts_http_url: model.ttsHttpUrl,
        tts_realtime_url: model.ttsRealtimeUrl,
        tts_bidirectional_url: model.ttsBidirectionalUrl,
        asr_realtime_url: model.asrRealtimeUrl,
        asr_async_url: model.asrAsyncUrl,
        tts_voice: model.ttsVoice,
        tts_format: model.ttsFormat,
        tts_sample_rate: model.ttsSampleRate,
        api_key: payload.apiKey,
        reuse_existing_api_key: payload.reuseExistingApiKey,
        is_default: payload.isDefault && index === 0,
        is_active: payload.isActive,
        ...model.capabilities
      })
    }
    emit('refresh')
    await store.loadManagerRuntimeOptions()
    dialogOpen.value = false
    editingSetting.value = null
    emit('set-notice', t('settings.models.added', { count: payload.modelConfigs?.length || 1 }))
  })
}

async function handleEditSubmit(payload: EditModelPayload): Promise<void> {
  await runAction('dialog', async () => {
    await agentSettingsApi.updateLLMSetting(payload.id, {
      display_name: payload.displayName,
      api_key: payload.apiKey,
      is_default: payload.isDefault,
      is_active: payload.isActive,
      supports_audio_input: payload.supportsAudioInput,
      supports_image_input: payload.supportsImageInput,
      supports_video_input: payload.supportsVideoInput,
      tts_voice: payload.ttsVoice,
      tts_format: payload.ttsFormat,
      tts_sample_rate: payload.ttsSampleRate
    })
    emit('refresh')
    await store.loadManagerRuntimeOptions()
    dialogOpen.value = false
    editingSetting.value = null
    emit('set-notice', t('settings.models.updated'))
  })
}

async function toggleActive(setting: LLMSetting): Promise<void> {
  await runAction(`active-${setting.id}`, async () => {
    await agentSettingsApi.updateLLMSetting(setting.id, { is_active: !setting.is_active })
    emit('refresh')
    await store.loadManagerRuntimeOptions()
  })
}

async function setDefault(setting: LLMSetting): Promise<void> {
  await runAction(`default-${setting.id}`, async () => {
    await agentSettingsApi.updateLLMSetting(setting.id, { is_default: true })
    emit('refresh')
    await store.loadManagerRuntimeOptions()
  })
}

function toggleDeleteConfirm(settingId: string): void {
  if (savingId.value) return
  deleteConfirmId.value = deleteConfirmId.value === settingId ? null : settingId
}

function cancelDelete(): void {
  deleteConfirmId.value = null
}

async function confirmRemove(setting: LLMSetting): Promise<void> {
  await runAction(`delete-${setting.id}`, async () => {
    await agentSettingsApi.deleteLLMSetting(setting.id)
    deleteConfirmId.value = null
    emit('refresh')
    await store.loadManagerRuntimeOptions()
    emit('set-notice', t('settings.models.deleted'))
  })
}

function capabilityList(
  setting: LLMSetting
): Array<{ key: 'llm' | 'asr' | 'tts' | 'audio' | 'vision' | 'video'; active: boolean }> {
  return [
    { key: 'llm', active: setting.supports_llm },
    { key: 'vision', active: setting.supports_image_input },
    { key: 'asr', active: setting.supports_asr },
    { key: 'tts', active: setting.supports_tts },
    { key: 'audio', active: setting.supports_audio_input },
    { key: 'video', active: setting.supports_video_input }
  ]
}
</script>

<template>
  <section data-testid="agent-settings-section-providers" class="mt-10 space-y-6">
    <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold">{{ t('settings.models.runtimeTitle') }}</h2>
          <div class="mt-1 text-xs text-gray-500">{{ t('settings.models.runtimeSubtitle') }}</div>
        </div>
        <span
          data-testid="agent-settings-manager-runtime-count"
          class="rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400"
          >{{ t('settings.models.available', { count: availableManagerModelCount }) }}</span
        >
      </div>
      <div v-if="currentManagerUsesCodex" class="mt-4 grid gap-3 md:grid-cols-2">
        <div
          data-testid="agent-settings-manager-runtime-provider-readonly"
          class="flex h-10 items-center justify-between rounded-md border border-white/10 bg-[#343434] px-3 text-sm"
        >
          <span>Codex</span>
          <span class="inline-flex items-center gap-1 text-xs text-cyan-200/70">
            <LockKeyhole class="h-3.5 w-3.5" />
            {{ t('settings.models.autoDetected') }}
          </span>
        </div>
        <div
          data-testid="agent-settings-manager-runtime-model-readonly"
          class="flex h-10 items-center justify-between rounded-md border border-white/10 bg-[#343434] px-3 text-sm"
        >
          <span>{{ currentCodexModelLabel }}</span>
          <span class="text-xs text-gray-500">
            <template v-if="managerConfig?.reasoning_effort"
              >{{ managerConfig.reasoning_effort }} · </template
            >{{ currentCodexServiceTierLabel }}
          </span>
        </div>
      </div>
      <div v-else class="mt-4 grid gap-3 md:grid-cols-2">
        <select
          :value="store.managerProviderName"
          class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none"
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
          class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none"
          :disabled="store.managerRuntimeLoading"
          @change="handleManagerModelChange"
        >
          <option v-for="model in store.managerModelOptions" :key="model" :value="model">
            {{ store.managerModelLabel(store.managerProviderName, model) }}
          </option>
        </select>
      </div>
      <div v-if="currentManagerUsesCodex" class="mt-3 text-xs leading-relaxed text-gray-500">
        {{ t('settings.models.codexRuntimeHint') }}
      </div>
      <div v-else class="mt-3 text-xs leading-relaxed text-gray-500">
        {{ t('settings.models.runtimeHint') }}
      </div>
    </div>

    <CustomProviderManager
      :providers="providers"
      :settings="llmSettings"
      @refresh="emit('refresh')"
      @notice="emit('set-notice', $event)"
      @add-model="openCreate"
    />

    <div class="rounded-lg border border-white/10 bg-[#252525]">
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3"
      >
        <div>
          <h2 class="font-semibold">{{ t('settings.models.configuredTitle') }}</h2>
          <div class="mt-1 text-xs text-gray-500">
            {{
              t('settings.models.summary', {
                providers: providers.length,
                models: configuredModelCount
              })
            }}
          </div>
        </div>
        <div class="relative">
          <button
            data-testid="add-model-menu-button"
            class="inline-flex items-center gap-2 rounded-md bg-blue-500 px-3 py-2 text-sm text-white hover:bg-blue-400 disabled:opacity-50"
            :disabled="loading"
            aria-haspopup="menu"
            :aria-expanded="createMenuOpen"
            @click="toggleCreateMenu"
          >
            <Plus class="h-4 w-4" />
            {{ t('settings.models.addModel') }}
            <ChevronDown class="h-3.5 w-3.5" />
          </button>
          <div
            v-if="createMenuOpen"
            class="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-white/12 bg-[#202426] p-1.5 shadow-2xl"
            role="menu"
          >
            <button
              v-for="option in purposeOptions"
              :key="option.id"
              :data-testid="`add-model-purpose-${option.id}`"
              type="button"
              class="flex w-full items-center gap-3 rounded px-3 py-2.5 text-left text-sm text-gray-200 hover:bg-white/7"
              role="menuitem"
              @click="openCreate(option.id)"
            >
              <component :is="option.icon" class="h-4 w-4 text-cyan-200/80" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="loading && !configuredModelCount"
        class="px-4 py-8 text-center text-sm text-gray-500"
      >
        <Loader2 class="mx-auto h-5 w-5 animate-spin" />
        <div class="mt-2">{{ t('settings.models.loading') }}</div>
      </div>

      <div v-else-if="!configuredModelCount" class="px-4 py-8 text-center text-sm text-gray-500">
        {{ t('settings.models.empty') }}
      </div>

      <template v-else>
        <div
          v-if="showCodexRuntime"
          data-testid="agent-settings-model-item-codex"
          class="border-b border-white/10 px-4 py-4"
        >
          <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">Codex</span>
                <span
                  v-if="currentManagerUsesCodex"
                  class="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200"
                  >{{ t('settings.models.currentManager') }}</span
                >
                <span
                  v-if="codexModels.length"
                  class="rounded-full bg-cyan-400/10 px-2 py-0.5 text-[10px] text-cyan-200"
                  >{{ t('settings.models.autoDetected') }}</span
                >
                <span class="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-300">{{
                  t('settings.models.readOnly')
                }}</span>
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>OpenAI Codex</span>
                <span>·</span>
                <span>{{ t('settings.models.localCli') }}</span>
                <template v-if="codexModels.length">
                  <span>·</span>
                  <span>{{
                    t('settings.models.availableModelList', {
                      count: codexModels.length,
                      models: codexModelSummary
                    })
                  }}</span>
                </template>
                <template v-else-if="currentCodexModelName">
                  <span>·</span>
                  <span>{{
                    t('settings.models.currentModel', { model: currentCodexModelLabel })
                  }}</span>
                </template>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <CapabilityBadge capability="llm" :active="true" />
                <span
                  v-if="currentManagerUsesCodex"
                  class="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-300"
                >
                  {{ currentCodexModelLabel
                  }}<template v-if="managerConfig?.reasoning_effort">
                    · {{ managerConfig.reasoning_effort }}</template
                  >
                  · {{ currentCodexServiceTierLabel }}
                </span>
              </div>
            </div>

            <div class="inline-flex items-center gap-1.5 text-xs text-gray-500 xl:pt-1">
              <LockKeyhole class="h-3.5 w-3.5" />
              {{ t('settings.models.systemManaged') }}
            </div>
          </div>
        </div>

        <div
          v-for="setting in activeSettings"
          :key="setting.id"
          class="group border-b border-white/10 px-4 py-4 last:border-0"
          :data-testid="`agent-settings-model-item-${setting.id}`"
        >
          <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ setting.display_name || setting.model_name }}</span>
                <span
                  v-if="setting.is_default"
                  class="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200"
                  >{{ t('settings.models.default') }}</span
                >
                <span
                  class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200"
                  >{{ t('settings.models.active') }}</span
                >
              </div>
              <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>{{ setting.provider_name }}</span>
                <span>·</span>
                <span>{{ localizedPlanLabel(setting.plan_type) }}</span>
                <span>·</span>
                <span v-if="setting.models && setting.models.length > 1" class="text-gray-400">
                  {{
                    t('settings.models.modelList', {
                      count: setting.models.length,
                      models: setting.models.slice(0, 3).join(', ')
                    })
                  }}{{ setting.models.length > 3 ? '...' : '' }}
                </span>
                <span v-else>{{ setting.model_name }}</span>
                <span>·</span>
                <span class="font-mono">{{ setting.api_key_display || '****' }}</span>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <CapabilityBadge
                  v-for="cap in capabilityList(setting)"
                  :key="cap.key"
                  :capability="cap.key"
                  :active="cap.active"
                />
                <span
                  v-if="setting.plan_type === 'custom' || setting.endpoint_id?.endsWith('_custom')"
                  class="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200"
                  >{{ t('settings.models.custom') }}</span
                >
                <span class="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-gray-300">{{
                  localizedPlanLabel(setting.plan_type)
                }}</span>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 xl:justify-end">
              <button
                class="rounded-md border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5"
                :disabled="savingId === `default-${setting.id}`"
                @click="setDefault(setting)"
              >
                <Loader2
                  v-if="savingId === `default-${setting.id}`"
                  class="inline h-3 w-3 animate-spin"
                />
                <span v-else>{{ t('settings.models.setDefault') }}</span>
              </button>
              <button
                :data-testid="`edit-model-${setting.id}`"
                :title="t('settings.models.editTitle')"
                class="rounded-md border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5"
                @click="openEdit(setting)"
              >
                <Pencil class="h-3.5 w-3.5" />
              </button>
              <button
                class="rounded-md border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5"
                :disabled="savingId === `active-${setting.id}`"
                @click="toggleActive(setting)"
              >
                <Loader2
                  v-if="savingId === `active-${setting.id}`"
                  class="inline h-3 w-3 animate-spin"
                />
                <span v-else>{{ t('settings.actions.disable') }}</span>
              </button>
              <div>
                <button
                  :data-testid="`delete-model-${setting.id}`"
                  class="rounded-md border border-red-500/30 px-2 py-1.5 text-red-300 hover:bg-red-500/10"
                  :class="deleteConfirmId === setting.id ? 'bg-red-500/10' : ''"
                  :disabled="savingId === `delete-${setting.id}`"
                  @click="toggleDeleteConfirm(setting.id)"
                >
                  <Loader2
                    v-if="savingId === `delete-${setting.id}`"
                    class="inline h-4 w-4 animate-spin"
                  />
                  <Trash2 v-else class="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <InlineDeleteConfirm
            v-if="deleteConfirmId === setting.id"
            :test-id="`delete-model-confirm-${setting.id}`"
            :message="
              t('settings.models.deleteConfirm', {
                name: setting.display_name || setting.model_name
              })
            "
            :loading="savingId === `delete-${setting.id}`"
            class="ml-auto mt-3 w-72 max-w-full"
            @confirm="confirmRemove(setting)"
            @cancel="cancelDelete"
          />
        </div>

        <div
          v-if="inactiveSettings.length"
          class="border-t border-dashed border-white/10 px-4 py-2"
        >
          <div class="text-xs text-gray-500">
            {{ t('settings.models.inactive', { count: inactiveSettings.length }) }}
          </div>
        </div>
        <div
          v-for="setting in inactiveSettings"
          :key="setting.id"
          class="group border-b border-white/10 px-4 py-3 opacity-60 last:border-0 hover:opacity-80"
          :data-testid="`agent-settings-model-item-${setting.id}`"
        >
          <div class="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-gray-400">
                {{ setting.display_name || setting.model_name }}
              </div>
              <div class="mt-0.5 text-xs text-gray-600">
                {{ setting.provider_name }}
                <span
                  v-if="setting.plan_type === 'custom' || setting.endpoint_id?.endsWith('_custom')"
                  class="ml-1 rounded bg-amber-400/10 px-1 text-amber-200/70"
                  >{{ t('settings.models.custom') }}</span
                >
                · {{ localizedPlanLabel(setting.plan_type) }} ·
                {{
                  setting.models && setting.models.length > 1
                    ? t('settings.models.modelsCount', { count: setting.models.length })
                    : setting.model_name
                }}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                class="rounded-md border border-white/10 px-3 py-1.5 text-xs text-gray-400 hover:bg-white/5"
                :disabled="savingId === `active-${setting.id}`"
                @click="toggleActive(setting)"
              >
                <Loader2
                  v-if="savingId === `active-${setting.id}`"
                  class="inline h-3 w-3 animate-spin"
                />
                <span v-else>{{ t('settings.actions.enable') }}</span>
              </button>
              <div>
                <button
                  :data-testid="`delete-model-${setting.id}`"
                  class="rounded-md border border-red-500/30 px-2 py-1.5 text-red-300/70 hover:bg-red-500/10"
                  :class="deleteConfirmId === setting.id ? 'bg-red-500/10' : ''"
                  :disabled="savingId === `delete-${setting.id}`"
                  @click="toggleDeleteConfirm(setting.id)"
                >
                  <Loader2
                    v-if="savingId === `delete-${setting.id}`"
                    class="inline h-4 w-4 animate-spin"
                  />
                  <Trash2 v-else class="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <InlineDeleteConfirm
            v-if="deleteConfirmId === setting.id"
            :test-id="`delete-model-confirm-${setting.id}`"
            :message="
              t('settings.models.deleteConfirm', {
                name: setting.display_name || setting.model_name
              })
            "
            :loading="savingId === `delete-${setting.id}`"
            class="ml-auto mt-3 w-72 max-w-full"
            @confirm="confirmRemove(setting)"
            @cancel="cancelDelete"
          />
        </div>
      </template>
    </div>

    <!-- 添加/编辑模型：右侧滑入面板（透明遮罩，点击关闭） -->
    <teleport to="body">
      <transition name="settings-overlay">
        <div v-if="dialogOpen" class="settings-model-overlay" @click="closeDialog" />
      </transition>
      <transition name="settings-panel">
        <div
          v-if="dialogOpen"
          class="settings-model-panel"
          data-testid="agent-settings-model-dialog"
          @click.stop
        >
          <div class="flex h-full flex-col">
            <div
              class="flex items-center justify-between border-b border-cyan-200/10 px-5 py-4 flex-shrink-0"
            >
              <h2 class="text-base font-semibold text-cyan-50">
                {{
                  editingSetting ? t('settings.models.editTitle') : t('settings.models.addTitle')
                }}
              </h2>
              <button
                class="rounded-md border border-cyan-200/14 px-3 py-1.5 text-sm text-gray-400 transition-colors hover:bg-cyan-200/10 hover:text-white"
                @click="closeDialog"
              >
                {{ t('settings.actions.close') }}
              </button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <EditModelForm
                v-if="editingSetting"
                :setting="editingSetting"
                :submitting="savingId === 'dialog'"
                @submit="handleEditSubmit"
                @cancel="closeDialog"
              />
              <ModelForm
                v-else
                :providers="providers"
                :settings="llmSettings"
                :purpose="createPurpose"
                :initial-provider-id="createProviderId"
                :submitting="savingId === 'dialog'"
                @submit="handleSubmit"
                @cancel="closeDialog"
              />
            </div>
          </div>
        </div>
      </transition>
    </teleport>
  </section>
</template>

<style scoped>
/* 透明遮罩：拦截区域外点击，不全黑，微暗化背景 */
.settings-model-overlay {
  position: fixed;
  inset: 0;
  z-index: 59;
  background: rgba(0, 0, 0, 0.25);
  backdrop-filter: blur(2px);
}

.settings-model-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: min(640px, 94vw);
  z-index: 60;
  /* 匹配设置页主题：#080b0d 基底 + #071012 主区 + 毛玻璃 */
  background: rgba(7, 16, 18, 0.96);
  backdrop-filter: blur(24px);
  border-left: 1px solid rgba(103, 232, 249, 0.12);
  box-shadow: -24px 0 80px rgba(0, 0, 0, 0.45);
}

.settings-overlay-enter-active,
.settings-overlay-leave-active {
  transition: opacity 200ms ease;
}
.settings-overlay-enter-from,
.settings-overlay-leave-to {
  opacity: 0;
}

.settings-panel-enter-active {
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.settings-panel-leave-active {
  transition: transform 180ms cubic-bezier(0.4, 0, 1, 1);
}
.settings-panel-enter-from,
.settings-panel-leave-to {
  transform: translateX(100%);
}
</style>

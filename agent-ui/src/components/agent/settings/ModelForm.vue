<script setup lang="ts">
/**
 * ModelForm — 凭证式模型配置表单（v2）。
 *
 * 核心理解：凭证 = 供应商 + 计费方式 + API Key。一个 key 可用多个模型。
 * 协议是凭证的附属属性（同 key 通常同时支持 Chat Completions 和 Anthropic），
 * 不参与选择，只在底部信息区显示。
 *
 * 流程：选凭证类型（供应商+计费）→ 填 key → 多选模型（能力自动填）
 */

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { KeyRound, Loader2, Minus, Plus, Search, RefreshCw } from 'lucide-vue-next'
import { probeModels } from '@/api/services/providers-api'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import type {
  Provider,
  ProviderEndpointPreset,
  ProviderModelPreset,
  ProviderProtocol
} from '@/api/types/orchestration-v2.types'
import { createProtocolLabels } from '@/lib/protocol-labels'
import CapabilityToggle from './CapabilityToggle.vue'

export interface ModelFormPayload {
  providerId: string
  providerName: string
  endpointId?: string
  endpointName?: string
  modelName: string
  models?: string[]
  displayName: string
  protocol: ProviderProtocol
  planType?: LLMSetting['plan_type']
  authType?: LLMSetting['auth_type']
  keyHint?: string
  baseUrl: string
  chatCompletionsBaseUrl?: string
  responsesBaseUrl?: string
  anthropicBaseUrl?: string
  resourceId?: string
  voiceAdapter?: string
  ttsHttpUrl?: string
  ttsRealtimeUrl?: string
  ttsBidirectionalUrl?: string
  asrRealtimeUrl?: string
  asrAsyncUrl?: string
  ttsVoice?: string
  ttsFormat?: string
  ttsSampleRate?: number
  apiKey: string
  reuseExistingApiKey: boolean
  isDefault: boolean
  isActive: boolean
  capabilities: ModelCapabilities
  modelConfigs?: ModelFormModelConfig[]
}

export interface ModelFormModelConfig {
  modelName: string
  displayName: string
  endpointId?: string
  endpointName?: string
  protocol: ProviderProtocol
  baseUrl: string
  chatCompletionsBaseUrl?: string
  responsesBaseUrl?: string
  anthropicBaseUrl?: string
  resourceId?: string
  voiceAdapter?: string
  ttsHttpUrl?: string
  ttsRealtimeUrl?: string
  ttsBidirectionalUrl?: string
  asrRealtimeUrl?: string
  asrAsyncUrl?: string
  ttsVoice?: string
  ttsFormat?: string
  ttsSampleRate?: number
  capabilities: ModelCapabilities
}

export interface ModelCapabilities {
  supports_llm: boolean
  supports_asr: boolean
  supports_tts: boolean
  supports_audio_input: boolean
  supports_image_input: boolean
  supports_video_input: boolean
}

export type ModelPurpose = 'llm' | 'asr' | 'tts'

const props = defineProps<{
  providers: Provider[]
  settings?: LLMSetting[]
  purpose: ModelPurpose
  initialProviderId?: string
  submitting?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', payload: ModelFormPayload): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const { planLabel: localizedPlanLabel, protocolLabel: localizedProtocolLabel } =
  createProtocolLabels(t)

// ── 状态 ──────────────────────────────────────────────────────
// 凭证选择：providerId + planType + endpoint boundary 唯一标识一个凭证类型
const selectedProviderId = ref('')
const selectedPlanType = ref<string>('')
const selectedEndpointId = ref('') // 该 plan 下的代表 endpoint（用于取 base_url）
// 选中的模型 + 各自别名：modelId → alias（空字符串=无别名）
const selectedModels = ref<Map<string, string>>(new Map())
const displayName = ref('')
const apiKey = ref('')
const useNewApiKey = ref(false)
const isDefault = ref(false)
const isActive = ref(true)
const saving = ref(false)

// 动态模型探测
const probing = ref(false)
const probedModels = ref<string[]>([])
const probeError = ref<string | null>(null)
let probeTimer: number | undefined
const searchQuery = ref('')

function modelSupportsPurpose(model: ProviderModelPreset): boolean {
  if (props.purpose === 'asr') return Boolean(model.supports_asr)
  if (props.purpose === 'tts') return Boolean(model.supports_tts)
  return model.supports_llm !== false
}

function settingSupportsPurpose(setting: LLMSetting): boolean {
  if (props.purpose === 'asr') return setting.supports_asr
  if (props.purpose === 'tts') return setting.supports_tts
  return setting.supports_llm
}

function providerModelSupportsPurpose(provider: Provider, model: ProviderModelPreset): boolean {
  if (provider.source !== 'custom') return modelSupportsPurpose(model)
  const matchingSettings = (props.settings ?? []).filter(
    setting => setting.provider_id === provider.id && setting.model_name === model.id
  )
  return matchingSettings.length
    ? matchingSettings.some(settingSupportsPurpose)
    : modelSupportsPurpose(model)
}

function endpointSupportsPurpose(endpoint: ProviderEndpointPreset): boolean {
  if (props.purpose === 'asr') return Boolean(endpoint.supports_asr)
  if (props.purpose === 'tts') return Boolean(endpoint.supports_tts)
  return endpoint.supports_llm !== false
}

function credentialSupportsPurpose(credential: CredentialOption): boolean {
  if (credential.provider.source === 'custom') {
    const providerSettings = (props.settings ?? []).filter(
      setting => setting.provider_id === credential.provider.id
    )
    if (providerSettings.length) return providerSettings.some(settingSupportsPurpose)
  }
  return (
    credential.models.some(model => providerModelSupportsPurpose(credential.provider, model)) ||
    credential.endpoints.some(endpointSupportsPurpose)
  )
}

// ── 凭证选项（供应商 + 计费方式 去重）────────────────────────
interface CredentialOption {
  key: string
  provider: Provider
  planType: string
  // 该凭证下的所有 endpoint（合并同 plan 不同协议的 endpoint）
  endpoints: ProviderEndpointPreset[]
  // 该凭证可用的所有模型（去重合并）
  models: ProviderModelPreset[]
  // 支持的协议（从 endpoints 聚合）
  protocols: ProviderProtocol[]
}

function isArkVoiceEndpoint(ep?: ProviderEndpointPreset | null): boolean {
  return (
    ep?.protocol === 'volcengine_doubao_voice' ||
    ep?.protocol === 'volcengine_ark_voice' ||
    ep?.protocol === 'volcengine_openspeech' ||
    ep?.voice_adapter === 'volcengine_doubao_voice' ||
    ep?.voice_adapter === 'volcengine_ark_voice' ||
    ep?.voice_adapter === 'volcengine_openspeech'
  )
}

function credentialBoundaryKey(ep: ProviderEndpointPreset): string {
  return [
    ep.plan_type,
    ep.auth_type ?? '',
    ep.key_hint ?? '',
    isArkVoiceEndpoint(ep) ? (ep.voice_adapter ?? ep.protocol) : 'llm'
  ].join('|')
}

const allCredentials = computed<CredentialOption[]>(() => {
  const result: CredentialOption[] = []
  for (const provider of props.providers) {
    if (!provider.endpoints?.length) continue
    // 按实际凭证边界分组。方舟 OpenAI/Anthropic 可共用同一模型 API key；
    // openspeech 使用 X-Api-Key，不能和方舟模型 endpoint 合并。
    const byCredential = new Map<string, ProviderEndpointPreset[]>()
    for (const ep of provider.endpoints) {
      const key = credentialBoundaryKey(ep)
      if (!byCredential.has(key)) byCredential.set(key, [])
      byCredential.get(key)!.push(ep)
    }
    for (const [credentialKey, endpoints] of byCredential) {
      const planType = endpoints[0]?.plan_type ?? 'custom'
      // 合并模型（去重）
      const modelMap = new Map<string, ProviderModelPreset>()
      for (const ep of endpoints) {
        for (const m of ep.models) {
          if (!modelMap.has(m.id)) modelMap.set(m.id, m)
        }
      }
      // 聚合协议：根据 endpoint 实际拥有的 base_url 判断（不看 protocol 字段，
      // 因为合并后 protocol 都是 openai_compatible，但 anthropic_base_url 仍存在）
      const protoSet = new Set<ProviderProtocol>()
      for (const ep of endpoints) {
        protoSet.add(ep.protocol)
        if (isArkVoiceEndpoint(ep)) continue
        if (ep.chat_completions_base_url || ep.base_url) protoSet.add('openai_compatible')
        if (ep.responses_base_url) protoSet.add('openai_compatible')
        if (ep.anthropic_base_url) protoSet.add('anthropic_compatible')
      }
      const protocols = Array.from(protoSet)
      result.push({
        key: `${provider.id}:${credentialKey}`,
        provider,
        planType,
        endpoints,
        models: Array.from(modelMap.values()),
        protocols
      })
    }
  }
  return result
})

const filteredCredentials = computed<CredentialOption[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return allCredentials.value
    .filter(credentialSupportsPurpose)
    .map(credential => ({
      ...credential,
      models: credential.models.filter(model =>
        providerModelSupportsPurpose(credential.provider, model)
      )
    }))
    .filter(
      ({ provider, planType }) =>
        !q ||
        provider.name.toLowerCase().includes(q) ||
        localizedPlanLabel(planType).toLowerCase().includes(q)
    )
})

const groupedCredentials = computed(() => {
  const groups = new Map<string, { provider: Provider; items: CredentialOption[] }>()
  for (const item of filteredCredentials.value) {
    const key = item.provider.id
    if (!groups.has(key)) groups.set(key, { provider: item.provider, items: [] })
    groups.get(key)!.items.push(item)
  }
  return Array.from(groups.values())
})

// ── 当前选中的凭证 ────────────────────────────────────────────
const selectedCredential = computed<CredentialOption | null>(() => {
  if (!selectedProviderId.value || !selectedPlanType.value) return null
  return (
    allCredentials.value.find(
      c =>
        c.provider.id === selectedProviderId.value &&
        c.planType === selectedPlanType.value &&
        (!selectedEndpointId.value || c.endpoints.some(ep => ep.id === selectedEndpointId.value))
    ) ?? null
  )
})

function isSelectedCredentialOption(item: CredentialOption): boolean {
  return (
    selectedProviderId.value === item.provider.id &&
    selectedPlanType.value === item.planType &&
    item.endpoints.some(ep => ep.id === selectedEndpointId.value)
  )
}

function endpointForModel(
  modelId: string,
  cred = selectedCredential.value
): ProviderEndpointPreset | null {
  if (!cred) return null
  return (
    cred.endpoints.find(ep => ep.models.some(model => model.id === modelId)) ??
    cred.endpoints[0] ??
    null
  )
}

const selectedPrimaryModelEndpoint = computed<ProviderEndpointPreset | null>(() => {
  const firstModel = Array.from(selectedModels.value.keys())[0]
  return firstModel ? endpointForModel(firstModel) : null
})

// 凭证下的代表 endpoint（用于 base_url，取第一个）
const representativeEndpoint = computed<ProviderEndpointPreset | null>(() => {
  return selectedPrimaryModelEndpoint.value ?? selectedCredential.value?.endpoints[0] ?? null
})

function reusableSettingForEndpoint(
  endpoint: ProviderEndpointPreset
): LLMSetting | undefined {
  return (props.settings ?? []).find(
    setting =>
      setting.provider_id === selectedProviderId.value &&
      (setting.endpoint_id ?? 'custom') === endpoint.id &&
      Boolean(setting.api_key_display)
  )
}

const endpointsForSelectedModels = computed<ProviderEndpointPreset[]>(() => {
  const selected = Array.from(selectedModels.value.keys())
  const endpoints = selected.length
    ? selected
        .map(modelId => endpointForModel(modelId))
        .filter((endpoint): endpoint is ProviderEndpointPreset => Boolean(endpoint))
    : representativeEndpoint.value
      ? [representativeEndpoint.value]
      : []
  return Array.from(new Map(endpoints.map(endpoint => [endpoint.id, endpoint])).values())
})

const reusableCredentialSettings = computed<LLMSetting[]>(() =>
  endpointsForSelectedModels.value
    .map(reusableSettingForEndpoint)
    .filter((setting): setting is LLMSetting => Boolean(setting))
)

const canReuseCredential = computed(
  () =>
    endpointsForSelectedModels.value.length > 0 &&
    reusableCredentialSettings.value.length === endpointsForSelectedModels.value.length
)

const reusingCredential = computed(() => canReuseCredential.value && !useNewApiKey.value)
const reusableCredentialDisplay = computed(
  () => reusableCredentialSettings.value[0]?.api_key_display || '****'
)

const endpointUrlRows = computed(() => {
  const ep = representativeEndpoint.value
  if (!ep) return []
  return [
    { label: 'Chat Completions', value: ep.chat_completions_base_url || ep.base_url },
    { label: 'OpenAI Responses', value: ep.responses_base_url },
    { label: 'Anthropic Messages', value: ep.anthropic_base_url }
  ].filter(row => Boolean(row.value))
})

const selectedModelPresets = computed(() => {
  const cred = selectedCredential.value
  if (!cred) return []
  const selected = new Set(Array.from(selectedModels.value.keys()))
  return cred.models.filter(model => selected.has(model.id))
})

const selectedPrimaryModelPreset = computed(() => selectedModelPresets.value[0] ?? null)

function modelPresetFor(
  modelId: string,
  cred = selectedCredential.value
): ProviderModelPreset | null {
  return cred?.models.find(model => model.id === modelId) ?? null
}

const isArkVoiceCredential = computed(() => isArkVoiceEndpoint(representativeEndpoint.value))

// ── 合并模型列表：catalog 预设 + probe 发现的新模型 ──────────
// probe 发现但 catalog 没有的模型追加到末尾（标为"探测"）
interface DisplayModel {
  id: string
  display_name: string
  probed: boolean // 是否来自动态探测（非 catalog 预设）
}

const displayModels = computed<DisplayModel[]>(() => {
  const cred = selectedCredential.value
  if (!cred) return []
  const result: DisplayModel[] = cred.models
    .filter(model => providerModelSupportsPurpose(cred.provider, model))
    .map(m => ({
      id: m.id,
      display_name: m.display_name || m.id,
      probed: false
    }))
  // probe 发现的新模型（catalog 没有的）追加
  const known = new Set(result.map(m => m.id))
  for (const id of probedModels.value) {
    if (!known.has(id)) {
      result.push({ id, display_name: id, probed: true })
    }
  }
  return result
})

const availableDisplayModels = computed(() =>
  displayModels.value.filter(model => !selectedModels.value.has(model.id))
)

const selectedModelRows = computed(() =>
  Array.from(selectedModels.value.entries()).map(([modelId, alias]) => {
    const display = displayModels.value.find(model => model.id === modelId)
    return {
      id: modelId,
      displayName: display?.display_name || modelPresetFor(modelId)?.display_name || modelId,
      alias,
      probed: Boolean(display?.probed)
    }
  })
)

// ── 动态探测模型 ──────────────────────────────────────────────
async function runProbe(): Promise<void> {
  const ep = representativeEndpoint.value
  if (!ep || !apiKey.value.trim()) return
  if (isArkVoiceEndpoint(ep)) {
    probedModels.value = []
    probeError.value = null
    return
  }
  const baseUrl = ep.chat_completions_base_url || ep.base_url
  if (!baseUrl) return
  probing.value = true
  probeError.value = null
  try {
    const result = await probeModels(baseUrl, apiKey.value.trim())
    probedModels.value = result.models
    if (result.error) probeError.value = result.error
  } catch (e: any) {
    probeError.value = e?.message || t('settings.models.form.probeFailedFallback')
    probedModels.value = []
  } finally {
    probing.value = false
  }
}

// 填 key 后 debounce 自动 probe（500ms）
watch([apiKey, selectedEndpointId], ([key]) => {
  if (probeTimer) window.clearTimeout(probeTimer)
  probedModels.value = []
  probeError.value = null
  if (!key?.trim() || isArkVoiceCredential.value) return
  probeTimer = window.setTimeout(() => {
    void runProbe()
  }, 600)
})

function endpointDefaultCapabilities(ep?: ProviderEndpointPreset | null): ModelCapabilities {
  return {
    supports_llm: props.purpose === 'llm',
    supports_asr: props.purpose === 'asr',
    supports_tts: props.purpose === 'tts',
    supports_audio_input: props.purpose !== 'tts' && (ep?.supports_audio_input ?? false),
    supports_image_input: props.purpose === 'llm' && (ep?.supports_image_input ?? false),
    supports_video_input: props.purpose === 'llm' && (ep?.supports_video_input ?? false)
  }
}

function modelBaseCapabilities(modelId: string): ModelCapabilities {
  const preset = modelPresetFor(modelId)
  if (!preset) return endpointDefaultCapabilities(endpointForModel(modelId))
  return {
    supports_llm: props.purpose === 'llm',
    supports_asr: props.purpose === 'asr',
    supports_tts: props.purpose === 'tts',
    supports_audio_input: props.purpose !== 'tts' && Boolean(preset.supports_audio_input),
    supports_image_input: props.purpose === 'llm' && Boolean(preset.supports_image_input),
    supports_video_input: props.purpose === 'llm' && Boolean(preset.supports_video_input)
  }
}

function mergeCapabilities(models: ModelCapabilities[]): ModelCapabilities {
  if (!models.length)
    return {
      supports_llm: props.purpose === 'llm',
      supports_asr: props.purpose === 'asr',
      supports_tts: props.purpose === 'tts',
      supports_audio_input: false,
      supports_image_input: false,
      supports_video_input: false
    }
  return {
    supports_llm: models.some(capabilities => capabilities.supports_llm),
    supports_asr: models.some(capabilities => capabilities.supports_asr),
    supports_tts: models.some(capabilities => capabilities.supports_tts),
    supports_audio_input: models.some(capabilities => capabilities.supports_audio_input),
    supports_image_input: models.some(capabilities => capabilities.supports_image_input),
    supports_video_input: models.some(capabilities => capabilities.supports_video_input)
  }
}

// ── 能力自动填（从选中的模型 catalog 取并集）─────────────────
const inferredCapabilities = computed<ModelCapabilities>(() => {
  if (!selectedCredential.value) return mergeCapabilities([])
  const selected = Array.from(selectedModels.value.keys())
  if (!selected.length) return endpointDefaultCapabilities(representativeEndpoint.value)
  return mergeCapabilities(selected.map(modelBaseCapabilities))
})

// 手动能力覆盖（用户可微调）
const capabilityOverrides = ref<Partial<ModelCapabilities>>({})
const effectiveCapabilities = computed<ModelCapabilities>(() => ({
  ...inferredCapabilities.value,
  ...capabilityOverrides.value
}))

function setCapability(key: keyof ModelCapabilities, value: boolean): void {
  capabilityOverrides.value = { ...capabilityOverrides.value, [key]: value }
}

function effectiveCapabilitiesForModel(modelId: string): ModelCapabilities {
  return {
    ...modelBaseCapabilities(modelId),
    ...capabilityOverrides.value
  }
}

// ── 凭证选择 ─────────────────────────────────────────────────
function selectCredential(opt: CredentialOption): void {
  selectedProviderId.value = opt.provider.id
  selectedPlanType.value = opt.planType
  selectedEndpointId.value = opt.endpoints[0]?.id ?? ''
  // 默认不选中任何模型，用户自行点选（去掉推荐逻辑）
  selectedModels.value = new Map()
  capabilityOverrides.value = {}
  apiKey.value = ''
  useNewApiKey.value = false
}

watch(
  [() => props.initialProviderId, allCredentials],
  ([providerId, credentials]) => {
    if (!providerId || selectedProviderId.value) return
    const credential = credentials.find(item => item.provider.id === providerId)
    if (credential) selectCredential(credential)
  },
  { immediate: true }
)

function addModel(modelId: string): void {
  if (selectedModels.value.has(modelId)) return
  const next = new Map(selectedModels.value)
  next.set(modelId, '') // 初始别名空
  selectedModels.value = next
}

function removeModel(modelId: string): void {
  const next = new Map(selectedModels.value)
  next.delete(modelId)
  selectedModels.value = next
}

function setModelAlias(modelId: string, alias: string): void {
  const next = new Map(selectedModels.value)
  next.set(modelId, alias)
  selectedModels.value = next
}

// ── 提交 ──────────────────────────────────────────────────────
const selectedModelList = computed(() => Array.from(selectedModels.value.keys()))
const isSubmitting = computed(() => saving.value || Boolean(props.submitting))

const canSubmit = computed(() => {
  if (!reusingCredential.value && !apiKey.value.trim()) return false
  return !!selectedCredential.value && selectedModels.value.size > 0
})

function buildModelConfig(modelId: string): ModelFormModelConfig {
  const ep = endpointForModel(modelId) ?? representativeEndpoint.value!
  const preset = modelPresetFor(modelId)
  return {
    modelName: modelId,
    displayName: selectedModels.value.get(modelId)?.trim() || '',
    endpointId: ep.id,
    endpointName: ep.name,
    protocol: ep.protocol,
    baseUrl: ep.base_url,
    chatCompletionsBaseUrl: ep.chat_completions_base_url,
    responsesBaseUrl: ep.responses_base_url,
    anthropicBaseUrl: ep.anthropic_base_url,
    resourceId: preset?.resource_id ?? ep.resource_id,
    voiceAdapter: ep.voice_adapter,
    ttsHttpUrl: ep.tts_http_url,
    ttsRealtimeUrl: ep.tts_realtime_url,
    ttsBidirectionalUrl: ep.tts_bidirectional_url,
    asrRealtimeUrl: ep.asr_realtime_url,
    asrAsyncUrl: ep.asr_async_url,
    ttsVoice: ep.tts_voice,
    ttsFormat: ep.tts_format,
    ttsSampleRate: ep.tts_sample_rate,
    capabilities: effectiveCapabilitiesForModel(modelId)
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || isSubmitting.value) return
  saving.value = true
  try {
    const cred = selectedCredential.value!
    const ep = selectedPrimaryModelEndpoint.value ?? representativeEndpoint.value!
    const models = selectedModelList.value
    const modelConfigs = models.map(buildModelConfig)
    const primaryDisplayName = modelConfigs[0]?.displayName || displayName.value.trim()
    emit('submit', {
      providerId: cred.provider.id,
      providerName: cred.provider.name,
      endpointId: ep.id,
      endpointName: ep.name,
      modelName: models[0],
      models,
      displayName: primaryDisplayName,
      protocol: ep.protocol,
      planType: cred.planType as LLMSetting['plan_type'],
      authType: ep.auth_type,
      keyHint: ep.key_hint,
      baseUrl: ep.base_url,
      chatCompletionsBaseUrl: ep.chat_completions_base_url,
      responsesBaseUrl: ep.responses_base_url,
      anthropicBaseUrl: ep.anthropic_base_url,
      resourceId: selectedPrimaryModelPreset.value?.resource_id ?? ep.resource_id,
      voiceAdapter: ep.voice_adapter,
      ttsHttpUrl: ep.tts_http_url,
      ttsRealtimeUrl: ep.tts_realtime_url,
      ttsBidirectionalUrl: ep.tts_bidirectional_url,
      asrRealtimeUrl: ep.asr_realtime_url,
      asrAsyncUrl: ep.asr_async_url,
      ttsVoice: ep.tts_voice,
      ttsFormat: ep.tts_format,
      ttsSampleRate: ep.tts_sample_rate,
      apiKey: reusingCredential.value ? '' : apiKey.value.trim(),
      reuseExistingApiKey: reusingCredential.value,
      isDefault: isDefault.value,
      isActive: isActive.value,
      capabilities: effectiveCapabilities.value,
      modelConfigs
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-5 p-5">
    <!-- ═══ 内置凭证列表（供应商+计费方式）══════════════════════ -->
    <div class="contents">
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-gray-400">{{
            t('settings.models.form.credentialType')
          }}</span>
          <div class="relative">
            <Search
              class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600"
            />
            <input
              v-model="searchQuery"
              class="h-8 w-44 rounded-lg border border-white/10 bg-[#343434] pl-7 pr-2 text-xs text-gray-200 outline-none focus:border-cyan-400/40"
              :placeholder="t('settings.models.form.search')"
            />
          </div>
        </div>

        <div
          class="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-white/8 bg-black/20 p-3"
        >
          <div v-for="group in groupedCredentials" :key="group.provider.id">
            <div
              class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500"
            >
              {{ group.provider.name }}
            </div>
            <div class="space-y-1.5">
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                :class="[
                  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all',
                  isSelectedCredentialOption(item)
                    ? 'border-cyan-400/50 bg-cyan-400/10 shadow-[0_0_16px_rgba(34,211,238,0.12)]'
                    : 'border-white/8 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                ]"
                @click="selectCredential(item)"
              >
                <span
                  :class="[
                    'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border',
                    isSelectedCredentialOption(item)
                      ? 'border-cyan-400 bg-cyan-400'
                      : 'border-white/25'
                  ]"
                >
                  <span
                    v-if="isSelectedCredentialOption(item)"
                    class="h-1.5 w-1.5 rounded-full bg-black"
                  />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-gray-200">
                    {{ localizedPlanLabel(item.planType) }}
                  </div>
                  <div class="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
                    <span>{{
                      t('settings.models.modelsCount', { count: item.models.length })
                    }}</span>
                    <span>·</span>
                    <span>{{
                      item.protocols.map(p => localizedProtocolLabel(p)).join(' / ')
                    }}</span>
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div v-if="!groupedCredentials.length" class="py-6 text-center text-xs text-gray-600">
            {{ t('settings.models.form.noCredentials') }}
          </div>
        </div>

        <!-- 底部信息：协议 + 接入地址 -->
        <div
          v-if="selectedCredential"
          class="mt-3 space-y-1.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5"
        >
          <div class="flex items-center gap-2 text-[11px] text-gray-500">
            <span>{{ t('settings.models.form.supportedProtocols') }}</span>
            <span
              v-for="p in selectedCredential.protocols"
              :key="p"
              class="rounded bg-white/5 px-1.5 py-0.5 text-gray-300"
              >{{ localizedProtocolLabel(p) }}</span
            >
          </div>
          <div
            v-for="row in endpointUrlRows"
            :key="row.label"
            class="flex items-center gap-2 text-[11px] text-gray-500"
          >
            <span>{{ row.label }}：</span>
            <span class="truncate font-mono text-gray-400">{{ row.value }}</span>
          </div>
          <template v-if="isArkVoiceCredential">
            <div class="flex items-center gap-2 text-[11px] text-gray-500">
              <span>TTS HTTP：</span>
              <span class="truncate font-mono text-gray-400">{{
                representativeEndpoint?.tts_http_url
              }}</span>
            </div>
            <div class="flex items-center gap-2 text-[11px] text-gray-500">
              <span>ASR Batch WS：</span>
              <span class="truncate font-mono text-gray-400">{{
                representativeEndpoint?.asr_realtime_url
              }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- ═══ 模型多选（catalog 预设 + 动态探测）════════════════ -->
      <div v-if="selectedCredential" class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-400">{{
            t('settings.models.form.availableModels')
          }}</span>
          <div class="flex items-center gap-2">
            <span v-if="probing" class="flex items-center gap-1 text-[11px] text-cyan-300/70">
              <Loader2 class="h-3 w-3 animate-spin" /> {{ t('settings.models.form.probing') }}
            </span>
            <span v-else-if="probedModels.length" class="text-[11px] text-emerald-300/60">
              {{ t('settings.models.form.probedCount', { count: probedModels.length }) }}
            </span>
            <button
              v-if="apiKey && !probing && !isArkVoiceCredential"
              type="button"
              class="flex items-center gap-1 text-[11px] text-gray-500 transition-colors hover:text-cyan-300"
              :title="t('settings.models.form.reprobe')"
              @click="runProbe"
            >
              <RefreshCw class="h-3 w-3" />
            </button>
            <span class="text-[11px] text-gray-500">{{
              t('settings.models.form.pendingCount', { count: selectedModels.size })
            }}</span>
          </div>
        </div>
        <div
          v-if="probeError"
          class="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-1.5 text-[11px] text-amber-300/70"
        >
          {{ t('settings.models.form.probeFailed', { error: probeError }) }}
        </div>
        <div v-if="availableDisplayModels.length" class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="m in availableDisplayModels"
            :key="m.id"
            type="button"
            :class="[
              'flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-all',
              m.probed
                ? 'border-emerald-400/25 bg-emerald-400/[0.04] text-emerald-200/75 hover:border-emerald-400/45'
                : 'border-white/10 bg-white/[0.02] text-gray-300 hover:border-cyan-400/35 hover:bg-cyan-400/[0.06]'
            ]"
            @click="addModel(m.id)"
          >
            <span class="min-w-0">
              <span class="block truncate">{{ m.display_name }}</span>
              <span v-if="m.probed" class="mt-0.5 block text-[9px] text-emerald-300/55">{{
                t('settings.models.form.probed')
              }}</span>
            </span>
            <span
              class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-cyan-300/25 bg-cyan-300/10 text-cyan-100"
            >
              <Plus class="h-3.5 w-3.5" />
            </span>
          </button>
        </div>
        <div
          v-else
          class="rounded-lg border border-white/8 bg-black/15 px-3 py-4 text-center text-xs text-gray-500"
        >
          {{ t('settings.models.form.allAdded') }}
        </div>

        <!-- 已配置模型列表（每个模型提交为一个独立配置，共用同一个 key）-->
        <div
          v-if="selectedModels.size > 0"
          class="space-y-2 rounded-lg border border-white/8 bg-black/20 p-3"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] text-gray-500">
              {{ t('settings.models.form.pendingConfigs') }}
            </div>
            <div class="text-[11px] text-gray-600">
              {{ t('settings.models.modelsCount', { count: selectedModels.size }) }}
            </div>
          </div>
          <div
            v-for="model in selectedModelRows"
            :key="model.id"
            class="grid gap-2 rounded-lg border border-white/8 bg-white/[0.025] p-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_32px]"
          >
            <span class="min-w-0 truncate py-1.5 text-sm text-gray-300" :title="model.id">
              {{ model.displayName }}
            </span>
            <input
              :value="model.alias"
              class="h-8 flex-1 rounded-md border border-white/10 bg-[#343434] px-2 text-xs text-gray-200 outline-none focus:border-cyan-400/40"
              :placeholder="t('settings.models.form.aliasPlaceholder')"
              @input="setModelAlias(model.id, ($event.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full border border-red-400/25 text-red-200/80 transition hover:bg-red-400/10 hover:text-red-100"
              :title="t('settings.models.form.removeModel')"
              @click="removeModel(model.id)"
            >
              <Minus class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ API Key ═════════════════════════════════════════════ -->
    <div
      v-if="reusingCredential"
      data-testid="reused-provider-credential"
      class="flex items-center gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-3 py-2.5"
    >
      <KeyRound class="h-4 w-4 flex-shrink-0 text-emerald-300/80" />
      <div class="min-w-0 flex-1">
        <div class="text-xs font-medium text-emerald-100/90">
          {{ t('settings.models.form.reuseCredential') }}
        </div>
        <div class="mt-0.5 truncate font-mono text-[11px] text-gray-500">
          {{ reusableCredentialDisplay }}
        </div>
      </div>
      <button
        type="button"
        class="flex-shrink-0 text-xs text-gray-400 transition-colors hover:text-gray-200"
        @click="useNewApiKey = true"
      >
        {{ t('settings.models.form.useDifferentKey') }}
      </button>
    </div>
    <label v-else class="block space-y-1">
      <span class="flex items-center justify-between gap-3 text-xs font-medium text-gray-400">
        <span>API Key</span>
        <button
          v-if="canReuseCredential"
          type="button"
          class="font-normal text-cyan-300/70 transition-colors hover:text-cyan-200"
          @click.prevent="useNewApiKey = false"
        >
          {{ t('settings.models.form.useSavedKey') }}
        </button>
      </span>
      <input
        v-model="apiKey"
        type="password"
        class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40"
        :placeholder="representativeEndpoint?.key_hint || 'sk-...'"
      />
    </label>

    <!-- ═══ 能力（自动填 + 手动微调）════════════════════════════ -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-gray-400">{{
          t('settings.models.form.capabilities')
        }}</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <span
          class="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-xs font-medium uppercase text-cyan-100"
          >{{ purpose }}</span
        >
        <template v-if="purpose === 'llm'">
          <CapabilityToggle
            capability="vision"
            :model-value="effectiveCapabilities.supports_image_input"
            @update:model-value="setCapability('supports_image_input', $event)"
          />
          <CapabilityToggle
            capability="audio"
            :model-value="effectiveCapabilities.supports_audio_input"
            @update:model-value="setCapability('supports_audio_input', $event)"
          />
          <CapabilityToggle
            capability="video"
            :model-value="effectiveCapabilities.supports_video_input"
            @update:model-value="setCapability('supports_video_input', $event)"
          />
        </template>
      </div>
    </div>

    <!-- ═══ 开关 ════════════════════════════════════════════════ -->
    <div class="flex items-center gap-6">
      <label class="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          v-model="isDefault"
          class="h-4 w-4 rounded border-white/20 bg-[#343434]"
        />
        <span class="text-sm text-gray-300">{{ t('settings.models.setDefault') }}</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          v-model="isActive"
          class="h-4 w-4 rounded border-white/20 bg-[#343434]"
        />
        <span class="text-sm text-gray-300">{{ t('settings.actions.enable') }}</span>
      </label>
    </div>

    <!-- ═══ 操作 ════════════════════════════════════════════════ -->
    <div class="flex justify-end gap-2 pt-2">
      <button
        type="button"
        class="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200"
        @click="emit('cancel')"
      >
        {{ t('settings.actions.cancel') }}
      </button>
      <button
        type="button"
        :disabled="!canSubmit || isSubmitting"
        :class="[
          'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all',
          canSubmit && !isSubmitting
            ? 'bg-cyan-500 text-white hover:bg-cyan-400'
            : 'cursor-not-allowed bg-gray-700 text-gray-500'
        ]"
        @click="submit"
      >
        <Loader2 v-if="isSubmitting" class="h-4 w-4 animate-spin" />
        {{ t('settings.actions.add') }}
      </button>
    </div>
  </div>
</template>

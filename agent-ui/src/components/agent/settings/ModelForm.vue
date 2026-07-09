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
import { Loader2, Minus, Plus, Search, RefreshCw } from 'lucide-vue-next'
import { probeModels } from '@/api/services/providers-api'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import type {
  Provider,
  ProviderEndpointPreset,
  ProviderModelPreset,
  ProviderProtocol,
} from '@/api/types/orchestration-v2.types'
import { protocolLabel, planLabel } from '@/lib/protocol-labels'
import CapabilityToggle from './CapabilityToggle.vue'

export interface ModelFormPayload {
  id?: string
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

const props = defineProps<{
  providers: Provider[]
  editing: LLMSetting | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', payload: ModelFormPayload): void
  (e: 'cancel'): void
}>()

// ── 状态 ──────────────────────────────────────────────────────
const isCustom = ref(false)
const customProviderId = ref('')
const customProviderName = ref('')
// 凭证选择：providerId + planType + endpoint boundary 唯一标识一个凭证类型
const selectedProviderId = ref('')
const selectedPlanType = ref<string>('')
const selectedEndpointId = ref('')  // 该 plan 下的代表 endpoint（用于取 base_url）
// 选中的模型 + 各自别名：modelId → alias（空字符串=无别名）
const selectedModels = ref<Map<string, string>>(new Map())
const displayName = ref('')
const apiKey = ref('')
const isDefault = ref(false)
const isActive = ref(true)
const saving = ref(false)

// 动态模型探测
const probing = ref(false)
const probedModels = ref<string[]>([])
const probeError = ref<string | null>(null)
let probeTimer: number | undefined
const searchQuery = ref('')

const customProtocol = ref<ProviderProtocol>('openai_compatible')
const customChatCompletionsBaseUrl = ref('')
const customResponsesBaseUrl = ref('')
const customAnthropicBaseUrl = ref('')
const customModelInput = ref('')

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function firstUrl(...values: Array<string | undefined>): string {
  return values.map(value => value?.trim()).find(Boolean) ?? ''
}

const customBaseUrl = computed(() => {
  if (customProtocol.value === 'anthropic_compatible') {
    return firstUrl(customAnthropicBaseUrl.value, customChatCompletionsBaseUrl.value, customResponsesBaseUrl.value)
  }
  return firstUrl(customChatCompletionsBaseUrl.value, customResponsesBaseUrl.value, customAnthropicBaseUrl.value)
})

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
  return ep?.protocol === 'volcengine_doubao_voice' ||
    ep?.protocol === 'volcengine_ark_voice' ||
    ep?.protocol === 'volcengine_openspeech' ||
    ep?.voice_adapter === 'volcengine_doubao_voice' ||
    ep?.voice_adapter === 'volcengine_ark_voice' ||
    ep?.voice_adapter === 'volcengine_openspeech'
}

function credentialBoundaryKey(ep: ProviderEndpointPreset): string {
  return [
    ep.plan_type,
    ep.auth_type ?? '',
    ep.key_hint ?? '',
    isArkVoiceEndpoint(ep) ? ep.voice_adapter ?? ep.protocol : 'llm',
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
        protocols,
      })
    }
  }
  return result
})

const filteredCredentials = computed<CredentialOption[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return allCredentials.value
  return allCredentials.value.filter(({ provider, planType }) => {
    return (
      provider.name.toLowerCase().includes(q) ||
      planLabel(planType).toLowerCase().includes(q)
    )
  })
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
  if (isCustom.value || !selectedProviderId.value || !selectedPlanType.value) return null
  return allCredentials.value.find(
    c => c.provider.id === selectedProviderId.value &&
      c.planType === selectedPlanType.value &&
      (!selectedEndpointId.value || c.endpoints.some(ep => ep.id === selectedEndpointId.value))
  ) ?? null
})

function isSelectedCredentialOption(item: CredentialOption): boolean {
  return selectedProviderId.value === item.provider.id &&
    selectedPlanType.value === item.planType &&
    item.endpoints.some(ep => ep.id === selectedEndpointId.value)
}

function endpointForModel(modelId: string, cred = selectedCredential.value): ProviderEndpointPreset | null {
  if (!cred) return null
  return cred.endpoints.find(ep => ep.models.some(model => model.id === modelId)) ?? cred.endpoints[0] ?? null
}

const selectedPrimaryModelEndpoint = computed<ProviderEndpointPreset | null>(() => {
  const firstModel = Array.from(selectedModels.value.keys())[0]
  return firstModel ? endpointForModel(firstModel) : null
})

// 凭证下的代表 endpoint（用于 base_url，取第一个）
const representativeEndpoint = computed<ProviderEndpointPreset | null>(() => {
  return selectedPrimaryModelEndpoint.value ?? selectedCredential.value?.endpoints[0] ?? null
})

const endpointUrlRows = computed(() => {
  const ep = representativeEndpoint.value
  if (!ep) return []
  return [
    { label: 'Chat Completions', value: ep.chat_completions_base_url || ep.base_url },
    { label: 'OpenAI Responses', value: ep.responses_base_url },
    { label: 'Anthropic Messages', value: ep.anthropic_base_url },
  ].filter(row => Boolean(row.value))
})

const selectedModelPresets = computed(() => {
  const cred = selectedCredential.value
  if (!cred) return []
  const selected = new Set(Array.from(selectedModels.value.keys()))
  return cred.models.filter(model => selected.has(model.id))
})

const selectedPrimaryModelPreset = computed(() => selectedModelPresets.value[0] ?? null)

function modelPresetFor(modelId: string, cred = selectedCredential.value): ProviderModelPreset | null {
  return cred?.models.find(model => model.id === modelId) ?? null
}

const isArkVoiceCredential = computed(() => isArkVoiceEndpoint(representativeEndpoint.value))

// ── 合并模型列表：catalog 预设 + probe 发现的新模型 ──────────
// probe 发现但 catalog 没有的模型追加到末尾（标为"探测"）
interface DisplayModel {
  id: string
  display_name: string
  probed: boolean  // 是否来自动态探测（非 catalog 预设）
}

const displayModels = computed<DisplayModel[]>(() => {
  const cred = selectedCredential.value
  if (!cred) return []
  const result: DisplayModel[] = cred.models.map(m => ({
    id: m.id,
    display_name: m.display_name || m.id,
    probed: false,
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
      probed: Boolean(display?.probed),
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
    probeError.value = e?.message || '探测失败'
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
  if (!key?.trim() || isCustom.value || isArkVoiceCredential.value) return
  probeTimer = window.setTimeout(() => { void runProbe() }, 600)
})

function endpointDefaultCapabilities(ep?: ProviderEndpointPreset | null): ModelCapabilities {
  return {
    supports_llm: ep?.supports_llm ?? true,
    supports_asr: ep?.supports_asr ?? false,
    supports_tts: ep?.supports_tts ?? false,
    supports_audio_input: ep?.supports_audio_input ?? false,
    supports_image_input: ep?.supports_image_input ?? false,
    supports_video_input: ep?.supports_video_input ?? false,
  }
}

function modelBaseCapabilities(modelId: string): ModelCapabilities {
  const preset = modelPresetFor(modelId)
  if (!preset) return endpointDefaultCapabilities(endpointForModel(modelId))
  return {
    supports_llm: preset.supports_llm !== false,
    supports_asr: Boolean(preset.supports_asr),
    supports_tts: Boolean(preset.supports_tts),
    supports_audio_input: Boolean(preset.supports_audio_input),
    supports_image_input: Boolean(preset.supports_image_input),
    supports_video_input: Boolean(preset.supports_video_input),
  }
}

function mergeCapabilities(models: ModelCapabilities[]): ModelCapabilities {
  if (!models.length) return {
    supports_llm: true, supports_asr: false, supports_tts: false,
    supports_audio_input: false, supports_image_input: false, supports_video_input: false,
  }
  return {
    supports_llm: models.some(capabilities => capabilities.supports_llm),
    supports_asr: models.some(capabilities => capabilities.supports_asr),
    supports_tts: models.some(capabilities => capabilities.supports_tts),
    supports_audio_input: models.some(capabilities => capabilities.supports_audio_input),
    supports_image_input: models.some(capabilities => capabilities.supports_image_input),
    supports_video_input: models.some(capabilities => capabilities.supports_video_input),
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
  ...capabilityOverrides.value,
}))

function setCapability(key: keyof ModelCapabilities, value: boolean): void {
  capabilityOverrides.value = { ...capabilityOverrides.value, [key]: value }
}

function effectiveCapabilitiesForModel(modelId: string): ModelCapabilities {
  return {
    ...modelBaseCapabilities(modelId),
    ...capabilityOverrides.value,
  }
}

// ── 凭证选择 ─────────────────────────────────────────────────
function selectCredential(opt: CredentialOption): void {
  isCustom.value = false
  selectedProviderId.value = opt.provider.id
  selectedPlanType.value = opt.planType
  selectedEndpointId.value = opt.endpoints[0]?.id ?? ''
  // 默认不选中任何模型，用户自行点选（去掉推荐逻辑）
  selectedModels.value = new Map()
  capabilityOverrides.value = {}
}

function addModel(modelId: string): void {
  if (selectedModels.value.has(modelId)) return
  const next = new Map(selectedModels.value)
  next.set(modelId, '')  // 初始别名空
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

// ── 自定义供应商 ──────────────────────────────────────────────
function enableCustomMode(): void {
  isCustom.value = true
  selectedProviderId.value = ''
  selectedPlanType.value = ''
  selectedModels.value = new Map()
  customProviderId.value = ''
  customProviderName.value = ''
  customProtocol.value = 'openai_compatible'
  customChatCompletionsBaseUrl.value = ''
  customResponsesBaseUrl.value = ''
  customAnthropicBaseUrl.value = ''
  customModelInput.value = ''
}

// ── 编辑回填 ──────────────────────────────────────────────────
function loadEditing(setting: LLMSetting): void {
  const provider = props.providers.find(p => p.id === setting.provider_id)
  const hasEndpoints = (provider?.endpoints?.length ?? 0) > 0
  isCustom.value = !hasEndpoints
  apiKey.value = ''
  displayName.value = setting.display_name ?? ''
  isDefault.value = setting.is_default
  isActive.value = setting.is_active

  if (hasEndpoints) {
    selectedProviderId.value = setting.provider_id
    selectedPlanType.value = setting.plan_type
    // 回填选中的模型；单配置编辑时把 display_name 放进第一个模型别名。
    const models = setting.models ?? [setting.model_name]
    selectedModels.value = new Map(models.map((m: string, index: number) => [
      m,
      index === 0 ? setting.display_name ?? '' : '',
    ]))
    // 找代表 endpoint
    const ep = provider?.endpoints?.find(e => e.id === setting.endpoint_id)
      ?? provider?.endpoints?.find(e => e.plan_type === setting.plan_type)
      ?? provider?.endpoints?.[0]
    selectedEndpointId.value = ep?.id ?? ''
    capabilityOverrides.value = {
      supports_llm: setting.supports_llm,
      supports_asr: setting.supports_asr,
      supports_tts: setting.supports_tts,
      supports_audio_input: setting.supports_audio_input,
      supports_image_input: setting.supports_image_input,
      supports_video_input: setting.supports_video_input,
    }
  } else {
    customProviderId.value = setting.provider_id
    customProviderName.value = setting.provider_name ?? provider?.name ?? ''
    customProtocol.value = setting.protocol
    const fallbackBaseUrl = setting.base_url ?? ''
    customChatCompletionsBaseUrl.value = setting.chat_completions_base_url ??
      (setting.protocol === 'openai_compatible' ? fallbackBaseUrl : '')
    customResponsesBaseUrl.value = setting.responses_base_url ?? ''
    customAnthropicBaseUrl.value = setting.anthropic_base_url ??
      (setting.protocol === 'anthropic_compatible' ? fallbackBaseUrl : '')
    customModelInput.value = setting.model_name
  }
}

function reset(): void {
  isCustom.value = false
  selectedProviderId.value = ''
  selectedPlanType.value = ''
  selectedEndpointId.value = ''
  selectedModels.value = new Map()
  displayName.value = ''
  apiKey.value = ''
  isDefault.value = false
  isActive.value = true
  searchQuery.value = ''
  capabilityOverrides.value = {}
  customProviderId.value = ''
  customProviderName.value = ''
  customProtocol.value = 'openai_compatible'
  customChatCompletionsBaseUrl.value = ''
  customResponsesBaseUrl.value = ''
  customAnthropicBaseUrl.value = ''
  customModelInput.value = ''
}

watch(() => props.editing, (setting) => {
  if (setting) loadEditing(setting)
  else reset()
}, { immediate: true })

// ── 提交 ──────────────────────────────────────────────────────
const selectedModelList = computed(() => Array.from(selectedModels.value.keys()))
const isSubmitting = computed(() => saving.value || Boolean(props.submitting))

const canSubmit = computed(() => {
  if (!props.editing && !apiKey.value.trim()) return false
  if (isCustom.value) {
    return !!(customProviderId.value.trim()) && !!customBaseUrl.value && !!customModelInput.value.trim()
  }
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
    capabilities: effectiveCapabilitiesForModel(modelId),
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value || isSubmitting.value) return
  saving.value = true
  try {
    if (isCustom.value) {
      const pid = customProviderId.value.trim()
      emit('submit', {
        id: props.editing?.id,
        providerId: pid,
        providerName: customProviderName.value.trim() || pid,
        endpointId: `${pid}_custom`,
        endpointName: 'custom',
        modelName: customModelInput.value.trim(),
        displayName: displayName.value.trim(),
        protocol: customProtocol.value,
        planType: 'custom',
        baseUrl: customBaseUrl.value,
        chatCompletionsBaseUrl: trimmedOrUndefined(customChatCompletionsBaseUrl.value),
        responsesBaseUrl: trimmedOrUndefined(customResponsesBaseUrl.value),
        anthropicBaseUrl: trimmedOrUndefined(customAnthropicBaseUrl.value),
        apiKey: apiKey.value.trim(),
        isDefault: isDefault.value,
        isActive: isActive.value,
        capabilities: {
          supports_llm: true, supports_asr: false, supports_tts: false,
          supports_audio_input: false, supports_image_input: false, supports_video_input: false,
        },
      })
    } else {
      const cred = selectedCredential.value!
      const ep = selectedPrimaryModelEndpoint.value ?? representativeEndpoint.value!
      const models = selectedModelList.value
      const modelConfigs = models.map(buildModelConfig)
      const primaryDisplayName = modelConfigs[0]?.displayName || displayName.value.trim()
      emit('submit', {
        id: props.editing?.id,
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
        apiKey: apiKey.value.trim(),
        isDefault: isDefault.value,
        isActive: isActive.value,
        capabilities: effectiveCapabilities.value,
        modelConfigs,
      })
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-5 p-5">
    <!-- ═══ 内置凭证列表（供应商+计费方式）══════════════════════ -->
    <template v-if="!isCustom">
      <div>
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-gray-400">选择凭证类型</span>
          <div class="relative">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
            <input
              v-model="searchQuery"
              class="h-8 w-44 rounded-lg border border-white/10 bg-[#343434] pl-7 pr-2 text-xs text-gray-200 outline-none focus:border-cyan-400/40"
              placeholder="搜索供应商/计费..."
            />
          </div>
        </div>

        <div class="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-white/8 bg-black/20 p-3">
          <div v-for="group in groupedCredentials" :key="group.provider.id">
            <div class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
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
                  <span v-if="isSelectedCredentialOption(item)" class="h-1.5 w-1.5 rounded-full bg-black" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-gray-200">{{ planLabel(item.planType) }}</div>
                  <div class="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
                    <span>{{ item.models.length }} 个模型</span>
                    <span>·</span>
                    <span>{{ item.protocols.map(p => protocolLabel(p)).join(' / ') }}</span>
                  </div>
                </div>
              </button>
            </div>
          </div>

          <div v-if="!groupedCredentials.length" class="py-6 text-center text-xs text-gray-600">
            无匹配的凭证
          </div>
        </div>

        <!-- 底部信息：协议 + 接入地址 -->
        <div v-if="selectedCredential" class="mt-3 space-y-1.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5">
          <div class="flex items-center gap-2 text-[11px] text-gray-500">
            <span>支持协议：</span>
            <span
              v-for="p in selectedCredential.protocols"
              :key="p"
              class="rounded bg-white/5 px-1.5 py-0.5 text-gray-300"
            >{{ protocolLabel(p) }}</span>
          </div>
          <div v-for="row in endpointUrlRows" :key="row.label" class="flex items-center gap-2 text-[11px] text-gray-500">
            <span>{{ row.label }}：</span>
            <span class="truncate font-mono text-gray-400">{{ row.value }}</span>
          </div>
          <template v-if="isArkVoiceCredential">
            <div class="flex items-center gap-2 text-[11px] text-gray-500">
              <span>TTS HTTP：</span>
              <span class="truncate font-mono text-gray-400">{{ representativeEndpoint?.tts_http_url }}</span>
            </div>
            <div class="flex items-center gap-2 text-[11px] text-gray-500">
              <span>ASR Batch WS：</span>
              <span class="truncate font-mono text-gray-400">{{ representativeEndpoint?.asr_realtime_url }}</span>
            </div>
          </template>
        </div>

        <button
          type="button"
          class="mt-3 flex items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-300"
          @click="enableCustomMode"
        >
          <Plus class="h-3.5 w-3.5" />
          新建自定义供应商
        </button>
      </div>

      <!-- ═══ 模型多选（catalog 预设 + 动态探测）════════════════ -->
      <div v-if="selectedCredential" class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-400">{{ editing ? '当前模型' : '可添加模型' }}</span>
          <div v-if="!editing" class="flex items-center gap-2">
            <span v-if="probing" class="flex items-center gap-1 text-[11px] text-cyan-300/70">
              <Loader2 class="h-3 w-3 animate-spin" /> 探测中...
            </span>
            <span v-else-if="probedModels.length" class="text-[11px] text-emerald-300/60">
              已探测 {{ probedModels.length }} 个
            </span>
            <button
              v-if="apiKey && !probing && !isArkVoiceCredential"
              type="button"
              class="flex items-center gap-1 text-[11px] text-gray-500 transition-colors hover:text-cyan-300"
              title="重新探测可用模型"
              @click="runProbe"
            >
              <RefreshCw class="h-3 w-3" />
            </button>
            <span class="text-[11px] text-gray-500">待创建 {{ selectedModels.size }}</span>
          </div>
        </div>
        <div v-if="!editing && probeError" class="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-1.5 text-[11px] text-amber-300/70">
          探测失败：{{ probeError }}（仍可从下方预设模型选择）
        </div>
        <div v-if="!editing && availableDisplayModels.length" class="grid gap-2 sm:grid-cols-2">
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
              <span v-if="m.probed" class="mt-0.5 block text-[9px] text-emerald-300/55">探测</span>
            </span>
            <span class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-cyan-300/25 bg-cyan-300/10 text-cyan-100">
              <Plus class="h-3.5 w-3.5" />
            </span>
          </button>
        </div>
        <div v-else-if="!editing" class="rounded-lg border border-white/8 bg-black/15 px-3 py-4 text-center text-xs text-gray-500">
          该凭证下模型已全部加入下方配置列表。
        </div>

        <!-- 已配置模型列表（每个模型提交为一个独立配置，共用同一个 key）-->
        <div v-if="selectedModels.size > 0" class="space-y-2 rounded-lg border border-white/8 bg-black/20 p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[11px] text-gray-500">{{ editing ? '模型配置' : '待创建模型配置（共用上方 API Key）' }}</div>
            <div class="text-[11px] text-gray-600">{{ selectedModels.size }} 个</div>
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
              placeholder="别名（留空用模型 ID）"
              @input="setModelAlias(model.id, ($event.target as HTMLInputElement).value)"
            />
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full border border-red-400/25 text-red-200/80 transition hover:bg-red-400/10 hover:text-red-100"
              title="移除此模型配置"
              @click="removeModel(model.id)"
            >
              <Minus class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ═══ 自定义供应商 ═════════════════════════════════════════ -->
    <template v-else>
      <div class="space-y-3 rounded-xl border border-white/8 bg-black/20 p-4">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-400">自定义供应商</span>
          <button
            type="button"
            class="text-xs text-cyan-300/70 hover:text-cyan-200"
            @click="reset"
          >
            ← 返回内置列表
          </button>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="space-y-1">
            <span class="text-xs text-gray-500">Provider ID</span>
            <input v-model="customProviderId" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="例如 custom-openai" />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-gray-500">显示名称</span>
            <input v-model="customProviderName" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="例如 Custom OpenAI" />
          </label>
        </div>
        <label class="space-y-1">
          <span class="text-xs text-gray-500">API 格式</span>
          <select v-model="customProtocol" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40">
            <option value="openai_compatible">Chat Completions</option>
            <option value="anthropic_compatible">Anthropic</option>
          </select>
        </label>
        <div class="grid gap-3">
          <label class="space-y-1">
            <span class="text-xs text-gray-500">Chat Completions URL</span>
            <input v-model="customChatCompletionsBaseUrl" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="https://api.example.com/v1" />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-gray-500">OpenAI Responses URL</span>
            <input v-model="customResponsesBaseUrl" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="https://api.example.com/v1/responses" />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-gray-500">Anthropic Messages URL</span>
            <input v-model="customAnthropicBaseUrl" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="https://api.example.com/anthropic" />
          </label>
        </div>
        <label class="space-y-1">
          <span class="text-xs text-gray-500">模型名称</span>
          <input v-model="customModelInput" class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40" placeholder="模型 ID" />
        </label>
      </div>
    </template>

    <!-- ═══ API Key ═════════════════════════════════════════════ -->
    <label class="block space-y-1">
      <span class="text-xs font-medium text-gray-400">API Key</span>
      <input
        v-model="apiKey"
        type="password"
        class="h-10 w-full rounded-lg border border-white/10 bg-[#343434] px-3 text-sm outline-none focus:border-cyan-400/40"
        :placeholder="editing ? '留空则保留原 Key' : (representativeEndpoint?.key_hint || 'sk-...')"
      />
    </label>

    <!-- ═══ 能力（自动填 + 手动微调）════════════════════════════ -->
    <div v-if="!isCustom" class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-gray-400">模型能力</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <CapabilityToggle capability="llm" :model-value="effectiveCapabilities.supports_llm" @update:model-value="setCapability('supports_llm', $event)" />
        <CapabilityToggle capability="vision" :model-value="effectiveCapabilities.supports_image_input" @update:model-value="setCapability('supports_image_input', $event)" />
        <CapabilityToggle capability="asr" :model-value="effectiveCapabilities.supports_asr" @update:model-value="setCapability('supports_asr', $event)" />
        <CapabilityToggle capability="tts" :model-value="effectiveCapabilities.supports_tts" @update:model-value="setCapability('supports_tts', $event)" />
        <CapabilityToggle capability="audio" :model-value="effectiveCapabilities.supports_audio_input" @update:model-value="setCapability('supports_audio_input', $event)" />
        <CapabilityToggle capability="video" :model-value="effectiveCapabilities.supports_video_input" @update:model-value="setCapability('supports_video_input', $event)" />
      </div>
    </div>

    <!-- ═══ 开关 ════════════════════════════════════════════════ -->
    <div class="flex items-center gap-6">
      <label class="flex cursor-pointer items-center gap-2">
        <input type="checkbox" v-model="isDefault" class="h-4 w-4 rounded border-white/20 bg-[#343434]" />
        <span class="text-sm text-gray-300">设为默认</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2">
        <input type="checkbox" v-model="isActive" class="h-4 w-4 rounded border-white/20 bg-[#343434]" />
        <span class="text-sm text-gray-300">启用</span>
      </label>
    </div>

    <!-- ═══ 操作 ════════════════════════════════════════════════ -->
    <div class="flex justify-end gap-2 pt-2">
      <button type="button" class="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200" @click="emit('cancel')">
        取消
      </button>
      <button
        type="button"
        :disabled="!canSubmit || isSubmitting"
        :class="[
          'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all',
          canSubmit && !isSubmitting ? 'bg-cyan-500 text-white hover:bg-cyan-400' : 'cursor-not-allowed bg-gray-700 text-gray-500'
        ]"
        @click="submit"
      >
        <Loader2 v-if="isSubmitting" class="h-4 w-4 animate-spin" />
        {{ editing ? '保存' : '添加' }}
      </button>
    </div>
  </div>
</template>

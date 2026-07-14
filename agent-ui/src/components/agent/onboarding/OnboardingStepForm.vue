<script setup lang="ts">
/**
 * OnboardingStepForm — 新手引导单步最小配置表单。
 *
 * 支持两种模式：
 *   1. 内置凭证（供应商+计费）：选凭证 → 选模型 → 填 API Key。
 *      base_url / 协议 / asr·tts URL 从 preset 自动带出。
 *   2. 自定义 / 本地部署：直接填接入地址 + 模型名 +（可选）Key。
 *      适用于本地部署的 ASR/TTS，或任何未内置预设的服务。
 */

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Eye, EyeOff, Server, Package } from 'lucide-vue-next'
import { agentSettingsApi } from '@/api/agent'
import { probeModels } from '@/api/services/providers-api'
import { useToast } from '@/components/controls/useToast'
import { createProtocolLabels } from '@/lib/protocol-labels'
import { cn } from '@/lib/utils'
import type {
  Provider,
  ProviderEndpointPreset,
  ProviderModelPreset,
  ProviderProtocol,
} from '@/api/types/orchestration-v2.types'
import type { LLMSetting } from '@/api/services/llm-settings-api'

type CapabilityKey = 'supports_llm' | 'supports_asr' | 'supports_tts'

const props = defineProps<{
  capability: CapabilityKey
  providers: Provider[]
  /** 已配置的 settings，用于"复用已有 key"派生新能力模型 */
  existingSettings?: LLMSetting[]
}>()

const emit = defineEmits<{
  (e: 'created', setting?: LLMSetting): void
}>()

const { showToast } = useToast()
const { t } = useI18n()
const { planLabel: localizedPlanLabel } = createProtocolLabels(t)

function capabilityLabel(capability: CapabilityKey): string {
  if (capability === 'supports_llm') return t('onboarding.form.capabilities.llm')
  if (capability === 'supports_asr') return t('onboarding.form.capabilities.asr')
  return t('onboarding.form.capabilities.tts')
}

// ── 模式切换 ──────────────────────────────────────────────────
type Mode = 'preset' | 'custom'
const mode = ref<Mode>('preset')

// ── 模型能力判断 ──────────────────────────────────────────────
function modelSupports(m: ProviderModelPreset, cap: CapabilityKey): boolean {
  return cap === 'supports_llm' ? m.supports_llm !== false : Boolean(m[cap])
}

function selectedCapabilityFlags(
  endpoint: ProviderEndpointPreset,
  modelPreset: ProviderModelPreset | null,
): Pick<LLMSetting,
  'supports_llm' |
  'supports_asr' |
  'supports_tts' |
  'supports_audio_input' |
  'supports_image_input' |
  'supports_video_input'
> {
  const isLlm = props.capability === 'supports_llm'
  const isAsr = props.capability === 'supports_asr'
  const isTts = props.capability === 'supports_tts'
  const modelOrEndpoint = (key: keyof ProviderModelPreset & keyof ProviderEndpointPreset) =>
    Boolean(modelPreset?.[key] ?? endpoint[key] ?? false)

  return {
    supports_llm: isLlm,
    supports_asr: isAsr,
    supports_tts: isTts,
    supports_audio_input: isLlm || isAsr ? modelOrEndpoint('supports_audio_input') : false,
    supports_image_input: isLlm ? modelOrEndpoint('supports_image_input') : false,
    supports_video_input: isLlm ? modelOrEndpoint('supports_video_input') : false,
  }
}

// ── 内置预设凭证聚合（按能力过滤）──────────────────────────────
interface CredentialOption {
  key: string
  provider: Provider
  planType: string
  endpoints: ProviderEndpointPreset[]
  models: ProviderModelPreset[]
}

const credentials = computed<CredentialOption[]>(() => {
  const result: CredentialOption[] = []
  for (const provider of props.providers) {
    if (!provider.endpoints?.length) continue
    const byPlan = new Map<string, ProviderEndpointPreset[]>()
    for (const ep of provider.endpoints) {
      const hasCapModel = ep.models.some(m => modelSupports(m, props.capability))
      if (!hasCapModel) continue
      if (!byPlan.has(ep.plan_type)) byPlan.set(ep.plan_type, [])
      byPlan.get(ep.plan_type)!.push(ep)
    }
    for (const [planType, endpoints] of byPlan) {
      const modelMap = new Map<string, ProviderModelPreset>()
      for (const ep of endpoints) {
        for (const m of ep.models) {
          if (modelSupports(m, props.capability) && !modelMap.has(m.id)) {
            modelMap.set(m.id, m)
          }
        }
      }
      result.push({
        key: `${provider.id}::${planType}`,
        provider,
        planType,
        endpoints,
        models: Array.from(modelMap.values()),
      })
    }
  }
  return result
})

// ── credential 已有 key 检测 ───────────────────────────────────
// Key 的复用边界是具体 credential/endpoint，不是 provider。
// 例如 Xiaomi 的 API 计费和 Token Plan 是不同 credential，不能互相复用。
function maskedKeyForCredential(
  credential: CredentialOption,
  endpoint?: ProviderEndpointPreset | null,
): string | undefined {
  const existing = props.existingSettings ?? []
  const endpointIds = new Set((endpoint ? [endpoint] : credential.endpoints).map(ep => ep.id))
  const hit = existing.find(s =>
    s.is_active &&
    s.provider_id === credential.provider.id &&
    s.api_key_display &&
    (
      (s.endpoint_id && endpointIds.has(s.endpoint_id)) ||
      (!s.endpoint_id && s.plan_type === credential.planType)
    )
  )
  return hit?.api_key_display
}

// ── 表单状态 ──────────────────────────────────────────────────
const selectedCredentialKey = ref('')
const selectedModelId = ref('')
const apiKey = ref('')
const showKey = ref(false)
const saving = ref(false)
const probedModels = ref<string[]>([])
let probeTimer: number | undefined

const selectedCredential = computed<CredentialOption | null>(() => {
  if (!selectedCredentialKey.value) return null
  return credentials.value.find(c => c.key === selectedCredentialKey.value) ?? null
})

// 当前所选 credential 是否已配置过 key
const selectedCredentialHasKey = computed(() => {
  const cred = selectedCredential.value
  if (!cred) return false
  return Boolean(maskedKeyForCredential(cred, selectedEndpoint.value))
})
const selectedMaskedKey = computed(() => {
  const cred = selectedCredential.value
  if (!cred) return undefined
  return maskedKeyForCredential(cred, selectedEndpoint.value)
})

const displayModels = computed(() => {
  const cred = selectedCredential.value
  if (!cred) return []
  const result = cred.models.map(m => ({ id: m.id, display_name: m.display_name || m.id, recommended: Boolean(m.recommended) }))
  const known = new Set(result.map(m => m.id))
  for (const id of probedModels.value) {
    if (!known.has(id)) result.push({ id, display_name: id, recommended: false })
  }
  return result
})

const selectedEndpoint = computed<ProviderEndpointPreset | null>(() => {
  const cred = selectedCredential.value
  if (!cred) return null
  if (selectedModelId.value) {
    const hit = cred.endpoints.find(ep => ep.models.some(m => m.id === selectedModelId.value))
    if (hit) return hit
  }
  return cred.endpoints[0] ?? null
})

const selectedModelPreset = computed(() => {
  const cred = selectedCredential.value
  if (!cred || !selectedModelId.value) return null
  return cred.models.find(m => m.id === selectedModelId.value) ?? null
})

function credentialLabel(c: CredentialOption): string {
  const hasKey = Boolean(maskedKeyForCredential(c))
  return `${c.provider.name} · ${localizedPlanLabel(c.planType)}${hasKey ? ` (${t('onboarding.form.existingKey')})` : ''}`
}

function selectCredential(key: string): void {
  selectedCredentialKey.value = key
  const cred = credentials.value.find(c => c.key === selectedCredentialKey.value)
  if (!cred) { selectedModelId.value = ''; return }
  const rec = cred.models.find(m => m.recommended) ?? cred.models[0]
  selectedModelId.value = rec?.id ?? ''
  // 切换凭证时清空手动 key（若该 credential 已有 key 会自动复用）
  apiKey.value = ''
}

// ── 自定义 / 本地部署表单状态 ─────────────────────────────────
// 本地 OpenAI Audio 服务从 /v1 Base URL 派生标准 HTTP/WS 端点并持久化。
interface CustomFields {
  baseUrl: string  // vLLM OpenAI 兼容接入地址（不含 /v1）
  model: string
  voice: string    // TTS 可选音色
}

const customFields = ref<CustomFields>({
  baseUrl: '',
  model: '',
  voice: '',
})

function voiceApiBase(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function voiceEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, '')}`
}

// 自定义凭证的元信息
const customProviderId = computed(() => `local-${props.capability.replace('supports_', '')}`)
const customProviderName = computed(() => t('onboarding.form.localProvider', { capability: capabilityLabel(props.capability) }))

// 各能力的字段配置 + 示例（基于本地 vLLM 部署实测）
const customFieldConfig = computed(() => {
  if (props.capability === 'supports_llm') {
    return {
      baseUrlPlaceholder: 'http://localhost/v1',
      modelPlaceholder: 'qwen3.6',
      baseUrlHint: t('onboarding.form.llmBaseHint'),
      modelHint: t('onboarding.form.llmModelHint'),
      defaultModel: 'qwen3.6',
    }
  }
  if (props.capability === 'supports_asr') {
    return {
      baseUrlPlaceholder: 'http://localhost/v1',
      modelPlaceholder: 'qwen3-asr-realtime',
      baseUrlHint: t('onboarding.form.asrBaseHint'),
      modelHint: t('onboarding.form.modelHint'),
      defaultModel: 'qwen3-asr-realtime',
    }
  }
  // tts
  return {
    baseUrlPlaceholder: 'http://localhost/v1',
    modelPlaceholder: 'qwen3-tts',
    baseUrlHint: t('onboarding.form.ttsBaseHint'),
    modelHint: t('onboarding.form.modelHint'),
    defaultModel: 'qwen3-tts',
  }
})

// 切换能力时重置自定义字段 + 预填默认模型
watch(() => props.capability, () => {
  customFields.value = { baseUrl: '', model: customFieldConfig.value.defaultModel, voice: '' }
}, { immediate: true })

// ── 动态探测（内置模式，key 填入后）──────────────────────────
async function runProbe(): Promise<void> {
  const ep = selectedEndpoint.value
  if (!ep || !apiKey.value.trim()) return
  const baseUrl = ep.chat_completions_base_url || ep.base_url
  if (!baseUrl) return
  try {
    const result = await probeModels(baseUrl, apiKey.value.trim())
    probedModels.value = result.models
  } catch {
    probedModels.value = []
  }
}

watch([apiKey, selectedCredentialKey], () => {
  if (probeTimer) window.clearTimeout(probeTimer)
  probedModels.value = []
  if (!apiKey.value.trim() || !selectedCredential.value) return
  probeTimer = window.setTimeout(() => { void runProbe() }, 600)
})

// ── 校验 ──────────────────────────────────────────────────────
// credential 已有 key 时只需选模型；否则需模型 + key
const presetCanSubmit = computed(() => {
  if (!selectedCredential.value || !selectedModelId.value) return false
  if (selectedCredentialHasKey.value) return true
  return apiKey.value.trim().length > 0
})

// 自定义模式：base_url 必填；model 在 LLM/ASR/TTS 下都必填（有默认值预填）
const customCanSubmit = computed(() => {
  return customFields.value.baseUrl.trim().length > 0 && customFields.value.model.trim().length > 0
})

const canSubmit = computed(() => mode.value === 'preset' ? presetCanSubmit.value : customCanSubmit.value)

// ── 提交 ──────────────────────────────────────────────────────
async function submit(): Promise<void> {
  if (!canSubmit.value || saving.value) return
  saving.value = true
  try {
    const setting =
      mode.value === 'preset'
        ? await submitPreset()
        : await submitCustom()
    showToast(t('onboarding.form.added', { capability: capabilityLabel(props.capability) }), 'success')
    emit('created', setting)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('onboarding.form.saveFailed')
    showToast(message, 'error', 6000)
  } finally {
    saving.value = false
  }
}

async function submitPreset(): Promise<LLMSetting | undefined> {
  const cred = selectedCredential.value
  const ep = selectedEndpoint.value
  const modelId = selectedModelId.value
  if (!cred || !ep || !modelId) return

  const mp = selectedModelPreset.value
  const caps = selectedCapabilityFlags(ep, mp)

  // 同 credential/endpoint 的模型共用一个 key；不同计费方式不互相复用。
  const reuseExistingApiKey = selectedCredentialHasKey.value

  const displayName = `${cred.provider.name} ${capabilityLabel(props.capability)}`

  const res = await agentSettingsApi.createLLMSetting({
    provider_id: cred.provider.id,
    model_name: modelId,
    models: [modelId],
    display_name: displayName,
    endpoint_id: ep.id,
    endpoint_name: ep.name,
    plan_type: cred.planType as LLMSetting['plan_type'],
    protocol: ep.protocol,
    auth_type: ep.auth_type,
    key_hint: ep.key_hint,
    base_url: ep.base_url,
    chat_completions_base_url: ep.chat_completions_base_url,
    anthropic_base_url: ep.anthropic_base_url,
    resource_id: mp?.resource_id ?? ep.resource_id,
    voice_adapter: ep.voice_adapter,
    tts_http_url: ep.tts_http_url,
    tts_realtime_url: ep.tts_realtime_url,
    tts_bidirectional_url: ep.tts_bidirectional_url,
    asr_realtime_url: ep.asr_realtime_url,
    asr_async_url: ep.asr_async_url,
    tts_voice: ep.tts_voice,
    tts_format: ep.tts_format,
    tts_sample_rate: ep.tts_sample_rate,
    ...(reuseExistingApiKey
      ? { reuse_existing_api_key: true }
      : { api_key: apiKey.value.trim() }),
    is_default: props.capability === 'supports_llm',
    is_active: true,
    ...caps,
  })
  return res.data
}

async function submitCustom(): Promise<LLMSetting | undefined> {
  const f = customFields.value
  const pid = customProviderId.value
  const pname = customProviderName.value
  const model = f.model.trim()
  const displayName = `${pname} · ${model}`
  const rawBaseUrl = f.baseUrl.trim()
  const baseUrl = props.capability === 'supports_llm' ? rawBaseUrl : voiceApiBase(rawBaseUrl)

  // 本地语音服务使用 OpenAI Audio 兼容协议，并保存可覆盖的标准 HTTP/WS 端点。
  const protocol: ProviderProtocol = 'openai_compatible'

  const caps = {
    supports_llm: props.capability === 'supports_llm',
    supports_asr: props.capability === 'supports_asr',
    supports_tts: props.capability === 'supports_tts',
    supports_audio_input: false,
    supports_image_input: false,
    supports_video_input: false,
  }

  const voiceAdapter = props.capability === 'supports_llm' ? 'custom' as const : 'openai_audio' as const
  const voiceUrls = {
    ...(props.capability === 'supports_tts'
      ? {
          tts_http_url: voiceEndpoint(baseUrl, 'audio/speech'),
          tts_realtime_url: voiceEndpoint(baseUrl, 'audio/speech/stream'),
        }
      : {}),
    ...(props.capability === 'supports_asr'
      ? {
          asr_async_url: voiceEndpoint(baseUrl, 'audio/transcriptions'),
          asr_realtime_url: voiceEndpoint(baseUrl, 'realtime')
            .replace(/^http:/, 'ws:')
            .replace(/^https:/, 'wss:'),
        }
      : {}),
  }

  const providerPayload = {
    name: pname,
    default_model: model,
    base_url: baseUrl,
    chat_completions_base_url: props.capability === 'supports_llm' ? baseUrl : undefined,
    voice_adapter: voiceAdapter,
    status: 'active' as const,
    ...voiceUrls,
    ...caps,
  }
  if (props.providers.some(provider => provider.id === pid)) {
    await agentSettingsApi.updateProvider(pid, providerPayload)
  } else {
    await agentSettingsApi.createProvider({ id: pid, ...providerPayload })
  }

  const res = await agentSettingsApi.createLLMSetting({
    provider_id: pid,
    model_name: model,
    models: [model],
    display_name: displayName,
    endpoint_id: `${pid}_custom`,
    endpoint_name: 'custom',
    plan_type: 'custom',
    protocol,
    auth_type: 'bearer',
    base_url: baseUrl,
    // LLM 同时填 chat_completions_base_url；ASR/TTS 后端只用 base_url
    chat_completions_base_url: props.capability === 'supports_llm' ? baseUrl : undefined,
    voice_adapter: voiceAdapter,
    ...voiceUrls,
    // TTS 音色（后端 TTS payload 会带上）
    ...(props.capability === 'supports_tts' && f.voice.trim() ? { tts_voice: f.voice.trim() } : {}),
    // 本地服务通常无需 Key，留空则传占位（api_key 字段后端必填）
    api_key: apiKey.value.trim() || 'local-no-key',
    is_default: props.capability === 'supports_llm',
    is_active: true,
    ...caps,
  })
  return res.data
}
</script>

<template>
  <div class="onboarding-step-form">
    <!-- 模式切换 -->
    <div class="onboarding-step-form__mode">
      <button
        type="button"
        :class="cn('onboarding-step-form__mode-tab', mode === 'preset' && 'onboarding-step-form__mode-tab--active')"
        @click="mode = 'preset'"
      >
        <Package class="h-3.5 w-3.5" />
        <span>{{ t('onboarding.form.preset') }}</span>
      </button>
      <button
        type="button"
        :class="cn('onboarding-step-form__mode-tab', mode === 'custom' && 'onboarding-step-form__mode-tab--active')"
        @click="mode = 'custom'"
      >
        <Server class="h-3.5 w-3.5" />
        <span>{{ t('onboarding.form.custom') }}</span>
      </button>
    </div>

    <!-- ═══ 内置凭证模式 ═══════════════════════════════════════ -->
    <template v-if="mode === 'preset'">
      <div v-if="!credentials.length" class="onboarding-step-form__empty">
        {{ t('onboarding.form.noPreset', { capability: capabilityLabel(capability) }) }}
      </div>

      <div v-else class="onboarding-step-form__grid">
        <label class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">{{ t('onboarding.form.credential') }}</span>
          <select
            :value="selectedCredentialKey"
            class="onboarding-step-form__select"
            @change="selectCredential(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('onboarding.form.selectCredential') }}</option>
            <option v-for="c in credentials" :key="c.key" :value="c.key" class="bg-[#111315] text-white">
              {{ credentialLabel(c) }}
            </option>
          </select>
        </label>

        <label class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">{{ t('onboarding.form.model') }}</span>
          <select
            v-model="selectedModelId"
            :disabled="!selectedCredential"
            class="onboarding-step-form__select"
          >
            <option value="">{{ t('onboarding.form.selectModel') }}</option>
            <option v-for="m in displayModels" :key="m.id" :value="m.id" class="bg-[#111315] text-white">
              {{ m.display_name }}{{ m.recommended ? ` · ${t('onboarding.form.recommended')}` : '' }}
            </option>
          </select>
        </label>

        <!-- credential 已有 key：自动复用并显示 masked 值；否则填新 key -->
        <div v-if="selectedCredentialHasKey" class="onboarding-step-form__field onboarding-step-form__field--key">
          <span class="onboarding-step-form__field-label">API Key</span>
          <div class="onboarding-step-form__reuse-badge" :title="t('onboarding.form.reuseKey')">
            <span>{{ selectedMaskedKey }}</span>
          </div>
        </div>
        <label v-else class="onboarding-step-form__field onboarding-step-form__field--key">
          <span class="onboarding-step-form__field-label">API Key</span>
          <div class="onboarding-step-form__key">
            <input
              v-model="apiKey"
              :type="showKey ? 'text' : 'password'"
              :placeholder="selectedEndpoint?.key_hint || t('onboarding.form.pasteKey')"
              autocomplete="off"
              spellcheck="false"
              class="onboarding-step-form__input"
            />
            <button
              type="button"
              class="onboarding-step-form__key-toggle"
              :title="showKey ? t('onboarding.form.hide') : t('onboarding.form.show')"
              @click="showKey = !showKey"
            >
              <EyeOff v-if="showKey" class="h-3.5 w-3.5" />
              <Eye v-else class="h-3.5 w-3.5" />
            </button>
          </div>
        </label>
      </div>
    </template>

    <!-- ═══ 自定义 / 本地部署模式 ═════════════════════════════ -->
    <template v-else>
      <div class="onboarding-step-form__custom">
        <label class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">{{ t('onboarding.form.baseUrl') }}</span>
          <input
            v-model="customFields.baseUrl"
            :placeholder="customFieldConfig.baseUrlPlaceholder"
            autocomplete="off"
            spellcheck="false"
            class="onboarding-step-form__input"
          />
          <span class="onboarding-step-form__field-hint">{{ customFieldConfig.baseUrlHint }}</span>
        </label>

        <label class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">{{ t('onboarding.form.model') }}</span>
          <input
            v-model="customFields.model"
            :placeholder="customFieldConfig.modelPlaceholder"
            autocomplete="off"
            spellcheck="false"
            class="onboarding-step-form__input"
          />
          <span class="onboarding-step-form__field-hint">{{ customFieldConfig.modelHint }}</span>
        </label>

        <!-- TTS 音色（可选） -->
        <label v-if="capability === 'supports_tts'" class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">
            {{ t('onboarding.form.voice') }} <em>{{ t('onboarding.optional') }}</em>
          </span>
          <input
            v-model="customFields.voice"
            :placeholder="t('onboarding.form.voicePlaceholder')"
            autocomplete="off"
            spellcheck="false"
            class="onboarding-step-form__input"
          />
          <span class="onboarding-step-form__field-hint">{{ t('onboarding.form.voiceHint') }}</span>
        </label>

        <!-- 本地服务 Key 可选 -->
        <label class="onboarding-step-form__field">
          <span class="onboarding-step-form__field-label">
            API Key <em>{{ t('onboarding.form.localKeyOptional') }}</em>
          </span>
          <div class="onboarding-step-form__key">
            <input
              v-model="apiKey"
              :type="showKey ? 'text' : 'password'"
              :placeholder="t('onboarding.form.localKeyPlaceholder')"
              autocomplete="off"
              spellcheck="false"
              class="onboarding-step-form__input"
            />
            <button
              type="button"
              class="onboarding-step-form__key-toggle"
              :title="showKey ? t('onboarding.form.hide') : t('onboarding.form.show')"
              @click="showKey = !showKey"
            >
              <EyeOff v-if="showKey" class="h-3.5 w-3.5" />
              <Eye v-else class="h-3.5 w-3.5" />
            </button>
          </div>
        </label>
      </div>
    </template>

    <!-- 提交 -->
    <div class="onboarding-step-form__actions">
      <button
        type="button"
        :disabled="!canSubmit || saving"
        :class="cn(
          'onboarding-step-form__submit',
          (!canSubmit || saving) && 'onboarding-step-form__submit--disabled'
        )"
        @click="submit"
      >
        <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
        <span>{{ saving ? t('onboarding.form.saving') : t('onboarding.form.saveContinue') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.onboarding-step-form {
  width: 100%;
}

/* 模式切换 */
.onboarding-step-form__mode {
  display: flex;
  gap: 0.35rem;
  padding: 0.2rem;
  margin-bottom: 0.75rem;
  border-radius: 0.6rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.onboarding-step-form__mode-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  padding: 0.4rem 0.5rem;
  border-radius: 0.45rem;
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.5);
  transition: background 160ms ease, color 160ms ease;
}

.onboarding-step-form__mode-tab--active {
  background: rgba(103, 232, 249, 0.12);
  color: rgba(207, 250, 254, 0.95);
}

/* 内置凭证 grid */
.onboarding-step-form__empty {
  padding: 1rem 0.75rem;
  border-radius: 0.75rem;
  border: 1px dashed rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.02);
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.8rem;
  line-height: 1.5;
}

.onboarding-step-form__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 0.75rem;
  align-items: end;
}

@media (max-width: 720px) {
  .onboarding-step-form__grid {
    grid-template-columns: 1fr;
  }
}

/* 自定义模式：纵向流 */
.onboarding-step-form__custom {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

/* 公共字段 */
.onboarding-step-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.onboarding-step-form__field-label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.7rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 0.02em;
}

.onboarding-step-form__field-label em {
  font-size: 0.62rem;
  font-style: normal;
  color: rgba(255, 255, 255, 0.3);
}

.onboarding-step-form__field-hint {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.3);
}

.onboarding-step-form__select,
.onboarding-step-form__input {
  width: 100%;
  height: 2.25rem;
  padding: 0 0.65rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.8rem;
  outline: none;
  transition: border-color 160ms ease, background 160ms ease;
}

.onboarding-step-form__select:focus,
.onboarding-step-form__input:focus {
  border-color: rgba(103, 232, 249, 0.5);
  background: rgba(103, 232, 249, 0.06);
}

.onboarding-step-form__select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.onboarding-step-form__key {
  position: relative;
}

.onboarding-step-form__key .onboarding-step-form__input {
  padding-right: 2rem;
}

.onboarding-step-form__key-toggle {
  position: absolute;
  right: 0.4rem;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.5rem;
  width: 1.5rem;
  border-radius: 0.35rem;
  color: rgba(255, 255, 255, 0.4);
  transition: color 160ms ease, background 160ms ease;
}

.onboarding-step-form__key-toggle:hover {
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.06);
}

/* 复用已有 Key 提示 */
.onboarding-step-form__reuse-badge {
  display: flex;
  align-items: center;
  height: 2.25rem;
  padding: 0 0.65rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.08);
  color: rgba(167, 243, 208, 0.9);
  font-size: 0.72rem;
}

/* 提交 */
.onboarding-step-form__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.9rem;
}

.onboarding-step-form__submit {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1.1rem;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.4);
  background: rgba(103, 232, 249, 0.12);
  color: rgba(207, 250, 254, 0.95);
  font-size: 0.8rem;
  font-weight: 500;
  transition: background 160ms ease, transform 160ms ease;
}

.onboarding-step-form__submit:not(.onboarding-step-form__submit--disabled):hover {
  background: rgba(103, 232, 249, 0.22);
  transform: translateY(-1px);
}

.onboarding-step-form__submit--disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.5);
}
</style>

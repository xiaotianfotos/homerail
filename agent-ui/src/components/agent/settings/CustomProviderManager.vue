<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Bot, Loader2, Mic, Plus, RotateCcw, Trash2, Volume2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { agentSettingsApi } from '@/api/agent'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import {
  testVoiceEndpoints,
  type VoiceEndpointProbeCandidate,
  type VoiceEndpointProbeResult
} from '@/api/services/voice-api'
import type { Provider } from '@/api/types/orchestration-v2.types'
import { useToast } from '@/components/controls/useToast'
import CapabilityToggle from './CapabilityToggle.vue'
import InlineDeleteConfirm from './InlineDeleteConfirm.vue'
import type { ModelPurpose } from './ModelForm.vue'

const props = defineProps<{
  providers: Provider[]
  settings: LLMSetting[]
}>()

const emit = defineEmits<{
  refresh: []
  notice: [message: string]
  addModel: [purpose: ModelPurpose, providerId: string]
}>()

const { t } = useI18n()
const { showToast } = useToast()
const selectedId = ref('')
const creating = ref(false)
const createRequested = ref(false)
const saving = ref(false)
const testingEndpoints = ref(false)
const endpointTestResults = ref<VoiceEndpointProbeResult[]>([])
const endpointTestError = ref('')
const providerId = ref('')
const providerName = ref('')
const baseUrl = ref('')
const chatCompletionsBaseUrl = ref('')
const responsesBaseUrl = ref('')
const anthropicBaseUrl = ref('')
const ttsHttpUrl = ref('')
const ttsStreamingUrl = ref('')
const asrHttpUrl = ref('')
const asrRealtimeUrl = ref('')
const ttsHttpAutomatic = ref(true)
const ttsStreamingAutomatic = ref(true)
const asrHttpAutomatic = ref(true)
const asrRealtimeAutomatic = ref(true)
const supportsLlm = ref(true)
const supportsAsr = ref(false)
const supportsTts = ref(false)
const deleteConfirmOpen = ref(false)
const loadedDraftSignature = ref('')

const customProviders = computed(() =>
  props.providers.filter(provider => provider.source === 'custom')
)
const selectedProvider = computed(
  () => customProviders.value.find(provider => provider.id === selectedId.value) ?? null
)
const referencedSettings = computed(() =>
  props.settings.filter(setting => setting.provider_id === selectedId.value)
)
const referenceCount = computed(() => referencedSettings.value.length)
const referencedModelNames = computed(() =>
  referencedSettings.value.map(setting => setting.display_name || setting.model_name).join(', ')
)

function voiceApiBase(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function voiceEndpoint(path: string): string {
  const base = voiceApiBase(baseUrl.value)
  return base ? `${base}/${path.replace(/^\/+/, '')}` : ''
}

function realtimeWsEndpoint(): string {
  return voiceEndpoint('realtime')
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
}

const defaultTtsHttpUrl = computed(() => voiceEndpoint('audio/speech'))
const defaultTtsStreamingUrl = computed(() => voiceEndpoint('audio/speech/stream'))
const defaultAsrHttpUrl = computed(() => voiceEndpoint('audio/transcriptions'))
const defaultAsrRealtimeUrl = computed(realtimeWsEndpoint)

watch(defaultTtsHttpUrl, value => {
  if (ttsHttpAutomatic.value) ttsHttpUrl.value = value
})
watch(defaultTtsStreamingUrl, value => {
  if (ttsStreamingAutomatic.value) ttsStreamingUrl.value = value
})
watch(defaultAsrHttpUrl, value => {
  if (asrHttpAutomatic.value) asrHttpUrl.value = value
})
watch(defaultAsrRealtimeUrl, value => {
  if (asrRealtimeAutomatic.value) asrRealtimeUrl.value = value
})

watch(
  [ttsHttpUrl, ttsStreamingUrl, asrHttpUrl, asrRealtimeUrl],
  () => {
    endpointTestResults.value = []
    endpointTestError.value = ''
  }
)

function loadVoiceEndpoint(
  savedValue: string | undefined,
  derivedValue: string,
  target: typeof ttsHttpUrl,
  automatic: typeof ttsHttpAutomatic
): void {
  const saved = savedValue?.trim() ?? ''
  automatic.value = !saved || saved === derivedValue
  target.value = automatic.value ? derivedValue : saved
}

type VoiceEndpointField = 'tts_http' | 'tts_streaming' | 'asr_http' | 'asr_realtime'

function voiceEndpointState(field: VoiceEndpointField): {
  target: typeof ttsHttpUrl
  automatic: typeof ttsHttpAutomatic
  derived: string
} {
  if (field === 'tts_http') {
    return { target: ttsHttpUrl, automatic: ttsHttpAutomatic, derived: defaultTtsHttpUrl.value }
  }
  if (field === 'tts_streaming') {
    return {
      target: ttsStreamingUrl,
      automatic: ttsStreamingAutomatic,
      derived: defaultTtsStreamingUrl.value
    }
  }
  if (field === 'asr_http') {
    return { target: asrHttpUrl, automatic: asrHttpAutomatic, derived: defaultAsrHttpUrl.value }
  }
  return {
    target: asrRealtimeUrl,
    automatic: asrRealtimeAutomatic,
    derived: defaultAsrRealtimeUrl.value
  }
}

function setEndpointOverride(field: VoiceEndpointField): void {
  const endpoint = voiceEndpointState(field)
  endpoint.automatic.value = endpoint.target.value.trim() === endpoint.derived
}

function restoreEndpoint(field: VoiceEndpointField): void {
  const endpoint = voiceEndpointState(field)
  endpoint.automatic.value = true
  endpoint.target.value = endpoint.derived
}

function draftSignature(): string {
  return JSON.stringify({
    providerId: providerId.value,
    providerName: providerName.value,
    baseUrl: baseUrl.value,
    chatCompletionsBaseUrl: chatCompletionsBaseUrl.value,
    responsesBaseUrl: responsesBaseUrl.value,
    anthropicBaseUrl: anthropicBaseUrl.value,
    ttsHttpUrl: ttsHttpUrl.value,
    ttsStreamingUrl: ttsStreamingUrl.value,
    asrHttpUrl: asrHttpUrl.value,
    asrRealtimeUrl: asrRealtimeUrl.value,
    supportsLlm: supportsLlm.value,
    supportsAsr: supportsAsr.value,
    supportsTts: supportsTts.value
  })
}

const isDirty = computed(
  () => !creating.value && Boolean(loadedDraftSignature.value) && draftSignature() !== loadedDraftSignature.value
)

function normalizeVoiceBaseUrl(): void {
  if (!supportsLlm.value && (supportsAsr.value || supportsTts.value)) {
    baseUrl.value = voiceApiBase(baseUrl.value)
  }
}

function loadProvider(provider: Provider): void {
  deleteConfirmOpen.value = false
  creating.value = false
  createRequested.value = false
  selectedId.value = provider.id
  providerId.value = provider.id
  providerName.value = provider.name
  baseUrl.value = provider.base_url ?? ''
  chatCompletionsBaseUrl.value = provider.chat_completions_base_url ?? ''
  responsesBaseUrl.value = provider.responses_base_url ?? ''
  anthropicBaseUrl.value = provider.anthropic_base_url ?? ''
  const endpoint = provider.endpoints?.[0]
  loadVoiceEndpoint(
    provider.tts_http_url ?? endpoint?.tts_http_url,
    defaultTtsHttpUrl.value,
    ttsHttpUrl,
    ttsHttpAutomatic
  )
  loadVoiceEndpoint(
    provider.tts_realtime_url ?? endpoint?.tts_realtime_url,
    defaultTtsStreamingUrl.value,
    ttsStreamingUrl,
    ttsStreamingAutomatic
  )
  loadVoiceEndpoint(
    provider.asr_async_url ?? endpoint?.asr_async_url,
    defaultAsrHttpUrl.value,
    asrHttpUrl,
    asrHttpAutomatic
  )
  loadVoiceEndpoint(
    provider.asr_realtime_url ?? endpoint?.asr_realtime_url,
    defaultAsrRealtimeUrl.value,
    asrRealtimeUrl,
    asrRealtimeAutomatic
  )
  const configuredModels = props.settings.filter(setting => setting.provider_id === provider.id)
  supportsLlm.value = configuredModels.length
    ? configuredModels.some(setting => setting.supports_llm)
    : provider.supports_llm !== false
  supportsAsr.value = configuredModels.length
    ? configuredModels.some(setting => setting.supports_asr)
    : Boolean(provider.supports_asr)
  supportsTts.value = configuredModels.length
    ? configuredModels.some(setting => setting.supports_tts)
    : Boolean(provider.supports_tts)
  loadedDraftSignature.value = draftSignature()
}

function startCreate(): void {
  deleteConfirmOpen.value = false
  creating.value = true
  createRequested.value = true
  selectedId.value = ''
  providerId.value = ''
  providerName.value = ''
  baseUrl.value = ''
  chatCompletionsBaseUrl.value = ''
  responsesBaseUrl.value = ''
  anthropicBaseUrl.value = ''
  ttsHttpAutomatic.value = true
  ttsStreamingAutomatic.value = true
  asrHttpAutomatic.value = true
  asrRealtimeAutomatic.value = true
  ttsHttpUrl.value = defaultTtsHttpUrl.value
  ttsStreamingUrl.value = defaultTtsStreamingUrl.value
  asrHttpUrl.value = defaultAsrHttpUrl.value
  asrRealtimeUrl.value = defaultAsrRealtimeUrl.value
  supportsLlm.value = true
  supportsAsr.value = false
  supportsTts.value = false
  loadedDraftSignature.value = draftSignature()
}

watch(
  [customProviders, () => props.settings],
  ([providers]) => {
    if (createRequested.value) return
    const selected = providers.find(provider => provider.id === selectedId.value) ?? providers[0]
    if (selected && (selected.id !== selectedId.value || !isDirty.value)) loadProvider(selected)
    else if (!selected) creating.value = true
  },
  { immediate: true }
)

const canSave = computed(() =>
  Boolean(
    providerId.value.trim() &&
    providerName.value.trim() &&
    baseUrl.value.trim() &&
    (supportsLlm.value || supportsAsr.value || supportsTts.value)
  )
)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const endpointProbeCandidates = computed<VoiceEndpointProbeCandidate[]>(() => {
  const endpoints: VoiceEndpointProbeCandidate[] = []
  if (supportsAsr.value) {
    endpoints.push({ id: 'asr_http', kind: 'http', url: asrHttpUrl.value.trim() })
    endpoints.push({ id: 'asr_realtime', kind: 'websocket', url: asrRealtimeUrl.value.trim() })
  }
  if (supportsTts.value) {
    endpoints.push({ id: 'tts_http', kind: 'http', url: ttsHttpUrl.value.trim() })
    endpoints.push({ id: 'tts_streaming', kind: 'http', url: ttsStreamingUrl.value.trim() })
  }
  return endpoints.filter(endpoint => Boolean(endpoint.url))
})

const canTestEndpoints = computed(() =>
  endpointProbeCandidates.value.length > 0 && endpointProbeCandidates.value.every(endpoint => {
    try {
      const parsed = new URL(endpoint.url)
      return endpoint.kind === 'http'
        ? parsed.protocol === 'http:' || parsed.protocol === 'https:'
        : parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
    } catch {
      return false
    }
  })
)

const endpointTestPassed = computed(() =>
  endpointTestResults.value.length > 0 && endpointTestResults.value.every(result => result.ok)
)

function endpointLabel(id: VoiceEndpointProbeResult['id']): string {
  const labels: Record<string, string> = {
    asr_http: t('settings.models.providers.asrHttp'),
    asr_realtime: t('settings.models.providers.asrRealtimeWs'),
    tts_http: t('settings.models.providers.ttsHttp'),
    tts_streaming: t('settings.models.providers.ttsStreamingHttp')
  }
  return labels[id] ?? id
}

function endpointResultText(result: VoiceEndpointProbeResult): string {
  const status = !result.ok && result.status_code ? ` (${result.status_code})` : ''
  return `${endpointLabel(result.id)}${status} ${result.ok ? '✓' : '✕'}`
}

async function testEndpoints(): Promise<void> {
  if (!canTestEndpoints.value || testingEndpoints.value) return
  testingEndpoints.value = true
  endpointTestResults.value = []
  endpointTestError.value = ''
  try {
    const response = await testVoiceEndpoints(endpointProbeCandidates.value)
    endpointTestResults.value = response.data?.results ?? []
  } catch (error) {
    endpointTestError.value = messageOf(error)
  } finally {
    testingEndpoints.value = false
  }
}

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return
  saving.value = true
  const id = providerId.value.trim()
  normalizeVoiceBaseUrl()
  const payload = {
    name: providerName.value.trim(),
    base_url: baseUrl.value.trim(),
    chat_completions_base_url: chatCompletionsBaseUrl.value.trim() || undefined,
    responses_base_url: responsesBaseUrl.value.trim() || undefined,
    anthropic_base_url: anthropicBaseUrl.value.trim() || undefined,
    voice_adapter:
      supportsAsr.value || supportsTts.value ? ('openai_audio' as const) : ('custom' as const),
    tts_http_url: supportsTts.value
      ? ttsHttpUrl.value.trim() || defaultTtsHttpUrl.value
      : undefined,
    tts_realtime_url: supportsTts.value
      ? ttsStreamingUrl.value.trim() || defaultTtsStreamingUrl.value
      : undefined,
    asr_async_url: supportsAsr.value
      ? asrHttpUrl.value.trim() || defaultAsrHttpUrl.value
      : undefined,
    asr_realtime_url: supportsAsr.value
      ? asrRealtimeUrl.value.trim() || defaultAsrRealtimeUrl.value
      : undefined,
    status: 'active' as const,
    supports_llm: supportsLlm.value,
    supports_asr: supportsAsr.value,
    supports_tts: supportsTts.value,
    supports_audio_input: supportsAsr.value,
    supports_image_input: false,
    supports_video_input: false
  }
  try {
    if (creating.value) await agentSettingsApi.createProvider({ id, ...payload })
    else await agentSettingsApi.updateProvider(id, payload)
    creating.value = false
    createRequested.value = false
    selectedId.value = id
    loadedDraftSignature.value = draftSignature()
    emit('refresh')
    emit('notice', t('settings.models.providers.saved'))
  } catch (error) {
    showToast(messageOf(error), 'error', 6000)
  } finally {
    saving.value = false
  }
}

const deleteConfirmMessage = computed(() => {
  const provider = selectedProvider.value
  if (!provider) return ''
  return referenceCount.value > 0
    ? t('settings.models.providers.deleteCascadeConfirm', {
        name: provider.name,
        count: referenceCount.value,
        models: referencedModelNames.value
      })
    : t('settings.models.providers.deleteConfirm', { name: provider.name })
})

function toggleDeleteConfirm(): void {
  if (saving.value) return
  deleteConfirmOpen.value = !deleteConfirmOpen.value
}

async function confirmRemove(): Promise<void> {
  const provider = selectedProvider.value
  if (!provider || saving.value) return
  const cascade = referenceCount.value > 0
  saving.value = true
  try {
    await agentSettingsApi.deleteProvider(provider.id, { cascade })
    deleteConfirmOpen.value = false
    selectedId.value = ''
    createRequested.value = false
    emit('refresh')
    emit('notice', t('settings.models.providers.deleted'))
  } catch (error) {
    showToast(messageOf(error), 'error', 6000)
  } finally {
    saving.value = false
  }
}

const addOptions = [
  { purpose: 'llm' as const, icon: Bot },
  { purpose: 'asr' as const, icon: Mic },
  { purpose: 'tts' as const, icon: Volume2 }
]
</script>

<template>
  <section class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)]">
    <header
      class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hr-border)] px-4 py-3"
    >
      <div>
        <h2 class="font-semibold">{{ t('settings.models.providers.title') }}</h2>
        <p class="mt-1 text-xs text-[var(--hr-text-3)]">{{ t('settings.models.providers.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md border border-[var(--hr-border-strong)] px-3 py-2 text-sm text-[var(--hr-text-1)] hover:bg-[var(--hr-surface-1)]"
        @click="startCreate"
      >
        <Plus class="h-4 w-4" />
        {{ t('settings.models.providers.add') }}
      </button>
    </header>

    <div class="grid min-h-80 md:grid-cols-[220px_minmax(0,1fr)]">
      <nav
        class="border-b border-[var(--hr-border)] p-2 md:border-b-0 md:border-r"
        :aria-label="t('settings.models.providers.title')"
      >
        <button
          v-for="provider in customProviders"
          :key="provider.id"
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded px-3 py-2.5 text-left text-sm"
          :class="
            selectedId === provider.id && !creating
              ? 'bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]'
              : 'text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-1)] hover:text-[var(--hr-text-1)]'
          "
          @click="loadProvider(provider)"
        >
          <span class="truncate">{{ provider.name }}</span>
          <span class="text-[10px] text-[var(--hr-text-3)]">{{
            settings.filter(setting => setting.provider_id === provider.id).length
          }}</span>
        </button>
        <div v-if="!customProviders.length" class="px-3 py-6 text-center text-xs text-[var(--hr-text-3)]">
          {{ t('settings.models.providers.empty') }}
        </div>
      </nav>

      <form class="space-y-4 p-4" @submit.prevent="save">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="space-y-1">
            <span class="text-xs text-[var(--hr-text-3)]">Provider ID</span>
            <input
              v-model="providerId"
              :disabled="!creating"
              class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none disabled:text-[var(--hr-text-3)]"
              placeholder="custom-openai"
            />
          </label>
          <label class="space-y-1">
            <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.form.displayName') }}</span>
            <input
              v-model="providerName"
              class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
            />
          </label>
        </div>
        <label class="block space-y-1">
          <span class="text-xs text-[var(--hr-text-3)]">Base URL</span>
          <input
            v-model="baseUrl"
            class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
            placeholder="https://api.example.com/v1"
            @blur="normalizeVoiceBaseUrl"
          />
        </label>
        <details v-if="supportsLlm" class="border-t border-[var(--hr-border)] pt-3">
          <summary class="cursor-pointer text-xs text-[var(--hr-text-3)]">
            {{ t('settings.models.providers.protocolUrls') }}
          </summary>
          <div class="mt-3 grid gap-3">
            <input
              v-model="chatCompletionsBaseUrl"
              class="h-9 rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-xs"
              placeholder="Chat Completions URL"
            />
            <input
              v-model="responsesBaseUrl"
              class="h-9 rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-xs"
              placeholder="Responses URL"
            />
            <input
              v-model="anthropicBaseUrl"
              class="h-9 rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-xs"
              placeholder="Anthropic URL"
            />
          </div>
        </details>
        <div v-if="supportsTts || supportsAsr" class="space-y-3 border-t border-[var(--hr-border)] pt-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="text-xs text-[var(--hr-text-3)]">
                {{ t('settings.models.providers.voiceEndpoints') }}
              </div>
              <div class="mt-1 text-[11px] text-[var(--hr-text-3)]">
                {{ t('settings.models.providers.voiceEndpointsHint') }}
              </div>
            </div>
            <button
              type="button"
              data-testid="provider-test-voice-endpoints"
              class="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--hr-border-strong)] px-2.5 text-xs text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-2)] disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!canTestEndpoints || testingEndpoints"
              @click="testEndpoints"
            >
              <Loader2 v-if="testingEndpoints" class="h-3.5 w-3.5 animate-spin" />
              {{
                testingEndpoints
                  ? t('settings.models.providers.testingEndpoints')
                  : t('settings.models.providers.testEndpoints')
              }}
            </button>
          </div>
          <div v-if="supportsTts" class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-[var(--hr-text-3)]">{{
                  t('settings.models.providers.ttsHttp')
                }}</span>
                <button
                  v-if="!ttsHttpAutomatic"
                  type="button"
                  class="inline-flex items-center gap-1 text-[10px] text-[var(--hr-accent)] hover:underline"
                  @click="restoreEndpoint('tts_http')"
                >
                  <RotateCcw class="h-3 w-3" />
                  {{ t('settings.models.providers.restoreDerived') }}
                </button>
              </div>
              <input
                v-model="ttsHttpUrl"
                name="tts_http_url"
                data-testid="provider-tts-http-url"
                :aria-label="t('settings.models.providers.ttsHttp')"
                class="h-9 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 font-mono text-xs outline-none focus:border-[var(--hr-accent-border)]"
                @input="setEndpointOverride('tts_http')"
              />
            </div>
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-[var(--hr-text-3)]">{{
                  t('settings.models.providers.ttsStreamingHttp')
                }}</span>
                <button
                  v-if="!ttsStreamingAutomatic"
                  type="button"
                  class="inline-flex items-center gap-1 text-[10px] text-[var(--hr-accent)] hover:underline"
                  @click="restoreEndpoint('tts_streaming')"
                >
                  <RotateCcw class="h-3 w-3" />
                  {{ t('settings.models.providers.restoreDerived') }}
                </button>
              </div>
              <input
                v-model="ttsStreamingUrl"
                name="tts_streaming_url"
                data-testid="provider-tts-streaming-url"
                :aria-label="t('settings.models.providers.ttsStreamingHttp')"
                class="h-9 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 font-mono text-xs outline-none focus:border-[var(--hr-accent-border)]"
                @input="setEndpointOverride('tts_streaming')"
              />
            </div>
          </div>
          <div v-if="supportsAsr" class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-[var(--hr-text-3)]">{{
                  t('settings.models.providers.asrHttp')
                }}</span>
                <button
                  v-if="!asrHttpAutomatic"
                  type="button"
                  class="inline-flex items-center gap-1 text-[10px] text-[var(--hr-accent)] hover:underline"
                  @click="restoreEndpoint('asr_http')"
                >
                  <RotateCcw class="h-3 w-3" />
                  {{ t('settings.models.providers.restoreDerived') }}
                </button>
              </div>
              <input
                v-model="asrHttpUrl"
                name="asr_http_url"
                data-testid="provider-asr-http-url"
                :aria-label="t('settings.models.providers.asrHttp')"
                class="h-9 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 font-mono text-xs outline-none focus:border-[var(--hr-accent-border)]"
                @input="setEndpointOverride('asr_http')"
              />
            </div>
            <div class="space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-[var(--hr-text-3)]">{{
                  t('settings.models.providers.asrRealtimeWs')
                }}</span>
                <button
                  v-if="!asrRealtimeAutomatic"
                  type="button"
                  class="inline-flex items-center gap-1 text-[10px] text-[var(--hr-accent)] hover:underline"
                  @click="restoreEndpoint('asr_realtime')"
                >
                  <RotateCcw class="h-3 w-3" />
                  {{ t('settings.models.providers.restoreDerived') }}
                </button>
              </div>
              <input
                v-model="asrRealtimeUrl"
                name="asr_realtime_url"
                data-testid="provider-asr-realtime-url"
                :aria-label="t('settings.models.providers.asrRealtimeWs')"
                class="h-9 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 font-mono text-xs outline-none focus:border-[var(--hr-accent-border)]"
                @input="setEndpointOverride('asr_realtime')"
              />
            </div>
          </div>
          <div
            v-if="endpointTestResults.length"
            data-testid="provider-endpoint-test-result"
            class="rounded-md border px-3 py-2 text-xs"
            :class="
              endpointTestPassed
                ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
                : 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] text-[var(--hr-warning)]'
            "
          >
            <span class="font-medium">{{
              endpointTestPassed
                ? t('settings.models.providers.endpointTestPassed')
                : t('settings.models.providers.endpointTestFailed')
            }}</span>
            <span class="ml-1">
              {{ endpointTestResults.map(endpointResultText).join(' · ') }}
            </span>
          </div>
          <div
            v-else-if="endpointTestError"
            data-testid="provider-endpoint-test-error"
            class="rounded-md border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-3 py-2 text-xs text-[var(--hr-danger)]"
          >
            {{ endpointTestError }}
          </div>
        </div>
        <div class="space-y-2">
          <div class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.form.capabilities') }}</div>
          <div class="flex flex-wrap gap-2">
            <CapabilityToggle capability="llm" v-model="supportsLlm" />
            <CapabilityToggle capability="asr" v-model="supportsAsr" />
            <CapabilityToggle capability="tts" v-model="supportsTts" />
          </div>
        </div>
        <div v-if="!creating && selectedProvider" class="space-y-3 border-t border-[var(--hr-border)] pt-4">
          <div>
            <div class="text-xs text-[var(--hr-text-3)]">
              {{ t('settings.models.providers.references', { count: referenceCount }) }}
            </div>
            <div v-if="referenceCount" class="mt-2 flex flex-wrap gap-1.5">
              <span
                v-for="setting in referencedSettings"
                :key="setting.id"
                class="rounded border border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] px-2 py-1 text-xs text-[var(--hr-warning)]"
              >
                {{ setting.display_name || setting.model_name }}
              </span>
            </div>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <button
              v-for="option in addOptions"
              :key="option.purpose"
              type="button"
              class="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--hr-border)] px-2.5 text-xs text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-1)]"
              @click="emit('addModel', option.purpose, selectedProvider.id)"
            >
              <component :is="option.icon" class="h-3.5 w-3.5" />
              {{ option.purpose.toUpperCase() }}
            </button>
          </div>
        </div>
        <div class="flex flex-wrap items-end justify-between gap-3 pt-2">
          <div v-if="!creating" class="flex flex-wrap items-end gap-2">
            <button
              type="button"
              data-testid="delete-custom-provider"
              class="inline-flex items-center gap-2 rounded-md border border-[var(--hr-danger-border)] px-3 py-2 text-xs text-[var(--hr-danger)] disabled:cursor-not-allowed disabled:opacity-35"
              :class="deleteConfirmOpen ? 'bg-[var(--hr-danger-soft)]' : ''"
              :disabled="saving"
              @click="toggleDeleteConfirm"
            >
              <Loader2 v-if="saving" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
              {{
                referenceCount
                  ? t('settings.models.providers.deleteCascade', { count: referenceCount })
                  : t('settings.actions.delete')
              }}
            </button>
            <InlineDeleteConfirm
              v-if="deleteConfirmOpen"
              test-id="delete-custom-provider-confirm"
              :message="deleteConfirmMessage"
              :loading="saving"
              class="w-80 max-w-full"
              @confirm="confirmRemove"
              @cancel="deleteConfirmOpen = false"
            />
          </div>
          <span v-else />
          <button
            type="submit"
            class="inline-flex items-center gap-2 rounded-md bg-[var(--hr-accent)] px-4 py-2 text-sm font-medium text-[var(--hr-on-accent)] hover:bg-[color:color-mix(in_srgb,var(--hr-accent)_85%,white)] disabled:opacity-40"
            :disabled="!canSave || saving"
          >
            <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
            {{ t('settings.actions.save') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Loader2, LockKeyhole } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import CapabilityBadge from './CapabilityBadge.vue'
import CapabilityToggle from './CapabilityToggle.vue'

export interface EditModelPayload {
  id: string
  displayName?: string
  apiKey?: string
  isDefault: boolean
  isActive: boolean
  supportsAudioInput: boolean
  supportsImageInput: boolean
  supportsVideoInput: boolean
  ttsVoice?: string
  ttsFormat?: string
  ttsSampleRate?: number
}

const props = defineProps<{
  setting: LLMSetting
  submitting?: boolean
}>()

const emit = defineEmits<{
  submit: [payload: EditModelPayload]
  cancel: []
}>()

const { t } = useI18n()
const displayName = ref('')
const apiKey = ref('')
const isDefault = ref(false)
const isActive = ref(true)
const supportsAudioInput = ref(false)
const supportsImageInput = ref(false)
const supportsVideoInput = ref(false)
const ttsVoice = ref('')
const ttsFormat = ref('')
const ttsSampleRate = ref<number | undefined>()

const primaryCapabilities = computed(() =>
  [
    { key: 'llm' as const, active: props.setting.supports_llm },
    { key: 'asr' as const, active: props.setting.supports_asr },
    { key: 'tts' as const, active: props.setting.supports_tts }
  ].filter(item => item.active)
)

watch(
  () => props.setting,
  setting => {
    displayName.value = setting.display_name ?? ''
    apiKey.value = ''
    isDefault.value = setting.is_default
    isActive.value = setting.is_active
    supportsAudioInput.value = setting.supports_audio_input
    supportsImageInput.value = setting.supports_image_input
    supportsVideoInput.value = setting.supports_video_input
    ttsVoice.value = setting.tts_voice ?? ''
    ttsFormat.value = setting.tts_format ?? ''
    ttsSampleRate.value = setting.tts_sample_rate
  },
  { immediate: true }
)

function optionalText(value: string): string | undefined {
  return value.trim() || undefined
}

function submit(): void {
  emit('submit', {
    id: props.setting.id,
    displayName: optionalText(displayName.value),
    apiKey: optionalText(apiKey.value),
    isDefault: isDefault.value,
    isActive: isActive.value,
    supportsAudioInput: supportsAudioInput.value,
    supportsImageInput: supportsImageInput.value,
    supportsVideoInput: supportsVideoInput.value,
    ttsVoice: optionalText(ttsVoice.value),
    ttsFormat: optionalText(ttsFormat.value),
    ttsSampleRate: ttsSampleRate.value
  })
}
</script>

<template>
  <div class="space-y-5 p-5">
    <section class="space-y-3 border-b border-[var(--hr-border)] pb-5">
      <div class="text-xs font-medium text-[var(--hr-text-2)]">{{ t('settings.models.edit.provider') }}</div>
      <div
        class="flex min-h-11 items-center justify-between gap-3 rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3"
      >
        <div class="min-w-0">
          <div class="truncate text-sm text-[var(--hr-text-1)]">{{ setting.provider_name }}</div>
          <div class="truncate text-[11px] text-[var(--hr-text-3)]">
            {{ setting.provider_id }} · {{ setting.endpoint_name || setting.endpoint_id }}
          </div>
        </div>
        <span class="inline-flex flex-shrink-0 items-center gap-1 text-xs text-[var(--hr-text-3)]">
          <LockKeyhole class="h-3.5 w-3.5" />
          {{ t('settings.models.readOnly') }}
        </span>
      </div>
    </section>

    <section class="grid gap-3 sm:grid-cols-2">
      <label class="space-y-1">
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.form.modelName') }}</span>
        <div
          class="flex h-10 items-center rounded-md border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 font-mono text-sm text-[var(--hr-text-2)]"
        >
          {{ setting.model_name }}
        </div>
      </label>
      <label class="space-y-1">
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.form.aliasPlaceholder') }}</span>
        <input
          v-model="displayName"
          class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
        />
      </label>
    </section>

    <section class="space-y-2">
      <div class="text-xs font-medium text-[var(--hr-text-2)]">
        {{ t('settings.models.form.capabilities') }}
      </div>
      <div class="flex flex-wrap gap-2">
        <CapabilityBadge
          v-for="cap in primaryCapabilities"
          :key="cap.key"
          :capability="cap.key"
          :active="true"
        />
        <template v-if="setting.supports_llm">
          <CapabilityToggle capability="vision" v-model="supportsImageInput" />
          <CapabilityToggle capability="audio" v-model="supportsAudioInput" />
          <CapabilityToggle capability="video" v-model="supportsVideoInput" />
        </template>
      </div>
    </section>

    <section v-if="setting.supports_tts" class="grid gap-3 sm:grid-cols-3">
      <label class="space-y-1">
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.form.voice') }}</span>
        <input
          v-model="ttsVoice"
          class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
        />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.edit.format') }}</span>
        <input
          v-model="ttsFormat"
          class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
        />
      </label>
      <label class="space-y-1">
        <span class="text-xs text-[var(--hr-text-3)]">{{ t('settings.models.edit.sampleRate') }}</span>
        <input
          v-model.number="ttsSampleRate"
          type="number"
          min="1"
          class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
        />
      </label>
    </section>

    <label class="block space-y-1">
      <span class="text-xs font-medium text-[var(--hr-text-2)]">API Key</span>
      <input
        v-model="apiKey"
        type="password"
        class="h-10 w-full rounded-md border border-[var(--hr-border)] bg-[var(--hr-control)] px-3 text-sm outline-none focus:border-[var(--hr-accent-border)]"
        :placeholder="t('settings.models.form.keepKey')"
      />
    </label>

    <div class="flex items-center gap-6">
      <label class="flex cursor-pointer items-center gap-2">
        <input
          v-model="isDefault"
          type="checkbox"
          class="h-4 w-4 rounded border-[var(--hr-border-strong)] bg-[var(--hr-control)]"
        />
        <span class="text-sm text-[var(--hr-text-2)]">{{ t('settings.models.setDefault') }}</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2">
        <input
          v-model="isActive"
          type="checkbox"
          class="h-4 w-4 rounded border-[var(--hr-border-strong)] bg-[var(--hr-control)]"
        />
        <span class="text-sm text-[var(--hr-text-2)]">{{ t('settings.actions.enable') }}</span>
      </label>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <button
        type="button"
        class="rounded-md border border-[var(--hr-border)] px-4 py-2 text-sm text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-1)]"
        @click="emit('cancel')"
      >
        {{ t('settings.actions.cancel') }}
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-md bg-[var(--hr-accent)] px-4 py-2 text-sm font-medium text-[var(--hr-on-accent)] hover:bg-[color:color-mix(in_srgb,var(--hr-accent)_85%,white)] disabled:opacity-50"
        :disabled="submitting"
        @click="submit"
      >
        <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
        {{ t('settings.actions.save') }}
      </button>
    </div>
  </div>
</template>

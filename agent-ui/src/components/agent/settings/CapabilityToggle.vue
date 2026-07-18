<script setup lang="ts">
/**
 * CapabilityToggle — 按钮式能力开关。
 * 按下选中（高亮），再按取消。替代原来的 checkbox。
 */
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  capability: 'llm' | 'asr' | 'tts' | 'audio' | 'vision' | 'video'
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const label = computed(() => {
  const map: Record<string, string> = {
    llm: 'LLM',
    asr: 'ASR',
    tts: 'TTS',
    audio: 'Audio',
    vision: 'Vision',
    video: 'Video',
  }
  return map[props.capability] ?? props.capability
})

const activeClasses = computed(() => {
  const map: Record<string, string> = {
    llm: 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)] shadow-[0_0_12px_var(--hr-success-soft)]',
    asr: 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] text-[var(--hr-info)] shadow-[0_0_12px_var(--hr-info-soft)]',
    tts: 'border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] text-[var(--hr-warning)] shadow-[0_0_12px_var(--hr-warning-soft)]',
    audio: 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)] shadow-[0_0_12px_color-mix(in_srgb,var(--hr-accent)_20%,transparent)]',
    vision: 'border-[var(--hr-speaking-border)] bg-[var(--hr-speaking-soft)] text-[var(--hr-speaking)] shadow-[0_0_12px_var(--hr-speaking-soft)]',
    video: 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] text-[var(--hr-info)] shadow-[0_0_12px_var(--hr-info-soft)]',
  }
  return map[props.capability] ?? 'border-[var(--hr-border-strong)] bg-[var(--hr-surface-2)] text-[var(--hr-text-1)]'
})

function toggle(): void {
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    :class="cn(
      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all duration-150 select-none',
      modelValue
        ? activeClasses
        : 'border-[var(--hr-border)] bg-transparent text-[var(--hr-text-3)] hover:border-[var(--hr-border-strong)] hover:text-[var(--hr-text-2)]'
    )"
    @click="toggle"
  >
    {{ label }}
  </button>
</template>

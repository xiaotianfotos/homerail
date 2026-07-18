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
    llm: 'border-emerald-400/50 bg-emerald-400/15 text-emerald-200 shadow-[0_0_12px_rgba(52,211,153,0.2)]',
    asr: 'border-blue-400/50 bg-blue-400/15 text-blue-200 shadow-[0_0_12px_rgba(96,165,250,0.2)]',
    tts: 'border-orange-300/50 bg-orange-300/15 text-orange-200 shadow-[0_0_12px_rgba(251,146,60,0.2)]',
    audio: 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)] shadow-[0_0_12px_color-mix(in_srgb,var(--hr-accent)_20%,transparent)]',
    vision: 'border-violet-400/50 bg-violet-400/15 text-violet-200 shadow-[0_0_12px_rgba(167,139,250,0.2)]',
    video: 'border-fuchsia-400/50 bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_12px_rgba(232,121,249,0.2)]',
  }
  return map[props.capability] ?? 'border-white/20 bg-white/10 text-gray-200'
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
        : 'border-white/10 bg-transparent text-gray-500 hover:border-white/25 hover:text-gray-300'
    )"
    @click="toggle"
  >
    {{ label }}
  </button>
</template>

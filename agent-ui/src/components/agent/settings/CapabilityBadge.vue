<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  capability: 'llm' | 'asr' | 'tts' | 'audio' | 'vision' | 'video'
  active?: boolean
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

const classes = computed(() => {
  if (!props.active) {
    return 'border-[var(--hr-border)] text-[var(--hr-text-3)] bg-transparent'
  }
  const map: Record<string, string> = {
    llm: 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]',
    asr: 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] text-[var(--hr-info)]',
    tts: 'border-orange-300/40 bg-orange-300/10 text-orange-100',
    audio: 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]',
    vision: 'border-[var(--hr-speaking-border)] bg-[var(--hr-speaking-soft)] text-[var(--hr-speaking)]',
    video: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100',
  }
  return map[props.capability] ?? 'border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-2)]'
})
</script>

<template>
  <span class="rounded-full border px-2 py-0.5 text-[10px]" :class="classes">
    {{ label }}
  </span>
</template>

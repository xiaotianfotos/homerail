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
    return 'border-white/10 text-gray-600 bg-transparent'
  }
  const map: Record<string, string> = {
    llm: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100',
    asr: 'border-blue-400/40 bg-blue-400/10 text-blue-100',
    tts: 'border-orange-300/40 bg-orange-300/10 text-orange-100',
    audio: 'border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] text-[var(--hr-accent)]',
    vision: 'border-violet-400/40 bg-violet-400/10 text-violet-100',
    video: 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-100',
  }
  return map[props.capability] ?? 'border-white/10 bg-white/5 text-gray-300'
})
</script>

<template>
  <span class="rounded-full border px-2 py-0.5 text-[10px]" :class="classes">
    {{ label }}
  </span>
</template>

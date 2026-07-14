<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'

const props = defineProps<{
  resetKey: string | number
}>()

const emit = defineEmits<{
  (event: 'renderer-error', payload: { message: string }): void
}>()

const crashed = ref(false)
const message = ref('')

watch(() => props.resetKey, () => {
  crashed.value = false
  message.value = ''
})

onErrorCaptured((error) => {
  crashed.value = true
  message.value = error instanceof Error ? error.message : String(error)
  emit('renderer-error', { message: message.value })
  return false
})
</script>

<template>
  <slot v-if="!crashed" />
  <slot v-else name="fallback" :error="message" />
</template>

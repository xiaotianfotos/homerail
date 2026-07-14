<script setup lang="ts">
import type { GenerativeUiStoredNodeV1 } from 'homerail-protocol'
import TopicOutlineWidget from '@/components/agent/widgets/TopicOutlineWidget.vue'

defineProps<{
  node: GenerativeUiStoredNodeV1
}>()
</script>

<template>
  <TopicOutlineWidget :content="node.content" />
</template>

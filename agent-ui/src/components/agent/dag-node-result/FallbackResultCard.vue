<script setup lang="ts">
/**
 * FallbackResultCard — 未知/无专用渲染器节点的兜底结果卡片。
 *
 * 展示出口 port + 格式化 JSON，保证"每个节点都有可视化的结果"。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { prettyValue } from './dagNodeResultPresentation'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const port = computed(() => props.result.latest?.port ?? null)
const content = computed(() => prettyValue(props.result.latest?.content))
</script>

<template>
  <div class="flex flex-col gap-3 px-6 py-4">
    <div v-if="port" class="flex items-center gap-2 text-sm">
      <span class="text-xs text-[var(--hr-text-3)]">{{ t('dag.result.outputPort') }}</span>
      <span class="rounded-full border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2.5 py-1 font-mono text-xs text-[var(--hr-text-1)]">{{ port }}</span>
    </div>
    <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <pre data-testid="fallback-content" class="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ content }}</pre>
    </div>
  </div>
</template>

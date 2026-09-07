<script setup lang="ts">
/**
 * WhileResultCard — while 网关节点的结果卡片（迭代进度 + 谓词命中）。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { asWhilePayload, prettyValue } from './dagNodeResultPresentation'
import FallbackResultCard from './FallbackResultCard.vue'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const payload = computed(() => asWhilePayload(props.result.latest?.content))

const statusLabel = computed(() => {
  if (payload.value?.matched) return t('dag.result.whileMatched')
  if (payload.value?.exhausted) return t('dag.result.whileExhausted')
  return t('dag.result.whileContinuing')
})
</script>

<template>
  <div v-if="payload" class="flex flex-col gap-3 px-6 py-4">
    <div class="flex items-center gap-3 text-sm">
      <span
        class="rounded-full border px-2.5 py-1 text-xs font-medium"
        :class="payload.matched
          ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
          : payload.exhausted
            ? 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'
            : 'border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] text-[var(--hr-info)]'"
      >
        {{ statusLabel }}
      </span>
      <span class="font-mono text-xs text-[var(--hr-text-3)]">
        {{ t('dag.result.whileIteration', { iteration: payload.iteration ?? 0, max: payload.max_iterations ?? '—' }) }}
      </span>
    </div>

    <div v-if="payload.input !== undefined" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.whileInput') }}</div>
      <pre class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ prettyValue(payload.input) }}</pre>
    </div>
  </div>
  <FallbackResultCard v-else :result="result" />
</template>

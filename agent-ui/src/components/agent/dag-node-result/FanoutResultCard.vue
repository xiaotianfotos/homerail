<script setup lang="ts">
/**
 * FanoutResultCard — fanout 网关节点的聚合结果卡片。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { asFanoutPayload, previewValue } from './dagNodeResultPresentation'
import FallbackResultCard from './FallbackResultCard.vue'
import { CircleCheck, CircleX } from 'lucide-vue-next'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const payload = computed(() => asFanoutPayload(props.result.latest?.content))
const passed = computed(() => payload.value?.passed !== false)
</script>

<template>
  <div v-if="payload" class="flex flex-col gap-3 px-6 py-4">
    <div class="flex items-center gap-3 text-sm">
      <span
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
        :class="passed
          ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
          : 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'"
      >
        <component :is="passed ? CircleCheck : CircleX" class="h-3.5 w-3.5" />
        {{ passed ? t('dag.result.fanoutPassed') : t('dag.result.fanoutFailed') }}
      </span>
      <span v-if="payload.early_completion" class="text-xs text-[var(--hr-warning)]">{{ t('dag.result.fanoutEarlyCompletion') }}</span>
    </div>

    <div class="grid grid-cols-4 gap-1.5">
      <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 py-2">
        <div class="text-[9px] text-[var(--hr-text-4)]">{{ t('dag.result.fanoutTotal') }}</div>
        <div class="mt-0.5 font-mono text-xs text-[var(--hr-text-1)]">{{ payload.total ?? '—' }}</div>
      </div>
      <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 py-2">
        <div class="text-[9px] text-[var(--hr-text-4)]">{{ t('dag.result.fanoutCompleted') }}</div>
        <div class="mt-0.5 font-mono text-xs text-[var(--hr-text-1)]">{{ payload.completed ?? '—' }}</div>
      </div>
      <div class="rounded-lg border border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] px-2 py-2">
        <div class="text-[9px] text-[var(--hr-success)]">{{ t('dag.result.fanoutSuccesses') }}</div>
        <div class="mt-0.5 font-mono text-xs font-semibold text-[var(--hr-success)]">{{ payload.successes ?? '—' }}</div>
      </div>
      <div class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-2 py-2">
        <div class="text-[9px] text-[var(--hr-text-4)]">{{ t('dag.result.fanoutFailures') }}</div>
        <div class="mt-0.5 font-mono text-xs text-[var(--hr-text-1)]">{{ payload.failures ?? '—' }}</div>
      </div>
    </div>

    <div v-if="payload.results?.length" class="rounded-lg border border-[var(--hr-border)]">
      <div class="border-b border-[var(--hr-border)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">
        {{ t('dag.result.fanoutResults') }}
      </div>
      <div
        v-for="(value, index) in payload.results"
        :key="index"
        class="break-all border-b border-[var(--hr-border)] px-3 py-2 font-mono text-xs text-[var(--hr-text-2)] last:border-b-0"
      >
        {{ previewValue(value, 240) }}
      </div>
    </div>
  </div>
  <FallbackResultCard v-else :result="result" />
</template>

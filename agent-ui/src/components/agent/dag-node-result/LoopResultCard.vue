<script setup lang="ts">
/**
 * LoopResultCard — loop(foreach) 网关节点的结果卡片（当前 item / 汇总结果）。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { asLoopPayload, prettyValue, previewValue } from './dagNodeResultPresentation'
import FallbackResultCard from './FallbackResultCard.vue'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const payload = computed(() => asLoopPayload(props.result.latest?.content))
const results = computed(() => payload.value?.results ?? payload.value?.completed_results ?? [])
</script>

<template>
  <div v-if="payload" class="flex flex-col gap-3 px-6 py-4">
    <div class="flex items-center gap-3 text-sm">
      <span class="rounded-full border border-[var(--hr-info-border)] bg-[var(--hr-info-soft)] px-2.5 py-1 text-xs font-medium text-[var(--hr-info)]">
        {{ payload.completed ? t('dag.result.loopCompleted') : t('dag.result.loopIterating') }}
      </span>
      <span v-if="payload.total != null" class="font-mono text-xs text-[var(--hr-text-3)]">
        <template v-if="payload.index != null">{{ payload.index + 1 }}/</template>{{ payload.total }}
      </span>
    </div>

    <div v-if="payload.item !== undefined" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.loopItem') }}</div>
      <pre class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ prettyValue(payload.item) }}</pre>
    </div>

    <div v-if="results.length" class="rounded-lg border border-[var(--hr-border)]">
      <div class="border-b border-[var(--hr-border)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">
        {{ t('dag.result.loopResults') }}
      </div>
      <div
        v-for="(value, index) in results"
        :key="index"
        class="break-all border-b border-[var(--hr-border)] px-3 py-2 font-mono text-xs text-[var(--hr-text-2)] last:border-b-0"
      >
        {{ previewValue(value, 240) }}
      </div>
    </div>
  </div>
  <FallbackResultCard v-else :result="result" />
</template>

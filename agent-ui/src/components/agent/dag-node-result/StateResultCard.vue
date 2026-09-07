<script setup lang="ts">
/**
 * StateResultCard — state 网关节点的结果卡片（操作、是否写入、前后值）。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { asStatePayload, prettyValue } from './dagNodeResultPresentation'
import FallbackResultCard from './FallbackResultCard.vue'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const payload = computed(() => asStatePayload(props.result.latest?.content))
</script>

<template>
  <div v-if="payload" class="flex flex-col gap-3 px-6 py-4">
    <div class="flex items-center gap-3 text-sm">
      <span
        class="rounded-full border px-2.5 py-1 text-xs font-medium"
        :class="payload.updated
          ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
          : 'border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-3)]'"
      >
        {{ payload.updated ? t('dag.result.stateUpdated') : t('dag.result.stateUnchanged') }}
      </span>
      <span v-if="payload.operation" class="font-mono text-xs text-[var(--hr-text-2)]">{{ payload.operation }}</span>
    </div>

    <div v-if="payload.record !== undefined" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.stateRecord') }}</div>
      <pre data-testid="state-record" class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ prettyValue(payload.record) }}</pre>
    </div>

    <div v-if="payload.previous !== undefined && payload.previous !== null" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.statePrevious') }}</div>
      <pre class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-2)]">{{ prettyValue(payload.previous) }}</pre>
    </div>
  </div>
  <FallbackResultCard v-else :result="result" />
</template>

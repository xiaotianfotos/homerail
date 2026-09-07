<script setup lang="ts">
/**
 * ConditionResultCard — condition 网关节点的结果卡片（选中的路由 + 输入值）。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { prettyValue } from './dagNodeResultPresentation'
import { GitBranch } from 'lucide-vue-next'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const port = computed(() => props.result.latest?.port ?? null)
const input = computed(() => props.result.latest?.content)
</script>

<template>
  <div class="flex flex-col gap-3 px-6 py-4">
    <div class="flex items-center gap-3 text-sm">
      <span class="flex items-center gap-1.5 rounded-full border border-[var(--hr-accent-border)] bg-[var(--hr-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--hr-accent)]">
        <GitBranch class="h-3.5 w-3.5" />
        {{ t('dag.result.conditionRoute') }}
      </span>
      <span data-testid="condition-port" class="font-mono text-xs font-semibold text-[var(--hr-text-1)]">{{ port }}</span>
    </div>

    <div v-if="input !== undefined" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.conditionInput') }}</div>
      <pre class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ prettyValue(input) }}</pre>
    </div>
  </div>
</template>

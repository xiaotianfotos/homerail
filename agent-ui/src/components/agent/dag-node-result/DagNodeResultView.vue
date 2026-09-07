<script setup lang="ts">
/**
 * DagNodeResultView — 节点结构化结果的默认渲染入口。
 *
 * 每种非 worker 节点（command/join/condition/loop/while/state/fanout/...）
 * 都有人类可读的默认展示，不需要生成式 UI。未知 kind 兜底为格式化 JSON，
 * 保证"每个节点都有可视化的结果"。
 */

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import CommandResultCard from './CommandResultCard.vue'
import JoinResultCard from './JoinResultCard.vue'
import FanoutResultCard from './FanoutResultCard.vue'
import StateResultCard from './StateResultCard.vue'
import LoopResultCard from './LoopResultCard.vue'
import WhileResultCard from './WhileResultCard.vue'
import ConditionResultCard from './ConditionResultCard.vue'
import FallbackResultCard from './FallbackResultCard.vue'

const props = defineProps<{
  result: DAGNodeResult | null
  loading?: boolean
}>()

const { t } = useI18n()

const cardComponent = computed(() => {
  switch (props.result?.result_kind) {
    case 'command': return CommandResultCard
    case 'join': return JoinResultCard
    case 'fanout': return FanoutResultCard
    case 'state': return StateResultCard
    case 'loop': return LoopResultCard
    case 'while': return WhileResultCard
    case 'condition': return ConditionResultCard
    default: return FallbackResultCard
  }
})
</script>

<template>
  <div class="dag-node-result">
    <div v-if="loading && !result" class="py-6 text-center text-sm text-[var(--hr-text-4)]">
      {{ t('dag.result.loading') }}
    </div>
    <div v-else-if="!result || !result.latest" class="py-6 text-center text-sm text-[var(--hr-text-4)]">
      {{ t('dag.result.empty') }}
    </div>
    <component :is="cardComponent" v-else :result="result" />
  </div>
</template>

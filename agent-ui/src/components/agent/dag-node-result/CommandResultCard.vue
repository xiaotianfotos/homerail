<script setup lang="ts">
/**
 * CommandResultCard — command 网关节点的结果卡片。
 *
 * 展示命令行、退出码、耗时、解析值；stdout/stderr 折叠展示。
 * result_payload=value 时 envelope 从 telemetry 补回（见 useDagNodeResult）。
 */

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DAGNodeResult } from '@/api/types/dag.types'
import { prettyValue, resolveCommandEnvelope, resolveCommandValue } from './dagNodeResultPresentation'
import { ChevronDown, ChevronUp, CircleCheck, CircleX, Clock, Terminal } from 'lucide-vue-next'

const props = defineProps<{ result: DAGNodeResult }>()

const { t } = useI18n()

const envelope = computed(() => resolveCommandEnvelope(props.result))
const handedValue = computed(() => resolveCommandValue(props.result))

const commandLine = computed(() => {
  const env = envelope.value
  if (!env?.command) return null
  return [env.command, ...(env.args ?? [])].join(' ')
})

const ok = computed(() => envelope.value?.ok === true)
const showStdout = ref(false)
const showStderr = ref(false)

const hasStdout = computed(() => Boolean(envelope.value?.stdout))
const hasStderr = computed(() => Boolean(envelope.value?.stderr))

const displayValue = computed(() => {
  const value = handedValue.value !== undefined ? handedValue.value : envelope.value?.value
  if (value === undefined) return null
  const envelopeStdout = envelope.value?.stdout
  // 解析值与 stdout 原文一致时不重复展示
  if (typeof value === 'string' && value === envelopeStdout) return null
  return prettyValue(value)
})

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<template>
  <div class="flex flex-col gap-3 px-6 py-4">
    <!-- 状态行：退出码 + 耗时 -->
    <div class="flex items-center gap-3 text-sm">
      <span
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
        :class="ok
          ? 'border-[var(--hr-success-border)] bg-[var(--hr-success-soft)] text-[var(--hr-success)]'
          : 'border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] text-[var(--hr-danger)]'"
      >
        <component :is="ok ? CircleCheck : CircleX" class="h-3.5 w-3.5" />
        {{ ok ? t('dag.result.commandPassed') : t('dag.result.commandFailed') }}
      </span>
      <span v-if="envelope?.exit_code != null" class="font-mono text-xs text-[var(--hr-text-3)]">
        exit {{ envelope.exit_code }}
      </span>
      <span v-if="envelope?.timed_out" class="text-xs text-[var(--hr-danger)]">{{ t('dag.result.timedOut') }}</span>
      <span v-if="envelope?.duration_ms != null" class="flex items-center gap-1 font-mono text-xs text-[var(--hr-text-3)]">
        <Clock class="h-3 w-3" />{{ fmtDuration(envelope.duration_ms) }}
      </span>
    </div>

    <!-- 命令行 -->
    <div v-if="commandLine" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">
        <Terminal class="h-3 w-3" />{{ t('dag.result.command') }}
      </div>
      <div data-testid="command-result-line" class="break-all font-mono text-xs text-[var(--hr-text-1)]">{{ commandLine }}</div>
      <div v-if="envelope?.cwd" class="mt-1 font-mono text-[10px] text-[var(--hr-text-4)]">cwd: {{ envelope.cwd }}</div>
    </div>

    <!-- 错误 -->
    <div v-if="envelope?.error" class="rounded-lg border border-[var(--hr-danger-border)] bg-[var(--hr-danger-soft)] px-3 py-2 text-xs text-[var(--hr-danger)]">
      {{ envelope.error }}
    </div>

    <!-- 解析值 -->
    <div v-if="displayValue !== null" class="rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2">
      <div class="mb-1 text-[10px] uppercase tracking-wide text-[var(--hr-text-4)]">{{ t('dag.result.parsedValue') }}</div>
      <pre data-testid="command-result-value" class="whitespace-pre-wrap break-all font-mono text-xs text-[var(--hr-text-1)]">{{ displayValue }}</pre>
    </div>

    <!-- stdout -->
    <div v-if="hasStdout" class="rounded-lg border border-[var(--hr-border)]">
      <button
        data-testid="command-stdout-toggle"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-1)]"
        @click="showStdout = !showStdout"
      >
        <component :is="showStdout ? ChevronUp : ChevronDown" class="h-3.5 w-3.5 text-[var(--hr-text-3)]" />
        stdout
      </button>
      <pre v-if="showStdout" class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2 font-mono text-xs text-[var(--hr-text-2)]">{{ envelope?.stdout }}</pre>
    </div>

    <!-- stderr -->
    <div v-if="hasStderr" class="rounded-lg border border-[var(--hr-border)]">
      <button
        data-testid="command-stderr-toggle"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--hr-text-2)] hover:bg-[var(--hr-surface-1)]"
        @click="showStderr = !showStderr"
      >
        <component :is="showStderr ? ChevronUp : ChevronDown" class="h-3.5 w-3.5 text-[var(--hr-text-3)]" />
        stderr
      </button>
      <pre v-if="showStderr" class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all border-t border-[var(--hr-border)] bg-[var(--hr-surface-1)] px-3 py-2 font-mono text-xs text-[var(--hr-danger)]">{{ envelope?.stderr }}</pre>
    </div>
  </div>
</template>

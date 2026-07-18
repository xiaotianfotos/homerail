<script setup lang="ts">
import { computed } from 'vue'

// ============================================================================
// Props
// ============================================================================

interface SystemInitMessage {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: string[]
  model: string
  permissionMode: string
  slash_commands: string[]
  apiKeySource: string
  claude_code_version: string
  output_style: string
  agents: string[]
  skills: string[]
  plugins: string[]
  uuid: string
  [key: string]: unknown
}

const props = defineProps<{
  message: SystemInitMessage
  timestamp: string | number
}>()

// ============================================================================
// Computed
// ============================================================================

const displayText = computed(() => {
  const { cwd, tools, model } = props.message
  const toolCount = tools?.length || 0
  return `Agent初始化 • ${cwd} • 工具: ${toolCount}个`
})

const tooltipText = computed(() => {
  const { cwd, tools, model, agents, slash_commands } = props.message
  const lines = [
    `工作目录: ${cwd}`,
    `模型: ${model}`,
    `工具数量: ${tools?.length || 0}`,
    `Agent数量: ${agents?.length || 0}`,
    `命令数量: ${slash_commands?.length || 0}`,
    `版本: ${props.message.claude_code_version || 'unknown'}`
  ]
  return lines.join('\n')
})
</script>

<template>
  <div class="system-message-item" :title="tooltipText">
    <span class="system-icon">⚙</span>
    <span class="system-text">{{ displayText }}</span>
  </div>
</template>

<style scoped>
.system-message-item {
  @apply flex items-center gap-2 px-4 py-2 rounded-lg;
  @apply bg-[var(--hr-surface-1)];
  @apply text-base text-[var(--hr-text-3)];
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}

.system-icon {
  @apply text-[var(--hr-text-4)];
}

.system-text {
  @apply truncate;
}
</style>

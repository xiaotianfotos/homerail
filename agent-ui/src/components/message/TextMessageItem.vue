<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatTimestamp } from '@/utils/message-formatter'
import { ChevronRight, Brain } from 'lucide-vue-next'

// ============================================================================
// Props
// ============================================================================

const props = defineProps<{
  content: string
  timestamp: string | number
  isUserMessage?: boolean
  isThinking?: boolean
}>()

// ============================================================================
// State
// ============================================================================

const thinkingExpanded = ref(false)

// ============================================================================
// Computed
// ============================================================================

const timestamp = computed(() => {
  const ts = props.timestamp
  let parsedTs: number

  if (typeof ts === 'number') {
    parsedTs = ts * 1000
  } else {
    const parsed = new Date(ts).getTime()
    parsedTs = isNaN(parsed) ? Date.now() : parsed
  }

  return formatTimestamp(parsedTs)
})

const displayContent = computed(() => props.content || '')

const itemClass = computed(() => ({
  'text-message-item': true,
  'user-message': props.isUserMessage,
  'thinking-message': props.isThinking,
}))
</script>

<template>
  <div :class="itemClass">
    <!-- 思考消息：折叠显示 -->
    <template v-if="isThinking">
      <div
        class="thinking-header cursor-pointer flex items-center gap-1.5 px-1 py-1 text-xs text-[var(--hr-text-3)] hover:text-[var(--hr-text-1)] transition-colors"
        @click="thinkingExpanded = !thinkingExpanded"
      >
        <Brain class="h-3.5 w-3.5" />
        <ChevronRight class="h-3 w-3 transition-transform" :class="{ 'rotate-90': thinkingExpanded }" />
        <span class="font-medium">{{ thinkingExpanded ? '思考过程' : '查看思考过程' }}</span>
      </div>
      <div v-if="thinkingExpanded" class="thinking-content ml-5 px-3 py-2 text-xs text-[var(--hr-text-3)] rounded max-h-[50vh] overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--hr-border-strong)]">
        {{ displayContent }}
      </div>
    </template>

    <!-- 用户消息：使用 > 符号 -->
    <div v-else-if="isUserMessage" class="left-section user-message-section">
      <span class="user-prompt">&gt;</span>
      <span class="text-content">{{ displayContent }}</span>
    </div>

    <!-- 普通消息：圆点 + 文本 -->
    <div v-else class="left-section">
      <div class="status-dot" />
      <span class="text-content">{{ displayContent }}</span>
    </div>

    <!-- 时间在右上角 -->
    <span v-if="!isThinking" class="timestamp-top-right">{{ timestamp }}</span>
  </div>
</template>

<style scoped>
.text-message-item {
  padding: 12px 12px;
  border-radius: 8px;
  margin-bottom: 8px;
  position: relative;
}

.text-message-item.user-message {
  background-color: var(--hr-accent-soft);
  border-left: 3px solid var(--hr-accent);
}

.text-message-item.thinking-message {
  padding: 4px 12px;
  margin-bottom: 4px;
}

.left-section {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.user-message-section {
  gap: 8px;
}

.user-prompt {
  color: var(--hr-accent);
  font-weight: 600;
  font-size: 16px;
  flex-shrink: 0;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
  background-color: var(--hr-text-2);
}

.text-content {
  flex: 1;
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.timestamp-top-right {
  font-size: 11px;
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  position: absolute;
  top: 8px;
  right: 12px;
}

.thinking-content {
  font-family: monospace;
  line-height: 1.4;
}

.thinking-content::-webkit-scrollbar {
  width: 4px;
}

.thinking-content::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-content::-webkit-scrollbar-thumb {
  background-color: var(--hr-border-strong);
  border-radius: 4px;
}
</style>

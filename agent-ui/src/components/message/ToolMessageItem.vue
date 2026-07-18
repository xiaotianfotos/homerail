<script setup lang="ts">
import { ref, computed } from 'vue'
import type { RenderedToolContent } from '@/utils/tool-renderer'
import { formatTimestamp } from '@/utils/message-formatter'

// ============================================================================
// Props
// ============================================================================

const props = defineProps<{
  toolName: string
  toolInput: Record<string, unknown>
  toolResult?: string | Record<string, unknown> | null
  timestamp: string | number
  isError?: boolean | null
  rendered?: RenderedToolContent
  /** 工具关键信息（显示在工具名后的摘要） */
  toolSummary?: string
}>()

// ============================================================================
// State
// ============================================================================

const expanded = ref(false)

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

const dotColor = computed(() => {
  if (props.isError === true) return 'var(--hr-danger)'
  return 'var(--hr-success)'
})

const displayName = computed(() => props.rendered?.displayName || props.toolName)

const content = computed(() => props.rendered || null)

// 是否可展开（检查输入或结果是否有更多内容）
const isExpandable = computed(() => {
  const c = content.value
  if (!c) return false

  // 输入有更多内容
  const hasMoreInput = c.inputPreview !== c.inputFull && c.inputFull.length > 100

  // 或者有结果内容（包括 resultFull 或 toolResult）
  // 只要工具调用完成且返回了结果（无论内容多少），都应该可以展开查看
  const hasRenderedResult = c.resultFull !== undefined && c.resultFull !== null
  const hasToolResult = props.toolResult !== null && props.toolResult !== undefined
  const hasResult = hasRenderedResult || hasToolResult

  return hasMoreInput || hasResult
})

const displayInput = computed(() => {
  if (!content.value) return ''
  return expanded.value ? content.value.inputFull : content.value.inputPreview
})

const displayResult = computed(() => {
  // 优先使用 rendered.resultFull（包含渲染后的结果）
  // 空字符串不显示
  if (content.value?.resultFull) {
    return content.value.resultFull
  }
  // 其次使用 props.toolResult
  if (props.toolResult !== null && props.toolResult !== undefined) {
    if (typeof props.toolResult === 'string') {
      return props.toolResult
    }
    return JSON.stringify(props.toolResult, null, 2)
  }
  return ''
})

const showResult = computed(() => {
  // rendered 有结果内容时显示（空字符串不显示）
  if (content.value?.resultFull) {
    return true
  }
  // 有 toolResult 时显示（包括 null/undefined 以外的值）
  if (props.toolResult !== null && props.toolResult !== undefined) {
    return true
  }
  return false
})

function toggleExpand() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="tool-message-item">
    <!-- Header: 圆点 + 工具名 + (关键信息) + 时间 -->
    <div class="tool-header">
      <div
        class="status-dot"
        :style="{ backgroundColor: dotColor }"
      />
      <span class="tool-name">{{ displayName }}</span>
      <span v-if="toolSummary" class="tool-summary">({{ toolSummary }})</span>
      <span class="timestamp">{{ timestamp }}</span>
    </div>

    <!-- 工具调用内容（展开后显示输入和结果） -->
    <div class="tool-content">
      <!-- 展开/收起按钮 -->
      <button
        v-if="isExpandable"
        @click="toggleExpand"
        class="expand-btn"
      >
        {{ expanded ? '▼ 收起' : '▶ 展开' }}
      </button>

      <!-- 展开后显示完整内容 -->
      <template v-if="expanded">
        <!-- 输入部分 -->
        <div v-if="displayInput" class="tool-section">
          <pre class="tool-input">{{ displayInput }}</pre>
        </div>

        <!-- 结果部分 -->
        <div v-if="showResult" class="tool-section">
          <pre
            class="tool-result"
            :class="{ 'is-error': isError === true }"
          >{{ displayResult }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool-message-item {
  padding: 12px 12px;
  border-radius: 6px;
  margin-bottom: 4px;
  position: relative;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 1px;
}

.tool-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--hr-text-1);
  white-space: nowrap;
}

.tool-summary {
  font-size: 14px;
  color: var(--hr-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 500px;
}

.timestamp {
  font-size: 11px;
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  margin-left: auto;
}

.tool-content {
  margin-top: 4px;
  margin-left: 14px;
}

.expand-btn {
  font-size: 10px;
  padding: 1px 4px;
  margin-bottom: 2px;
  opacity: 0.6;
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  transition: opacity 0.2s;
}

.expand-btn:hover {
  opacity: 1;
}

.tool-section {
  margin-top: 4px;
}

.tool-input,
.tool-result {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: 1.7;
  padding: 8px 10px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0;
  word-break: break-all;
  max-height: 300px;
}

.tool-input {
  background: var(--hr-accent-soft);
  border: 1px solid var(--hr-accent-border);
  color: var(--hr-accent);
}

.tool-result {
  background: var(--hr-success-soft);
  border: 1px solid var(--hr-success-border);
  color: var(--hr-success);
}

.tool-result.is-error {
  background: var(--hr-danger-soft);
  border: 1px solid var(--hr-danger-border);
  color: var(--hr-danger);
}
</style>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { ClaudeMessage } from '@/api/types/run.types'
import { renderToolContent, type RenderedToolContent } from '@/utils/tool-renderer'
import TextMessageItem from './TextMessageItem.vue'
import ToolMessageItem from './ToolMessageItem.vue'
import SystemMessageItem from './SystemMessageItem.vue'
import RoundDivider from './RoundDivider.vue'

// ============================================================================
// Types
// ============================================================================

interface RoundStartMessage {
  type: 'round_start'
  round_id: number
  timestamp: string
  instance_id: string
  run_id: string
  [key: string]: unknown
}

interface RenderedMessage {
  id: string
  type: 'text' | 'tool_pair' | 'system_init' | 'thinking' | 'round_placeholder'
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string | Record<string, unknown> | null
  isError?: boolean | null
  rendered?: RenderedToolContent
  timestamp: string
  roundId?: number
  systemContent?: Record<string, unknown>
  /** 工具关键信息（显示在工具名后的摘要） */
  toolSummary?: string
  /** 是否是用户消息（用于特殊显示样式） */
  isUserMessage?: boolean
}

// ============================================================================
// Props
// ============================================================================

const props = defineProps<{
  messages: ClaudeMessage[]
  loading?: boolean
  emptyText?: string
  rounds?: RoundStartMessage[]
  currentRoundId?: number | null
}>()

// ============================================================================
// Emits
// ============================================================================

const emit = defineEmits<{
  (e: 'retry', message: ClaudeMessage): void
  (e: 'jumpToRound', roundId: number): void
}>()

// ============================================================================
// State
// ============================================================================

const roundRefs = ref<Record<number, HTMLElement | null>>({})
const scrollViewport = ref<HTMLElement | null>(null)
const wrapperRef = ref<HTMLElement | null>(null)  // 🔧 新增：当前组件的 wrapper 引用

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 从 ClaudeMessage 中提取文本内容
 */
function extractTextContent(msg: ClaudeMessage): string {
  if (msg.content) {
    return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)
  }
  return ''
}

/**
 * 提取工具名称
 */
function extractToolName(tool: Record<string, unknown>): string {
  if ('name' in tool) {
    return String(tool.name)
  }
  return ''
}

/**
 * 提取工具输入
 */
function extractToolInput(tool: Record<string, unknown>): Record<string, unknown> {
  if ('input' in tool && typeof tool.input === 'object') {
    return tool.input as Record<string, unknown>
  }
  return {}
}

/**
 * 提取工具关键信息（显示在工具名后的摘要）
 * 参考 Claude Code 格式: "Bash (ls -la)" -> 提取 "ls -la"
 */
function extractToolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'bash':
    case 'Shell':
      // 提取命令
      if (toolInput.cmd) return String(toolInput.cmd)
      if (toolInput.command) return String(toolInput.command)
      if (toolInput.script) return String(toolInput.script)
      break

    case 'Read':
    case 'ReadFile':
    case 'read_file':
      // 提取文件路径
      if (toolInput.path) return String(toolInput.path)
      if (toolInput.file_path) return String(toolInput.file_path)
      if (toolInput.file) return String(toolInput.file)
      break

    case 'Write':
    case 'WriteFile':
    case 'write_file':
      // 提取文件路径
      if (toolInput.path) return String(toolInput.path)
      if (toolInput.file_path) return String(toolInput.file_path)
      if (toolInput.file) return String(toolInput.file)
      // 如果有 path，显示 path，否则显示摘要
      break

    case 'Glob':
    case 'glob':
      // 提取模式
      if (toolInput.pattern) return String(toolInput.pattern)
      if (toolInput.glob) return String(toolInput.glob)
      break

    case 'Grep':
    case 'grep':
      // 提取搜索模式
      if (toolInput.pattern) return String(toolInput.pattern)
      if (toolInput.query) return String(toolInput.query)
      break

    case 'Edit':
    case 'edit':
      // 提取文件路径
      if (toolInput.path) return String(toolInput.path)
      if (toolInput.file_path) return String(toolInput.file_path)
      break

    case 'LS':
    case 'List':
    case 'list_dir':
      // 提取目录路径
      if (toolInput.path) return String(toolInput.path)
      if (toolInput.dir) return String(toolInput.dir)
      break

    case 'Task':
    case 'task':
      // 提取任务名
      if (toolInput.name) return String(toolInput.name)
      if (toolInput.task) return String(toolInput.task)
      break

    case 'WebFetch':
    case 'web_fetch':
      // 提取 URL
      if (toolInput.url) return String(toolInput.url)
      break

    case 'WebSearch':
    case 'web_search':
      // 提取搜索查询
      if (toolInput.query) return String(toolInput.query)
      if (toolInput.search) return String(toolInput.search)
      break

    default:
      // 默认：尝试找有意义的字段
      const meaningfulFields = ['path', 'file', 'file_path', 'cmd', 'command', 'query', 'pattern', 'name', 'url']
      for (const field of meaningfulFields) {
        if (toolInput[field]) {
          const val = toolInput[field]
          const strVal = typeof val === 'string' ? val : JSON.stringify(val)
          // 截断过长的内容
          return strVal.length > 80 ? strVal.slice(0, 80) + '...' : strVal
        }
      }
  }
  return ''
}

/**
 * 配对并渲染工具消息
 * 假设网络返回顺序正确：tool_use 紧跟 tool_result
 */
function renderMessages(messages: ClaudeMessage[]): RenderedMessage[] {
  const result: RenderedMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const msgAny = msg as any
    const responseType = msgAny.response_type
    const msgType = msgAny.type

    // 提取 roundId（从 renderList 预先标记）
    const roundId = msgAny.roundId

    // 跳过 round_start（检查 type 或 response_type）
    if (msgType === 'round_start' || responseType === 'round_start') {
      continue
    }

    // 处理 system init 消息（Agent 初始化信息）
    // 隐藏这些消息，不显示在界面上
    // 支持多种格式：
    // 1. response_type: "system", content: { type: "system", subtype: "init" }
    // 2. response_type: "text", content: { type: "system", subtype: "init" } (Worker 消息)
    // 3. 旧版: { type: "system", subtype: "init", ... }
    const contentAny = msgAny.content
    const isSystemInitByResponse = responseType === 'system' && contentAny?.subtype === 'init'
    const isSystemInitByContent = contentAny?.type === 'system' && contentAny?.subtype === 'init'
    const isSystemInitLegacy = (msg as any).type === 'system' && msgAny.subtype === 'init'

    if (isSystemInitByResponse || isSystemInitByContent || isSystemInitLegacy) {
      // 隐藏系统初始化消息，不添加到渲染列表
      continue
    }

    // 跳过其他 system 消息（纯 system 类型，没有 subtype init）
    if (responseType === 'system') {
      continue
    }

    // 处理用户消息（type === 'user_message'）
    if (msgType === 'user_message') {
      result.push({
        id: msg.id || `user_msg-${msg.timestamp}`,
        type: 'text' as const,
        content: msgAny.content || '',
        timestamp: msg.timestamp,
        roundId,
        isUserMessage: true
      })
      continue
    }

    // 检查是否是 tool_use
    if (msg.type === 'tool_call' || responseType === 'tool_use') {
      // 提取工具信息
      let toolName = ''
      let toolInput: Record<string, unknown> = {}
      let toolId = ''

      if (responseType === 'tool_use' && msg.content && typeof msg.content === 'object') {
        // 新版格式
        toolName = (msg.content as any).name || ''
        toolInput = (msg.content as any).input || {}
        toolId = (msg.content as any).tool_id || ''
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        // 旧版格式
        const tool = msg.tool_calls[0]
        toolName = extractToolName(tool)
        toolInput = extractToolInput(tool)
      }

      if (!toolName) {
        continue
      }

      // 查找下一条消息（假设网络顺序正确）
      let toolResult: string | Record<string, unknown> | null = null
      let isError: boolean | null = null
      let resultTimestamp = msg.timestamp

      if (i + 1 < messages.length) {
        const nextMsg = messages[i + 1]
        const nextMsgAny = nextMsg as any
        const nextResponseType = nextMsgAny.response_type

        // 检查下一条是否是配对的 tool_result
        let nextToolUseId = ''
        if (nextResponseType === 'tool_result' && nextMsg.content && typeof nextMsg.content === 'object') {
          nextToolUseId = (nextMsg.content as any).tool_use_id || ''
        } else if (nextMsg.type === 'tool_result') {
          nextToolUseId = (nextMsg.content as any)?.tool_use_id || ''
        }

        // 如果 tool_id 存在，检查是否匹配
        if (toolId && nextToolUseId === toolId) {
          // 配对成功，提取结果
          if (nextResponseType === 'tool_result' && nextMsg.content && typeof nextMsg.content === 'object') {
            const contentValue = (nextMsg.content as any).content
            toolResult = contentValue !== undefined ? contentValue : null
            isError = (nextMsg.content as any).is_error === true
            resultTimestamp = nextMsg.timestamp
          } else if (nextMsg.type === 'tool_result') {
            toolResult = nextMsg.content !== undefined ? nextMsg.content : null
            isError = nextMsg.status === 'failed'
            resultTimestamp = nextMsg.timestamp
          }
          // 跳过下一条消息（因为已经配对处理）
          i++
        } else if (!toolId && nextMsg.type === 'tool_result') {
          // 没有 tool_id，假设下一个就是结果
          if (nextMsg.content && typeof nextMsg.content === 'object') {
            const contentValue = (nextMsg.content as any).content
            toolResult = contentValue !== undefined ? contentValue : null
            isError = (nextMsg.content as any).is_error === true
            resultTimestamp = nextMsg.timestamp
          } else {
            toolResult = nextMsg.content !== undefined ? nextMsg.content : null
            isError = nextMsg.status === 'failed'
            resultTimestamp = nextMsg.timestamp
          }
          i++
        }
        // 如果下一条不是 tool_result，保持 toolResult = null, isError = null（黄色状态）
      }

      // 渲染工具内容
      const rendered = renderToolContent(toolName, toolInput, toolResult, isError)
      const toolSummary = extractToolSummary(toolName, toolInput)

      result.push({
        id: toolId || msg.id || `tool-pair-${result.length}`,
        type: 'tool_pair' as const,
        toolName,
        toolInput,
        toolResult,
        isError,
        rendered,
        toolSummary,
        timestamp: resultTimestamp,
        roundId
      })
      continue
    }

    // 处理 thinking 类型（Claude 思考过程）— 连续 thinking 合并显示
    if (msgType === 'thinking' || responseType === 'thinking') {
      const text = extractTextContent(msg)
      // 如果前一条也是 thinking，合并内容
      const lastRendered = result[result.length - 1]
      if (lastRendered && lastRendered.type === 'thinking') {
        lastRendered.content = (lastRendered.content || '') + '\n' + text
        lastRendered.timestamp = msg.timestamp
      } else {
        result.push({
          id: msg.id || `${msg.timestamp}-thinking`,
          type: 'thinking' as const,
          content: text,
          timestamp: msg.timestamp,
          roundId,
        })
      }
      continue
    }

    // 处理 text 类型（包括 DAG 转换的 assistant_message）
    // 排除 content.type === 'system' 的情况（那是系统初始化消息）
    if ((responseType === 'text' || msgType === 'assistant_message') && contentAny?.type !== 'system') {
      // 检查是否是用户消息
      const isUserMessage = msgType === 'user_message'
      const textContent = extractTextContent(msg)

      // 连续 assistant text 合并（和 thinking 合并逻辑一致）
      if (!isUserMessage) {
        const lastRendered = result[result.length - 1]
        if (lastRendered && lastRendered.type === 'text' && !lastRendered.isUserMessage) {
          lastRendered.content = (lastRendered.content || '') + textContent
          lastRendered.timestamp = msg.timestamp
          continue
        }
      }

      result.push({
        id: msg.id || `text-${result.length}`,
        type: 'text' as const,
        content: textContent,
        timestamp: msg.timestamp,
        roundId,
        isUserMessage
      })
      continue
    }

    // 处理其他未知类型（跳过）
  }

  return result
}

// ============================================================================
// Computed
// ============================================================================

// 过滤消息（不过滤 round_start，用于检测轮次变化）
const filteredMessages = computed(() => {
  // 调试：检查 props.messages 中是否有重复的 ID
  const ids = props.messages.map(m => m.id)
  const uniqueIds = new Set(ids)
  if (ids.length !== uniqueIds.size) {
    console.warn('[MessageList] DUPLICATE MESSAGES DETECTED!', {
      total: ids.length,
      unique: uniqueIds.size,
      duplicateIds: ids.filter((id, idx) => ids.indexOf(id) !== idx)
    })
  }

  const filtered = props.messages.filter(msg => {
    const msgAny = msg as any
    const responseType = msgAny.response_type

    // 跳过 system 消息（对用户价值不大）
    if (responseType === 'system') return false

    // 其他消息都通过（包括 round_start，用于检测轮次变化）
    return true
  })

  console.log('[MessageList] filteredMessages:', filtered.length, 'from', props.messages.length, 'total messages')
  return filtered
})

// 提取轮次（从消息中提取，使用数组避免 round_id 重复时丢失数据）
const allRounds = computed(() => {
  // 🔧 修复：使用数组而非 Map，避免服务器重启后 round_id 重复导致数据丢失
  const roundStartEvents: RoundStartMessage[] = []

  // 从实际消息中提取轮次信息
  filteredMessages.value.forEach((msg) => {
    const msgAny = msg as any
    const responseType = msgAny.response_type
    const msgType = msgAny.type

    // 检查 type 或 response_type 是否为 round_start
    if ((msgType === 'round_start' || responseType === 'round_start') && msgAny.round_id) {
      const roundInfo: RoundStartMessage = {
        type: 'round_start',
        round_id: msgAny.round_id,
        timestamp: msgAny.timestamp || new Date().toISOString(),
        instance_id: msgAny.instance_id || '',
        run_id: msgAny.run_id || ''
      }
      roundStartEvents.push(roundInfo)
    }
  })

  // 按出现顺序分配客户端编号（1, 2, 3...）
  return roundStartEvents.map((round, index) => ({
    ...round,
    round_id: index + 1  // 使用客户端连续编号
  }))
})

// 渲染列表
const renderList = computed<RenderedMessage[]>(() => {
  const messages = filteredMessages.value  // 已按时间戳排序

  // 🔧 修复：使用数组而非 Map 收集所有 round_start 事件
  // 解决服务器重启后 round_id 重复的问题（多个 round_start 都用 round_id=1）
  const roundStartEvents: Array<{ serverRoundId: number; timestamp: string; msg: any }> = []
  messages.forEach((msg, idx) => {
    const msgAny = msg as any
    const responseType = msgAny.response_type
    const msgType = msgAny.type

    // 检查 type 或 response_type 是否为 round_start
    if ((msgType === 'round_start' || responseType === 'round_start') && msgAny.round_id) {
      roundStartEvents.push({
        serverRoundId: msgAny.round_id,
        timestamp: msgAny.timestamp || new Date().toISOString(),
        msg: msgAny
      })
      console.log('[MessageList] Found round_start at index', idx, 'server_round_id:', msgAny.round_id, 'timestamp:', msgAny.timestamp?.substring(11, 19))
    }
  })

  // 按时间戳排序（由于 messages 已经排序，这应该保持顺序）
  const sortedRounds = roundStartEvents.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime()
    const timeB = new Date(b.timestamp).getTime()
    return timeA - timeB
  })

  // 创建客户端连续编号（1, 2, 3...）
  const roundStartClientIds = new Map<string, number>()  // key: timestamp + serverRoundId
  sortedRounds.forEach((round, index) => {
    const key = `${round.timestamp}_${round.serverRoundId}`
    roundStartClientIds.set(key, index + 1)
  })

  // 为每条消息分配客户端轮次编号
  let currentClientRoundId = 1
  const messagesWithRoundId: Array<ClaudeMessage & { roundId?: number }> = []

  messages.forEach((msg, idx) => {
    const msgAny = msg as any
    const responseType = msgAny.response_type
    const msgType = msgAny.type

    // 检测 round_start 消息，更新当前轮次
    if (msgType === 'round_start' || responseType === 'round_start') {
      if (msgAny.round_id) {
        // 使用 timestamp + serverRoundId 作为唯一键查找客户端编号
        const key = `${(msgAny.timestamp || new Date().toISOString())}_${msgAny.round_id}`
        currentClientRoundId = roundStartClientIds.get(key) || sortedRounds.length + 1
        console.log('[MessageList] Round start at index', idx, 'server_round_id:', msgAny.round_id, '→ client_round_number:', currentClientRoundId)
      }
      // round_start 消息本身不渲染
      return
    }

    // 为非 round_start 消息标记客户端轮次编号
    messagesWithRoundId.push({ ...msg, roundId: currentClientRoundId })
  })

  console.log('[MessageList] messagesWithRoundId (first 5):', messagesWithRoundId.slice(0, 5).map(m => {
    let timeStr = ''
    if (typeof m.timestamp === 'string') {
      timeStr = m.timestamp.substring(11, 19)
    } else if (typeof m.timestamp === 'number') {
      timeStr = new Date(m.timestamp * 1000).toISOString().substring(11, 19)
    }
    return {
      time: timeStr,
      roundId: m.roundId
    }
  }))

  // 一次性渲染所有消息
  let rendered = renderMessages(messagesWithRoundId)

  // 获取所有客户端轮次编号
  const clientRoundIds = Array.from(roundStartClientIds.values()).sort((a, b) => a - b)

  // 确保所有轮次都有对应的分隔符
  const renderedRoundIds = new Set(rendered.map(r => r.roundId).filter(id => id !== undefined))
  const missingRounds = clientRoundIds.filter(rid => !renderedRoundIds.has(rid))

  if (missingRounds.length > 0) {
    const placeholders = missingRounds.map(rid => ({
      id: `round-${rid}-placeholder`,
      type: 'round_placeholder' as const,
      roundId: rid,
      timestamp: new Date().toISOString()
    }))
    rendered = [...placeholders, ...rendered]
  }

  // 过滤掉没有 roundId 的消息
  return rendered.filter(item => item.roundId !== undefined)
})

// ============================================================================
// Methods
// ============================================================================

function jumpToRound(roundId: number) {
  emit('jumpToRound', roundId)
  scrollToRound(roundId)
}

/**
 * 查找可滚动的父级容器
 * 优先返回真正可滚动的容器（scrollHeight > clientHeight）
 */
function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element
  const candidates: Array<{ element: HTMLElement; canScroll: boolean }> = []

  // 第一遍：收集所有可能的滚动容器
  while (current) {
    // 优先检查是否是 ScrollArea 的 viewport（通过 data 属性判断）
    if (current.hasAttribute('data-scroll-area-viewport')) {
      return current
    }

    // 检查是否有滚动属性
    const style = window.getComputedStyle(current)
    const overflowY = style.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      // 检查是否真的可以滚动
      const canScroll = current.scrollHeight > current.clientHeight
      candidates.push({ element: current, canScroll })
    }

    current = current.parentElement
  }

  // 第二遍：优先返回真正可滚动的容器
  const scrollable = candidates.find(c => c.canScroll)
  if (scrollable) {
    return scrollable.element
  }

  // 如果没有可滚动的，返回第一个有滚动属性的容器
  if (candidates.length > 0) {
    return candidates[0].element
  }

  return null
}

/**
 * 滚动到指定轮次
 */
function scrollToRound(roundId: number) {
  nextTick(() => {
    const element = roundRefs.value[roundId]
    if (!element) {
      console.warn('[MessageList] roundRefs[' + roundId + '] is empty')
      return
    }

    // 简单实现：居中显示，避免被导航栏遮挡
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

// ============================================================================
// Expose
// ============================================================================

defineExpose({
  /**
   * 滚动到底部
   * 使用组件内部的 wrapperRef，避免 document.querySelector 找到错误的元素
   */
  scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    nextTick(() => {
      // 🔧 修复：使用组件内部的 wrapperRef，而非 document.querySelector
      const wrapper = wrapperRef.value
      if (!wrapper) {
        console.warn('[MessageList] wrapperRef not found')
        return
      }

      // 查找可滚动的父容器（ScrollArea 的 viewport）
      const viewport = findScrollContainer(wrapper)
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior
        })
      } else {
        console.warn('[MessageList] No scrollable parent container found')
      }
    })
  },

  /**
   * 滚动到顶部
   */
  scrollToTop(behavior: ScrollBehavior = 'smooth') {
    nextTick(() => {
      // 🔧 修复：使用组件内部的 wrapperRef
      const wrapper = wrapperRef.value
      if (!wrapper) return

      const viewport = findScrollContainer(wrapper)
      if (viewport) {
        viewport.scrollTo({
          top: 0,
          behavior
        })
      }
    })
  }
})

// ============================================================================
// Watch
// ============================================================================

// 监听当前轮次变化
watch(() => props.currentRoundId, (newRoundId) => {
  if (newRoundId !== null && newRoundId !== undefined) {
    scrollToRound(newRoundId)
  }
})

// 监听消息列表变化，智能滚动到底部
// — 新消息追加时：总是滚底（实时流式体验）
// — 整批重载时（长度先归零再跳回）：不滚底，由 DagDetailPanel 恢复位置
watch(() => renderList.value.length, (newLength, oldLength) => {
  if (newLength > (oldLength || 0)) {
    nextTick(() => {
      const wrapper = wrapperRef.value
      if (!wrapper) return

      const viewport = findScrollContainer(wrapper)
      if (!viewport) return

      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: 'auto'
      })
    })
  }
}, { flush: 'post' })
</script>

<template>
  <!-- 轮次导航栏 - 在 wrapper 外面，不受内部滚动影响 -->
  <div v-if="allRounds.length > 0" class="round-nav-fixed">
    <div class="round-nav-title">
      <span class="round-count">{{ allRounds.length }} 轮</span>
    </div>
    <div class="round-nav-buttons">
      <button
        v-for="round in allRounds"
        :key="round.round_id"
        :class="['round-nav-btn', { active: currentRoundId === round.round_id }]"
        @click="jumpToRound(round.round_id)"
      >
        {{ round.round_id }}
      </button>
    </div>
  </div>

  <div ref="wrapperRef" class="message-list-wrapper">
    <!-- 消息列表容器 -->
    <div class="message-list">
      <!-- Loading State -->
      <div v-if="loading" class="loading-state">
        <div class="inline-block h-6 w-6 border-2 border-[var(--hr-accent)] border-t-transparent rounded-full animate-spin"></div>
        <p class="text-sm text-[var(--hr-text-3)] mt-2">加载消息中...</p>
      </div>

      <!-- Empty State -->
      <div
        v-else-if="filteredMessages.length === 0"
        class="empty-state"
      >
        <slot name="empty">
          <p class="text-sm text-[var(--hr-text-3)]">{{ emptyText || '暂无消息' }}</p>
        </slot>
      </div>

      <!-- Message List -->
      <template v-else>
        <template v-for="(item, index) in renderList" :key="item.id">
          <!-- 轮次分隔符 -->
          <RoundDivider
            v-if="allRounds.length > 0 && (index === 0 || (item.roundId && renderList[index - 1].roundId !== item.roundId))"
            :ref="(el: any) => { if (el) roundRefs[item.roundId || 1] = el.$el }"
            :round="{
              type: 'round_start',
              round_id: item.roundId || 1,
              timestamp: typeof item.timestamp === 'string'
                ? item.timestamp
                : new Date((item.timestamp as number) * 1000).toISOString(),
              instance_id: '',
              run_id: ''
            }"
            :is-first="index === 0"
          />

          <!-- 文本消息 -->
          <TextMessageItem
            v-if="item.type === 'text'"
            :content="item.content || ''"
            :timestamp="item.timestamp"
            :is-user-message="item.isUserMessage"
          />

          <!-- 思考过程消息 -->
          <TextMessageItem
            v-else-if="item.type === 'thinking'"
            :content="item.content || ''"
            :timestamp="item.timestamp"
            :is-thinking="true"
          />

          <!-- 工具对消息 -->
          <ToolMessageItem
            v-else-if="item.type === 'tool_pair'"
            :tool-name="item.toolName || ''"
            :tool-input="item.toolInput || {}"
            :tool-result="item.toolResult"
            :timestamp="item.timestamp"
            :is-error="item.isError"
            :rendered="item.rendered"
            :tool-summary="item.toolSummary"
          />

          <!-- 系统初始化消息 -->
          <SystemMessageItem
            v-else-if="item.type === 'system_init'"
            :message="item.systemContent as any"
            :timestamp="item.timestamp"
          />

          <!-- 空轮次占位符（仅用于触发分割符显示，不渲染实际内容） -->
          <div v-else-if="item.type === 'round_placeholder'" class="round-empty-placeholder">
            <!-- 此轮次没有可见消息 -->
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.message-list-wrapper {
  @apply flex flex-col;
  overflow-x: hidden;  /* 防止水平滚动条 */
}

/* 轮次导航栏 - 固定在 ScrollArea 顶部 */
.round-nav-fixed {
  @apply flex items-center gap-3 px-4 py-2 bg-[var(--hr-panel)] backdrop-blur border-b border-[var(--hr-border)];
  position: sticky;
  top: 0;
  z-index: 50;
  flex-shrink: 0;
  /* 确保导航栏不随内容滚动 */
  overflow-anchor: none;
}

.round-nav-title {
  @apply text-xs font-medium text-[var(--hr-text-3)] whitespace-nowrap;
}

.round-count {
  @apply bg-[var(--hr-surface-2)] px-2 py-0.5 rounded;
}

.round-nav-buttons {
  @apply flex flex-wrap gap-1;
}

.round-nav-btn {
  @apply w-6 h-6 text-xs font-medium rounded transition-all;
  @apply bg-[var(--hr-surface-1)] text-[var(--hr-text-2)];
  @apply hover:bg-[var(--hr-accent-hover)] hover:text-[var(--hr-on-accent)];
}

.round-nav-btn.active {
  @apply bg-[var(--hr-accent)] text-[var(--hr-on-accent)];
}

.message-list {
  @apply space-y-2;
}

.loading-state,
.empty-state {
  @apply flex flex-col items-center justify-center py-8 text-center;
}
</style>

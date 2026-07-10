/**
 * ============================================================================
 * Message Formatter - 消息格式化工具
 * ============================================================================
 *
 * 提供统一消息格式的解析和格式化功能
 *
 * 功能：
 * - 解析 JSONL 日志行
 * - 格式化消息内容（Markdown 支持）
 * - 提取工具调用信息
 * - 生成显示文本
 */

import MarkdownIt from 'markdown-it'
import type { UnifiedMessage, MessageType, ToolUseContent, ToolResultContent } from '@/api/types/run.types'

// ============================================================================
// Markdown Parser Setup
// ============================================================================

const markdown = new MarkdownIt({
  html: false,          // 禁用 HTML 解析（安全）
  linkify: true,        // 自动转换 URL 为链接
  typographer: true,    // 优化排版
  breaks: true          // 转换换行符
})

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * 安全解析 JSONL 行
 */
export function parseJsonlLine(line: string): UnifiedMessage | null {
  try {
    const parsed = JSON.parse(line)
    // 验证基本结构
    if (parsed.type === 'claude_response' && parsed.response_type) {
      return parsed as UnifiedMessage
    }
    return null
  } catch {
    return null
  }
}

/**
 * 解析 JSONL 行（包括 round_start 类型）
 * 返回联合类型以支持所有消息类型
 */
type RoundStartJsonlMessage = { type: 'round_start'; round_id: number; timestamp: string; [key: string]: unknown }

export function parseJsonlLineAny(line: string): UnifiedMessage | RoundStartJsonlMessage | null {
  try {
    const parsed = JSON.parse(line)
    // 验证基本结构
    if (parsed.type === 'claude_response' && parsed.response_type) {
      return parsed as UnifiedMessage
    }
    if (parsed.type === 'round_start' && typeof parsed.round_id === 'number') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * 解析 JSONL 字符串为消息数组（包含 round_start）
 */
export function parseJsonlWithRounds(content: string): Array<UnifiedMessage | RoundStartJsonlMessage> {
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => parseJsonlLineAny(line))
    .filter((msg): msg is UnifiedMessage | RoundStartJsonlMessage => msg !== null)
}

/**
 * 解析 JSONL 字符串为消息数组
 */
export function parseJsonl(content: string): UnifiedMessage[] {
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => parseJsonlLine(line))
    .filter((msg): msg is UnifiedMessage => msg !== null)
}

/**
 * 格式化时间戳
 * @param timestamp 毫秒级时间戳
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-Hans', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  })
}

/**
 * 获取消息类型配置
 */
export function getMessageTypeConfig(type: MessageType) {
  const config: Record<MessageType, { color: string; bgClass: string }> = {
    system: { color: '#6b7280', bgClass: 'bg-gray-100 dark:bg-gray-800' },
    text: { color: '#10b981', bgClass: 'bg-green-100 dark:bg-green-900/30' },
    tool_use: { color: '#3b82f6', bgClass: 'bg-blue-100 dark:bg-blue-900/30' },
    tool_result: { color: '#22c55e', bgClass: 'bg-emerald-100 dark:bg-emerald-900/30' },
    round_start: { color: '#f59e0b', bgClass: 'bg-amber-100 dark:bg-amber-900/30' }
  }
  return config[type] || config.text
}

/**
 * 获取工具结果状态颜色
 */
export function getToolResultStatus(is_error: boolean | null): {
  color: string
  text: string
} {
  if (is_error === true) {
    return { color: '#ef4444', text: '失败' }
  }
  if (is_error === false) {
    return { color: '#22c55e', text: '成功' }
  }
  return { color: '#f59e0b', text: '等待' }
}

// ============================================================================
// Content Formatting
// ============================================================================

/**
 * 格式化文本内容（支持 Markdown）
 */
export function formatTextContent(text: unknown): string {
  if (typeof text === 'string') {
    return text
  }
  if (typeof text === 'object' && text !== null) {
    return JSON.stringify(text, null, 2)
  }
  return String(text)
}

/**
 * 渲染 Markdown
 */
export function renderMarkdown(text: string): string {
  return markdown.render(text)
}

/**
 * 格式化工具调用内容
 */
export function formatToolUse(content: ToolUseContent): {
  name: string
  inputPreview: string
  inputFull: string
} {
  const inputStr = JSON.stringify(content.input, null, 2)
  // 预览：截取前 200 字符
  const preview = inputStr.length > 200
    ? inputStr.slice(0, 200) + '...'
    : inputStr

  return {
    name: content.name,
    inputPreview: preview,
    inputFull: inputStr
  }
}

/**
 * 格式化工具结果内容
 */
export function formatToolResult(content: ToolResultContent): {
  isError: boolean | null
  statusText: string
  contentPreview: string
  contentFull: string
} {
  const status = getToolResultStatus(content.is_error)

  let contentStr: string
  if (typeof content.content === 'string') {
    contentStr = content.content
  } else if (typeof content.content === 'object' && content.content !== null) {
    contentStr = JSON.stringify(content.content, null, 2)
  } else {
    contentStr = String(content.content)
  }

  // 预览：截取前 500 字符
  const preview = contentStr.length > 500
    ? contentStr.slice(0, 500) + '...'
    : contentStr

  return {
    isError: content.is_error,
    statusText: status.text,
    contentPreview: preview,
    contentFull: contentStr
  }
}

/**
 * 提取消息的主要文本内容
 */
export function extractMessageText(message: UnifiedMessage): string {
  const { response_type, content } = message

  switch (response_type) {
    case 'text':
      // 文本消息：直接返回内容
      if (typeof content === 'string') return content
      if (content.type === 'text') return String(content.content || '')
      return formatTextContent(content)

    case 'system':
      // 系统消息：返回模型信息
      return `Model: ${(content as any).model || 'Unknown'}`

    case 'tool_use':
      // 工具调用：返回工具名称
      return `Tool: ${(content as ToolUseContent).name}`

    case 'tool_result':
      // 工具结果：返回结果摘要
      const result = content as ToolResultContent
      const status = getToolResultStatus(result.is_error)
      const preview = formatToolResult(result).contentPreview
      return `[${status.text}] ${preview}`

    default:
      return formatTextContent(content)
  }
}

/**
 * 判断消息是否包含可展开内容
 */
export function isExpandable(message: UnifiedMessage): boolean {
  const { response_type, content } = message

  if (response_type === 'tool_use') {
    const input = (content as ToolUseContent).input
    return JSON.stringify(input).length > 200
  }

  if (response_type === 'tool_result') {
    const result = content as ToolResultContent
    const contentStr = typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content)
    return contentStr.length > 500
  }

  if (response_type === 'text') {
    const text = typeof content === 'string' ? content : String(content?.content || '')
    return text.length > 500
  }

  return false
}

// ============================================================================
// Export
// ============================================================================

export const messageFormatter = {
  parseJsonlLine,
  parseJsonl,
  formatTimestamp,
  getMessageTypeConfig,
  getToolResultStatus,
  formatTextContent,
  renderMarkdown,
  formatToolUse,
  formatToolResult,
  extractMessageText,
  isExpandable,
  markdown
}

export default messageFormatter

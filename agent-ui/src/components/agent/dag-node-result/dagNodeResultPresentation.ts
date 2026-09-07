/**
 * dagNodeResultPresentation — 把各类节点的结构化结果 payload 规整成渲染输入。
 *
 * 与后端 homerail_manager 的网关 payload 契约一一对应：
 *  - command   → { ok, command, args, cwd, exit_code, stdout, stderr, duration_ms, value, ... }
 *  - join      → { mode, total, successes, failures, threshold, passed, values }
 *  - condition → 原始输入值（路由到哪个 port 由 handoff.port 表达）
 *  - loop      → { item, index, total, completed_results } | { total, completed, results }
 *  - while     → { input, iteration, max_iterations, matched, exhausted? }
 *  - state     → { updated, operation, record, previous }
 *  - fanout    → { total, completed, successes, failures, threshold, passed, results, ... }
 *  - worker    → 任意 handoff 内容
 */

import type { DAGNodeResult } from '@/api/types/dag.types'

export interface CommandEnvelope {
  ok?: boolean
  command?: string
  args?: string[]
  cwd?: string
  exit_code?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  duration_ms?: number
  timed_out?: boolean
  error?: string
  value?: unknown
  parse_failed?: boolean
}

export interface JoinPayload {
  mode?: string
  total?: number
  successes?: number
  failures?: number
  threshold?: number
  passed?: boolean
  values?: unknown[]
}

export interface LoopPayload {
  item?: unknown
  index?: number
  total?: number
  completed?: boolean
  completed_results?: unknown[]
  results?: unknown[]
}

export interface WhilePayload {
  input?: unknown
  iteration?: number
  max_iterations?: number
  matched?: boolean
  exhausted?: boolean
}

export interface FanoutPayload {
  total?: number
  completed?: number
  successes?: number
  failures?: number
  threshold?: number
  passed?: boolean
  early_completion?: boolean
  results?: unknown[]
}

export interface StatePayload {
  updated?: boolean
  operation?: string
  record?: unknown
  previous?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** command 节点的展示 envelope：优先 telemetry（完整且已脱敏），否则 latest.content。 */
export function resolveCommandEnvelope(result: DAGNodeResult): CommandEnvelope | null {
  if (result.telemetry) return result.telemetry as CommandEnvelope
  const content = result.latest?.content
  if (isRecord(content) && ('exit_code' in content || 'ok' in content || 'stdout' in content)) {
    return content as CommandEnvelope
  }
  return null
}

/** command 节点 handoff 的纯值（result_payload=value 时 envelope 在 telemetry，值在 content）。 */
export function resolveCommandValue(result: DAGNodeResult): unknown {
  const content = result.latest?.content
  if (isRecord(content) && ('exit_code' in content || 'ok' in content)) return undefined
  return content
}

export function asJoinPayload(content: unknown): JoinPayload | null {
  return isRecord(content) && ('successes' in content || 'passed' in content || 'mode' in content)
    ? (content as JoinPayload)
    : null
}

export function asLoopPayload(content: unknown): LoopPayload | null {
  return isRecord(content) && ('item' in content || 'results' in content || 'completed_results' in content || 'completed' in content)
    ? (content as LoopPayload)
    : null
}

export function asWhilePayload(content: unknown): WhilePayload | null {
  return isRecord(content) && ('iteration' in content || 'matched' in content)
    ? (content as WhilePayload)
    : null
}

export function asFanoutPayload(content: unknown): FanoutPayload | null {
  return isRecord(content) && ('results' in content || 'successes' in content || 'early_completion' in content)
    ? (content as FanoutPayload)
    : null
}

export function asStatePayload(content: unknown): StatePayload | null {
  return isRecord(content) && ('operation' in content || 'record' in content || 'updated' in content)
    ? (content as StatePayload)
    : null
}

/** 把任意值格式化为短文本（列表项用）；对象/数组走紧凑 JSON。 */
export function previewValue(value: unknown, maxLength = 160): string {
  if (value === null) return 'null'
  if (value === undefined) return '—'
  if (typeof value === 'string') return truncate(value, maxLength)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return truncate(JSON.stringify(value), maxLength)
  } catch {
    return String(value)
  }
}

/** 把任意值格式化为多行 JSON（详情块用）。 */
export function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

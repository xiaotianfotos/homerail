import type { Ref } from 'vue'
import {
  HOMERAIL_A2UI_MAX_DEPTH,
  HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
  validateHomerailA2uiSurface,
  type A2uiComponentV1,
  type GenerativeUiStoredNodeV1,
  type HomerailA2uiSurfaceV1,
} from 'homerail-protocol'
import type { GenerativeUiPreviewRequestV1 } from './types'

export {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_MAX_BYTES,
  HOMERAIL_A2UI_MAX_COMPONENTS,
  HOMERAIL_A2UI_MAX_DEPTH,
  HOMERAIL_A2UI_MAX_DIRECT_CHILDREN,
  HOMERAIL_A2UI_MAX_SOURCE_ITEMS,
  HOMERAIL_A2UI_VERSION,
} from 'homerail-protocol'
export type { A2uiComponentV1, HomerailA2uiSurfaceV1 } from 'homerail-protocol'

export interface A2uiEvaluationScope {
  value: unknown
  key: string
  index?: number
}

export interface A2uiRuntime {
  components: ReadonlyMap<string, A2uiComponentV1>
  dataModel: Ref<unknown>
  locale: string
  compact: boolean
  expanded: boolean
  requestAction: (name: string) => void
  openPreview: (preview: GenerativeUiPreviewRequestV1) => void
}

const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const TONES = new Set(['neutral', 'positive', 'info', 'warning', 'critical'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pointerSegments(pointer: string, relative: boolean): string[] | undefined {
  if (pointer === '') return []
  const source = relative ? pointer.replace(/^\//, '') : pointer.slice(1)
  if (!relative && !pointer.startsWith('/')) return undefined
  const segments = source.split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  return segments.some(segment => UNSAFE_POINTER_SEGMENTS.has(segment)) ? undefined : segments
}

function readSegments(root: unknown, segments: readonly string[]): unknown {
  let current = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** Resolves standard absolute pointers and A2UI template-relative pointers. */
export function readA2uiPointer(
  pointer: string,
  dataModel: unknown,
  scope: A2uiEvaluationScope,
): unknown {
  const absolute = pointer.startsWith('/')
  const segments = pointerSegments(pointer, !absolute)
  return segments ? readSegments(absolute ? dataModel : scope.value, segments) : undefined
}

/** HomeRail collection field selectors are always relative to one source item. */
export function readA2uiItemPointer(item: unknown, pointer: unknown): unknown {
  if (typeof pointer !== 'string') return undefined
  const segments = pointerSegments(pointer, true)
  return segments ? readSegments(item, segments) : undefined
}

function writableChild(container: unknown, segment: string, create: boolean): unknown {
  if (Array.isArray(container)) {
    if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined
    const index = Number(segment)
    if (container[index] === undefined && create) container[index] = {}
    return container[index]
  }
  if (!isRecord(container)) return undefined
  if (!Object.prototype.hasOwnProperty.call(container, segment) && create) container[segment] = {}
  return container[segment]
}

export function writeA2uiBinding(
  binding: unknown,
  value: unknown,
  dataModel: unknown,
  scope: A2uiEvaluationScope,
): boolean {
  if (!isRecord(binding) || typeof binding.path !== 'string') return false
  const absolute = binding.path.startsWith('/')
  const segments = pointerSegments(binding.path, !absolute)
  if (!segments?.length) return false
  let target = absolute ? dataModel : scope.value
  for (const segment of segments.slice(0, -1)) {
    target = writableChild(target, segment, true)
    if (target === undefined) return false
  }
  const last = segments[segments.length - 1]!
  if (Array.isArray(target)) {
    if (!/^(0|[1-9][0-9]*)$/.test(last)) return false
    target[Number(last)] = value
    return true
  }
  if (!isRecord(target)) return false
  target[last] = value
  return true
}

export function isWritableA2uiBinding(binding: unknown): boolean {
  if (!isRecord(binding) || typeof binding.path !== 'string') return false
  const absolute = binding.path.startsWith('/')
  const segments = pointerSegments(binding.path, !absolute)
  return Boolean(segments?.length && segments.every(segment => segment.length > 0))
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function statusTone(value: unknown): string {
  const status = stringValue(value).trim().toLowerCase()
  if (['passed', 'ready', 'resolved', 'verified', 'succeeded', 'success', 'complete', 'completed', 'healthy'].includes(status)) {
    return 'positive'
  }
  if (['failed', 'blocked', 'critical', 'error', 'denied', 'cancelled', 'unhealthy'].includes(status)) {
    return 'critical'
  }
  if (['warning', 'warn', 'pending', 'paused', 'degraded', 'needs_grant'].includes(status)) return 'warning'
  if (['running', 'active', 'authorized', 'info', 'submitting'].includes(status)) return 'info'
  return 'neutral'
}

function formatDate(value: unknown, format: unknown, locale: string): string {
  const date = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(date.getTime())) return ''
  const pattern = stringValue(format)
  if (!pattern) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  const options: Intl.DateTimeFormatOptions = {}
  if (/y/.test(pattern)) options.year = pattern.includes('yy') && !pattern.includes('yyyy') ? '2-digit' : 'numeric'
  if (/M/.test(pattern)) {
    options.month = pattern.includes('MMMM') ? 'long' : pattern.includes('MMM') ? 'short' : pattern.includes('MM') ? '2-digit' : 'numeric'
  }
  if (/d/.test(pattern)) options.day = pattern.includes('dd') ? '2-digit' : 'numeric'
  if (/E/.test(pattern)) options.weekday = pattern.includes('EEEE') ? 'long' : 'short'
  if (/[Hh]/.test(pattern)) {
    options.hour = pattern.includes('HH') || pattern.includes('hh') ? '2-digit' : 'numeric'
    options.hour12 = /h/.test(pattern)
  }
  if (/m/.test(pattern)) options.minute = '2-digit'
  if (/s/.test(pattern)) options.second = '2-digit'
  return new Intl.DateTimeFormat(locale, options).format(date)
}

function interpolateFormatString(
  template: string,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
): string {
  return template.replace(/\\?\$\{([^{}]+)\}/g, (match, expression: string) => {
    if (match.startsWith('\\')) return match.slice(1)
    const pointer = expression.trim()
    if (!pointer || /[()'"`,]/.test(pointer)) return ''
    return stringValue(readA2uiPointer(pointer, runtime.dataModel.value, scope))
  })
}

function evaluateFunction(
  call: string,
  rawArgs: unknown,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
): unknown {
  const source = isRecord(rawArgs) ? rawArgs : {}
  const args = Object.fromEntries(Object.entries(source).map(([key, value]) => [
    key,
    evaluateA2uiValue(value, runtime, scope),
  ]))
  if (call === 'formatString') {
    return interpolateFormatString(stringValue(args.value), runtime, scope)
  }
  if (call === 'formatNumber') {
    const value = numberValue(args.value)
    if (value === undefined) return ''
    const requestedDecimals = numberValue(args.decimals)
    const decimals = requestedDecimals === undefined
      ? undefined
      : Math.max(0, Math.min(6, Math.round(requestedDecimals)))
    return new Intl.NumberFormat(runtime.locale, {
      useGrouping: args.grouping !== false,
      ...(decimals === undefined ? {} : {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }),
    }).format(value)
  }
  if (call === 'formatCurrency') {
    const value = numberValue(args.value)
    const currency = stringValue(args.currency)
    if (value === undefined || !/^[A-Z]{3}$/.test(currency)) return ''
    const requestedDecimals = numberValue(args.decimals)
    const decimals = requestedDecimals === undefined
      ? undefined
      : Math.max(0, Math.min(6, Math.round(requestedDecimals)))
    return new Intl.NumberFormat(runtime.locale, {
      style: 'currency',
      currency,
      useGrouping: args.grouping !== false,
      ...(decimals === undefined ? {} : {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }),
    }).format(value)
  }
  if (call === 'formatDate') return formatDate(args.value, args.format, runtime.locale)
  if (call === '@index') return (scope.index ?? 0) + (numberValue(args.offset) ?? 0)
  if (call === 'and') return Array.isArray(args.values) && args.values.every(Boolean)
  if (call === 'or') return Array.isArray(args.values) && args.values.some(Boolean)
  if (call === 'not') return !Boolean(args.value)
  if (call === 'required') {
    if (args.value === undefined || args.value === null) return false
    if (typeof args.value === 'string' || Array.isArray(args.value)) return args.value.length > 0
    return true
  }
  if (call === 'length') {
    const length = stringValue(args.value).length
    const min = numberValue(args.min)
    const max = numberValue(args.max)
    return (min === undefined || length >= min) && (max === undefined || length <= max)
  }
  if (call === 'numeric') {
    const value = numberValue(args.value)
    const min = numberValue(args.min)
    const max = numberValue(args.max)
    return value !== undefined && (min === undefined || value >= min) && (max === undefined || value <= max)
  }
  if (call === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue(args.value))
  if (call === 'pluralize') {
    const value = numberValue(args.value)
    if (value === undefined) return stringValue(args.other)
    const category = new Intl.PluralRules(runtime.locale).select(value)
    return stringValue(args[category] ?? args.other)
  }
  return undefined
}

/** Evaluates only DataBindings and the closed, deterministic Catalog function set above. */
export function evaluateA2uiValue(
  value: unknown,
  runtime: A2uiRuntime,
  scope: A2uiEvaluationScope,
): unknown {
  if (Array.isArray(value)) return value.map(item => evaluateA2uiValue(item, runtime, scope))
  if (!isRecord(value)) return value
  if (typeof value.path === 'string') return readA2uiPointer(value.path, runtime.dataModel.value, scope)
  if (typeof value.call === 'string') return evaluateFunction(value.call, value.args, runtime, scope)
  return undefined
}

export function a2uiText(value: unknown): string {
  return stringValue(value)
}

export function a2uiNumber(value: unknown): number | undefined {
  return numberValue(value)
}

export function a2uiTone(value: unknown): string {
  const tone = stringValue(value)
  return TONES.has(tone) ? tone : statusTone(tone)
}

export function validateA2uiSurfaceForNode(
  value: unknown,
  node: GenerativeUiStoredNodeV1,
): HomerailA2uiSurfaceV1 {
  const validation = validateHomerailA2uiSurface(value, {
    action_ids: new Set((node.actions ?? []).map(action => action.id)),
    data_model: node.content,
  })
  if (!validation.valid || !validation.value) {
    throw new Error(`Generated A2UI surface is invalid: ${JSON.stringify(validation.errors)}`)
  }
  return validation.value
}

export function indexA2uiSurface(surface: HomerailA2uiSurfaceV1): ReadonlyMap<string, A2uiComponentV1> {
  return new Map(surface.components.map(component => [component.id, component]))
}

export function a2uiActionNames(surface: HomerailA2uiSurfaceV1): ReadonlySet<string> {
  return scanA2uiActionNames(surface)
}

/** Guarded pre-render scan used only to avoid supplementary Action flicker. */
export function scanA2uiActionNames(value: unknown): ReadonlySet<string> {
  const names = new Set<string>()
  if (!isRecord(value) || !Array.isArray(value.components)) return names
  for (const component of value.components) {
    if (!isRecord(component) || component.component !== 'Button' || !isRecord(component.action) || !isRecord(component.action.event)) continue
    const name = component.action.event.name
    if (typeof name === 'string' && name) names.add(name)
  }
  return names
}

export function isA2uiRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

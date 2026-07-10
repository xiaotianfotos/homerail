/**
 * ============================================================================
 * Utils - 通用工具函数
 * ============================================================================
 *
 * 包含常用的工具函数，如类名合并、类型守卫等
 */

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// ============================================================================
// Class Utils
// ============================================================================

/**
 * 合并Tailwind CSS类名
 * 结合clsx和tailwind-merge，支持条件类名和冲突解决
 *
 * @param inputs - 类名输入（可以是字符串、对象、数组等）
 * @returns 合并后的类名字符串
 *
 * @example
 * cn('px-4', 'py-2', { 'bg-blue': isActive }) // "px-4 py-2 bg-blue"
 * cn('px-4 py-2', 'px-2') // "px-2 py-2" (后面的px-2会覆盖前面的px-4)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * 检查值是否为非空
 */
export function isNotEmpty<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

/**
 * 检查值是否为字符串且非空
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 检查值是否为数字
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value)
}

/**
 * 检查值是否为对象（不是null或数组）
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ============================================================================
// Async Utils
// ============================================================================

/**
 * 延迟函数
 *
 * @param ms - 延迟毫秒数
 * @returns Promise
 *
 * @example
 * await sleep(1000) // 延迟1秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带超时的Promise
 *
 * @param promise - 要执行的Promise
 * @param timeoutMs - 超时时间（毫秒）
 * @returns Promise
 *
 * @example
 * const result = await withTimeout(fetch('/api'), 5000)
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(errorMessage))
    }, timeoutMs)

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        clearTimeout(timeoutId)
      })
  })
}

// ============================================================================
// Array Utils
// ============================================================================

/**
 * 数组去重
 */
export function unique<T>(array: T[]): T[] {
  return Array.from(new Set(array))
}

/**
 * 数组分组
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

/**
 * 数组扁平化（单层）
 */
export function flatten<T>(array: (T | T[])[]): T[] {
  return array.flatMap(item => Array.isArray(item) ? item : [item])
}

// ============================================================================
// Object Utils
// ============================================================================

/**
 * 浅拷贝对象
 */
export function shallowClone<T extends Record<string, unknown>>(obj: T): T {
  return { ...obj }
}

/**
 * 深拷贝对象（简单版本，适用于JSON可序列化的对象）
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as unknown as T
  }

  if (obj instanceof Array) {
    return obj.map(item => deepClone(item)) as unknown as T
  }

  const cloned = {} as T
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      cloned[key] = deepClone(obj[key])
    }
  }
  return cloned
}

/**
 * 从对象中选取指定键
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>
  keys.forEach(key => {
    if (key in obj) {
      result[key] = obj[key]
    }
  })
  return result
}

/**
 * 从对象中排除指定键
 */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj }
  keys.forEach(key => {
    delete result[key]
  })
  return result
}

// ============================================================================// String Utils
// ============================================================================

/**
 * 首字母大写
 */
export function capitalize(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * 转换为短横线命名
 */
export function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

/**
 * 转换为驼峰命名
 */
export function camelCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (m) => m.toLowerCase())
}

/**
 * 截断字符串
 */
export function truncate(str: string, length: number, suffix = '...'): string {
  if (str.length <= length) return str
  return str.slice(0, length) + suffix
}

// ============================================================================
// Number Utils
// ============================================================================

/**
 * 限制数字在指定范围内
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 生成指定范围内的随机数
 */
export function random(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 格式化数字（添加千分位分隔符）
 */
export function formatNumber(num: number): string {
  return num.toLocaleString()
}

/**
 * 数字补零
 */
export function padNumber(num: number, length: number): string {
  let str = num.toString()
  while (str.length < length) {
    str = '0' + str
  }
  return str
}

// ============================================================================// Date Utils
// ============================================================================

/**
 * 格式化相对时间
 */
export function formatRelativeTime(date: Date | string): string {
  const now = new Date()
  const targetDate = typeof date === 'string' ? new Date(date) : date
  const diffInMs = now.getTime() - targetDate.getTime()

  const seconds = Math.floor(diffInMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days} 天前`
  } else if (hours > 0) {
    return `${hours} 小时前`
  } else if (minutes > 0) {
    return `${minutes} 分钟前`
  } else {
    return '刚刚'
  }
}

/**
 * 格式化日期
 */
export function formatDate(
  date: Date | string,
  format: 'short' | 'long' | 'datetime' = 'short'
): string {
  const d = typeof date === 'string' ? new Date(date) : date

  if (format === 'short') {
    return d.toLocaleDateString('zh-Hans', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  } else if (format === 'long') {
    return d.toLocaleDateString('zh-Hans', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    })
  } else {
    return d.toLocaleString('zh-Hans', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
}

// ============================================================================// Storage Utils
// ============================================================================

/**
 * 从localStorage安全读取数据
 */
export function safeLocalStorageGet<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') {
    return defaultValue
  }

  try {
    const item = localStorage.getItem(key)
    return item ? JSON.parse(item) : defaultValue
  } catch (error) {
    console.warn(`Failed to parse localStorage key "${key}":`, error)
    return defaultValue
  }
}

/**
 * 安全写入localStorage
 */
export function safeLocalStorageSet(key: string, value: unknown): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn(`Failed to set localStorage key "${key}":`, error)
  }
}

/**
 * 从localStorage删除数据
 */
export function safeLocalStorageRemove(key: string): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.removeItem(key)
  } catch (error) {
    console.warn(`Failed to remove localStorage key "${key}":`, error)
  }
}

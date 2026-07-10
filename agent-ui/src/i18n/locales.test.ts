import { describe, expect, it } from 'vitest'
import enUS from '@/locales/en-US'
import zhCN from '@/locales/zh-CN'
import {
  applyLocaleToDocument,
  detectBrowserLocale,
  LOCALE_STORAGE_KEY,
  normalizeAppLocale,
  resolveInitialLocale,
} from './locales'

function resourceKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => resourceKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}

describe('application locale resolution', () => {
  it('normalizes supported locale variants', () => {
    expect(normalizeAppLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeAppLocale('en_GB')).toBe('en-US')
    expect(normalizeAppLocale('fr-FR')).toBeNull()
  })

  it('prefers a saved supported locale over the browser language', () => {
    const storage = { getItem: (key: string) => key === LOCALE_STORAGE_KEY ? 'en-US' : null }
    expect(resolveInitialLocale(storage, ['zh-CN'])).toBe('en-US')
  })

  it('falls back to browser detection when storage is missing or invalid', () => {
    expect(resolveInitialLocale({ getItem: () => 'invalid' }, ['zh-TW', 'en-US'])).toBe('zh-CN')
    expect(resolveInitialLocale({ getItem: () => null }, ['de-DE'])).toBe('en-US')
    expect(detectBrowserLocale([])).toBe('zh-CN')
  })

  it('updates document language metadata', () => {
    const element = document.createElement('html')
    applyLocaleToDocument('en-US', element)
    expect(element.lang).toBe('en-US')
    expect(element.dir).toBe('ltr')
  })

  it('keeps the Chinese and English resource trees in sync', () => {
    expect(resourceKeys(enUS)).toEqual(resourceKeys(zhCN))
  })
})

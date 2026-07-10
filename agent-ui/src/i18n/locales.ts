export const APP_LOCALES = ['zh-CN', 'en-US'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

export const DEFAULT_APP_LOCALE: AppLocale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'app-locale'

export interface AppLocaleOption {
  code: AppLocale
  label: string
  translationKey: string
}

export const APP_LOCALE_OPTIONS: readonly AppLocaleOption[] = [
  { code: 'zh-CN', label: '简体中文', translationKey: 'settings.general.language.options.zhCN' },
  { code: 'en-US', label: 'English', translationKey: 'settings.general.language.options.enUS' },
]

export function normalizeAppLocale(value: unknown): AppLocale | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace('_', '-')
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US'
  return null
}

export function detectBrowserLocale(languages?: readonly string[]): AppLocale {
  const candidates = languages ?? (
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages ?? []), navigator.language]
  )
  for (const candidate of candidates) {
    const locale = normalizeAppLocale(candidate)
    if (locale) return locale
  }
  return candidates.length > 0 ? 'en-US' : DEFAULT_APP_LOCALE
}

export function resolveInitialLocale(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
  browserLanguages?: readonly string[],
): AppLocale {
  const stored = normalizeAppLocale(storage?.getItem(LOCALE_STORAGE_KEY))
  return stored ?? detectBrowserLocale(browserLanguages)
}

export function applyLocaleToDocument(
  locale: AppLocale,
  documentElement: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  documentElement?.setAttribute('lang', locale)
  documentElement?.setAttribute('dir', 'ltr')
}

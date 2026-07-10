export const APP_LOCALES = ['zh-Hans', 'zh-Hant', 'en-US'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

export const DEFAULT_APP_LOCALE: AppLocale = 'zh-Hans'
export const LOCALE_STORAGE_KEY = 'app-locale'

export interface AppLocaleOption {
  code: AppLocale
  label: string
  translationKey: string
}

export const APP_LOCALE_OPTIONS: readonly AppLocaleOption[] = [
  { code: 'zh-Hans', label: '简体中文', translationKey: 'settings.general.language.options.zhHans' },
  { code: 'zh-Hant', label: '繁體中文', translationKey: 'settings.general.language.options.zhHant' },
  { code: 'en-US', label: 'English', translationKey: 'settings.general.language.options.enUS' },
]

export function normalizeAppLocale(value: unknown): AppLocale | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/g, '-')
  if (!normalized) return null

  try {
    const locale = new Intl.Locale(normalized)
    if (locale.language === 'zh') {
      return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans'
    }
    if (locale.language === 'en') return 'en-US'
  } catch {
    // Invalid or unsupported BCP 47 tag.
  }
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

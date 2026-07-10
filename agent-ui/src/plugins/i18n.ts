import { createI18n } from 'vue-i18n'
import zhHans from '@/locales/zh-Hans/index'
import zhHant from '@/locales/zh-Hant/index'
import enUS from '@/locales/en-US/index'
import { applyLocaleToDocument, resolveInitialLocale } from '@/i18n/locales'

export const initialLocale = resolveInitialLocale()
applyLocaleToDocument(initialLocale)

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
    'en-US': enUS,
  },
  globalInjection: true,
  missingWarn: false,
  fallbackWarn: false,
})

import { createI18n } from 'vue-i18n'
import zhCN from '@/locales/zh-CN/index'
import enUS from '@/locales/en-US/index'
import { applyLocaleToDocument, resolveInitialLocale } from '@/i18n/locales'

export const initialLocale = resolveInitialLocale()
applyLocaleToDocument(initialLocale)

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
  globalInjection: true,
  missingWarn: false,
  fallbackWarn: false,
})

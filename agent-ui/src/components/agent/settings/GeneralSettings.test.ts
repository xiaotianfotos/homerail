import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/plugins/i18n'
import { LOCALE_STORAGE_KEY } from '@/i18n/locales'
import { useUiStore } from '@/stores/ui-store'
import GeneralSettings from './GeneralSettings.vue'

describe('GeneralSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'zh-CN'
    i18n.global.locale.value = 'zh-CN'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  it('switches the interface to English and persists the preference', async () => {
    const pinia = createPinia()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(GeneralSettings)
    app.use(pinia)
    app.use(i18n)
    app.mount(root)

    const uiStore = useUiStore(pinia)
    expect(root.textContent).toContain('选择 HomeRail 界面使用的语言')

    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-language-en-US"]')
      ?.click()
    await nextTick()

    expect(uiStore.locale).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(root.textContent).toContain('Choose the language used by the HomeRail interface')
    expect(root.textContent).toContain('General')
  })
})

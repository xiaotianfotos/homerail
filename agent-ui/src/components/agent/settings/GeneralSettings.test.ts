import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/plugins/i18n'
import { LOCALE_STORAGE_KEY } from '@/i18n/locales'
import { useUiStore } from '@/stores/ui-store'
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
} from '@/appearance/appearance-registry'
import GeneralSettings from './GeneralSettings.vue'

describe('GeneralSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'zh-Hans'
    i18n.global.locale.value = 'zh-Hans'
    applyAppearanceToDocument('cockpit')
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

  it('switches to Traditional Chinese with a script-based locale', async () => {
    const pinia = createPinia()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(GeneralSettings)
    app.use(pinia)
    app.use(i18n)
    app.mount(root)

    const uiStore = useUiStore(pinia)
    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-language-zh-Hant"]')
      ?.click()
    await nextTick()

    expect(uiStore.locale).toBe('zh-Hant')
    expect(i18n.global.locale.value).toBe('zh-Hant')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-Hant')
    expect(document.documentElement.lang).toBe('zh-Hant')
    expect(root.textContent).toContain('選擇 HomeRail 界面使用的語言')
    expect(root.textContent).toContain('繁體中文')
  })

  it('switches appearance as one persisted document-level setting', async () => {
    const pinia = createPinia()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(GeneralSettings)
    app.use(pinia)
    app.use(i18n)
    app.mount(root)

    const uiStore = useUiStore(pinia)
    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-appearance-paper"]')
      ?.click()
    await nextTick()

    expect(uiStore.appearanceId).toBe('paper')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('paper')
    expect(document.documentElement.dataset.hrAppearance).toBe('paper')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})

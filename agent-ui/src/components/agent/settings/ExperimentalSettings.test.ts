import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/plugins/i18n'
import {
  LIVE_VOICE_IMMERSIVE_STORAGE_KEY,
  useUiStore,
} from '@/stores/ui-store'
import ExperimentalSettings from './ExperimentalSettings.vue'

describe('ExperimentalSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    i18n.global.locale.value = 'zh-Hans'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  it('disables Live Voice immersion by default and persists the device toggle', async () => {
    const pinia = createPinia()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ExperimentalSettings)
    app.use(pinia)
    app.use(i18n)
    app.mount(root)

    const uiStore = useUiStore(pinia)
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-testid="agent-settings-live-voice-immersive-toggle"]'
    )

    expect(uiStore.liveVoiceImmersiveEnabled).toBe(false)
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    toggle?.click()
    await nextTick()

    expect(uiStore.liveVoiceImmersiveEnabled).toBe(true)
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem(LIVE_VOICE_IMMERSIVE_STORAGE_KEY)).toBe('true')
  })
})

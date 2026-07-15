import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { http } from '@/api/clients/http-client'
import { i18n } from '@/plugins/i18n'
import AgentModeTopBar from './AgentModeTopBar.vue'

describe('AgentModeTopBar localization', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'zh-Hans'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.restoreAllMocks()
  })

  it('updates primary controls immediately when the locale changes', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, {
      activeMode: 'text',
      showDetails: true,
      showSettings: true,
    })
    app.use(i18n)
    app.mount(root)

    expect(root.textContent).toContain('文字模式')
    expect(root.textContent).toContain('设置')

    i18n.global.locale.value = 'en-US'
    await nextTick()

    expect(root.textContent).toContain('Text')
    expect(root.textContent).toContain('Voice')
    expect(root.textContent).toContain('Details')
    expect(root.textContent).toContain('Settings')
    expect(root.textContent).not.toContain('文字模式')
  })

  it('shows waiting runs without presenting them as actively executing', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({
      data: {
        runs: [{ runId: 'run-waiting', status: 'waiting' }],
        total: 1,
      },
    } as any)
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(AgentModeTopBar, {
      activeMode: 'text',
      showRuntime: true,
    })
    app.use(i18n)
    app.mount(root)

    await vi.waitFor(() => {
      const button = root?.querySelector<HTMLElement>('[data-testid="dag-runtime-button"]')
      expect(button?.dataset.state).toBe('waiting')
      expect(button?.title).toContain('1 个运行等待指令')
      expect(button?.textContent).toContain('1')
      expect(button?.querySelector('.animate-spin')).toBeNull()
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import { getToolProviderCatalog } from '@/api/services/tool-providers-api'
import ToolProviderSettings from './ToolProviderSettings.vue'

vi.mock('@/api/services/tool-providers-api', () => ({
  getToolProviderCatalog: vi.fn(),
}))

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('ToolProviderSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.resetAllMocks()
  })

  it('shows real declarations separately from current browser presence', async () => {
    vi.mocked(getToolProviderCatalog).mockResolvedValue({
      version: 1,
      generated_at: new Date(0).toISOString(),
      providers: [{
        id: 'homerail.browser-ui',
        name: 'Experimental Browser UI Tools',
        description: 'Trusted UI actions',
        kind: 'webmcp',
        configuration_state: 'experimental',
        read_only_configuration: true,
        tools: [{ name: 'ui_open_surface', description: 'Open a surface' }],
        bindings: [{
          harness: 'gpt_live',
          execution_host: 'renderer',
          transport: 'browser_tools_ws',
          runtime_state: 'disconnected',
        }],
      }],
    })
    i18n.global.locale.value = 'zh-Hans'
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ToolProviderSettings)
    app.use(i18n)
    app.mount(root)
    await flushUi()

    const provider = root.querySelector('[data-testid="tool-provider-homerail.browser-ui"]')
    expect(provider?.textContent).toContain('Experimental Browser UI Tools')
    expect(provider?.textContent).toContain('实验性')
    expect(provider?.textContent).toContain('未连接')
    expect(provider?.textContent).toContain('只读配置')
    expect(provider?.textContent).toContain('ui_open_surface')
  })

  it('renders the structured HTTP client error message', async () => {
    vi.mocked(getToolProviderCatalog).mockRejectedValue({ message: 'Manager proxy unavailable', code: 0 })
    i18n.global.locale.value = 'zh-Hans'
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ToolProviderSettings)
    app.use(i18n)
    app.mount(root)
    await flushUi()

    expect(root.querySelector('[data-testid="tool-providers-error"]')?.textContent)
      .toContain('Manager proxy unavailable')
    expect(root.textContent).not.toContain('[object Object]')
  })
})

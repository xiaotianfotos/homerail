import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, type Pinia } from 'pinia'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import {
  useUiStore,
  WEB_BROWSER_TOOLS_ENABLED_STORAGE_KEY,
} from '@/stores/ui-store'
import BrowserToolsSettings from './BrowserToolsSettings.vue'

function browserToolsStatus(
  overrides: Partial<DesktopBrowserToolsStatus> = {},
): DesktopBrowserToolsStatus {
  return {
    supported: true,
    enabled: false,
    runtimeEnabled: false,
    restartRequired: false,
    state: 'disabled',
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('BrowserToolsSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null
  let pinia: Pinia

  beforeEach(() => {
    i18n.global.locale.value = 'zh-Hans'
    localStorage.removeItem(WEB_BROWSER_TOOLS_ENABLED_STORAGE_KEY)
    pinia = createPinia()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    Reflect.deleteProperty(window, 'homerailDesktop')
    localStorage.removeItem(WEB_BROWSER_TOOLS_ENABLED_STORAGE_KEY)
    vi.restoreAllMocks()
  })

  function mount(bridge?: HomeRailDesktopBridge): void {
    if (bridge) {
      Object.defineProperty(window, 'homerailDesktop', {
        configurable: true,
        value: bridge,
      })
    } else {
      Reflect.deleteProperty(window, 'homerailDesktop')
    }
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(BrowserToolsSettings)
    app.use(pinia)
    app.use(i18n)
    app.mount(root)
  }

  it('is visible and default-off in Web, then toggles immediately', async () => {
    mount()
    await flushUi()

    const card = root?.querySelector('[data-testid="desktop-browser-tools-settings"]')
    const toggle = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-browser-tools-toggle"]')
    expect(card).not.toBeNull()
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    expect(root?.querySelector('[data-testid="desktop-browser-tools-state"]')?.textContent)
      .toContain('已关闭')

    toggle?.click()
    await flushUi()
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(useUiStore(pinia).webBrowserToolsEnabled).toBe(true)
    expect(localStorage.getItem(WEB_BROWSER_TOOLS_ENABLED_STORAGE_KEY)).toBe('true')
  })

  it('enables through Desktop while reporting native restart separately', async () => {
    const setBrowserToolsEnabled = vi.fn().mockResolvedValue(browserToolsStatus({
      enabled: true,
      restartRequired: true,
      state: 'restart-required',
    }))
    mount({
      browserToolsStatus: vi.fn().mockResolvedValue(browserToolsStatus()),
      setBrowserToolsEnabled,
    })
    await flushUi()

    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-browser-tools-toggle"]')?.click()
    await flushUi()

    expect(setBrowserToolsEnabled).toHaveBeenCalledWith(true)
    expect(root?.querySelector('[data-testid="desktop-browser-tools-toggle"]')?.getAttribute('aria-checked'))
      .toBe('true')
    expect(root?.querySelector('[data-testid="desktop-browser-tools-native-state"]')?.textContent)
      .toContain('重启一次 HomeRail Desktop')
  })

  it('reflects an immediate disable update from Desktop', async () => {
    let statusListener: ((status: DesktopBrowserToolsStatus) => void) | undefined
    mount({
      browserToolsStatus: vi.fn().mockResolvedValue(browserToolsStatus({
        enabled: true,
        runtimeEnabled: true,
        state: 'connected',
      })),
      setBrowserToolsEnabled: vi.fn(),
      onBrowserToolsStatus: vi.fn((listener) => {
        statusListener = listener
        return () => undefined
      }),
    })
    await flushUi()

    statusListener?.(browserToolsStatus())
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-browser-tools-toggle"]')?.getAttribute('aria-checked'))
      .toBe('false')
  })

  it('does not show enabled from a stale initial snapshot after a Desktop disable event', async () => {
    const initialStatus = deferred<DesktopBrowserToolsStatus>()
    let statusListener: ((status: DesktopBrowserToolsStatus) => void) | undefined
    mount({
      browserToolsStatus: vi.fn(() => initialStatus.promise),
      setBrowserToolsEnabled: vi.fn(),
      onBrowserToolsStatus: vi.fn((listener) => {
        statusListener = listener
        return () => { statusListener = undefined }
      }),
    })
    await vi.waitFor(() => expect(statusListener).toBeDefined())

    statusListener?.(browserToolsStatus())
    await flushUi()
    initialStatus.resolve(browserToolsStatus({
      enabled: true,
      runtimeEnabled: true,
      state: 'connected',
    }))
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-browser-tools-toggle"]')?.getAttribute('aria-checked'))
      .toBe('false')
    expect(root?.querySelector('[data-testid="desktop-browser-tools-state"]')?.textContent)
      .toContain('已关闭')
  })

  it('distinguishes direct bridge and native WebMCP runtime state', async () => {
    const store = useUiStore(pinia)
    store.setBrowserToolsRuntimeStatus({
      state: 'direct-native',
      directConnected: true,
      nativeRegistered: true,
    })
    mount()
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-browser-tools-state"]')?.textContent)
      .toContain('页面直连和原生 WebMCP 均已')
  })

  it('shows native unavailable, not native error, when Desktop is unsupported', async () => {
    useUiStore(pinia).setBrowserToolsRuntimeStatus({
      state: 'direct',
      directConnected: true,
      nativeRegistered: false,
    })
    mount({
      browserToolsStatus: vi.fn().mockResolvedValue(browserToolsStatus({
        supported: false,
        enabled: true,
        runtimeEnabled: false,
        state: 'unavailable',
        error: 'Chromium runtime unsupported',
      })),
      setBrowserToolsEnabled: vi.fn(),
    })
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-browser-tools-state"]')?.textContent)
      .toContain('页面直连已连接')
    expect(root?.querySelector('[data-testid="desktop-browser-tools-native-state"]')?.textContent)
      .toContain('原生 Chromium WebMCP 不可用')
    expect(root?.querySelector('[data-testid="desktop-browser-tools-native-state"]')?.textContent)
      .not.toContain('启动失败')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import DesktopUpdateSettings from './DesktopUpdateSettings.vue'

function updateStatus(overrides: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus {
  return {
    supported: true,
    state: 'not-available',
    currentVersion: '0.1.0-alpha.1',
    channel: 'stable',
    ...overrides,
  }
}

async function flushUi(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

describe('DesktopUpdateSettings', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    Reflect.deleteProperty(window, 'homerailDesktop')
    vi.restoreAllMocks()
  })

  function mount(bridge: HomeRailDesktopBridge): void {
    Object.defineProperty(window, 'homerailDesktop', {
      configurable: true,
      value: bridge,
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DesktopUpdateSettings)
    app.use(i18n)
    app.mount(root)
  }

  it('shows the persisted channel and switches to Early Access through the desktop bridge', async () => {
    const setUpdateChannel = vi.fn().mockResolvedValue(updateStatus({
      channel: 'early-access',
      state: 'checking',
    }))
    mount({
      updateStatus: vi.fn().mockResolvedValue(updateStatus()),
      setUpdateChannel,
    })
    await flushUi()

    expect(root?.textContent).toContain('Desktop updates')
    expect(root?.textContent).toContain('Installed version: 0.1.0-alpha.1')
    expect(root?.querySelector('[data-testid="desktop-update-channel-stable"]')?.getAttribute('aria-checked')).toBe('true')

    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-channel-early-access"]')?.click()
    await flushUi()

    expect(setUpdateChannel).toHaveBeenCalledWith('early-access')
    expect(root?.querySelector('[data-testid="desktop-update-channel-early-access"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('explains that switching a prerelease to Stable will not downgrade it', async () => {
    mount({
      updateStatus: vi.fn().mockResolvedValue(updateStatus({
        channelNotice: 'waiting-for-newer-stable',
      })),
      setUpdateChannel: vi.fn(),
    })
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-update-channel-notice"]')?.textContent)
      .toContain('will not downgrade')
  })

  it('disables channel switching while an update is downloaded', async () => {
    const setUpdateChannel = vi.fn()
    mount({
      updateStatus: vi.fn().mockResolvedValue(updateStatus({ state: 'downloaded' })),
      setUpdateChannel,
    })
    await flushUi()

    const earlyAccess = root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-channel-early-access"]')
    expect(earlyAccess?.disabled).toBe(true)
    earlyAccess?.click()
    expect(setUpdateChannel).not.toHaveBeenCalled()
  })

  it('shows a channel switch failure instead of swallowing it', async () => {
    mount({
      updateStatus: vi.fn().mockResolvedValue(updateStatus()),
      setUpdateChannel: vi.fn().mockRejectedValue(new Error('preference file is read-only')),
    })
    await flushUi()

    root?.querySelector<HTMLButtonElement>('[data-testid="desktop-update-channel-early-access"]')?.click()
    await flushUi()

    expect(root?.querySelector('[data-testid="desktop-update-error"]')?.textContent)
      .toContain('preference file is read-only')
  })

  it('stays hidden in the standalone web UI', async () => {
    mount({})
    await flushUi()
    expect(root?.querySelector('[data-testid="desktop-update-settings"]')).toBeNull()
  })
})

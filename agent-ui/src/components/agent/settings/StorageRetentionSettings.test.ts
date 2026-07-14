import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'

import { i18n } from '@/plugins/i18n'
import StorageRetentionSettings from './StorageRetentionSettings.vue'

const {
  getStorageInfo,
  updateWorkspaceRetention,
  cleanupRunWorkspaces,
  showToast,
} = vi.hoisted(() => ({
  getStorageInfo: vi.fn(),
  updateWorkspaceRetention: vi.fn(),
  cleanupRunWorkspaces: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('@/api/agent', () => ({
  agentSettingsApi: {
    getStorageInfo,
    updateWorkspaceRetention,
    cleanupRunWorkspaces,
  },
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => ({ showToast }),
}))

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function mount() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(StorageRetentionSettings)
  app.use(i18n)
  app.mount(root)
  return { app, root }
}

describe('StorageRetentionSettings', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    i18n.global.locale.value = 'zh-Hans'
    vi.clearAllMocks()
    getStorageInfo.mockResolvedValue({
      data_root: '/tmp/homerail/manager',
      runs_count: 3,
      sessions_dir: '/tmp/homerail/sessions',
      retention_supported: true,
      cleanup_supported: true,
      cleanup_tracked_gap: false,
      cleanup_next_action: '',
      workspace_retention: { enabled: true, success_days: 7, failure_days: 7 },
      export_supported: false,
      export_tracked_gap: true,
      export_next_action: 'not implemented',
    })
    updateWorkspaceRetention.mockImplementation(async (settings) => settings)
    cleanupRunWorkspaces.mockResolvedValue({
      dry_run: true,
      scanned: 3,
      eligible: 2,
      removed: 0,
      skipped: 1,
      failed: 0,
    })
  })

  it('shows seven-day defaults and persists edited success and failure policies', async () => {
    const { app, root } = mount()
    await flush()

    const success = root.querySelector<HTMLInputElement>('[data-testid="agent-settings-workspace-retention-success-days"]')!
    const failure = root.querySelector<HTMLInputElement>('[data-testid="agent-settings-workspace-retention-failure-days"]')!
    expect(success.value).toBe('7')
    expect(failure.value).toBe('7')

    success.value = '10'
    success.dispatchEvent(new Event('input', { bubbles: true }))
    failure.value = '12'
    failure.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-workspace-retention-save"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(updateWorkspaceRetention).toHaveBeenCalledWith({
      enabled: true,
      success_days: 10,
      failure_days: 12,
    })
    app.unmount()
  })

  it('previews safely and requires confirmation before destructive cleanup', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const { app, root } = mount()
    await flush()

    root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-workspace-cleanup-preview"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(cleanupRunWorkspaces).toHaveBeenCalledWith(true)

    root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-workspace-cleanup-run"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(cleanupRunWorkspaces).not.toHaveBeenCalledWith(false)
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(root.querySelector('[data-testid="agent-settings-workspace-cleanup-confirm"]'))
      .not.toBeNull()

    root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-workspace-cleanup-confirm-confirm"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(cleanupRunWorkspaces).toHaveBeenCalledWith(false)
    app.unmount()
  })

  it('clamps retention days to the supported range before saving', async () => {
    const { app, root } = mount()
    await flush()

    const success = root.querySelector<HTMLInputElement>('[data-testid="agent-settings-workspace-retention-success-days"]')!
    const failure = root.querySelector<HTMLInputElement>('[data-testid="agent-settings-workspace-retention-failure-days"]')!
    success.value = '4000'
    success.dispatchEvent(new Event('input', { bubbles: true }))
    failure.value = '-3'
    failure.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-workspace-retention-save"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(updateWorkspaceRetention).toHaveBeenCalledWith({
      enabled: true,
      success_days: 3650,
      failure_days: 0,
    })
    app.unmount()
  })
})

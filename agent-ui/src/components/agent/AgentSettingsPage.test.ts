import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AgentSettingsPage from './AgentSettingsPage.vue'

const loadManagerRuntimeOptions = vi.fn(() => Promise.resolve())
const showToast = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() })
}))

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => ({
    managerProjectId: '',
    settingsPageOpen: true,
    setManagerProjectId: vi.fn(),
    loadManagerRuntimeOptions
  })
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => ({ showToast })
}))

vi.mock('./settings/ModelSettings.vue', () => ({
  default: { template: '<section data-testid="mock-model-settings" />' }
}))

vi.mock('@/api/agent', () => ({
  listProjects: vi.fn(() => Promise.resolve({ data: { projects: [] } })),
  listProjectStorages: vi.fn(() => Promise.resolve({ data: { storages: [] } })),
  listNodes: vi.fn(() => Promise.resolve({ data: { nodes: [] } })),
  updateProject: vi.fn(() => Promise.resolve({ data: {} })),
  listMemories: vi.fn(() => Promise.resolve({ data: { memories: [] } })),
  getMemoryStats: vi.fn(() => Promise.resolve({ data: null })),
  createMemory: vi.fn(() => Promise.resolve({ data: {} })),
  deleteMemory: vi.fn(() => Promise.resolve({ data: {} })),
  deleteSkill: vi.fn(() => Promise.resolve({ data: {} })),
  listSkills: vi.fn(() => Promise.resolve({ data: { skills: [] } })),
  uploadSkill: vi.fn(() => Promise.resolve({ data: {} })),
  listVoiceModels: vi.fn(() => Promise.resolve({ data: { models: [] } })),
  testVoiceConnection: vi.fn(() => Promise.resolve({ data: { models: [] } })),
  getCodexModels: vi.fn(() => Promise.resolve({ data: { binary: '', models: [] } })),
  getExperienceGraphSummary: vi.fn(() => Promise.resolve({ data: null })),
  getAssetDiagnostics: vi.fn(() => Promise.resolve({ data: null })),
  getOrchestrationTemplates: vi.fn(() => Promise.resolve({ data: { orchestrations: [] } })),
  agentSettingsApi: {
    getApiBaseUrl: vi.fn(() => 'http://localhost:19191'),
    listGitServers: vi.fn(() => Promise.resolve({ data: { servers: [] } })),
    listProviders: vi.fn(() => Promise.resolve({ data: { providers: [] } })),
    listLLMSettings: vi.fn(() => Promise.resolve({ data: { settings: [] } })),
    listMCPServers: vi.fn(() => Promise.resolve({ data: { servers: [] } })),
    getVoiceSettings: vi.fn(() => Promise.resolve({ data: null })),
    getVoiceAgentConfig: vi.fn(() => Promise.resolve({ data: null })),
    getVoiceUiRulesAsset: vi.fn(() => Promise.resolve({ data: null })),
    getRuntimeStatus: vi.fn(() => Promise.resolve(null)),
    getWorkspaceSettings: vi.fn(() => Promise.resolve(null)),
    getStorageInfo: vi.fn(() => Promise.resolve(null)),
    createGitServer: vi.fn(() => Promise.resolve({ data: {} })),
    verifyGitServer: vi.fn(() => Promise.resolve({ data: {} })),
    deleteGitServer: vi.fn(() => Promise.resolve({ data: {} })),
    addMCPServer: vi.fn(() => Promise.resolve({ data: {} })),
    updateMCPServer: vi.fn(() => Promise.resolve({ data: {} })),
    refreshMCPServerRuntime: vi.fn(() => Promise.resolve({ data: {} })),
    deleteMCPServer: vi.fn(() => Promise.resolve({ data: {} })),
    updateVoiceSettings: vi.fn(() => Promise.resolve({ data: {} })),
    updateVoiceUiRulesAsset: vi.fn(() => Promise.resolve({ data: null })),
    updateVoiceAgentConfig: vi.fn(() => Promise.resolve({ data: null }))
  }
}))

function setBridge(bridge: Record<string, unknown> | null): void {
  Object.defineProperty(window, 'HomeRailBridge', {
    configurable: true,
    value: bridge ?? undefined
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function mountSettings(): { app: App<Element>; root: HTMLElement } {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp(AgentSettingsPage)
  app.mount(root)
  return { app, root }
}

describe('AgentSettingsPage Android TV WireGuard settings', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    showToast.mockClear()
    loadManagerRuntimeOptions.mockClear()
    const storage = new Map<string, string>()
    const localStorageMock = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
      key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
      get length() {
        return storage.size
      }
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: localStorageMock
    })
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock
    })
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: vi.fn(() => 1)
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn()
    })
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: vi.fn(() => [])
    })
  })

  afterEach(() => {
    setBridge(null)
  })

  it('shows the Android TV WireGuard settings and saves through the local bridge', async () => {
    let savedPayload = ''
    setBridge({
      isAndroidTV: () => true,
      getWireGuardConfig: () =>
        JSON.stringify({
          ok: true,
          configured: true,
          config: {
            name: 'wg0',
            endpoint: 'old.example.com:51820',
            allowedIps: '10.0.0.0/8',
            persistentKeepalive: '25'
          }
        }),
      saveWireGuardConfig(json: string) {
        savedPayload = json
        return JSON.stringify({
          ok: true,
          configured: true,
          endpoint: JSON.parse(json).config.endpoint,
          config: JSON.parse(json).config
        })
      },
      clearWireGuardConfig: () => JSON.stringify({ ok: true, configured: false }),
      getWireGuardStatus: () =>
        JSON.stringify({ connected: false, configured: true, endpoint: 'old.example.com:51820' }),
      connectWireGuard: () => JSON.stringify({ connected: true, configured: true }),
      disconnectWireGuard: () => JSON.stringify({ connected: false, configured: true })
    })

    const { app, root } = mountSettings()
    await flush()

    const tab = root.querySelector<HTMLButtonElement>('[data-testid="agent-settings-tab-device"]')
    expect(tab).not.toBeNull()
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(root.querySelector('[data-testid="agent-settings-section-wireguard"]')).not.toBeNull()
    const endpoint = root.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-wireguard-endpoint"]'
    )
    expect(endpoint?.value).toBe('old.example.com:51820')
    endpoint!.value = 'vpn.example.com:51820'
    endpoint!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-wireguard-save"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(JSON.parse(savedPayload).config.endpoint).toBe('vpn.example.com:51820')
    app.unmount()
  })

  it('connects the selected Android TV WireGuard profile through the local bridge', async () => {
    let savedPayload = ''
    const connectedProfiles: string[] = []
    setBridge({
      isAndroidTV: () => true,
      getWireGuardConfig: () =>
        JSON.stringify({
          ok: true,
          configured: true,
          config: {
            name: 'wg-tv',
            endpoint: '127.0.0.1:51820',
            interfacePrivateKey: 'private',
            interfaceAddress: '192.168.99.99/32',
            peerPublicKey: 'public',
            allowedIps: '192.168.99.0/24',
            persistentKeepalive: '25'
          }
        }),
      saveWireGuardConfig(json: string) {
        savedPayload = json
        return JSON.stringify({
          ok: true,
          configured: true,
          endpoint: JSON.parse(json).config.endpoint,
          config: JSON.parse(json).config
        })
      },
      clearWireGuardConfig: () => JSON.stringify({ ok: true, configured: false }),
      getWireGuardStatus: () =>
        JSON.stringify({ connected: false, configured: true, endpoint: '127.0.0.1:51820', profileName: 'wg-tv' }),
      connectWireGuard(profileName: string) {
        connectedProfiles.push(profileName)
        return JSON.stringify({
          connected: true,
          configured: true,
          endpoint: '127.0.0.1:51820',
          profileName,
          tunnelName: profileName,
          runningTunnels: [profileName]
        })
      },
      disconnectWireGuard: () => JSON.stringify({ connected: false, configured: true })
    })

    const { app, root } = mountSettings()
    await flush()
    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-tab-device"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-wireguard-connect"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(JSON.parse(savedPayload).config.name).toBe('wg-tv')
    expect(connectedProfiles).toEqual(['wg-tv'])
    expect(root.querySelector('[data-testid="agent-settings-wireguard-status"]')?.textContent).toContain('已连接')
    app.unmount()
  })

  it('hides WireGuard settings outside Android TV', async () => {
    setBridge({
      isAndroidTV: () => false,
      getWireGuardConfig: () => '{}',
      saveWireGuardConfig: () => '{}',
      clearWireGuardConfig: () => '{}',
      getWireGuardStatus: () => '{}',
      connectWireGuard: () => '{}',
      disconnectWireGuard: () => '{}'
    })

    const { app, root } = mountSettings()
    await flush()

    expect(root.querySelector('[data-testid="agent-settings-tab-device"]')).toBeNull()
    expect(root.querySelector('[data-testid="agent-settings-section-wireguard"]')).toBeNull()
    app.unmount()
  })

  it('renders save errors returned by the Android TV bridge', async () => {
    setBridge({
      isAndroidTV: () => true,
      getWireGuardConfig: () => JSON.stringify({ ok: true, configured: false, config: {} }),
      saveWireGuardConfig: () =>
        JSON.stringify({ ok: false, code: 'invalid_config', message: 'endpoint is required' }),
      clearWireGuardConfig: () => JSON.stringify({ ok: true, configured: false }),
      getWireGuardStatus: () => JSON.stringify({ connected: false, configured: false }),
      connectWireGuard: () => JSON.stringify({ connected: false, configured: false }),
      disconnectWireGuard: () => JSON.stringify({ connected: false, configured: false })
    })

    const { app, root } = mountSettings()
    await flush()
    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-tab-device"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    root
      .querySelector<HTMLButtonElement>('[data-testid="agent-settings-wireguard-save"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(root.querySelector('[data-testid="agent-settings-wireguard-error"]')?.textContent).toContain(
      'endpoint is required'
    )
    app.unmount()
  })
})

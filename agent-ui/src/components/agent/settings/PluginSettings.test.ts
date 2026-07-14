import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import PluginSettings from './PluginSettings.vue'

const listHomerailPlugins = vi.fn()
const setHomerailPluginEnabled = vi.fn()

vi.mock('@/api/services/plugin-api', () => ({
  listHomerailPlugins: (...args: unknown[]) => listHomerailPlugins(...args),
  setHomerailPluginEnabled: (...args: unknown[]) => setHomerailPluginEnabled(...args),
}))

const registry = {
  registry_revision: 2,
  registry_fingerprint: 'a'.repeat(64),
  plugins: [{
    id: 'com.homerail.core',
    name: 'Core',
    version: '0.1.0',
    package_digest: 'b'.repeat(64),
    manifest_digest: 'c'.repeat(64),
    source: 'builtin',
    enabled: true,
    locked: true,
    activation_revision: 1,
    capabilities: ['voice-generative-ui'],
    skills: ['voice-generative-ui'],
    tools: [],
    kinds: ['com.homerail.core/notice'],
    renderers: ['core-notice'],
    actions: [],
  }, {
    id: 'com.homerail.topic-outline',
    name: 'Topic Outline',
    version: '1.0.0',
    package_digest: 'd'.repeat(64),
    manifest_digest: 'e'.repeat(64),
    source: 'builtin',
    enabled: true,
    locked: false,
    activation_revision: 1,
    capabilities: ['compose-outline'],
    skills: ['topic-outline'],
    tools: ['upsert_topic_outline'],
    kinds: ['com.homerail.topic-outline/outline'],
    renderers: ['topic-outline-main'],
    actions: [],
  }],
}

let app: App<Element> | null = null
let root: HTMLElement | null = null

async function mount(): Promise<HTMLElement> {
  listHomerailPlugins.mockResolvedValue({ success: true, data: structuredClone(registry) })
  setHomerailPluginEnabled.mockResolvedValue({
    success: true,
    data: {
      activation: { enabled: false },
      registry: {
        ...structuredClone(registry),
        registry_revision: 3,
        plugins: registry.plugins.map(plugin => (
          plugin.id === 'com.homerail.topic-outline' ? { ...plugin, enabled: false } : plugin
        )),
      },
    },
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(PluginSettings)
  app.use(i18n)
  app.mount(root)
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  return root
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  vi.clearAllMocks()
})

describe('PluginSettings', () => {
  it('shows resolved capabilities, locks Core, and toggles an optional plugin', async () => {
    const mounted = await mount()
    const core = mounted.querySelector<HTMLInputElement>('[data-testid="agent-settings-plugin-toggle-com.homerail.core"]')!
    const topic = mounted.querySelector<HTMLInputElement>('[data-testid="agent-settings-plugin-toggle-com.homerail.topic-outline"]')!
    expect(core.disabled).toBe(true)
    expect(topic.disabled).toBe(false)
    expect(mounted.textContent).toContain('Topic Outline')
    expect(mounted.textContent).toContain('1 tool')

    topic.checked = false
    topic.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(setHomerailPluginEnabled).toHaveBeenCalledWith('com.homerail.topic-outline', false, 1, '1.0.0')
    expect(mounted.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-plugin-toggle-com.homerail.topic-outline"]',
    )?.checked).toBe(false)
  })

  it('restores the last confirmed toggle state when activation fails', async () => {
    const mounted = await mount()
    setHomerailPluginEnabled.mockRejectedValueOnce(new Error('activation rejected'))
    const topic = mounted.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-plugin-toggle-com.homerail.topic-outline"]',
    )!
    topic.checked = false
    topic.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()

    expect(topic.checked).toBe(true)
    expect(mounted.querySelector('[data-testid="agent-settings-plugins-error"]')?.textContent)
      .toContain('activation rejected')
  })

  it('serializes refresh and activation controls while a mutation is pending', async () => {
    const mounted = await mount()
    let release!: (value: unknown) => void
    setHomerailPluginEnabled.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const topic = mounted.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-plugin-toggle-com.homerail.topic-outline"]',
    )!
    topic.checked = false
    topic.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(topic.disabled).toBe(true)
    expect(mounted.querySelector<HTMLButtonElement>('[data-testid="agent-settings-plugins-refresh"]')?.disabled)
      .toBe(true)

    release({
      success: true,
      data: {
        activation: { enabled: false },
        registry: {
          ...structuredClone(registry),
          registry_revision: 3,
          plugins: registry.plugins.map(plugin => (
            plugin.id === 'com.homerail.topic-outline' ? { ...plugin, enabled: false } : plugin
          )),
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
    expect(topic.disabled).toBe(false)
    expect(topic.checked).toBe(false)
  })

  it('removes an uninstalled plugin when a newer registry snapshot omits it', async () => {
    const mounted = await mount()
    setHomerailPluginEnabled.mockResolvedValueOnce({
      success: true,
      data: {
        activation: { enabled: false },
        registry: {
          ...structuredClone(registry),
          registry_revision: 3,
          plugins: registry.plugins.filter(plugin => plugin.id !== 'com.homerail.topic-outline'),
        },
      },
    })
    const topic = mounted.querySelector<HTMLInputElement>(
      '[data-testid="agent-settings-plugin-toggle-com.homerail.topic-outline"]',
    )!
    topic.checked = false
    topic.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()

    expect(mounted.querySelector('[data-testid="agent-settings-plugin-com.homerail.topic-outline"]'))
      .toBeNull()
    expect(mounted.textContent).not.toContain('Topic Outline')
  })
})

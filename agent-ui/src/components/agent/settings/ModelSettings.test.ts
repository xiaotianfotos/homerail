import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import { agentSettingsApi } from '@/api/agent'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import ModelSettings from './ModelSettings.vue'

const managerStore = {
  managerProviderName: '',
  managerModelName: '',
  managerRuntimeLoading: false,
  managerProviderOptions: [] as string[],
  managerModelOptions: [] as string[],
  managerProviderLabel: (provider: string) => provider,
  managerModelLabel: (_provider: string, model: string) => model,
  setManagerRuntime: vi.fn(),
  loadManagerRuntimeOptions: vi.fn(() => Promise.resolve())
}

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => managerStore
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => ({ showToast: vi.fn() })
}))

vi.mock('@/api/agent', () => ({
  agentSettingsApi: {
    deleteLLMSetting: vi.fn(async () => ({ success: true }))
  }
}))

function codexModel(model: string, displayName: string, isDefault = false) {
  return {
    id: model,
    model,
    display_name: displayName,
    description: '',
    is_default: isDefault,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    service_tiers: []
  }
}

const codexModels = [
  codexModel('gpt-5.5', 'GPT-5.5', true),
  codexModel('gpt-5.4', 'GPT-5.4'),
  codexModel('gpt-5.4-mini', 'GPT-5.4-Mini'),
  codexModel('gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark')
]

function managerConfig(harness: 'codex_appserver' | 'claude_agent_sdk') {
  return {
    agent_type: 'manager_agent' as const,
    harness,
    llm_setting_id: null,
    provider_name: null,
    model_name: harness === 'codex_appserver' ? 'gpt-5.5' : null,
    reasoning_effort: 'xhigh' as const,
    service_tier: null,
    system_prompt: '',
    session_policy: {}
  }
}

let app: App<Element> | null = null

const modelSetting: LLMSetting = {
  id: 'setting-1',
  provider_id: 'local-llm',
  provider_name: 'Local LLM',
  provider_source: 'custom',
  provider_readonly: false,
  endpoint_id: 'local-llm_custom',
  endpoint_name: 'Custom endpoint',
  plan_type: 'custom',
  protocol: 'custom',
  model_name: 'qwen3.6',
  display_name: 'Qwen 3.6',
  api_key_display: '****',
  supports_llm: true,
  supports_asr: false,
  supports_tts: false,
  supports_audio_input: false,
  supports_image_input: false,
  supports_video_input: false,
  is_active: true,
  is_default: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
}

async function mountSettings(
  harness: 'codex_appserver' | 'claude_agent_sdk',
  llmSettings: LLMSetting[] = []
) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ModelSettings, {
    providers: [],
    llmSettings,
    managerConfig: managerConfig(harness),
    codexModels,
    loading: false
  })
  app.use(i18n)
  app.mount(root)
  await nextTick()
  return root
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-Hans'
  vi.clearAllMocks()
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('ModelSettings detected Codex runtime', () => {
  it('opens a purpose menu beside Add model', async () => {
    const root = await mountSettings('claude_agent_sdk')
    const menuButton = root.querySelector<HTMLButtonElement>(
      '[data-testid="add-model-menu-button"]'
    )!

    menuButton.click()
    await nextTick()

    expect(root.querySelector('[data-testid="add-model-purpose-llm"]')?.textContent).toContain(
      '大语言模型'
    )
    expect(root.querySelector('[data-testid="add-model-purpose-asr"]')?.textContent).toContain(
      'ASR'
    )
    expect(root.querySelector('[data-testid="add-model-purpose-tts"]')?.textContent).toContain(
      'TTS'
    )
  })

  it('renders the active Codex runtime and full catalog as read-only', async () => {
    const root = await mountSettings('codex_appserver')
    const codexItem = root.querySelector<HTMLElement>(
      '[data-testid="agent-settings-model-item-codex"]'
    )

    expect(
      root.querySelector('[data-testid="agent-settings-manager-runtime-provider-readonly"]')
        ?.textContent
    ).toContain('Codex')
    expect(
      root.querySelector('[data-testid="agent-settings-manager-runtime-model-readonly"]')
        ?.textContent
    ).toContain('GPT-5.5')
    expect(
      root.querySelector('[data-testid="agent-settings-manager-runtime-model-readonly"]')
        ?.textContent
    ).toContain('标准')
    expect(
      root.querySelector('[data-testid="agent-settings-manager-runtime-count"]')?.textContent
    ).toContain('4 个可用模型')
    expect(codexItem?.textContent).toContain('自动检测')
    expect(codexItem?.textContent).toContain('只读')
    expect(codexItem?.textContent).toContain('GPT-5.5, GPT-5.4, GPT-5.4-Mini, GPT-5.3-Codex-Spark')
    expect(codexItem?.querySelectorAll('button')).toHaveLength(0)
    expect(root.querySelectorAll('select')).toHaveLength(0)
  })

  it('keeps detected Codex visible when another Manager runtime is selected', async () => {
    const root = await mountSettings('claude_agent_sdk')

    expect(root.querySelector('[data-testid="agent-settings-model-item-codex"]')).not.toBeNull()
    expect(root.querySelectorAll('select')).toHaveLength(2)
  })

  it('uses an adjacent inline confirmation before deleting a model', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const root = await mountSettings('claude_agent_sdk', [modelSetting])

    root.querySelector<HTMLButtonElement>('[data-testid="delete-model-setting-1"]')!.click()
    await nextTick()

    const inlineConfirm = root.querySelector<HTMLElement>(
      '[data-testid="delete-model-confirm-setting-1"]'
    )
    expect(inlineConfirm?.textContent).toContain('Qwen 3.6')
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(agentSettingsApi.deleteLLMSetting).not.toHaveBeenCalled()

    root
      .querySelector<HTMLButtonElement>('[data-testid="delete-model-confirm-setting-1-confirm"]')!
      .click()
    await nextTick()
    await nextTick()

    expect(agentSettingsApi.deleteLLMSetting).toHaveBeenCalledWith('setting-1')
  })
})

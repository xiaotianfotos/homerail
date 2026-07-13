import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const agentApi = vi.hoisted(() => ({
  deleteManagerSession: vi.fn(),
  getManagerAgentConfig: vi.fn(),
  getManagerSessionMessages: vi.fn(),
  listManagerSessions: vi.fn(),
  updateManagerAgentConfig: vi.fn(),
}))
const llmApi = vi.hoisted(() => ({ listLLMSettings: vi.fn() }))

vi.mock('@/api/agent', () => agentApi)
vi.mock('@/api/services/llm-settings-api', () => llmApi)

import { useAgentStore } from './agent-store'

describe('agent runtime selection', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('keeps an auto-detected Codex config instead of overwriting it with an LLM setting', async () => {
    llmApi.listLLMSettings.mockResolvedValue({
      data: {
        settings: [{
          id: 'local-default',
          provider_id: 'kimi',
          provider_name: 'Kimi',
          model_name: 'kimi-k2.7-code',
          supports_llm: true,
          supports_asr: false,
          supports_tts: false,
          is_active: true,
          is_default: true,
        }],
      },
    })
    agentApi.getManagerAgentConfig.mockResolvedValue({
      data: {
        harness: 'codex_appserver',
        llm_setting_id: null,
        provider_name: null,
        model_name: 'gpt-5.6-terra',
      },
    })

    const store = useAgentStore()
    await store.loadManagerRuntimeOptions()

    expect(store.managerSettingId).toBeNull()
    expect(store.managerProviderName).toBe('codex')
    expect(store.managerModelName).toBe('gpt-5.6-terra')
    expect(agentApi.updateManagerAgentConfig).not.toHaveBeenCalled()
  })
})

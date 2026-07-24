import { beforeEach, describe, expect, it, vi } from 'vitest'

const llmApi = vi.hoisted(() => ({
  listLLMSettings: vi.fn(),
}))
const voiceApi = vi.hoisted(() => ({
  getManagerAgentReadiness: vi.fn(),
}))

vi.mock('@/api/services/llm-settings-api', () => llmApi)
vi.mock('@/api/services/voice-agent-api', async importOriginal => {
  const original = await importOriginal<typeof import('@/api/services/voice-agent-api')>()
  return {
    ...original,
    getManagerAgentReadiness: voiceApi.getManagerAgentReadiness,
  }
})

import { useOnboardingStatus } from './useOnboardingStatus'

describe('useOnboardingStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    llmApi.listLLMSettings.mockResolvedValue({
      data: {
        settings: [],
        total: 0,
      },
    })
  })

  it('maps Codex Live Voice readiness and does not require a separate ASR setting', async () => {
    voiceApi.getManagerAgentReadiness.mockResolvedValue({
      ready: true,
      status: 'ready',
      harness: 'codex_appserver',
      runtime_placement: 'host',
      agent_type: 'manager_agent',
      provider_name: 'codex',
      model_name: 'gpt-5.6-sol',
      live_voice_enabled: true,
      live_voice_effective: true,
      blockers: [],
      checks: {
        config: true,
        codex: {
          available: true,
          logged_in: true,
          version: 'codex-cli 0.145.0',
          live_voice: {
            supported: true,
            minimum_version: '0.145.0',
            protocol: 'v3',
            transport: 'webrtc',
            feature: 'realtime_conversation',
            voices: ['juniper', 'maple'],
            default_voice: 'juniper',
            stage: 'under development',
          },
        },
      },
    })

    const { status, refresh } = useOnboardingStatus()
    await refresh()

    expect(status.value).toMatchObject({
      codexAvailable: true,
      codexVersion: 'codex-cli 0.145.0',
      managerAgentReady: true,
      managerAgentHarness: 'codex_appserver',
      liveVoiceSupported: true,
      liveVoiceMinimumVersion: '0.145.0',
      liveVoiceVoices: ['juniper', 'maple'],
      liveVoiceDefaultVoice: 'juniper',
      liveVoiceEffective: true,
      hasAsr: false,
      needsOnboarding: false,
      loading: false,
    })
  })
})

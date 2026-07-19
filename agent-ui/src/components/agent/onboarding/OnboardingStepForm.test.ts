import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import { detectMainModelRuntime, probeModels } from '@/api/services/providers-api'
import type { Provider } from '@/api/types/orchestration-v2.types'
import OnboardingStepForm from './OnboardingStepForm.vue'

const apiMocks = vi.hoisted(() => ({
  createLLMSetting: vi.fn(async () => ({ success: true, data: undefined })),
  createProvider: vi.fn(async () => ({ success: true, data: undefined })),
  updateProvider: vi.fn(async () => ({ success: true, data: undefined }))
}))
const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn()
}))
const voiceApiMocks = vi.hoisted(() => ({
  testVoiceEndpoints: vi.fn()
}))

vi.mock('@/api/agent', () => ({
  agentSettingsApi: apiMocks
}))

vi.mock('@/api/services/providers-api', () => ({
  detectMainModelRuntime: vi.fn(),
  probeModels: vi.fn(async () => ({ models: [] }))
}))

vi.mock('@/api/services/voice-api', () => ({
  testVoiceEndpoints: voiceApiMocks.testVoiceEndpoints
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => toastMocks
}))

const ttsProvider: Provider = {
  id: 'xiaomi',
  name: 'Xiaomi MiMo',
  source: 'builtin',
  readonly: true,
  endpoints: [{
    id: 'xiaomi_mimo_api',
    provider_id: 'xiaomi',
    name: 'MiMo API 计费',
    plan_type: 'api_billing',
    protocol: 'openai_compatible',
    auth_type: 'bearer',
    base_url: 'https://api.xiaomimimo.com/v1',
    default_model: 'mimo-v2.5-tts',
    models: [{
      id: 'mimo-v2.5-tts',
      display_name: 'MiMo TTS',
      supports_llm: false,
      supports_tts: true
    }]
  }]
}

const existingAsrSetting: LLMSetting = {
  id: 'setting-asr',
  provider_id: 'xiaomi',
  provider_name: 'Xiaomi MiMo',
  endpoint_id: 'xiaomi_mimo_api',
  endpoint_name: 'MiMo API 计费',
  plan_type: 'api_billing',
  protocol: 'openai_compatible',
  model_name: 'mimo-v2.5-asr',
  display_name: 'MiMo ASR',
  api_key_display: 'sk-c****hyxs',
  supports_llm: false,
  supports_asr: true,
  supports_tts: false,
  supports_audio_input: true,
  supports_image_input: false,
  supports_video_input: false,
  is_active: true,
  is_default: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
}

let app: App<Element> | null = null

async function mountForm(props: Record<string, unknown>): Promise<HTMLElement> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(OnboardingStepForm, props)
  app.use(i18n)
  app.mount(root)
  await nextTick()
  return root
}

function inputValue(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-Hans'
  vi.clearAllMocks()
  voiceApiMocks.testVoiceEndpoints.mockResolvedValue({
    success: true,
    data: {
      ok: true,
      results: [
        {
          id: 'asr_http',
          kind: 'http',
          url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
          ok: true,
          reachable: true,
          status_code: 405,
          message: 'Endpoint is reachable'
        },
        {
          id: 'asr_realtime',
          kind: 'websocket',
          url: 'ws://192.168.100.10:5002/v1/realtime',
          ok: true,
          reachable: true,
          message: 'WebSocket handshake succeeded'
        }
      ]
    }
  })
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ''
})

describe('OnboardingStepForm TTS persistence', () => {
  it('uses the explicit credential reuse flag for a preset TTS model', async () => {
    const root = await mountForm({
      capability: 'supports_tts',
      providers: [ttsProvider],
      existingSettings: [existingAsrSetting]
    })

    const credential = root.querySelector<HTMLSelectElement>('select')!
    credential.value = 'xiaomi::api_billing'
    credential.dispatchEvent(new Event('change'))
    await nextTick()

    expect(root.textContent).toContain('sk-c****hyxs')
    const submit = root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!
    submit.click()

    await vi.waitFor(() => expect(apiMocks.createLLMSetting).toHaveBeenCalledTimes(1))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: 'xiaomi',
      endpoint_id: 'xiaomi_mimo_api',
      model_name: 'mimo-v2.5-tts',
      reuse_existing_api_key: true,
      supports_llm: false,
      supports_tts: true
    }))
    expect(apiMocks.createLLMSetting.mock.calls[0]?.[0]).not.toHaveProperty('api_key')
  })

  it('probes preset models by saved setting id when onboarding reuses a credential', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(probeModels).mockResolvedValueOnce({
        models: ['mimo-v2.5-tts', 'mimo-v2.5-tts-latest']
      })
      const root = await mountForm({
        capability: 'supports_tts',
        providers: [ttsProvider],
        existingSettings: [existingAsrSetting]
      })

      const credential = root.querySelector<HTMLSelectElement>('select')!
      credential.value = 'xiaomi::api_billing'
      credential.dispatchEvent(new Event('change'))
      await nextTick()
      await vi.advanceTimersByTimeAsync(600)
      await nextTick()

      expect(probeModels).toHaveBeenCalledWith({ settingId: existingAsrSetting.id })
      expect(root.textContent).toContain('mimo-v2.5-tts-latest')
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a custom TTS provider before saving its model setting', async () => {
    const root = await mountForm({
      capability: 'supports_tts',
      providers: [],
      existingSettings: []
    })

    const customMode = root.querySelectorAll<HTMLButtonElement>('.onboarding-step-form__mode-tab')[1]!
    customMode.click()
    await nextTick()

    const inputs = root.querySelectorAll<HTMLInputElement>('.onboarding-step-form__custom input')
    inputValue(inputs[0]!, 'http://192.168.100.10:5001/v1')
    inputValue(inputs[1]!, 'qwen3-tts')
    await nextTick()
    expect(inputs[1]!.value).toBe('qwen3-tts')

    const submit = root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!
    submit.click()

    await vi.waitFor(() => expect(apiMocks.createLLMSetting).toHaveBeenCalledTimes(1))
    expect(apiMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'local-tts',
      name: expect.any(String),
      default_model: 'qwen3-tts',
      base_url: 'http://192.168.100.10:5001/v1',
      voice_adapter: 'openai_audio',
      tts_http_url: 'http://192.168.100.10:5001/v1/audio/speech',
      tts_realtime_url: 'http://192.168.100.10:5001/v1/audio/speech/stream',
      supports_llm: false,
      supports_tts: true
    }))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: 'local-tts',
      model_name: 'qwen3-tts',
      api_key: 'local-no-key',
      supports_llm: false,
      supports_tts: true
    }))
    expect(apiMocks.createProvider.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.createLLMSetting.mock.invocationCallOrder[0]!
    )
  })
})

describe('OnboardingStepForm ASR endpoint detection', () => {
  async function fillCustomAsr(root: HTMLElement): Promise<void> {
    root.querySelectorAll<HTMLButtonElement>('.onboarding-step-form__mode-tab')[1]!.click()
    await nextTick()
    const inputs = root.querySelectorAll<HTMLInputElement>('.onboarding-step-form__custom input')
    inputValue(inputs[0]!, 'http://192.168.100.10:5002/v1')
    inputValue(inputs[1]!, 'qwen3-asr-realtime')
    await nextTick()
  }

  it('tests the /v1 endpoints before saving and persists both when both are reachable', async () => {
    const root = await mountForm({
      capability: 'supports_asr',
      providers: [],
      existingSettings: []
    })
    await fillCustomAsr(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(apiMocks.createLLMSetting).toHaveBeenCalledTimes(1))
    expect(voiceApiMocks.testVoiceEndpoints).toHaveBeenCalledWith([
      {
        id: 'asr_http',
        kind: 'http',
        url: 'http://192.168.100.10:5002/v1/audio/transcriptions'
      },
      {
        id: 'asr_realtime',
        kind: 'websocket',
        url: 'ws://192.168.100.10:5002/v1/realtime'
      }
    ])
    expect(apiMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      base_url: 'http://192.168.100.10:5002/v1',
      asr_async_url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
      asr_realtime_url: 'ws://192.168.100.10:5002/v1/realtime'
    }))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      asr_async_url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
      asr_realtime_url: 'ws://192.168.100.10:5002/v1/realtime'
    }))
    expect(voiceApiMocks.testVoiceEndpoints.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.createProvider.mock.invocationCallOrder[0]!
    )
  })

  it('stores only the standard endpoint when realtime is unavailable', async () => {
    voiceApiMocks.testVoiceEndpoints.mockResolvedValueOnce({
      success: true,
      data: {
        ok: false,
        results: [
          {
            id: 'asr_http',
            kind: 'http',
            url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
            ok: true,
            reachable: true,
            status_code: 405,
            message: 'Endpoint is reachable'
          },
          {
            id: 'asr_realtime',
            kind: 'websocket',
            url: 'ws://192.168.100.10:5002/v1/realtime',
            ok: false,
            reachable: true,
            status_code: 404,
            message: 'WebSocket handshake returned HTTP 404'
          }
        ]
      }
    })
    const root = await mountForm({
      capability: 'supports_asr',
      providers: [],
      existingSettings: []
    })
    await fillCustomAsr(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(apiMocks.createLLMSetting).toHaveBeenCalledTimes(1))
    expect(apiMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      asr_async_url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
      asr_realtime_url: ''
    }))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      asr_async_url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
      asr_realtime_url: ''
    }))
  })

  it('does not persist an ASR setting when neither endpoint is reachable', async () => {
    voiceApiMocks.testVoiceEndpoints.mockResolvedValueOnce({
      success: true,
      data: {
        ok: false,
        results: [
          {
            id: 'asr_http',
            kind: 'http',
            url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
            ok: false,
            reachable: false,
            message: 'fetch failed'
          },
          {
            id: 'asr_realtime',
            kind: 'websocket',
            url: 'ws://192.168.100.10:5002/v1/realtime',
            ok: false,
            reachable: false,
            message: 'connect ECONNREFUSED'
          }
        ]
      }
    })
    const root = await mountForm({
      capability: 'supports_asr',
      providers: [],
      existingSettings: []
    })
    await fillCustomAsr(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(toastMocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('ASR 接入地址不可用'),
      'error',
      6000
    ))
    expect(apiMocks.createProvider).not.toHaveBeenCalled()
    expect(apiMocks.createLLMSetting).not.toHaveBeenCalled()
  })
})

describe('OnboardingStepForm local Manager Agent setup', () => {
  const localMainSetting: LLMSetting = {
    id: 'setting-local-main',
    provider_id: 'local-llm',
    provider_name: '本地主 Agent',
    provider_source: 'custom',
    endpoint_id: 'local-llm_custom',
    endpoint_name: 'custom',
    plan_type: 'custom',
    protocol: 'anthropic_compatible',
    base_url: 'http://127.0.0.1:8000/v1',
    chat_completions_base_url: 'http://127.0.0.1:8000/v1',
    anthropic_base_url: 'http://127.0.0.1:8000/v1',
    model_name: 'qwen-local',
    display_name: '本地主 Agent · qwen-local',
    api_key_display: 'loca****-key',
    supports_llm: true,
    supports_asr: false,
    supports_tts: false,
    supports_audio_input: false,
    supports_image_input: false,
    supports_video_input: false,
    is_active: true,
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  }

  async function fillLocalMainModel(root: HTMLElement): Promise<void> {
    root.querySelectorAll<HTMLButtonElement>('.onboarding-step-form__mode-tab')[1]!.click()
    await nextTick()
    const inputs = root.querySelectorAll<HTMLInputElement>('.onboarding-step-form__custom input')
    expect(inputs[1]!.value).toBe('')
    inputValue(inputs[0]!, 'http://127.0.0.1:8000/v1')
    inputValue(inputs[1]!, 'qwen-local')
    await nextTick()
  }

  it('tests both endpoints, prefers Claude, persists both URLs, and awaits activation', async () => {
    vi.mocked(detectMainModelRuntime).mockResolvedValueOnce({
      available: true,
      preferred_harness: 'claude_agent_sdk',
      endpoints: {
        anthropic: { available: true, url: 'http://127.0.0.1:8000/v1/messages', status: 200 },
        openai: { available: true, url: 'http://127.0.0.1:8000/v1/chat/completions', status: 200 }
      }
    })
    apiMocks.createLLMSetting.mockResolvedValueOnce({ success: true, data: localMainSetting } as any)
    const activateSetting = vi.fn(async () => undefined)
    const root = await mountForm({
      capability: 'supports_llm',
      providers: [],
      existingSettings: [],
      activateSetting
    })
    await fillLocalMainModel(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(activateSetting).toHaveBeenCalledWith(
      localMainSetting,
      'claude_agent_sdk'
    ))
    expect(detectMainModelRuntime).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: 'local-no-key',
      model: 'qwen-local'
    })
    expect(detectMainModelRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.createLLMSetting.mock.invocationCallOrder[0]!
    )
    expect(apiMocks.createLLMSetting.mock.invocationCallOrder[0]).toBeLessThan(
      activateSetting.mock.invocationCallOrder[0]!
    )
    expect(apiMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      chat_completions_base_url: 'http://127.0.0.1:8000/v1',
      anthropic_base_url: 'http://127.0.0.1:8000/v1'
    }))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'anthropic_compatible',
      chat_completions_base_url: 'http://127.0.0.1:8000/v1',
      anthropic_base_url: 'http://127.0.0.1:8000/v1'
    }))
    expect(toastMocks.showToast).toHaveBeenCalledWith(
      '主模型检测通过，已使用 Claude Agent SDK 配置',
      'success'
    )
  })

  it('falls back to Kimi Code only when the OpenAI endpoint is the one that works', async () => {
    vi.mocked(detectMainModelRuntime).mockResolvedValueOnce({
      available: true,
      preferred_harness: 'kimi_code',
      endpoints: {
        anthropic: {
          available: false,
          url: 'http://127.0.0.1:8000/v1/messages',
          status: 404,
          error: 'HTTP 404'
        },
        openai: { available: true, url: 'http://127.0.0.1:8000/v1/chat/completions', status: 200 }
      }
    })
    const openAiSetting = {
      ...localMainSetting,
      protocol: 'openai_compatible' as const,
      anthropic_base_url: undefined
    }
    apiMocks.createLLMSetting.mockResolvedValueOnce({ success: true, data: openAiSetting } as any)
    const activateSetting = vi.fn(async () => undefined)
    const root = await mountForm({
      capability: 'supports_llm',
      providers: [],
      existingSettings: [],
      activateSetting
    })
    await fillLocalMainModel(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(activateSetting).toHaveBeenCalledWith(openAiSetting, 'kimi_code'))
    expect(apiMocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      chat_completions_base_url: 'http://127.0.0.1:8000/v1',
      anthropic_base_url: ''
    }))
    expect(apiMocks.createLLMSetting).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai_compatible',
      chat_completions_base_url: 'http://127.0.0.1:8000/v1',
      anthropic_base_url: undefined
    }))
  })

  it('does not persist or report success when neither endpoint can run the model', async () => {
    vi.mocked(detectMainModelRuntime).mockResolvedValueOnce({
      available: false,
      preferred_harness: null,
      endpoints: {
        anthropic: {
          available: false,
          url: 'http://127.0.0.1:8000/v1/messages',
          status: 404,
          error: 'HTTP 404'
        },
        openai: {
          available: false,
          url: 'http://127.0.0.1:8000/v1/chat/completions',
          status: 503,
          error: 'HTTP 503'
        }
      }
    })
    const activateSetting = vi.fn(async () => undefined)
    const root = await mountForm({
      capability: 'supports_llm',
      providers: [],
      existingSettings: [],
      activateSetting
    })
    await fillLocalMainModel(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(toastMocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Anthropic Messages：HTTP 404'),
      'error',
      6000
    ))
    expect(apiMocks.createProvider).not.toHaveBeenCalled()
    expect(apiMocks.createLLMSetting).not.toHaveBeenCalled()
    expect(activateSetting).not.toHaveBeenCalled()
    expect(toastMocks.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })

  it('does not report success until runtime activation succeeds', async () => {
    vi.mocked(detectMainModelRuntime).mockResolvedValueOnce({
      available: true,
      preferred_harness: 'claude_agent_sdk',
      endpoints: {
        anthropic: { available: true, url: 'http://127.0.0.1:8000/v1/messages', status: 200 },
        openai: { available: false, url: 'http://127.0.0.1:8000/v1/chat/completions', status: 404 }
      }
    })
    apiMocks.createLLMSetting.mockResolvedValueOnce({ success: true, data: localMainSetting } as any)
    const activateSetting = vi.fn(async () => {
      throw new Error('runtime binding failed')
    })
    const root = await mountForm({
      capability: 'supports_llm',
      providers: [],
      existingSettings: [],
      activateSetting
    })
    await fillLocalMainModel(root)

    root.querySelector<HTMLButtonElement>('.onboarding-step-form__submit')!.click()

    await vi.waitFor(() => expect(toastMocks.showToast).toHaveBeenCalledWith(
      'runtime binding failed',
      'error',
      6000
    ))
    expect(toastMocks.showToast).not.toHaveBeenCalledWith(expect.any(String), 'success')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import type { Provider } from '@/api/types/orchestration-v2.types'
import OnboardingStepForm from './OnboardingStepForm.vue'

const apiMocks = vi.hoisted(() => ({
  createLLMSetting: vi.fn(async () => ({ success: true, data: undefined })),
  createProvider: vi.fn(async () => ({ success: true, data: undefined })),
  updateProvider: vi.fn(async () => ({ success: true, data: undefined }))
}))

vi.mock('@/api/agent', () => ({
  agentSettingsApi: apiMocks
}))

vi.mock('@/api/services/providers-api', () => ({
  probeModels: vi.fn(async () => ({ models: [] }))
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => ({ showToast: vi.fn() })
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

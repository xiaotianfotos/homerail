import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import type { Provider } from '@/api/types/orchestration-v2.types'
import { agentSettingsApi } from '@/api/agent'
import CustomProviderManager from './CustomProviderManager.vue'
import EditModelForm, { type EditModelPayload } from './EditModelForm.vue'
import ModelForm, { type ModelFormPayload } from './ModelForm.vue'

vi.mock('@/api/services/providers-api', () => ({
  probeModels: vi.fn(async () => ({ models: [] }))
}))

vi.mock('@/api/agent', () => ({
  agentSettingsApi: {
    deleteProvider: vi.fn(async () => ({ success: true })),
    updateProvider: vi.fn(async () => ({ success: true }))
  }
}))

vi.mock('@/components/controls/useToast', () => ({
  useToast: () => ({ showToast: vi.fn() })
}))

const provider: Provider = {
  id: 'mixed-provider',
  name: 'Mixed Provider',
  source: 'builtin',
  readonly: true,
  endpoints: [
    {
      id: 'mixed-api',
      provider_id: 'mixed-provider',
      name: 'Mixed API',
      plan_type: 'api_billing',
      protocol: 'openai_compatible',
      auth_type: 'bearer',
      base_url: 'https://mixed.example/v1',
      default_model: 'chat-model',
      supports_llm: true,
      supports_asr: true,
      models: [
        { id: 'chat-model', display_name: 'Chat Model', supports_llm: true },
        {
          id: 'speech-model',
          display_name: 'Speech Model',
          supports_llm: false,
          supports_asr: true
        }
      ]
    }
  ]
}

const setting: LLMSetting = {
  id: 'setting-1',
  provider_id: provider.id,
  provider_name: provider.name,
  provider_source: 'builtin',
  provider_readonly: true,
  endpoint_id: 'mixed-api',
  endpoint_name: 'Mixed API',
  plan_type: 'api_billing',
  protocol: 'openai_compatible',
  model_name: 'chat-model',
  display_name: 'Chat Model',
  api_key_display: '****',
  supports_llm: true,
  supports_asr: false,
  supports_tts: false,
  supports_audio_input: false,
  supports_image_input: true,
  supports_video_input: false,
  is_active: true,
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z'
}

const customProvider: Provider = {
  id: 'local-gemma4-omni',
  name: 'Local Gemma4 12B Omni',
  default_model: 'gemma4-12b',
  base_url: 'http://127.0.0.1:9000/v1',
  source: 'custom',
  readonly: false,
  endpoints: []
}

const customSetting: LLMSetting = {
  ...setting,
  id: 'gemma-setting',
  provider_id: customProvider.id,
  provider_name: customProvider.name,
  provider_source: 'custom',
  provider_readonly: false,
  endpoint_id: 'local-gemma4-omni_custom',
  endpoint_name: 'Custom endpoint',
  plan_type: 'custom',
  protocol: 'custom',
  model_name: 'gemma4-12b',
  display_name: 'Gemma4 12B Omni'
}

const asrProvider: Provider = {
  id: 'local-asr',
  name: 'Local ASR',
  default_model: 'qwen3-asr-realtime',
  base_url: 'http://192.168.100.10:5002',
  source: 'custom',
  readonly: false,
  supports_llm: false,
  supports_asr: true,
  endpoints: []
}

const asrSetting: LLMSetting = {
  ...customSetting,
  id: 'asr-setting',
  provider_id: asrProvider.id,
  provider_name: asrProvider.name,
  model_name: 'qwen3-asr-realtime',
  display_name: 'qwen3-asr-realtime',
  supports_llm: false,
  supports_asr: true,
  supports_audio_input: true,
  supports_image_input: false
}

let app: App<Element> | null = null

async function mount(component: object, props: Record<string, unknown>) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(component, props)
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

describe('model purpose forms', () => {
  it('filters preset models and fixes primary capabilities from the ASR purpose', async () => {
    let submitted: ModelFormPayload | undefined
    const root = await mount(ModelForm, {
      providers: [provider],
      purpose: 'asr',
      onSubmit: (payload: ModelFormPayload) => {
        submitted = payload
      }
    })

    const credential = Array.from(root.querySelectorAll('button')).find(button =>
      button.textContent?.includes('API 计费')
    )
    expect(credential).toBeTruthy()
    credential!.click()
    await nextTick()

    expect(root.textContent).toContain('Speech Model')
    expect(root.textContent).not.toContain('Chat Model')
    const speechModel = Array.from(root.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Speech Model')
    )
    speechModel!.click()
    await nextTick()

    const keyInput = root.querySelector<HTMLInputElement>('input[type="password"]')!
    keyInput.value = 'asr-secret'
    keyInput.dispatchEvent(new Event('input'))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '添加'
    )
    submit!.click()
    await nextTick()

    expect(submitted?.modelName).toBe('speech-model')
    expect(submitted?.capabilities).toMatchObject({
      supports_llm: false,
      supports_asr: true,
      supports_tts: false
    })
  })

  it('reuses a saved provider credential when adding another model on the same endpoint', async () => {
    let submitted: ModelFormPayload | undefined
    const providerWithAnotherModel: Provider = {
      ...provider,
      endpoints: provider.endpoints.map(endpoint => ({
        ...endpoint,
        models: [
          ...endpoint.models,
          { id: 'second-chat-model', display_name: 'Second Chat Model', supports_llm: true }
        ]
      }))
    }
    const root = await mount(ModelForm, {
      providers: [providerWithAnotherModel],
      settings: [setting],
      purpose: 'llm',
      onSubmit: (payload: ModelFormPayload) => {
        submitted = payload
      }
    })

    const credential = Array.from(root.querySelectorAll('button')).find(button =>
      button.textContent?.includes('API 计费')
    )!
    credential.click()
    await nextTick()

    expect(root.querySelector('[data-testid="reused-provider-credential"]')).toBeTruthy()
    expect(root.querySelector('input[type="password"]')).toBeNull()

    const model = Array.from(root.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Second Chat Model')
    )!
    model.click()
    await nextTick()

    const submit = Array.from(root.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '添加'
    )!
    submit.click()
    await nextTick()

    expect(submitted?.modelName).toBe('second-chat-model')
    expect(submitted?.apiKey).toBe('')
    expect(submitted?.reuseExistingApiKey).toBe(true)
  })

  it('uses a separate edit form with a read-only provider binding', async () => {
    let submitted: EditModelPayload | undefined
    const root = await mount(EditModelForm, {
      setting,
      onSubmit: (payload: EditModelPayload) => {
        submitted = payload
      }
    })

    expect(root.textContent).toContain('Mixed Provider')
    expect(root.querySelectorAll('select')).toHaveLength(0)
    expect(root.textContent).toContain('只读')

    const save = Array.from(root.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '保存'
    )
    save!.click()
    await nextTick()

    expect(submitted?.id).toBe('setting-1')
    expect(submitted).not.toHaveProperty('providerId')
    expect(submitted).not.toHaveProperty('provider_id')
  })

  it('shows referenced models and explicitly cascades provider deletion', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    const root = await mount(CustomProviderManager, {
      providers: [customProvider],
      settings: [customSetting]
    })

    expect(root.textContent).toContain('Gemma4 12B Omni')
    const remove = Array.from(root.querySelectorAll('button')).find(button =>
      button.textContent?.includes('删除供应商及 1 个模型')
    )
    expect(remove).toBeTruthy()
    expect(remove!.disabled).toBe(false)

    remove!.click()
    await nextTick()

    const inlineConfirm = root.querySelector<HTMLElement>(
      '[data-testid="delete-custom-provider-confirm"]'
    )
    expect(inlineConfirm?.textContent).toContain('Gemma4 12B Omni')
    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(agentSettingsApi.deleteProvider).not.toHaveBeenCalled()

    root
      .querySelector<HTMLButtonElement>('[data-testid="delete-custom-provider-confirm-confirm"]')!
      .click()
    await nextTick()
    await nextTick()

    expect(agentSettingsApi.deleteProvider).toHaveBeenCalledWith(customProvider.id, {
      cascade: true
    })
  })

  it('keeps an unsaved provider draft when unrelated settings refresh', async () => {
    const settings = ref<LLMSetting[]>([customSetting])
    const Wrapper = defineComponent({
      setup: () => () =>
        h(CustomProviderManager, {
          providers: [customProvider],
          settings: settings.value
        })
    })
    const root = await mount(Wrapper, {})
    const nameInput = Array.from(root.querySelectorAll<HTMLInputElement>('input')).find(
      input => input.value === customProvider.name
    )!

    nameInput.value = 'Unsaved provider name'
    nameInput.dispatchEvent(new Event('input'))
    await nextTick()
    settings.value = [{ ...customSetting, is_active: false }]
    await nextTick()

    expect(nameInput.value).toBe('Unsaved provider name')
  })

  it('derives and saves HTTP and WebSocket endpoints for an ASR provider', async () => {
    const root = await mount(CustomProviderManager, {
      providers: [asrProvider],
      settings: [asrSetting]
    })

    expect(
      root.querySelector<HTMLInputElement>('[data-testid="provider-asr-http-url"]')?.placeholder
    ).toBe('http://192.168.100.10:5002/v1/audio/transcriptions')
    expect(
      root.querySelector<HTMLInputElement>('[data-testid="provider-asr-realtime-url"]')?.placeholder
    ).toBe('ws://192.168.100.10:5002/v1/realtime')
    expect(root.textContent).not.toContain('各协议接入地址')
    expect(root.querySelector('input[placeholder="Chat Completions URL"]')).toBeNull()
    expect(root.querySelector('input[placeholder="Responses URL"]')).toBeNull()
    expect(root.querySelector('input[placeholder="Anthropic URL"]')).toBeNull()

    const save = Array.from(root.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '保存'
    )!
    save.click()
    await nextTick()
    await nextTick()

    expect(agentSettingsApi.updateProvider).toHaveBeenCalledWith(
      asrProvider.id,
      expect.objectContaining({
        base_url: 'http://192.168.100.10:5002/v1',
        voice_adapter: 'openai_audio',
        asr_async_url: 'http://192.168.100.10:5002/v1/audio/transcriptions',
        asr_realtime_url: 'ws://192.168.100.10:5002/v1/realtime'
      })
    )
  })

  it('keeps saved voice endpoints when a provider capability is disabled', async () => {
    const root = await mount(CustomProviderManager, {
      providers: [asrProvider],
      settings: [asrSetting]
    })
    const capabilityButton = (name: string) =>
      Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
        button => button.textContent?.trim() === name
      )!

    capabilityButton('LLM').click()
    capabilityButton('ASR').click()
    await nextTick()
    Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === '保存')!
      .click()
    await nextTick()
    await nextTick()

    const payload = vi.mocked(agentSettingsApi.updateProvider).mock.calls.at(-1)?.[1]
    expect(payload).toMatchObject({ supports_llm: true, supports_asr: false })
    expect(payload?.asr_async_url).toBeUndefined()
    expect(payload?.asr_realtime_url).toBeUndefined()
  })
})

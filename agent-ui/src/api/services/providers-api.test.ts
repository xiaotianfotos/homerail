import { afterEach, describe, expect, it, vi } from 'vitest'

import { http } from '@/api/clients/http-client'
import { detectMainModelRuntime, probeModels } from './providers-api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('providers api model probing', () => {
  it('sends only the saved setting id when probing a reused credential', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { models: ['k3'] }
    })

    await expect(probeModels({ settingId: 'setting-1' })).resolves.toEqual({ models: ['k3'] })
    expect(post).toHaveBeenCalledWith('/api/llm/models/probe', { setting_id: 'setting-1' })
  })

  it('keeps explicit credentials for unsaved model probes', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { models: ['model-1'] }
    })

    await probeModels({ baseUrl: 'https://provider.example/v1', apiKey: 'new-key' })
    expect(post).toHaveBeenCalledWith('/api/llm/models/probe', {
      base_url: 'https://provider.example/v1',
      api_key: 'new-key'
    })
  })

  it('sends the exact base URL and model for dual runtime detection', async () => {
    const detection = {
      available: true,
      preferred_harness: 'claude_agent_sdk' as const,
      endpoints: {
        anthropic: { available: true, url: 'http://localhost/v1/messages', status: 200 },
        openai: { available: true, url: 'http://localhost/v1/chat/completions', status: 200 }
      }
    }
    const post = vi.spyOn(http, 'post').mockResolvedValue({ success: true, data: detection })

    await expect(detectMainModelRuntime({
      baseUrl: 'http://localhost/v1',
      apiKey: '',
      model: 'local-model'
    })).resolves.toEqual(detection)
    expect(post).toHaveBeenCalledWith('/api/llm/models/detect-runtime', {
      base_url: 'http://localhost/v1',
      api_key: '',
      model: 'local-model'
    })
  })
})

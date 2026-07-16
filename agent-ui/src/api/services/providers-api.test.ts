import { afterEach, describe, expect, it, vi } from 'vitest'

import { http } from '@/api/clients/http-client'
import { probeModels } from './providers-api'

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
})

import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import { afterEach, describe, expect, it } from 'vitest'

import HttpClient from './http-client'

const originalAdapter = axios.defaults.adapter

function response(config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
  return {
    config,
    data,
    headers: {},
    status,
    statusText: status >= 400 ? 'Error' : 'OK'
  }
}

function clientWithAdapter(adapter: AxiosAdapter): HttpClient {
  axios.defaults.adapter = adapter
  return new HttpClient({ baseURL: 'https://manager.test', timeout: 1234 })
}

function rejectingAdapter(status: number, data: unknown): AxiosAdapter {
  return async config => {
    throw new AxiosError(
      'Request failed',
      'ERR_BAD_RESPONSE',
      config,
      {},
      response(config, data, status)
    )
  }
}

afterEach(() => {
  axios.defaults.adapter = originalAdapter
  localStorage.clear()
})

describe('HttpClient', () => {
  it('sends every HTTP verb through Axios and injects the auth token', async () => {
    const requests: InternalAxiosRequestConfig[] = []
    const adapter: AxiosAdapter = async config => {
      requests.push(config)
      return response(config, {
        success: true,
        data: { method: config.method, url: config.url }
      })
    }
    const client = clientWithAdapter(adapter)
    client.setToken('test-token')

    await client.get('/items', { params: { page: 2 } })
    await client.post('/items', { name: 'created' })
    await client.put('/items/1', { name: 'replaced' })
    await client.patch('/items/1', { name: 'patched' })
    await client.delete('/items/1')

    expect(requests.map(request => request.method)).toEqual([
      'get',
      'post',
      'put',
      'patch',
      'delete'
    ])
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer test-token')
    expect(requests[0]?.params).toEqual({ page: 2 })
    expect(JSON.parse(String(requests[1]?.data))).toEqual({ name: 'created' })
  })

  it('updates the base URL used by later requests', async () => {
    const requests: InternalAxiosRequestConfig[] = []
    const client = clientWithAdapter(async config => {
      requests.push(config)
      return response(config, { success: true, data: null })
    })

    expect(client.getBaseURL()).toBe('https://manager.test')
    client.setBaseURL('https://manager-2.test')
    await client.get('/health')

    expect(client.getBaseURL()).toBe('https://manager-2.test')
    expect(requests[0]?.baseURL).toBe('https://manager-2.test')
  })

  it('turns a 200 business failure into a structured API error', async () => {
    const client = clientWithAdapter(async config =>
      response(config, {
        success: false,
        error: 'Model is unavailable',
        data: { provider: 'test' }
      })
    )

    await expect(client.get('/models')).rejects.toEqual({
      message: 'Model is unavailable',
      code: 400,
      details: { provider: 'test' }
    })
  })

  it('clears the stored token after an unauthorized response', async () => {
    const client = clientWithAdapter(rejectingAdapter(401, { message: 'expired' }))
    client.setToken('expired-token')

    await expect(client.get('/private')).rejects.toEqual({
      message: 'Authentication required',
      code: 401
    })
    expect(localStorage.getItem('omni_auth_token')).toBeNull()
  })

  it.each([
    [403, { error: 'Manager mutation Origin is not trusted' }, 'Manager mutation Origin is not trusted'],
    [403, {}, 'Access forbidden'],
    [404, { error: { message: 'Missing run' } }, 'Missing run'],
    [409, { message: 'Run is active' }, 'Run is active'],
    [422, { detail: 'Invalid field', details: { field: 'name' } }, 'Invalid field'],
    [400, { error: 'Bad input' }, 'Bad input'],
    [500, { message: 'Manager failed' }, 'Manager failed'],
    [418, {}, 'HTTP Error: 418']
  ])('maps HTTP %i responses to a stable API error', async (status, data, message) => {
    const client = clientWithAdapter(rejectingAdapter(status, data))

    await expect(client.get('/failure')).rejects.toMatchObject({
      message,
      code: status
    })
  })

  it('distinguishes network failures from request configuration failures', async () => {
    const networkClient = clientWithAdapter(async config => {
      throw new AxiosError('offline', 'ERR_NETWORK', config, {})
    })
    await expect(networkClient.get('/health')).rejects.toEqual({
      message: 'Network error - no response received',
      code: 0
    })

    const configClient = clientWithAdapter(async config => {
      throw new AxiosError('Invalid adapter configuration', 'ERR_BAD_OPTION', config)
    })
    await expect(configClient.get('/health')).rejects.toEqual({
      message: 'Invalid adapter configuration'
    })
  })
})

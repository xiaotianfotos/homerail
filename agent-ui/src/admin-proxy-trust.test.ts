import { describe, expect, it } from 'vitest'
import {
  authorizeAdminProxyRequest,
  isProtectedApiMutation,
} from './admin-proxy-trust'

describe('Vite Manager mutation proxy trust', () => {
  it('recognizes every /api mutation, not just plugin routes', () => {
    expect(isProtectedApiMutation('POST', '/api/runs')).toBe(true)
    expect(isProtectedApiMutation('PATCH', '/api/settings')).toBe(true)
    expect(isProtectedApiMutation('DELETE', '/api/plugins/demo')).toBe(true)
    expect(isProtectedApiMutation('GET', '/api/plugins')).toBe(false)
    expect(isProtectedApiMutation('POST', '/artifacts/upload')).toBe(false)
  })

  it('derives localhost self-Origin without a deployment switch', () => {
    expect(authorizeAdminProxyRequest({
      protocol: 'https',
      host: 'localhost:19194',
      origin: 'https://localhost:19194',
      secFetchSite: 'same-origin',
    })).toEqual({ allowed: true })
  })

  it('derives LAN self-Origin without configured public URL', () => {
    expect(authorizeAdminProxyRequest({
      protocol: 'https',
      host: 'homerail.lan:19194',
      origin: 'https://homerail.lan:19194',
      secFetchSite: 'same-origin',
    })).toEqual({ allowed: true })
  })

  it('rejects missing and cross-origin browser mutations', () => {
    expect(authorizeAdminProxyRequest({
      protocol: 'http',
      host: 'localhost:19194',
      origin: undefined,
    })).toMatchObject({ allowed: false })
    expect(authorizeAdminProxyRequest({
      protocol: 'http',
      host: 'localhost:19194',
      origin: 'https://evil.example',
    })).toMatchObject({ allowed: false })
    expect(authorizeAdminProxyRequest({
      protocol: 'http',
      host: 'localhost:19194',
      origin: 'http://localhost:19194',
      secFetchSite: 'cross-site',
    })).toMatchObject({ allowed: false })
  })
})

import { describe, expect, it } from 'vitest'
import {
  authorizeAdminProxyRequest,
  isProtectedApiMutation,
  resolveAdminProxyTrust,
} from './admin-proxy-trust'

const local = () => resolveAdminProxyTrust({
  enabled: true,
  uiOrigin: 'https://localhost:19192',
  uiBindHost: '127.0.0.1',
  managerUrl: 'http://localhost:19191',
})

describe('Vite Manager mutation proxy trust', () => {
  it('recognizes every /api mutation, not just plugin routes', () => {
    expect(isProtectedApiMutation('POST', '/api/runs')).toBe(true)
    expect(isProtectedApiMutation('PATCH', '/api/settings')).toBe(true)
    expect(isProtectedApiMutation('DELETE', '/api/plugins/demo')).toBe(true)
    expect(isProtectedApiMutation('GET', '/api/plugins')).toBe(false)
    expect(isProtectedApiMutation('POST', '/artifacts/upload')).toBe(false)
  })

  it('permits only an exact self-Origin when the loopback switch is safe', () => {
    expect(authorizeAdminProxyRequest(local(), 'https://localhost:19192')).toEqual({ allowed: true })
    expect(authorizeAdminProxyRequest(local(), undefined)).toMatchObject({ allowed: false })
    expect(authorizeAdminProxyRequest(local(), 'https://evil.example')).toMatchObject({ allowed: false })
    expect(authorizeAdminProxyRequest(local(), 'https://localhost:19192', 'cross-site'))
      .toMatchObject({ allowed: false })
  })

  it('fails public UI and non-loopback Manager targets closed even when switched on', () => {
    expect(resolveAdminProxyTrust({
      enabled: true,
      uiOrigin: 'http://192.168.1.9:19193',
      uiBindHost: '0.0.0.0',
      managerUrl: 'http://127.0.0.1:19191',
    }).enabled).toBe(false)
    expect(resolveAdminProxyTrust({
      enabled: true,
      uiOrigin: 'https://localhost:19192',
      uiBindHost: '127.0.0.1',
      managerUrl: 'http://192.168.1.9:19191',
    }).enabled).toBe(false)
  })

  it('allows an explicitly unsafe public test proxy only for its exact self Origin', () => {
    const unsafe = resolveAdminProxyTrust({
      enabled: true,
      uiOrigin: 'http://192.168.1.9:19193',
      uiBindHost: '192.168.1.9',
      managerUrl: 'http://127.0.0.1:19191',
      unsafeAllowPublicNoAuth: true,
    })
    expect(unsafe).toMatchObject({ enabled: true, unsafeAllowPublicNoAuth: true })
    expect(authorizeAdminProxyRequest(unsafe, 'http://192.168.1.9:19193', 'same-origin'))
      .toEqual({ allowed: true })
    expect(authorizeAdminProxyRequest(unsafe, 'https://evil.example', 'cross-site'))
      .toMatchObject({ allowed: false })
  })
})

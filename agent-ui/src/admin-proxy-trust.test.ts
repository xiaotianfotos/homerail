import { describe, expect, it } from 'vitest'
import {
  authorizeAdminProxyRequest,
  hardenBrowserRendererProxyHeaders,
  isAllowedGeneralUiWebSocketProxyPath,
  isProtectedApiMutation,
  trustedBrowserRendererTicketProxyFetchSite,
  trustedBrowserRendererWebSocketProxyFetchSite,
  trustedWebSocketProxyFetchSite,
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

  it('checks matching Host and Origin inside Vite after its allowed-host boundary', () => {
    expect(authorizeAdminProxyRequest({
      protocol: 'https',
      host: 'dev-ui.example.test:19194',
      origin: 'https://dev-ui.example.test:19194',
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

  it('restores the same-origin marker only for a verified UI WebSocket upgrade', () => {
    expect(trustedWebSocketProxyFetchSite({
      protocol: 'http',
      host: '127.0.0.1:19194',
      origin: 'http://127.0.0.1:19194',
    })).toBe('same-origin')

    expect(trustedWebSocketProxyFetchSite({
      protocol: 'http',
      host: '127.0.0.1:19194',
      origin: 'https://evil.example',
    })).toBeUndefined()
  })

  it('authorizes only the exact renderer bridge WebSocket path', () => {
    const request = {
      protocol: 'http' as const,
      host: '127.0.0.1:19192',
      origin: 'http://127.0.0.1:19192',
    }
    expect(trustedBrowserRendererWebSocketProxyFetchSite(
      '/ws/browser-tools/renderer',
      request,
    )).toBe('same-origin')
    expect(trustedBrowserRendererWebSocketProxyFetchSite(
      '/ws/browser-tools/renderer-evil',
      request,
    )).toBeUndefined()
    expect(trustedBrowserRendererWebSocketProxyFetchSite(
      '/ws/browser-tools/renderer?ticket=must-not-be-forwarded',
      request,
    )).toBeUndefined()
    expect(trustedBrowserRendererWebSocketProxyFetchSite(
      '/ws/events',
      request,
    )).toBeUndefined()
    expect(trustedBrowserRendererWebSocketProxyFetchSite(
      '/ws/browser-tools/renderer',
      { ...request, origin: 'https://evil.example' },
    )).toBeUndefined()
  })

  it('restores proxy trust only for an exact renderer ticket POST', () => {
    const request = {
      protocol: 'http' as const,
      host: '127.0.0.1:19192',
      origin: 'http://127.0.0.1:19192',
      secFetchSite: 'same-origin',
    }
    expect(trustedBrowserRendererTicketProxyFetchSite(
      'POST',
      '/api/browser-tools/renderer-ticket',
      request,
    )).toBe('same-origin')
    for (const [method, path] of [
      ['GET', '/api/browser-tools/renderer-ticket'],
      ['POST', '/api/browser-tools/renderer-ticket?leak=1'],
      ['POST', '/api/browser-tools/renderer-ticket/extra'],
      ['POST', '/api/other'],
    ]) {
      expect(trustedBrowserRendererTicketProxyFetchSite(method, path, request)).toBeUndefined()
    }
    expect(trustedBrowserRendererTicketProxyFetchSite(
      'POST',
      '/api/browser-tools/renderer-ticket',
      { ...request, origin: 'https://evil.example' },
    )).toBeUndefined()
  })

  it('strips forwarding claims before asserting the verified proxy hop', () => {
    const removeHeader = vi.fn()
    const setHeader = vi.fn()
    const getHeaderNames = vi.fn(() => [
      'authorization',
      'Forwarded',
      'x-forwarded-for',
      'X-Forwarded-Host',
      'x-forwarded-proto',
      'X-Forwarded-Port',
      'x-forwarded-scheme',
      'X-Real-IP',
    ])
    hardenBrowserRendererProxyHeaders({ getHeaderNames, removeHeader, setHeader }, 'same-origin')

    expect(removeHeader.mock.calls.map(([name]) => name)).toEqual([
      'Forwarded',
      'x-forwarded-for',
      'X-Forwarded-Host',
      'x-forwarded-proto',
      'X-Forwarded-Port',
      'x-forwarded-scheme',
      'X-Real-IP',
    ])
    expect(removeHeader).not.toHaveBeenCalledWith('authorization')
    expect(setHeader).toHaveBeenCalledWith('sec-fetch-site', 'same-origin')
  })

  it('proxies only the two public UI WebSocket routes through the general path', () => {
    expect(isAllowedGeneralUiWebSocketProxyPath('/ws')).toBe(true)
    expect(isAllowedGeneralUiWebSocketProxyPath('/ws/events')).toBe(true)
    for (const path of [
      '/ws/',
      '/ws?ticket=forbidden',
      '/ws/events?cursor=forbidden',
      '/ws/browser-tools',
      '/ws/browser-tools/renderer',
      '/ws/browser-tools/renderer/',
      '/ws/browser-tools/renderer-evil',
      '/ws/unknown',
    ]) {
      expect(isAllowedGeneralUiWebSocketProxyPath(path)).toBe(false)
    }
  })
})

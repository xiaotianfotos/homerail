const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface UiMutationRequestTrust {
  protocol: 'http' | 'https'
  host: string | string[] | undefined
  origin: string | string[] | undefined
  secFetchSite?: string | string[]
}

export function isProtectedApiMutation(methodValue?: string, urlValue?: string): boolean {
  if (!MUTATION_METHODS.has((methodValue || 'GET').toUpperCase())) return false
  try {
    const pathname = new URL(urlValue || '/', 'http://localhost').pathname
    return pathname === '/api' || pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Authorize a browser mutation using the origin of the request that reached the
 * Vite development server. This deliberately has no deployment switch or
 * configured Origin: Vite's own allowed-host boundary runs before this helper,
 * which only verifies that the surviving browser Origin matches that Host.
 * Production named-host pinning belongs to the static UI server and is covered
 * by its integration tests. Manager remains the canonical trust boundary after
 * either proxy hop.
 */
export function authorizeAdminProxyRequest(
  request: UiMutationRequestTrust,
): { allowed: true } | { allowed: false; reason: string } {
  const host = singleHeader(request.host)
  const origin = singleHeader(request.origin)
  if (!host || !origin) {
    return { allowed: false, reason: 'UI mutation Origin is required' }
  }

  let selfOrigin: string
  try {
    selfOrigin = new URL(`${request.protocol}://${host}`).origin
  } catch {
    return { allowed: false, reason: 'UI request Host is invalid' }
  }
  if (origin !== selfOrigin) {
    return { allowed: false, reason: 'Cross-origin UI mutation requests are forbidden' }
  }

  const secFetchSite = singleHeader(request.secFetchSite)?.toLowerCase()
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin') {
    return { allowed: false, reason: 'Cross-origin UI mutation requests are forbidden' }
  }
  return { allowed: true }
}

/**
 * Browsers do not consistently forward Sec-Fetch-Site on WebSocket upgrades.
 * Once the UI proxy has independently verified the browser-facing Origin and
 * Host, it can restore the same-origin marker for Manager's upgrade boundary.
 */
export function trustedWebSocketProxyFetchSite(
  request: UiMutationRequestTrust,
): 'same-origin' | undefined {
  return authorizeAdminProxyRequest(request).allowed ? 'same-origin' : undefined
}

export function trustedBrowserRendererWebSocketProxyFetchSite(
  urlValue: string | undefined,
  request: UiMutationRequestTrust,
): 'same-origin' | undefined {
  try {
    const url = new URL(urlValue || '/', 'http://localhost')
    if (url.pathname !== '/ws/browser-tools/renderer' || url.search) {
      return undefined
    }
  } catch {
    return undefined
  }
  return trustedWebSocketProxyFetchSite(request)
}

export function trustedBrowserRendererTicketProxyFetchSite(
  methodValue: string | undefined,
  urlValue: string | undefined,
  request: UiMutationRequestTrust,
): 'same-origin' | undefined {
  if ((methodValue || 'GET').toUpperCase() !== 'POST') return undefined
  try {
    const url = new URL(urlValue || '/', 'http://localhost')
    if (url.pathname !== '/api/browser-tools/renderer-ticket' || url.search) {
      return undefined
    }
  } catch {
    return undefined
  }
  return trustedWebSocketProxyFetchSite(request)
}

export function isAllowedGeneralUiWebSocketProxyPath(urlValue: string | undefined): boolean {
  try {
    const url = new URL(urlValue || '/', 'http://localhost')
    return !url.search && (url.pathname === '/ws' || url.pathname === '/ws/events')
  } catch {
    return false
  }
}

export interface BrowserRendererProxyHeaders {
  getHeaderNames(): string[]
  removeHeader(name: string): void
  setHeader(name: string, value: string): void
}

export function hardenBrowserRendererProxyHeaders(
  headers: BrowserRendererProxyHeaders,
  fetchSite: 'same-origin',
): void {
  for (const name of headers.getHeaderNames()) {
    const normalized = name.toLowerCase()
    if (
      normalized === 'forwarded'
      || normalized === 'x-real-ip'
      || normalized.startsWith('x-forwarded-')
    ) {
      headers.removeHeader(name)
    }
  }
  headers.setHeader('sec-fetch-site', fetchSite)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) return undefined
  return value
}

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
 * UI server. This deliberately has no deployment switch or configured Origin:
 * Vite already knows the browser-facing protocol and Host for every request.
 * Manager remains the canonical trust boundary after the proxy hop.
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

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) return undefined
  return value
}

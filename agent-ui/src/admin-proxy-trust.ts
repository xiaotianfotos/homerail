const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AdminProxyTrustOptions {
  enabled: boolean
  uiOrigin: string
  uiBindHost: string
  managerUrl: string
  unsafeAllowPublicNoAuth?: boolean
}

export interface AdminProxyTrust {
  enabled: boolean
  uiOrigin?: string
  unsafeAllowPublicNoAuth?: boolean
  disabledReason?: string
}

export function resolveAdminProxyTrust(options: AdminProxyTrustOptions): AdminProxyTrust {
  if (!options.enabled) return disabled('loopback-safe admin proxy switch is disabled')
  const uiOrigin = exactOrigin(options.uiOrigin)
  if (!uiOrigin) return disabled('UI Origin is invalid')
  const unsafeAllowPublicNoAuth = Boolean(options.unsafeAllowPublicNoAuth)
  if (
    (!isLoopbackHost(options.uiBindHost) || !isLoopbackHost(new URL(uiOrigin).hostname))
    && !unsafeAllowPublicNoAuth
  ) {
    return disabled('UI is reachable beyond loopback')
  }
  let manager: URL
  try {
    manager = new URL(options.managerUrl)
  } catch {
    return disabled('Manager URL is invalid')
  }
  if (
    !['http:', 'https:'].includes(manager.protocol)
    || !isLoopbackHost(manager.hostname)
    || Boolean(manager.username)
    || Boolean(manager.password)
  ) return disabled('Manager is reachable beyond loopback')
  return { enabled: true, uiOrigin, unsafeAllowPublicNoAuth }
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

export function authorizeAdminProxyRequest(
  trust: AdminProxyTrust,
  origin: string | string[] | undefined,
  secFetchSite?: string | string[],
): { allowed: true } | { allowed: false; reason: string } {
  if (!trust.enabled || !trust.uiOrigin) {
    return { allowed: false, reason: trust.disabledReason || 'UI mutation proxy is disabled' }
  }
  if (typeof origin !== 'string' || origin !== trust.uiOrigin) {
    return { allowed: false, reason: 'UI mutation Origin is missing or not self-origin' }
  }
  if (
    secFetchSite !== undefined
    && (typeof secFetchSite !== 'string' || secFetchSite.toLowerCase() !== 'same-origin')
  ) return { allowed: false, reason: 'Cross-origin UI mutation proxy requests are forbidden' }
  return { allowed: true }
}

function exactOrigin(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || Boolean(parsed.username)
    || Boolean(parsed.password)
    || parsed.pathname !== '/'
    || Boolean(parsed.search)
    || Boolean(parsed.hash)
    || parsed.origin !== value
  ) return undefined
  return parsed.origin
}

function isLoopbackHost(value: string): boolean {
  let host = value.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const zone = host.indexOf('%')
  if (zone >= 0) host = host.slice(0, zone)
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length)
  const octets = host.split('.')
  return octets.length === 4
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

function disabled(reason: string): AdminProxyTrust {
  return { enabled: false, disabledReason: reason }
}

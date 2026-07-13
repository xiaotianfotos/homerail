const KIMI_PROVIDER_IDS = new Set(['kimi_cn', 'kimi'])

export function isKimiProviderId(providerId?: string | null): boolean {
  return Boolean(providerId && KIMI_PROVIDER_IDS.has(providerId))
}

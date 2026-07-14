const KIMI_PROVIDER_IDS = new Set(['kimi_cn', 'kimi'])

export interface RuntimeModelLabelSetting {
  provider_id?: string | null
  provider_name?: string | null
  display_name?: string | null
  model_name?: string | null
  plan_type?: string | null
}

export function isKimiProviderId(providerId?: string | null): boolean {
  return Boolean(providerId && KIMI_PROVIDER_IDS.has(providerId))
}

export function formatRuntimeModelSettingLabel(
  setting: RuntimeModelLabelSetting | null | undefined,
  siblingSettings: RuntimeModelLabelSetting[],
  planLabel: (plan?: string) => string,
): string {
  if (!setting) return ''
  const model = setting.display_name || setting.model_name || ''
  const base = setting.provider_name ? `${setting.provider_name} / ${model}` : model
  if (!setting.provider_id) return base

  const providerPlans = new Set(
    siblingSettings
      .filter(item => item.provider_id === setting.provider_id)
      .map(item => item.plan_type || 'custom'),
  )
  return providerPlans.size > 1 ? `${base} · ${planLabel(setting.plan_type || 'custom')}` : base
}

import { describe, expect, it } from 'vitest'
import { formatRuntimeModelSettingLabel, isKimiProviderId } from './model-runtime'

describe('model runtime provider helpers', () => {
  it('recognizes both CN and international Kimi providers', () => {
    expect(isKimiProviderId('kimi_cn')).toBe(true)
    expect(isKimiProviderId('kimi')).toBe(true)
    expect(isKimiProviderId('glm')).toBe(false)
  })

  it('adds plan labels only when a provider has multiple billing plans', () => {
    const apiSetting = {
      provider_id: 'kimi_cn',
      provider_name: 'Kimi / Moonshot CN',
      display_name: 'kimi-k2.7-code',
      model_name: 'kimi-k2.7-code',
      plan_type: 'api_billing',
    }
    const codingSetting = {
      ...apiSetting,
      model_name: 'kimi-for-coding',
      plan_type: 'coding_plan',
    }
    const planLabel = (plan?: string) => (plan === 'coding_plan' ? 'Coding Plan' : 'API 计费')

    expect(formatRuntimeModelSettingLabel(apiSetting, [apiSetting], planLabel)).toBe(
      'Kimi / Moonshot CN / kimi-k2.7-code',
    )
    expect(formatRuntimeModelSettingLabel(apiSetting, [apiSetting, codingSetting], planLabel)).toBe(
      'Kimi / Moonshot CN / kimi-k2.7-code · API 计费',
    )
    expect(formatRuntimeModelSettingLabel(codingSetting, [apiSetting, codingSetting], planLabel)).toBe(
      'Kimi / Moonshot CN / kimi-k2.7-code · Coding Plan',
    )
  })
})

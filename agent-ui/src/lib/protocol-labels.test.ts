import { describe, expect, it } from 'vitest'
import { createProtocolLabels } from './protocol-labels'

describe('localized protocol labels', () => {
  const { planLabel, protocolLabel } = createProtocolLabels(key => `translated:${key}`)

  it('resolves plan labels through locale resources', () => {
    expect(planLabel('api_billing')).toBe('translated:settings.models.plans.apiBilling')
    expect(planLabel('coding_plan')).toBe('translated:settings.models.plans.codingPlan')
    expect(planLabel('unknown')).toBe('translated:settings.models.plans.custom')
  })

  it('keeps API names stable and localizes vendor labels', () => {
    expect(protocolLabel('openai_compatible')).toBe('Chat Completions')
    expect(protocolLabel('volcengine_openspeech')).toBe(
      'translated:settings.models.protocols.volcengineOpenSpeech',
    )
    expect(protocolLabel('custom')).toBe('translated:settings.models.protocols.custom')
    expect(protocolLabel('future_protocol')).toBe('future_protocol')
    expect(protocolLabel()).toBe('—')
  })
})

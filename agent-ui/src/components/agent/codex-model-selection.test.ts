import { describe, expect, it } from 'vitest'

import type { CodexModel } from '@/api/agent'
import {
  isCodexModelUnavailable,
  resolveCodexModelOptions,
  resolveSelectedCodexModel,
  resolveCodexReasoningEffortForModel,
  resolveCodexReasoningEffortOptions,
  resolveCodexServiceTierForModel,
  resolveCodexServiceTierOptions
} from './codex-model-selection'

function model(
  id: string,
  isDefault = false,
  efforts = ['medium'],
  defaultEffort = 'medium',
  fast = false
): CodexModel {
  return {
    id,
    model: id,
    display_name: id,
    description: '',
    is_default: isDefault,
    default_reasoning_effort: defaultEffort,
    supported_reasoning_efforts: efforts,
    reasoning_effort_options: efforts.map(effort => ({
      reasoning_effort: effort,
      description: `${effort} description`
    })),
    service_tiers: fast
      ? [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }]
      : []
  }
}

describe('Codex model selection', () => {
  it('keeps an unavailable saved model selected without adding it to the account catalog', () => {
    const options = resolveCodexModelOptions([model('gpt-5.5', true)], 'gpt-5.6-sol', true)

    expect(options.map(option => option.model)).toEqual(['gpt-5.5'])
    expect(resolveSelectedCodexModel(options, 'gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(isCodexModelUnavailable(options, 'gpt-5.6-sol', true)).toBe(true)
  })

  it('keeps the saved model as a temporary fallback when catalog loading fails', () => {
    const options = resolveCodexModelOptions([], 'gpt-5.6-sol', false)

    expect(options.map(option => option.model)).toEqual(['gpt-5.6-sol'])
    expect(resolveSelectedCodexModel(options, 'gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(isCodexModelUnavailable(options, 'gpt-5.6-sol', false)).toBe(false)
  })

  it('preserves the saved value when a loaded catalog is empty', () => {
    const options = resolveCodexModelOptions([], 'gpt-5.6-sol', true)

    expect(options).toEqual([])
    expect(resolveSelectedCodexModel(options, 'gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(isCodexModelUnavailable(options, 'gpt-5.6-sol', true)).toBe(true)
  })

  it('does not invent a fallback model when no catalog or saved value exists', () => {
    const options = resolveCodexModelOptions([], null, false)

    expect(options).toEqual([])
    expect(resolveSelectedCodexModel(options, null)).toBe('')
  })

  it('uses all six Sol reasoning efforts and OpenAI descriptions', () => {
    const sol = model(
      'gpt-5.6-sol',
      true,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'low',
      true
    )
    const options = resolveCodexReasoningEffortOptions([sol], sol.model, 'medium')

    expect(options.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(options.find(option => option.value === 'ultra')).toEqual({
      value: 'ultra',
      label: 'Ultra',
      description: 'ultra description'
    })
  })

  it('falls back to the new model default when the current effort is unsupported', () => {
    const luna = model('gpt-5.6-luna', false, ['low', 'medium', 'high', 'xhigh', 'max'], 'medium')

    expect(resolveCodexReasoningEffortForModel([luna], luna.model, 'ultra')).toBe('medium')
    expect(resolveCodexReasoningEffortForModel([luna], luna.model, 'max')).toBe('max')
  })

  it('uses OpenAI service tier labels and defaults to Standard', () => {
    const sol = model('gpt-5.6-sol', true, ['low'], 'low', true)

    expect(resolveCodexServiceTierOptions([sol], sol.model)).toEqual([
      { value: '', label: 'Standard', description: 'Standard speed and usage' },
      { value: 'priority', label: 'Fast', description: '1.5x speed, increased usage' }
    ])
    expect(resolveCodexServiceTierForModel([sol], sol.model, 'priority')).toBe('priority')
    expect(resolveCodexServiceTierForModel([sol], sol.model, 'flex')).toBeNull()
  })
})

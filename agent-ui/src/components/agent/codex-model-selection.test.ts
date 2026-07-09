import { describe, expect, it } from 'vitest'

import type { CodexModel } from '@/api/agent'
import {
  isCodexModelUnavailable,
  resolveCodexModelOptions,
  resolveSelectedCodexModel
} from './codex-model-selection'

function model(id: string, isDefault = false): CodexModel {
  return {
    id,
    model: id,
    display_name: id,
    description: '',
    is_default: isDefault,
    default_reasoning_effort: 'medium',
    supported_reasoning_efforts: ['medium'],
    service_tiers: []
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
})

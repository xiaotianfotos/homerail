import { describe, expect, it } from 'vitest'
import { resolveGenerativeUiMotionProfile } from './motion-profiles'

describe('Generative UI motion profiles', () => {
  it('uses the bounded standard profile when no profile is requested', () => {
    expect(resolveGenerativeUiMotionProfile()).toEqual({
      id: 'standard',
      attentionDurationMs: 2400,
    })
  })

  it('resolves the explicitly requested profile through the registry', () => {
    expect(resolveGenerativeUiMotionProfile('standard').id).toBe('standard')
  })

  it('fails closed to standard when stale runtime data names an unknown profile', () => {
    expect(resolveGenerativeUiMotionProfile('cinematic' as 'standard').id).toBe('standard')
  })
})

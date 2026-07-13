import { describe, expect, it } from 'vitest'
import { isKimiProviderId } from './model-runtime'

describe('model runtime provider helpers', () => {
  it('recognizes both CN and international Kimi providers', () => {
    expect(isKimiProviderId('kimi_cn')).toBe(true)
    expect(isKimiProviderId('kimi')).toBe(true)
    expect(isKimiProviderId('glm')).toBe(false)
  })
})

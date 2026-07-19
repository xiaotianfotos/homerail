import { describe, expect, it } from 'vitest'
import toastSource from './Toast.vue?raw'

describe('global toast layering', () => {
  it('teleports above full-screen onboarding overlays', () => {
    expect(toastSource).toContain('<Teleport to="body">')
    expect(toastSource).toContain('z-[10000]')
  })
})

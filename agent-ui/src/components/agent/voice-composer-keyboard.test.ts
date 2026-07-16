import { describe, expect, it } from 'vitest'
import { shouldSubmitVoiceComposer } from './voice-composer-keyboard'

function keyEvent(
  overrides: Partial<Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode' | 'shiftKey'>> = {}
) {
  return {
    isComposing: false,
    key: 'Enter',
    keyCode: 13,
    shiftKey: false,
    ...overrides
  }
}

describe('shouldSubmitVoiceComposer', () => {
  it('submits a regular Enter key', () => {
    expect(shouldSubmitVoiceComposer(keyEvent())).toBe(true)
  })

  it('keeps Shift+Enter as a newline', () => {
    expect(shouldSubmitVoiceComposer(keyEvent({ shiftKey: true }))).toBe(false)
  })

  it('does not submit while an IME composition is active', () => {
    expect(shouldSubmitVoiceComposer(keyEvent({ isComposing: true }))).toBe(false)
  })

  it('does not submit legacy IME keydown events', () => {
    expect(shouldSubmitVoiceComposer(keyEvent({ keyCode: 229 }))).toBe(false)
  })

  it('ignores non-Enter keys', () => {
    expect(shouldSubmitVoiceComposer(keyEvent({ key: 'Process', keyCode: 229 }))).toBe(false)
    expect(shouldSubmitVoiceComposer(keyEvent({ key: 'a', keyCode: 65 }))).toBe(false)
  })
})

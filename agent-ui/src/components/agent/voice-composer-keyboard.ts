type VoiceComposerKeyboardEvent = Pick<
  KeyboardEvent,
  'isComposing' | 'key' | 'keyCode' | 'shiftKey'
>

export function shouldSubmitVoiceComposer(event: VoiceComposerKeyboardEvent): boolean {
  // Some IMEs report keyCode 229 while confirming a candidate even when
  // isComposing is false, so keep both guards.
  if (event.isComposing || event.keyCode === 229) return false
  return event.key === 'Enter' && !event.shiftKey
}

export type VoiceSpeechChannel = 'final' | 'commentary'

export interface VoiceSpeechFingerprintInput {
  channel?: VoiceSpeechChannel | string | null
  text?: string | null
}

export interface VoiceConversationSpeechCandidate {
  role?: string | null
  kind?: string | null
  text?: string | null
}

export const VOICE_SPEECH_EVENT_KEY_TTL_MS = 60_000

export function normalizeVoiceSpeechTextForKey(text: string | null | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim()
}

export function isVoiceConversationMessageSpeakable(
  message: VoiceConversationSpeechCandidate,
): boolean {
  return message.role === 'assistant' && message.kind !== 'error' && Boolean(message.text?.trim())
}

export function createVoiceSpeechEventKey(event: VoiceSpeechFingerprintInput): string {
  const text = normalizeVoiceSpeechTextForKey(event.text)
  if (!text) return ''
  const channel = event.channel === 'commentary' ? 'commentary' : 'final'
  return `${channel}:${text}`
}

export function pruneVoiceSpeechEventKeys(
  seenAt: Map<string, number>,
  now = Date.now(),
  ttlMs = VOICE_SPEECH_EVENT_KEY_TTL_MS,
): void {
  for (const [key, timestamp] of seenAt) {
    if (now - timestamp > ttlMs) seenAt.delete(key)
  }
}

export function hasRecentVoiceSpeechEvent(
  seenAt: Map<string, number>,
  event: VoiceSpeechFingerprintInput,
  now = Date.now(),
  ttlMs = VOICE_SPEECH_EVENT_KEY_TTL_MS,
): boolean {
  pruneVoiceSpeechEventKeys(seenAt, now, ttlMs)
  const key = createVoiceSpeechEventKey(event)
  return Boolean(key && seenAt.has(key))
}

export function rememberVoiceSpeechEvent(
  seenAt: Map<string, number>,
  event: VoiceSpeechFingerprintInput,
  now = Date.now(),
  ttlMs = VOICE_SPEECH_EVENT_KEY_TTL_MS,
): string {
  pruneVoiceSpeechEventKeys(seenAt, now, ttlMs)
  const key = createVoiceSpeechEventKey(event)
  if (key) seenAt.set(key, now)
  return key
}

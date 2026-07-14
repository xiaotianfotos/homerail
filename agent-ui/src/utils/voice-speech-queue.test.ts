import { describe, expect, it } from 'vitest'
import {
  createVoiceSpeechEventKey,
  hasRecentVoiceSpeechEvent,
  isVoiceConversationMessageSpeakable,
  normalizeVoiceSpeechTextForKey,
  pruneVoiceSpeechEventKeys,
  rememberVoiceSpeechEvent,
} from './voice-speech-queue'

describe('voice speech queue helpers', () => {
  it('normalizes whitespace for stable TTS event keys', () => {
    expect(normalizeVoiceSpeechTextForKey('  你好\n\nNative   TTS  ')).toBe('你好 Native TTS')
    expect(createVoiceSpeechEventKey({ channel: 'final', text: '  你好\nNative   TTS  ' })).toBe(
      'final:你好 Native TTS',
    )
  })

  it('dedupes explicit speech events and workspace fallback by spoken text', () => {
    const seen = new Map<string, number>()
    const explicit = { id: 'speech-1', channel: 'final', text: '队列复测会播放 TTS。' }
    const fallback = { id: 'assistant-1', channel: 'final', text: '队列复测会播放 TTS。' }

    expect(hasRecentVoiceSpeechEvent(seen, fallback, 1_000)).toBe(false)
    rememberVoiceSpeechEvent(seen, explicit, 1_000)
    expect(hasRecentVoiceSpeechEvent(seen, fallback, 1_001)).toBe(true)
  })

  it('keeps commentary and final channels separate', () => {
    const seen = new Map<string, number>()
    rememberVoiceSpeechEvent(seen, { channel: 'commentary', text: '正在处理。' }, 2_000)

    expect(hasRecentVoiceSpeechEvent(seen, { channel: 'commentary', text: '正在处理。' }, 2_001)).toBe(true)
    expect(hasRecentVoiceSpeechEvent(seen, { channel: 'final', text: '正在处理。' }, 2_001)).toBe(false)
  })

  it('expires old keys by ttl', () => {
    const seen = new Map<string, number>()
    rememberVoiceSpeechEvent(seen, { channel: 'final', text: '旧消息' }, 10_000, 100)

    expect(hasRecentVoiceSpeechEvent(seen, { channel: 'final', text: '旧消息' }, 10_050, 100)).toBe(true)
    pruneVoiceSpeechEventKeys(seen, 10_101, 100)
    expect(hasRecentVoiceSpeechEvent(seen, { channel: 'final', text: '旧消息' }, 10_101, 100)).toBe(false)
  })

  it('never sends structured execution errors to TTS', () => {
    expect(isVoiceConversationMessageSpeakable({
      role: 'assistant',
      kind: 'error',
      text: '主 Agent 执行失败：provider rejected the credential',
    })).toBe(false)
    expect(isVoiceConversationMessageSpeakable({
      role: 'assistant',
      kind: 'message',
      text: '任务已经完成。',
    })).toBe(true)
  })
})

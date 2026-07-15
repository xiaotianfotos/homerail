import { describe, expect, it } from 'vitest'

import {
  BUILTIN_EDGE_TTS_MODEL,
  BUILTIN_EDGE_TTS_OPTION_ID,
  BUILTIN_EDGE_TTS_VOICE,
  builtinEdgeTtsUpdate,
  isBuiltinEdgeTtsSettings
} from './builtin-tts'

describe('built-in Edge TTS option', () => {
  it('recognizes only the keyless built-in runtime, not a stored model setting', () => {
    expect(isBuiltinEdgeTtsSettings({
      tts_model: BUILTIN_EDGE_TTS_MODEL,
      tts_llm_setting_id: null
    })).toBe(true)
    expect(isBuiltinEdgeTtsSettings({
      tts_model: BUILTIN_EDGE_TTS_MODEL,
      tts_llm_setting_id: 'user-edge-setting'
    })).toBe(false)
    expect(BUILTIN_EDGE_TTS_OPTION_ID).toBe('builtin:microsoft-edge')
  })

  it('produces a canonical update without creating an LLM setting', () => {
    expect(builtinEdgeTtsUpdate()).toEqual({
      tts_base_url: '',
      tts_model: BUILTIN_EDGE_TTS_MODEL,
      tts_llm_setting_id: null,
      tts_voice: BUILTIN_EDGE_TTS_VOICE,
      tts_speed: null,
      tts_stream: false
    })
  })
})

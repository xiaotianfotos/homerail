import { describe, expect, it } from 'vitest'

import {
  BUILTIN_EDGE_TTS_MODEL,
  BUILTIN_EDGE_TTS_OPTION_ID,
  BUILTIN_EDGE_TTS_VOICE,
  builtinEdgeTtsRequest,
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

  it('preserves the active Agent and ASR runtime in a full settings request', () => {
    expect(builtinEdgeTtsRequest({
      recognition_mode: 'asr',
      omni_base_url: '',
      omni_model: '',
      omni_llm_setting_id: null,
      omni_token_set: false,
      llm_base_url: 'http://manager.test/v1',
      llm_model: 'manager-model',
      llm_setting_id: 'manager-setting',
      llm_token_set: true,
      asr_base_url: 'http://asr.test/v1',
      asr_realtime_url: 'ws://asr.test/v1/realtime',
      asr_model: 'asr-model',
      asr_llm_setting_id: 'asr-setting',
      asr_token_set: true,
      tts_base_url: 'http://old-tts.test/v1',
      tts_model: 'old-tts',
      tts_llm_setting_id: 'old-tts-setting',
      tts_voice: 'old-voice',
      tts_speed: 1.2,
      tts_token_set: true,
      tts_stream: true,
      tts_output_channels: ['final']
    })).toEqual(expect.objectContaining({
      recognition_mode: 'asr',
      llm_setting_id: 'manager-setting',
      asr_llm_setting_id: 'asr-setting',
      asr_realtime_url: 'ws://asr.test/v1/realtime',
      tts_base_url: '',
      tts_model: BUILTIN_EDGE_TTS_MODEL,
      tts_llm_setting_id: null,
      tts_voice: BUILTIN_EDGE_TTS_VOICE,
      tts_speed: null,
      tts_stream: false,
      tts_output_channels: ['final']
    }))
  })
})

import type { UpdateVoiceSettingsRequest, VoiceSettings } from '@/api/services/voice-api'

export const BUILTIN_EDGE_TTS_OPTION_ID = 'builtin:microsoft-edge'
export const BUILTIN_EDGE_TTS_MODEL = 'edge-tts'
export const BUILTIN_EDGE_TTS_VOICE = 'en-US-MichelleNeural'

export function isBuiltinEdgeTtsSettings(
  settings: Pick<VoiceSettings, 'tts_llm_setting_id' | 'tts_model'> | null | undefined
): boolean {
  return Boolean(
    settings &&
    !settings.tts_llm_setting_id &&
    settings.tts_model === BUILTIN_EDGE_TTS_MODEL
  )
}

export function builtinEdgeTtsUpdate(): Partial<UpdateVoiceSettingsRequest> {
  return {
    tts_base_url: '',
    tts_model: BUILTIN_EDGE_TTS_MODEL,
    tts_llm_setting_id: null,
    tts_voice: BUILTIN_EDGE_TTS_VOICE,
    tts_speed: null,
    tts_stream: false
  }
}

/** Build the full PUT payload while preserving every non-TTS voice setting. */
export function builtinEdgeTtsRequest(settings: VoiceSettings): UpdateVoiceSettingsRequest {
  return {
    recognition_mode: settings.recognition_mode,
    omni_base_url: settings.omni_base_url,
    omni_model: settings.omni_model,
    omni_llm_setting_id: settings.omni_llm_setting_id || null,
    omni_token: null,
    llm_base_url: settings.llm_base_url,
    llm_model: settings.llm_model,
    llm_setting_id: settings.llm_setting_id || null,
    llm_token: null,
    asr_base_url: settings.asr_base_url,
    asr_realtime_url: settings.asr_realtime_url,
    asr_model: settings.asr_model,
    asr_llm_setting_id: settings.asr_llm_setting_id || null,
    asr_token: null,
    tts_base_url: settings.tts_base_url,
    tts_model: settings.tts_model,
    tts_llm_setting_id: settings.tts_llm_setting_id || null,
    tts_voice: settings.tts_voice,
    tts_speed: settings.tts_speed,
    tts_token: null,
    tts_stream: settings.tts_stream,
    tts_output_channels: settings.tts_output_channels?.length
      ? settings.tts_output_channels
      : ['commentary', 'final'],
    ...builtinEdgeTtsUpdate()
  }
}

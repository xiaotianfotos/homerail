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

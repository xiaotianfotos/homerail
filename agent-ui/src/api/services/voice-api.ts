import { http } from '@/api/clients/http-client'
import type { BaseResponse } from '@/api/types/common.types'

export type VoiceTtsOutputChannel = 'final' | 'commentary'

export interface VoiceSettings {
  recognition_mode: 'omni' | 'asr'
  omni_base_url: string
  omni_model: string
  omni_llm_setting_id?: string | null
  omni_token_set: boolean
  llm_base_url: string
  llm_model: string
  llm_setting_id?: string | null
  llm_token_set: boolean
  asr_base_url: string
  asr_realtime_url: string
  asr_model: string
  asr_llm_setting_id?: string | null
  asr_token_set: boolean
  tts_base_url: string
  tts_model: string
  tts_llm_setting_id?: string | null
  tts_voice: string
  tts_speed: number | null
  tts_token_set: boolean
  tts_stream: boolean
  tts_output_channels: VoiceTtsOutputChannel[]
}

export interface UpdateVoiceSettingsRequest {
  recognition_mode: 'omni' | 'asr'
  omni_base_url: string
  omni_model: string
  omni_llm_setting_id?: string | null
  omni_token?: string | null
  llm_base_url: string
  llm_model: string
  llm_setting_id?: string | null
  llm_token?: string | null
  asr_base_url: string
  asr_realtime_url: string
  asr_model: string
  asr_llm_setting_id?: string | null
  asr_token?: string | null
  tts_base_url: string
  tts_model: string
  tts_llm_setting_id?: string | null
  tts_voice: string
  tts_speed: number | null
  tts_token?: string | null
  tts_stream: boolean
  tts_output_channels: VoiceTtsOutputChannel[]
}

export interface VoiceModelsResponse {
  models: string[]
  raw?: unknown
  verified?: boolean
  verification_status?: 'verified' | 'not_verified'
  warning?: string
}

export interface VoiceModelsRequest {
  service: 'omni' | 'llm' | 'asr' | 'tts'
  llm_setting_id?: string | null
  base_url?: string
  token?: string
}

export type VoiceEndpointProbeKind = 'http' | 'websocket'

export interface VoiceEndpointProbeCandidate {
  id: string
  kind: VoiceEndpointProbeKind
  url: string
}

export interface VoiceEndpointProbeResult extends VoiceEndpointProbeCandidate {
  ok: boolean
  reachable: boolean
  status_code?: number
  message: string
}

export interface VoiceEndpointProbeResponse {
  ok: boolean
  results: VoiceEndpointProbeResult[]
}

export async function getVoiceSettings(): Promise<BaseResponse<VoiceSettings>> {
  return http.get<BaseResponse<VoiceSettings>>('/api/voice/') as unknown as Promise<BaseResponse<VoiceSettings>>
}

export async function updateVoiceSettings(request: UpdateVoiceSettingsRequest): Promise<BaseResponse<VoiceSettings>> {
  return http.put<BaseResponse<VoiceSettings>>('/api/voice/', request) as unknown as Promise<BaseResponse<VoiceSettings>>
}

export async function listVoiceModels(
  service: 'omni' | 'llm' | 'asr' | 'tts',
  baseUrl?: string,
  token?: string,
  llmSettingId?: string,
): Promise<BaseResponse<VoiceModelsResponse>> {
  return http.post<BaseResponse<VoiceModelsResponse>>('/api/voice/models', {
    service,
    llm_setting_id: llmSettingId || null,
    base_url: baseUrl,
    token,
  } satisfies VoiceModelsRequest) as unknown as Promise<BaseResponse<VoiceModelsResponse>>
}

export async function testVoiceConnection(
  service: 'omni' | 'llm' | 'asr' | 'tts',
  baseUrl?: string,
  token?: string,
  llmSettingId?: string,
): Promise<BaseResponse<VoiceModelsResponse>> {
  return http.post<BaseResponse<VoiceModelsResponse>>('/api/voice/test', {
    service,
    llm_setting_id: llmSettingId || null,
    base_url: baseUrl,
    token,
  } satisfies VoiceModelsRequest) as unknown as Promise<BaseResponse<VoiceModelsResponse>>
}

export async function testVoiceEndpoints(
  endpoints: VoiceEndpointProbeCandidate[],
): Promise<BaseResponse<VoiceEndpointProbeResponse>> {
  return http.post<BaseResponse<VoiceEndpointProbeResponse>>('/api/voice/endpoints/test', {
    endpoints,
  }) as unknown as Promise<BaseResponse<VoiceEndpointProbeResponse>>
}

export async function transcribeVoice(
  audioDataUrl: string,
  signal?: AbortSignal,
  mode?: 'omni' | 'asr',
): Promise<BaseResponse<{ text: string; raw?: unknown; mode?: 'omni' | 'asr' }>> {
  return http.post<BaseResponse<{ text: string; raw?: unknown; mode?: 'omni' | 'asr' }>>('/api/voice/transcribe', {
    audio_data_url: audioDataUrl,
    mode,
  }, { signal }) as unknown as Promise<BaseResponse<{ text: string; raw?: unknown; mode?: 'omni' | 'asr' }>>
}

export async function speechStream(text: string, voice?: string, stream = false, signal?: AbortSignal, speed?: number): Promise<Response> {
  const baseUrl = http.getBaseURL().replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/api/voice/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, stream, speed }),
    signal,
  })
  if (!response.ok) {
    const body = await response.text()
    try {
      const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
      const message = typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : body
      throw new Error(message)
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(body)
      throw err
    }
  }
  return response
}

export function createAsrRealtimeSocket(): WebSocket {
  const configured = http.getBaseURL().replace(/\/$/, '')
  const origin = configured || (typeof window !== 'undefined' ? window.location.origin : '')
  if (!origin) throw new Error('无法确定 ASR Realtime WebSocket 地址')
  const wsBase = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  return new WebSocket(`${wsBase}/api/voice/asr/realtime`)
}

export const voiceApi = {
  getVoiceSettings,
  updateVoiceSettings,
  listVoiceModels,
  testVoiceConnection,
  testVoiceEndpoints,
  transcribeVoice,
  speechStream,
  createAsrRealtimeSocket,
}

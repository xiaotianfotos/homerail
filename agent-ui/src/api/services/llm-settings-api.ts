/**
 * ============================================================================
 * LLM Settings API - LLM 模型配置 API服务
 * ============================================================================
 *
 * 提供模型配置相关的所有API调用
 * 模型配置 = Provider + Model Name + API Key
 */

import { http } from '../clients/http-client'
import type { BaseResponse } from '../types/common.types'

// ============================================================================
// 类型定义
// ============================================================================

export interface LLMSetting {
  id: string
  provider_id: string
  provider_name: string
  provider_source?: 'builtin' | 'custom'
  provider_readonly?: boolean
  provider_base_url?: string
  endpoint_id?: string
  endpoint_name?: string
  plan_type: 'api_billing' | 'token_plan' | 'coding_plan' | 'agent_plan' | 'subscription' | 'custom'
  protocol:
    | 'openai_compatible'
    | 'anthropic_compatible'
    | 'dashscope_native'
    | 'volcengine_doubao_voice'
    | 'volcengine_ark_voice'
    | 'volcengine_openspeech'
    | 'custom'
  auth_type?: 'bearer' | 'api-key' | 'x-api-key' | 'subscription-key' | 'custom'
  key_hint?: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  resource_id?: string
  voice_adapter?: string
  tts_http_url?: string
  tts_realtime_url?: string
  tts_bidirectional_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  tts_voice?: string
  tts_format?: string
  tts_sample_rate?: number
  model_name: string
  /** 该凭证（key）可用的模型列表（多模型凭证） */
  models?: string[]
  display_name: string
  api_key_display: string
  capabilities?: string[]
  supports_llm: boolean
  supports_asr: boolean
  supports_tts: boolean
  supports_audio_input: boolean
  supports_image_input: boolean
  supports_video_input: boolean
  is_active: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface LLMSettingsListResponse {
  settings: LLMSetting[]
  total: number
}

export interface CreateLLMSettingsRequest {
  provider_id: string
  model_name: string
  models?: string[]
  display_name?: string
  endpoint_id?: string
  endpoint_name?: string
  plan_type?: LLMSetting['plan_type']
  protocol?: LLMSetting['protocol']
  auth_type?: LLMSetting['auth_type']
  key_hint?: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  resource_id?: string
  voice_adapter?: string
  tts_http_url?: string
  tts_realtime_url?: string
  tts_bidirectional_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  tts_voice?: string
  tts_format?: string
  tts_sample_rate?: number
  api_key?: string
  reuse_existing_api_key?: boolean
  is_default?: boolean
  is_active?: boolean
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
}

export interface UpdateLLMSettingsRequest {
  model_name?: string
  models?: string[]
  display_name?: string
  endpoint_id?: string
  endpoint_name?: string
  plan_type?: LLMSetting['plan_type']
  protocol?: LLMSetting['protocol']
  auth_type?: LLMSetting['auth_type']
  key_hint?: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  resource_id?: string
  voice_adapter?: string
  tts_http_url?: string
  tts_realtime_url?: string
  tts_bidirectional_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  tts_voice?: string
  tts_format?: string
  tts_sample_rate?: number
  api_key?: string
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
  is_active?: boolean
  is_default?: boolean
}

// ============================================================================
// LLM Settings CRUD Operations
// ============================================================================

/**
 * 获取所有模型配置
 */
export async function listLLMSettings(
  providerId?: string
): Promise<BaseResponse<LLMSettingsListResponse>> {
  const url = providerId ? `/api/llm/settings?provider_id=${providerId}` : '/api/llm/settings'
  return http.get<BaseResponse<LLMSettingsListResponse>>(url) as unknown as Promise<
    BaseResponse<LLMSettingsListResponse>
  >
}

/**
 * 获取单个模型配置详情
 */
export async function getLLMSetting(settingId: string): Promise<BaseResponse<LLMSetting>> {
  return http.get<BaseResponse<LLMSetting>>(`/api/llm/settings/${settingId}`) as unknown as Promise<
    BaseResponse<LLMSetting>
  >
}

/**
 * 创建模型配置
 */
export async function createLLMSetting(
  data: CreateLLMSettingsRequest
): Promise<BaseResponse<LLMSetting>> {
  return http.post<BaseResponse<LLMSetting>>('/api/llm/settings', data) as unknown as Promise<
    BaseResponse<LLMSetting>
  >
}

/**
 * 更新模型配置
 */
export async function updateLLMSetting(
  settingId: string,
  data: UpdateLLMSettingsRequest
): Promise<BaseResponse<LLMSetting>> {
  return http.put<BaseResponse<LLMSetting>>(
    `/api/llm/settings/${settingId}`,
    data
  ) as unknown as Promise<BaseResponse<LLMSetting>>
}

/**
 * 删除模型配置
 */
export async function deleteLLMSetting(settingId: string): Promise<BaseResponse<{ id: string }>> {
  return http.delete<BaseResponse<{ id: string }>>(
    `/api/llm/settings/${settingId}`
  ) as unknown as Promise<BaseResponse<{ id: string }>>
}

// ============================================================================
// 导出 API 对象
// ============================================================================

export const llmSettingsApi = {
  listLLMSettings,
  getLLMSetting,
  createLLMSetting,
  updateLLMSetting,
  deleteLLMSetting
}

/**
 * ============================================================================
 * Agent Infrastructure Types — Prompt / Skill / Agent / Provider
 * ============================================================================
 *
 * 编排相关类型已移至 dag.types.ts 和 orchestration.types.ts
 */

import type { BaseResponse, SearchParams } from './common.types'

// ============================================================================
// Prompt Types
// ============================================================================

export interface Prompt {
  id: string
  name: string
  content: string
  created_at: string
  updated_at: string
}

export interface CreatePromptRequest {
  name: string
  content: string
}

export interface UpdatePromptRequest {
  name?: string
  content?: string
}

export interface PromptListParams extends SearchParams {}

export interface PromptListResponse {
  prompts: Prompt[]
  total: number
  limit: number
  offset: number
}

export type PromptResponse = BaseResponse<Prompt>
export type PromptsDataResponse = BaseResponse<PromptListResponse>

// ============================================================================
// Skill Types
// ============================================================================

export type UploadStatus = 'installing' | 'installed' | 'error'
export type SkillRuntimeStatus = 'installed' | 'runtime_available' | 'unavailable_with_reason'

export interface Skill {
  id: string
  name: string
  description: string
  package_file: string
  package_path: string
  upload_status: UploadStatus
  runtime_status?: SkillRuntimeStatus
  runtime_message?: string
  created_at: string
  updated_at: string
}

export interface UpdateSkillRequest {
  name?: string
  description?: string
}

export interface SkillListParams extends SearchParams {
  status?: UploadStatus
}

export interface SkillListResponse {
  skills: Skill[]
  total: number
  limit: number
  offset: number
}

export type SkillResponse = BaseResponse<Skill>
export type SkillsDataResponse = BaseResponse<SkillListResponse>

// ============================================================================
// Agent Types
// ============================================================================

export type AgentType = 'manager' | 'worker'

export interface Agent {
  id: string
  name: string
  type: AgentType
  prompt_id: string
  skill_ids: string[]
  llm_setting_id: string
  llm_model_name_override: string
  created_at: string
  updated_at: string
}

export interface AgentDetail {
  id: string
  name: string
  type: AgentType
  prompt: {
    id: string
    name: string
    content: string
  } | null
  skills: Array<{
    id: string
    name: string
    description: string
  }>
  llm_setting_id: string
  llm_model_name: string
  llm_model_name_override: string
  llm_setting: {
    id: string
    display_name: string
    provider_name: string
    model_name: string
  } | null
  provider: {
    id: string
    name: string
  } | null
  created_at: string
  updated_at: string
}

export interface CreateAgentRequest {
  name: string
  type: AgentType
  prompt_id: string
  skill_ids: string[]
  llm_setting_id: string
  llm_model_name_override?: string
}

export interface UpdateAgentRequest {
  name?: string
  type?: AgentType
  prompt_id?: string
  skill_ids?: string[]
  llm_setting_id?: string
  llm_model_name_override?: string
}

export interface ChangeModelRequest {
  llm_setting_id: string
  llm_model_name_override?: string
}

export interface AgentListParams extends SearchParams {
  type?: AgentType
}

export interface AgentListItem {
  id: string
  name: string
  type: AgentType
  prompt_id: string
  prompt_name: string
  skill_ids: string[]
  skill_count: number
  llm_setting_id: string
  llm_model_name: string
  llm_setting_name: string
  provider_name: string
  created_at: string
  updated_at: string
}

export interface AgentListResponse {
  agents: AgentListItem[]
  total: number
  limit: number
  offset: number
}

export type AgentResponse = BaseResponse<AgentDetail>
export type AgentsDataResponse = BaseResponse<AgentListResponse>

// ============================================================================
// Provider Types
// ============================================================================

export interface Provider {
  id: string
  name: string
  status?: 'active' | 'paused'
  default_model?: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  voice_adapter?: ProviderEndpointPreset['voice_adapter']
  tts_http_url?: string
  tts_realtime_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  docs_url?: string
  source?: 'builtin' | 'custom'
  readonly?: boolean
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
  endpoints?: ProviderEndpointPreset[]
  is_active?: boolean
  created_at?: string
  updated_at?: string
}

export type ProviderPlanType =
  | 'api_billing'
  | 'token_plan'
  | 'coding_plan'
  | 'agent_plan'
  | 'subscription'
  | 'custom'
export type ProviderProtocol =
  | 'openai_compatible'
  | 'anthropic_compatible'
  | 'dashscope_native'
  | 'volcengine_doubao_voice'
  | 'volcengine_ark_voice'
  | 'volcengine_openspeech'
  | 'custom'
export type ProviderAuthType = 'bearer' | 'api-key' | 'x-api-key' | 'subscription-key' | 'custom'

export interface ProviderModelPreset {
  id: string
  name?: string
  display_name?: string
  description?: string
  recommended?: boolean
  resource_id?: string
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
}

export interface ProviderEndpointPreset {
  id: string
  provider_id: string
  name: string
  plan_type: ProviderPlanType
  protocol: ProviderProtocol
  base_url: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  resource_id?: string
  voice_adapter?:
    | 'openai_audio'
    | 'mimo_audio'
    | 'volcengine_doubao_voice'
    | 'volcengine_ark_voice'
    | 'volcengine_openspeech'
    | 'custom'
  tts_http_url?: string
  tts_realtime_url?: string
  tts_bidirectional_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  tts_voice?: string
  tts_format?: string
  tts_sample_rate?: number
  region?: string
  region_label?: string
  auth_type: ProviderAuthType
  key_hint?: string
  key_prefix_hint?: string
  docs_url?: string
  default_model: string
  source?: 'builtin' | 'custom'
  readonly?: boolean
  models: ProviderModelPreset[]
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
}

export interface CreateProviderRequest {
  id: string
  name?: string
  default_model: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  voice_adapter?: ProviderEndpointPreset['voice_adapter']
  tts_http_url?: string
  tts_realtime_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  status?: 'active' | 'paused'
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
}

export interface UpdateProviderRequest {
  id?: string
  name?: string
  default_model?: string
  base_url?: string
  chat_completions_base_url?: string
  responses_base_url?: string
  anthropic_base_url?: string
  voice_adapter?: ProviderEndpointPreset['voice_adapter']
  tts_http_url?: string
  tts_realtime_url?: string
  asr_realtime_url?: string
  asr_async_url?: string
  status?: 'active' | 'paused'
  supports_llm?: boolean
  supports_asr?: boolean
  supports_tts?: boolean
  supports_audio_input?: boolean
  supports_image_input?: boolean
  supports_video_input?: boolean
}

export interface ProviderListResponse {
  providers: Provider[]
  total: number
}

export interface ProviderModelsResponse {
  provider_id: string
  provider_name: string
  models: string[]
}

export interface CommonModelsResponse {
  models: Record<string, string[]>
}

export type ProviderResponse = BaseResponse<Provider>
export type ProvidersDataResponse = BaseResponse<ProviderListResponse>
export type ProviderModelsDataResponse = BaseResponse<ProviderModelsResponse>
export type CommonModelsDataResponse = BaseResponse<CommonModelsResponse>

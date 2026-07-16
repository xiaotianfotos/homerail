/**
 * ============================================================================
 * Providers API - LLM 供应商 API服务
 * ============================================================================
 *
 * 提供供应商配置和模型发现相关的所有API调用
 */

import { http } from '../clients/http-client'
import type { BaseResponse } from '../types/common.types'
import type {
  Provider,
  ProviderListResponse,
  CreateProviderRequest,
  UpdateProviderRequest,
  ProviderModelsResponse,
  CommonModelsResponse
} from '../types/orchestration-v2.types'

// ============================================================================
// Providers CRUD Operations
// ============================================================================

/**
 * 获取所有供应商
 */
export async function listProviders(): Promise<BaseResponse<ProviderListResponse>> {
  return http.get<ProviderListResponse>('/api/llm/providers') as Promise<
    BaseResponse<ProviderListResponse>
  >
}

/**
 * 获取单个供应商详情
 */
export async function getProvider(providerId: string): Promise<BaseResponse<Provider>> {
  return http.get<Provider>(`/api/llm/providers/${providerId}`) as Promise<BaseResponse<Provider>>
}

/**
 * 新增供应商
 */
export async function createProvider(data: CreateProviderRequest): Promise<BaseResponse<Provider>> {
  return http.post<Provider>('/api/llm/providers', data) as Promise<BaseResponse<Provider>>
}

/**
 * 更新供应商
 */
export async function updateProvider(
  providerId: string,
  data: UpdateProviderRequest
): Promise<BaseResponse<Provider>> {
  return http.put<Provider>(`/api/llm/providers/${providerId}`, data) as Promise<
    BaseResponse<Provider>
  >
}

/**
 * 删除供应商
 */
export async function deleteProvider(
  providerId: string,
  options: { cascade?: boolean } = {}
): Promise<BaseResponse<{ id: string; cascade: boolean }>> {
  const query = options.cascade ? '?cascade=true' : ''
  return http.delete<{ id: string; cascade: boolean }>(
    `/api/llm/providers/${providerId}${query}`
  ) as Promise<BaseResponse<{ id: string; cascade: boolean }>>
}

// ============================================================================
// Model Discovery
// ============================================================================

/**
 * 获取供应商的可用模型列表（从 catalog 预设）
 */
export async function getProviderModels(
  providerId: string
): Promise<BaseResponse<ProviderModelsResponse>> {
  return http.get<ProviderModelsResponse>(`/api/llm/providers/${providerId}/models`) as Promise<
    BaseResponse<ProviderModelsResponse>
  >
}

/**
 * 动态探测供应商可用模型（后端代理调 /v1/models）
 * 已保存凭证只发送 settingId；新凭证发送 baseUrl + apiKey。
 */
export type ProbeModelsInput =
  | { settingId: string; baseUrl?: never; apiKey?: never }
  | { settingId?: never; baseUrl: string; apiKey: string }

export async function probeModels(
  input: ProbeModelsInput
): Promise<{ models: string[]; error?: string }> {
  const body = input.settingId
    ? { setting_id: input.settingId }
    : { base_url: input.baseUrl, api_key: input.apiKey }
  const res = await http.post<any>('/api/llm/models/probe', body)
  const data = res.data ?? res
  return {
    models: Array.isArray(data?.models) ? data.models : [],
    error: typeof data?.error === 'string' ? data.error : undefined
  }
}

/**
 * 获取常见供应商的常用模型列表（静态 fallback）
 */
export async function getCommonModels(): Promise<BaseResponse<CommonModelsResponse>> {
  return http.get<CommonModelsResponse>('/api/llm/models/common') as Promise<
    BaseResponse<CommonModelsResponse>
  >
}

// Export API object
export const providersApi = {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  getProviderModels,
  getCommonModels
}

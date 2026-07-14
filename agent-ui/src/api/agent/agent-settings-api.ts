/**
 * ============================================================================
 * Agent Settings API - Agent 设置 Facade
 * ============================================================================
 *
 * 封装 project-api 中与 Agent 设置页面相关的调用，
 * 包括项目列表、项目更新、存储配置、语音设置和语音代理配置。
 *
 * Agent UI 组件应通过本模块而非直接引用 project-api / voice-api。
 */

import { http } from '../clients/http-client'
import type { BaseResponse } from '../types/common.types'
import type {
  CreateProjectRequest,
  ProjectDirectoryBrowseResponse,
  ProjectDirectoryRootsResponse,
  ProjectListParams,
  ProjectListResponse,
  ProjectResponse,
  ProjectStorageListResponse,
  UpdateProjectRequest
} from '../types/project.types'
import type { NodeListResponse } from '../types/node.types'
import type {
  GitRepositoryInfo,
  GitServer,
  GitServerCreateRequest,
  GitUserInfo
} from '../types/infrastructure.types'
import type {
  ProviderListResponse,
  Skill,
  SkillListParams,
  SkillListResponse
} from '../types/orchestration-v2.types'
import type { AgentProject, AgentProjectListParams, AgentStorageInfo } from './agent.types'
import {
  asAgentRecord,
  getAgentArray,
  getAgentDataPayload,
  getAgentString,
  normalizeProject
} from './agent.types'
import {
  getVoiceSettings as _getVoiceSettings,
  updateVoiceSettings as _updateVoiceSettings,
  listVoiceModels as _listVoiceModels,
  testVoiceConnection as _testVoiceConnection,
  type VoiceSettings,
  type UpdateVoiceSettingsRequest,
  type VoiceTtsOutputChannel
} from '../services/voice-api'
import { getExperienceGraphSummary as _getExperienceGraphSummary } from '../services/experience-api'
import type { ExperienceGraphSummary } from '../types/experience.types'
import {
  getAssetDiagnostics as _getAssetDiagnostics,
  getOrchestrationTemplates as _getOrchestrationTemplates,
  type AssetDiagnostics,
  type OrchestrationTemplate
} from '../services/asset-diagnostics-api'
import {
  getVoiceAgentConfig as _getVoiceAgentConfig,
  updateVoiceAgentConfig as _updateVoiceAgentConfig,
  type VoiceAgentConfig,
  type UpdateVoiceAgentConfigRequest
} from './agent-voice-api'
import {
  listMemories as _listMemories,
  getMemoryStats as _getMemoryStats,
  createMemory as _createMemory,
  deleteMemory as _deleteMemory
} from '../services/memory-api'
import {
  listLLMSettings as _listLLMSettings,
  createLLMSetting as _createLLMSetting,
  updateLLMSetting as _updateLLMSetting,
  deleteLLMSetting as _deleteLLMSetting,
  type LLMSetting,
  type CreateLLMSettingsRequest,
  type UpdateLLMSettingsRequest
} from '../services/llm-settings-api'
import {
  listProviders as _listProviders,
  createProvider as _createProvider,
  updateProvider as _updateProvider,
  deleteProvider as _deleteProvider
} from '../services/providers-api'
import {
  listGitServers as _listGitServers,
  createGitServer as _createGitServer,
  deleteGitServer as _deleteGitServer,
  verifyGitServer as _verifyGitServer,
  listGitServerRepos as _listGitServerRepos
} from '../services/git-credentials-api'
import {
  listMCPServers as _listMCPServers,
  addMCPServer as _addMCPServer,
  updateMCPServer as _updateMCPServer,
  refreshMCPServerRuntime as _refreshMCPServerRuntime,
  deleteMCPServer as _deleteMCPServer,
  type MCPServer,
  type MCPServerType,
  type AddMCPServerRequest,
  type UpdateMCPServerRequest
} from '../services/mcp-api'

export type { LLMSetting, CreateLLMSettingsRequest, UpdateLLMSettingsRequest }
export type { GitServer, GitServerCreateRequest }
export type { MCPServer, MCPServerType, AddMCPServerRequest, UpdateMCPServerRequest }
export type {
  VoiceSettings,
  VoiceTtsOutputChannel,
  ExperienceGraphSummary,
  AssetDiagnostics,
  OrchestrationTemplate
}

export interface GitServerListResponse {
  success: boolean
  message?: string
  data: { servers: GitServer[] }
}

export interface GitServerDetailResponse {
  success: boolean
  message?: string
  data: GitServer
}

export interface GitServerReposResponse {
  success: boolean
  message?: string
  data: {
    repositories: GitRepositoryInfo[]
    page: number
    per_page: number
  }
}

export interface GitVerifyResponse {
  success: boolean
  message?: string
  data: {
    valid: boolean
    user_info?: GitUserInfo
    scopes?: string[]
    token_type?: string
  }
}

export interface AgentStorageRetentionInfo {
  data_root: string
  runs_count: number
  sessions_dir: string
  retention_supported: boolean
  cleanup_supported: boolean
  cleanup_tracked_gap: boolean
  cleanup_next_action: string
  workspace_retention: WorkspaceRetentionSettings
  export_supported: boolean
  export_tracked_gap: boolean
  export_next_action: string
}

export interface WorkspaceRetentionSettings {
  enabled: boolean
  success_days: number
  failure_days: number
}

export interface WorkspaceCleanupReport {
  dry_run: boolean
  scanned: number
  eligible: number
  removed: number
  skipped: number
  failed: number
}

export interface AgentRuntimeStatus {
  connected_nodes: number
  connected_workers: number
  active_runs: number
  node_ids: string[]
  node_capabilities: Record<string, string[]>
  worker_ids: string[]
}

export interface AgentWorkspaceSettings {
  workspace_path: string | null
  homerail_home: string | null
  active_runs: number
  directory_import_supported: boolean
  directory_import_tracked_gap: boolean
  directory_import_next_action: string
  directory_import_issue: string
}

export interface VoiceUiRulesAsset {
  path: string
  exists: boolean
  content: string
  template: string
  updated_at?: string | null
  effective_hash: string
  effective_sources: string[]
}

export interface UpdateVoiceUiRulesAssetRequest {
  content?: string
  reset_to_template?: boolean
}

/**
 * ============================================================================
 * Raw re-exports for backward-compatible migration
 * ============================================================================
 *
 * Components importing directly from legacy service modules should migrate to
 * these wrappers via @/api/agent. They intentionally use only the shared HTTP
 * client and public type files, keeping Agent Shell production type-check
 * detached from the old Admin Console service surface.
 */
export async function listProjects(params?: ProjectListParams): Promise<ProjectListResponse> {
  const queryParams = new URLSearchParams()
  if (params?.search) queryParams.append('search', params.search)
  if (params?.limit !== undefined) queryParams.append('limit', String(params.limit))
  if (params?.offset !== undefined) queryParams.append('offset', String(params.offset))
  const queryString = queryParams.toString()
  return http.get<ProjectListResponse['data']>(
    `/api/projects${queryString ? `?${queryString}` : ''}`
  ) as Promise<ProjectListResponse>
}

export async function createProject(data: CreateProjectRequest): Promise<ProjectResponse> {
  return http.post<ProjectResponse['data']>('/api/projects', data) as Promise<ProjectResponse>
}

export async function updateProject(
  projectId: string,
  data: UpdateProjectRequest
): Promise<ProjectResponse> {
  return http.put<ProjectResponse['data']>(
    `/api/projects/${encodeURIComponent(projectId)}`,
    data
  ) as Promise<ProjectResponse>
}

export async function deleteProject(
  projectId: string
): Promise<BaseResponse<{ id: string; summary?: Record<string, unknown> | null }>> {
  return http.delete<{ id: string; summary?: Record<string, unknown> | null }>(
    `/api/projects/${encodeURIComponent(projectId)}`
  ) as Promise<BaseResponse<{ id: string; summary?: Record<string, unknown> | null }>>
}

export async function listProjectStorages(projectId: string): Promise<ProjectStorageListResponse> {
  return http.get<ProjectStorageListResponse['data']>(
    `/api/projects/${encodeURIComponent(projectId)}/storages`
  ) as Promise<ProjectStorageListResponse>
}

export async function listProjectDirectoryRoots(): Promise<ProjectDirectoryRootsResponse> {
  return http.get<ProjectDirectoryRootsResponse['data']>(
    '/api/projects/directories/roots'
  ) as Promise<ProjectDirectoryRootsResponse>
}

export async function browseProjectDirectories(params: {
  path?: string
  server_id?: string
  show_hidden?: boolean
  limit?: number
}): Promise<ProjectDirectoryBrowseResponse> {
  const queryParams = new URLSearchParams()
  if (params.path) queryParams.append('path', params.path)
  if (params.server_id) queryParams.append('server_id', params.server_id)
  if (params.show_hidden !== undefined)
    queryParams.append('show_hidden', String(params.show_hidden))
  if (params.limit !== undefined) queryParams.append('limit', String(params.limit))
  const queryString = queryParams.toString()
  return http.get<ProjectDirectoryBrowseResponse['data']>(
    `/api/projects/directories/browse${queryString ? `?${queryString}` : ''}`
  ) as Promise<ProjectDirectoryBrowseResponse>
}

export async function listNodes(): Promise<NodeListResponse> {
  return http.get<NodeListResponse['data']>('/api/nodes') as Promise<NodeListResponse>
}

export async function listGitServers(activeOnly = true): Promise<GitServerListResponse> {
  return _listGitServers(activeOnly)
}

export async function createGitServer(
  data: GitServerCreateRequest
): Promise<GitServerDetailResponse> {
  return _createGitServer(data)
}

export async function deleteGitServer(
  serverId: string,
  force = false
): Promise<BaseResponse<{ server_id: string }>> {
  return _deleteGitServer(serverId, force)
}

export async function verifyGitServer(serverId: string): Promise<GitVerifyResponse> {
  return _verifyGitServer(serverId)
}

export async function listGitServerRepos(
  serverId: string,
  page = 1,
  perPage = 30
): Promise<GitServerReposResponse> {
  return _listGitServerRepos(serverId, page, perPage)
}

export async function listSkills(
  params?: SkillListParams
): Promise<BaseResponse<SkillListResponse>> {
  const queryParams = new URLSearchParams()
  if (params?.search) queryParams.append('search', params.search)
  if (params?.status) queryParams.append('status', params.status)
  if (params?.limit !== undefined) queryParams.append('limit', String(params.limit))
  if (params?.offset !== undefined) queryParams.append('offset', String(params.offset))
  const queryString = queryParams.toString()
  return http.get<SkillListResponse>(
    `/api/skills${queryString ? `?${queryString}` : ''}`
  ) as Promise<BaseResponse<SkillListResponse>>
}

export async function listProviders(): Promise<BaseResponse<ProviderListResponse>> {
  return _listProviders()
}

export async function uploadSkill(
  file: File,
  name?: string,
  description?: string
): Promise<BaseResponse<Skill>> {
  const formData = new FormData()
  formData.append('file', file)
  if (name) formData.append('name', name)
  if (description) formData.append('description', description)
  return http.post<Skill>('/api/skills', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }) as Promise<BaseResponse<Skill>>
}

export async function deleteSkill(skillId: string): Promise<BaseResponse<{ id: string }>> {
  return http.delete<{ id: string }>(`/api/skills/${encodeURIComponent(skillId)}`) as Promise<
    BaseResponse<{ id: string }>
  >
}

export async function listVoiceModels(
  service: 'omni' | 'llm' | 'asr' | 'tts',
  baseUrl?: string,
  token?: string,
  llmSettingId?: string
) {
  return _listVoiceModels(service, baseUrl, token, llmSettingId)
}

export async function testVoiceConnection(
  service: 'omni' | 'llm' | 'asr' | 'tts',
  baseUrl?: string,
  token?: string,
  llmSettingId?: string
) {
  return _testVoiceConnection(service, baseUrl, token, llmSettingId)
}

export async function getExperienceGraphSummary(limit = 12) {
  return _getExperienceGraphSummary(limit)
}

export async function getAssetDiagnostics() {
  return _getAssetDiagnostics()
}

export async function getOrchestrationTemplates(all = false) {
  return _getOrchestrationTemplates(all)
}

export async function getVoiceUiRulesAsset(
  createTemplate = false
): Promise<BaseResponse<VoiceUiRulesAsset>> {
  return http.get<VoiceUiRulesAsset>('/api/voice-agent/ui-rules', {
    params: { create: createTemplate ? '1' : undefined }
  }) as Promise<BaseResponse<VoiceUiRulesAsset>>
}

export async function updateVoiceUiRulesAsset(
  request: UpdateVoiceUiRulesAssetRequest
): Promise<BaseResponse<VoiceUiRulesAsset>> {
  return http.put<VoiceUiRulesAsset>('/api/voice-agent/ui-rules', request) as Promise<
    BaseResponse<VoiceUiRulesAsset>
  >
}
export { listMemories, getMemoryStats, createMemory, deleteMemory } from '../services/memory-api'

/**
 * Agent Settings API facade
 */
export const agentSettingsApi = {
  getApiBaseUrl(): string {
    return http.getBaseURL()
  },

  async getRuntimeStatus(): Promise<AgentRuntimeStatus> {
    const res = await http.get<AgentRuntimeStatus>('/api/runtime/status')
    return res.data
  },

  async getWorkspaceSettings(): Promise<AgentWorkspaceSettings> {
    const res = await http.get<AgentWorkspaceSettings>('/api/settings/workspace')
    return res.data
  },

  async listNodes() {
    return listNodes()
  },

  /**
   * 列出项目
   * 委托给 project-api.listProjects
   */
  async listProjects(params?: AgentProjectListParams): Promise<AgentProject[]> {
    const raw = await listProjects(params)
    const data = asAgentRecord(getAgentDataPayload(raw))
    return getAgentArray(data.projects).map(project => normalizeProject(project))
  },

  /**
   * 更新项目
   * 委托给 project-api.updateProject
   */
  async updateProject(projectId: string, data: Partial<AgentProject>): Promise<AgentProject> {
    const raw = await updateProject(projectId, {
      name: data.name,
      description: data.description
    })
    return normalizeProject(getAgentDataPayload(raw))
  },

  /**
   * 列出项目的存储配置
   * 委托给 project-api.listProjectStorages
   */
  async listStorages(projectId: string): Promise<AgentStorageInfo[]> {
    const raw = await listProjectStorages(projectId)
    const data = asAgentRecord(getAgentDataPayload(raw))
    return getAgentArray(data.storages).map(storage => {
      const record = asAgentRecord(storage)
      return {
        id: getAgentString(record.id),
        name: getAgentString(record.name),
        type: getAgentString(record.storage_type)
      }
    })
  },

  /**
   * 获取语音设置
   * 委托给 voice-api.getVoiceSettings
   */
  async getVoiceSettings() {
    return _getVoiceSettings()
  },

  /**
   * 更新语音设置
   * 委托给 voice-api.updateVoiceSettings
   */
  async updateVoiceSettings(request: UpdateVoiceSettingsRequest) {
    return _updateVoiceSettings(request)
  },

  async listVoiceModels(
    service: 'omni' | 'llm' | 'asr' | 'tts',
    baseUrl?: string,
    token?: string,
    llmSettingId?: string
  ) {
    return listVoiceModels(service, baseUrl, token, llmSettingId)
  },

  async testVoiceConnection(
    service: 'omni' | 'llm' | 'asr' | 'tts',
    baseUrl?: string,
    token?: string,
    llmSettingId?: string
  ) {
    return testVoiceConnection(service, baseUrl, token, llmSettingId)
  },

  /**
   * 获取语音代理配置
   * 委托给 agent-voice-api.getVoiceAgentConfig
   */
  async getVoiceAgentConfig() {
    return _getVoiceAgentConfig()
  },

  /**
   * 更新语音代理配置
   * 委托给 agent-voice-api.updateVoiceAgentConfig
   */
  async updateVoiceAgentConfig(request: UpdateVoiceAgentConfigRequest) {
    return _updateVoiceAgentConfig(request)
  },

  /**
   * 列出所有供应商（只读）
   * 委托给 providers-api.listProviders
   */
  async listProviders() {
    return listProviders()
  },

  async createProvider(data: import('../types/orchestration-v2.types').CreateProviderRequest) {
    return _createProvider(data)
  },

  async updateProvider(
    providerId: string,
    data: import('../types/orchestration-v2.types').UpdateProviderRequest
  ) {
    return _updateProvider(providerId, data)
  },

  async deleteProvider(providerId: string, options: { cascade?: boolean } = {}) {
    return _deleteProvider(providerId, options)
  },

  /**
   * 列出模型配置
   * 委托给 llm-settings-api.listLLMSettings
   */
  async listLLMSettings(providerId?: string) {
    return _listLLMSettings(providerId)
  },

  /**
   * 创建模型配置
   * 委托给 llm-settings-api.createLLMSetting
   */
  async createLLMSetting(data: CreateLLMSettingsRequest) {
    return _createLLMSetting(data)
  },

  /**
   * 更新模型配置
   * 委托给 llm-settings-api.updateLLMSetting
   */
  async updateLLMSetting(id: string, data: UpdateLLMSettingsRequest) {
    return _updateLLMSetting(id, data)
  },

  /**
   * 删除模型配置
   * 委托给 llm-settings-api.deleteLLMSetting
   */
  async deleteLLMSetting(id: string) {
    return _deleteLLMSetting(id)
  },

  /**
   * 列出Git Server配置
   * 委托给 git-credentials-api.listGitServers
   */
  async listGitServers(activeOnly?: boolean) {
    return listGitServers(activeOnly)
  },

  /**
   * 创建Git Server配置
   * 委托给 git-credentials-api.createGitServer
   */
  async createGitServer(data: GitServerCreateRequest) {
    return createGitServer(data)
  },

  /**
   * 删除Git Server配置
   * 委托给 git-credentials-api.deleteGitServer
   */
  async deleteGitServer(serverId: string, force?: boolean) {
    return deleteGitServer(serverId, force)
  },

  /**
   * 验证Git Server Token
   * 委托给 git-credentials-api.verifyGitServer
   */
  async verifyGitServer(serverId: string) {
    return verifyGitServer(serverId)
  },

  /**
   * 列出MCP Server配置
   * 委托给 mcp-api.listMCPServers
   */
  async listMCPServers() {
    return _listMCPServers()
  },

  /**
   * 添加MCP Server配置
   * 委托给 mcp-api.addMCPServer
   */
  async addMCPServer(request: AddMCPServerRequest) {
    return _addMCPServer(request)
  },

  /**
   * 更新MCP Server配置
   * 委托给 mcp-api.updateMCPServer
   */
  async updateMCPServer(request: UpdateMCPServerRequest) {
    return _updateMCPServer(request)
  },

  /**
   * 刷新 MCP Server runtime 可用性
   * 委托给 mcp-api.refreshMCPServerRuntime
   */
  async refreshMCPServerRuntime(id: string) {
    return _refreshMCPServerRuntime(id)
  },

  /**
   * 删除MCP Server配置
   * 委托给 mcp-api.deleteMCPServer
   */
  async deleteMCPServer(id: string) {
    return _deleteMCPServer(id)
  },

  /**
   * 获取存储与保留信息
   * 调用 GET /api/settings/storage-info
   */
  async getStorageInfo(): Promise<AgentStorageRetentionInfo> {
    const res = await http.get<AgentStorageRetentionInfo>('/api/settings/storage-info')
    return res.data
  },

  async updateWorkspaceRetention(
    settings: WorkspaceRetentionSettings,
  ): Promise<WorkspaceRetentionSettings> {
    const res = await http.post<WorkspaceRetentionSettings>(
      '/api/settings/workspace-retention',
      settings,
    )
    return res.data
  },

  async cleanupRunWorkspaces(dryRun = true): Promise<WorkspaceCleanupReport> {
    const res = await http.post<WorkspaceCleanupReport>(
      '/api/dag/workspaces/cleanup',
      { dry_run: dryRun },
      { timeout: 0 },
    )
    return res.data
  },

  async getExperienceGraphSummary(limit = 12) {
    return getExperienceGraphSummary(limit)
  },

  async getAssetDiagnostics() {
    return getAssetDiagnostics()
  },

  async getOrchestrationTemplates(all = false) {
    return getOrchestrationTemplates(all)
  },

  async getVoiceUiRulesAsset(createTemplate = false) {
    return getVoiceUiRulesAsset(createTemplate)
  },

  async updateVoiceUiRulesAsset(request: UpdateVoiceUiRulesAssetRequest) {
    return updateVoiceUiRulesAsset(request)
  },

  /**
   * 列出记忆
   * 委托给 memory-api.listMemories
   */
  async listMemories(params?: Parameters<typeof _listMemories>[0]) {
    return _listMemories(params)
  },

  /**
   * 获取记忆统计
   * 委托给 memory-api.getMemoryStats
   */
  async getMemoryStats(userId?: string) {
    return _getMemoryStats(userId)
  },

  /**
   * 创建记忆
   * 委托给 memory-api.createMemory
   */
  async createMemory(params: Parameters<typeof _createMemory>[0]) {
    return _createMemory(params)
  },

  /**
   * 删除记忆
   * 委托给 memory-api.deleteMemory
   */
  async deleteMemory(memoryId: number, userId?: string) {
    return _deleteMemory(memoryId, userId)
  }
}

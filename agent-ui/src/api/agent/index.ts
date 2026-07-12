/**
 * ============================================================================
 * Agent API Barrel - Agent Facade 统一导出
 * ============================================================================
 *
 * Agent UI 组件统一从此模块导入，不直接引用底层 API services。
 *
 * 允许的导入路径：
 *   @/api/agent                  — 所有 facade、类型、raw re-export
 *   @/api/agent/*.types          — 类型（type-only import）
 *   @/services/agent             — Agent 专属 services
 *   @/stores/agent               — Agent 专属 stores
 *
 * 禁止的导入路径（Agent 组件不得直接引用）：
 *   @/api/services/run-api
 *   @/api/services/project-api
 *   @/api/services/change-api
 *   @/stores/project, @/stores/change, @/stores/run
 *
 * 使用示例：
 * import { agentRuntimeApi, agentSessionApi } from '@/api/agent'
 * import type { AgentProject, AgentChatRequest } from '@/api/agent'
 */

export { agentRuntimeApi } from './agent-runtime-api'
export { agentSessionApi } from './agent-session-api'
export { agentSettingsApi } from './agent-settings-api'
export { agentEvidenceApi } from './agent-evidence-api'
export type {
  AgentRuntimeStatus,
  AgentWorkspaceSettings,
  AgentStorageRetentionInfo,
  WorkspaceRetentionSettings,
  WorkspaceCleanupReport,
  VoiceUiRulesAsset,
  VoiceSettings,
  VoiceTtsOutputChannel,
  ExperienceGraphSummary,
  AssetDiagnostics,
  OrchestrationTemplate,
  LLMSetting,
  GitServer,
  GitServerCreateRequest,
  MCPServer,
  MCPServerType,
  AddMCPServerRequest,
  UpdateMCPServerRequest,
} from './agent-settings-api'
export type * from './agent.types'
export {
  normalizeProject,
  normalizeSession,
  normalizeChatMessage,
  normalizeNativeTextTurn,
  normalizeRunSummary,
  normalizeChangeEvidence,
} from './agent.types'
export {
  createVoiceModeSession,
  submitVoiceTextTurn,
  runVoiceTextTurn,
} from './agent-voice-bridge'
export * from './agent-voice-api'

// ---------------------------------------------------------------------------
// Raw re-exports — backward-compatible passthrough for legacy call signatures
// ---------------------------------------------------------------------------

// from run-api
export { managerChat, invokeManagerAgent, getRunAuditSummary, getManagerAgentConfig, updateManagerAgentConfig } from './agent-runtime-api'
export {
  listManagerSessions,
  getManagerSession,
  getManagerSessionMessages,
  closeManagerSession,
  deleteManagerSession,
} from './agent-session-api'

// from project-api
export {
  listProjects,
  listProjectStorages,
  updateProject,
  deleteProject,
  createProject,
  browseProjectDirectories,
  listProjectDirectoryRoots,
  listNodes,
  listGitServers,
  listGitServerRepos,
  listProviders,
  verifyGitServer,
  listSkills,
  uploadSkill,
  deleteSkill,
  listVoiceModels,
  testVoiceConnection,
  getExperienceGraphSummary,
  getAssetDiagnostics,
  getOrchestrationTemplates,
} from './agent-settings-api'

// from change-api / run-api
export { getChange, getRun } from './agent-evidence-api'

// from memory-api
export {
  listMemories,
  getMemoryStats,
  createMemory,
  deleteMemory,
} from './agent-settings-api'

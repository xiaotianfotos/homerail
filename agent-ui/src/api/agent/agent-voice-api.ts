/**
 * ============================================================================
 * Agent Voice API Facade — Re-exports from legacy voice-agent-api
 * ============================================================================
 *
 * Source Issue: #934
 *
 * Agent UI components import voice types and functions from this facade
 * instead of the low-level @/api/services/voice-agent-api module.
 * All symbols are re-exported; no duplication, no new logic.
 */

export type {
  VoiceWidgetType,
  VoicePriority,
  VoiceWidget,
  VoiceTaskDraft,
  VoiceConversationMessage,
  VoiceDebugEvent,
  VoiceUiEvent,
  VoiceWorkspace,
  VoiceSessionItem,
  VoiceManagerStatus,
  ManagerAgentConfig,
  UpdateManagerAgentConfigRequest,
  ManagerAgentReadiness,
  CodexModel,
  CodexModelCatalog,
  CodexReasoningEffortOption,
  CodexModelServiceTier,
  VoiceAgentConfig,
  UpdateVoiceAgentConfigRequest,
  VoiceTtsOutputChannel,
  VoiceSpeechEvent,
  VoiceTurnResponse,
  VoiceConfirmResponse,
  VoiceStreamEvent,
  VoiceManagerStatusResponse,
} from '@/api/services/voice-agent-api'

export {
  createVoiceSession,
  listVoiceSessions,
  getVoiceSession,
  refreshVoiceManagerStatus,
  closeVoiceSession,
  getCurrentVoiceSession,
  setCurrentVoiceSession,
  stopVoiceMonitor,
  getManagerAgentReadiness,
  getCodexModels,
  getVoiceAgentConfig,
  updateVoiceAgentConfig,
  sendVoiceTurn,
  streamVoiceTurn,
  confirmVoiceTask,
  streamConfirmVoiceTask,
  notifyVoiceSession,
} from '@/api/services/voice-agent-api'

import { http } from '@/api/clients/http-client'
import type { BaseResponse } from '@/api/types/common.types'
import type {
  ManagerAgentHarness,
  ManagerAgentReasoningEffort,
} from 'homerail-protocol'
import type { GenerativeUiStreamEventV1 } from '@/generative-ui/types'

const NO_HTTP_TIMEOUT = 0

export type VoiceWidgetType =
  | 'task_draft'
  | 'status'
  | 'list'
  | 'progress'
  | 'note'
  | 'artifact'
  | 'html'
  | 'metric_strip'
  | 'timeline'
  | 'dag_flow'
  | 'chart'
  | 'memory_refs'
  | 'confirmation'
  | 'notification'
  | 'xiaohongshu_note'
  | 'topic_outline'
  | 'slide_deck'
export type VoicePriority = 'low' | 'normal' | 'high'

export interface VoiceWidget {
  id: string
  type: VoiceWidgetType
  title: string
  body: string
  priority: VoicePriority
  status?: string | null
  items: string[]
  steps: string[]
  active_step?: number | null
  data: Record<string, unknown>
}

export interface VoiceTaskDraft {
  title: string
  request: string
  acceptance: string[]
  constraints: string[]
  status: 'draft' | 'clarifying' | 'needs_confirmation' | 'submitted'
}

export interface VoiceConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  spoken_text?: string
  created_at: string
  channel?: 'final' | 'commentary'
  kind?: 'message' | 'error'
}

export interface VoiceDebugEvent {
  id: string
  level: 'debug' | 'info' | 'warning' | 'error'
  code: string
  message: string
  created_at: string
}

export interface VoiceUiEvent {
  id: string
  session_id: string
  voice_message_id?: string | null
  sequence: number
  event_type: 'upsert_widget' | 'remove_widgets' | 'widget_snapshot' | string
  widget_id?: string | null
  widget_type?: VoiceWidgetType | string | null
  payload: Record<string, unknown>
  created_at?: string | null
}

export interface VoiceWorkspace {
  session_id: string
  mode: 'voice'
  project_id?: string | null
  project_workspace_path?: string | null
  voice_assets_dir?: string | null
  manager_session_id?: string | null
  manager_run_id?: string | null
  orchestrator_session_id?: string | null
  source_issue_number?: number | null
  source_issue_url?: string | null
  source_issue_title?: string | null
  session_title?: string | null
  session_slate: string
  active_objective?: string | null
  task_draft?: VoiceTaskDraft | null
  pending_confirmations: Array<{ id: string; kind: 'submit_task' | 'memory_write'; summary: string }>
  memory_refs: Array<{ id: string; title: string; summary: string; source: string }>
  conversation: VoiceConversationMessage[]
  debug_events: VoiceDebugEvent[]
  progress_brief: { status: string; short_text: string; updated_at: string }
  widgets: VoiceWidget[]
  ui_events: VoiceUiEvent[]
  generative_ui_mode?: 'off' | 'shadow' | 'prefer'
  codex_monitor_status?: 'idle' | 'running' | 'done' | 'failed'
  codex_monitor_run_id?: string | null
  created_at: string
  updated_at: string
}

export interface VoiceSessionItem {
  session_id: string
  project_id?: string | null
  status: string
  title?: string | null
  prompt?: string | null
  start_time?: string | null
  end_time?: string | null
  message_count: number
  run_ids: string[]
  duration_seconds?: number | null
}

export interface VoiceManagerStatus {
  manager_session_id?: string | null
  manager_run_id?: string | null
  manager_status: string
  run?: Record<string, unknown> | null
  dag?: Record<string, unknown> | null
}

export interface ManagerAgentConfig {
  agent_type: 'manager_agent'
  harness: ManagerAgentHarness
  llm_setting_id?: string | null
  provider_name?: string | null
  model_name?: string | null
  reasoning_effort?: ManagerAgentReasoningEffort
  service_tier?: string | null
  system_prompt: string
  session_policy: Record<string, unknown>
}

export type VoiceAgentConfig = ManagerAgentConfig

export interface UpdateManagerAgentConfigRequest {
  harness?: ManagerAgentHarness
  llm_setting_id?: string | null
  provider_name?: string | null
  model_name?: string | null
  reasoning_effort?: ManagerAgentReasoningEffort
  service_tier?: string | null
  system_prompt?: string
  session_policy?: Record<string, unknown>
}

export type UpdateVoiceAgentConfigRequest = UpdateManagerAgentConfigRequest

export type VoiceTtsOutputChannel = 'final' | 'commentary'

export interface VoiceSpeechEvent {
  id: string
  channel: VoiceTtsOutputChannel
  text: string
}

export interface VoiceManagerResult {
  [key: string]: unknown
  text?: string
  run_id?: string | null
  run_ids?: string[]
  session_id?: string | null
  issue?: Record<string, unknown>
  orchestrator?: Record<string, unknown>
  manager_provider_name?: string
  manager_model_name?: string
}

export interface VoiceTurnResponse {
  workspace: VoiceWorkspace
  spoken_text: string
  voice_events?: VoiceSpeechEvent[]
  suggested_action?: 'confirm' | null
  manager?: VoiceManagerResult
  manager_status?: VoiceManagerStatus
}

export interface VoiceConfirmResponse {
  workspace: VoiceWorkspace
  manager: VoiceManagerResult
  manager_status?: VoiceManagerStatus
  spoken_text: string
  voice_events?: VoiceSpeechEvent[]
}

export type VoiceStreamEvent =
  | { type: 'workspace'; workspace: VoiceWorkspace }
  | { type: 'speech'; event: VoiceSpeechEvent; workspace?: VoiceWorkspace }
  | { type: 'done'; workspace: VoiceWorkspace; spoken_text?: string; voice_events?: VoiceSpeechEvent[]; suggested_action?: 'confirm' | null; manager?: VoiceManagerResult; manager_status?: VoiceManagerStatus }
  | { type: 'error'; message: string; workspace?: VoiceWorkspace }
  | GenerativeUiStreamEventV1
  | { type: string; [key: string]: unknown }

export interface VoiceManagerStatusResponse {
  workspace: VoiceWorkspace
  manager_status: VoiceManagerStatus
}

export async function createVoiceSession(projectId?: string | null): Promise<BaseResponse<VoiceWorkspace>> {
  return http.post<BaseResponse<VoiceWorkspace>>('/api/voice-agent/sessions', {
    project_id: projectId || null,
  }) as unknown as Promise<BaseResponse<VoiceWorkspace>>
}

export async function listVoiceSessions(projectId?: string | null, limit = 30): Promise<BaseResponse<{ sessions: VoiceSessionItem[] }>> {
  return http.get<BaseResponse<{ sessions: VoiceSessionItem[] }>>('/api/voice-agent/sessions', {
    params: {
      project_id: projectId || undefined,
      limit,
    },
  }) as unknown as Promise<BaseResponse<{ sessions: VoiceSessionItem[] }>>
}

export async function getVoiceSession(sessionId: string): Promise<BaseResponse<VoiceWorkspace>> {
  return http.get<BaseResponse<VoiceWorkspace>>(`/api/voice-agent/sessions/${sessionId}`) as unknown as Promise<BaseResponse<VoiceWorkspace>>
}

export async function refreshVoiceManagerStatus(sessionId: string): Promise<BaseResponse<VoiceManagerStatusResponse>> {
  return http.post<BaseResponse<VoiceManagerStatusResponse>>(`/api/voice-agent/sessions/${sessionId}/manager-status`, {}) as unknown as Promise<BaseResponse<VoiceManagerStatusResponse>>
}

export async function closeVoiceSession(sessionId: string): Promise<BaseResponse<{ session_id: string }>> {
  return http.delete<BaseResponse<{ session_id: string }>>(`/api/voice-agent/sessions/${sessionId}`) as unknown as Promise<BaseResponse<{ session_id: string }>>
}

export async function getCurrentVoiceSession(): Promise<BaseResponse<{ session_id: string | null }>> {
  return http.get<BaseResponse<{ session_id: string | null }>>('/api/voice-agent/current-session') as unknown as Promise<BaseResponse<{ session_id: string | null }>>
}

export async function setCurrentVoiceSession(sessionId: string | null): Promise<BaseResponse<{ session_id: string | null }>> {
  return http.put<BaseResponse<{ session_id: string | null }>>('/api/voice-agent/current-session', {
    session_id: sessionId,
  }) as unknown as Promise<BaseResponse<{ session_id: string | null }>>
}

export async function stopVoiceMonitor(sessionId: string): Promise<BaseResponse<{ workspace: VoiceWorkspace }>> {
  return http.post<BaseResponse<{ workspace: VoiceWorkspace }>>(`/api/voice-agent/sessions/${sessionId}/monitor/stop`, {}) as unknown as Promise<BaseResponse<{ workspace: VoiceWorkspace }>>
}

export async function getVoiceAgentConfig(): Promise<BaseResponse<VoiceAgentConfig>> {
  return http.get<BaseResponse<VoiceAgentConfig>>('/api/manager-agent/config') as unknown as Promise<BaseResponse<VoiceAgentConfig>>
}

export interface CodexStatus {
  available: boolean
  logged_in: boolean
  version?: string
}

export interface CodexModelServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexReasoningEffortOption {
  reasoning_effort: string
  description: string
}

export interface CodexModel {
  id: string
  model: string
  display_name: string
  description: string
  is_default: boolean
  default_reasoning_effort: string
  supported_reasoning_efforts: string[]
  reasoning_effort_options?: CodexReasoningEffortOption[]
  service_tiers: CodexModelServiceTier[]
}

export interface CodexModelCatalog {
  binary: string
  models: CodexModel[]
}

export interface ManagerAgentReadiness {
  ready: boolean
  status: 'ready' | 'blocked'
  harness: ManagerAgentHarness
  runtime_placement: 'host' | 'host_shell' | null
  agent_type: string | null
  provider_name: string | null
  model_name: string | null
  blockers: Array<{ code: string; message: string; detail?: string }>
  checks: {
    config: boolean
    codex?: CodexStatus & { binary?: string }
    docker_node?: {
      required: boolean
      available: boolean
      node_ids: string[]
    }
    docker_workspace?: {
      required: boolean
      host_path: string
      probe_endpoint: string
    }
    host_shell?: {
      required: boolean
      available: boolean
      shell_path?: string
      worker_entry?: string
      error?: string
    }
    dag_resources?: {
      worker_image: {
        status: 'unknown' | 'checking' | 'building' | 'ready' | 'error' | 'skipped'
        image: string
        reason?: string
        message: string
        started_at?: number
        updated_at?: number
        error?: string
      }
    }
  }
}

export interface DockerWorkspaceProbeResult {
  available: boolean
  node_id?: string | null
  image?: string
  host_path: string
  probe_path?: string
  container_id?: string | null
  error?: string
  code?: string
}

export async function getCodexStatus(): Promise<CodexStatus> {
  const res = await http.get<any>('/api/voice-agent/codex-status')
  return res.data ?? { available: false, logged_in: false }
}

export async function getCodexModels(): Promise<BaseResponse<CodexModelCatalog>> {
  return http.get<BaseResponse<CodexModelCatalog>>('/api/manager-agent/codex-models') as unknown as Promise<BaseResponse<CodexModelCatalog>>
}

export async function getManagerAgentReadiness(): Promise<ManagerAgentReadiness> {
  const res = await http.get<BaseResponse<ManagerAgentReadiness>>('/api/manager-agent/readiness') as unknown as BaseResponse<ManagerAgentReadiness>
  return res.data
}

export async function probeDockerWorkspaceMount(): Promise<DockerWorkspaceProbeResult> {
  const res = await http.post<BaseResponse<DockerWorkspaceProbeResult>>('/api/dag/docker-workspace-probe', {}) as unknown as BaseResponse<DockerWorkspaceProbeResult>
  return res.data
}

export async function updateVoiceAgentConfig(request: UpdateVoiceAgentConfigRequest): Promise<BaseResponse<VoiceAgentConfig>> {
  return http.put<BaseResponse<VoiceAgentConfig>>('/api/manager-agent/config', request) as unknown as Promise<BaseResponse<VoiceAgentConfig>>
}

export async function sendVoiceTurn(
  sessionId: string,
  text: string,
  projectId?: string | null,
  selectedNodeId?: string | null,
): Promise<BaseResponse<VoiceTurnResponse>> {
  return http.post<BaseResponse<VoiceTurnResponse>>(`/api/voice-agent/sessions/${sessionId}/turn`, {
    text,
    project_id: projectId || null,
    selected_node_id: selectedNodeId || null,
  }, { timeout: NO_HTTP_TIMEOUT }) as unknown as Promise<BaseResponse<VoiceTurnResponse>>
}

function voiceStreamUrl(path: string): string {
  const base = http.getBaseURL().replace(/\/$/, '')
  return `${base}${path}`
}

async function readVoiceNdjson(
  response: Response,
  onEvent: (event: VoiceStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = await response.json()
      message = data?.detail || data?.message || data?.error?.message || message
    } catch {
    }
    throw new Error(message)
  }
  if (!response.body) throw new Error('Streaming response body is empty')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 中止时主动释放 reader，避免悬挂的 fetch 继续往不相关的 workspace 写数据。
  const onAbort = () => { reader.cancel().catch(() => {}) }
  if (signal) {
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') throw err
        const detail = err?.message || String(err || 'stream read failed')
        throw new Error(`Manager Agent stream disconnected before an error response was received: ${detail}`)
      }
      const { value, done } = chunk
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const clean = line.trim()
        if (!clean) continue
        await onEvent(JSON.parse(clean) as VoiceStreamEvent)
      }
    }
    const tail = buffer.trim()
    if (tail) await onEvent(JSON.parse(tail) as VoiceStreamEvent)
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

export async function streamVoiceTurn(
  sessionId: string,
  text: string,
  projectId: string | null | undefined,
  onEvent: (event: VoiceStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
  selectedNodeId?: string | null,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(voiceStreamUrl(`/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/turn/stream`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        project_id: projectId || null,
        selected_node_id: selectedNodeId || null,
      }),
      signal,
    })
  } catch (err: any) {
    if (signal?.aborted || err?.name === 'AbortError') throw err
    const detail = err?.message || String(err || 'request failed')
    throw new Error(`Manager Agent stream request failed: ${detail}`)
  }
  await readVoiceNdjson(response, onEvent, signal)
}

export async function confirmVoiceTask(
  sessionId: string,
  confirmationId?: string | null,
  managerProviderName?: string | null,
  managerModelName?: string | null,
): Promise<BaseResponse<VoiceConfirmResponse>> {
  void managerProviderName
  void managerModelName
  return http.post<BaseResponse<VoiceConfirmResponse>>(`/api/voice-agent/sessions/${sessionId}/confirm`, {
    confirmation_id: confirmationId || null,
  }, { timeout: NO_HTTP_TIMEOUT }) as unknown as Promise<BaseResponse<VoiceConfirmResponse>>
}

export async function streamConfirmVoiceTask(
  sessionId: string,
  confirmationId: string | null | undefined,
  managerProviderName: string | null | undefined,
  managerModelName: string | null | undefined,
  onEvent: (event: VoiceStreamEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  void managerProviderName
  void managerModelName
  const response = await fetch(voiceStreamUrl(`/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/confirm/stream`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      confirmation_id: confirmationId || null,
    }),
    signal,
  })
  await readVoiceNdjson(response, onEvent, signal)
}

export async function notifyVoiceSession(
  sessionId: string,
  title: string,
  body: string,
  priority: VoicePriority = 'normal',
  spokenText?: string,
): Promise<BaseResponse<VoiceTurnResponse>> {
  return http.post<BaseResponse<VoiceTurnResponse>>(`/api/voice-agent/sessions/${sessionId}/notifications`, {
    title,
    body,
    priority,
    spoken_text: spokenText,
  }) as unknown as Promise<BaseResponse<VoiceTurnResponse>>
}

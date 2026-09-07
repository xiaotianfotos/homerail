/**
 * ============================================================================
 * Agent Runtime API - Agent 运行时 Facade
 * ============================================================================
 *
 * 封装 run-api 中与 Agent 运行时相关的调用，
 * 包括聊天对话、Agent 调用、审计摘要等。
 *
 * Agent UI 组件应通过本模块而非直接引用 run-api。
 */

import { http } from '../clients/http-client'
import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentRunAuditData,
} from './agent.types'
import type { ManagerAgentConfig } from '../services/voice-agent-api'
import { asAgentRecord, getAgentDataPayload, getAgentString } from './agent.types'
import { currentBrowserToolsTurnBinding } from '@/browser-tools/browser-renderer-bridge'

interface AgentRawResponse {
  success?: boolean
  data?: unknown
  message?: string
}

/**
 * 将 run-api managerChat 的原始响应归一化为 AgentChatResponse
 */
function normalizeChatResponse(raw: unknown): AgentChatResponse {
  const record = asAgentRecord(raw)
  const data = asAgentRecord(getAgentDataPayload(raw))
  return {
    reply: getAgentString(data.text),
    session_id: getAgentString(data.session_id),
    status: record.success ? 'ok' : 'error',
  }
}

/**
 * 将 run-api invokeManagerAgent 的原始响应归一化为 AgentChatResponse
 */
function normalizeInvokeResponse(raw: unknown): AgentChatResponse {
  const data = asAgentRecord(getAgentDataPayload(raw))
  return {
    reply: getAgentString(data.prompt),
    session_id: getAgentString(data.instance_id),
    status: getAgentString(data.status) || 'unknown',
  }
}

/**
 * 将 run-api getRunAuditSummary 的原始响应归一化为 AgentRunAuditData
 */
function normalizeAuditResponse(raw: unknown, runId: string): AgentRunAuditData {
  const data = getAgentDataPayload(raw)
  return {
    run_id: runId,
    summary: typeof data === 'string' ? data : getAgentString(asAgentRecord(data).summary),
    details: typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)
      : {},
  }
}

/**
 * ============================================================================
 * Raw re-exports for backward-compatible migration
 * ============================================================================
 *
 * Components importing directly from @/api/services/run-api should migrate
 * to these wrappers via @/api/agent. These wrappers intentionally avoid
 * importing the legacy service module so Agent Shell production type-check does
 * not pull the old Admin API surface into the main entry.
 */
export async function managerChat(data: unknown, signal?: AbortSignal): Promise<AgentRawResponse> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Manager chat request must be an object')
  }
  const {
    browser_tools_transport: _ignoredTransport,
    browser_tools_target: _ignoredTarget,
    ...request
  } = data as Record<string, unknown>
  return http.post(
    '/api/manager/chat',
    {
      ...request,
      ...currentBrowserToolsTurnBinding(),
    },
    signal ? { signal } : undefined,
  )
}

export async function getManagerAgentConfig(): Promise<AgentRawResponse> {
  return http.get('/api/manager-agent/config')
}

export async function updateManagerAgentConfig(data: Partial<ManagerAgentConfig>): Promise<AgentRawResponse> {
  return http.put('/api/manager-agent/config', data)
}

export async function invokeManagerAgent(runId: string, data: unknown): Promise<AgentRawResponse> {
  return http.post(`/api/runs/${encodeURIComponent(runId)}/invoke`, data)
}

export async function getRunAuditSummary(runId: string): Promise<AgentRawResponse> {
  return http.get(`/api/runs/${encodeURIComponent(runId)}/audit/summary`)
}

/**
 * Agent Runtime API facade
 */
export const agentRuntimeApi = {
  getManagerAgentConfig,
  updateManagerAgentConfig,
  /**
   * 与 Manager Agent 对话
   * 委托给 run-api.managerChat
   */
  async agentChat(request: AgentChatRequest, signal?: AbortSignal): Promise<AgentChatResponse> {
    const raw = await managerChat(
      {
        message: request.message,
        project_id: request.project_id,
        session_id: request.session_id,
        manager_agent_config: request.context,
      },
      signal,
    )
    return normalizeChatResponse(raw)
  },

  /**
   * 调用 Manager Agent
   * 委托给 run-api.invokeManagerAgent
   */
  async invokeAgent(runId: string, data: { prompt: string }): Promise<AgentChatResponse> {
    const raw = await invokeManagerAgent(runId, { prompt: data.prompt })
    return normalizeInvokeResponse(raw)
  },

  /**
   * 获取运行审计摘要
   * 委托给 run-api.getRunAuditSummary
   */
  async getAuditSummary(runId: string): Promise<AgentRunAuditData> {
    const raw = await getRunAuditSummary(runId)
    return normalizeAuditResponse(raw, runId)
  },
}

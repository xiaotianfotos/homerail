import { http, type ApiResponse } from '@/api/clients/http-client'
import type {
  GenerativeUiAttention,
  GenerativeUiDevice,
  GenerativeUiDocumentScopeV1,
  GenerativeUiInputModality,
  GenerativeUiSurface,
  GenerativeUiViewport,
  GenerativeUiVisibility,
} from 'homerail-protocol'
import type { GenerativeUiProjectionV1 } from '@/generative-ui/types'
import type { AgentToolResponseV1 } from '@/generative-ui/types'
import { normalizeAgentToolResponse } from '@/generative-ui/tool-confirmation'

export interface GenerativeUiProjectionQuery {
  device: GenerativeUiDevice
  input: GenerativeUiInputModality
  viewport: GenerativeUiViewport
  attention: GenerativeUiAttention
  active_run_id?: string
}

export interface PutGenerativeUiOverrideRequest {
  visibility?: GenerativeUiVisibility
  pinned?: boolean
  preferred_surface?: GenerativeUiSurface
}

export type PluginActionStatus =
  | 'needs_grant'
  | 'awaiting_confirmation'
  | 'authorized'
  | 'running'
  | 'committed'
  | 'denied'
  | 'failed'
  | 'cancelled'

/**
 * Minimal, untrusted browser interaction sent to Manager. Manager resolves the
 * current node Action and every plugin/policy binding from its own registry.
 */
export interface InvokePluginActionRequest {
  request_id: string
  idempotency_key: string
  scope: GenerativeUiDocumentScopeV1
  document_id: string
  document_revision: number
  node_id: string
  node_revision: number
  action_id: string
  input: Record<string, unknown>
}

export interface PluginActionEffectiveGrant {
  permission: string
  paths?: string[]
  hosts?: string[]
}

export interface PluginActionConfirmationChallenge {
  challenge_id: string
  request_id: string
  request_digest: string
  message: string
  expires_at: string
  effect: string
  permissions: string[]
  effective_grants: PluginActionEffectiveGrant[]
}

export interface PluginActionResponse {
  request_id: string
  status: PluginActionStatus
  request_digest: string
  missing_permissions?: string[]
  challenge?: PluginActionConfirmationChallenge
  result?: Record<string, unknown>
  error_code?: string
  error_message?: string
}

export interface ConfirmPluginActionRequest {
  challenge_id: string
  decision: 'approved' | 'denied'
}

export interface ConfirmPluginAgentToolRequest {
  challenge_id: string
  decision: 'approved' | 'denied'
}

const pluginActionStatuses = new Set<PluginActionStatus>([
  'needs_grant',
  'awaiting_confirmation',
  'authorized',
  'running',
  'committed',
  'denied',
  'failed',
  'cancelled',
])

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Manager plugin Action response: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid Manager plugin Action response: ${label} must be a non-empty string`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label)
  if (!result) {
    throw new Error(`Invalid Manager plugin Action response: ${label} is required`)
  }
  return result
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error(`Invalid Manager plugin Action response: ${label} must contain strings`)
  }
  return [...value]
}

function requiredStringArray(value: unknown, label: string): string[] {
  const result = optionalStringArray(value, label)
  if (!result) {
    throw new Error(`Invalid Manager plugin Action response: ${label} is required`)
  }
  return result
}

function optionalCanonicalScopeArray(value: unknown, label: string): string[] | undefined {
  const result = optionalStringArray(value, label)
  if (result && (
    result.length === 0
    || result.some((entry, index) => index > 0 && entry <= result[index - 1]!)
  )) {
    throw new Error(`Invalid Manager plugin Action response: ${label} must be non-empty, unique, and sorted`)
  }
  return result
}

function normalizeEffectiveGrants(value: unknown): PluginActionEffectiveGrant[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Manager plugin Action response: challenge.effective_grants is required')
  }
  return value.map((candidate, index) => {
    const grant = objectValue(candidate, `challenge.effective_grants[${index}]`)
    if (Object.keys(grant).some(key => !['permission', 'paths', 'hosts'].includes(key))) {
      throw new Error(`Invalid Manager plugin Action response: challenge.effective_grants[${index}] has unknown fields`)
    }
    const permission = requiredString(grant.permission, `challenge.effective_grants[${index}].permission`)
    const paths = optionalCanonicalScopeArray(grant.paths, `challenge.effective_grants[${index}].paths`)
    const hosts = optionalCanonicalScopeArray(grant.hosts, `challenge.effective_grants[${index}].hosts`)
    return {
      permission,
      ...(paths ? { paths } : {}),
      ...(hosts ? { hosts } : {}),
    }
  })
}

function normalizePluginActionChallenge(value: unknown): PluginActionConfirmationChallenge {
  const challenge = objectValue(value, 'challenge')
  const effect = requiredString(challenge.effect, 'challenge.effect')
  const permissions = requiredStringArray(challenge.permissions, 'challenge.permissions')
  if (permissions.some((permission, index) => index > 0 && permission <= permissions[index - 1]!)) {
    throw new Error('Invalid Manager plugin Action response: challenge.permissions must be unique and sorted')
  }
  const effectiveGrants = normalizeEffectiveGrants(challenge.effective_grants)
  if (
    permissions.length !== effectiveGrants.length
    || permissions.some((permission, index) => permission !== effectiveGrants[index]?.permission)
  ) {
    throw new Error('Invalid Manager plugin Action response: challenge effective grants do not match permissions')
  }
  const requestDigest = requiredString(challenge.request_digest, 'challenge.request_digest')
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new Error('Invalid Manager plugin Action response: challenge.request_digest must be SHA-256')
  }
  return {
    challenge_id: requiredString(challenge.challenge_id, 'challenge.challenge_id'),
    request_id: requiredString(challenge.request_id, 'challenge.request_id'),
    request_digest: requestDigest,
    message: requiredString(challenge.message, 'challenge.message'),
    expires_at: requiredString(challenge.expires_at, 'challenge.expires_at'),
    effect,
    permissions,
    effective_grants: effectiveGrants,
  }
}

/** Runtime validation keeps a malformed Manager response from becoming UI authority. */
export function normalizePluginActionResponse(value: unknown): PluginActionResponse {
  const response = objectValue(value, 'data')
  const requestId = requiredString(response.request_id, 'request_id')
  const status = response.status
  if (typeof status !== 'string' || !pluginActionStatuses.has(status as PluginActionStatus)) {
    throw new Error('Invalid Manager plugin Action response: unknown status')
  }
  const challenge = response.challenge === undefined
    ? undefined
    : normalizePluginActionChallenge(response.challenge)
  if (challenge && challenge.request_id !== requestId) {
    throw new Error('Invalid Manager plugin Action response: challenge request binding mismatch')
  }
  if (status === 'awaiting_confirmation' && !challenge) {
    throw new Error('Invalid Manager plugin Action response: confirmation challenge is required')
  }
  const requestDigest = requiredString(response.request_digest, 'request_digest')
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new Error('Invalid Manager plugin Action response: request_digest must be SHA-256')
  }
  if (challenge && challenge.request_digest !== requestDigest) {
    throw new Error('Invalid Manager plugin Action response: challenge digest binding mismatch')
  }
  const result = response.result === undefined
    ? undefined
    : structuredClone(objectValue(response.result, 'result'))
  const missingPermissions = optionalStringArray(response.missing_permissions, 'missing_permissions')
  const errorCode = optionalString(response.error_code, 'error_code')
  const responseErrorMessage = optionalString(response.error_message, 'error_message')
  return {
    request_id: requestId,
    status: status as PluginActionStatus,
    request_digest: requestDigest,
    ...(missingPermissions ? { missing_permissions: missingPermissions } : {}),
    ...(challenge ? { challenge } : {}),
    ...(result ? { result } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(responseErrorMessage ? { error_message: responseErrorMessage } : {}),
  }
}

export async function getVoiceGenerativeUiProjection(
  sessionId: string,
  query: GenerativeUiProjectionQuery,
): Promise<ApiResponse<GenerativeUiProjectionV1>> {
  return http.get<GenerativeUiProjectionV1>(
    `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/generative-ui`,
    { params: query },
  )
}

export async function putVoiceGenerativeUiOverride(
  sessionId: string,
  nodeId: string,
  request: PutGenerativeUiOverrideRequest,
): Promise<ApiResponse<{ override: GenerativeUiProjectionV1['overrides'][number] }>> {
  return http.put<{ override: GenerativeUiProjectionV1['overrides'][number] }>(
    `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/generative-ui/overrides/${encodeURIComponent(nodeId)}`,
    request,
  )
}

export async function deleteVoiceGenerativeUiOverride(
  sessionId: string,
  nodeId: string,
): Promise<ApiResponse<{ document_id: string; node_id: string }>> {
  return http.delete<{ document_id: string; node_id: string }>(
    `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/generative-ui/overrides/${encodeURIComponent(nodeId)}`,
  )
}

export async function invokePluginAction(
  request: InvokePluginActionRequest,
): Promise<ApiResponse<PluginActionResponse>> {
  const response = await http.post<unknown>('/api/plugins/actions', request)
  return {
    ...response,
    data: normalizePluginActionResponse(response.data),
  }
}

export async function confirmPluginAction(
  requestId: string,
  request: ConfirmPluginActionRequest,
): Promise<ApiResponse<PluginActionResponse>> {
  const response = await http.post<unknown>(
    `/api/plugins/actions/${encodeURIComponent(requestId)}/confirmation`,
    request,
  )
  return {
    ...response,
    data: normalizePluginActionResponse(response.data),
  }
}

export async function confirmPluginAgentTool(
  requestId: string,
  request: ConfirmPluginAgentToolRequest,
): Promise<ApiResponse<AgentToolResponseV1>> {
  const response = await http.post<unknown>(
    `/api/plugins/tools/${encodeURIComponent(requestId)}/confirmation`,
    request,
  )
  return {
    ...response,
    data: normalizeAgentToolResponse(response.data),
  }
}

export { normalizeAgentToolResponse, normalizePendingAgentToolConfirmations } from '@/generative-ui/tool-confirmation'

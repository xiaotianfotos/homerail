import {
  HomerailPluginPermission,
  isHomerailPluginId,
  validateHomerailPluginToolConfirmationChallenge,
} from 'homerail-protocol'
import type {
  AgentToolReferenceV1,
  AgentToolResponseV1,
  AgentToolStatusV1,
  PendingAgentToolConfirmationV1,
} from './types'

const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/
const TOOL_WIRE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const LOCAL_ID = /^[a-z][a-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/
const PERMISSIONS = new Set<string>(Object.values(HomerailPluginPermission))
const STATUSES = new Set<AgentToolStatusV1>([
  'needs_grant',
  'awaiting_confirmation',
  'authorized',
  'running',
  'committed',
  'denied',
  'failed',
  'cancelled',
])
const RESPONSE_FIELDS = new Set([
  'request_id',
  'request_digest',
  'status',
  'idempotent',
  'tool',
  'source',
  'missing_permissions',
  'denied_permissions',
  'challenge',
  'result',
  'error_code',
  'error_message',
])
const PENDING_FIELDS = new Set([
  'request_id',
  'request_digest',
  'status',
  'idempotent',
  'tool',
  'source',
  'challenge',
])

function invalid(message: string): Error {
  return new Error(`Invalid Manager Agent Tool response: ${message}`)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) throw invalid(`${label} has unknown field ${unknown}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw invalid(`${label} must be a non-empty string`)
  return value
}

function optionalCanonicalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || value.some(entry => typeof entry !== 'string' || !entry)
    || value.some((entry, index) => index > 0 && entry <= value[index - 1]!)
  ) throw invalid(`${label} must be a unique sorted string array`)
  if (value.some(entry => !PERMISSIONS.has(entry))) throw invalid(`${label} contains an unknown permission`)
  return [...value] as string[]
}

function normalizeTool(value: unknown): AgentToolReferenceV1 {
  const tool = objectValue(value, 'tool')
  exactFields(tool, new Set(['local_id', 'qualified_id', 'wire_id']), 'tool')
  const localId = requiredString(tool.local_id, 'tool.local_id')
  const qualifiedId = requiredString(tool.qualified_id, 'tool.qualified_id')
  const wireId = requiredString(tool.wire_id, 'tool.wire_id')
  const separator = qualifiedId.indexOf(':')
  if (
    !LOCAL_ID.test(localId)
    || separator < 1
    || separator !== qualifiedId.lastIndexOf(':')
    || !isHomerailPluginId(qualifiedId.slice(0, separator))
    || qualifiedId.slice(separator + 1) !== localId
    || !TOOL_WIRE_ID.test(wireId)
  ) throw invalid('tool identity is not canonical')
  return { local_id: localId, qualified_id: qualifiedId, wire_id: wireId }
}

export function normalizeAgentToolResponse(value: unknown): AgentToolResponseV1 {
  const response = objectValue(value, 'data')
  exactFields(response, RESPONSE_FIELDS, 'data')
  const requestId = requiredString(response.request_id, 'request_id')
  const requestDigest = requiredString(response.request_digest, 'request_digest')
  if (!WIRE_ID.test(requestId)) throw invalid('request_id is not canonical')
  if (!SHA256.test(requestDigest)) throw invalid('request_digest must be SHA-256')
  if (response.source !== 'agent') throw invalid('source must be agent')
  if (typeof response.status !== 'string' || !STATUSES.has(response.status as AgentToolStatusV1)) {
    throw invalid('status is unknown')
  }
  if (typeof response.idempotent !== 'boolean') throw invalid('idempotent must be boolean')
  const tool = normalizeTool(response.tool)
  const challengeValidation = response.challenge === undefined
    ? undefined
    : validateHomerailPluginToolConfirmationChallenge(response.challenge)
  if (challengeValidation && (!challengeValidation.valid || !challengeValidation.value)) {
    throw invalid(`challenge is invalid: ${JSON.stringify(challengeValidation.errors)}`)
  }
  const challenge = challengeValidation?.value
  if (challenge && (
    challenge.request_id !== requestId
    || challenge.request_digest !== requestDigest
  )) throw invalid('challenge request binding mismatch')
  if (response.status === 'awaiting_confirmation' && !challenge) {
    throw invalid('awaiting_confirmation requires a challenge')
  }
  const missingPermissions = optionalCanonicalStrings(response.missing_permissions, 'missing_permissions')
  const deniedPermissions = optionalCanonicalStrings(response.denied_permissions, 'denied_permissions')
  const result = response.result === undefined
    ? undefined
    : structuredClone(objectValue(response.result, 'result'))
  const errorCode = response.error_code === undefined
    ? undefined
    : requiredString(response.error_code, 'error_code')
  const errorMessage = response.error_message === undefined
    ? undefined
    : requiredString(response.error_message, 'error_message')
  if (errorCode && !ERROR_CODE.test(errorCode)) throw invalid('error_code is not canonical')
  if (errorMessage && (errorMessage.length > 1000 || /[\u0000-\u001f\u007f]/.test(errorMessage))) {
    throw invalid('error_message is not bounded plain text')
  }
  return {
    request_id: requestId,
    request_digest: requestDigest,
    status: response.status as AgentToolStatusV1,
    idempotent: response.idempotent,
    tool,
    source: 'agent',
    ...(missingPermissions ? { missing_permissions: missingPermissions } : {}),
    ...(deniedPermissions ? { denied_permissions: deniedPermissions } : {}),
    ...(challenge ? { challenge: structuredClone(challenge) } : {}),
    ...(result ? { result } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}

export function normalizePendingAgentToolConfirmations(value: unknown): PendingAgentToolConfirmationV1[] {
  if (!Array.isArray(value)) throw invalid('pending_tool_confirmations must be an array')
  const requestIds = new Set<string>()
  const challengeIds = new Set<string>()
  return value.map((candidate, index) => {
    const raw = objectValue(candidate, `pending_tool_confirmations[${index}]`)
    exactFields(raw, PENDING_FIELDS, `pending_tool_confirmations[${index}]`)
    const normalized = normalizeAgentToolResponse(raw)
    if (
      normalized.status !== 'awaiting_confirmation'
      || normalized.idempotent !== true
      || !normalized.challenge
    ) throw invalid(`pending_tool_confirmations[${index}] is not a pending Manager snapshot`)
    if (requestIds.has(normalized.request_id)) throw invalid('pending request ids must be unique')
    if (challengeIds.has(normalized.challenge.challenge_id)) throw invalid('pending challenge ids must be unique')
    requestIds.add(normalized.request_id)
    challengeIds.add(normalized.challenge.challenge_id)
    return normalized as PendingAgentToolConfirmationV1
  })
}

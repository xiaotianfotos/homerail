/**
 * Shared, pure capability/persistence rule for ASR realtime endpoints.
 *
 * Issue #193: a batch-only transcription service (for example a local
 * SenseVoice-compatible server exposing only POST /v1/audio/transcriptions)
 * must never be silently configured as native realtime ASR. Both Agent
 * Onboarding and Custom Provider Settings derive `ws://<host>/v1/realtime`
 * as a probe candidate, and both must apply exactly the same rule before
 * persisting it:
 *
 *   - Only a probe that completed a real WebSocket upgrade verifies native
 *     realtime support, and only a verified derived candidate may be saved
 *     automatically.
 *   - HTTP 401/403 only proves the endpoint is reachable and requires
 *     authentication; 404/405 prove it does not exist; network failures and
 *     any other pre-upgrade response prove nothing. None of them may be
 *     persisted as a derived realtime URL or labeled as verified support.
 *   - A URL the user deliberately entered, or an explicit URL loaded from a
 *     saved configuration, always survives. If the user explicitly clears
 *     the URL, the empty value survives too: the derived default must not
 *     be silently restored.
 *
 * Newer Manager builds attach an explicit capability outcome to probe
 * results so the UI never interprets status codes itself; older responses
 * only carry ok/reachable/status_code, so a conservative fallback keeps the
 * same semantics there (a WebSocket probe was only answered `ok` without a
 * pre-upgrade HTTP status when the upgrade really happened).
 */

/** Explicit probe outcomes a voice endpoint result may carry. */
export type AsrRealtimeCapability =
  | 'verified'
  | 'authentication_required'
  | 'not_found'
  | 'rejected'
  | 'unreachable'

/**
 * Structural view of one probed endpoint. Accepts the API
 * `VoiceEndpointProbeResult` shape plus the additive explicit outcome
 * fields newer Manager builds may include.
 */
export interface AsrRealtimeProbeLike {
  url?: string
  kind?: string
  ok?: boolean
  reachable?: boolean
  status_code?: number
  message?: string
  capability?: string | null
  outcome?: string | null
}

const CAPABILITY_ALIASES: Record<string, AsrRealtimeCapability> = {
  verified: 'verified',
  websocket_verified: 'verified',
  authentication_required: 'authentication_required',
  auth_required: 'authentication_required',
  requires_authentication: 'authentication_required',
  not_found: 'not_found',
  rejected: 'rejected',
  unreachable: 'unreachable'
}

function normalizeCapabilityAlias(value: string | null | undefined): AsrRealtimeCapability | undefined {
  if (typeof value !== 'string') return undefined
  return CAPABILITY_ALIASES[value.trim().toLowerCase().replace(/-/g, '_')]
}

/**
 * Reduce one ASR realtime endpoint probe to an explicit capability state.
 * Anything other than `verified` means native realtime support is unproven.
 */
export function asrRealtimeCapability(
  result: AsrRealtimeProbeLike | null | undefined
): AsrRealtimeCapability {
  if (!result) return 'unreachable'
  const explicit = normalizeCapabilityAlias(result.capability) ?? normalizeCapabilityAlias(result.outcome)
  if (explicit) return explicit

  const status = typeof result.status_code === 'number' ? result.status_code : undefined
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'authentication_required'
    if (status === 404 || status === 405) return 'not_found'
    return 'rejected'
  }
  if (result.reachable === false) return 'unreachable'
  if (result.ok) return 'verified'
  return result.reachable ? 'rejected' : 'unreachable'
}

/** True only when the probe completed a real WebSocket upgrade. */
export function isVerifiedAsrRealtimeProbe(
  result: AsrRealtimeProbeLike | null | undefined
): boolean {
  return asrRealtimeCapability(result) === 'verified'
}

export interface AsrRealtimeUrlPersistenceInput {
  /**
   * The user's own intent for the realtime URL:
   * - non-empty string: a URL the user typed or an explicit saved value;
   * - empty/blank string: the user explicitly cleared the field;
   * - undefined/null: no user intent, only an automatically derived
   *   candidate exists.
   */
  explicitUrl?: string | null
  /** Candidate automatically derived from the ASR base URL. */
  derivedUrl?: string | null
  /**
   * Probe result for the derived candidate. Callers must pass the result
   * that matches the current derived URL; both UI flows drop stale probe
   * results whenever the URL changes.
   */
  probeResult?: AsrRealtimeProbeLike | null
}

export type AsrRealtimeUrlPersistenceReason = 'explicit' | 'cleared' | 'verified' | 'unverified'

export interface AsrRealtimeUrlPersistenceDecision {
  /** Value to persist; '' keeps the field intentionally empty. */
  url: string
  reason: AsrRealtimeUrlPersistenceReason
}

/**
 * The one persistence predicate shared by Onboarding and Custom Provider
 * Settings. Explicit user values always win (including an explicit clear);
 * a derived candidate is persisted only after a verified WebSocket upgrade.
 */
export function decideAsrRealtimeUrlPersistence(
  input: AsrRealtimeUrlPersistenceInput
): AsrRealtimeUrlPersistenceDecision {
  if (typeof input.explicitUrl === 'string') {
    const explicit = input.explicitUrl.trim()
    if (!explicit) return { url: '', reason: 'cleared' }
    return { url: explicit, reason: 'explicit' }
  }
  const derived = typeof input.derivedUrl === 'string' ? input.derivedUrl.trim() : ''
  if (derived && isVerifiedAsrRealtimeProbe(input.probeResult ?? undefined)) {
    return { url: derived, reason: 'verified' }
  }
  return { url: '', reason: 'unverified' }
}

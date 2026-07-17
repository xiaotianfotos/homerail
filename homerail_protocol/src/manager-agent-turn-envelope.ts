/**
 * Manager-signed, request-bound trust envelope for host Agent processes.
 * @version 0.1.0
 */

import { stableStringify } from "./codec.js";

export const MANAGER_AGENT_TURN_ENVELOPE_VERSION = 1 as const;
export const MANAGER_AGENT_TURN_MAX_TTL_MS = 10 * 60 * 1000;
export const HOMERAIL_MANAGER_TURN_PUBLIC_KEY_ENV = "HOMERAIL_MANAGER_TURN_PUBLIC_KEY";
export const HOMERAIL_MANAGER_TURN_KEY_ID_ENV = "HOMERAIL_MANAGER_TURN_KEY_ID";
export const HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED_ENV = "HOMERAIL_MANAGER_TURN_ENVELOPE_REQUIRED";
export const HOMERAIL_MANAGER_TURN_HEADER = "x-homerail-manager-turn";

export type ManagerAgentTurnRuntimePlacementV1 = "host_shell";
export type ManagerAgentTurnResponseModeV1 = "chat" | "voice";
export type ManagerAgentTurnGenerativeUiModeV1 = "off" | "shadow" | "prefer";

export interface ManagerAgentTurnScopeV1 {
  runtime_placement: ManagerAgentTurnRuntimePlacementV1;
  worker_id: string;
  project_id: string | null;
  session_id: string | null;
  voice_session_id: string | null;
  response_mode: ManagerAgentTurnResponseModeV1;
  generative_ui_mode: ManagerAgentTurnGenerativeUiModeV1 | null;
  plugin_registry_revision: number;
  plugin_context_digest: string | null;
  capability_ids: string[];
  manager_skill_ids: string[];
  /** Exact method:path patterns authorized for this Worker turn. */
  manager_api_scopes: string[];
}

export interface ManagerAgentTurnClaimsV1 {
  turn_envelope_version: 1;
  issuer: "homerail-manager";
  audience: "homerail-manager-agent-worker";
  key_id: string;
  turn_id: string;
  issued_at: string;
  expires_at: string;
  payload_digest: string;
  scope: ManagerAgentTurnScopeV1;
}

export interface ManagerAgentTurnEnvelopeV1 {
  claims: ManagerAgentTurnClaimsV1;
  signature: string;
}

export interface ManagerAgentTurnEnvelopeValidationResultV1 {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  value?: ManagerAgentTurnEnvelopeV1;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
// Ed25519 signatures are exactly 64 bytes. Requiring canonical base64url also
// prevents alternate encodings of the same signature bytes.
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canonicalIds(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)))
    .sort((left, right) => left.localeCompare(right));
}

function payloadWithoutEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  delete copy.turn_envelope;
  return copy;
}

export function managerAgentTurnPayloadDigestInput(payload: Record<string, unknown>): string {
  return stableStringify(payloadWithoutEnvelope(payload));
}

export function managerAgentTurnClaimsSigningInput(claims: ManagerAgentTurnClaimsV1): string {
  return stableStringify(claims);
}

export function managerAgentTurnScopeFromPayload(
  payload: Record<string, unknown>,
  target: { runtime_placement: ManagerAgentTurnRuntimePlacementV1; worker_id: string },
): ManagerAgentTurnScopeV1 {
  const pluginContext = isRecord(payload.plugin_context) ? payload.plugin_context : undefined;
  const descriptors = [
    ...(Array.isArray(pluginContext?.skills) ? pluginContext.skills : []),
    ...(Array.isArray(pluginContext?.tools) ? pluginContext.tools : []),
    ...(Array.isArray(pluginContext?.actions) ? pluginContext.actions : []),
  ];
  const capabilityIds = canonicalIds(descriptors.flatMap((descriptor) =>
    isRecord(descriptor) && Array.isArray(descriptor.capability_ids) ? descriptor.capability_ids : []));
  const managerSkillIds = canonicalIds(
    (Array.isArray(payload.manager_skills) ? payload.manager_skills : [])
      .map((skill) => isRecord(skill) ? skill.id : undefined),
  );
  const responseMode = payload.response_mode === "voice" ? "voice" : "chat";
  const uiMode = payload.generative_ui_mode;
  return {
    runtime_placement: target.runtime_placement,
    worker_id: target.worker_id,
    project_id: nullableString(payload.project_id),
    session_id: nullableString(payload.session_id),
    voice_session_id: nullableString(payload.voice_session_id),
    response_mode: responseMode,
    generative_ui_mode: uiMode === "off" || uiMode === "shadow" || uiMode === "prefer" ? uiMode : null,
    plugin_registry_revision: Number.isSafeInteger(pluginContext?.registry_revision)
      && Number(pluginContext?.registry_revision) >= 0
      ? Number(pluginContext?.registry_revision)
      : 0,
    plugin_context_digest: typeof pluginContext?.context_digest === "string" && DIGEST.test(pluginContext.context_digest)
      ? pluginContext.context_digest
      : null,
    capability_ids: capabilityIds,
    manager_skill_ids: managerSkillIds,
    manager_api_scopes: canonicalIds(Array.isArray(payload.manager_api_scopes) ? payload.manager_api_scopes : []),
  };
}

export function validateManagerAgentTurnEnvelope(
  raw: unknown,
  options: {
    payload: Record<string, unknown>;
    payload_digest: string;
    expected_scope: ManagerAgentTurnScopeV1;
    now_ms?: number;
    clock_skew_ms?: number;
  },
): ManagerAgentTurnEnvelopeValidationResultV1 {
  const errors: Array<{ path: string; message: string }> = [];
  if (!isRecord(raw) || !exactKeys(raw, ["claims", "signature"])) {
    return { valid: false, errors: [{ path: "", message: "turn envelope must be an exact object" }] };
  }
  const claims = raw.claims;
  if (!isRecord(claims) || !exactKeys(claims, [
    "turn_envelope_version", "issuer", "audience", "key_id", "turn_id",
    "issued_at", "expires_at", "payload_digest", "scope",
  ])) errors.push({ path: "/claims", message: "claims must be an exact object" });
  const scope = isRecord(claims) ? claims.scope : undefined;
  if (!isRecord(scope) || !exactKeys(scope, [
    "runtime_placement", "worker_id", "project_id", "session_id", "voice_session_id",
    "response_mode", "generative_ui_mode", "plugin_registry_revision",
    "plugin_context_digest", "capability_ids", "manager_skill_ids", "manager_api_scopes",
  ])) errors.push({ path: "/claims/scope", message: "scope must be an exact object" });
  if (errors.length || !isRecord(claims) || !isRecord(scope)) return { valid: false, errors };

  if (claims.turn_envelope_version !== 1) errors.push({ path: "/claims/turn_envelope_version", message: "must be 1" });
  if (claims.issuer !== "homerail-manager") errors.push({ path: "/claims/issuer", message: "invalid issuer" });
  if (claims.audience !== "homerail-manager-agent-worker") errors.push({ path: "/claims/audience", message: "invalid audience" });
  if (typeof claims.key_id !== "string" || !ID.test(claims.key_id)) errors.push({ path: "/claims/key_id", message: "invalid key id" });
  if (typeof claims.turn_id !== "string" || !ID.test(claims.turn_id)) errors.push({ path: "/claims/turn_id", message: "invalid turn id" });
  if (typeof claims.payload_digest !== "string" || !DIGEST.test(claims.payload_digest)) {
    errors.push({ path: "/claims/payload_digest", message: "invalid payload digest" });
  } else if (claims.payload_digest !== options.payload_digest) {
    errors.push({ path: "/claims/payload_digest", message: "payload digest mismatch" });
  }
  if (typeof raw.signature !== "string" || !SIGNATURE.test(raw.signature)) {
    errors.push({ path: "/signature", message: "invalid signature encoding" });
  }

  const issued = typeof claims.issued_at === "string" ? Date.parse(claims.issued_at) : Number.NaN;
  const expires = typeof claims.expires_at === "string" ? Date.parse(claims.expires_at) : Number.NaN;
  if (!Number.isFinite(issued)) errors.push({ path: "/claims/issued_at", message: "invalid timestamp" });
  if (!Number.isFinite(expires)) errors.push({ path: "/claims/expires_at", message: "invalid timestamp" });
  if (Number.isFinite(issued) && Number.isFinite(expires)) {
    if (expires <= issued || expires - issued > MANAGER_AGENT_TURN_MAX_TTL_MS) {
      errors.push({ path: "/claims/expires_at", message: "turn lifetime is invalid" });
    }
    const now = options.now_ms ?? Date.now();
    const skew = options.clock_skew_ms ?? 10_000;
    if (issued > now + skew) errors.push({ path: "/claims/issued_at", message: "turn was issued in the future" });
    if (expires <= now - skew) errors.push({ path: "/claims/expires_at", message: "turn has expired" });
  }

  const value = raw as unknown as ManagerAgentTurnEnvelopeV1;
  const payloadScope = managerAgentTurnScopeFromPayload(options.payload, {
    runtime_placement: options.expected_scope.runtime_placement,
    worker_id: options.expected_scope.worker_id,
  });
  if (stableStringify(payloadScope) !== stableStringify(options.expected_scope)) {
    errors.push({ path: "/claims/scope", message: "expected scope does not match the payload" });
  }
  if (stableStringify(scope) !== stableStringify(options.expected_scope)) {
    errors.push({ path: "/claims/scope", message: "turn scope does not match the request or Worker" });
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [], value: structuredClone(value) };
}

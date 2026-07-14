/**
 * Manager-issued, single-use Artifact Broker capability contract.
 *
 * Runtime Tools never receive a host path. The capability binds one exact
 * content digest, byte length and media type to the originating Agent Tool,
 * plugin package and Generative UI scope.
 * @version 0.1.0
 */

import { stableStringify } from "../codec.js";
import {
  isHomerailPluginId,
  type HomerailPluginToolBindingV1,
  type HomerailPluginValidationError,
  type HomerailPluginValidationResult,
} from "./types.js";

export const HOMERAIL_ARTIFACT_BROKER_CAPABILITY_VERSION = 1 as const;
export const HOMERAIL_ARTIFACT_BROKER_MAX_TTL_MS = 5 * 60 * 1000;
export const HOMERAIL_ARTIFACT_BROKER_MAX_BYTES = 16 * 1024 * 1024;
export const HOMERAIL_ARTIFACT_BROKER_MEDIA_TYPES = [
  "application/json",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type HomerailPluginArtifactMediaTypeV1 =
  (typeof HOMERAIL_ARTIFACT_BROKER_MEDIA_TYPES)[number];

export interface HomerailPluginArtifactWriteCapabilityClaimsV1 {
  artifact_capability_version: 1;
  capability_id: string;
  audience: "homerail.artifact-broker";
  scope: "plugin.artifact.write";
  nonce: string;
  single_use: true;
  binding: HomerailPluginToolBindingV1;
  request_id: string;
  request_digest: string;
  document_scope: {
    type: "voice_session" | "project" | "run";
    id: string;
    document_id: string;
  };
  artifact: {
    label: string;
    media_type: HomerailPluginArtifactMediaTypeV1;
    digest: string;
    size_bytes: number;
  };
  issued_at: string;
  expires_at: string;
}

export interface HomerailPluginArtifactCapabilityValidationOptionsV1 {
  now_ms?: number;
  clock_skew_ms?: number;
  expected?: Partial<{
    capability_id: string;
    plugin_id: string;
    plugin_version: string;
    request_id: string;
    request_digest: string;
    document_id: string;
    digest: string;
    media_type: HomerailPluginArtifactMediaTypeV1;
    size_bytes: number;
  }>;
}

const DIGEST = /^[a-f0-9]{64}$/;
const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MEDIA_TYPES = new Set<string>(HOMERAIL_ARTIFACT_BROKER_MEDIA_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function issue(path: string, message: string, keyword = "artifactCapability"): HomerailPluginValidationError {
  return { path, message, keyword };
}

function validOpaqueId(value: unknown, maxBytes = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= maxBytes
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function bindingErrors(value: unknown): HomerailPluginValidationError[] {
  if (!isRecord(value) || !exactKeys(value, [
    "plugin_id", "plugin_version", "manifest_digest", "package_digest", "context_digest",
    "registry_revision", "permission_revision",
  ])) return [issue("/binding", "binding must be an exact Tool binding")];
  const errors: HomerailPluginValidationError[] = [];
  if (!isHomerailPluginId(value.plugin_id)) errors.push(issue("/binding/plugin_id", "invalid plugin id"));
  if (typeof value.plugin_version !== "string" || !SEMVER.test(value.plugin_version)) {
    errors.push(issue("/binding/plugin_version", "invalid plugin version"));
  }
  for (const key of ["manifest_digest", "package_digest", "context_digest"] as const) {
    if (typeof value[key] !== "string" || !DIGEST.test(value[key])) {
      errors.push(issue(`/binding/${key}`, "invalid SHA-256 digest"));
    }
  }
  for (const key of ["registry_revision", "permission_revision"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      errors.push(issue(`/binding/${key}`, "invalid non-negative revision"));
    }
  }
  return errors;
}

/** Canonical input signed by the Manager Artifact Broker. */
export function homerailPluginArtifactCapabilitySigningInput(
  claims: HomerailPluginArtifactWriteCapabilityClaimsV1,
): string {
  return stableStringify(claims);
}

export function validateHomerailPluginArtifactWriteCapabilityClaims(
  raw: unknown,
  options: HomerailPluginArtifactCapabilityValidationOptionsV1 = {},
): HomerailPluginValidationResult<HomerailPluginArtifactWriteCapabilityClaimsV1> {
  if (!isRecord(raw) || !exactKeys(raw, [
    "artifact_capability_version", "capability_id", "audience", "scope", "nonce",
    "single_use", "binding", "request_id", "request_digest", "document_scope",
    "artifact", "issued_at", "expires_at",
  ])) return { valid: false, errors: [issue("", "capability claims must be an exact object")] };

  const errors: HomerailPluginValidationError[] = [];
  if (raw.artifact_capability_version !== 1) errors.push(issue("/artifact_capability_version", "must be 1"));
  if (raw.audience !== "homerail.artifact-broker") errors.push(issue("/audience", "invalid audience"));
  if (raw.scope !== "plugin.artifact.write") errors.push(issue("/scope", "invalid capability scope"));
  if (raw.single_use !== true) errors.push(issue("/single_use", "must be true"));
  for (const key of ["capability_id", "nonce", "request_id"] as const) {
    if (typeof raw[key] !== "string" || !WIRE_ID.test(raw[key])) {
      errors.push(issue(`/${key}`, "invalid wire identity"));
    }
  }
  if (typeof raw.request_digest !== "string" || !DIGEST.test(raw.request_digest)) {
    errors.push(issue("/request_digest", "invalid request digest"));
  }
  errors.push(...bindingErrors(raw.binding));

  if (!isRecord(raw.document_scope) || !exactKeys(raw.document_scope, ["type", "id", "document_id"])) {
    errors.push(issue("/document_scope", "document scope must be exact"));
  } else {
    if (!new Set(["voice_session", "project", "run"]).has(String(raw.document_scope.type))) {
      errors.push(issue("/document_scope/type", "invalid document scope type"));
    }
    if (!validOpaqueId(raw.document_scope.id)) errors.push(issue("/document_scope/id", "invalid scope id"));
    if (!validOpaqueId(raw.document_scope.document_id)) {
      errors.push(issue("/document_scope/document_id", "invalid document id"));
    }
  }

  if (!isRecord(raw.artifact) || !exactKeys(raw.artifact, ["label", "media_type", "digest", "size_bytes"])) {
    errors.push(issue("/artifact", "artifact declaration must be exact"));
  } else {
    if (!validOpaqueId(raw.artifact.label, 240)) errors.push(issue("/artifact/label", "invalid artifact label"));
    if (typeof raw.artifact.media_type !== "string" || !MEDIA_TYPES.has(raw.artifact.media_type)) {
      errors.push(issue("/artifact/media_type", "media type is not broker-approved"));
    }
    if (typeof raw.artifact.digest !== "string" || !DIGEST.test(raw.artifact.digest)) {
      errors.push(issue("/artifact/digest", "invalid artifact digest"));
    }
    if (!Number.isSafeInteger(raw.artifact.size_bytes)
      || Number(raw.artifact.size_bytes) < 1
      || Number(raw.artifact.size_bytes) > HOMERAIL_ARTIFACT_BROKER_MAX_BYTES) {
      errors.push(issue("/artifact/size_bytes", "artifact size is outside broker limits"));
    }
  }

  const issuedAt = typeof raw.issued_at === "string" ? Date.parse(raw.issued_at) : Number.NaN;
  const expiresAt = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : Number.NaN;
  if (!Number.isFinite(issuedAt)) errors.push(issue("/issued_at", "invalid timestamp"));
  if (!Number.isFinite(expiresAt)) errors.push(issue("/expires_at", "invalid timestamp"));
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt)) {
    if (expiresAt <= issuedAt || expiresAt - issuedAt > HOMERAIL_ARTIFACT_BROKER_MAX_TTL_MS) {
      errors.push(issue("/expires_at", "capability lifetime is invalid"));
    }
    const now = options.now_ms ?? Date.now();
    const skew = options.clock_skew_ms ?? 0;
    if (issuedAt > now + skew) errors.push(issue("/issued_at", "capability is not active yet"));
    if (expiresAt <= now - skew) errors.push(issue("/expires_at", "capability has expired"));
  }

  const expected = options.expected;
  const binding = isRecord(raw.binding) ? raw.binding : {};
  const documentScope = isRecord(raw.document_scope) ? raw.document_scope : {};
  const artifact = isRecord(raw.artifact) ? raw.artifact : {};
  const comparisons: Array<[unknown, unknown, string]> = [
    [raw.capability_id, expected?.capability_id, "/capability_id"],
    [binding.plugin_id, expected?.plugin_id, "/binding/plugin_id"],
    [binding.plugin_version, expected?.plugin_version, "/binding/plugin_version"],
    [raw.request_id, expected?.request_id, "/request_id"],
    [raw.request_digest, expected?.request_digest, "/request_digest"],
    [documentScope.document_id, expected?.document_id, "/document_scope/document_id"],
    [artifact.digest, expected?.digest, "/artifact/digest"],
    [artifact.media_type, expected?.media_type, "/artifact/media_type"],
    [artifact.size_bytes, expected?.size_bytes, "/artifact/size_bytes"],
  ];
  for (const [actual, wanted, path] of comparisons) {
    if (wanted !== undefined && actual !== wanted) errors.push(issue(path, "capability binding does not match expected value"));
  }

  const value = raw as unknown as HomerailPluginArtifactWriteCapabilityClaimsV1;
  return errors.length
    ? { valid: false, errors }
    : { valid: true, value: structuredClone(value), errors: [] };
}

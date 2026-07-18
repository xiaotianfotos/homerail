import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  type EncryptedSecret,
} from "./secret-store.js";
import { nowIso } from "./time.js";

export const CREDENTIAL_TYPES = [
  "api_key",
  "oauth_token",
  "bot",
  "ssh_key",
  "certificate",
  "opaque",
] as const;

export type CredentialType = typeof CREDENTIAL_TYPES[number];
export type CredentialStatus = "active" | "revoked";

export interface CredentialMetadata {
  description?: string;
  scopes?: string[];
  labels?: Record<string, string>;
}

export interface CredentialRecord {
  id: string;
  credential_type: CredentialType;
  name: string;
  status: CredentialStatus;
  version: number;
  secret_fields: string[];
  metadata: CredentialMetadata;
  expires_at?: string;
  last_used_at?: string;
  rotated_at?: string;
  revoked_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CredentialAuditEvent {
  sequence: number;
  event_id: string;
  credential_id: string;
  event_type: "created" | "rotated" | "revoked" | "deleted" | "materialized" | "denied";
  actor: string;
  run_id?: string;
  node_id?: string;
  purpose?: string;
  result: "success" | "denied" | "failed";
  detail: Record<string, unknown>;
  created_at: string;
}

interface StoredCredentialRow {
  id: string;
  credential_type: string;
  name: string;
  encrypted_payload: string;
  metadata: string | null;
  status: string;
  version: number;
  expires_at: string | null;
  last_used_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EncryptedCredentialPayloadV1 {
  schema_version: 1;
  secret_fields: string[];
  secret: EncryptedSecret;
}

export interface CredentialMutationContext {
  actor: string;
}

export interface CredentialUseContext {
  actor: string;
  run_id?: string;
  node_id?: string;
  purpose?: string;
  broker?: string;
  action?: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_BYTES = 2 * 1024 * 1024;

function assertCredentialType(value: string): asserts value is CredentialType {
  if (!(CREDENTIAL_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported credential type: ${value}`);
  }
}

function normalizedId(value: string): string {
  const id = value.trim();
  if (!ID_PATTERN.test(id)) throw new Error("Credential id must be 1-128 safe identifier characters");
  return id;
}

function normalizedName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 256) throw new Error("Credential name must be 1-256 characters");
  return name;
}

function normalizedActor(value: string): string {
  const actor = value.trim();
  if (!actor || actor.length > 256) throw new Error("Credential actor must be 1-256 characters");
  return actor;
}

function normalizedOptionalText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new Error(`Value exceeds ${maxLength} characters`);
  return normalized;
}

function normalizedExpiresAt(value: string | undefined): string | undefined {
  const expiresAt = normalizedOptionalText(value, 64);
  if (!expiresAt) return undefined;
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time)) throw new Error("expires_at must be an RFC3339 timestamp");
  return new Date(time).toISOString();
}

function normalizedMetadata(value: CredentialMetadata | undefined): CredentialMetadata {
  const description = normalizedOptionalText(value?.description, 2048);
  const scopes = [...new Set((value?.scopes ?? []).map((entry) => normalizedOptionalText(entry, 256)).filter(
    (entry): entry is string => Boolean(entry),
  ))].sort();
  if (scopes.length > 128) throw new Error("Credential metadata has too many scopes");
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value?.labels ?? {})) {
    if (!FIELD_PATTERN.test(key)) throw new Error(`Invalid credential metadata label: ${key}`);
    const label = normalizedOptionalText(raw, 512);
    if (label) labels[key] = label;
  }
  if (Object.keys(labels).length > 64) throw new Error("Credential metadata has too many labels");
  return {
    ...(description ? { description } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

function normalizedSecrets(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("Credential secret must contain 1-16 fields");
  }
  let totalBytes = 0;
  const normalized: Record<string, string> = {};
  for (const [key, secret] of entries) {
    if (!FIELD_PATTERN.test(key)) throw new Error(`Invalid credential secret field: ${key}`);
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error(`Credential secret field '${key}' must be a non-empty string`);
    }
    totalBytes += Buffer.byteLength(secret, "utf8");
    normalized[key] = secret;
  }
  if (totalBytes > MAX_SECRET_BYTES) throw new Error("Credential secret exceeds 2 MiB");
  return normalized;
}

function assertRequiredSecretFields(type: CredentialType, secret: Record<string, string>): void {
  const required: Partial<Record<CredentialType, string[]>> = {
    api_key: ["value"],
    bot: ["app_id", "app_secret"],
    ssh_key: ["private_key"],
    certificate: ["certificate", "private_key"],
  };
  for (const field of required[type] ?? []) {
    if (!secret[field]) throw new Error(`Credential type '${type}' requires secret field '${field}'`);
  }
  if (type === "oauth_token" && !secret.access_token && !secret.refresh_token) {
    throw new Error("Credential type 'oauth_token' requires access_token or refresh_token");
  }
}

function encodePayload(secret: Record<string, string>): string {
  const secretFields = Object.keys(secret).sort();
  const payload: EncryptedCredentialPayloadV1 = {
    schema_version: 1,
    secret_fields: secretFields,
    secret: encryptSecret(JSON.stringify(secret)),
  };
  return JSON.stringify(payload);
}

function parsePayload(value: string): EncryptedCredentialPayloadV1 {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error("Credential payload uses an unsupported legacy format");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Credential payload is invalid");
  }
  const raw = payload as Record<string, unknown>;
  if (raw.schema_version !== 1 || !Array.isArray(raw.secret_fields) || !isEncryptedSecret(raw.secret)) {
    throw new Error("Credential payload uses an unsupported schema version");
  }
  if (!raw.secret_fields.every((field) => typeof field === "string" && FIELD_PATTERN.test(field))) {
    throw new Error("Credential secret field manifest is invalid");
  }
  return raw as unknown as EncryptedCredentialPayloadV1;
}

function decodePayload(value: string): { secret_fields: string[]; secret: Record<string, string> } {
  const payload = parsePayload(value);
  const plaintext = decryptSecret(payload.secret);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } finally {
    // JavaScript strings cannot be zeroed; keep the plaintext lifetime inside this function.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credential plaintext is invalid");
  }
  const secret = normalizedSecrets(parsed as Record<string, string>);
  const secretFields = Object.keys(secret).sort();
  if (JSON.stringify(secretFields) !== JSON.stringify([...payload.secret_fields].sort())) {
    throw new Error("Credential secret field manifest does not match the encrypted payload");
  }
  return { secret_fields: secretFields, secret };
}

function rowMetadata(row: StoredCredentialRow): CredentialMetadata {
  if (!row.metadata) return {};
  try {
    return normalizedMetadata(JSON.parse(row.metadata) as CredentialMetadata);
  } catch {
    return {};
  }
}

function publicRecord(row: StoredCredentialRow): CredentialRecord {
  assertCredentialType(row.credential_type);
  const payload = parsePayload(row.encrypted_payload);
  return {
    id: row.id,
    credential_type: row.credential_type,
    name: row.name,
    status: row.status === "revoked" ? "revoked" : "active",
    version: row.version,
    secret_fields: [...payload.secret_fields].sort(),
    metadata: rowMetadata(row),
    ...(row.expires_at ? { expires_at: row.expires_at } : {}),
    ...(row.last_used_at ? { last_used_at: row.last_used_at } : {}),
    ...(row.rotated_at ? { rotated_at: row.rotated_at } : {}),
    ...(row.revoked_at ? { revoked_at: row.revoked_at } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function selectRow(id: string): StoredCredentialRow | undefined {
  return getDb().prepare(`
    SELECT id, credential_type, name, encrypted_payload, metadata, status, version,
           expires_at, last_used_at, rotated_at, revoked_at, created_at, updated_at
    FROM execution_credentials WHERE id = ?
  `).get(id) as StoredCredentialRow | undefined;
}

function appendAudit(input: Omit<CredentialAuditEvent, "sequence" | "event_id" | "created_at">): void {
  getDb().prepare(`
    INSERT INTO credential_audit_events(
      event_id, credential_id, event_type, actor, run_id, node_id, purpose, result, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    input.credential_id,
    input.event_type,
    normalizedActor(input.actor),
    input.run_id ?? null,
    input.node_id ?? null,
    input.purpose ?? null,
    input.result,
    JSON.stringify(input.detail),
    nowIso(),
  );
}

export function createCredential(input: {
  id: string;
  credential_type: string;
  name: string;
  secret: Record<string, string>;
  metadata?: CredentialMetadata;
  expires_at?: string;
}, context: CredentialMutationContext): CredentialRecord {
  const id = normalizedId(input.id);
  assertCredentialType(input.credential_type);
  const name = normalizedName(input.name);
  const secret = normalizedSecrets(input.secret);
  assertRequiredSecretFields(input.credential_type, secret);
  const metadata = normalizedMetadata(input.metadata);
  const expiresAt = normalizedExpiresAt(input.expires_at);
  const now = nowIso();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO execution_credentials(
        id, credential_type, name, encrypted_payload, metadata, status, version,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
    `).run(id, input.credential_type, name, encodePayload(secret), JSON.stringify(metadata), expiresAt ?? null, now, now);
    appendAudit({
      credential_id: id,
      event_type: "created",
      actor: context.actor,
      result: "success",
      detail: { credential_type: input.credential_type, secret_fields: Object.keys(secret).sort() },
    });
  }).immediate();
  return getCredential(id)!;
}

export function listCredentials(): CredentialRecord[] {
  const rows = getDb().prepare(`
    SELECT id, credential_type, name, encrypted_payload, metadata, status, version,
           expires_at, last_used_at, rotated_at, revoked_at, created_at, updated_at
    FROM execution_credentials ORDER BY name, id
  `).all() as StoredCredentialRow[];
  return rows.map(publicRecord);
}

export function getCredential(idValue: string): CredentialRecord | undefined {
  const row = selectRow(normalizedId(idValue));
  return row ? publicRecord(row) : undefined;
}

export function rotateCredential(idValue: string, input: {
  secret: Record<string, string>;
  expires_at?: string;
}, context: CredentialMutationContext): CredentialRecord {
  const id = normalizedId(idValue);
  const row = selectRow(id);
  if (!row) throw new Error(`Credential not found: ${id}`);
  assertCredentialType(row.credential_type);
  const secret = normalizedSecrets(input.secret);
  assertRequiredSecretFields(row.credential_type, secret);
  const expiresAt = normalizedExpiresAt(input.expires_at);
  const now = nowIso();
  getDb().transaction(() => {
    const updated = getDb().prepare(`
      UPDATE execution_credentials
      SET encrypted_payload = ?, status = 'active', version = version + 1,
          expires_at = ?, rotated_at = ?, revoked_at = NULL, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(encodePayload(secret), expiresAt ?? null, now, now, id, row.version);
    if (updated.changes !== 1) throw new Error(`Credential changed concurrently: ${id}`);
    appendAudit({
      credential_id: id,
      event_type: "rotated",
      actor: context.actor,
      result: "success",
      detail: { from_version: row.version, to_version: row.version + 1, secret_fields: Object.keys(secret).sort() },
    });
  }).immediate();
  return getCredential(id)!;
}

export function revokeCredential(idValue: string, context: CredentialMutationContext): CredentialRecord {
  const id = normalizedId(idValue);
  const row = selectRow(id);
  if (!row) throw new Error(`Credential not found: ${id}`);
  if (row.status === "revoked") return publicRecord(row);
  const now = nowIso();
  getDb().transaction(() => {
    const updated = getDb().prepare(`
      UPDATE execution_credentials
      SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(now, now, id, row.version);
    if (updated.changes !== 1) throw new Error(`Credential changed concurrently: ${id}`);
    appendAudit({
      credential_id: id,
      event_type: "revoked",
      actor: context.actor,
      result: "success",
      detail: { version: row.version },
    });
  }).immediate();
  return getCredential(id)!;
}

export function deleteCredential(idValue: string, context: CredentialMutationContext): void {
  const id = normalizedId(idValue);
  const row = selectRow(id);
  if (!row) throw new Error(`Credential not found: ${id}`);
  getDb().transaction(() => {
    appendAudit({
      credential_id: id,
      event_type: "deleted",
      actor: context.actor,
      result: "success",
      detail: { version: row.version, status: row.status },
    });
    getDb().prepare("DELETE FROM execution_credentials WHERE id = ?").run(id);
  }).immediate();
}

export function materializeCredential(idValue: string, context: CredentialUseContext): {
  record: CredentialRecord;
  secret: Record<string, string>;
} {
  const id = normalizedId(idValue);
  const row = selectRow(id);
  const denied = (reason: string): never => {
    appendAudit({
      credential_id: id,
      event_type: "denied",
      actor: context.actor,
      run_id: context.run_id,
      node_id: context.node_id,
      purpose: context.purpose,
      result: "denied",
      detail: { reason },
    });
    throw new Error(reason);
  };
  if (!row) return denied(`Credential not found: ${id}`);
  if (row.status !== "active") denied(`Credential is revoked: ${id}`);
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) denied(`Credential is expired: ${id}`);
  const decoded = decodePayload(row.encrypted_payload);
  const usedAt = nowIso();
  getDb().transaction(() => {
    getDb().prepare("UPDATE execution_credentials SET last_used_at = ? WHERE id = ?").run(usedAt, id);
    appendAudit({
      credential_id: id,
      event_type: "materialized",
      actor: context.actor,
      run_id: context.run_id,
      node_id: context.node_id,
      purpose: context.purpose,
      result: "success",
      detail: {
        version: row.version,
        secret_fields: decoded.secret_fields,
        ...(context.broker ? { broker: context.broker } : {}),
        ...(context.action ? { action: context.action } : {}),
      },
    });
  }).immediate();
  return { record: getCredential(id)!, secret: decoded.secret };
}

export function recordCredentialUseFailure(
  idValue: string,
  context: CredentialUseContext,
  reason: string,
): void {
  const id = normalizedId(idValue);
  appendAudit({
    credential_id: id,
    event_type: "denied",
    actor: context.actor,
    run_id: context.run_id,
    node_id: context.node_id,
    purpose: context.purpose,
    result: "failed",
    detail: {
      reason: normalizedOptionalText(reason, 512) ?? "credential broker call failed",
      ...(context.broker ? { broker: context.broker } : {}),
      ...(context.action ? { action: context.action } : {}),
    },
  });
}

export function listCredentialAuditEvents(idValue: string): CredentialAuditEvent[] {
  const id = normalizedId(idValue);
  const rows = getDb().prepare(`
    SELECT sequence, event_id, credential_id, event_type, actor, run_id, node_id,
           purpose, result, detail, created_at
    FROM credential_audit_events WHERE credential_id = ? ORDER BY sequence
  `).all(id) as Array<Omit<CredentialAuditEvent, "detail"> & { detail: string }>;
  return rows.map((row) => ({
    ...row,
    ...(row.run_id ? {} : { run_id: undefined }),
    ...(row.node_id ? {} : { node_id: undefined }),
    ...(row.purpose ? {} : { purpose: undefined }),
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}

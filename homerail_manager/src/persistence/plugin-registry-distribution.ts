import { randomUUID } from "node:crypto";
import {
  normalizeHrpPath,
  type PluginRegistryReleaseV1,
  type VerifiedPluginRegistryIndex,
} from "homerail-plugin-sdk";
import {
  isCanonicalHomerailPluginSemver,
  isHomerailPluginId,
} from "homerail-protocol";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { nowIso } from "./time.js";

export type PluginRegistryOperation =
  | "configure"
  | "sync"
  | "install"
  | "update"
  | "activate"
  | "rollback";

export interface PluginRegistrySourceRecord {
  registry_id: string;
  source_url: string;
  root_key_id: string;
  last_sequence: number;
  last_index_digest?: string;
  last_issued_at?: string;
  last_expires_at?: string;
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginRegistryReleaseRecord extends PluginRegistryReleaseV1 {
  registry_id: string;
  index_sequence: number;
  created_at: string;
}

export interface PluginRegistryUpdateAttemptRecord {
  seq: number;
  attempt_id: string;
  registry_id: string;
  operation: PluginRegistryOperation;
  status: "succeeded" | "failed";
  plugin_id?: string;
  from_version?: string;
  to_version?: string;
  index_sequence?: number;
  index_digest?: string;
  rollback_version?: string;
  error?: string;
  created_at: string;
  completed_at: string;
  data: Record<string, unknown>;
}

interface SourceRow {
  registry_id: string;
  source_url: string;
  root_key_id: string;
  last_sequence: number;
  last_index_digest: string | null;
  last_issued_at: string | null;
  last_expires_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReleaseRow extends PluginRegistryReleaseV1 {
  registry_id: string;
  index_sequence: number;
  created_at: string;
}

interface AttemptRow {
  seq: number;
  attempt_id: string;
  registry_id: string;
  operation: PluginRegistryOperation;
  status: "succeeded" | "failed";
  plugin_id: string | null;
  from_version: string | null;
  to_version: string | null;
  index_sequence: number | null;
  index_digest: string | null;
  rollback_version: string | null;
  error: string | null;
  created_at: string;
  completed_at: string;
  data_json: string;
}

const REGISTRY_ID = /^[a-z][a-z0-9._-]{0,79}$/;
const KEY_ID = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assertRegistryId(value: string): string {
  if (!REGISTRY_ID.test(value)) throw new Error("Plugin registry id is invalid");
  return value;
}

export function normalizePluginRegistrySourceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Plugin registry source URL is invalid"); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Plugin registry source URL must not contain credentials, a query, or a fragment");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin registry source URL must use HTTPS or loopback HTTP");
  }
  if (url.protocol === "https:" && !url.hostname) throw new Error("Plugin registry source URL requires a host");
  return url.toString();
}

function decodeSource(row: SourceRow): PluginRegistrySourceRecord {
  if (
    !REGISTRY_ID.test(row.registry_id)
    || !KEY_ID.test(row.root_key_id)
    || !Number.isSafeInteger(row.last_sequence)
    || row.last_sequence < 0
    || (row.last_index_digest !== null && !SHA256.test(row.last_index_digest))
  ) throw new Error(`Invalid persisted plugin registry source: ${row.registry_id}`);
  return {
    registry_id: row.registry_id,
    source_url: normalizePluginRegistrySourceUrl(row.source_url),
    root_key_id: row.root_key_id,
    last_sequence: row.last_sequence,
    ...(row.last_index_digest === null ? {} : { last_index_digest: row.last_index_digest }),
    ...(row.last_issued_at === null ? {} : { last_issued_at: row.last_issued_at }),
    ...(row.last_expires_at === null ? {} : { last_expires_at: row.last_expires_at }),
    ...(row.last_synced_at === null ? {} : { last_synced_at: row.last_synced_at }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function decodeRelease(row: ReleaseRow): PluginRegistryReleaseRecord {
  if (
    !REGISTRY_ID.test(row.registry_id)
    || !isHomerailPluginId(row.plugin_id)
    || !isCanonicalHomerailPluginSemver(row.plugin_version)
    || normalizeHrpPath(row.archive_path) !== row.archive_path
    || !row.archive_path.endsWith(".hrp")
    || !SHA256.test(row.archive_digest)
    || !SHA256.test(row.payload_digest)
    || !KEY_ID.test(row.publisher_key_id)
    || !Number.isSafeInteger(row.index_sequence)
    || row.index_sequence < 1
  ) throw new Error(`Invalid persisted plugin registry release: ${row.registry_id}/${row.plugin_id}@${row.plugin_version}`);
  return { ...row };
}

function decodeAttempt(row: AttemptRow): PluginRegistryUpdateAttemptRecord {
  return {
    seq: row.seq,
    attempt_id: row.attempt_id,
    registry_id: row.registry_id,
    operation: row.operation,
    status: row.status,
    ...(row.plugin_id === null ? {} : { plugin_id: row.plugin_id }),
    ...(row.from_version === null ? {} : { from_version: row.from_version }),
    ...(row.to_version === null ? {} : { to_version: row.to_version }),
    ...(row.index_sequence === null ? {} : { index_sequence: row.index_sequence }),
    ...(row.index_digest === null ? {} : { index_digest: row.index_digest }),
    ...(row.rollback_version === null ? {} : { rollback_version: row.rollback_version }),
    ...(row.error === null ? {} : { error: row.error }),
    created_at: row.created_at,
    completed_at: row.completed_at,
    data: parseJsonRow<Record<string, unknown>>(row.data_json),
  };
}

export function getPluginRegistrySource(registryId: string): PluginRegistrySourceRecord | undefined {
  const row = getDb().prepare(`
    SELECT registry_id, source_url, root_key_id, last_sequence, last_index_digest,
           last_issued_at, last_expires_at, last_synced_at, created_at, updated_at
    FROM plugin_registry_sources WHERE registry_id = ?
  `).get(assertRegistryId(registryId)) as SourceRow | undefined;
  return row ? decodeSource(row) : undefined;
}

export function listPluginRegistrySources(): PluginRegistrySourceRecord[] {
  return (getDb().prepare(`
    SELECT registry_id, source_url, root_key_id, last_sequence, last_index_digest,
           last_issued_at, last_expires_at, last_synced_at, created_at, updated_at
    FROM plugin_registry_sources ORDER BY registry_id
  `).all() as SourceRow[]).map(decodeSource);
}

function insertAttempt(input: {
  registry_id: string;
  operation: PluginRegistryOperation;
  status: "succeeded" | "failed";
  plugin_id?: string;
  from_version?: string;
  to_version?: string;
  index_sequence?: number;
  index_digest?: string;
  rollback_version?: string;
  error?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}): PluginRegistryUpdateAttemptRecord {
  const attemptId = randomUUID();
  getDb().prepare(`
    INSERT INTO plugin_registry_update_attempts(
      attempt_id, registry_id, operation, status, plugin_id, from_version, to_version,
      index_sequence, index_digest, rollback_version, error,
      created_at, completed_at, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attemptId,
    input.registry_id,
    input.operation,
    input.status,
    input.plugin_id ?? null,
    input.from_version ?? null,
    input.to_version ?? null,
    input.index_sequence ?? null,
    input.index_digest ?? null,
    input.rollback_version ?? null,
    input.error ?? null,
    input.timestamp,
    input.timestamp,
    encodeJson(input.data ?? {}),
  );
  return decodeAttempt(getDb().prepare(`
    SELECT seq, attempt_id, registry_id, operation, status, plugin_id, from_version,
           to_version, index_sequence, index_digest, rollback_version, error,
           created_at, completed_at, data_json
    FROM plugin_registry_update_attempts WHERE attempt_id = ?
  `).get(attemptId) as AttemptRow);
}

export function configurePluginRegistrySource(input: {
  registry_id: string;
  source_url: string;
  root_key_id: string;
  timestamp?: string;
}): PluginRegistrySourceRecord {
  const registryId = assertRegistryId(input.registry_id);
  const sourceUrl = normalizePluginRegistrySourceUrl(input.source_url);
  if (!KEY_ID.test(input.root_key_id)) throw new Error("Plugin registry root pin is invalid");
  const timestamp = input.timestamp ?? nowIso();
  return getDb().transaction(() => {
    const existing = getPluginRegistrySource(registryId);
    if (existing && existing.root_key_id !== input.root_key_id) {
      throw new Error("Plugin registry root pin is immutable");
    }
    if (!existing) {
      getDb().prepare(`
        INSERT INTO plugin_registry_sources(
          registry_id, source_url, root_key_id, last_sequence, last_index_digest,
          last_issued_at, last_expires_at, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?)
      `).run(registryId, sourceUrl, input.root_key_id, timestamp, timestamp);
    } else if (existing.source_url !== sourceUrl) {
      getDb().prepare(`
        UPDATE plugin_registry_sources SET source_url = ?, updated_at = ? WHERE registry_id = ?
      `).run(sourceUrl, timestamp, registryId);
    }
    insertAttempt({
      registry_id: registryId,
      operation: "configure",
      status: "succeeded",
      data: { source_url: sourceUrl, root_key_id: input.root_key_id },
      timestamp,
    });
    return getPluginRegistrySource(registryId)!;
  }).immediate();
}

export function commitPluginRegistryIndex(
  verified: VerifiedPluginRegistryIndex,
  timestamp: string = nowIso(),
): { source: PluginRegistrySourceRecord; releases: PluginRegistryReleaseRecord[] } {
  return getDb().transaction(() => {
    const source = getPluginRegistrySource(verified.index.registry_id);
    if (!source) throw new Error(`Plugin registry source is not configured: ${verified.index.registry_id}`);
    if (source.root_key_id !== verified.root_pin) throw new Error("Plugin registry root pin mismatch");
    if (verified.index.sequence <= source.last_sequence) {
      throw new Error("Plugin registry index sequence rollback or replay detected");
    }
    getDb().prepare("DELETE FROM plugin_registry_releases WHERE registry_id = ?").run(source.registry_id);
    const insert = getDb().prepare(`
      INSERT INTO plugin_registry_releases(
        registry_id, plugin_id, plugin_version, archive_path, archive_digest,
        payload_digest, publisher_key_id, index_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const release of verified.index.releases) {
      insert.run(
        source.registry_id,
        release.plugin_id,
        release.plugin_version,
        release.archive_path,
        release.archive_digest,
        release.payload_digest,
        release.publisher_key_id,
        verified.index.sequence,
        timestamp,
      );
    }
    getDb().prepare(`
      UPDATE plugin_registry_sources
      SET last_sequence = ?, last_index_digest = ?, last_issued_at = ?,
          last_expires_at = ?, last_synced_at = ?, updated_at = ?
      WHERE registry_id = ? AND last_sequence = ?
    `).run(
      verified.index.sequence,
      verified.index_digest,
      verified.index.issued_at,
      verified.index.expires_at,
      timestamp,
      timestamp,
      source.registry_id,
      source.last_sequence,
    );
    insertAttempt({
      registry_id: source.registry_id,
      operation: "sync",
      status: "succeeded",
      index_sequence: verified.index.sequence,
      index_digest: verified.index_digest,
      data: { release_count: verified.index.releases.length },
      timestamp,
    });
    return {
      source: getPluginRegistrySource(source.registry_id)!,
      releases: listPluginRegistryReleases(source.registry_id),
    };
  }).immediate();
}

export function recordPluginRegistryAttempt(input: {
  registry_id: string;
  operation: PluginRegistryOperation;
  status: "succeeded" | "failed";
  plugin_id?: string;
  from_version?: string;
  to_version?: string;
  index_sequence?: number;
  index_digest?: string;
  rollback_version?: string;
  error?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}): PluginRegistryUpdateAttemptRecord {
  assertRegistryId(input.registry_id);
  if (!getPluginRegistrySource(input.registry_id)) {
    throw new Error(`Plugin registry source is not configured: ${input.registry_id}`);
  }
  if (input.index_digest !== undefined && !SHA256.test(input.index_digest)) {
    throw new Error("Plugin registry attempt index digest is invalid");
  }
  if (input.status === "failed" && !input.error) {
    throw new Error("Failed plugin registry attempt requires an error");
  }
  const timestamp = input.timestamp ?? nowIso();
  return getDb().transaction(() => insertAttempt({ ...input, timestamp })).immediate();
}

export function listPluginRegistryReleases(
  registryId: string,
  pluginId?: string,
): PluginRegistryReleaseRecord[] {
  const rows = (pluginId
    ? getDb().prepare(`
        SELECT registry_id, plugin_id, plugin_version, archive_path, archive_digest,
               payload_digest, publisher_key_id, index_sequence, created_at
        FROM plugin_registry_releases
        WHERE registry_id = ? AND plugin_id = ?
        ORDER BY plugin_id, plugin_version
      `).all(assertRegistryId(registryId), pluginId)
    : getDb().prepare(`
        SELECT registry_id, plugin_id, plugin_version, archive_path, archive_digest,
               payload_digest, publisher_key_id, index_sequence, created_at
        FROM plugin_registry_releases
        WHERE registry_id = ? ORDER BY plugin_id, plugin_version
      `).all(assertRegistryId(registryId))) as ReleaseRow[];
  return rows.map(decodeRelease);
}

export function getPluginRegistryRelease(
  registryId: string,
  pluginId: string,
  pluginVersion: string,
): PluginRegistryReleaseRecord | undefined {
  const row = getDb().prepare(`
    SELECT registry_id, plugin_id, plugin_version, archive_path, archive_digest,
           payload_digest, publisher_key_id, index_sequence, created_at
    FROM plugin_registry_releases
    WHERE registry_id = ? AND plugin_id = ? AND plugin_version = ?
  `).get(assertRegistryId(registryId), pluginId, pluginVersion) as ReleaseRow | undefined;
  return row ? decodeRelease(row) : undefined;
}

export function listPluginRegistryUpdateAttempts(
  registryId: string,
  pluginId?: string,
): PluginRegistryUpdateAttemptRecord[] {
  const rows = (pluginId
    ? getDb().prepare(`
        SELECT seq, attempt_id, registry_id, operation, status, plugin_id, from_version,
               to_version, index_sequence, index_digest, rollback_version, error,
               created_at, completed_at, data_json
        FROM plugin_registry_update_attempts
        WHERE registry_id = ? AND plugin_id = ? ORDER BY seq
      `).all(assertRegistryId(registryId), pluginId)
    : getDb().prepare(`
        SELECT seq, attempt_id, registry_id, operation, status, plugin_id, from_version,
               to_version, index_sequence, index_digest, rollback_version, error,
               created_at, completed_at, data_json
        FROM plugin_registry_update_attempts
        WHERE registry_id = ? ORDER BY seq
      `).all(assertRegistryId(registryId))) as AttemptRow[];
  return rows.map(decodeAttempt);
}

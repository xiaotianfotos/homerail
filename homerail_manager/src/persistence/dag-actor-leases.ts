import { createHash } from "node:crypto";
import { redactTelemetry, type DagActorCheckpointV1 } from "homerail-protocol";

import {
  loadDagActorLeaseSettings,
  validateDagActorRetentionTtlMs,
  validateDagWorkerIdleTtlMs,
} from "../config/dag-actor-lease-settings.js";
import { getDb, parseJsonRow } from "./db.js";

export type { DagActorCheckpointV1 } from "homerail-protocol";

export const MAX_DAG_ACTOR_CHECKPOINT_BYTES = 256 * 1024;
export const MAX_DAG_ACTOR_CHECKPOINT_ITEMS = 128;
export const DEFAULT_DAG_ACTOR_LEASE_LIST_LIMIT = 100;
export const MAX_DAG_ACTOR_LEASE_LIST_LIMIT = 1_000;
export const MAX_DAG_PROVISIONED_WORKER_FAILURE_BYTES = 64 * 1024;

export type DagActorLeaseState = "leased" | "dormant" | "retired";
export type DagProvisionedWorkerStatus = "active" | "releasing" | "released" | "failed";

const LEASE_STATES: ReadonlySet<string> = new Set(["leased", "dormant", "retired"]);
const PROVISIONED_WORKER_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "releasing",
  "released",
  "failed",
]);

export interface DagActorLeaseRecord {
  run_id: string;
  actor_id: string;
  state: DagActorLeaseState;
  lease_generation: number;
  target_type?: string;
  target_id?: string;
  idle_deadline?: number;
  pinned: boolean;
  retained_until?: number;
  state_changed_at: number;
  created_at: number;
  updated_at: number;
  version: number;
}

export type DagActorLeaseAssessment =
  | { current: true; lease: DagActorLeaseRecord }
  | {
      current: false;
      reason: "missing" | "not_leased" | "generation_mismatch" | "target_mismatch" | "expired";
      lease?: DagActorLeaseRecord;
    };

export interface DagActorCheckpointRecord {
  run_id: string;
  actor_id: string;
  checkpoint_version: number;
  checkpoint_sha256: string;
  checkpoint: DagActorCheckpointV1;
  created_at: number;
}

export interface DagProvisionedWorkerRecord {
  run_id: string;
  node_id: string;
  actor_id: string;
  lease_generation: number;
  worker_id: string;
  container_id: string;
  docker_node_id: string;
  status: DagProvisionedWorkerStatus;
  registered_at: number;
  updated_at: number;
  release_requested_at?: number;
  terminal_at?: number;
  failure?: unknown;
  version: number;
}

export class DagActorLeaseConflictError extends Error {
  constructor(
    public readonly code:
      | "actor_not_found"
      | "lease_not_found"
      | "lease_retired"
      | "lease_version_conflict"
      | "lease_state_conflict"
      | "lease_generation_conflict"
      | "lease_target_conflict"
      | "lease_expired"
      | "checkpoint_version_conflict"
      | "checkpoint_generation_conflict"
      | "provisioned_worker_identity_conflict"
      | "provisioned_worker_version_conflict"
      | "provisioned_worker_status_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DagActorLeaseConflictError";
  }
}

interface DagActorLeaseRow {
  run_id: string;
  actor_id: string;
  state: string;
  lease_generation: number;
  target_type: string | null;
  target_id: string | null;
  idle_deadline: number | null;
  pinned: number;
  retained_until: number | null;
  state_changed_at: number;
  created_at: number;
  updated_at: number;
  version: number;
}

interface DagActorCheckpointRow {
  run_id: string;
  actor_id: string;
  checkpoint_version: number;
  schema_version: number;
  actor_generation: number;
  round_id: string;
  captured_at: number;
  checkpoint_sha256: string;
  checkpoint_json: string;
  created_at: number;
}

interface DagProvisionedWorkerRow {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  worker_id: string;
  node_id: string;
  container_id: string;
  docker_node_id: string;
  status: string;
  registered_at: number;
  updated_at: number;
  release_requested_at: number | null;
  terminal_at: number | null;
  failure_json: string | null;
  version: number;
}

function assertBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

function assertContentString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveSafeInteger(value: unknown, label: string): number {
  const normalized = assertNonNegativeSafeInteger(value, label);
  if (normalized < 1) throw new Error(`${label} must be a positive safe integer`);
  return normalized;
}

function assertOptionalExpectedVersion(value: number | undefined): number | undefined {
  return value === undefined ? undefined : assertPositiveSafeInteger(value, "expected_version");
}

function assertIncrementableVersion(value: number, label: string): void {
  assertPositiveSafeInteger(value + 1, label);
}

function assertNow(value: number | undefined): number {
  return assertNonNegativeSafeInteger(value ?? Date.now(), "now");
}

function assertMutationTime(now: number, updatedAt: number): void {
  if (now < updatedAt) throw new Error("now must not precede the persisted update timestamp");
}

function checkedDeadline(now: number, ttlMs: number, label: string): number {
  const deadline = now + ttlMs;
  if (!Number.isSafeInteger(deadline)) throw new Error(`${label} exceeds the safe timestamp range`);
  return deadline;
}

function idleTtl(value: number | undefined): number {
  return value === undefined
    ? loadDagActorLeaseSettings().worker_idle_ttl_ms
    : validateDagWorkerIdleTtlMs(value);
}

function retentionTtl(value: number | undefined): number {
  return value === undefined
    ? loadDagActorLeaseSettings().actor_retention_ttl_ms
    : validateDagActorRetentionTtlMs(value);
}

function normalizeListLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_DAG_ACTOR_LEASE_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DAG_ACTOR_LEASE_LIST_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_DAG_ACTOR_LEASE_LIST_LIMIT}`);
  }
  return limit;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) result[key] = canonicalize(nested);
    }
    return result;
  }
  return value;
}

function encodeCanonicalJson(value: unknown, label: string, maximumBytes: number): string {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (raw === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  const canonical = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(canonical, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return canonical;
}

function getLeaseRow(runId: string, actorId: string): DagActorLeaseRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_runtimes WHERE run_id = ? AND actor_id = ?")
    .get(runId, actorId) as DagActorLeaseRow | undefined;
}

function leaseFromRow(row: DagActorLeaseRow): DagActorLeaseRecord {
  if (!LEASE_STATES.has(row.state)) {
    throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has invalid state ${row.state}`);
  }
  const state = row.state as DagActorLeaseState;
  const leaseGeneration = assertNonNegativeSafeInteger(row.lease_generation, "persisted lease_generation");
  const createdAt = assertNonNegativeSafeInteger(row.created_at, "persisted created_at");
  const updatedAt = assertNonNegativeSafeInteger(row.updated_at, "persisted updated_at");
  const stateChangedAt = assertNonNegativeSafeInteger(row.state_changed_at, "persisted state_changed_at");
  const version = assertPositiveSafeInteger(row.version, "persisted version");
  if ((row.pinned !== 0 && row.pinned !== 1) || updatedAt < createdAt || stateChangedAt < createdAt || stateChangedAt > updatedAt) {
    throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has invalid persisted metadata`);
  }
  if (state === "leased") {
    if (
      leaseGeneration < 1
      || row.target_type === null
      || row.target_id === null
      || row.idle_deadline === null
      || row.retained_until !== null
    ) {
      throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has invalid leased state`);
    }
    const targetType = assertBoundedString(row.target_type, "persisted target_type", 64);
    const targetId = assertBoundedString(row.target_id, "persisted target_id", 512);
    const idleDeadline = assertNonNegativeSafeInteger(row.idle_deadline, "persisted idle_deadline");
    if (idleDeadline < stateChangedAt) {
      throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has an invalid idle deadline`);
    }
    return {
      run_id: row.run_id,
      actor_id: row.actor_id,
      state,
      lease_generation: leaseGeneration,
      target_type: targetType,
      target_id: targetId,
      idle_deadline: idleDeadline,
      pinned: row.pinned === 1,
      state_changed_at: stateChangedAt,
      created_at: createdAt,
      updated_at: updatedAt,
      version,
    };
  }
  if (row.target_type !== null || row.target_id !== null || row.idle_deadline !== null || row.retained_until === null) {
    throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has invalid ${state} state`);
  }
  const retainedUntil = assertNonNegativeSafeInteger(row.retained_until, "persisted retained_until");
  if (retainedUntil < updatedAt) {
    throw new Error(`DAG actor lease ${row.run_id}/${row.actor_id} has an invalid retention deadline`);
  }
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    state,
    lease_generation: leaseGeneration,
    pinned: row.pinned === 1,
    retained_until: retainedUntil,
    state_changed_at: stateChangedAt,
    created_at: createdAt,
    updated_at: updatedAt,
    version,
  };
}

function requireLease(runId: string, actorId: string): DagActorLeaseRecord {
  const row = getLeaseRow(runId, actorId);
  if (!row) {
    throw new DagActorLeaseConflictError("lease_not_found", `Unknown DAG actor lease: ${runId}/${actorId}`);
  }
  return leaseFromRow(row);
}

function assertExpectedVersion(lease: DagActorLeaseRecord, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && lease.version !== expectedVersion) {
    throw new DagActorLeaseConflictError(
      "lease_version_conflict",
      `DAG actor lease ${lease.run_id}/${lease.actor_id} version is ${lease.version}, expected ${expectedVersion}`,
    );
  }
}

function assertExactLease(
  lease: DagActorLeaseRecord,
  input: { lease_generation: number; target_type: string; target_id: string },
): void {
  if (lease.state !== "leased") {
    throw new DagActorLeaseConflictError(
      "lease_state_conflict",
      `DAG actor lease ${lease.run_id}/${lease.actor_id} is ${lease.state}, not leased`,
    );
  }
  if (lease.lease_generation !== input.lease_generation) {
    throw new DagActorLeaseConflictError(
      "lease_generation_conflict",
      `DAG actor lease ${lease.run_id}/${lease.actor_id} generation is ${lease.lease_generation}, expected ${input.lease_generation}`,
    );
  }
  if (lease.target_type !== input.target_type || lease.target_id !== input.target_id) {
    throw new DagActorLeaseConflictError(
      "lease_target_conflict",
      `DAG actor lease ${lease.run_id}/${lease.actor_id} belongs to another target`,
    );
  }
}

function ensureLeaseRow(input: {
  run_id: string;
  actor_id: string;
  pinned: boolean;
  now: number;
  retention_ttl_ms: number;
}): DagActorLeaseRecord {
  const existing = getLeaseRow(input.run_id, input.actor_id);
  if (existing) return leaseFromRow(existing);
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM dag_actors WHERE run_id = ? AND actor_id = ?").get(input.run_id, input.actor_id)) {
    throw new DagActorLeaseConflictError(
      "actor_not_found",
      `Unknown DAG actor: ${input.run_id}/${input.actor_id}`,
    );
  }
  const retainedUntil = checkedDeadline(input.now, input.retention_ttl_ms, "retained_until");
  db.prepare(`
    INSERT INTO dag_actor_runtimes(
      run_id, actor_id, state, lease_generation, target_type, target_id,
      idle_deadline, pinned, retained_until, state_changed_at, created_at,
      updated_at, version
    ) VALUES (?, ?, 'dormant', 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1)
  `).run(
    input.run_id,
    input.actor_id,
    input.pinned ? 1 : 0,
    retainedUntil,
    input.now,
    input.now,
    input.now,
  );
  return requireLease(input.run_id, input.actor_id);
}

export function ensureDagActorLease(input: {
  run_id: string;
  actor_id: string;
  pinned?: boolean;
  retention_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const now = assertNow(input.now);
  const actorRetentionTtl = retentionTtl(input.retention_ttl_ms);
  const db = getDb();
  return db.transaction(() => ensureLeaseRow({
    run_id: runId,
    actor_id: actorId,
    pinned: input.pinned ?? false,
    now,
    retention_ttl_ms: actorRetentionTtl,
  })).immediate();
}

export function getDagActorLease(input: {
  run_id: string;
  actor_id: string;
}): DagActorLeaseRecord | undefined {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const row = getLeaseRow(runId, actorId);
  return row ? leaseFromRow(row) : undefined;
}

export function acquireDagActorLease(input: {
  run_id: string;
  actor_id: string;
  target_type: string;
  target_id: string;
  expected_version?: number;
  idle_ttl_ms?: number;
  retention_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const targetType = assertBoundedString(input.target_type, "target_type", 64);
  const targetId = assertBoundedString(input.target_id, "target_id", 512);
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const now = assertNow(input.now);
  const workerIdleTtl = idleTtl(input.idle_ttl_ms);
  const actorRetentionTtl = retentionTtl(input.retention_ttl_ms);
  const requestedDeadline = checkedDeadline(now, workerIdleTtl, "idle_deadline");
  const db = getDb();

  return db.transaction(() => {
    const current = ensureLeaseRow({
      run_id: runId,
      actor_id: actorId,
      pinned: false,
      now,
      retention_ttl_ms: actorRetentionTtl,
    });
    if (current.state === "retired") {
      throw new DagActorLeaseConflictError("lease_retired", `DAG actor lease ${runId}/${actorId} is retired`);
    }
    assertExpectedVersion(current, expectedVersion);
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "lease version");
    const sameTarget = current.state === "leased"
      && current.target_type === targetType
      && current.target_id === targetId;
    const leaseGeneration = sameTarget
      ? current.lease_generation
      : assertPositiveSafeInteger(current.lease_generation + 1, "lease_generation");
    const deadline = sameTarget
      ? Math.max(current.idle_deadline ?? 0, requestedDeadline)
      : requestedDeadline;
    const changed = db.prepare(`
      UPDATE dag_actor_runtimes SET
        state = 'leased',
        lease_generation = ?,
        target_type = ?,
        target_id = ?,
        idle_deadline = ?,
        retained_until = NULL,
        state_changed_at = CASE WHEN ? THEN state_changed_at ELSE ? END,
        updated_at = ?,
        version = version + 1
      WHERE run_id = ? AND actor_id = ? AND version = ?
    `).run(
      leaseGeneration,
      targetType,
      targetId,
      deadline,
      sameTarget ? 1 : 0,
      now,
      now,
      runId,
      actorId,
      current.version,
    );
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return requireLease(runId, actorId);
  }).immediate();
}

export function renewDagActorLease(input: {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  target_type: string;
  target_id: string;
  expected_version?: number;
  idle_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const targetType = assertBoundedString(input.target_type, "target_type", 64);
  const targetId = assertBoundedString(input.target_id, "target_id", 512);
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const now = assertNow(input.now);
  const deadline = checkedDeadline(now, idleTtl(input.idle_ttl_ms), "idle_deadline");
  const db = getDb();

  return db.transaction(() => {
    const current = requireLease(runId, actorId);
    assertExpectedVersion(current, expectedVersion);
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "lease version");
    assertExactLease(current, {
      lease_generation: leaseGeneration,
      target_type: targetType,
      target_id: targetId,
    });
    if (!current.pinned && now >= current.idle_deadline!) {
      throw new DagActorLeaseConflictError("lease_expired", `DAG actor lease ${runId}/${actorId} has expired`);
    }
    const changed = db.prepare(`
      UPDATE dag_actor_runtimes SET idle_deadline = ?, updated_at = ?, version = version + 1
      WHERE run_id = ? AND actor_id = ? AND state = 'leased'
        AND lease_generation = ? AND target_type = ? AND target_id = ? AND version = ?
    `).run(
      Math.max(current.idle_deadline!, deadline),
      now,
      runId,
      actorId,
      leaseGeneration,
      targetType,
      targetId,
      current.version,
    );
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return requireLease(runId, actorId);
  }).immediate();
}

export function releaseDagActorLease(input: {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  target_type: string;
  target_id: string;
  expected_version?: number;
  retention_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const targetType = assertBoundedString(input.target_type, "target_type", 64);
  const targetId = assertBoundedString(input.target_id, "target_id", 512);
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const now = assertNow(input.now);
  const retainedUntil = checkedDeadline(now, retentionTtl(input.retention_ttl_ms), "retained_until");
  const db = getDb();

  return db.transaction(() => {
    const current = requireLease(runId, actorId);
    assertExpectedVersion(current, expectedVersion);
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "lease version");
    assertExactLease(current, {
      lease_generation: leaseGeneration,
      target_type: targetType,
      target_id: targetId,
    });
    const changed = db.prepare(`
      UPDATE dag_actor_runtimes SET
        state = 'dormant', target_type = NULL, target_id = NULL,
        idle_deadline = NULL, retained_until = ?, state_changed_at = ?,
        updated_at = ?, version = version + 1
      WHERE run_id = ? AND actor_id = ? AND state = 'leased'
        AND lease_generation = ? AND target_type = ? AND target_id = ? AND version = ?
    `).run(
      retainedUntil,
      now,
      now,
      runId,
      actorId,
      leaseGeneration,
      targetType,
      targetId,
      current.version,
    );
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return requireLease(runId, actorId);
  }).immediate();
}

export function setDagActorLeasePinned(input: {
  run_id: string;
  actor_id: string;
  pinned: boolean;
  expected_version?: number;
  retention_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  if (typeof input.pinned !== "boolean") throw new Error("pinned must be a boolean");
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const now = assertNow(input.now);
  const actorRetentionTtl = retentionTtl(input.retention_ttl_ms);
  const db = getDb();

  return db.transaction(() => {
    const current = requireLease(runId, actorId);
    assertExpectedVersion(current, expectedVersion);
    if (current.pinned === input.pinned) return current;
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "lease version");
    if (input.pinned && current.state === "leased" && now >= current.idle_deadline!) {
      throw new DagActorLeaseConflictError("lease_expired", `DAG actor lease ${runId}/${actorId} has expired`);
    }
    if (input.pinned && current.state !== "leased" && now >= current.retained_until!) {
      throw new DagActorLeaseConflictError(
        "lease_expired",
        `DAG actor lease ${runId}/${actorId} has exceeded its retention deadline`,
      );
    }
    const retainedUntil = current.state === "leased"
      ? null
      : input.pinned
        ? current.retained_until!
        : checkedDeadline(now, actorRetentionTtl, "retained_until");
    const changed = db.prepare(`
      UPDATE dag_actor_runtimes SET
        pinned = ?, retained_until = ?, updated_at = ?, version = version + 1
      WHERE run_id = ? AND actor_id = ? AND version = ?
    `).run(input.pinned ? 1 : 0, retainedUntil, now, runId, actorId, current.version);
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return requireLease(runId, actorId);
  }).immediate();
}

export function retireDagActorLease(input: {
  run_id: string;
  actor_id: string;
  expected_version?: number;
  lease_generation?: number;
  target_type?: string;
  target_id?: string;
  retention_ttl_ms?: number;
  now?: number;
}): DagActorLeaseRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const leaseGeneration = input.lease_generation === undefined
    ? undefined
    : assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const targetType = input.target_type === undefined
    ? undefined
    : assertBoundedString(input.target_type, "target_type", 64);
  const targetId = input.target_id === undefined
    ? undefined
    : assertBoundedString(input.target_id, "target_id", 512);
  const now = assertNow(input.now);
  const retainedUntil = checkedDeadline(now, retentionTtl(input.retention_ttl_ms), "retained_until");
  const db = getDb();

  return db.transaction(() => {
    const current = requireLease(runId, actorId);
    assertExpectedVersion(current, expectedVersion);
    if (current.state === "retired") return current;
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "lease version");
    if (current.state === "leased") {
      if (leaseGeneration === undefined || targetType === undefined || targetId === undefined) {
        throw new DagActorLeaseConflictError(
          "lease_target_conflict",
          "Retiring a leased actor requires the exact lease generation and target",
        );
      }
      assertExactLease(current, {
        lease_generation: leaseGeneration,
        target_type: targetType,
        target_id: targetId,
      });
    } else if (leaseGeneration !== undefined || targetType !== undefined || targetId !== undefined) {
      throw new DagActorLeaseConflictError(
        "lease_state_conflict",
        `DAG actor lease ${runId}/${actorId} is ${current.state} and has no current target`,
      );
    }
    const changed = db.prepare(`
      UPDATE dag_actor_runtimes SET
        state = 'retired', target_type = NULL, target_id = NULL,
        idle_deadline = NULL, retained_until = ?, state_changed_at = ?,
        updated_at = ?, version = version + 1
      WHERE run_id = ? AND actor_id = ? AND version = ? AND state != 'retired'
    `).run(retainedUntil, now, now, runId, actorId, current.version);
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return requireLease(runId, actorId);
  }).immediate();
}

export function assessDagActorLease(input: {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  target_type: string;
  target_id: string;
  now?: number;
}): DagActorLeaseAssessment {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const targetType = assertBoundedString(input.target_type, "target_type", 64);
  const targetId = assertBoundedString(input.target_id, "target_id", 512);
  const now = assertNow(input.now);
  const lease = getDagActorLease({ run_id: runId, actor_id: actorId });
  if (!lease) return { current: false, reason: "missing" };
  if (lease.state !== "leased") return { current: false, reason: "not_leased", lease };
  if (lease.lease_generation !== leaseGeneration) {
    return { current: false, reason: "generation_mismatch", lease };
  }
  if (lease.target_type !== targetType || lease.target_id !== targetId) {
    return { current: false, reason: "target_mismatch", lease };
  }
  if (!lease.pinned && now >= lease.idle_deadline!) {
    return { current: false, reason: "expired", lease };
  }
  return { current: true, lease };
}

export function listExpiredDagActorLeases(input: {
  now?: number;
  limit?: number;
} = {}): DagActorLeaseRecord[] {
  const now = assertNow(input.now);
  const limit = normalizeListLimit(input.limit);
  return (getDb().prepare(`
    SELECT * FROM dag_actor_runtimes
    WHERE state = 'leased' AND pinned = 0 AND idle_deadline <= ?
    ORDER BY idle_deadline, run_id, actor_id
    LIMIT ?
  `).all(now, limit) as DagActorLeaseRow[]).map(leaseFromRow);
}

function normalizeCheckpointStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_DAG_ACTOR_CHECKPOINT_ITEMS) {
    throw new Error(`${label} must contain at most ${MAX_DAG_ACTOR_CHECKPOINT_ITEMS} strings`);
  }
  return value.map((entry, index) => assertContentString(entry, `${label}[${index}]`, 8_192));
}

function normalizeCheckpoint(value: unknown): DagActorCheckpointV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkpoint must be an object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "schema_version",
    "objective",
    "confirmed_conclusions",
    "unresolved_items",
    "key_event_refs",
    "artifact_refs",
    "workspace_ref",
    "surface_binding",
    "context_summary",
    "round_id",
    "actor_generation",
    "captured_at",
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) throw new Error(`checkpoint has unknown fields: ${unknownKeys.sort().join(", ")}`);
  if (raw.schema_version !== 1) throw new Error("checkpoint.schema_version must equal 1");
  return {
    schema_version: 1,
    objective: assertContentString(raw.objective, "checkpoint.objective", 16_384),
    confirmed_conclusions: normalizeCheckpointStringArray(
      raw.confirmed_conclusions,
      "checkpoint.confirmed_conclusions",
    ),
    unresolved_items: normalizeCheckpointStringArray(raw.unresolved_items, "checkpoint.unresolved_items"),
    key_event_refs: normalizeCheckpointStringArray(raw.key_event_refs, "checkpoint.key_event_refs"),
    artifact_refs: normalizeCheckpointStringArray(raw.artifact_refs, "checkpoint.artifact_refs"),
    ...(raw.workspace_ref === undefined
      ? {}
      : { workspace_ref: assertBoundedString(raw.workspace_ref, "checkpoint.workspace_ref", 2_048) }),
    surface_binding: assertBoundedString(raw.surface_binding, "checkpoint.surface_binding", 2_048),
    context_summary: assertContentString(raw.context_summary, "checkpoint.context_summary", 65_536),
    round_id: assertBoundedString(raw.round_id, "checkpoint.round_id", 256),
    actor_generation: assertPositiveSafeInteger(raw.actor_generation, "checkpoint.actor_generation"),
    captured_at: assertNonNegativeSafeInteger(raw.captured_at, "checkpoint.captured_at"),
  };
}

function encodeCheckpoint(value: DagActorCheckpointV1): {
  checkpoint: DagActorCheckpointV1;
  json: string;
  sha256: string;
} {
  const raw = encodeCanonicalJson(value, "checkpoint", MAX_DAG_ACTOR_CHECKPOINT_BYTES);
  const redacted = redactTelemetry(parseJsonRow<unknown>(raw));
  const checkpoint = normalizeCheckpoint(redacted);
  const json = encodeCanonicalJson(checkpoint, "checkpoint", MAX_DAG_ACTOR_CHECKPOINT_BYTES);
  return {
    checkpoint,
    json,
    sha256: createHash("sha256").update(json).digest("hex"),
  };
}

function checkpointFromRow(row: DagActorCheckpointRow): DagActorCheckpointRecord {
  const checkpointVersion = assertPositiveSafeInteger(row.checkpoint_version, "persisted checkpoint_version");
  const createdAt = assertNonNegativeSafeInteger(row.created_at, "persisted checkpoint created_at");
  const parsed = parseJsonRow<unknown>(row.checkpoint_json);
  const checkpoint = normalizeCheckpoint(parsed);
  const canonicalJson = encodeCanonicalJson(checkpoint, "persisted checkpoint", MAX_DAG_ACTOR_CHECKPOINT_BYTES);
  const sha256 = createHash("sha256").update(canonicalJson).digest("hex");
  if (canonicalJson !== row.checkpoint_json || sha256 !== row.checkpoint_sha256) {
    throw new Error(`DAG actor checkpoint ${row.run_id}/${row.actor_id}/${checkpointVersion} failed integrity validation`);
  }
  if (
    row.schema_version !== checkpoint.schema_version
    || row.actor_generation !== checkpoint.actor_generation
    || row.round_id !== checkpoint.round_id
    || row.captured_at !== checkpoint.captured_at
  ) {
    throw new Error(`DAG actor checkpoint ${row.run_id}/${row.actor_id}/${checkpointVersion} metadata is inconsistent`);
  }
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    checkpoint_version: checkpointVersion,
    checkpoint_sha256: row.checkpoint_sha256,
    checkpoint,
    created_at: createdAt,
  };
}

export function writeDagActorCheckpoint(input: {
  run_id: string;
  actor_id: string;
  checkpoint: DagActorCheckpointV1;
  expected_checkpoint_version?: number;
  now?: number;
}): DagActorCheckpointRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const expectedCheckpointVersion = input.expected_checkpoint_version === undefined
    ? undefined
    : assertNonNegativeSafeInteger(input.expected_checkpoint_version, "expected_checkpoint_version");
  const now = assertNow(input.now);
  const encoded = encodeCheckpoint(input.checkpoint);
  if (encoded.checkpoint.captured_at > now) {
    throw new Error("checkpoint.captured_at must not be in the future");
  }
  const db = getDb();

  return db.transaction(() => {
    const actor = db.prepare("SELECT generation FROM dag_actors WHERE run_id = ? AND actor_id = ?")
      .get(runId, actorId) as { generation: number } | undefined;
    if (!actor) {
      throw new DagActorLeaseConflictError("actor_not_found", `Unknown DAG actor: ${runId}/${actorId}`);
    }
    const actorGeneration = assertPositiveSafeInteger(actor.generation, "persisted actor generation");
    if (actorGeneration !== encoded.checkpoint.actor_generation) {
      throw new DagActorLeaseConflictError(
        "checkpoint_generation_conflict",
        `Checkpoint generation ${encoded.checkpoint.actor_generation} does not match actor generation ${actorGeneration}`,
      );
    }
    const latest = db.prepare(`
      SELECT checkpoint_version, captured_at, created_at
      FROM dag_actor_checkpoints
      WHERE run_id = ? AND actor_id = ?
      ORDER BY checkpoint_version DESC
      LIMIT 1
    `).get(runId, actorId) as {
      checkpoint_version: number;
      captured_at: number;
      created_at: number;
    } | undefined;
    const currentVersion = latest === undefined
      ? 0
      : assertPositiveSafeInteger(latest.checkpoint_version, "persisted checkpoint_version");
    if (latest !== undefined) {
      const latestCapturedAt = assertNonNegativeSafeInteger(latest.captured_at, "persisted captured_at");
      const latestCreatedAt = assertNonNegativeSafeInteger(latest.created_at, "persisted checkpoint created_at");
      if (encoded.checkpoint.captured_at < latestCapturedAt) {
        throw new Error("checkpoint.captured_at must not precede the latest checkpoint");
      }
      if (now < latestCreatedAt) throw new Error("now must not precede the latest checkpoint write");
    }
    if (expectedCheckpointVersion !== undefined && currentVersion !== expectedCheckpointVersion) {
      throw new DagActorLeaseConflictError(
        "checkpoint_version_conflict",
        `Latest checkpoint version is ${currentVersion}, expected ${expectedCheckpointVersion}`,
      );
    }
    const checkpointVersion = assertPositiveSafeInteger(currentVersion + 1, "checkpoint_version");
    db.prepare(`
      INSERT INTO dag_actor_checkpoints(
        run_id, actor_id, checkpoint_version, schema_version, actor_generation,
        round_id, captured_at, checkpoint_sha256, checkpoint_json, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      actorId,
      checkpointVersion,
      encoded.checkpoint.actor_generation,
      encoded.checkpoint.round_id,
      encoded.checkpoint.captured_at,
      encoded.sha256,
      encoded.json,
      now,
    );
    const row = db.prepare(`
      SELECT * FROM dag_actor_checkpoints
      WHERE run_id = ? AND actor_id = ? AND checkpoint_version = ?
    `).get(runId, actorId, checkpointVersion) as DagActorCheckpointRow;
    return checkpointFromRow(row);
  }).immediate();
}

export function getLatestDagActorCheckpoint(input: {
  run_id: string;
  actor_id: string;
}): DagActorCheckpointRecord | undefined {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const row = getDb().prepare(`
    SELECT * FROM dag_actor_checkpoints
    WHERE run_id = ? AND actor_id = ?
    ORDER BY checkpoint_version DESC
    LIMIT 1
  `).get(runId, actorId) as DagActorCheckpointRow | undefined;
  return row ? checkpointFromRow(row) : undefined;
}

export function deleteExpiredDagActorRuntime(input: {
  run_id: string;
  actor_id: string;
  now?: number;
}): {
  deleted: boolean;
  deleted_checkpoints: number;
  reason?: "missing" | "leased" | "pinned" | "retained" | "worker_cleanup_pending";
} {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const now = assertNow(input.now);
  const db = getDb();

  return db.transaction(() => {
    const current = getDagActorLease({ run_id: runId, actor_id: actorId });
    if (!current) return { deleted: false, deleted_checkpoints: 0, reason: "missing" as const };
    if (current.state === "leased") return { deleted: false, deleted_checkpoints: 0, reason: "leased" as const };
    if (current.pinned) return { deleted: false, deleted_checkpoints: 0, reason: "pinned" as const };
    if (current.retained_until! > now) {
      return { deleted: false, deleted_checkpoints: 0, reason: "retained" as const };
    }
    const pendingWorker = db.prepare(`
      SELECT 1 FROM dag_actor_provisioned_workers
      WHERE run_id = ? AND actor_id = ? AND status != 'released'
      LIMIT 1
    `).get(runId, actorId);
    if (pendingWorker) {
      return { deleted: false, deleted_checkpoints: 0, reason: "worker_cleanup_pending" as const };
    }
    const checkpointCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM dag_actor_checkpoints WHERE run_id = ? AND actor_id = ?
    `).get(runId, actorId) as { count: number }).count);
    const deleted = db.prepare(`
      DELETE FROM dag_actors
      WHERE run_id = ? AND actor_id = ?
        AND EXISTS (
          SELECT 1 FROM dag_actor_runtimes runtime
          WHERE runtime.run_id = dag_actors.run_id
            AND runtime.actor_id = dag_actors.actor_id
            AND runtime.state IN ('dormant', 'retired')
            AND runtime.pinned = 0
            AND runtime.retained_until <= ?
            AND runtime.version = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM dag_actor_provisioned_workers worker
          WHERE worker.run_id = dag_actors.run_id
            AND worker.actor_id = dag_actors.actor_id
            AND worker.status != 'released'
        )
    `).run(runId, actorId, now, current.version);
    if (deleted.changes !== 1) {
      throw new DagActorLeaseConflictError("lease_version_conflict", `DAG actor lease ${runId}/${actorId} changed concurrently`);
    }
    return { deleted: true, deleted_checkpoints: checkpointCount };
  }).immediate();
}

function getProvisionedWorkerRow(input: {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  worker_id: string;
}): DagProvisionedWorkerRow | undefined {
  return getDb().prepare(`
    SELECT * FROM dag_actor_provisioned_workers
    WHERE run_id = ? AND actor_id = ? AND lease_generation = ? AND worker_id = ?
  `).get(input.run_id, input.actor_id, input.lease_generation, input.worker_id) as
    | DagProvisionedWorkerRow
    | undefined;
}

function provisionedWorkerFromRow(row: DagProvisionedWorkerRow): DagProvisionedWorkerRecord {
  if (!PROVISIONED_WORKER_STATUSES.has(row.status)) {
    throw new Error(`Provisioned worker ${row.worker_id} has invalid status ${row.status}`);
  }
  const status = row.status as DagProvisionedWorkerStatus;
  const leaseGeneration = assertPositiveSafeInteger(row.lease_generation, "persisted lease_generation");
  const registeredAt = assertNonNegativeSafeInteger(row.registered_at, "persisted registered_at");
  const updatedAt = assertNonNegativeSafeInteger(row.updated_at, "persisted updated_at");
  const version = assertPositiveSafeInteger(row.version, "persisted version");
  if (updatedAt < registeredAt) throw new Error(`Provisioned worker ${row.worker_id} has invalid timestamps`);
  const releaseRequestedAt = row.release_requested_at === null
    ? undefined
    : assertNonNegativeSafeInteger(row.release_requested_at, "persisted release_requested_at");
  const terminalAt = row.terminal_at === null
    ? undefined
    : assertNonNegativeSafeInteger(row.terminal_at, "persisted terminal_at");
  const failure = row.failure_json === null ? undefined : parseJsonRow<unknown>(row.failure_json);
  if (row.failure_json !== null) {
    if (failure === null) throw new Error(`Provisioned worker ${row.worker_id} has invalid failure data`);
    const canonicalFailure = encodeCanonicalJson(
      failure,
      "persisted provisioned worker failure",
      MAX_DAG_PROVISIONED_WORKER_FAILURE_BYTES,
    );
    if (canonicalFailure !== row.failure_json) {
      throw new Error(`Provisioned worker ${row.worker_id} has non-canonical failure data`);
    }
  }
  const coherent =
    (status === "active" && releaseRequestedAt === undefined && terminalAt === undefined && failure === undefined)
    || (status === "releasing" && releaseRequestedAt !== undefined && terminalAt === undefined && failure === undefined)
    || (status === "released" && releaseRequestedAt !== undefined && terminalAt !== undefined && failure === undefined)
    || (status === "failed" && terminalAt !== undefined && failure !== undefined);
  if (!coherent) throw new Error(`Provisioned worker ${row.worker_id} has incoherent lifecycle data`);
  return {
    run_id: row.run_id,
    node_id: assertBoundedString(row.node_id, "persisted node_id", 256),
    actor_id: row.actor_id,
    lease_generation: leaseGeneration,
    worker_id: assertBoundedString(row.worker_id, "persisted worker_id", 256),
    container_id: assertBoundedString(row.container_id, "persisted container_id", 512),
    docker_node_id: assertBoundedString(row.docker_node_id, "persisted docker_node_id", 256),
    status,
    registered_at: registeredAt,
    updated_at: updatedAt,
    ...(releaseRequestedAt === undefined ? {} : { release_requested_at: releaseRequestedAt }),
    ...(terminalAt === undefined ? {} : { terminal_at: terminalAt }),
    ...(failure === undefined ? {} : { failure }),
    version,
  };
}

export function registerDagProvisionedWorker(input: {
  run_id: string;
  node_id: string;
  actor_id: string;
  lease_generation: number;
  worker_id: string;
  container_id: string;
  docker_node_id: string;
  now?: number;
}): DagProvisionedWorkerRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const nodeId = assertBoundedString(input.node_id, "node_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const workerId = assertBoundedString(input.worker_id, "worker_id", 256);
  const containerId = assertBoundedString(input.container_id, "container_id", 512);
  const dockerNodeId = assertBoundedString(input.docker_node_id, "docker_node_id", 256);
  const now = assertNow(input.now);
  const db = getDb();

  return db.transaction(() => {
    const actor = db.prepare("SELECT node_id FROM dag_actors WHERE run_id = ? AND actor_id = ?")
      .get(runId, actorId) as { node_id: string } | undefined;
    if (!actor) {
      throw new DagActorLeaseConflictError("actor_not_found", `Unknown DAG actor: ${runId}/${actorId}`);
    }
    if (actor.node_id !== nodeId) {
      throw new DagActorLeaseConflictError(
        "provisioned_worker_identity_conflict",
        `DAG actor ${runId}/${actorId} belongs to node ${actor.node_id}, not ${nodeId}`,
      );
    }
    const lease = requireLease(runId, actorId);
    assertMutationTime(now, lease.updated_at);
    if (lease.state !== "leased") {
      throw new DagActorLeaseConflictError("lease_state_conflict", `DAG actor lease ${runId}/${actorId} is not leased`);
    }
    if (lease.lease_generation !== leaseGeneration) {
      throw new DagActorLeaseConflictError(
        "lease_generation_conflict",
        `DAG actor lease ${runId}/${actorId} generation is ${lease.lease_generation}, expected ${leaseGeneration}`,
      );
    }
    if (lease.target_id !== workerId) {
      throw new DagActorLeaseConflictError(
        "lease_target_conflict",
        `DAG actor lease ${runId}/${actorId} targets ${lease.target_id}, not worker ${workerId}`,
      );
    }
    if (!lease.pinned && now >= lease.idle_deadline!) {
      throw new DagActorLeaseConflictError("lease_expired", `DAG actor lease ${runId}/${actorId} has expired`);
    }
    const existing = getProvisionedWorkerRow({
      run_id: runId,
      actor_id: actorId,
      lease_generation: leaseGeneration,
      worker_id: workerId,
    });
    if (existing) {
      if (
        existing.node_id !== nodeId
        || existing.container_id !== containerId
        || existing.docker_node_id !== dockerNodeId
      ) {
        throw new DagActorLeaseConflictError(
          "provisioned_worker_identity_conflict",
          `Provisioned worker ${workerId} is already registered with different ownership`,
        );
      }
      return provisionedWorkerFromRow(existing);
    }
    try {
      db.prepare(`
        INSERT INTO dag_actor_provisioned_workers(
          run_id, actor_id, lease_generation, worker_id, node_id, container_id,
          docker_node_id, status, registered_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(
        runId,
        actorId,
        leaseGeneration,
        workerId,
        nodeId,
        containerId,
        dockerNodeId,
        now,
        now,
      );
    } catch (cause) {
      if (!(cause instanceof Error) || !cause.message.includes("UNIQUE constraint failed")) throw cause;
      throw new DagActorLeaseConflictError(
        "provisioned_worker_identity_conflict",
        `Provisioned worker ${workerId} conflicts with existing ownership: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return provisionedWorkerFromRow(getProvisionedWorkerRow({
      run_id: runId,
      actor_id: actorId,
      lease_generation: leaseGeneration,
      worker_id: workerId,
    })!);
  }).immediate();
}

export function listDagProvisionedWorkers(input: {
  run_id?: string;
  actor_id?: string;
  lease_generation?: number;
  statuses?: readonly DagProvisionedWorkerStatus[];
  limit?: number;
} = {}): DagProvisionedWorkerRecord[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (input.run_id !== undefined) {
    conditions.push("run_id = ?");
    params.push(assertBoundedString(input.run_id, "run_id", 256));
  }
  if (input.actor_id !== undefined) {
    conditions.push("actor_id = ?");
    params.push(assertBoundedString(input.actor_id, "actor_id", 256));
  }
  if (input.lease_generation !== undefined) {
    conditions.push("lease_generation = ?");
    params.push(assertPositiveSafeInteger(input.lease_generation, "lease_generation"));
  }
  if (input.statuses !== undefined) {
    const statuses = Array.from(new Set(input.statuses));
    if (statuses.length < 1 || statuses.some((status) => !PROVISIONED_WORKER_STATUSES.has(status))) {
      throw new Error("statuses must contain one or more valid provisioned worker statuses");
    }
    conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  params.push(normalizeListLimit(input.limit));
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  return (getDb().prepare(`
    SELECT * FROM dag_actor_provisioned_workers
    ${where}
    ORDER BY registered_at, run_id, actor_id, lease_generation, worker_id
    LIMIT ?
  `).all(...params) as DagProvisionedWorkerRow[]).map(provisionedWorkerFromRow);
}

export function transitionDagProvisionedWorker(input: {
  run_id: string;
  actor_id: string;
  lease_generation: number;
  worker_id: string;
  expected_status: DagProvisionedWorkerStatus;
  status: DagProvisionedWorkerStatus;
  expected_version?: number;
  failure?: unknown;
  now?: number;
}): DagProvisionedWorkerRecord {
  const runId = assertBoundedString(input.run_id, "run_id", 256);
  const actorId = assertBoundedString(input.actor_id, "actor_id", 256);
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const workerId = assertBoundedString(input.worker_id, "worker_id", 256);
  if (!PROVISIONED_WORKER_STATUSES.has(input.expected_status)) throw new Error("expected_status is invalid");
  if (!PROVISIONED_WORKER_STATUSES.has(input.status)) throw new Error("status is invalid");
  const expectedVersion = assertOptionalExpectedVersion(input.expected_version);
  const now = assertNow(input.now);
  const allowed = new Set([
    "active:releasing",
    "active:failed",
    "releasing:released",
    "releasing:failed",
    "failed:releasing",
  ]);
  if (!allowed.has(`${input.expected_status}:${input.status}`)) {
    throw new DagActorLeaseConflictError(
      "provisioned_worker_status_conflict",
      `Invalid provisioned worker transition ${input.expected_status} -> ${input.status}`,
    );
  }
  if (input.status === "failed" && (input.failure === undefined || input.failure === null)) {
    throw new Error("failure is required when transitioning a provisioned worker to failed");
  }
  if (input.status !== "failed" && input.failure !== undefined) {
    throw new Error("failure is only valid when transitioning a provisioned worker to failed");
  }
  const failureJson = input.status === "failed"
    ? encodeCanonicalJson(
        redactTelemetry(input.failure),
        "provisioned worker failure",
        MAX_DAG_PROVISIONED_WORKER_FAILURE_BYTES,
      )
    : null;
  const db = getDb();

  return db.transaction(() => {
    const row = getProvisionedWorkerRow({
      run_id: runId,
      actor_id: actorId,
      lease_generation: leaseGeneration,
      worker_id: workerId,
    });
    if (!row) {
      throw new DagActorLeaseConflictError(
        "provisioned_worker_identity_conflict",
        `Unknown provisioned worker: ${runId}/${actorId}/${leaseGeneration}/${workerId}`,
      );
    }
    const current = provisionedWorkerFromRow(row);
    if (current.status !== input.expected_status) {
      throw new DagActorLeaseConflictError(
        "provisioned_worker_status_conflict",
        `Provisioned worker ${workerId} is ${current.status}, expected ${input.expected_status}`,
      );
    }
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new DagActorLeaseConflictError(
        "provisioned_worker_version_conflict",
        `Provisioned worker ${workerId} version is ${current.version}, expected ${expectedVersion}`,
      );
    }
    assertMutationTime(now, current.updated_at);
    assertIncrementableVersion(current.version, "provisioned worker version");
    const releaseRequestedAt = input.status === "releasing"
      ? now
      : current.release_requested_at ?? null;
    const terminalAt = input.status === "released" || input.status === "failed" ? now : null;
    const changed = db.prepare(`
      UPDATE dag_actor_provisioned_workers SET
        status = ?, release_requested_at = ?, terminal_at = ?, failure_json = ?,
        updated_at = ?, version = version + 1
      WHERE run_id = ? AND actor_id = ? AND lease_generation = ?
        AND worker_id = ? AND status = ? AND version = ?
    `).run(
      input.status,
      releaseRequestedAt,
      terminalAt,
      failureJson,
      now,
      runId,
      actorId,
      leaseGeneration,
      workerId,
      input.expected_status,
      current.version,
    );
    if (changed.changes !== 1) {
      throw new DagActorLeaseConflictError(
        "provisioned_worker_status_conflict",
        `Provisioned worker ${workerId} changed concurrently`,
      );
    }
    return provisionedWorkerFromRow(getProvisionedWorkerRow({
      run_id: runId,
      actor_id: actorId,
      lease_generation: leaseGeneration,
      worker_id: workerId,
    })!);
  }).immediate();
}

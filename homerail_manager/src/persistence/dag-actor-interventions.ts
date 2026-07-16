import { createHash } from "node:crypto";
import { redactTelemetry } from "homerail-protocol";
import { getDagActor } from "./dag-actors.js";
import { getDb, parseJsonRow } from "./db.js";

export const DAG_ACTOR_INTERVENTION_OPERATIONS = [
  "interrupt",
  "cancel",
  "retry",
  "reassign",
  "checkpoint_fork",
] as const;
export type DagActorInterventionOperation = typeof DAG_ACTOR_INTERVENTION_OPERATIONS[number];
export type DagActorInterventionStatus = "queued" | "applying" | "applied" | "failed";

export interface DagActorInterventionRecord {
  intervention_id: string;
  run_id: string;
  actor_id: string;
  operation: DagActorInterventionOperation;
  status: DagActorInterventionStatus;
  idempotency_key: string;
  instruction?: string;
  expected_actor_generation: number;
  expected_actor_version: number;
  checkpoint_version?: number;
  from_generation?: number;
  to_generation?: number;
  resulting_actor_version?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  failure?: unknown;
}

export interface DagActorDispatchExclusionRecord {
  run_id: string;
  actor_id: string;
  node_id: string;
  target_type: "worker" | "node";
  target_id: string;
  intervention_id: string;
  created_at: number;
}

export interface DagSurfaceGenerationSnapshotRecord {
  run_id: string;
  actor_id: string;
  generation: number;
  node_id: string;
  surface_id: string;
  document_id: string;
  node_revision: number;
  document_revision: number;
  surface_revision: number;
  activity_state: string;
  visibility_state: string;
  last_event_id?: string;
  node_snapshot: unknown;
  superseded_by_generation: number;
  intervention_id: string;
  created_at: number;
}

export class DagActorInterventionConflictError extends Error {
  constructor(
    public readonly code:
      | "intervention_identity_conflict"
      | "intervention_in_progress"
      | "actor_generation_conflict"
      | "actor_version_conflict"
      | "intervention_status_conflict"
      | "snapshot_identity_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DagActorInterventionConflictError";
  }
}

interface InterventionRow {
  intervention_id: string;
  run_id: string;
  actor_id: string;
  operation: DagActorInterventionOperation;
  status: DagActorInterventionStatus;
  idempotency_key: string;
  payload_digest: string;
  payload_json: string;
  expected_actor_generation: number;
  expected_actor_version: number;
  checkpoint_version: number | null;
  from_generation: number | null;
  to_generation: number | null;
  resulting_actor_version: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  failure_json: string | null;
}

interface SnapshotRow {
  run_id: string;
  actor_id: string;
  generation: number;
  node_id: string;
  surface_id: string;
  document_id: string;
  node_revision: number;
  document_revision: number;
  surface_revision: number;
  activity_state: string;
  visibility_state: string;
  last_event_id: string | null;
  node_snapshot_sha256: string;
  node_snapshot_json: string;
  superseded_by_generation: number;
  intervention_id: string;
  created_at: number;
}

interface DispatchExclusionRow {
  run_id: string;
  actor_id: string;
  node_id: string;
  target_type: "worker" | "node";
  target_id: string;
  intervention_id: string;
  created_at: number;
}

function assertIdentifier(value: string, label: string, maxLength = 256): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be between 1 and ${maxLength} printable characters`);
  }
  return normalized;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function assertTimestamp(value: number | undefined, label: string): number {
  const normalized = value ?? Date.now();
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative epoch millisecond integer`);
  }
  return normalized;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) output[key] = canonicalize(nested);
    }
    return output;
  }
  return value;
}

function encodeBounded(value: unknown, label: string, maxBytes: number): { json: string; digest: string } {
  let redacted: unknown;
  try {
    redacted = canonicalize(redactTelemetry(value));
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  const json = JSON.stringify(redacted);
  if (!json || Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return { json, digest: createHash("sha256").update(json).digest("hex") };
}

function normalizeInstruction(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 4_096) {
    throw new Error("instruction must be between 1 and 4096 characters when provided");
  }
  return normalized;
}

function interventionFromRow(row: InterventionRow): DagActorInterventionRecord {
  const payload = parseJsonRow<{ instruction?: unknown }>(row.payload_json);
  return {
    intervention_id: row.intervention_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    operation: row.operation,
    status: row.status,
    idempotency_key: row.idempotency_key,
    ...(typeof payload.instruction === "string" ? { instruction: payload.instruction } : {}),
    expected_actor_generation: Number(row.expected_actor_generation),
    expected_actor_version: Number(row.expected_actor_version),
    ...(row.checkpoint_version === null ? {} : { checkpoint_version: Number(row.checkpoint_version) }),
    ...(row.from_generation === null ? {} : { from_generation: Number(row.from_generation) }),
    ...(row.to_generation === null ? {} : { to_generation: Number(row.to_generation) }),
    ...(row.resulting_actor_version === null ? {} : { resulting_actor_version: Number(row.resulting_actor_version) }),
    created_at: Number(row.created_at),
    ...(row.started_at === null ? {} : { started_at: Number(row.started_at) }),
    ...(row.completed_at === null ? {} : { completed_at: Number(row.completed_at) }),
    ...(row.failure_json === null ? {} : { failure: parseJsonRow(row.failure_json) }),
  };
}

function snapshotFromRow(row: SnapshotRow): DagSurfaceGenerationSnapshotRecord {
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    generation: Number(row.generation),
    node_id: row.node_id,
    surface_id: row.surface_id,
    document_id: row.document_id,
    node_revision: Number(row.node_revision),
    document_revision: Number(row.document_revision),
    surface_revision: Number(row.surface_revision),
    activity_state: row.activity_state,
    visibility_state: row.visibility_state,
    ...(row.last_event_id === null ? {} : { last_event_id: row.last_event_id }),
    node_snapshot: parseJsonRow(row.node_snapshot_json),
    superseded_by_generation: Number(row.superseded_by_generation),
    intervention_id: row.intervention_id,
    created_at: Number(row.created_at),
  };
}

function dispatchExclusionFromRow(row: DispatchExclusionRow): DagActorDispatchExclusionRecord {
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    target_type: row.target_type,
    target_id: row.target_id,
    intervention_id: row.intervention_id,
    created_at: Number(row.created_at),
  };
}

function interventionRowById(interventionId: string): InterventionRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_interventions WHERE intervention_id = ?")
    .get(interventionId) as InterventionRow | undefined;
}

function sameIntervention(
  row: InterventionRow,
  input: {
    intervention_id: string;
    run_id: string;
    actor_id: string;
    operation: DagActorInterventionOperation;
    idempotency_key: string;
    payload_digest: string;
    expected_actor_generation: number;
    expected_actor_version: number;
    checkpoint_version?: number;
  },
): boolean {
  return row.intervention_id === input.intervention_id
    && row.run_id === input.run_id
    && row.actor_id === input.actor_id
    && row.operation === input.operation
    && row.idempotency_key === input.idempotency_key
    && row.payload_digest === input.payload_digest
    && row.expected_actor_generation === input.expected_actor_generation
    && row.expected_actor_version === input.expected_actor_version
    && row.checkpoint_version === (input.checkpoint_version ?? null);
}

export function createDagActorIntervention(input: {
  intervention_id: string;
  run_id: string;
  actor_id: string;
  operation: DagActorInterventionOperation;
  instruction?: string;
  expected_actor_generation: number;
  expected_actor_version: number;
  idempotency_key: string;
  checkpoint_version?: number;
  created_at?: number;
}): { intervention: DagActorInterventionRecord; changed: boolean; deduplicated: boolean } {
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  if (!DAG_ACTOR_INTERVENTION_OPERATIONS.includes(input.operation)) throw new Error("invalid intervention operation");
  const instruction = normalizeInstruction(input.instruction);
  const expectedGeneration = assertPositiveInteger(input.expected_actor_generation, "expected_actor_generation");
  const expectedVersion = assertPositiveInteger(input.expected_actor_version, "expected_actor_version");
  const idempotencyKey = assertIdentifier(input.idempotency_key, "idempotency_key");
  const checkpointVersion = input.checkpoint_version === undefined
    ? undefined
    : assertPositiveInteger(input.checkpoint_version, "checkpoint_version");
  if (input.operation === "checkpoint_fork" ? checkpointVersion === undefined : checkpointVersion !== undefined) {
    throw new Error("checkpoint_version is required only for checkpoint_fork");
  }
  const createdAt = assertTimestamp(input.created_at, "created_at");
  const payload = encodeBounded(instruction === undefined ? {} : { instruction }, "intervention payload", 65_536);
  const normalized = {
    intervention_id: interventionId,
    run_id: runId,
    actor_id: actorId,
    operation: input.operation,
    idempotency_key: idempotencyKey,
    payload_digest: payload.digest,
    expected_actor_generation: expectedGeneration,
    expected_actor_version: expectedVersion,
    ...(checkpointVersion === undefined ? {} : { checkpoint_version: checkpointVersion }),
  };
  const db = getDb();
  return db.transaction(() => {
    const byId = interventionRowById(interventionId);
    const byKey = db.prepare(`
      SELECT * FROM dag_actor_interventions
      WHERE run_id = ? AND actor_id = ? AND idempotency_key = ?
    `).get(runId, actorId, idempotencyKey) as InterventionRow | undefined;
    const existing = byId ?? byKey;
    if (existing) {
      if (!sameIntervention(existing, normalized)) {
        throw new DagActorInterventionConflictError(
          "intervention_identity_conflict",
          `DAG actor intervention identity was reused with different content`,
        );
      }
      return { intervention: interventionFromRow(existing), changed: false, deduplicated: true };
    }
    const actor = getDagActor(runId, actorId);
    if (!actor) throw new Error(`Unknown DAG actor: ${runId}/${actorId}`);
    if (actor.generation !== expectedGeneration) {
      throw new DagActorInterventionConflictError(
        "actor_generation_conflict",
        `DAG actor ${runId}/${actorId} generation changed before intervention`,
      );
    }
    if (actor.version !== expectedVersion) {
      throw new DagActorInterventionConflictError(
        "actor_version_conflict",
        `DAG actor ${runId}/${actorId} version changed before intervention`,
      );
    }
    const active = db.prepare(`
      SELECT intervention_id FROM dag_actor_interventions
      WHERE run_id = ? AND actor_id = ? AND status IN ('queued', 'applying')
    `).get(runId, actorId) as { intervention_id: string } | undefined;
    if (active) {
      throw new DagActorInterventionConflictError(
        "intervention_in_progress",
        `DAG actor ${runId}/${actorId} already has an active intervention`,
      );
    }
    db.prepare(`
      INSERT INTO dag_actor_interventions(
        intervention_id, run_id, actor_id, operation, status, idempotency_key,
        payload_digest, payload_json, expected_actor_generation, expected_actor_version,
        checkpoint_version, created_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      interventionId,
      runId,
      actorId,
      input.operation,
      idempotencyKey,
      payload.digest,
      payload.json,
      expectedGeneration,
      expectedVersion,
      checkpointVersion ?? null,
      createdAt,
    );
    return {
      intervention: interventionFromRow(interventionRowById(interventionId)!),
      changed: true,
      deduplicated: false,
    };
  }).immediate();
}

export function getDagActorIntervention(interventionId: string): DagActorInterventionRecord | undefined {
  const row = interventionRowById(assertIdentifier(interventionId, "intervention_id"));
  return row ? interventionFromRow(row) : undefined;
}

export function findDagActorInterventionByKey(input: {
  run_id: string;
  actor_id: string;
  idempotency_key: string;
}): DagActorInterventionRecord | undefined {
  const row = getDb().prepare(`
    SELECT * FROM dag_actor_interventions
    WHERE run_id = ? AND actor_id = ? AND idempotency_key = ?
  `).get(
    assertIdentifier(input.run_id, "run_id"),
    assertIdentifier(input.actor_id, "actor_id"),
    assertIdentifier(input.idempotency_key, "idempotency_key"),
  ) as InterventionRow | undefined;
  return row ? interventionFromRow(row) : undefined;
}

export function listDagActorInterventions(input: {
  run_id: string;
  actor_id?: string;
  status?: DagActorInterventionStatus;
  limit?: number;
}): DagActorInterventionRecord[] {
  const conditions = ["run_id = ?"];
  const params: unknown[] = [assertIdentifier(input.run_id, "run_id")];
  if (input.actor_id !== undefined) {
    conditions.push("actor_id = ?");
    params.push(assertIdentifier(input.actor_id, "actor_id"));
  }
  if (input.status !== undefined) {
    if (!["queued", "applying", "applied", "failed"].includes(input.status)) throw new Error("invalid intervention status");
    conditions.push("status = ?");
    params.push(input.status);
  }
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
  params.push(limit);
  return (getDb().prepare(`
    SELECT * FROM dag_actor_interventions WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC, intervention_id DESC LIMIT ?
  `).all(...params) as InterventionRow[]).map(interventionFromRow);
}

export function markDagActorInterventionApplying(input: {
  intervention_id: string;
  from_generation: number;
  started_at?: number;
}): { intervention: DagActorInterventionRecord; changed: boolean; deduplicated: boolean } {
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const fromGeneration = assertPositiveInteger(input.from_generation, "from_generation");
  const startedAt = assertTimestamp(input.started_at, "started_at");
  const db = getDb();
  return db.transaction(() => {
    const current = interventionRowById(interventionId);
    if (!current) throw new Error(`Unknown DAG actor intervention: ${interventionId}`);
    if (current.status === "applying" && current.from_generation === fromGeneration) {
      return { intervention: interventionFromRow(current), changed: false, deduplicated: true };
    }
    if (current.status !== "queued") {
      throw new DagActorInterventionConflictError(
        "intervention_status_conflict",
        `DAG actor intervention ${interventionId} is ${current.status}, not queued`,
      );
    }
    const result = db.prepare(`
      UPDATE dag_actor_interventions SET status = 'applying', started_at = ?, from_generation = ?
      WHERE intervention_id = ? AND status = 'queued'
    `).run(startedAt, fromGeneration, interventionId);
    if (result.changes !== 1) throw new DagActorInterventionConflictError("intervention_status_conflict", "intervention changed concurrently");
    return { intervention: interventionFromRow(interventionRowById(interventionId)!), changed: true, deduplicated: false };
  }).immediate();
}

export function completeDagActorIntervention(input: {
  intervention_id: string;
  from_generation: number;
  to_generation: number;
  resulting_actor_version: number;
  completed_at?: number;
}): { intervention: DagActorInterventionRecord; changed: boolean; deduplicated: boolean } {
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const fromGeneration = assertPositiveInteger(input.from_generation, "from_generation");
  const toGeneration = assertPositiveInteger(input.to_generation, "to_generation");
  const resultingVersion = assertPositiveInteger(input.resulting_actor_version, "resulting_actor_version");
  if (toGeneration !== fromGeneration + 1) throw new Error("to_generation must equal from_generation + 1");
  const completedAt = assertTimestamp(input.completed_at, "completed_at");
  const db = getDb();
  return db.transaction(() => {
    const current = interventionRowById(interventionId);
    if (!current) throw new Error(`Unknown DAG actor intervention: ${interventionId}`);
    if (
      current.status === "applied"
      && current.from_generation === fromGeneration
      && current.to_generation === toGeneration
      && current.resulting_actor_version === resultingVersion
    ) return { intervention: interventionFromRow(current), changed: false, deduplicated: true };
    if (current.status !== "applying" || current.from_generation !== fromGeneration) {
      throw new DagActorInterventionConflictError("intervention_status_conflict", `DAG actor intervention ${interventionId} is not applying`);
    }
    const result = db.prepare(`
      UPDATE dag_actor_interventions SET
        status = 'applied', to_generation = ?, resulting_actor_version = ?, completed_at = ?
      WHERE intervention_id = ? AND status = 'applying' AND from_generation = ?
    `).run(toGeneration, resultingVersion, completedAt, interventionId, fromGeneration);
    if (result.changes !== 1) throw new DagActorInterventionConflictError("intervention_status_conflict", "intervention changed concurrently");
    return { intervention: interventionFromRow(interventionRowById(interventionId)!), changed: true, deduplicated: false };
  }).immediate();
}

export function failDagActorIntervention(input: {
  intervention_id: string;
  failure: unknown;
  completed_at?: number;
}): { intervention: DagActorInterventionRecord; changed: boolean; deduplicated: boolean } {
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const failure = encodeBounded(input.failure, "intervention failure", 65_536).json;
  const completedAt = assertTimestamp(input.completed_at, "completed_at");
  const db = getDb();
  return db.transaction(() => {
    const current = interventionRowById(interventionId);
    if (!current) throw new Error(`Unknown DAG actor intervention: ${interventionId}`);
    if (current.status === "failed") return { intervention: interventionFromRow(current), changed: false, deduplicated: true };
    if (current.status !== "queued" && current.status !== "applying") {
      throw new DagActorInterventionConflictError("intervention_status_conflict", `DAG actor intervention ${interventionId} is ${current.status}`);
    }
    const result = db.prepare(`
      UPDATE dag_actor_interventions SET status = 'failed', completed_at = ?, failure_json = ?
      WHERE intervention_id = ? AND status IN ('queued', 'applying')
    `).run(completedAt, failure, interventionId);
    if (result.changes !== 1) throw new DagActorInterventionConflictError("intervention_status_conflict", "intervention changed concurrently");
    return { intervention: interventionFromRow(interventionRowById(interventionId)!), changed: true, deduplicated: false };
  }).immediate();
}

export function upsertDagActorDispatchExclusion(input: {
  run_id: string;
  actor_id: string;
  node_id: string;
  target_type: "worker" | "node";
  target_id: string;
  intervention_id: string;
  created_at?: number;
}): DagActorDispatchExclusionRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const nodeId = assertIdentifier(input.node_id, "node_id");
  if (input.target_type !== "worker" && input.target_type !== "node") {
    throw new Error("target_type must be worker or node");
  }
  const targetId = assertIdentifier(input.target_id, "target_id");
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const createdAt = assertTimestamp(input.created_at, "created_at");
  const db = getDb();
  return db.transaction(() => {
    const actor = getDagActor(runId, actorId);
    if (!actor || actor.node_id !== nodeId) {
      throw new Error(`Unknown DAG actor dispatch identity: ${runId}/${actorId}/${nodeId}`);
    }
    const intervention = interventionRowById(interventionId);
    if (
      !intervention
      || intervention.run_id !== runId
      || intervention.actor_id !== actorId
      || intervention.operation !== "reassign"
      || !["queued", "applying", "applied"].includes(intervention.status)
    ) {
      throw new Error(`DAG actor dispatch exclusion requires a queued, applying, or applied reassign intervention`);
    }
    db.prepare(`
      INSERT INTO dag_actor_dispatch_exclusions(
        run_id, actor_id, node_id, target_type, target_id, intervention_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET
        actor_id = excluded.actor_id,
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        intervention_id = excluded.intervention_id,
        created_at = excluded.created_at
    `).run(runId, actorId, nodeId, input.target_type, targetId, interventionId, createdAt);
    return dispatchExclusionFromRow(db.prepare(`
      SELECT * FROM dag_actor_dispatch_exclusions WHERE run_id = ? AND node_id = ?
    `).get(runId, nodeId) as DispatchExclusionRow);
  }).immediate();
}

export function clearDagActorDispatchExclusion(input: {
  run_id: string;
  node_id: string;
}): boolean {
  const result = getDb().prepare(`
    DELETE FROM dag_actor_dispatch_exclusions WHERE run_id = ? AND node_id = ?
  `).run(
    assertIdentifier(input.run_id, "run_id"),
    assertIdentifier(input.node_id, "node_id"),
  );
  return result.changes > 0;
}

export function listDagActorDispatchExclusions(): DagActorDispatchExclusionRecord[] {
  return (getDb().prepare(`
    SELECT * FROM dag_actor_dispatch_exclusions ORDER BY created_at, run_id, node_id
  `).all() as DispatchExclusionRow[]).map(dispatchExclusionFromRow);
}

export function createDagSurfaceGenerationSnapshot(input: {
  run_id: string;
  actor_id: string;
  generation: number;
  node_id: string;
  surface_id: string;
  document_id: string;
  node_revision: number;
  document_revision: number;
  surface_revision: number;
  activity_state: string;
  visibility_state: string;
  last_event_id?: string;
  node_snapshot: unknown;
  superseded_by_generation: number;
  intervention_id: string;
  created_at?: number;
}): { snapshot: DagSurfaceGenerationSnapshotRecord; changed: boolean; deduplicated: boolean } {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const generation = assertPositiveInteger(input.generation, "generation");
  const supersededBy = assertPositiveInteger(input.superseded_by_generation, "superseded_by_generation");
  if (supersededBy !== generation + 1) throw new Error("superseded_by_generation must equal generation + 1");
  const nodeId = assertIdentifier(input.node_id, "node_id");
  const surfaceId = assertIdentifier(input.surface_id, "surface_id", 512);
  const documentId = assertIdentifier(input.document_id, "document_id");
  const interventionId = assertIdentifier(input.intervention_id, "intervention_id");
  const nodeRevision = assertPositiveInteger(input.node_revision, "node_revision");
  const documentRevision = assertPositiveInteger(input.document_revision, "document_revision");
  const surfaceRevision = assertPositiveInteger(input.surface_revision, "surface_revision");
  const lastEventId = input.last_event_id === undefined ? undefined : assertIdentifier(input.last_event_id, "last_event_id");
  const createdAt = assertTimestamp(input.created_at, "created_at");
  const encoded = encodeBounded(input.node_snapshot, "surface generation snapshot", 262_144);
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM dag_surface_generation_snapshots
      WHERE run_id = ? AND actor_id = ? AND generation = ?
    `).get(runId, actorId, generation) as SnapshotRow | undefined;
    if (existing) {
      const same = existing.node_id === nodeId
        && existing.surface_id === surfaceId
        && existing.document_id === documentId
        && existing.node_revision === nodeRevision
        && existing.document_revision === documentRevision
        && existing.surface_revision === surfaceRevision
        && existing.activity_state === input.activity_state
        && existing.visibility_state === input.visibility_state
        && existing.last_event_id === (lastEventId ?? null)
        && existing.node_snapshot_sha256 === encoded.digest
        && existing.node_snapshot_json === encoded.json
        && existing.superseded_by_generation === supersededBy
        && existing.intervention_id === interventionId;
      if (!same) throw new DagActorInterventionConflictError("snapshot_identity_conflict", "generation snapshot identifies different content");
      return { snapshot: snapshotFromRow(existing), changed: false, deduplicated: true };
    }
    db.prepare(`
      INSERT INTO dag_surface_generation_snapshots(
        run_id, actor_id, generation, node_id, surface_id, document_id,
        node_revision, document_revision, surface_revision, activity_state,
        visibility_state, last_event_id, node_snapshot_sha256, node_snapshot_json,
        superseded_by_generation, intervention_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      actorId,
      generation,
      nodeId,
      surfaceId,
      documentId,
      nodeRevision,
      documentRevision,
      surfaceRevision,
      input.activity_state,
      input.visibility_state,
      lastEventId ?? null,
      encoded.digest,
      encoded.json,
      supersededBy,
      interventionId,
      createdAt,
    );
    const row = db.prepare(`
      SELECT * FROM dag_surface_generation_snapshots
      WHERE run_id = ? AND actor_id = ? AND generation = ?
    `).get(runId, actorId, generation) as SnapshotRow;
    return { snapshot: snapshotFromRow(row), changed: true, deduplicated: false };
  }).immediate();
}

export function listDagSurfaceGenerationSnapshots(input: {
  run_id: string;
  actor_id: string;
  limit?: number;
}): DagSurfaceGenerationSnapshotRecord[] {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  return (getDb().prepare(`
    SELECT * FROM dag_surface_generation_snapshots
    WHERE run_id = ? AND actor_id = ?
    ORDER BY generation DESC LIMIT ?
  `).all(
    assertIdentifier(input.run_id, "run_id"),
    assertIdentifier(input.actor_id, "actor_id"),
    limit,
  ) as SnapshotRow[]).map(snapshotFromRow);
}

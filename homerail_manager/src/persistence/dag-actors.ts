import { createHash } from "node:crypto";
import { redactTelemetry } from "homerail-protocol";
import { getDb, parseJsonRow } from "./db.js";

export const MAX_DAG_ACTOR_DOCUMENT_BYTES = 256 * 1024;
export const DEFAULT_DAG_ACTOR_COMMAND_LIMIT = 100;
export const MAX_DAG_ACTOR_COMMAND_LIMIT = 500;

export interface DagActorRecord {
  run_id: string;
  actor_id: string;
  node_id: string;
  role: string;
  generation: number;
  attempt: number;
  version: number;
  session_id?: string;
  model_profile: Record<string, unknown>;
  surface_id: string;
  workspace_ref?: string;
  checkpoint_ref?: string;
  created_at: number;
  updated_at: number;
}

export type DagActorCommandStatus = "pending" | "delivered" | "claimed" | "acknowledged" | "failed" | "cancelled";
const DAG_ACTOR_COMMAND_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "delivered",
  "claimed",
  "acknowledged",
  "failed",
  "cancelled",
]);

export interface DagActorCommandRecord {
  command_id: string;
  run_id: string;
  actor_id: string;
  round_id: string;
  target_generation: number;
  status: DagActorCommandStatus;
  idempotency_key: string;
  payload: unknown;
  claimed_generation?: number;
  created_at: number;
  delivered_at?: number;
  claimed_at?: number;
  completed_at?: number;
  failure?: unknown;
}

export interface DagActorCommandMutationResult {
  command: DagActorCommandRecord;
  changed: boolean;
  deduplicated: boolean;
}

export class DagActorConflictError extends Error {
  constructor(
    public readonly code:
      | "actor_identity_conflict"
      | "actor_version_conflict"
      | "actor_generation_conflict"
      | "command_identity_conflict"
      | "command_generation_conflict"
      | "command_status_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DagActorConflictError";
  }
}

interface DagActorRow extends Record<string, unknown> {
  run_id: string;
  actor_id: string;
  node_id: string;
  role: string;
  generation: number;
  attempt: number;
  version: number;
  session_id: string | null;
  model_profile_json: string;
  surface_id: string;
  workspace_ref: string | null;
  checkpoint_ref: string | null;
  created_at: number;
  updated_at: number;
}

interface DagActorCommandRow extends Record<string, unknown> {
  command_id: string;
  run_id: string;
  actor_id: string;
  round_id: string;
  target_generation: number;
  status: DagActorCommandStatus;
  idempotency_key: string;
  payload_digest: string;
  payload_json: string;
  claimed_generation: number | null;
  created_at: number;
  delivered_at: number | null;
  claimed_at: number | null;
  completed_at: number | null;
  failure_json: string | null;
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${label} must be between 1 and 256 characters`);
  }
  return normalized;
}

function assertOptionalReference(value: string | null | undefined, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new Error(`${label} must be between 1 and 2048 characters when provided`);
  }
  return normalized;
}

function assertPositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
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

function encodeBoundedDocument(value: unknown, label: string): { json: string; digest: string } {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (raw === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(raw, "utf8") > MAX_DAG_ACTOR_DOCUMENT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DAG_ACTOR_DOCUMENT_BYTES} bytes`);
  }
  const redacted = canonicalize(redactTelemetry(value));
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, "utf8") > MAX_DAG_ACTOR_DOCUMENT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DAG_ACTOR_DOCUMENT_BYTES} bytes after redaction`);
  }
  return { json, digest: createHash("sha256").update(json).digest("hex") };
}

function actorFromRow(row: DagActorRow): DagActorRecord {
  const modelProfile = parseJsonRow<unknown>(row.model_profile_json);
  if (!modelProfile || typeof modelProfile !== "object" || Array.isArray(modelProfile)) {
    throw new Error(`DAG actor ${row.actor_id} has an invalid model profile`);
  }
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    role: row.role,
    generation: Number(row.generation),
    attempt: Number(row.attempt),
    version: Number(row.version),
    ...(row.session_id ? { session_id: row.session_id } : {}),
    model_profile: modelProfile as Record<string, unknown>,
    surface_id: row.surface_id,
    ...(row.workspace_ref ? { workspace_ref: row.workspace_ref } : {}),
    ...(row.checkpoint_ref ? { checkpoint_ref: row.checkpoint_ref } : {}),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function commandFromRow(row: DagActorCommandRow): DagActorCommandRecord {
  return {
    command_id: row.command_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    round_id: row.round_id,
    target_generation: Number(row.target_generation),
    status: row.status,
    idempotency_key: row.idempotency_key,
    payload: parseJsonRow(row.payload_json),
    ...(row.claimed_generation === null ? {} : { claimed_generation: Number(row.claimed_generation) }),
    created_at: Number(row.created_at),
    ...(row.delivered_at === null ? {} : { delivered_at: Number(row.delivered_at) }),
    ...(row.claimed_at === null ? {} : { claimed_at: Number(row.claimed_at) }),
    ...(row.completed_at === null ? {} : { completed_at: Number(row.completed_at) }),
    ...(row.failure_json === null ? {} : { failure: parseJsonRow(row.failure_json) }),
  };
}

function getActorRow(runId: string, actorId: string): DagActorRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actors WHERE run_id = ? AND actor_id = ?")
    .get(runId, actorId) as DagActorRow | undefined;
}

function getCommandRow(commandId: string): DagActorCommandRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_commands WHERE command_id = ?")
    .get(commandId) as DagActorCommandRow | undefined;
}

function requireActor(runId: string, actorId: string): DagActorRecord {
  const actor = getDagActor(runId, actorId);
  if (!actor) throw new Error(`Unknown DAG actor: ${runId}/${actorId}`);
  return actor;
}

function requireCommand(commandId: string): DagActorCommandRecord {
  const command = getDagActorCommand(commandId);
  if (!command) throw new Error(`Unknown DAG actor command: ${commandId}`);
  return command;
}

export function registerDagActor(input: {
  run_id: string;
  actor_id: string;
  node_id: string;
  role: string;
  model_profile?: Record<string, unknown>;
  surface_id: string;
  session_id?: string;
  workspace_ref?: string;
  checkpoint_ref?: string;
}): { actor: DagActorRecord; inserted: boolean; deduplicated: boolean } {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const nodeId = assertIdentifier(input.node_id, "node_id");
  const role = assertIdentifier(input.role, "role");
  const surfaceId = assertIdentifier(input.surface_id, "surface_id");
  const sessionId = assertOptionalReference(input.session_id, "session_id");
  const workspaceRef = assertOptionalReference(input.workspace_ref, "workspace_ref");
  const checkpointRef = assertOptionalReference(input.checkpoint_ref, "checkpoint_ref");
  const modelProfile = encodeBoundedDocument(input.model_profile ?? {}, "model_profile");
  const db = getDb();

  return db.transaction(() => {
    const existing = getActorRow(runId, actorId);
    if (existing) {
      if (existing.node_id !== nodeId || existing.role !== role || existing.surface_id !== surfaceId) {
        throw new DagActorConflictError(
          "actor_identity_conflict",
          `DAG actor ${runId}/${actorId} is already bound to node ${existing.node_id}, role ${existing.role}, surface ${existing.surface_id}`,
        );
      }
      return { actor: actorFromRow(existing), inserted: false, deduplicated: true };
    }
    if (!db.prepare("SELECT 1 FROM dag_runs WHERE run_id = ?").get(runId)) {
      throw new Error(`Unknown DAG run: ${runId}`);
    }
    const nodeConflict = db.prepare("SELECT actor_id FROM dag_actors WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as { actor_id: string } | undefined;
    if (nodeConflict) {
      throw new DagActorConflictError(
        "actor_identity_conflict",
        `DAG node ${runId}/${nodeId} is already owned by actor ${nodeConflict.actor_id}`,
      );
    }
    const surfaceConflict = db.prepare("SELECT actor_id FROM dag_actors WHERE run_id = ? AND surface_id = ?")
      .get(runId, surfaceId) as { actor_id: string } | undefined;
    if (surfaceConflict) {
      throw new DagActorConflictError(
        "actor_identity_conflict",
        `DAG surface ${runId}/${surfaceId} is already owned by actor ${surfaceConflict.actor_id}`,
      );
    }
    const now = Date.now();
    db.prepare(`
      INSERT INTO dag_actors(
        run_id, actor_id, node_id, role, generation, attempt, version, session_id,
        model_profile_json, surface_id, workspace_ref, checkpoint_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      actorId,
      nodeId,
      role,
      sessionId ?? null,
      modelProfile.json,
      surfaceId,
      workspaceRef ?? null,
      checkpointRef ?? null,
      now,
      now,
    );
    return { actor: actorFromRow(getActorRow(runId, actorId)!), inserted: true, deduplicated: false };
  })();
}

export function getDagActor(runId: string, actorId: string): DagActorRecord | undefined {
  const row = getActorRow(runId, actorId);
  return row ? actorFromRow(row) : undefined;
}

export function getDagActorByNode(runId: string, nodeId: string): DagActorRecord | undefined {
  const row = getDb().prepare("SELECT * FROM dag_actors WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId) as DagActorRow | undefined;
  return row ? actorFromRow(row) : undefined;
}

export function listDagActors(runId: string): DagActorRecord[] {
  return (getDb().prepare("SELECT * FROM dag_actors WHERE run_id = ? ORDER BY actor_id")
    .all(runId) as DagActorRow[]).map(actorFromRow);
}

export function updateDagActorBinding(input: {
  run_id: string;
  actor_id: string;
  expected_version: number;
  session_id?: string | null;
  attempt?: number;
  model_profile?: Record<string, unknown>;
  workspace_ref?: string | null;
  checkpoint_ref?: string | null;
}): DagActorRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const expectedVersion = assertPositiveSafeInteger(input.expected_version, "expected_version");
  const hasPatch = input.session_id !== undefined
    || input.attempt !== undefined
    || input.model_profile !== undefined
    || input.workspace_ref !== undefined
    || input.checkpoint_ref !== undefined;
  if (!hasPatch) throw new Error("At least one actor binding field is required");
  const sessionId = assertOptionalReference(input.session_id, "session_id");
  const attempt = input.attempt === undefined ? undefined : assertPositiveSafeInteger(input.attempt, "attempt");
  const workspaceRef = assertOptionalReference(input.workspace_ref, "workspace_ref");
  const checkpointRef = assertOptionalReference(input.checkpoint_ref, "checkpoint_ref");
  const modelProfile = input.model_profile === undefined
    ? undefined
    : encodeBoundedDocument(input.model_profile, "model_profile").json;
  const db = getDb();

  return db.transaction(() => {
    const current = requireActor(runId, actorId);
    if (current.version !== expectedVersion) {
      throw new DagActorConflictError(
        "actor_version_conflict",
        `DAG actor ${runId}/${actorId} version is ${current.version}, expected ${expectedVersion}`,
      );
    }
    const changed = db.prepare(`
      UPDATE dag_actors SET
        session_id = CASE WHEN ? THEN ? ELSE session_id END,
        attempt = COALESCE(?, attempt),
        model_profile_json = COALESCE(?, model_profile_json),
        workspace_ref = CASE WHEN ? THEN ? ELSE workspace_ref END,
        checkpoint_ref = CASE WHEN ? THEN ? ELSE checkpoint_ref END,
        version = version + 1,
        updated_at = ?
      WHERE run_id = ? AND actor_id = ? AND version = ?
    `).run(
      input.session_id !== undefined ? 1 : 0,
      sessionId ?? null,
      attempt ?? null,
      modelProfile ?? null,
      input.workspace_ref !== undefined ? 1 : 0,
      workspaceRef ?? null,
      input.checkpoint_ref !== undefined ? 1 : 0,
      checkpointRef ?? null,
      Date.now(),
      runId,
      actorId,
      expectedVersion,
    );
    if (changed.changes !== 1) {
      throw new DagActorConflictError("actor_version_conflict", `DAG actor ${runId}/${actorId} changed concurrently`);
    }
    return requireActor(runId, actorId);
  })();
}

export function advanceDagActorGeneration(input: {
  run_id: string;
  actor_id: string;
  expected_generation: number;
  expected_version: number;
  session_id?: string | null;
  attempt?: number;
  checkpoint_ref?: string | null;
}): DagActorRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const expectedGeneration = assertPositiveSafeInteger(input.expected_generation, "expected_generation");
  const expectedVersion = assertPositiveSafeInteger(input.expected_version, "expected_version");
  const sessionId = assertOptionalReference(input.session_id, "session_id");
  const requestedAttempt = input.attempt === undefined
    ? undefined
    : assertPositiveSafeInteger(input.attempt, "attempt");
  const checkpointRef = assertOptionalReference(input.checkpoint_ref, "checkpoint_ref");
  const db = getDb();

  return db.transaction(() => {
    const current = requireActor(runId, actorId);
    if (current.generation !== expectedGeneration) {
      throw new DagActorConflictError(
        "actor_generation_conflict",
        `DAG actor ${runId}/${actorId} generation is ${current.generation}, expected ${expectedGeneration}`,
      );
    }
    if (current.version !== expectedVersion) {
      throw new DagActorConflictError(
        "actor_version_conflict",
        `DAG actor ${runId}/${actorId} version is ${current.version}, expected ${expectedVersion}`,
      );
    }
    const attempt = requestedAttempt ?? assertPositiveSafeInteger(current.attempt + 1, "attempt");
    const changed = db.prepare(`
      UPDATE dag_actors SET
        generation = generation + 1,
        attempt = ?,
        version = version + 1,
        session_id = ?,
        checkpoint_ref = CASE WHEN ? THEN ? ELSE checkpoint_ref END,
        updated_at = ?
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND version = ?
    `).run(
      attempt,
      sessionId ?? null,
      input.checkpoint_ref !== undefined ? 1 : 0,
      checkpointRef ?? null,
      Date.now(),
      runId,
      actorId,
      expectedGeneration,
      expectedVersion,
    );
    if (changed.changes !== 1) {
      throw new DagActorConflictError("actor_generation_conflict", `DAG actor ${runId}/${actorId} changed concurrently`);
    }
    return requireActor(runId, actorId);
  })();
}

export function createDagActorCommand(input: {
  command_id: string;
  run_id: string;
  actor_id: string;
  round_id: string;
  idempotency_key: string;
  payload: unknown;
  target_generation?: number;
}): DagActorCommandMutationResult {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const roundId = assertIdentifier(input.round_id, "round_id");
  const idempotencyKey = assertIdentifier(input.idempotency_key, "idempotency_key");
  const encoded = encodeBoundedDocument(input.payload, "command payload");
  const db = getDb();

  return db.transaction(() => {
    const actor = requireActor(runId, actorId);
    const targetGeneration = input.target_generation === undefined
      ? actor.generation
      : assertPositiveSafeInteger(input.target_generation, "target_generation");
    if (targetGeneration !== actor.generation) {
      throw new DagActorConflictError(
        "command_generation_conflict",
        `Command targets generation ${targetGeneration}, but actor ${runId}/${actorId} is generation ${actor.generation}`,
      );
    }
    const byId = getCommandRow(commandId);
    if (byId) {
      const same = byId.run_id === runId
        && byId.actor_id === actorId
        && byId.round_id === roundId
        && byId.target_generation === targetGeneration
        && byId.idempotency_key === idempotencyKey
        && byId.payload_digest === encoded.digest
        && byId.payload_json === encoded.json;
      if (!same) {
        throw new DagActorConflictError(
          "command_identity_conflict",
          `DAG actor command_id ${commandId} already identifies different content`,
        );
      }
      return { command: commandFromRow(byId), changed: false, deduplicated: true };
    }
    const byKey = db.prepare(`
      SELECT * FROM dag_actor_commands
      WHERE run_id = ? AND actor_id = ? AND idempotency_key = ?
    `).get(runId, actorId, idempotencyKey) as DagActorCommandRow | undefined;
    if (byKey) {
      const same = byKey.round_id === roundId
        && byKey.target_generation === targetGeneration
        && byKey.payload_digest === encoded.digest
        && byKey.payload_json === encoded.json;
      if (!same) {
        throw new DagActorConflictError(
          "command_identity_conflict",
          `DAG actor idempotency_key ${idempotencyKey} already identifies different content`,
        );
      }
      return { command: commandFromRow(byKey), changed: false, deduplicated: true };
    }
    db.prepare(`
      INSERT INTO dag_actor_commands(
        command_id, run_id, actor_id, round_id, target_generation, status,
        idempotency_key, payload_digest, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      commandId,
      runId,
      actorId,
      roundId,
      targetGeneration,
      idempotencyKey,
      encoded.digest,
      encoded.json,
      Date.now(),
    );
    return { command: commandFromRow(getCommandRow(commandId)!), changed: true, deduplicated: false };
  })();
}

export function getDagActorCommand(commandId: string): DagActorCommandRecord | undefined {
  const row = getCommandRow(commandId);
  return row ? commandFromRow(row) : undefined;
}

export function listDagActorCommands(input: {
  run_id: string;
  actor_id?: string;
  round_id?: string;
  status?: DagActorCommandStatus;
  limit?: number;
}): DagActorCommandRecord[] {
  const conditions = ["run_id = ?"];
  const params: unknown[] = [assertIdentifier(input.run_id, "run_id")];
  if (input.actor_id !== undefined) {
    conditions.push("actor_id = ?");
    params.push(assertIdentifier(input.actor_id, "actor_id"));
  }
  if (input.round_id !== undefined) {
    conditions.push("round_id = ?");
    params.push(assertIdentifier(input.round_id, "round_id"));
  }
  if (input.status !== undefined) {
    if (!DAG_ACTOR_COMMAND_STATUSES.has(input.status)) throw new Error(`Invalid command status: ${input.status}`);
    conditions.push("status = ?");
    params.push(input.status);
  }
  const requestedLimit = input.limit ?? DEFAULT_DAG_ACTOR_COMMAND_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("limit must be a positive safe integer");
  }
  params.push(Math.min(requestedLimit, MAX_DAG_ACTOR_COMMAND_LIMIT));
  return (getDb().prepare(`
    SELECT * FROM dag_actor_commands
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at, command_id
    LIMIT ?
  `).all(...params) as DagActorCommandRow[]).map(commandFromRow);
}

export function markDagActorCommandDelivered(rawCommandId: string): DagActorCommandMutationResult {
  const commandId = assertIdentifier(rawCommandId, "command_id");
  const db = getDb();
  return db.transaction(() => {
    const current = requireCommand(commandId);
    if (current.status === "delivered") {
      return { command: current, changed: false, deduplicated: true };
    }
    if (current.status !== "pending") {
      throw new DagActorConflictError(
        "command_status_conflict",
        `DAG actor command ${commandId} is ${current.status}, not pending`,
      );
    }
    const changed = db.prepare(`
      UPDATE dag_actor_commands SET status = 'delivered', delivered_at = ?
      WHERE command_id = ? AND status = 'pending'
    `).run(Date.now(), commandId);
    if (changed.changes !== 1) {
      throw new DagActorConflictError("command_status_conflict", `DAG actor command ${commandId} changed concurrently`);
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  })();
}

/** The command is already durable when `deliver` runs. A failed delivery leaves it pending. */
export async function deliverDagActorCommand(input: {
  command_id: string;
  deliver: (command: DagActorCommandRecord) => boolean | void | Promise<boolean | void>;
}): Promise<DagActorCommandMutationResult & { delivered: boolean }> {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const current = requireCommand(commandId);
  if (current.status === "delivered") {
    return { command: current, changed: false, deduplicated: true, delivered: true };
  }
  if (current.status !== "pending") {
    throw new DagActorConflictError(
      "command_status_conflict",
      `DAG actor command ${commandId} is ${current.status}, not pending`,
    );
  }
  const delivered = await input.deliver(current);
  if (delivered === false) {
    return { command: requireCommand(commandId), changed: false, deduplicated: false, delivered: false };
  }
  return { ...markDagActorCommandDelivered(commandId), delivered: true };
}

export function cancelUnclaimedDagActorCommands(runId: string, completedAt?: number): DagActorCommandRecord[];
export function cancelUnclaimedDagActorCommands(input: {
  run_id: string;
  actor_id?: string;
  completed_at?: number;
  reason?: unknown;
}): DagActorCommandRecord[];
export function cancelUnclaimedDagActorCommands(
  input: string | { run_id: string; actor_id?: string; completed_at?: number; reason?: unknown },
  requestedCompletedAt?: number,
): DagActorCommandRecord[] {
  const runId = assertIdentifier(typeof input === "string" ? input : input.run_id, "run_id");
  const actorId = typeof input === "string" || input.actor_id === undefined
    ? undefined
    : assertIdentifier(input.actor_id, "actor_id");
  const completedAt = typeof input === "string"
    ? requestedCompletedAt ?? Date.now()
    : input.completed_at ?? Date.now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error("completed_at must be a non-negative epoch millisecond integer");
  }
  const reason = typeof input === "string"
    ? { message: "command cancelled" }
    : input.reason ?? { message: "command cancelled" };
  const reasonJson = encodeBoundedDocument(reason, "command cancellation reason").json;
  const db = getDb();

  return db.transaction(() => {
    const candidates = db.prepare(`
      SELECT * FROM dag_actor_commands
      WHERE run_id = ? AND (? IS NULL OR actor_id = ?) AND status IN ('pending', 'delivered')
      ORDER BY created_at, command_id
    `).all(runId, actorId ?? null, actorId ?? null) as DagActorCommandRow[];
    if (candidates.length === 0) return [];
    if (candidates.some((command) => completedAt < Number(command.created_at))) {
      throw new Error("completed_at must not precede command creation");
    }
    const changed = db.prepare(`
      UPDATE dag_actor_commands SET
        status = 'cancelled',
        completed_at = ?,
        failure_json = ?
      WHERE run_id = ? AND (? IS NULL OR actor_id = ?) AND status IN ('pending', 'delivered')
    `).run(completedAt, reasonJson, runId, actorId ?? null, actorId ?? null);
    if (changed.changes !== candidates.length) {
      throw new DagActorConflictError(
        "command_status_conflict",
        `Unclaimed DAG actor commands for ${actorId ? `actor ${runId}/${actorId}` : `run ${runId}`} changed concurrently`,
      );
    }
    return candidates.map((candidate) => requireCommand(candidate.command_id));
  })();
}

export function claimDagActorCommand(input: {
  command_id: string;
  run_id: string;
  actor_id: string;
  generation: number;
}): DagActorCommandMutationResult {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const generation = assertPositiveSafeInteger(input.generation, "generation");
  const db = getDb();

  return db.transaction(() => {
    const actor = requireActor(runId, actorId);
    if (actor.generation !== generation) {
      throw new DagActorConflictError(
        "command_generation_conflict",
        `Actor ${runId}/${actorId} is generation ${actor.generation}, not ${generation}`,
      );
    }
    const current = requireCommand(commandId);
    if (current.run_id !== runId || current.actor_id !== actorId) {
      throw new DagActorConflictError("command_identity_conflict", `Command ${commandId} belongs to another actor`);
    }
    if (current.target_generation !== generation) {
      throw new DagActorConflictError(
        "command_generation_conflict",
        `Command ${commandId} targets generation ${current.target_generation}, not ${generation}`,
      );
    }
    if (current.status === "claimed" && current.claimed_generation === generation) {
      return { command: current, changed: false, deduplicated: true };
    }
    if (current.status !== "pending" && current.status !== "delivered") {
      throw new DagActorConflictError(
        "command_status_conflict",
        `DAG actor command ${commandId} is ${current.status}, not claimable`,
      );
    }
    const now = Date.now();
    const changed = db.prepare(`
      UPDATE dag_actor_commands SET
        status = 'claimed',
        delivered_at = COALESCE(delivered_at, ?),
        claimed_generation = ?,
        claimed_at = ?
      WHERE command_id = ?
        AND run_id = ?
        AND actor_id = ?
        AND target_generation = ?
        AND status IN ('pending', 'delivered')
    `).run(now, generation, now, commandId, runId, actorId, generation);
    if (changed.changes !== 1) {
      throw new DagActorConflictError("command_status_conflict", `DAG actor command ${commandId} changed concurrently`);
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  })();
}

export function acknowledgeDagActorCommand(input: {
  command_id: string;
  generation: number;
}): DagActorCommandMutationResult {
  return completeCommand(input.command_id, input.generation, "acknowledged");
}

export function failDagActorCommand(input: {
  command_id: string;
  generation: number;
  failure: unknown;
}): DagActorCommandMutationResult {
  return completeCommand(input.command_id, input.generation, "failed", input.failure);
}

function completeCommand(
  rawCommandId: string,
  rawGeneration: number,
  status: "acknowledged" | "failed",
  failure?: unknown,
): DagActorCommandMutationResult {
  const commandId = assertIdentifier(rawCommandId, "command_id");
  const generation = assertPositiveSafeInteger(rawGeneration, "generation");
  const failureJson = status === "failed"
    ? encodeBoundedDocument(failure ?? { message: "command failed" }, "command failure").json
    : null;
  const db = getDb();

  return db.transaction(() => {
    const current = requireCommand(commandId);
    if (current.status === status && current.claimed_generation === generation) {
      return { command: current, changed: false, deduplicated: true };
    }
    if (current.status !== "claimed" || current.claimed_generation !== generation) {
      throw new DagActorConflictError(
        current.claimed_generation !== undefined && current.claimed_generation !== generation
          ? "command_generation_conflict"
          : "command_status_conflict",
        `DAG actor command ${commandId} is not claimed by generation ${generation}`,
      );
    }
    const changed = db.prepare(`
      UPDATE dag_actor_commands SET status = ?, completed_at = ?, failure_json = ?
      WHERE command_id = ? AND status = 'claimed' AND claimed_generation = ?
    `).run(status, Date.now(), failureJson, commandId, generation);
    if (changed.changes !== 1) {
      throw new DagActorConflictError("command_status_conflict", `DAG actor command ${commandId} changed concurrently`);
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  })();
}

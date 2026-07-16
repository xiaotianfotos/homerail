import { createHash } from "node:crypto";
import { redactTelemetry } from "homerail-protocol";
import { getDb, parseJsonRow } from "./db.js";

export const MAX_DAG_ACTOR_LIVE_COMMAND_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DAG_ACTOR_LIVE_COMMAND_REASON_BYTES = 4 * 1024;
export const DEFAULT_DAG_ACTOR_LIVE_COMMAND_LIMIT = 100;
export const MAX_DAG_ACTOR_LIVE_COMMAND_LIMIT = 500;
export const MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN = 500;

export const DAG_ACTOR_LIVE_COMMAND_STATUSES = [
  "queued",
  "delivered",
  "applied",
  "completed",
  "rejected",
  "failed",
  "superseded",
  "cancelled",
] as const;

export type DagActorLiveCommandStatus = (typeof DAG_ACTOR_LIVE_COMMAND_STATUSES)[number];
export type DagActorLiveCommandTerminalStatus = Extract<
  DagActorLiveCommandStatus,
  "completed" | "rejected" | "failed" | "superseded" | "cancelled"
>;

const LIVE_COMMAND_STATUS_SET: ReadonlySet<string> = new Set(DAG_ACTOR_LIVE_COMMAND_STATUSES);
const TERMINAL_STATUS_SET: ReadonlySet<DagActorLiveCommandStatus> = new Set([
  "completed",
  "rejected",
  "failed",
  "superseded",
  "cancelled",
]);

export interface DagActorLiveCommandRecord {
  command_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  target_generation: number;
  target_lease_generation: number;
  expected_state_token: string;
  sequence: number;
  status: DagActorLiveCommandStatus;
  idempotency_key: string;
  payload: unknown;
  delivery_attempts: number;
  last_sent_at?: number;
  fallback_reason?: string;
  delivered_at?: number;
  applied_at?: number;
  terminal_at?: number;
  terminal_reason?: string;
  created_at: number;
  updated_at: number;
}

export interface CreateDagActorLiveCommandInput {
  run_id: string;
  actor_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  target_generation: number;
  target_lease_generation: number;
  expected_state_token: string;
  idempotency_key: string;
  payload: unknown;
}

export interface DagActorLiveCommandMutationResult {
  command: DagActorLiveCommandRecord;
  changed: boolean;
  deduplicated: boolean;
}

export class DagActorLiveCommandConflictError extends Error {
  constructor(
    public readonly code:
      | "live_command_identity_conflict"
      | "live_command_generation_conflict"
      | "live_command_status_conflict"
      | "live_command_capacity_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "DagActorLiveCommandConflictError";
  }
}

interface DagActorLiveCommandRow extends Record<string, unknown> {
  command_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  target_generation: number;
  target_lease_generation: number;
  expected_state_token: string;
  sequence: number;
  status: DagActorLiveCommandStatus;
  idempotency_key: string;
  payload_digest: string;
  payload_json: string;
  delivery_attempts: number;
  last_sent_at: number | null;
  fallback_reason_json: string | null;
  delivered_at: number | null;
  applied_at: number | null;
  terminal_at: number | null;
  terminal_reason_json: string | null;
  created_at: number;
  updated_at: number;
}

interface NormalizedCreateInput extends CreateDagActorLiveCommandInput {
  command_id: string;
  payload_digest: string;
  payload_json: string;
}

function assertIdentifier(value: string, label: string, maxLength = 256): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be between 1 and ${maxLength} printable characters`);
  }
  return normalized;
}

function assertPositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertStateToken(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("expected_state_token must be a 64-character lowercase hex token");
  }
  return normalized;
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

function encodePayload(value: unknown): { json: string; digest: string } {
  let source: string | undefined;
  try {
    source = JSON.stringify(value);
  } catch {
    throw new Error("live command payload must be JSON serializable");
  }
  if (source === undefined) throw new Error("live command payload must be JSON serializable");
  if (Buffer.byteLength(source, "utf8") > MAX_DAG_ACTOR_LIVE_COMMAND_PAYLOAD_BYTES) {
    throw new Error(`live command payload exceeds ${MAX_DAG_ACTOR_LIVE_COMMAND_PAYLOAD_BYTES} bytes`);
  }
  const json = JSON.stringify(canonicalize(redactTelemetry(value)));
  if (Buffer.byteLength(json, "utf8") > MAX_DAG_ACTOR_LIVE_COMMAND_PAYLOAD_BYTES) {
    throw new Error(`live command payload exceeds ${MAX_DAG_ACTOR_LIVE_COMMAND_PAYLOAD_BYTES} bytes after redaction`);
  }
  return { json, digest: createHash("sha256").update(json).digest("hex") };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...";
  const source = Buffer.from(value, "utf8");
  let truncated = source.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix))).toString("utf8");
  if (truncated.endsWith("\ufffd")) truncated = truncated.slice(0, -1);
  return `${truncated}${suffix}`;
}

function encodeReason(value: string | undefined, fallback: string): string {
  const redacted = String(redactTelemetry(value?.trim() || fallback));
  let reason = truncateUtf8(redacted, MAX_DAG_ACTOR_LIVE_COMMAND_REASON_BYTES - 32);
  let json = JSON.stringify({ reason });
  while (Buffer.byteLength(json, "utf8") > MAX_DAG_ACTOR_LIVE_COMMAND_REASON_BYTES) {
    reason = truncateUtf8(reason, Math.max(0, Buffer.byteLength(reason, "utf8") - 16));
    json = JSON.stringify({ reason });
  }
  return json;
}

function decodeReason(value: string | null): string | undefined {
  if (value === null) return undefined;
  const parsed = parseJsonRow<unknown>(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const reason = (parsed as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
}

function commandFromRow(row: DagActorLiveCommandRow): DagActorLiveCommandRecord {
  return {
    command_id: row.command_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    session_id: row.session_id,
    round_id: row.round_id,
    target_generation: Number(row.target_generation),
    target_lease_generation: Number(row.target_lease_generation),
    expected_state_token: row.expected_state_token,
    sequence: Number(row.sequence),
    status: row.status,
    idempotency_key: row.idempotency_key,
    payload: parseJsonRow(row.payload_json),
    delivery_attempts: Number(row.delivery_attempts),
    ...(row.last_sent_at === null ? {} : { last_sent_at: Number(row.last_sent_at) }),
    ...(decodeReason(row.fallback_reason_json) === undefined
      ? {}
      : { fallback_reason: decodeReason(row.fallback_reason_json) }),
    ...(row.delivered_at === null ? {} : { delivered_at: Number(row.delivered_at) }),
    ...(row.applied_at === null ? {} : { applied_at: Number(row.applied_at) }),
    ...(row.terminal_at === null ? {} : { terminal_at: Number(row.terminal_at) }),
    ...(decodeReason(row.terminal_reason_json) === undefined
      ? {}
      : { terminal_reason: decodeReason(row.terminal_reason_json) }),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function getRow(commandId: string): DagActorLiveCommandRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_live_commands WHERE command_id = ?")
    .get(commandId) as DagActorLiveCommandRow | undefined;
}

function requireCommand(commandId: string): DagActorLiveCommandRecord {
  const command = getDagActorLiveCommand(commandId);
  if (!command) throw new Error(`Unknown DAG actor live command: ${commandId}`);
  return command;
}

function stableCommandId(runId: string, actorId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(runId)
    .update("\0")
    .update(actorId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `dag-live-${digest}`;
}

function normalizeCreateInput(input: CreateDagActorLiveCommandInput): NormalizedCreateInput {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const idempotencyKey = assertIdentifier(input.idempotency_key, "idempotency_key");
  const encoded = encodePayload(input.payload);
  return {
    run_id: runId,
    actor_id: actorId,
    node_id: assertIdentifier(input.node_id, "node_id"),
    session_id: assertIdentifier(input.session_id, "session_id", 512),
    round_id: assertIdentifier(input.round_id, "round_id"),
    target_generation: assertPositiveSafeInteger(input.target_generation, "target_generation"),
    target_lease_generation: assertNonNegativeSafeInteger(
      input.target_lease_generation,
      "target_lease_generation",
    ),
    expected_state_token: assertStateToken(input.expected_state_token),
    idempotency_key: idempotencyKey,
    payload: input.payload,
    command_id: stableCommandId(runId, actorId, idempotencyKey),
    payload_digest: encoded.digest,
    payload_json: encoded.json,
  };
}

function sameIdempotentCommand(row: DagActorLiveCommandRow, input: NormalizedCreateInput): boolean {
  return row.run_id === input.run_id
    && row.actor_id === input.actor_id
    && row.node_id === input.node_id
    && Number(row.target_generation) === input.target_generation
    && row.expected_state_token === input.expected_state_token
    && row.idempotency_key === input.idempotency_key
    && row.payload_digest === input.payload_digest
    && row.payload_json === input.payload_json;
}

export function createDagActorLiveCommandBatch(
  rawInputs: readonly CreateDagActorLiveCommandInput[],
  options: {
    validate_new?: (input: Readonly<CreateDagActorLiveCommandInput>) => void;
  } = {},
): DagActorLiveCommandMutationResult[] {
  if (rawInputs.length < 1 || rawInputs.length > 128) {
    throw new Error("live command batch must contain between 1 and 128 entries");
  }
  const inputs = rawInputs.map(normalizeCreateInput);
  const uniqueActors = new Set(inputs.map((input) => `${input.run_id}\0${input.actor_id}`));
  if (uniqueActors.size !== inputs.length) {
    throw new Error("live command batch must contain unique run_id/actor_id pairs");
  }
  const db = getDb();

  return db.transaction(() => {
    const results: DagActorLiveCommandMutationResult[] = [];
    for (const input of inputs) {
      const byKey = db.prepare(`
        SELECT * FROM dag_actor_live_commands
        WHERE run_id = ? AND actor_id = ? AND idempotency_key = ?
      `).get(input.run_id, input.actor_id, input.idempotency_key) as DagActorLiveCommandRow | undefined;
      const byId = getRow(input.command_id);
      const existing = byKey ?? byId;
      if (existing) {
        if (!sameIdempotentCommand(existing, input) || (byKey && byId && byKey.command_id !== byId.command_id)) {
          throw new DagActorLiveCommandConflictError(
            "live_command_identity_conflict",
            `Live command idempotency key ${input.idempotency_key} already identifies different content`,
          );
        }
        results.push({ command: commandFromRow(existing), changed: false, deduplicated: true });
        continue;
      }

      const outstanding = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM dag_actor_live_commands
        WHERE run_id = ? AND status IN ('queued', 'delivered', 'applied')
      `).get(input.run_id) as { count: number }).count);
      if (outstanding >= MAX_DAG_ACTOR_OUTSTANDING_LIVE_COMMANDS_PER_RUN) {
        throw new DagActorLiveCommandConflictError(
          "live_command_capacity_exceeded",
          `Run ${input.run_id} already has ${outstanding} outstanding live commands`,
        );
      }

      options.validate_new?.(input);
      const actor = db.prepare(`
        SELECT node_id, generation FROM dag_actors WHERE run_id = ? AND actor_id = ?
      `).get(input.run_id, input.actor_id) as { node_id: string; generation: number } | undefined;
      if (!actor) throw new Error(`Unknown DAG actor: ${input.run_id}/${input.actor_id}`);
      if (actor.node_id !== input.node_id) {
        throw new DagActorLiveCommandConflictError(
          "live_command_identity_conflict",
          `Actor ${input.run_id}/${input.actor_id} is bound to node ${actor.node_id}, not ${input.node_id}`,
        );
      }
      if (Number(actor.generation) !== input.target_generation) {
        throw new DagActorLiveCommandConflictError(
          "live_command_generation_conflict",
          `Actor ${input.run_id}/${input.actor_id} is generation ${actor.generation}, not ${input.target_generation}`,
        );
      }
      const sequence = Number((db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM dag_actor_live_commands WHERE run_id = ? AND actor_id = ?
      `).get(input.run_id, input.actor_id) as { sequence: number }).sequence);
      const now = Date.now();
      db.prepare(`
        INSERT INTO dag_actor_live_commands(
          command_id, run_id, actor_id, node_id, session_id, round_id,
          target_generation, target_lease_generation, expected_state_token, sequence,
          status, idempotency_key, payload_digest, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      `).run(
        input.command_id,
        input.run_id,
        input.actor_id,
        input.node_id,
        input.session_id,
        input.round_id,
        input.target_generation,
        input.target_lease_generation,
        input.expected_state_token,
        sequence,
        input.idempotency_key,
        input.payload_digest,
        input.payload_json,
        now,
        now,
      );
      results.push({ command: commandFromRow(getRow(input.command_id)!), changed: true, deduplicated: false });
    }
    return results;
  }).immediate();
}

export function getDagActorLiveCommand(rawCommandId: string): DagActorLiveCommandRecord | undefined {
  const commandId = assertIdentifier(rawCommandId, "command_id");
  const row = getRow(commandId);
  return row ? commandFromRow(row) : undefined;
}

export function listDagActorLiveCommands(input: {
  run_id: string;
  actor_id?: string;
  status?: DagActorLiveCommandStatus;
  fallback_pending?: boolean;
  limit?: number;
}): DagActorLiveCommandRecord[] {
  const conditions = ["run_id = ?"];
  const params: unknown[] = [assertIdentifier(input.run_id, "run_id")];
  if (input.actor_id !== undefined) {
    conditions.push("actor_id = ?");
    params.push(assertIdentifier(input.actor_id, "actor_id"));
  }
  if (input.status !== undefined) {
    if (!LIVE_COMMAND_STATUS_SET.has(input.status)) throw new Error(`Invalid live command status: ${input.status}`);
    conditions.push("status = ?");
    params.push(input.status);
  }
  if (input.fallback_pending !== undefined) {
    conditions.push(input.fallback_pending ? "fallback_reason_json IS NOT NULL" : "fallback_reason_json IS NULL");
  }
  const requestedLimit = input.limit ?? DEFAULT_DAG_ACTOR_LIVE_COMMAND_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("limit must be a positive safe integer");
  }
  params.push(Math.min(requestedLimit, MAX_DAG_ACTOR_LIVE_COMMAND_LIMIT));
  return (getDb().prepare(`
    SELECT * FROM dag_actor_live_commands
    WHERE ${conditions.join(" AND ")}
    ORDER BY actor_id, sequence, command_id
    LIMIT ?
  `).all(...params) as DagActorLiveCommandRow[]).map(commandFromRow);
}

/** Complete nonterminal set used by ordered fallback and recovery. The create
 * transaction enforces the matching per-run bound, so this query cannot grow
 * without limit or silently hide a later Actor sequence. */
export function listOutstandingDagActorLiveCommands(runId: string): DagActorLiveCommandRecord[] {
  return (getDb().prepare(`
    SELECT * FROM dag_actor_live_commands
    WHERE run_id = ? AND status IN ('queued', 'delivered', 'applied')
    ORDER BY actor_id, sequence, command_id
  `).all(assertIdentifier(runId, "run_id")) as DagActorLiveCommandRow[]).map(commandFromRow);
}

export function recordDagActorLiveCommandSendAttempt(input: {
  command_id: string;
  session_id: string;
  round_id: string;
  lease_generation: number;
  sent_at?: number;
}): DagActorLiveCommandMutationResult {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const sessionId = assertIdentifier(input.session_id, "session_id", 512);
  const roundId = assertIdentifier(input.round_id, "round_id");
  const leaseGeneration = assertPositiveSafeInteger(input.lease_generation, "lease_generation");
  const sentAt = input.sent_at ?? Date.now();
  assertNonNegativeSafeInteger(sentAt, "sent_at");
  const db = getDb();
  return db.transaction(() => {
    const current = requireCommand(commandId);
    if (current.status !== "queued") {
      return { command: current, changed: false, deduplicated: true };
    }
    if (sentAt < current.created_at) throw new Error("sent_at must not precede command creation");
    const changed = db.prepare(`
      UPDATE dag_actor_live_commands SET
        session_id = ?, round_id = ?, target_lease_generation = ?,
        delivery_attempts = delivery_attempts + 1, last_sent_at = ?,
        fallback_reason_json = NULL, updated_at = ?
      WHERE command_id = ? AND status = 'queued'
    `).run(sessionId, roundId, leaseGeneration, sentAt, sentAt, commandId);
    if (changed.changes !== 1) {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live command ${commandId} changed concurrently`,
      );
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  }).immediate();
}

export function markDagActorLiveCommandFallback(input: {
  command_id: string;
  reason: string;
}): DagActorLiveCommandMutationResult {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const reasonJson = encodeReason(input.reason, "live delivery unavailable");
  const db = getDb();
  return db.transaction(() => {
    const current = requireCommand(commandId);
    if (current.status !== "queued") {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live command ${commandId} is ${current.status}, not queued`,
      );
    }
    if (current.fallback_reason === decodeReason(reasonJson)) {
      return { command: current, changed: false, deduplicated: true };
    }
    const now = Date.now();
    const changed = db.prepare(`
      UPDATE dag_actor_live_commands SET fallback_reason_json = ?, updated_at = ?
      WHERE command_id = ? AND status = 'queued'
    `).run(reasonJson, now, commandId);
    if (changed.changes !== 1) {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live command ${commandId} changed concurrently`,
      );
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  }).immediate();
}

export function transitionDagActorLiveCommand(input: {
  command_id: string;
  status: Exclude<DagActorLiveCommandStatus, "queued">;
  reason?: string;
  transitioned_at?: number;
}): DagActorLiveCommandMutationResult {
  const commandId = assertIdentifier(input.command_id, "command_id");
  const transitionedAt = input.transitioned_at ?? Date.now();
  assertNonNegativeSafeInteger(transitionedAt, "transitioned_at");
  const db = getDb();

  return db.transaction(() => {
    const current = requireCommand(commandId);
    if (current.status === input.status) {
      return { command: current, changed: false, deduplicated: true };
    }
    if (TERMINAL_STATUS_SET.has(current.status)) {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live command ${commandId} is already terminal (${current.status})`,
      );
    }
    if (transitionedAt < current.created_at) {
      throw new Error("transitioned_at must not precede command creation");
    }
    const rank: Record<"queued" | "delivered" | "applied" | "completed", number> = {
      queued: 0,
      delivered: 1,
      applied: 2,
      completed: 3,
    };
    if (
      (input.status === "delivered" || input.status === "applied" || input.status === "completed")
      && rank[input.status] < rank[current.status as keyof typeof rank]
    ) {
      return { command: current, changed: false, deduplicated: true };
    }

    const terminalReasonJson = input.status === "rejected"
      || input.status === "failed"
      || input.status === "superseded"
      || input.status === "cancelled"
      ? encodeReason(input.reason, `live command ${input.status}`)
      : null;
    const changed = db.prepare(`
      UPDATE dag_actor_live_commands SET
        status = ?,
        delivered_at = CASE WHEN ? IN ('delivered', 'applied', 'completed')
          THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
        applied_at = CASE WHEN ? IN ('applied', 'completed')
          THEN COALESCE(applied_at, ?) ELSE applied_at END,
        terminal_at = CASE WHEN ? IN ('completed', 'rejected', 'failed', 'superseded', 'cancelled')
          THEN ? ELSE NULL END,
        fallback_reason_json = NULL,
        terminal_reason_json = ?,
        updated_at = ?
      WHERE command_id = ? AND status IN ('queued', 'delivered', 'applied')
    `).run(
      input.status,
      input.status,
      transitionedAt,
      input.status,
      transitionedAt,
      input.status,
      transitionedAt,
      terminalReasonJson,
      transitionedAt,
      commandId,
    );
    if (changed.changes !== 1) {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live command ${commandId} changed concurrently`,
      );
    }
    return { command: requireCommand(commandId), changed: true, deduplicated: false };
  }).immediate();
}

export function terminateDagActorLiveCommands(input: {
  run_id: string;
  actor_id?: string;
  status: "superseded" | "cancelled";
  reason: string;
  transitioned_at?: number;
}): DagActorLiveCommandRecord[] {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = input.actor_id === undefined ? undefined : assertIdentifier(input.actor_id, "actor_id");
  const transitionedAt = input.transitioned_at ?? Date.now();
  assertNonNegativeSafeInteger(transitionedAt, "transitioned_at");
  const reasonJson = encodeReason(input.reason, `live command ${input.status}`);
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT command_id, created_at FROM dag_actor_live_commands
      WHERE run_id = ? AND (? IS NULL OR actor_id = ?) AND status IN ('queued', 'delivered', 'applied')
      ORDER BY actor_id, sequence
    `).all(runId, actorId ?? null, actorId ?? null) as Array<{ command_id: string; created_at: number }>;
    if (rows.length === 0) return [];
    if (rows.some((row) => transitionedAt < Number(row.created_at))) {
      throw new Error("transitioned_at must not precede command creation");
    }
    const changed = db.prepare(`
      UPDATE dag_actor_live_commands SET
        status = ?, terminal_at = ?, fallback_reason_json = NULL,
        terminal_reason_json = ?, updated_at = ?
      WHERE run_id = ? AND (? IS NULL OR actor_id = ?) AND status IN ('queued', 'delivered', 'applied')
    `).run(
      input.status,
      transitionedAt,
      reasonJson,
      transitionedAt,
      runId,
      actorId ?? null,
      actorId ?? null,
    );
    if (changed.changes !== rows.length) {
      throw new DagActorLiveCommandConflictError(
        "live_command_status_conflict",
        `Live commands for ${actorId ? `${runId}/${actorId}` : runId} changed concurrently`,
      );
    }
    return rows.map((row) => requireCommand(row.command_id));
  }).immediate();
}

export function isDagActorLiveCommandTerminal(status: DagActorLiveCommandStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

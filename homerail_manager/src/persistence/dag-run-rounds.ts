import { getDb, parseJsonRow } from "./db.js";
import type { DagRunRoundStatus } from "./types.js";

export interface DagRunRoundRecord {
  run_id: string;
  round_id: string;
  ordinal: number;
  status: DagRunRoundStatus;
  target_actor_ids: string[];
  await_node_id?: string;
  opened_at: number;
  closed_at?: number;
  expires_at?: number;
}

export type DagRunRoundConflictCode =
  | "initial_round_conflict"
  | "round_not_found"
  | "round_identity_conflict"
  | "round_status_conflict"
  | "current_round_conflict";

export class DagRunRoundConflictError extends Error {
  constructor(
    public readonly code: DagRunRoundConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "DagRunRoundConflictError";
  }
}

interface DagRunRoundRow extends Record<string, unknown> {
  run_id: string;
  round_id: string;
  ordinal: number;
  status: DagRunRoundStatus;
  target_actor_ids_json: string;
  await_node_id: string | null;
  opened_at: number;
  closed_at: number | null;
  expires_at: number | null;
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${label} must be between 1 and 256 characters`);
  }
  return normalized;
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative epoch millisecond integer`);
  }
  return value;
}

function normalizeTargetActorIds(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => assertIdentifier(value, "target_actor_id")))).sort();
}

function roundFromRow(row: DagRunRoundRow): DagRunRoundRecord {
  const targetActorIds = parseJsonRow<unknown>(row.target_actor_ids_json);
  if (!Array.isArray(targetActorIds) || targetActorIds.some((value) => typeof value !== "string")) {
    throw new Error(`DAG run round ${row.run_id}/${row.round_id} has invalid target_actor_ids_json`);
  }
  return {
    run_id: row.run_id,
    round_id: row.round_id,
    ordinal: Number(row.ordinal),
    status: row.status,
    target_actor_ids: [...targetActorIds],
    ...(row.await_node_id === null ? {} : { await_node_id: row.await_node_id }),
    opened_at: Number(row.opened_at),
    ...(row.closed_at === null ? {} : { closed_at: Number(row.closed_at) }),
    ...(row.expires_at === null ? {} : { expires_at: Number(row.expires_at) }),
  };
}

function getRoundRow(runId: string, roundId: string): DagRunRoundRow | undefined {
  return getDb().prepare("SELECT * FROM dag_run_rounds WHERE run_id = ? AND round_id = ?")
    .get(runId, roundId) as DagRunRoundRow | undefined;
}

function requireRound(runId: string, roundId: string): DagRunRoundRecord {
  const row = getRoundRow(runId, roundId);
  if (!row) {
    throw new DagRunRoundConflictError(
      "round_not_found",
      `Unknown DAG run round: ${runId}/${roundId}`,
    );
  }
  return roundFromRow(row);
}

function assertExpectedCurrentRound(runId: string, roundId: string): DagRunRoundRecord {
  const requested = requireRound(runId, roundId);
  const current = getCurrentDagRunRound(runId);
  if (!current || current.round_id !== roundId) {
    throw new DagRunRoundConflictError(
      "current_round_conflict",
      `DAG run ${runId} current round is ${current?.round_id ?? "absent"}, expected ${roundId}`,
    );
  }
  return requested;
}

export function createInitialDagRunRound(input: {
  run_id: string;
  round_id: string;
  target_actor_ids: readonly string[];
  status?: DagRunRoundStatus;
  await_node_id?: string;
  opened_at?: number;
  closed_at?: number;
  expires_at?: number;
}): DagRunRoundRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const roundId = assertIdentifier(input.round_id, "round_id");
  const targetActorIds = normalizeTargetActorIds(input.target_actor_ids);
  const status = input.status ?? "active";
  const awaitNodeId = input.await_node_id === undefined
    ? undefined
    : assertIdentifier(input.await_node_id, "await_node_id");
  const openedAt = assertTimestamp(input.opened_at ?? Date.now(), "opened_at");
  const closedAt = input.closed_at === undefined
    ? undefined
    : assertTimestamp(input.closed_at, "closed_at");
  const expiresAt = input.expires_at === undefined
    ? undefined
    : assertTimestamp(input.expires_at, "expires_at");
  if (expiresAt !== undefined && expiresAt < openedAt) {
    throw new Error("expires_at must not precede opened_at");
  }
  if (closedAt !== undefined && closedAt < openedAt) {
    throw new Error("closed_at must not precede opened_at");
  }
  if (status === "active" && (awaitNodeId !== undefined || closedAt !== undefined)) {
    throw new Error("An active initial round cannot have await_node_id or closed_at");
  }
  if (status === "waiting" && (awaitNodeId === undefined || closedAt === undefined)) {
    throw new Error("A waiting initial round requires await_node_id and closed_at");
  }
  if (
    (status === "completed" || status === "cancelled" || status === "failed")
    && closedAt === undefined
  ) {
    throw new Error(`A ${status} initial round requires closed_at`);
  }
  const db = getDb();

  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM dag_runs WHERE run_id = ?").get(runId)) {
      throw new Error(`Unknown DAG run: ${runId}`);
    }
    const existing = db.prepare("SELECT round_id FROM dag_run_rounds WHERE run_id = ? LIMIT 1")
      .get(runId) as { round_id: string } | undefined;
    if (existing) {
      throw new DagRunRoundConflictError(
        "initial_round_conflict",
        `DAG run ${runId} already has round ${existing.round_id}`,
      );
    }
    db.prepare(`
      INSERT INTO dag_run_rounds(
        run_id, round_id, ordinal, status, target_actor_ids_json,
        await_node_id, opened_at, closed_at, expires_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      roundId,
      status,
      JSON.stringify(targetActorIds),
      awaitNodeId ?? null,
      openedAt,
      closedAt ?? null,
      expiresAt ?? null,
    );
    return requireRound(runId, roundId);
  })();
}

export function getDagRunRound(runId: string, roundId: string): DagRunRoundRecord | undefined {
  const row = getRoundRow(
    assertIdentifier(runId, "run_id"),
    assertIdentifier(roundId, "round_id"),
  );
  return row ? roundFromRow(row) : undefined;
}

export function getCurrentDagRunRound(runId: string): DagRunRoundRecord | undefined {
  const normalizedRunId = assertIdentifier(runId, "run_id");
  const row = getDb().prepare(`
    SELECT * FROM dag_run_rounds
    WHERE run_id = ? AND status IN ('active', 'waiting')
  `).get(normalizedRunId) as DagRunRoundRow | undefined;
  return row ? roundFromRow(row) : undefined;
}

export function listDagRunRounds(runId: string): DagRunRoundRecord[] {
  const normalizedRunId = assertIdentifier(runId, "run_id");
  return (getDb().prepare(`
    SELECT * FROM dag_run_rounds
    WHERE run_id = ?
    ORDER BY ordinal, round_id
  `).all(normalizedRunId) as DagRunRoundRow[]).map(roundFromRow);
}

export function transitionDagRunRoundToWaiting(input: {
  run_id: string;
  round_id: string;
  await_node_id: string;
  closed_at?: number;
  expires_at?: number;
}): DagRunRoundRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const roundId = assertIdentifier(input.round_id, "round_id");
  const awaitNodeId = assertIdentifier(input.await_node_id, "await_node_id");
  const closedAt = assertTimestamp(input.closed_at ?? Date.now(), "closed_at");
  const expiresAt = input.expires_at === undefined
    ? undefined
    : assertTimestamp(input.expires_at, "expires_at");
  const db = getDb();

  return db.transaction(() => {
    const current = assertExpectedCurrentRound(runId, roundId);
    if (current.status !== "active") {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${roundId} is ${current.status}, not active`,
      );
    }
    if (closedAt < current.opened_at) throw new Error("closed_at must not precede opened_at");
    if (expiresAt !== undefined && expiresAt < closedAt) {
      throw new Error("expires_at must not precede closed_at");
    }
    const changed = db.prepare(`
      UPDATE dag_run_rounds SET
        status = 'waiting',
        await_node_id = ?,
        closed_at = ?,
        expires_at = ?
      WHERE run_id = ? AND round_id = ? AND status = 'active' AND closed_at IS NULL
    `).run(awaitNodeId, closedAt, expiresAt ?? null, runId, roundId);
    if (changed.changes !== 1) {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${roundId} changed concurrently`,
      );
    }
    return requireRound(runId, roundId);
  })();
}

export function openNextDagRunRound(input: {
  run_id: string;
  expected_round_id: string;
  round_id: string;
  target_actor_ids: readonly string[];
  opened_at?: number;
  expires_at?: number;
}): DagRunRoundRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const currentRoundId = assertIdentifier(input.expected_round_id, "expected_round_id");
  const nextRoundId = assertIdentifier(input.round_id, "round_id");
  const targetActorIds = normalizeTargetActorIds(input.target_actor_ids);
  const openedAt = assertTimestamp(input.opened_at ?? Date.now(), "opened_at");
  const expiresAt = input.expires_at === undefined
    ? undefined
    : assertTimestamp(input.expires_at, "expires_at");
  const db = getDb();

  return db.transaction(() => {
    const current = assertExpectedCurrentRound(runId, currentRoundId);
    if (current.status !== "waiting") {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${currentRoundId} is ${current.status}, not waiting`,
      );
    }
    if (openedAt < (current.closed_at ?? current.opened_at)) {
      throw new Error("opened_at must not precede the previous round closure");
    }
    if (expiresAt !== undefined && expiresAt < openedAt) {
      throw new Error("expires_at must not precede opened_at");
    }
    if (getRoundRow(runId, nextRoundId)) {
      throw new DagRunRoundConflictError(
        "round_identity_conflict",
        `DAG run round ${runId}/${nextRoundId} already exists`,
      );
    }

    const completed = db.prepare(`
      UPDATE dag_run_rounds SET status = 'completed'
      WHERE run_id = ? AND round_id = ? AND status = 'waiting'
    `).run(runId, currentRoundId);
    if (completed.changes !== 1) {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${currentRoundId} changed concurrently`,
      );
    }
    db.prepare(`
      INSERT INTO dag_run_rounds(
        run_id, round_id, ordinal, status, target_actor_ids_json,
        await_node_id, opened_at, closed_at, expires_at
      ) VALUES (?, ?, ?, 'active', ?, NULL, ?, NULL, ?)
    `).run(
      runId,
      nextRoundId,
      current.ordinal + 1,
      JSON.stringify(targetActorIds),
      openedAt,
      expiresAt ?? null,
    );
    return requireRound(runId, nextRoundId);
  })();
}

export function terminalizeCurrentDagRunRound(input: {
  run_id: string;
  round_id: string;
  status: "completed" | "cancelled" | "failed";
  closed_at?: number;
}): DagRunRoundRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const roundId = assertIdentifier(input.round_id, "round_id");
  const closedAt = assertTimestamp(input.closed_at ?? Date.now(), "closed_at");
  const db = getDb();

  return db.transaction(() => {
    const current = assertExpectedCurrentRound(runId, roundId);
    if (current.status !== "active" && current.status !== "waiting") {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${roundId} is already ${current.status}`,
      );
    }
    if (closedAt < current.opened_at) throw new Error("closed_at must not precede opened_at");
    const changed = db.prepare(`
      UPDATE dag_run_rounds SET
        status = ?,
        closed_at = COALESCE(closed_at, ?)
      WHERE run_id = ? AND round_id = ? AND status IN ('active', 'waiting')
    `).run(input.status, closedAt, runId, roundId);
    if (changed.changes !== 1) {
      throw new DagRunRoundConflictError(
        "round_status_conflict",
        `DAG run round ${runId}/${roundId} changed concurrently`,
      );
    }
    return requireRound(runId, roundId);
  })();
}

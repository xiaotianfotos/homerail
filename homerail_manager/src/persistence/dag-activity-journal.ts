import { createHash } from "node:crypto";
import {
  type DagActivityEventV1,
  redactTelemetry,
  validateDagActivityEventV1,
} from "homerail-protocol";
import { getDb, parseJsonRow } from "./db.js";

export const DEFAULT_DAG_ACTIVITY_REPLAY_LIMIT = 100;
export const MAX_DAG_ACTIVITY_REPLAY_LIMIT = 500;
export const MAX_DAG_ACTIVITY_ROUND_RESULTS = 1_000;
export const MAX_DAG_ACTIVITY_EVENT_BYTES = 256 * 1024;
export const MAX_DAG_ACTIVITY_SEQUENCE_AHEAD = 64;

export interface DagActivityJournalEntry {
  /** Monotonic journal cursor. It does not imply a cross-actor causal order. */
  seq: number;
  received_at: number;
  event: DagActivityEventV1;
}

export interface AppendDagActivityEventResult extends DagActivityJournalEntry {
  inserted: boolean;
  deduplicated: boolean;
}

export interface ListDagActivityEventsOptions {
  run_id: string;
  actor_id?: string;
  after_seq?: number;
  limit?: number;
}

export interface DagActivityEventPage {
  events: DagActivityJournalEntry[];
  /** Cursor to pass as `after_seq` for the next page. */
  next_after_seq: number;
  has_more: boolean;
  limit: number;
}

export interface DagActivityRoundResultPage {
  events: DagActivityJournalEntry[];
  total: number;
  truncated: boolean;
  limit: number;
}

export class DagActivityJournalConflictError extends Error {
  constructor(
    public readonly code: "event_id_collision" | "sequence_collision" | "sequence_gap",
    message: string,
  ) {
    super(message);
    this.name = "DagActivityJournalConflictError";
  }
}

/** Highest contiguous sequence starting at 1 for one actor generation. */
export function getDagActivityContiguousSequenceCursor(
  runId: string,
  actorId: string,
  generation: number,
): number {
  assertIdentifier(runId, "run_id");
  assertIdentifier(actorId, "actor_id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("generation must be a positive safe integer");
  }
  const db = getDb();
  const first = db.prepare(`
    SELECT 1 AS present
    FROM dag_activity_events
    WHERE run_id = ? AND actor_id = ? AND generation = ? AND activity_sequence = 1
  `).get(runId, actorId, generation);
  if (!first) return 0;
  const row = db.prepare(`
    SELECT MIN(current.activity_sequence) AS sequence
    FROM dag_activity_events current
    LEFT JOIN dag_activity_events next
      ON next.run_id = current.run_id
      AND next.actor_id = current.actor_id
      AND next.generation = current.generation
      AND next.activity_sequence = current.activity_sequence + 1
    WHERE current.run_id = ? AND current.actor_id = ? AND current.generation = ?
      AND next.seq IS NULL
  `).get(runId, actorId, generation) as { sequence: number | null };
  return Number(row.sequence ?? 0);
}

interface ActivityRow {
  seq: number;
  event_id: string;
  run_id: string;
  actor_id: string;
  generation: number;
  activity_sequence: number;
  received_at: number;
  event_digest: string;
  event_json: string;
}

function validationDetails(event: unknown): string | undefined {
  const result = validateDagActivityEventV1(event);
  if (result.valid) return undefined;
  return result.errors
    .slice(0, 5)
    .map((error) => `${error.path || "/"} ${error.message}`)
    .join("; ");
}

function assertValidEvent(event: unknown): asserts event is DagActivityEventV1 {
  const details = validationDetails(event);
  if (details) throw new Error(`Invalid DAG activity event: ${details}`);
}

function assertEventSize(event: unknown): void {
  let eventJson: string | undefined;
  try {
    eventJson = JSON.stringify(event);
  } catch {
    throw new Error("DAG activity event must be JSON serializable");
  }
  if (eventJson === undefined) {
    throw new Error("DAG activity event must be JSON serializable");
  }
  if (Buffer.byteLength(eventJson, "utf8") > MAX_DAG_ACTIVITY_EVENT_BYTES) {
    throw new Error(`DAG activity event exceeds ${MAX_DAG_ACTIVITY_EVENT_BYTES} bytes`);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
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

function encodeCanonicalEvent(event: DagActivityEventV1): { event_json: string; event_digest: string } {
  const eventJson = JSON.stringify(canonicalize(event));
  return {
    event_json: eventJson,
    event_digest: createHash("sha256").update(eventJson).digest("hex"),
  };
}

function redactEvent(event: DagActivityEventV1): DagActivityEventV1 {
  const redacted = {
    ...event,
    payload: redactTelemetry(event.payload),
  };
  assertValidEvent(redacted);
  return redacted;
}

function decodeEntry(row: Pick<ActivityRow, "seq" | "received_at" | "event_json">): DagActivityJournalEntry {
  const event = parseJsonRow<unknown>(row.event_json);
  assertValidEvent(event);
  return { seq: row.seq, received_at: row.received_at, event };
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value.length > 256) throw new Error(`${label} must be between 1 and 256 characters`);
}

function normalizeCursor(value: number | undefined): number {
  const cursor = value ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("after_seq must be a non-negative safe integer");
  }
  return cursor;
}

function normalizeLimit(value: number | undefined): number {
  const requested = value ?? DEFAULT_DAG_ACTIVITY_REPLAY_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("limit must be a positive safe integer");
  }
  return Math.min(requested, MAX_DAG_ACTIVITY_REPLAY_LIMIT);
}

/**
 * Append one redacted activity to the durable journal.
 *
 * Replaying the same semantic event_id is idempotent. Reusing an event_id for
 * different content, or reusing an actor generation sequence with another
 * event_id, fails closed.
 */
export function appendDagActivityEvent(event: unknown): AppendDagActivityEventResult {
  // Reject oversized untrusted input before schema traversal and regex redaction.
  assertEventSize(event);
  assertValidEvent(event);
  const storedEvent = redactEvent(event);
  const encoded = encodeCanonicalEvent(storedEvent);
  const encodedBytes = Buffer.byteLength(encoded.event_json, "utf8");
  if (encodedBytes > MAX_DAG_ACTIVITY_EVENT_BYTES) {
    throw new Error(`DAG activity event exceeds ${MAX_DAG_ACTIVITY_EVENT_BYTES} bytes`);
  }
  const db = getDb();

  return db.transaction(() => {
    const byId = db.prepare(`
      SELECT seq, event_id, run_id, actor_id, generation, activity_sequence,
             received_at, event_digest, event_json
      FROM dag_activity_events
      WHERE event_id = ?
    `).get(storedEvent.event_id) as ActivityRow | undefined;
    if (byId) {
      if (byId.event_digest !== encoded.event_digest || byId.event_json !== encoded.event_json) {
        throw new DagActivityJournalConflictError(
          "event_id_collision",
          `DAG activity event_id ${storedEvent.event_id} already identifies different content`,
        );
      }
      return {
        ...decodeEntry(byId),
        inserted: false,
        deduplicated: true,
      };
    }

    const run = db.prepare("SELECT 1 FROM dag_runs WHERE run_id = ?").get(storedEvent.run_id);
    if (!run) throw new Error(`Unknown DAG run: ${storedEvent.run_id}`);

    const byActorSequence = db.prepare(`
      SELECT event_id
      FROM dag_activity_events
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND activity_sequence = ?
    `).get(
      storedEvent.run_id,
      storedEvent.actor_id,
      storedEvent.generation,
      storedEvent.sequence,
    ) as { event_id: string } | undefined;
    if (byActorSequence) {
      throw new DagActivityJournalConflictError(
        "sequence_collision",
        `DAG activity sequence ${storedEvent.sequence} is already used by actor ${storedEvent.actor_id} generation ${storedEvent.generation}`,
      );
    }

    const contiguousSequence = getDagActivityContiguousSequenceCursor(
      storedEvent.run_id,
      storedEvent.actor_id,
      storedEvent.generation,
    );
    if (storedEvent.sequence > contiguousSequence + MAX_DAG_ACTIVITY_SEQUENCE_AHEAD) {
      throw new DagActivityJournalConflictError(
        "sequence_gap",
        `DAG activity sequence ${storedEvent.sequence} is more than ${MAX_DAG_ACTIVITY_SEQUENCE_AHEAD} entries ahead of contiguous sequence ${contiguousSequence}`,
      );
    }

    const receivedAt = Date.now();
    const inserted = db.prepare(`
      INSERT INTO dag_activity_events(
        event_id, schema_version, run_id, round_id, node_id, actor_id, generation,
        surface_id, activity_sequence, activity_type, timestamp, received_at,
        event_digest, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      storedEvent.event_id,
      storedEvent.schema_version,
      storedEvent.run_id,
      storedEvent.round_id,
      storedEvent.node_id,
      storedEvent.actor_id,
      storedEvent.generation,
      storedEvent.surface_id ?? null,
      storedEvent.sequence,
      storedEvent.type,
      storedEvent.timestamp,
      receivedAt,
      encoded.event_digest,
      encoded.event_json,
    );
    const seq = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error("DAG activity journal returned an invalid sequence");
    }
    return {
      seq,
      received_at: receivedAt,
      event: storedEvent,
      inserted: true,
      deduplicated: false,
    };
  }).immediate();
}

/** Replay a bounded journal page in durable insertion order. */
export function listDagActivityEvents(options: ListDagActivityEventsOptions): DagActivityEventPage {
  assertIdentifier(options.run_id, "run_id");
  if (options.actor_id !== undefined) assertIdentifier(options.actor_id, "actor_id");
  const afterSeq = normalizeCursor(options.after_seq);
  const limit = normalizeLimit(options.limit);
  const params: Array<string | number> = [options.run_id, afterSeq];
  const actorClause = options.actor_id === undefined ? "" : " AND actor_id = ?";
  if (options.actor_id !== undefined) params.push(options.actor_id);
  params.push(limit + 1);

  const rows = getDb().prepare(`
    SELECT seq, received_at, event_json
    FROM dag_activity_events
    WHERE run_id = ? AND seq > ?${actorClause}
    ORDER BY seq ASC
    LIMIT ?
  `).all(...params) as Array<Pick<ActivityRow, "seq" | "received_at" | "event_json">>;
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(decodeEntry);
  return {
    events,
    next_after_seq: events.at(-1)?.seq ?? afterSeq,
    has_more: hasMore,
    limit,
  };
}

/**
 * Select one accepted result per Actor for a round. Terminal milestones outrank
 * findings, and only the Actor registry's current generation is eligible.
 */
export function listLatestDagActivityRoundResults(options: {
  run_id: string;
  round_id: string;
  limit?: number;
}): DagActivityRoundResultPage {
  assertIdentifier(options.run_id, "run_id");
  assertIdentifier(options.round_id, "round_id");
  const requestedLimit = options.limit ?? MAX_DAG_ACTIVITY_ROUND_RESULTS;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("limit must be a positive safe integer");
  }
  const limit = Math.min(requestedLimit, MAX_DAG_ACTIVITY_ROUND_RESULTS);
  const rows = getDb().prepare(`
    WITH ranked AS (
      SELECT activity.seq, activity.received_at, activity.event_json,
        ROW_NUMBER() OVER (
          PARTITION BY activity.actor_id
          ORDER BY
            CASE WHEN activity.activity_type IN ('blocked', 'completed', 'failed') THEN 0 ELSE 1 END,
            activity.seq DESC
        ) AS actor_rank
      FROM dag_activity_events activity
      INNER JOIN dag_actors actor
        ON actor.run_id = activity.run_id
        AND actor.actor_id = activity.actor_id
        AND actor.generation = activity.generation
      WHERE activity.run_id = ?
        AND activity.round_id = ?
        AND activity.activity_type IN ('finding', 'blocked', 'completed', 'failed')
    )
    SELECT seq, received_at, event_json, COUNT(*) OVER () AS total
    FROM ranked
    WHERE actor_rank = 1
    ORDER BY seq ASC
    LIMIT ?
  `).all(options.run_id, options.round_id, limit) as Array<Pick<ActivityRow, "seq" | "received_at" | "event_json"> & {
    total: number;
  }>;
  const events = rows.map(decodeEntry);
  const total = Number(rows[0]?.total ?? 0);
  return {
    events,
    total,
    truncated: total > events.length,
    limit,
  };
}

/** Last durable sequence assigned within one actor generation. */
export function getDagActivitySequenceCursor(
  runId: string,
  actorId: string,
  generation: number,
): number {
  assertIdentifier(runId, "run_id");
  assertIdentifier(actorId, "actor_id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("generation must be a positive safe integer");
  }
  const row = getDb().prepare(`
    SELECT COALESCE(MAX(activity_sequence), 0) AS sequence
    FROM dag_activity_events
    WHERE run_id = ? AND actor_id = ? AND generation = ?
  `).get(runId, actorId, generation) as { sequence: number };
  return row.sequence;
}

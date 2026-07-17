import { createHash } from "node:crypto";
import {
  DAG_ACTOR_SURFACE_PATCH_MAX_BYTES,
  redactTelemetry,
  validateDagActorSurfacePatchV1,
  type DagActorSurfaceBodyV1,
  type DagActorSurfacePatchPhaseV1,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import { getDagActor, type DagActorRecord } from "./dag-actors.js";
import { getDagActorLease } from "./dag-actor-leases.js";
import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { getCurrentDagRunRound } from "./dag-run-rounds.js";

export const MAX_DAG_ACTOR_SURFACE_PATCH_SEQUENCE_AHEAD = 64;
export const MAX_DAG_ACTOR_SURFACE_PATCH_JOURNAL_ROWS = 256;
export const MAX_DAG_ACTOR_SURFACE_PATCH_REPLAY_LIMIT = 500;

export type DagActorSurfacePatchQueueStatus =
  | "pending"
  | "applied"
  | "noop"
  | "coalesced"
  | "stale"
  | "rejected";

export type DagActorSurfacePatchApplyKind =
  | "update_data_model"
  | "patch_components"
  | "clear_body"
  | "no_op"
  | "coalesced";

export interface DagActorSurfacePatchJournalEntry {
  journal_seq: number;
  surface_id: string;
  received_at: number;
  patch: DagActorSurfacePatchV1;
}

export interface DagActorSurfacePatchQueueRecord {
  journal_seq: number;
  patch_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  generation: number;
  patch_sequence: number;
  status: DagActorSurfacePatchQueueStatus;
  apply_kind?: DagActorSurfacePatchApplyKind;
  body_revision?: number;
  visual_revision?: number;
  transaction_id?: string;
  queued_at: number;
  applied_at?: number;
  failure?: unknown;
}

export interface DagActorSurfacePatchMilestoneRecord extends DagActorSurfacePatchQueueRecord {
  phase: DagActorSurfacePatchPhaseV1;
}

export interface QueuedDagActorSurfacePatch extends DagActorSurfacePatchJournalEntry {
  queue: DagActorSurfacePatchQueueRecord;
}

export interface DagActorSurfaceViewRecord {
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  document_id: string;
  generation: number;
  session_id?: string;
  round_id?: string;
  lease_generation?: number;
  body_revision: number;
  visual_revision: number;
  body?: DagActorSurfaceBodyV1;
  last_patch_id?: string;
  phase?: DagActorSurfacePatchPhaseV1;
  component_digest?: string;
  body_digest?: string;
  last_transaction_id?: string;
  last_applied_at?: number;
  last_focus_at?: number;
  created_at: number;
  updated_at: number;
}

export interface DagActorSurfaceSnapshotRecord {
  run_id: string;
  actor_id: string;
  generation: number;
  node_id: string;
  surface_id: string;
  document_id: string;
  body_revision: number;
  visual_revision: number;
  body?: DagActorSurfaceBodyV1;
  last_patch_id?: string;
  phase?: DagActorSurfacePatchPhaseV1;
  body_digest?: string;
  superseded_by_generation: number;
  created_at: number;
}

export interface AppendDagActorSurfacePatchResult {
  journal: DagActorSurfacePatchJournalEntry;
  queue: DagActorSurfacePatchQueueRecord;
  inserted: boolean;
  deduplicated: boolean;
}

export class DagActorSurfacePatchConflictError extends Error {
  constructor(
    public readonly code:
      | "identity_mismatch"
      | "session_mismatch"
      | "round_mismatch"
      | "generation_conflict"
      | "lease_conflict"
      | "patch_id_collision"
      | "sequence_collision"
      | "stale_revision"
      | "sequence_gap"
      | "view_revision_conflict"
      | "queue_state_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DagActorSurfacePatchConflictError";
  }
}

interface JournalRow {
  journal_seq: number;
  patch_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  generation: number;
  patch_sequence: number;
  received_at: number;
  patch_digest: string;
  patch_json: string;
}

interface QueueRow {
  journal_seq: number;
  patch_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  generation: number;
  patch_sequence: number;
  status: DagActorSurfacePatchQueueStatus;
  apply_kind: DagActorSurfacePatchApplyKind | null;
  body_revision: number | null;
  visual_revision: number | null;
  transaction_id: string | null;
  queued_at: number;
  applied_at: number | null;
  failure_json: string | null;
}

interface ViewRow {
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  document_id: string;
  generation: number;
  session_id: string | null;
  round_id: string | null;
  lease_generation: number | null;
  body_revision: number;
  visual_revision: number;
  has_body: number;
  last_patch_id: string | null;
  phase: DagActorSurfacePatchPhaseV1 | null;
  a2ui_json: string | null;
  data_json: string | null;
  fallback_json: string | null;
  presentation_hint_json: string | null;
  component_digest: string | null;
  body_digest: string | null;
  last_transaction_id: string | null;
  last_applied_at: number | null;
  last_focus_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  run_id: string;
  actor_id: string;
  generation: number;
  node_id: string;
  surface_id: string;
  document_id: string;
  body_revision: number;
  visual_revision: number;
  has_body: number;
  last_patch_id: string | null;
  phase: DagActorSurfacePatchPhaseV1 | null;
  body_digest: string | null;
  body_json: string | null;
  superseded_by_generation: number;
  created_at: number;
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

export function dagActorSurfacePatchDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function encodePatch(value: unknown): { patch: DagActorSurfacePatchV1; json: string; digest: string } {
  const before = validateDagActorSurfacePatchV1(value);
  if (!before.valid) {
    const details = before.errors.slice(0, 8).map((error) => `${error.path || "/"} ${error.message}`).join("; ");
    throw new Error(`Invalid DAG Actor surface patch: ${details}`);
  }
  const redacted = redactTelemetry(value);
  const after = validateDagActorSurfacePatchV1(redacted);
  if (!after.valid) {
    throw new Error(`Redacted DAG Actor surface patch is invalid: ${JSON.stringify(after.errors.slice(0, 8))}`);
  }
  const patch = canonicalize(redacted) as DagActorSurfacePatchV1;
  const json = JSON.stringify(patch);
  if (Buffer.byteLength(json, "utf8") > DAG_ACTOR_SURFACE_PATCH_MAX_BYTES) {
    throw new Error(`DAG Actor surface patch exceeds ${DAG_ACTOR_SURFACE_PATCH_MAX_BYTES} bytes after redaction`);
  }
  return { patch, json, digest: createHash("sha256").update(json).digest("hex") };
}

function actorForPatch(patch: DagActorSurfacePatchV1): DagActorRecord {
  const actor = getDagActor(patch.run_id, patch.actor_id);
  if (!actor || actor.node_id !== patch.node_id) {
    throw new DagActorSurfacePatchConflictError(
      "identity_mismatch",
      `Patch ${patch.patch_id} does not belong to Actor ${patch.run_id}/${patch.actor_id}/${patch.node_id}`,
    );
  }
  if (actor.generation !== patch.generation) {
    throw new DagActorSurfacePatchConflictError(
      "generation_conflict",
      `Patch generation ${patch.generation} is not current Actor generation ${actor.generation}`,
    );
  }
  if (!actor.session_id || actor.session_id !== patch.session_id) {
    throw new DagActorSurfacePatchConflictError(
      "session_mismatch",
      `Patch session ${patch.session_id} is not current Actor session ${actor.session_id ?? "none"}`,
    );
  }
  const round = getCurrentDagRunRound(patch.run_id);
  if (!round || round.round_id !== patch.round_id) {
    throw new DagActorSurfacePatchConflictError(
      "round_mismatch",
      `Patch round ${patch.round_id} is not current Actor round ${round?.round_id ?? "none"}`,
    );
  }
  const lease = getDagActorLease({ run_id: patch.run_id, actor_id: patch.actor_id });
  if (!lease || lease.state !== "leased" || lease.lease_generation !== patch.lease_generation) {
    throw new DagActorSurfacePatchConflictError(
      "lease_conflict",
      `Patch lease ${patch.lease_generation} is not the current leased Actor target`,
    );
  }
  return actor;
}

function decodePatch(row: Pick<JournalRow, "journal_seq" | "surface_id" | "received_at" | "patch_json">): DagActorSurfacePatchJournalEntry {
  const patch = parseJsonRow<unknown>(row.patch_json);
  const validation = validateDagActorSurfacePatchV1(patch);
  if (!validation.valid) throw new Error(`Persisted DAG Actor surface patch is invalid: ${JSON.stringify(validation.errors)}`);
  return {
    journal_seq: Number(row.journal_seq),
    surface_id: row.surface_id,
    received_at: Number(row.received_at),
    patch: patch as DagActorSurfacePatchV1,
  };
}

function queueFromRow(row: QueueRow): DagActorSurfacePatchQueueRecord {
  return {
    journal_seq: Number(row.journal_seq),
    patch_id: row.patch_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    surface_id: row.surface_id,
    generation: Number(row.generation),
    patch_sequence: Number(row.patch_sequence),
    status: row.status,
    ...(row.apply_kind === null ? {} : { apply_kind: row.apply_kind }),
    ...(row.body_revision === null ? {} : { body_revision: Number(row.body_revision) }),
    ...(row.visual_revision === null ? {} : { visual_revision: Number(row.visual_revision) }),
    ...(row.transaction_id === null ? {} : { transaction_id: row.transaction_id }),
    queued_at: Number(row.queued_at),
    ...(row.applied_at === null ? {} : { applied_at: Number(row.applied_at) }),
    ...(row.failure_json === null ? {} : { failure: parseJsonRow(row.failure_json) }),
  };
}

function bodyFromViewRow(row: ViewRow): DagActorSurfaceBodyV1 | undefined {
  if (row.has_body !== 1) return undefined;
  if (!row.a2ui_json || !row.data_json || !row.fallback_json) {
    throw new Error(`DAG Actor surface view ${row.run_id}/${row.actor_id} has incomplete body state`);
  }
  return {
    a2ui: parseJsonRow(row.a2ui_json),
    data: parseJsonRow(row.data_json),
    fallback: parseJsonRow(row.fallback_json),
    ...(row.presentation_hint_json === null
      ? {}
      : { presentation_hint: parseJsonRow(row.presentation_hint_json) }),
  } as DagActorSurfaceBodyV1;
}

function viewFromRow(row: ViewRow): DagActorSurfaceViewRecord {
  const body = bodyFromViewRow(row);
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    surface_id: row.surface_id,
    document_id: row.document_id,
    generation: Number(row.generation),
    ...(row.session_id === null ? {} : { session_id: row.session_id }),
    ...(row.round_id === null ? {} : { round_id: row.round_id }),
    ...(row.lease_generation === null ? {} : { lease_generation: Number(row.lease_generation) }),
    body_revision: Number(row.body_revision),
    visual_revision: Number(row.visual_revision),
    ...(body ? { body } : {}),
    ...(row.last_patch_id === null ? {} : { last_patch_id: row.last_patch_id }),
    ...(row.phase === null ? {} : { phase: row.phase }),
    ...(row.component_digest === null ? {} : { component_digest: row.component_digest }),
    ...(row.body_digest === null ? {} : { body_digest: row.body_digest }),
    ...(row.last_transaction_id === null ? {} : { last_transaction_id: row.last_transaction_id }),
    ...(row.last_applied_at === null ? {} : { last_applied_at: Number(row.last_applied_at) }),
    ...(row.last_focus_at === null ? {} : { last_focus_at: Number(row.last_focus_at) }),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function getViewRow(runId: string, actorId: string): ViewRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_surface_views WHERE run_id = ? AND actor_id = ?")
    .get(runId, actorId) as ViewRow | undefined;
}

export function getDagActorSurfaceView(runId: string, actorId: string): DagActorSurfaceViewRecord | undefined {
  const row = getViewRow(runId, actorId);
  return row ? viewFromRow(row) : undefined;
}

export function listDagActorSurfaceViews(runId: string): DagActorSurfaceViewRecord[] {
  return (getDb().prepare("SELECT * FROM dag_actor_surface_views WHERE run_id = ? ORDER BY actor_id")
    .all(runId) as ViewRow[]).map(viewFromRow);
}

function journalRowById(input: {
  run_id: string;
  actor_id: string;
  generation: number;
  patch_id: string;
}): JournalRow | undefined {
  return getDb().prepare(`
    SELECT * FROM dag_actor_surface_patch_journal
    WHERE run_id = ? AND actor_id = ? AND generation = ? AND patch_id = ?
  `).get(input.run_id, input.actor_id, input.generation, input.patch_id) as JournalRow | undefined;
}

function queueRow(journalSeq: number): QueueRow | undefined {
  return getDb().prepare("SELECT * FROM dag_actor_surface_patch_queue WHERE journal_seq = ?")
    .get(journalSeq) as QueueRow | undefined;
}

function contiguousPatchSequence(runId: string, actorId: string, generation: number, baseRevision: number): number {
  const rows = getDb().prepare(`
    SELECT patch_sequence
    FROM dag_actor_surface_patch_journal
    WHERE run_id = ? AND actor_id = ? AND generation = ? AND patch_sequence > ?
    ORDER BY patch_sequence ASC
    LIMIT ?
  `).all(
    runId,
    actorId,
    generation,
    baseRevision,
    MAX_DAG_ACTOR_SURFACE_PATCH_SEQUENCE_AHEAD + 1,
  ) as Array<{ patch_sequence: number }>;
  let cursor = baseRevision;
  for (const row of rows) {
    if (Number(row.patch_sequence) !== cursor + 1) break;
    cursor += 1;
  }
  return cursor;
}

export function appendDagActorSurfacePatch(value: unknown): AppendDagActorSurfacePatchResult {
  const encoded = encodePatch(value);
  const actor = actorForPatch(encoded.patch);
  const db = getDb();
  return db.transaction(() => {
    const byId = journalRowById(encoded.patch);
    if (byId) {
      if (byId.patch_digest !== encoded.digest || byId.patch_json !== encoded.json) {
        throw new DagActorSurfacePatchConflictError(
          "patch_id_collision",
          `Patch id ${encoded.patch.patch_id} already identifies different content`,
        );
      }
      const queued = queueRow(byId.journal_seq);
      if (!queued) throw new Error(`Patch queue row is missing for ${encoded.patch.patch_id}`);
      return {
        journal: decodePatch(byId),
        queue: queueFromRow(queued),
        inserted: false,
        deduplicated: true,
      };
    }

    const view = getViewRow(encoded.patch.run_id, encoded.patch.actor_id);
    const baseRevision = view?.generation === encoded.patch.generation ? Number(view.body_revision) : 0;
    if (encoded.patch.patch_sequence <= baseRevision) {
      throw new DagActorSurfacePatchConflictError(
        "stale_revision",
        `Patch sequence ${encoded.patch.patch_sequence} is not newer than body revision ${baseRevision}`,
      );
    }
    const bySequence = db.prepare(`
      SELECT patch_id FROM dag_actor_surface_patch_journal
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND patch_sequence = ?
    `).get(
      encoded.patch.run_id,
      encoded.patch.actor_id,
      encoded.patch.generation,
      encoded.patch.patch_sequence,
    ) as { patch_id: string } | undefined;
    if (bySequence) {
      throw new DagActorSurfacePatchConflictError(
        "sequence_collision",
        `Patch sequence ${encoded.patch.patch_sequence} is already used by ${bySequence.patch_id}`,
      );
    }
    const contiguous = contiguousPatchSequence(
      encoded.patch.run_id,
      encoded.patch.actor_id,
      encoded.patch.generation,
      baseRevision,
    );
    if (encoded.patch.patch_sequence > contiguous + MAX_DAG_ACTOR_SURFACE_PATCH_SEQUENCE_AHEAD) {
      throw new DagActorSurfacePatchConflictError(
        "sequence_gap",
        `Patch sequence ${encoded.patch.patch_sequence} is more than ${MAX_DAG_ACTOR_SURFACE_PATCH_SEQUENCE_AHEAD} ahead of ${contiguous}`,
      );
    }

    const receivedAt = Date.now();
    const inserted = db.prepare(`
      INSERT INTO dag_actor_surface_patch_journal(
        patch_id, schema_version, run_id, actor_id, node_id, surface_id, session_id,
        round_id, generation, lease_generation, patch_sequence, patch_timestamp,
        received_at, operation, phase, patch_digest, patch_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      encoded.patch.patch_id,
      encoded.patch.schema_version,
      encoded.patch.run_id,
      encoded.patch.actor_id,
      encoded.patch.node_id,
      actor.surface_id,
      encoded.patch.session_id,
      encoded.patch.round_id,
      encoded.patch.generation,
      encoded.patch.lease_generation,
      encoded.patch.patch_sequence,
      encoded.patch.timestamp,
      receivedAt,
      encoded.patch.op,
      encoded.patch.phase,
      encoded.digest,
      encoded.json,
    );
    const journalSeq = Number(inserted.lastInsertRowid);
    db.prepare(`
      INSERT INTO dag_actor_surface_patch_queue(
        journal_seq, patch_id, run_id, actor_id, node_id, surface_id,
        generation, patch_sequence, status, queued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      journalSeq,
      encoded.patch.patch_id,
      encoded.patch.run_id,
      encoded.patch.actor_id,
      encoded.patch.node_id,
      actor.surface_id,
      encoded.patch.generation,
      encoded.patch.patch_sequence,
      receivedAt,
    );
    return {
      journal: {
        journal_seq: journalSeq,
        surface_id: actor.surface_id,
        received_at: receivedAt,
        patch: encoded.patch,
      },
      queue: queueFromRow(queueRow(journalSeq)!),
      inserted: true,
      deduplicated: false,
    };
  }).immediate();
}

export function getQueuedDagActorSurfacePatch(journalSeq: number): QueuedDagActorSurfacePatch | undefined {
  const row = getDb().prepare(`
    SELECT journal.*, queue.status, queue.apply_kind, queue.body_revision,
      queue.visual_revision, queue.transaction_id, queue.queued_at,
      queue.applied_at, queue.failure_json
    FROM dag_actor_surface_patch_journal journal
    INNER JOIN dag_actor_surface_patch_queue queue ON queue.journal_seq = journal.journal_seq
    WHERE journal.journal_seq = ?
  `).get(journalSeq) as (JournalRow & QueueRow) | undefined;
  if (!row) return undefined;
  return { ...decodePatch(row), queue: queueFromRow(row) };
}

export function listContiguousPendingDagActorSurfacePatches(input: {
  run_id: string;
  actor_id: string;
  generation: number;
  after_patch_sequence: number;
  limit?: number;
}): QueuedDagActorSurfacePatch[] {
  const limit = Math.min(input.limit ?? MAX_DAG_ACTOR_SURFACE_PATCH_SEQUENCE_AHEAD, MAX_DAG_ACTOR_SURFACE_PATCH_REPLAY_LIMIT);
  const rows = getDb().prepare(`
    SELECT journal.*, queue.status, queue.apply_kind, queue.body_revision,
      queue.visual_revision, queue.transaction_id, queue.queued_at,
      queue.applied_at, queue.failure_json
    FROM dag_actor_surface_patch_journal journal
    INNER JOIN dag_actor_surface_patch_queue queue ON queue.journal_seq = journal.journal_seq
    WHERE journal.run_id = ? AND journal.actor_id = ? AND journal.generation = ?
      AND journal.patch_sequence > ? AND queue.status = 'pending'
    ORDER BY journal.patch_sequence ASC
    LIMIT ?
  `).all(
    input.run_id,
    input.actor_id,
    input.generation,
    input.after_patch_sequence,
    limit,
  ) as Array<JournalRow & QueueRow>;
  const contiguous: QueuedDagActorSurfacePatch[] = [];
  let expected = input.after_patch_sequence + 1;
  for (const row of rows) {
    if (Number(row.patch_sequence) !== expected) break;
    contiguous.push({ ...decodePatch(row), queue: queueFromRow(row) });
    expected += 1;
  }
  return contiguous;
}

export function listDagActorSurfacePatchQueue(input: {
  run_id: string;
  actor_id?: string;
  after_journal_seq?: number;
  statuses?: DagActorSurfacePatchQueueStatus[];
  limit?: number;
}): DagActorSurfacePatchQueueRecord[] {
  const conditions = ["run_id = ?", "journal_seq > ?"];
  const params: Array<string | number> = [input.run_id, input.after_journal_seq ?? 0];
  if (input.actor_id) {
    conditions.push("actor_id = ?");
    params.push(input.actor_id);
  }
  if (input.statuses?.length) {
    conditions.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
    params.push(...input.statuses);
  }
  params.push(Math.min(input.limit ?? 100, MAX_DAG_ACTOR_SURFACE_PATCH_REPLAY_LIMIT));
  return (getDb().prepare(`
    SELECT * FROM dag_actor_surface_patch_queue
    WHERE ${conditions.join(" AND ")}
    ORDER BY journal_seq ASC
    LIMIT ?
  `).all(...params) as QueueRow[]).map(queueFromRow);
}

export function listDagActorSurfacePatchMilestones(input: {
  run_id: string;
  actor_id: string;
  after_journal_seq?: number;
  limit?: number;
}): DagActorSurfacePatchMilestoneRecord[] {
  const rows = getDb().prepare(`
    SELECT queue.*, journal.phase
    FROM dag_actor_surface_patch_queue queue
    INNER JOIN dag_actor_surface_patch_journal journal ON journal.journal_seq = queue.journal_seq
    WHERE queue.run_id = ? AND queue.actor_id = ? AND queue.journal_seq > ?
    ORDER BY queue.journal_seq ASC
    LIMIT ?
  `).all(
    input.run_id,
    input.actor_id,
    input.after_journal_seq ?? 0,
    Math.min(input.limit ?? 100, MAX_DAG_ACTOR_SURFACE_PATCH_REPLAY_LIMIT),
  ) as Array<QueueRow & { phase: DagActorSurfacePatchPhaseV1 }>;
  return rows.map((row) => ({ ...queueFromRow(row), phase: row.phase }));
}

export function ensureDagActorSurfaceView(input: {
  actor: DagActorRecord;
  document_id: string;
  now?: number;
}): DagActorSurfaceViewRecord {
  const now = input.now ?? Date.now();
  const db = getDb();
  return db.transaction(() => {
    const existing = getViewRow(input.actor.run_id, input.actor.actor_id);
    if (!existing) {
      db.prepare(`
        INSERT INTO dag_actor_surface_views(
          run_id, actor_id, node_id, surface_id, document_id, generation,
          body_revision, visual_revision, has_body, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
      `).run(
        input.actor.run_id,
        input.actor.actor_id,
        input.actor.node_id,
        input.actor.surface_id,
        input.document_id,
        input.actor.generation,
        now,
        now,
      );
      return viewFromRow(getViewRow(input.actor.run_id, input.actor.actor_id)!);
    }
    if (existing.node_id !== input.actor.node_id
      || existing.surface_id !== input.actor.surface_id
      || existing.document_id !== input.document_id) {
      throw new DagActorSurfacePatchConflictError(
        "identity_mismatch",
        `Actor surface view ${input.actor.run_id}/${input.actor.actor_id} has different ownership`,
      );
    }
    if (existing.generation > input.actor.generation) {
      throw new DagActorSurfacePatchConflictError(
        "generation_conflict",
        `Actor surface view generation ${existing.generation} is ahead of Actor ${input.actor.generation}`,
      );
    }
    if (existing.generation < input.actor.generation) {
      const body = bodyFromViewRow(existing);
      db.prepare(`
        INSERT OR IGNORE INTO dag_actor_surface_snapshots(
          run_id, actor_id, generation, node_id, surface_id, document_id,
          body_revision, visual_revision, has_body, last_patch_id, phase,
          body_digest, body_json, superseded_by_generation, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        existing.run_id,
        existing.actor_id,
        existing.generation,
        existing.node_id,
        existing.surface_id,
        existing.document_id,
        existing.body_revision,
        existing.visual_revision,
        existing.has_body,
        existing.last_patch_id,
        existing.phase,
        existing.body_digest,
        body ? encodeJson(body) : null,
        input.actor.generation,
        now,
      );
      db.prepare(`
        UPDATE dag_actor_surface_patch_queue
        SET status = 'stale', applied_at = MAX(queued_at, ?)
        WHERE run_id = ? AND actor_id = ? AND generation < ? AND status = 'pending'
      `).run(now, existing.run_id, existing.actor_id, input.actor.generation);
      const updated = db.prepare(`
        UPDATE dag_actor_surface_views
        SET generation = ?, session_id = NULL, round_id = NULL, lease_generation = NULL,
          body_revision = 0, visual_revision = 0, has_body = 0, last_patch_id = NULL,
          phase = NULL, a2ui_json = NULL, data_json = NULL, fallback_json = NULL,
          presentation_hint_json = NULL, component_digest = NULL, body_digest = NULL,
          last_transaction_id = NULL, last_applied_at = NULL, last_focus_at = NULL,
          updated_at = MAX(updated_at, ?)
        WHERE run_id = ? AND actor_id = ? AND generation = ?
      `).run(
        input.actor.generation,
        now,
        existing.run_id,
        existing.actor_id,
        existing.generation,
      );
      if (updated.changes !== 1) {
        throw new DagActorSurfacePatchConflictError("view_revision_conflict", "Actor surface generation changed concurrently");
      }
    }
    return viewFromRow(getViewRow(input.actor.run_id, input.actor.actor_id)!);
  }).immediate();
}

export function commitDagActorSurfacePatchApplication(input: {
  target: QueuedDagActorSurfacePatch;
  expected_body_revision: number;
  body?: DagActorSurfaceBodyV1;
  apply_kind: Exclude<DagActorSurfacePatchApplyKind, "coalesced">;
  transaction_id?: string;
  coalesced_journal_seqs?: number[];
  focus_at?: number;
  applied_at?: number;
}): DagActorSurfaceViewRecord {
  const patch = input.target.patch;
  const appliedAt = input.applied_at ?? Date.now();
  const visualChange = input.apply_kind !== "no_op";
  if ((input.apply_kind === "no_op") !== (input.transaction_id === undefined)) {
    throw new Error("Only no-op Actor surface applications may omit a transaction id");
  }
  if ((patch.op === "clear_body") !== (input.body === undefined)) {
    throw new Error("Actor surface body does not match the patch operation");
  }
  const body = input.body;
  const componentDigest = body ? dagActorSurfacePatchDigest(body.a2ui.components) : null;
  const bodyDigest = body ? dagActorSurfacePatchDigest(body) : null;
  const db = getDb();
  return db.transaction(() => {
    const row = getViewRow(patch.run_id, patch.actor_id);
    if (!row || row.generation !== patch.generation) {
      throw new DagActorSurfacePatchConflictError("generation_conflict", "Actor surface view generation is not current");
    }
    if (row.body_revision !== input.expected_body_revision) {
      throw new DagActorSurfacePatchConflictError(
        "view_revision_conflict",
        `Actor surface body revision is ${row.body_revision}, expected ${input.expected_body_revision}`,
      );
    }
    const coalescedSeqs = [...new Set(input.coalesced_journal_seqs ?? [])].sort((left, right) => left - right);
    const expectedCoalesced = patch.patch_sequence - input.expected_body_revision - 1;
    if (coalescedSeqs.length !== expectedCoalesced) {
      throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Coalesced patch range is not contiguous");
    }
    for (const [index, journalSeq] of coalescedSeqs.entries()) {
      const queued = queueRow(journalSeq);
      if (!queued
        || queued.run_id !== patch.run_id
        || queued.actor_id !== patch.actor_id
        || queued.generation !== patch.generation
        || queued.patch_sequence !== input.expected_body_revision + index + 1
        || queued.status !== "pending") {
        throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Coalesced patch identity is invalid");
      }
    }
    const targetQueue = queueRow(input.target.journal_seq);
    if (!targetQueue || targetQueue.status !== "pending" || targetQueue.patch_id !== patch.patch_id) {
      throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Target patch is not pending");
    }

    const nextVisualRevision = row.visual_revision + (visualChange ? 1 : 0);
    const updated = db.prepare(`
      UPDATE dag_actor_surface_views
      SET session_id = ?, round_id = ?, lease_generation = ?, body_revision = ?,
        visual_revision = ?, has_body = ?, last_patch_id = ?, phase = ?,
        a2ui_json = ?, data_json = ?, fallback_json = ?, presentation_hint_json = ?,
        component_digest = ?, body_digest = ?, last_transaction_id = ?,
        last_applied_at = ?, last_focus_at = COALESCE(?, last_focus_at),
        updated_at = MAX(updated_at, ?)
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND body_revision = ?
    `).run(
      patch.session_id,
      patch.round_id,
      patch.lease_generation,
      patch.patch_sequence,
      nextVisualRevision,
      body ? 1 : 0,
      patch.patch_id,
      patch.phase,
      body ? encodeJson(body.a2ui) : null,
      body ? encodeJson(body.data) : null,
      body ? encodeJson(body.fallback) : null,
      body?.presentation_hint ? encodeJson(body.presentation_hint) : null,
      componentDigest,
      bodyDigest,
      input.transaction_id ?? null,
      appliedAt,
      input.focus_at ?? null,
      appliedAt,
      patch.run_id,
      patch.actor_id,
      patch.generation,
      input.expected_body_revision,
    );
    if (updated.changes !== 1) {
      throw new DagActorSurfacePatchConflictError("view_revision_conflict", "Actor surface view changed concurrently");
    }
    for (const journalSeq of coalescedSeqs) {
      const changed = db.prepare(`
        UPDATE dag_actor_surface_patch_queue
        SET status = 'coalesced', apply_kind = 'coalesced', body_revision = ?,
          visual_revision = ?, applied_at = MAX(queued_at, ?)
        WHERE journal_seq = ? AND status = 'pending'
      `).run(patch.patch_sequence, nextVisualRevision, appliedAt, journalSeq);
      if (changed.changes !== 1) {
        throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Coalesced patch changed concurrently");
      }
    }
    const targetStatus = input.apply_kind === "no_op" ? "noop" : "applied";
    const queueUpdated = db.prepare(`
      UPDATE dag_actor_surface_patch_queue
      SET status = ?, apply_kind = ?, body_revision = ?, visual_revision = ?,
        transaction_id = ?, applied_at = MAX(queued_at, ?)
      WHERE journal_seq = ? AND status = 'pending'
    `).run(
      targetStatus,
      input.apply_kind,
      patch.patch_sequence,
      nextVisualRevision,
      input.transaction_id ?? null,
      appliedAt,
      input.target.journal_seq,
    );
    if (queueUpdated.changes !== 1) {
      throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Target patch changed concurrently");
    }
    return viewFromRow(getViewRow(patch.run_id, patch.actor_id)!);
  }).immediate();
}

export function rejectDagActorSurfacePatch(input: {
  target: QueuedDagActorSurfacePatch;
  expected_body_revision: number;
  failure: unknown;
  applied_at?: number;
}): DagActorSurfaceViewRecord {
  const patch = input.target.patch;
  const appliedAt = input.applied_at ?? Date.now();
  if (patch.patch_sequence !== input.expected_body_revision + 1) {
    throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Rejected patch sequence is not contiguous");
  }
  const redacted = redactTelemetry(input.failure);
  const db = getDb();
  return db.transaction(() => {
    const view = getViewRow(patch.run_id, patch.actor_id);
    if (!view || view.generation !== patch.generation) {
      throw new DagActorSurfacePatchConflictError("generation_conflict", "Actor surface view generation is not current");
    }
    if (view.body_revision !== input.expected_body_revision) {
      throw new DagActorSurfacePatchConflictError(
        "view_revision_conflict",
        `Actor surface body revision is ${view.body_revision}, expected ${input.expected_body_revision}`,
      );
    }
    const queue = queueRow(input.target.journal_seq);
    if (!queue || queue.status !== "pending" || queue.patch_id !== patch.patch_id) {
      throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Rejected patch is not pending");
    }
    const viewUpdated = db.prepare(`
      UPDATE dag_actor_surface_views
      SET session_id = ?, round_id = ?, lease_generation = ?, body_revision = ?,
        updated_at = MAX(updated_at, ?)
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND body_revision = ?
    `).run(
      patch.session_id,
      patch.round_id,
      patch.lease_generation,
      patch.patch_sequence,
      appliedAt,
      patch.run_id,
      patch.actor_id,
      patch.generation,
      input.expected_body_revision,
    );
    if (viewUpdated.changes !== 1) {
      throw new DagActorSurfacePatchConflictError("view_revision_conflict", "Actor surface view changed concurrently");
    }
    const queueUpdated = db.prepare(`
      UPDATE dag_actor_surface_patch_queue
      SET status = 'rejected', body_revision = ?, visual_revision = ?,
        applied_at = MAX(queued_at, ?), failure_json = ?
      WHERE journal_seq = ? AND status = 'pending'
    `).run(
      patch.patch_sequence,
      view.visual_revision,
      appliedAt,
      encodeJson(redacted),
      input.target.journal_seq,
    );
    if (queueUpdated.changes !== 1) {
      throw new DagActorSurfacePatchConflictError("queue_state_conflict", "Rejected patch changed concurrently");
    }
    return viewFromRow(getViewRow(patch.run_id, patch.actor_id)!);
  }).immediate();
}

export function markStaleDagActorSurfacePatches(input: {
  run_id: string;
  actor_id: string;
  before_generation: number;
  applied_at?: number;
}): number {
  const updated = getDb().prepare(`
    UPDATE dag_actor_surface_patch_queue
    SET status = 'stale', applied_at = MAX(queued_at, ?)
    WHERE run_id = ? AND actor_id = ? AND generation < ? AND status = 'pending'
  `).run(input.applied_at ?? Date.now(), input.run_id, input.actor_id, input.before_generation);
  return updated.changes;
}

export function pruneDagActorSurfacePatchJournal(runId: string, actorId: string): number {
  const total = (getDb().prepare(`
    SELECT COUNT(*) AS count FROM dag_actor_surface_patch_journal
    WHERE run_id = ? AND actor_id = ?
  `).get(runId, actorId) as { count: number }).count;
  const excess = Number(total) - MAX_DAG_ACTOR_SURFACE_PATCH_JOURNAL_ROWS;
  if (excess <= 0) return 0;
  return getDb().prepare(`
    DELETE FROM dag_actor_surface_patch_journal
    WHERE journal_seq IN (
      SELECT journal.journal_seq
      FROM dag_actor_surface_patch_journal journal
      INNER JOIN dag_actor_surface_patch_queue queue ON queue.journal_seq = journal.journal_seq
      WHERE journal.run_id = ? AND journal.actor_id = ? AND queue.status <> 'pending'
      ORDER BY journal.journal_seq ASC
      LIMIT ?
    )
  `).run(runId, actorId, excess).changes;
}

function snapshotFromRow(row: SnapshotRow): DagActorSurfaceSnapshotRecord {
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    generation: Number(row.generation),
    node_id: row.node_id,
    surface_id: row.surface_id,
    document_id: row.document_id,
    body_revision: Number(row.body_revision),
    visual_revision: Number(row.visual_revision),
    ...(row.has_body === 1 && row.body_json ? { body: parseJsonRow(row.body_json) } : {}),
    ...(row.last_patch_id === null ? {} : { last_patch_id: row.last_patch_id }),
    ...(row.phase === null ? {} : { phase: row.phase }),
    ...(row.body_digest === null ? {} : { body_digest: row.body_digest }),
    superseded_by_generation: Number(row.superseded_by_generation),
    created_at: Number(row.created_at),
  };
}

export function listDagActorSurfaceSnapshots(input: {
  run_id: string;
  actor_id: string;
  limit?: number;
}): DagActorSurfaceSnapshotRecord[] {
  return (getDb().prepare(`
    SELECT * FROM dag_actor_surface_snapshots
    WHERE run_id = ? AND actor_id = ?
    ORDER BY generation DESC
    LIMIT ?
  `).all(input.run_id, input.actor_id, Math.min(input.limit ?? 100, 500)) as SnapshotRow[])
    .map(snapshotFromRow);
}

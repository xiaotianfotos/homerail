import { createHash } from "node:crypto";
import {
  GENERATIVE_UI_IR_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_MAX_COMPONENTS,
  HOMERAIL_A2UI_VERSION,
  GenerativeUiActorType,
  GenerativeUiImportance,
  GenerativeUiPhase,
  GenerativeUiSurface,
  redactTelemetry,
  validateDagActivityEventV1,
  type DagActivityEventV1,
  type DagActivityType,
  type GenerativeUiDocumentV1,
  type GenerativeUiNodeV1,
  type GenerativeUiStoredNodeV1,
  type HomerailA2uiSurfaceV1,
} from "homerail-protocol";
import type { DagActivityJournalEntry } from "../persistence/dag-activity-journal.js";
import {
  createDagSurfaceGenerationSnapshot,
  getDagActorIntervention,
  listDagSurfaceGenerationSnapshots,
  type DagActorInterventionOperation,
  type DagSurfaceGenerationSnapshotRecord,
} from "../persistence/dag-actor-interventions.js";
import {
  getDagActor,
  type DagActorRecord,
} from "../persistence/dag-actors.js";
import { encodeJson, getDb, parseJsonRow } from "../persistence/db.js";
import { getGenerativeUiKindRegistry } from "./kind-registry.js";
import { persistentGenerativeUiDocumentService } from "./shadow-service.js";

const CORE_PLUGIN_ID = "com.homerail.core";
const GENERATED_VIEW_KIND = "com.homerail.core/generated_view";
const GENERATED_VIEW_KIND_VERSION = 2;
const PROJECTOR_ID = "dag-live-surface-projector";
const PROJECTOR_DATA_VERSION = 1;
const MAX_PROJECTED_STRING_BYTES = 1_024;
const MAX_PROJECTED_FINDINGS = 8;
const MAX_PROJECTED_CONTENT_BYTES = 32 * 1024;
const MAX_FOCUS_UNTIL = 8_640_000_000_000_000;
const INTERVENTION_FOCUS_DURATION_MS = 15_000;

export type DagLiveSurfaceActivityState = Exclude<DagActivityType, "tool_used">;
export type DagLiveSurfaceVisibilityState = "visible" | "focused" | "removed";
export type DagLiveSurfaceQueueStatus = "pending" | "applied" | "stale" | "rejected";
export type DagLiveSurfaceControlOperation = "focused" | "removed";

export interface DagLiveSurfaceProjectionRecord {
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  document_id: string;
  generation: number;
  last_activity_sequence: number;
  journal_cursor: number;
  surface_revision: number;
  activity_state: DagLiveSurfaceActivityState;
  visibility_state: DagLiveSurfaceVisibilityState;
  last_event_id?: string;
  focused_until?: number;
  created_at: number;
  updated_at: number;
}

export interface DagLiveSurfaceQueueRecord {
  journal_seq: number;
  event_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  generation: number;
  activity_sequence: number;
  status: DagLiveSurfaceQueueStatus;
  transaction_id?: string;
  surface_revision?: number;
  queued_at: number;
  applied_at?: number;
  failure?: unknown;
}

export interface DagLiveSurfaceProjectionResult {
  projection: DagLiveSurfaceProjectionRecord;
  queue: DagLiveSurfaceQueueRecord;
  inserted: boolean;
  applied_count: number;
}

export interface DagLiveSurfaceControlResult {
  projection: DagLiveSurfaceProjectionRecord;
  control_id: string;
  transaction_id: string;
  deduplicated: boolean;
}

export interface DagLiveSurfaceControlRecord {
  control_id: string;
  run_id: string;
  actor_id: string;
  operation: DagLiveSurfaceControlOperation;
  expected_surface_revision: number;
  committed_surface_revision: number;
  focused_until?: number;
  created_at: number;
}

export interface DagLiveSurfaceSupersessionResult {
  projection: DagLiveSurfaceProjectionRecord;
  intervention_id: string;
  operation: DagActorInterventionOperation;
  from_generation: number;
  to_generation: number;
  transaction_id: string;
  snapshot?: DagSurfaceGenerationSnapshotRecord;
  deduplicated: boolean;
}

export interface DagLiveSurfaceRecoveryResult {
  runs: string[];
  projected_events: number;
  failed: Array<{ run_id: string; event_id: string; error: string }>;
}

export class DagLiveSurfaceProjectionError extends Error {
  constructor(
    public readonly code:
      | "identity_mismatch"
      | "generation_conflict"
      | "surface_revision_conflict"
      | "a2ui_revision_conflict"
      | "a2ui_rejected"
      | "projection_state_conflict",
    message: string,
  ) {
    super(message);
    this.name = "DagLiveSurfaceProjectionError";
  }
}

interface ProjectionRow {
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  document_id: string;
  generation: number;
  last_activity_sequence: number;
  journal_cursor: number;
  surface_revision: number;
  activity_state: DagLiveSurfaceActivityState;
  visibility_state: DagLiveSurfaceVisibilityState;
  last_event_id: string | null;
  focused_until: number | null;
  created_at: number;
  updated_at: number;
}

interface QueueRow {
  journal_seq: number;
  event_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  generation: number;
  activity_sequence: number;
  status: DagLiveSurfaceQueueStatus;
  transaction_id: string | null;
  surface_revision: number | null;
  queued_at: number;
  applied_at: number | null;
  failure_json: string | null;
}

interface QueuedActivityRow extends QueueRow {
  received_at: number;
  event_json: string;
}

interface RecoverableActivityRow {
  seq: number;
  received_at: number;
  event_id: string;
  run_id: string;
  actor_id: string;
  event_json: string;
}

interface ControlRow {
  control_id: string;
  run_id: string;
  actor_id: string;
  node_id: string;
  surface_id: string;
  operation: DagLiveSurfaceControlOperation;
  expected_surface_revision: number;
  committed_surface_revision: number;
  focused_until: number | null;
  transaction_id: string;
  input_digest: string;
  created_at: number;
}

interface ProjectedFinding {
  id: string;
  title: string;
  detail?: string;
  sequence: number;
  timestamp: number;
}

interface ProjectedData {
  projector: { id: typeof PROJECTOR_ID; version: typeof PROJECTOR_DATA_VERSION };
  actor: {
    id: string;
    role: string;
    node_id: string;
    generation: number;
  };
  title: string;
  state: {
    activity: DagLiveSurfaceActivityState;
    visibility: DagLiveSurfaceVisibilityState;
    label: string;
    summary: string;
    tone: "info" | "positive" | "warning" | "critical";
    progress: number;
    event_id: string;
    round_id: string;
    sequence: number;
    updated_at: number;
    surface_revision: number;
    focused_until?: number;
  };
  intervention?: {
    intervention_id: string;
    operation: DagActorInterventionOperation;
    generation_state: "current";
    supersedes_generation: number;
    generation: number;
    summary: string;
    created_at: number;
  };
  findings: ProjectedFinding[];
}

const LIVE_SURFACE_A2UI: HomerailA2uiSurfaceV1 = {
  version: HOMERAIL_A2UI_VERSION,
  catalogId: HOMERAIL_A2UI_CATALOG_ID,
  components: [
    { id: "root", component: "Column", children: ["header", "summary", "progress", "findings"] },
    { id: "header", component: "Row", children: ["title", "status"], justify: "spaceBetween", align: "center" },
    { id: "title", component: "Text", text: { path: "/data/title" } },
    { id: "status", component: "HrStatusBadge", text: { path: "/data/state/label" }, tone: { path: "/data/state/tone" } },
    { id: "summary", component: "Text", text: { path: "/data/state/summary" }, variant: "body" },
    { id: "progress", component: "HrProgress", value: { path: "/data/state/progress" }, tone: { path: "/data/state/tone" } },
    {
      id: "findings",
      component: "HrList",
      source: { path: "/data/findings" },
      maxItems: MAX_PROJECTED_FINDINGS,
      itemTitlePath: "/title",
      itemDetailPath: "/detail",
    },
  ],
};

function projectionFromRow(row: ProjectionRow): DagLiveSurfaceProjectionRecord {
  return {
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    surface_id: row.surface_id,
    document_id: row.document_id,
    generation: Number(row.generation),
    last_activity_sequence: Number(row.last_activity_sequence),
    journal_cursor: Number(row.journal_cursor),
    surface_revision: Number(row.surface_revision),
    activity_state: row.activity_state,
    visibility_state: row.visibility_state,
    ...(row.last_event_id === null ? {} : { last_event_id: row.last_event_id }),
    ...(row.focused_until === null ? {} : { focused_until: Number(row.focused_until) }),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function queueFromRow(row: QueueRow): DagLiveSurfaceQueueRecord {
  return {
    journal_seq: Number(row.journal_seq),
    event_id: row.event_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    node_id: row.node_id,
    surface_id: row.surface_id,
    generation: Number(row.generation),
    activity_sequence: Number(row.activity_sequence),
    status: row.status,
    ...(row.transaction_id === null ? {} : { transaction_id: row.transaction_id }),
    ...(row.surface_revision === null ? {} : { surface_revision: Number(row.surface_revision) }),
    queued_at: Number(row.queued_at),
    ...(row.applied_at === null ? {} : { applied_at: Number(row.applied_at) }),
    ...(row.failure_json === null ? {} : { failure: parseJsonRow(row.failure_json) }),
  };
}

function getProjectionRow(runId: string, actorId: string): ProjectionRow | undefined {
  return getDb().prepare("SELECT * FROM dag_surface_projections WHERE run_id = ? AND actor_id = ?")
    .get(runId, actorId) as ProjectionRow | undefined;
}

function requireProjection(runId: string, actorId: string): DagLiveSurfaceProjectionRecord {
  const row = getProjectionRow(runId, actorId);
  if (!row) throw new Error(`DAG live surface does not exist: ${runId}/${actorId}`);
  return projectionFromRow(row);
}

function getQueueRow(journalSeq: number): QueueRow | undefined {
  return getDb().prepare("SELECT * FROM dag_surface_projection_queue WHERE journal_seq = ?")
    .get(journalSeq) as QueueRow | undefined;
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${label} must be between 1 and 256 characters`);
  }
  return normalized;
}

function assertNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function transactionId(kind: "activity" | "control" | "intervention", id: string): string {
  return `dag-live-surface-${kind}-${createHash("sha256").update(id).digest("hex")}`;
}

export function dagLiveSurfaceDocumentId(runId: string): string {
  return `dag-live-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

function scopeFor(runId: string) {
  return { type: "run", id: runId } as const;
}

function ensureProjection(actor: DagActorRecord, timestamp: number): DagLiveSurfaceProjectionRecord {
  const scope = scopeFor(actor.run_id);
  const activeDocument = persistentGenerativeUiDocumentService.findActiveForScope(scope, "canonical");
  const document = activeDocument ?? persistentGenerativeUiDocumentService.createOrGet({
    documentId: dagLiveSurfaceDocumentId(actor.run_id),
    scope,
    purpose: "canonical",
    createdAt: new Date(timestamp).toISOString(),
  });
  const existing = getProjectionRow(actor.run_id, actor.actor_id);
  if (existing) {
    if (
      existing.node_id !== actor.node_id
      || existing.surface_id !== actor.surface_id
      || existing.document_id !== document.document_id
    ) {
      throw new DagLiveSurfaceProjectionError(
        "identity_mismatch",
        `DAG live surface ownership changed for ${actor.run_id}/${actor.actor_id}`,
      );
    }
    return projectionFromRow(existing);
  }

  getDb().prepare(`
    INSERT INTO dag_surface_projections(
      run_id, actor_id, node_id, surface_id, document_id, generation,
      last_activity_sequence, journal_cursor, surface_revision,
      activity_state, visibility_state, last_event_id, focused_until,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'started', 'visible', NULL, NULL, ?, ?)
  `).run(
    actor.run_id,
    actor.actor_id,
    actor.node_id,
    actor.surface_id,
    document.document_id,
    actor.generation,
    timestamp,
    timestamp,
  );
  return requireProjection(actor.run_id, actor.actor_id);
}

function assertJournalIdentity(entry: DagActivityJournalEntry, actor: DagActorRecord): void {
  const { event } = entry;
  if (
    event.run_id !== actor.run_id
    || event.actor_id !== actor.actor_id
    || event.node_id !== actor.node_id
    || (event.surface_id !== undefined && event.surface_id !== actor.surface_id)
  ) {
    throw new DagLiveSurfaceProjectionError(
      "identity_mismatch",
      `Activity ${event.event_id} does not belong to ${actor.run_id}/${actor.actor_id}/${actor.node_id}/${actor.surface_id}`,
    );
  }
  if (event.generation > actor.generation) {
    throw new DagLiveSurfaceProjectionError(
      "generation_conflict",
      `Activity ${event.event_id} generation ${event.generation} is ahead of actor generation ${actor.generation}`,
    );
  }
}

function advanceProjectionGeneration(
  projection: DagLiveSurfaceProjectionRecord,
  actor: DagActorRecord,
  timestamp: number,
): DagLiveSurfaceProjectionRecord {
  if (projection.generation > actor.generation) {
    throw new DagLiveSurfaceProjectionError(
      "generation_conflict",
      `Surface ${projection.surface_id} generation ${projection.generation} is ahead of actor generation ${actor.generation}`,
    );
  }
  if (projection.generation === actor.generation) return projection;

  const staleCursor = getDb().prepare(`
    SELECT COALESCE(MAX(journal_seq), 0) AS cursor, COALESCE(MAX(queued_at), 0) AS queued_at
    FROM dag_surface_projection_queue
    WHERE run_id = ? AND actor_id = ? AND status = 'pending' AND generation < ?
  `).get(actor.run_id, actor.actor_id, actor.generation) as { cursor: number; queued_at: number };
  const transitionAt = Math.max(timestamp, Number(staleCursor.queued_at));
  getDb().prepare(`
    UPDATE dag_surface_projection_queue
    SET status = 'stale', applied_at = ?
    WHERE run_id = ? AND actor_id = ? AND status = 'pending' AND generation < ?
  `).run(transitionAt, actor.run_id, actor.actor_id, actor.generation);
  const changed = getDb().prepare(`
    UPDATE dag_surface_projections
    SET generation = ?, last_activity_sequence = 0,
        journal_cursor = MAX(journal_cursor, ?), updated_at = ?
    WHERE run_id = ? AND actor_id = ? AND generation = ? AND surface_revision = ?
  `).run(
    actor.generation,
    Number(staleCursor.cursor),
    transitionAt,
    actor.run_id,
    actor.actor_id,
    projection.generation,
    projection.surface_revision,
  );
  if (changed.changes !== 1) {
    throw new DagLiveSurfaceProjectionError(
      "surface_revision_conflict",
      `DAG live surface ${actor.run_id}/${actor.actor_id} changed while advancing generation`,
    );
  }
  return requireProjection(actor.run_id, actor.actor_id);
}

function enqueueJournalEntry(entry: DagActivityJournalEntry): { inserted: boolean; queue: DagLiveSurfaceQueueRecord } {
  const actor = getDagActor(entry.event.run_id, entry.event.actor_id);
  if (!actor) throw new Error(`Unknown DAG actor: ${entry.event.run_id}/${entry.event.actor_id}`);
  assertJournalIdentity(entry, actor);
  let projection = ensureProjection(actor, entry.received_at);
  projection = advanceProjectionGeneration(projection, actor, entry.received_at);

  const existing = getQueueRow(entry.seq);
  if (existing) {
    if (
      existing.event_id !== entry.event.event_id
      || existing.run_id !== actor.run_id
      || existing.actor_id !== actor.actor_id
      || existing.node_id !== actor.node_id
      || existing.surface_id !== actor.surface_id
      || existing.generation !== entry.event.generation
      || existing.activity_sequence !== entry.event.sequence
    ) {
      throw new DagLiveSurfaceProjectionError(
        "projection_state_conflict",
        `Projection queue cursor ${entry.seq} identifies different activity content`,
      );
    }
    return { inserted: false, queue: queueFromRow(existing) };
  }

  const sameEvent = getDb().prepare("SELECT * FROM dag_surface_projection_queue WHERE event_id = ?")
    .get(entry.event.event_id) as QueueRow | undefined;
  if (sameEvent) {
    throw new DagLiveSurfaceProjectionError(
      "projection_state_conflict",
      `Projection event id ${entry.event.event_id} is already bound to journal cursor ${sameEvent.journal_seq}`,
    );
  }

  getDb().prepare(`
    INSERT INTO dag_surface_projection_queue(
      journal_seq, event_id, run_id, actor_id, node_id, surface_id,
      generation, activity_sequence, status, transaction_id,
      surface_revision, queued_at, applied_at, failure_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)
  `).run(
    entry.seq,
    entry.event.event_id,
    actor.run_id,
    actor.actor_id,
    actor.node_id,
    actor.surface_id,
    entry.event.generation,
    entry.event.sequence,
    entry.received_at,
  );

  if (entry.event.generation < actor.generation) {
    getDb().prepare(`
      UPDATE dag_surface_projection_queue
      SET status = 'stale', applied_at = ?
      WHERE journal_seq = ? AND status = 'pending'
    `).run(entry.received_at, entry.seq);
    getDb().prepare(`
      UPDATE dag_surface_projections
      SET journal_cursor = MAX(journal_cursor, ?), updated_at = ?
      WHERE run_id = ? AND actor_id = ?
    `).run(entry.seq, entry.received_at, actor.run_id, actor.actor_id);
  }
  return { inserted: true, queue: queueFromRow(getQueueRow(entry.seq)!) };
}

function queuedActivity(runId: string, actorId: string, generation: number, sequence: number): QueuedActivityRow | undefined {
  return getDb().prepare(`
    SELECT q.*, e.received_at, e.event_json
    FROM dag_surface_projection_queue q
    JOIN dag_activity_events e ON e.seq = q.journal_seq
    WHERE q.run_id = ? AND q.actor_id = ? AND q.generation = ?
      AND q.activity_sequence = ? AND q.status = 'pending'
  `).get(runId, actorId, generation, sequence) as QueuedActivityRow | undefined;
}

function decodeQueuedActivity(row: QueuedActivityRow): DagActivityEventV1 {
  const value = parseJsonRow<unknown>(row.event_json);
  const validation = validateDagActivityEventV1(value);
  if (!validation.valid) {
    throw new DagLiveSurfaceProjectionError(
      "projection_state_conflict",
      `Projection queue contains an invalid activity event at journal cursor ${row.journal_seq}`,
    );
  }
  return value as DagActivityEventV1;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") <= MAX_PROJECTED_STRING_BYTES) {
    return normalized;
  }
  const characters = [...normalized];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, midpoint).join("")}…`;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_PROJECTED_STRING_BYTES) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return `${characters.slice(0, low).join("")}…`;
}

function firstString(payload: DagActivityEventV1["payload"], keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = boundedString(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function projectedProgress(
  event: DagActivityEventV1,
  previous: ProjectedData | undefined,
): number {
  if (event.type === "completed") return 100;
  const raw = event.payload.progress ?? event.payload.percent;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.min(100, raw));
  if (event.type === "started") return 0;
  return previous?.state.progress ?? 0;
}

function statePresentation(type: DagLiveSurfaceActivityState): {
  label: string;
  tone: ProjectedData["state"]["tone"];
  phase: GenerativeUiPhase;
} {
  switch (type) {
    case "started": return { label: "Started", tone: "info", phase: GenerativeUiPhase.RUNNING };
    case "progress": return { label: "In progress", tone: "info", phase: GenerativeUiPhase.RUNNING };
    case "finding": return { label: "Finding", tone: "positive", phase: GenerativeUiPhase.RUNNING };
    case "blocked": return { label: "Blocked", tone: "warning", phase: GenerativeUiPhase.BLOCKED };
    case "completed": return { label: "Completed", tone: "positive", phase: GenerativeUiPhase.SUCCEEDED };
    case "failed": return { label: "Failed", tone: "critical", phase: GenerativeUiPhase.FAILED };
  }
}

function projectedDataFromNode(node: GenerativeUiStoredNodeV1 | undefined): ProjectedData | undefined {
  const content = node?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const data = content.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const candidate = data as Partial<ProjectedData>;
  if (candidate.projector?.id !== PROJECTOR_ID || candidate.projector.version !== PROJECTOR_DATA_VERSION) {
    return undefined;
  }
  return structuredClone(candidate as ProjectedData);
}

function assertOwnedNode(node: GenerativeUiStoredNodeV1, projection: DagLiveSurfaceProjectionRecord): void {
  const data = projectedDataFromNode(node);
  if (
    node.id !== projection.surface_id
    || node.kind !== GENERATED_VIEW_KIND
    || node.kind_version !== GENERATED_VIEW_KIND_VERSION
    || node.owner.id !== CORE_PLUGIN_ID
    || node.provenance?.run_id !== projection.run_id
    || node.provenance?.actor_id !== projection.actor_id
    || data?.actor.id !== projection.actor_id
    || data.actor.node_id !== projection.node_id
  ) {
    throw new DagLiveSurfaceProjectionError(
      "identity_mismatch",
      `A2UI node ${projection.surface_id} is not owned by actor ${projection.run_id}/${projection.actor_id}`,
    );
  }
}

/** Verify that a canonical A2UI node is the active projector-owned surface for this actor. */
export function isDagLiveSurfaceProjectionNode(
  node: GenerativeUiStoredNodeV1,
  projection: DagLiveSurfaceProjectionRecord,
): boolean {
  if (projection.visibility_state === "removed") return false;
  try {
    assertOwnedNode(node, projection);
    return true;
  } catch {
    return false;
  }
}

function activeCoreVersion(): string {
  const definition = getGenerativeUiKindRegistry().uiProjection().kinds.find((kind) => (
    kind.enabled
    && kind.plugin_id === CORE_PLUGIN_ID
    && kind.kind === GENERATED_VIEW_KIND
    && kind.kind_version === GENERATED_VIEW_KIND_VERSION
  ));
  if (!definition) throw new Error("Active Core A2UI generated-view kind is unavailable");
  return definition.plugin_version;
}

function nextVisibility(
  projection: DagLiveSurfaceProjectionRecord,
  eventReceivedAt: number,
): DagLiveSurfaceVisibilityState {
  if (
    projection.visibility_state === "focused"
    && (projection.focused_until === undefined || eventReceivedAt <= projection.focused_until)
  ) return "focused";
  return "visible";
}

function buildProjectedNode(input: {
  actor: DagActorRecord;
  projection: DagLiveSurfaceProjectionRecord;
  event: DagActivityEventV1;
  received_at: number;
  existing?: GenerativeUiStoredNodeV1;
}): { node: GenerativeUiNodeV1; activity: DagLiveSurfaceActivityState; visibility: DagLiveSurfaceVisibilityState } {
  if (input.event.type === "tool_used") throw new Error("tool_used does not create an A2UI mutation");
  if (input.existing) assertOwnedNode(input.existing, input.projection);
  const previous = projectedDataFromNode(input.existing);
  const activity = input.event.type;
  const presentation = statePresentation(activity);
  const visibility = nextVisibility(input.projection, input.received_at);
  const title = previous?.title
    ?? firstString(input.event.payload, ["title", "task"])
    ?? input.actor.role;
  const summary = firstString(input.event.payload, ["message", "summary", "detail", "reason", "error"])
    ?? presentation.label;
  const findings = previous?.findings ? [...previous.findings] : [];
  if (activity === "finding") {
    const detail = firstString(input.event.payload, ["detail", "description"]);
    findings.push({
      id: input.event.event_id,
      title: firstString(input.event.payload, ["title", "message", "summary"]) ?? "Finding",
      ...(detail ? { detail } : {}),
      sequence: input.event.sequence,
      timestamp: input.event.timestamp,
    });
  }
  const boundedFindings = findings.slice(-MAX_PROJECTED_FINDINGS);
  const surfaceRevision = input.projection.surface_revision + 1;
  const data: ProjectedData = {
    projector: { id: PROJECTOR_ID, version: PROJECTOR_DATA_VERSION },
    actor: {
      id: input.actor.actor_id,
      role: input.actor.role,
      node_id: input.actor.node_id,
      generation: input.event.generation,
    },
    title,
    state: {
      activity,
      visibility,
      label: presentation.label,
      summary,
      tone: presentation.tone,
      progress: projectedProgress(input.event, previous),
      event_id: input.event.event_id,
      round_id: input.event.round_id,
      sequence: input.event.sequence,
      updated_at: input.event.timestamp,
      surface_revision: surfaceRevision,
      ...(visibility === "focused" && input.projection.focused_until !== undefined
        ? { focused_until: input.projection.focused_until }
        : {}),
    },
    ...(previous?.intervention?.generation === input.event.generation
      ? { intervention: previous.intervention }
      : {}),
    findings: boundedFindings,
  };
  const content = { data };
  while (
    data.findings.length > 1
    && Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_PROJECTED_CONTENT_BYTES
  ) {
    data.findings.shift();
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_PROJECTED_CONTENT_BYTES) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Projected DAG live surface content exceeds its budget");
  }
  if (LIVE_SURFACE_A2UI.components.length > HOMERAIL_A2UI_MAX_COMPONENTS) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Projected DAG live surface exceeds the A2UI component budget");
  }

  return {
    activity,
    visibility,
    node: {
      ir_version: GENERATIVE_UI_IR_VERSION,
      id: input.projection.surface_id,
      kind: GENERATED_VIEW_KIND,
      kind_version: GENERATED_VIEW_KIND_VERSION,
      owner: input.existing?.owner ?? { id: CORE_PLUGIN_ID, version: activeCoreVersion() },
      surface: GenerativeUiSurface.EXECUTION,
      importance: visibility === "focused" ? GenerativeUiImportance.CRITICAL : GenerativeUiImportance.PRIMARY,
      status: {
        phase: presentation.phase,
        label: presentation.label,
        progress: data.state.progress,
      },
      content,
      a2ui: structuredClone(LIVE_SURFACE_A2UI),
      presentation: { density: "summary" },
      lifecycle: { persistence: "session", removable: true },
      fallback: {
        title,
        summary,
        ...(boundedFindings.length ? { items: boundedFindings.map((finding) => finding.title) } : {}),
      },
      provenance: {
        actor: "agent",
        actor_id: input.actor.actor_id,
        run_id: input.actor.run_id,
      },
    },
  };
}

function applyQueuedActivity(row: QueuedActivityRow): boolean {
  const actor = getDagActor(row.run_id, row.actor_id);
  if (!actor) throw new Error(`Unknown DAG actor: ${row.run_id}/${row.actor_id}`);
  let projection = requireProjection(row.run_id, row.actor_id);
  const event = decodeQueuedActivity(row);
  assertJournalIdentity({ seq: row.journal_seq, received_at: row.received_at, event }, actor);
  if (event.generation !== actor.generation || projection.generation !== actor.generation) {
    throw new DagLiveSurfaceProjectionError(
      "generation_conflict",
      `Queued activity ${event.event_id} no longer targets the active actor generation`,
    );
  }
  if (event.sequence !== projection.last_activity_sequence + 1) return false;

  if (projection.visibility_state === "removed") {
    const document = persistentGenerativeUiDocumentService.get(
      projection.document_id,
      scopeFor(actor.run_id),
    );
    if (document?.nodes.some((node) => node.id === projection.surface_id)) {
      throw new DagLiveSurfaceProjectionError(
        "projection_state_conflict",
        `Removed DAG live surface ${projection.surface_id} unexpectedly exists in A2UI`,
      );
    }
  }

  if (event.type === "tool_used" || projection.visibility_state === "removed") {
    const activityState = event.type === "tool_used" ? projection.activity_state : event.type;
    const updated = getDb().prepare(`
      UPDATE dag_surface_projections
      SET last_activity_sequence = ?, journal_cursor = MAX(journal_cursor, ?),
          activity_state = ?, last_event_id = ?, updated_at = ?
      WHERE run_id = ? AND actor_id = ? AND generation = ?
        AND last_activity_sequence = ? AND surface_revision = ?
    `).run(
      event.sequence,
      row.journal_seq,
      activityState,
      event.event_id,
      row.received_at,
      actor.run_id,
      actor.actor_id,
      actor.generation,
      projection.last_activity_sequence,
      projection.surface_revision,
    );
    if (updated.changes !== 1) {
      throw new DagLiveSurfaceProjectionError(
        "surface_revision_conflict",
        "DAG live surface changed before non-visual activity commit",
      );
    }
    getDb().prepare(`
      UPDATE dag_surface_projection_queue
      SET status = 'applied', surface_revision = ?, applied_at = ?
      WHERE journal_seq = ? AND status = 'pending'
    `).run(projection.surface_revision, row.received_at, row.journal_seq);
    return true;
  }

  const scope = scopeFor(actor.run_id);
  const document = persistentGenerativeUiDocumentService.get(projection.document_id, scope);
  if (!document) throw new Error(`A2UI document not found: ${projection.document_id}`);
  const existing = document.nodes.find((node) => node.id === projection.surface_id);
  const projected = buildProjectedNode({
    actor,
    projection,
    event,
    received_at: row.received_at,
    ...(existing ? { existing } : {}),
  });
  const txId = transactionId("activity", event.event_id);
  const operation = existing
    ? {
        op: "patch" as const,
        node_id: existing.id,
        if_revision: existing.revision,
        changes: {
          surface: projected.node.surface,
          importance: projected.node.importance,
          status: projected.node.status,
          content: projected.node.content,
          a2ui: projected.node.a2ui,
          presentation: projected.node.presentation,
          lifecycle: projected.node.lifecycle,
          fallback: projected.node.fallback,
          provenance: projected.node.provenance,
        },
      }
    : { op: "put" as const, node: projected.node };
  const result = persistentGenerativeUiDocumentService.apply({
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: txId,
    document_id: document.document_id,
    base_revision: document.revision,
    actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
    operations: [operation],
    created_at: new Date(row.received_at).toISOString(),
  }, scope);
  if (result.status === "conflict") {
    throw new DagLiveSurfaceProjectionError(
      "a2ui_revision_conflict",
      `A2UI document or surface changed before ${event.event_id} could commit`,
    );
  }
  if (result.status !== "applied") {
    throw new DagLiveSurfaceProjectionError(
      "a2ui_rejected",
      `A2UI transaction ${txId} was ${result.status}: ${JSON.stringify(result.errors ?? [])}`,
    );
  }

  const nextSurfaceRevision = projection.surface_revision + 1;
  const updated = getDb().prepare(`
    UPDATE dag_surface_projections
    SET generation = ?, last_activity_sequence = ?, journal_cursor = MAX(journal_cursor, ?),
        surface_revision = ?, activity_state = ?, visibility_state = ?,
        last_event_id = ?, focused_until = CASE WHEN ? = 'focused' THEN focused_until ELSE NULL END,
        updated_at = ?
    WHERE run_id = ? AND actor_id = ? AND generation = ?
      AND last_activity_sequence = ? AND surface_revision = ?
  `).run(
    actor.generation,
    event.sequence,
    row.journal_seq,
    nextSurfaceRevision,
    projected.activity,
    projected.visibility,
    event.event_id,
    projected.visibility,
    row.received_at,
    actor.run_id,
    actor.actor_id,
    projection.generation,
    projection.last_activity_sequence,
    projection.surface_revision,
  );
  if (updated.changes !== 1) {
    throw new DagLiveSurfaceProjectionError("surface_revision_conflict", "DAG live surface changed before A2UI commit bookkeeping");
  }
  const queueUpdated = getDb().prepare(`
    UPDATE dag_surface_projection_queue
    SET status = 'applied', transaction_id = ?, surface_revision = ?, applied_at = ?
    WHERE journal_seq = ? AND status = 'pending'
  `).run(txId, nextSurfaceRevision, row.received_at, row.journal_seq);
  if (queueUpdated.changes !== 1) {
    throw new DagLiveSurfaceProjectionError("projection_state_conflict", "DAG live surface queue changed before commit");
  }
  projection = requireProjection(actor.run_id, actor.actor_id);
  return projection.last_activity_sequence === event.sequence;
}

function markRejected(row: QueuedActivityRow, error: DagLiveSurfaceProjectionError): void {
  const failure = redactTelemetry({ code: error.code, message: error.message });
  getDb().prepare(`
    UPDATE dag_surface_projection_queue
    SET status = 'rejected', applied_at = ?, failure_json = ?
    WHERE journal_seq = ? AND status = 'pending'
  `).run(Date.now(), encodeJson(failure), row.journal_seq);
}

function drainActor(runId: string, actorId: string): number {
  let applied = 0;
  while (true) {
    const projection = requireProjection(runId, actorId);
    const row = queuedActivity(runId, actorId, projection.generation, projection.last_activity_sequence + 1);
    if (!row) return applied;
    try {
      const changed = getDb().transaction(() => applyQueuedActivity(row)).immediate();
      if (!changed) return applied;
      applied += 1;
    } catch (error) {
      if (error instanceof DagLiveSurfaceProjectionError && error.code === "a2ui_rejected") {
        markRejected(row, error);
      }
      throw error;
    }
  }
}

/**
 * Queue one durable Activity Journal entry and drain every now-contiguous event
 * for that logical actor. Worker payload is treated as data only; the fixed
 * projector owns all A2UI components and document mutations.
 */
export function projectDagActivityJournalEntry(entry: DagActivityJournalEntry): DagLiveSurfaceProjectionResult {
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) throw new Error("journal seq must be a positive safe integer");
  if (!Number.isSafeInteger(entry.received_at) || entry.received_at < 0) throw new Error("received_at must be non-negative");
  const validation = validateDagActivityEventV1(entry.event);
  if (!validation.valid) throw new Error(`Invalid DAG activity event: ${JSON.stringify(validation.errors)}`);
  const enqueued = getDb().transaction(() => enqueueJournalEntry(entry)).immediate();
  const appliedCount = enqueued.queue.status === "stale"
    ? 0
    : drainActor(entry.event.run_id, entry.event.actor_id);
  return {
    projection: requireProjection(entry.event.run_id, entry.event.actor_id),
    queue: queueFromRow(getQueueRow(entry.seq)!),
    inserted: enqueued.inserted,
    applied_count: appliedCount,
  };
}

export function getDagLiveSurfaceProjection(
  runId: string,
  actorId: string,
): DagLiveSurfaceProjectionRecord | undefined {
  const row = getProjectionRow(assertIdentifier(runId, "run_id"), assertIdentifier(actorId, "actor_id"));
  return row ? projectionFromRow(row) : undefined;
}

export function listDagLiveSurfaceProjections(runId: string): DagLiveSurfaceProjectionRecord[] {
  const rows = getDb().prepare("SELECT * FROM dag_surface_projections WHERE run_id = ? ORDER BY actor_id")
    .all(assertIdentifier(runId, "run_id")) as ProjectionRow[];
  return rows.map(projectionFromRow);
}

export function listDagLiveSurfaceQueue(input: {
  run_id: string;
  actor_id?: string;
  status?: DagLiveSurfaceQueueStatus;
}): DagLiveSurfaceQueueRecord[] {
  const runId = assertIdentifier(input.run_id, "run_id");
  const conditions = ["run_id = ?"];
  const params: string[] = [runId];
  if (input.actor_id !== undefined) {
    conditions.push("actor_id = ?");
    params.push(assertIdentifier(input.actor_id, "actor_id"));
  }
  if (input.status !== undefined) {
    if (!["pending", "applied", "stale", "rejected"].includes(input.status)) throw new Error("invalid queue status");
    conditions.push("status = ?");
    params.push(input.status);
  }
  return (getDb().prepare(`
    SELECT * FROM dag_surface_projection_queue
    WHERE ${conditions.join(" AND ")}
    ORDER BY journal_seq
  `).all(...params) as QueueRow[]).map(queueFromRow);
}

export function getDagLiveSurfaceDocument(runId: string): GenerativeUiDocumentV1 | undefined {
  const normalizedRunId = assertIdentifier(runId, "run_id");
  const projection = getDb().prepare(`
    SELECT document_id FROM dag_surface_projections
    WHERE run_id = ? ORDER BY actor_id LIMIT 1
  `).get(normalizedRunId) as { document_id: string } | undefined;
  return projection
    ? persistentGenerativeUiDocumentService.get(projection.document_id, scopeFor(normalizedRunId))
    : undefined;
}

function interventionPresentation(operation: DagActorInterventionOperation): {
  activity: DagLiveSurfaceActivityState;
  label: string;
  summary: string;
  tone: ProjectedData["state"]["tone"];
  phase: GenerativeUiPhase;
} {
  switch (operation) {
    case "retry":
      return {
        activity: "started",
        label: "Retrying",
        summary: "Retry requested. Continuing with a new attempt.",
        tone: "info",
        phase: GenerativeUiPhase.RUNNING,
      };
    case "reassign":
      return {
        activity: "started",
        label: "Reassigned",
        summary: "Reassigned. Continuing with a new attempt.",
        tone: "info",
        phase: GenerativeUiPhase.RUNNING,
      };
    case "checkpoint_fork":
      return {
        activity: "started",
        label: "Resuming",
        summary: "Resuming from the selected checkpoint.",
        tone: "info",
        phase: GenerativeUiPhase.RUNNING,
      };
    case "interrupt":
      return {
        activity: "blocked",
        label: "Interrupted",
        summary: "Interrupted. Waiting for further direction.",
        tone: "warning",
        phase: GenerativeUiPhase.WAITING,
      };
    case "cancel":
      return {
        activity: "blocked",
        label: "Cancelled",
        summary: "Cancelled. Work is stopped.",
        tone: "warning",
        phase: GenerativeUiPhase.CANCELLED,
      };
  }
}

function interventionSummary(instruction: string | undefined, fallback: string): string {
  if (instruction === undefined) return fallback;
  const redacted = redactTelemetry(instruction);
  return boundedString(redacted) ?? fallback;
}

function isMatchingInterventionNode(input: {
  node: GenerativeUiStoredNodeV1;
  projection: DagLiveSurfaceProjectionRecord;
  intervention_id: string;
  operation: DagActorInterventionOperation;
  from_generation: number;
  to_generation: number;
}): boolean {
  assertOwnedNode(input.node, input.projection);
  const data = projectedDataFromNode(input.node);
  return data?.actor.generation === input.to_generation
    && data.state.surface_revision === input.projection.surface_revision
    && data.intervention?.intervention_id === input.intervention_id
    && data.intervention.operation === input.operation
    && data.intervention.generation_state === "current"
    && data.intervention.supersedes_generation === input.from_generation
    && data.intervention.generation === input.to_generation;
}

function buildInterventionNode(input: {
  actor: DagActorRecord;
  projection: DagLiveSurfaceProjectionRecord;
  existing?: GenerativeUiStoredNodeV1;
  intervention_id: string;
  operation: DagActorInterventionOperation;
  from_generation: number;
  summary: string;
  created_at: number;
  focused_until: number;
}): { node: GenerativeUiNodeV1; activity: DagLiveSurfaceActivityState } {
  if (input.existing) assertOwnedNode(input.existing, input.projection);
  const previous = projectedDataFromNode(input.existing);
  const presentation = interventionPresentation(input.operation);
  const surfaceRevision = input.projection.surface_revision + 1;
  const title = previous?.title ?? input.actor.role;
  const data: ProjectedData = {
    projector: { id: PROJECTOR_ID, version: PROJECTOR_DATA_VERSION },
    actor: {
      id: input.actor.actor_id,
      role: input.actor.role,
      node_id: input.actor.node_id,
      generation: input.actor.generation,
    },
    title,
    state: {
      activity: presentation.activity,
      visibility: "focused",
      label: presentation.label,
      summary: input.summary,
      tone: presentation.tone,
      progress: presentation.phase === GenerativeUiPhase.RUNNING ? 0 : previous?.state.progress ?? 0,
      event_id: input.intervention_id,
      round_id: previous?.state.round_id ?? `intervention:${input.intervention_id}`,
      sequence: 0,
      updated_at: input.created_at,
      surface_revision: surfaceRevision,
      focused_until: input.focused_until,
    },
    intervention: {
      intervention_id: input.intervention_id,
      operation: input.operation,
      generation_state: "current",
      supersedes_generation: input.from_generation,
      generation: input.actor.generation,
      summary: input.summary,
      created_at: input.created_at,
    },
    findings: [],
  };
  const content = { data };
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_PROJECTED_CONTENT_BYTES) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Intervention DAG live surface content exceeds its budget");
  }

  return {
    activity: presentation.activity,
    node: {
      ir_version: GENERATIVE_UI_IR_VERSION,
      id: input.projection.surface_id,
      kind: GENERATED_VIEW_KIND,
      kind_version: GENERATED_VIEW_KIND_VERSION,
      owner: input.existing?.owner ?? { id: CORE_PLUGIN_ID, version: activeCoreVersion() },
      surface: GenerativeUiSurface.EXECUTION,
      importance: GenerativeUiImportance.CRITICAL,
      status: {
        phase: presentation.phase,
        label: presentation.label,
        progress: data.state.progress,
      },
      content,
      a2ui: structuredClone(LIVE_SURFACE_A2UI),
      presentation: { density: "summary" },
      lifecycle: { persistence: "session", removable: true },
      fallback: { title, summary: input.summary },
      provenance: {
        actor: "agent",
        actor_id: input.actor.actor_id,
        run_id: input.actor.run_id,
      },
    },
  };
}

/**
 * Move one stable Actor surface from generation N to N+1 after the durable
 * Actor row has already advanced. The old stored node is snapshotted before
 * the fixed-id A2UI node is patched, and both writes share one DB transaction.
 */
export function supersedeDagLiveSurfaceForIntervention(input: {
  run_id: string;
  actor_id: string;
  intervention_id: string;
  operation?: DagActorInterventionOperation;
  instruction?: string;
  from_generation?: number;
  to_generation?: number;
  created_at?: number;
}): DagLiveSurfaceSupersessionResult {
  const normalized = {
    run_id: assertIdentifier(input.run_id, "run_id"),
    actor_id: assertIdentifier(input.actor_id, "actor_id"),
    intervention_id: assertIdentifier(input.intervention_id, "intervention_id"),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.instruction === undefined ? {} : { instruction: input.instruction.replace(/\s+/g, " ").trim() }),
    ...(input.from_generation === undefined
      ? {}
      : { from_generation: assertNonNegativeSafeInteger(input.from_generation, "from_generation") }),
    ...(input.to_generation === undefined
      ? {}
      : { to_generation: assertNonNegativeSafeInteger(input.to_generation, "to_generation") }),
    created_at: input.created_at === undefined
      ? Date.now()
      : assertNonNegativeSafeInteger(input.created_at, "created_at"),
  };
  if (normalized.created_at > MAX_FOCUS_UNTIL) {
    throw new Error("created_at is outside the supported timestamp range");
  }

  return getDb().transaction((): DagLiveSurfaceSupersessionResult => {
    const intervention = getDagActorIntervention(normalized.intervention_id);
    if (!intervention) throw new Error(`Unknown DAG actor intervention: ${normalized.intervention_id}`);
    if (intervention.run_id !== normalized.run_id || intervention.actor_id !== normalized.actor_id) {
      throw new DagLiveSurfaceProjectionError(
        "identity_mismatch",
        `DAG actor intervention ${normalized.intervention_id} belongs to a different Actor`,
      );
    }
    if (normalized.operation !== undefined && normalized.operation !== intervention.operation) {
      throw new DagLiveSurfaceProjectionError(
        "identity_mismatch",
        `DAG actor intervention ${normalized.intervention_id} operation does not match durable state`,
      );
    }
    if (
      intervention.instruction !== undefined
      && normalized.instruction !== undefined
      && normalized.instruction !== intervention.instruction
    ) {
      throw new DagLiveSurfaceProjectionError(
        "identity_mismatch",
        `DAG actor intervention ${normalized.intervention_id} instruction does not match durable state`,
      );
    }
    if (intervention.status !== "applying" && intervention.status !== "applied") {
      throw new DagLiveSurfaceProjectionError(
        "projection_state_conflict",
        `DAG actor intervention ${normalized.intervention_id} is ${intervention.status}, not applying`,
      );
    }
    const fromGeneration = intervention.from_generation;
    if (fromGeneration === undefined || intervention.expected_actor_generation !== fromGeneration) {
      throw new DagLiveSurfaceProjectionError(
        "generation_conflict",
        `DAG actor intervention ${normalized.intervention_id} has no valid source generation`,
      );
    }
    const toGeneration = fromGeneration + 1;
    if (
      (normalized.from_generation !== undefined && normalized.from_generation !== fromGeneration)
      || (normalized.to_generation !== undefined && normalized.to_generation !== toGeneration)
    ) {
      throw new DagLiveSurfaceProjectionError(
        "generation_conflict",
        `DAG actor intervention ${normalized.intervention_id} generation does not match durable state`,
      );
    }
    if (intervention.to_generation !== undefined && intervention.to_generation !== toGeneration) {
      throw new DagLiveSurfaceProjectionError(
        "generation_conflict",
        `DAG actor intervention ${normalized.intervention_id} completed at a different generation`,
      );
    }
    const actor = getDagActor(normalized.run_id, normalized.actor_id);
    if (!actor) throw new Error(`Unknown DAG actor: ${normalized.run_id}/${normalized.actor_id}`);
    if (actor.generation !== toGeneration) {
      throw new DagLiveSurfaceProjectionError(
        "generation_conflict",
        `DAG actor ${normalized.run_id}/${normalized.actor_id} generation is ${actor.generation}, expected ${toGeneration}`,
      );
    }

    let projection = getProjectionRow(normalized.run_id, normalized.actor_id)
      ? requireProjection(normalized.run_id, normalized.actor_id)
      : ensureProjection(actor, normalized.created_at);
    if (
      projection.node_id !== actor.node_id
      || projection.surface_id !== actor.surface_id
    ) {
      throw new DagLiveSurfaceProjectionError(
        "identity_mismatch",
        "DAG live surface no longer matches its logical Actor",
      );
    }
    if (projection.generation !== fromGeneration && projection.generation !== toGeneration) {
      throw new DagLiveSurfaceProjectionError(
        "generation_conflict",
        `DAG live surface generation is ${projection.generation}, expected ${fromGeneration} or ${toGeneration}`,
      );
    }

    const scope = scopeFor(normalized.run_id);
    const document = persistentGenerativeUiDocumentService.get(projection.document_id, scope);
    if (!document) throw new Error(`A2UI document not found: ${projection.document_id}`);
    const existing = document.nodes.find((candidate) => candidate.id === projection.surface_id);
    const txId = transactionId("intervention", normalized.intervention_id);
    if (
      projection.generation === toGeneration
      && existing
      && isMatchingInterventionNode({
        node: existing,
        projection,
        intervention_id: normalized.intervention_id,
        operation: intervention.operation,
        from_generation: fromGeneration,
        to_generation: toGeneration,
      })
    ) {
      const snapshot = listDagSurfaceGenerationSnapshots({
        run_id: normalized.run_id,
        actor_id: normalized.actor_id,
        limit: 1,
      }).find((candidate) => (
        candidate.generation === fromGeneration
        && candidate.intervention_id === normalized.intervention_id
      ));
      return {
        projection,
        intervention_id: normalized.intervention_id,
        operation: intervention.operation,
        from_generation: fromGeneration,
        to_generation: toGeneration,
        transaction_id: txId,
        ...(snapshot ? { snapshot } : {}),
        deduplicated: true,
      };
    }

    let snapshot: DagSurfaceGenerationSnapshotRecord | undefined;
    if (existing) {
      assertOwnedNode(existing, projection);
      const previous = projectedDataFromNode(existing)!;
      if (previous.actor.generation !== fromGeneration) {
        throw new DagLiveSurfaceProjectionError(
          "generation_conflict",
          `A2UI surface generation is ${previous.actor.generation}, expected ${fromGeneration}`,
        );
      }
      snapshot = createDagSurfaceGenerationSnapshot({
        run_id: actor.run_id,
        actor_id: actor.actor_id,
        generation: fromGeneration,
        node_id: actor.node_id,
        surface_id: actor.surface_id,
        document_id: projection.document_id,
        node_revision: existing.revision,
        document_revision: document.revision,
        surface_revision: projection.surface_revision,
        activity_state: projection.activity_state,
        visibility_state: projection.visibility_state,
        ...(projection.last_event_id === undefined ? {} : { last_event_id: projection.last_event_id }),
        node_snapshot: existing,
        superseded_by_generation: toGeneration,
        intervention_id: normalized.intervention_id,
        created_at: normalized.created_at,
      }).snapshot;
    }

    projection = advanceProjectionGeneration(projection, actor, normalized.created_at);
    const focusedUntil = Math.min(MAX_FOCUS_UNTIL, normalized.created_at + INTERVENTION_FOCUS_DURATION_MS);
    const presentation = interventionPresentation(intervention.operation);
    const summary = interventionSummary(
      normalized.instruction ?? intervention.instruction,
      presentation.summary,
    );
    const projected = buildInterventionNode({
      actor,
      projection,
      ...(existing ? { existing } : {}),
      intervention_id: normalized.intervention_id,
      operation: intervention.operation,
      from_generation: fromGeneration,
      summary,
      created_at: normalized.created_at,
      focused_until: focusedUntil,
    });
    const operation = existing
      ? {
          op: "patch" as const,
          node_id: existing.id,
          if_revision: existing.revision,
          changes: {
            surface: projected.node.surface,
            importance: projected.node.importance,
            status: projected.node.status,
            content: projected.node.content,
            a2ui: projected.node.a2ui,
            presentation: projected.node.presentation,
            lifecycle: projected.node.lifecycle,
            fallback: projected.node.fallback,
            provenance: projected.node.provenance,
          },
        }
      : { op: "put" as const, node: projected.node };
    const result = persistentGenerativeUiDocumentService.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: txId,
      document_id: document.document_id,
      base_revision: document.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
      operations: [operation],
      created_at: new Date(normalized.created_at).toISOString(),
    }, scope);
    if (result.status === "conflict") {
      throw new DagLiveSurfaceProjectionError(
        "a2ui_revision_conflict",
        `A2UI surface changed before intervention ${normalized.intervention_id} could commit`,
      );
    }
    if (result.status !== "applied") {
      throw new DagLiveSurfaceProjectionError(
        "a2ui_rejected",
        `A2UI intervention transaction ${txId} was ${result.status}: ${JSON.stringify(result.errors ?? [])}`,
      );
    }

    const nextSurfaceRevision = projection.surface_revision + 1;
    const updated = getDb().prepare(`
      UPDATE dag_surface_projections
      SET generation = ?, last_activity_sequence = 0, surface_revision = ?,
          activity_state = ?, visibility_state = 'focused', last_event_id = ?,
          focused_until = ?, updated_at = MAX(updated_at, ?)
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND surface_revision = ?
    `).run(
      toGeneration,
      nextSurfaceRevision,
      projected.activity,
      normalized.intervention_id,
      focusedUntil,
      normalized.created_at,
      normalized.run_id,
      normalized.actor_id,
      projection.generation,
      projection.surface_revision,
    );
    if (updated.changes !== 1) {
      throw new DagLiveSurfaceProjectionError(
        "surface_revision_conflict",
        "DAG live surface changed before intervention bookkeeping",
      );
    }

    return {
      projection: requireProjection(normalized.run_id, normalized.actor_id),
      intervention_id: normalized.intervention_id,
      operation: intervention.operation,
      from_generation: fromGeneration,
      to_generation: toGeneration,
      transaction_id: txId,
      ...(snapshot ? { snapshot } : {}),
      deduplicated: false,
    };
  }).immediate();
}

/** Full append-only Actor generation history for trusted Manager-side consumers. */
export function listDagLiveSurfaceGenerationHistory(input: {
  run_id: string;
  actor_id: string;
  limit?: number;
}): DagSurfaceGenerationSnapshotRecord[] {
  return listDagSurfaceGenerationSnapshots(input);
}

function controlDigest(input: {
  control_id: string;
  run_id: string;
  actor_id: string;
  operation: DagLiveSurfaceControlOperation;
  expected_surface_revision: number;
  focused_until?: number;
}): string {
  return digest({
    control_id: input.control_id,
    run_id: input.run_id,
    actor_id: input.actor_id,
    operation: input.operation,
    expected_surface_revision: input.expected_surface_revision,
    ...(input.focused_until === undefined ? {} : { focused_until: input.focused_until }),
  });
}

function existingControl(controlId: string): ControlRow | undefined {
  return getDb().prepare("SELECT * FROM dag_surface_projection_controls WHERE control_id = ?")
    .get(controlId) as ControlRow | undefined;
}

export function getDagLiveSurfaceControl(controlId: string): DagLiveSurfaceControlRecord | undefined {
  const row = existingControl(assertIdentifier(controlId, "control_id"));
  if (!row) return undefined;
  return {
    control_id: row.control_id,
    run_id: row.run_id,
    actor_id: row.actor_id,
    operation: row.operation,
    expected_surface_revision: row.expected_surface_revision,
    committed_surface_revision: row.committed_surface_revision,
    ...(row.focused_until === null ? {} : { focused_until: row.focused_until }),
    created_at: row.created_at,
  };
}

function visibilityContent(
  node: GenerativeUiStoredNodeV1,
  projection: DagLiveSurfaceProjectionRecord,
  visibility: DagLiveSurfaceVisibilityState,
  nextRevision: number,
  focusedUntil?: number,
): Record<string, unknown> {
  assertOwnedNode(node, projection);
  const data = projectedDataFromNode(node)!;
  data.actor.generation = projection.generation;
  data.state.visibility = visibility;
  data.state.surface_revision = nextRevision;
  if (focusedUntil === undefined) delete data.state.focused_until;
  else data.state.focused_until = focusedUntil;
  return { data };
}

/** Trusted Manager-side focus/removal boundary. Worker code has no access to it. */
export function controlDagLiveSurface(input: {
  control_id: string;
  run_id: string;
  actor_id: string;
  operation: DagLiveSurfaceControlOperation;
  expected_surface_revision: number;
  focused_until?: number;
  created_at?: number;
}): DagLiveSurfaceControlResult {
  const normalized = {
    control_id: assertIdentifier(input.control_id, "control_id"),
    run_id: assertIdentifier(input.run_id, "run_id"),
    actor_id: assertIdentifier(input.actor_id, "actor_id"),
    operation: input.operation,
    expected_surface_revision: assertNonNegativeSafeInteger(input.expected_surface_revision, "expected_surface_revision"),
    ...(input.focused_until === undefined
      ? {}
      : { focused_until: assertNonNegativeSafeInteger(input.focused_until, "focused_until") }),
    created_at: input.created_at === undefined ? Date.now() : assertNonNegativeSafeInteger(input.created_at, "created_at"),
  };
  if (normalized.operation !== "focused" && normalized.operation !== "removed") {
    throw new Error("operation must be focused or removed");
  }
  if (normalized.focused_until !== undefined && normalized.focused_until > MAX_FOCUS_UNTIL) {
    throw new Error("focused_until is outside the supported timestamp range");
  }
  if (normalized.created_at > MAX_FOCUS_UNTIL) {
    throw new Error("created_at is outside the supported timestamp range");
  }
  if (normalized.operation === "removed" && normalized.focused_until !== undefined) {
    throw new Error("removed control cannot include focused_until");
  }
  const inputDigest = controlDigest(normalized);
  const previous = existingControl(normalized.control_id);
  if (previous) {
    if (previous.input_digest !== inputDigest) {
      throw new DagLiveSurfaceProjectionError(
        "projection_state_conflict",
        `DAG live surface control id ${normalized.control_id} was reused with different input`,
      );
    }
    return {
      projection: requireProjection(previous.run_id, previous.actor_id),
      control_id: previous.control_id,
      transaction_id: previous.transaction_id,
      deduplicated: true,
    };
  }

  return getDb().transaction((): DagLiveSurfaceControlResult => {
    const actor = getDagActor(normalized.run_id, normalized.actor_id);
    if (!actor) throw new Error(`Unknown DAG actor: ${normalized.run_id}/${normalized.actor_id}`);
    let projection = requireProjection(normalized.run_id, normalized.actor_id);
    projection = advanceProjectionGeneration(projection, actor, normalized.created_at);
    if (
      projection.node_id !== actor.node_id
      || projection.surface_id !== actor.surface_id
      || projection.generation !== actor.generation
    ) {
      throw new DagLiveSurfaceProjectionError("identity_mismatch", "DAG live surface no longer matches its logical actor");
    }
    if (projection.surface_revision !== normalized.expected_surface_revision) {
      throw new DagLiveSurfaceProjectionError(
        "surface_revision_conflict",
        `DAG live surface revision is ${projection.surface_revision}, expected ${normalized.expected_surface_revision}`,
      );
    }
    const scope = scopeFor(normalized.run_id);
    const document = persistentGenerativeUiDocumentService.get(projection.document_id, scope);
    const node = document?.nodes.find((candidate) => candidate.id === projection.surface_id);
    if (!document || !node) {
      throw new DagLiveSurfaceProjectionError("projection_state_conflict", "DAG live surface A2UI node is unavailable");
    }
    assertOwnedNode(node, projection);
    const nextRevision = projection.surface_revision + 1;
    const txId = transactionId("control", normalized.control_id);
    const operation = normalized.operation === "removed"
      ? { op: "remove" as const, node_id: node.id, if_revision: node.revision }
      : {
          op: "patch" as const,
          node_id: node.id,
          if_revision: node.revision,
          changes: {
            importance: GenerativeUiImportance.CRITICAL,
            content: visibilityContent(node, projection, "focused", nextRevision, normalized.focused_until),
          },
        };
    const result = persistentGenerativeUiDocumentService.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: txId,
      document_id: document.document_id,
      base_revision: document.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
      operations: [operation],
      created_at: new Date(normalized.created_at).toISOString(),
    }, scope);
    if (result.status === "conflict") {
      throw new DagLiveSurfaceProjectionError("a2ui_revision_conflict", "A2UI surface changed before control commit");
    }
    if (result.status !== "applied") {
      throw new DagLiveSurfaceProjectionError(
        "a2ui_rejected",
        `A2UI control transaction ${txId} was ${result.status}: ${JSON.stringify(result.errors ?? [])}`,
      );
    }

    const visibility: DagLiveSurfaceVisibilityState = normalized.operation === "focused" ? "focused" : "removed";
    const updated = getDb().prepare(`
      UPDATE dag_surface_projections
      SET surface_revision = ?, visibility_state = ?, focused_until = ?, updated_at = MAX(updated_at, ?)
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND surface_revision = ?
    `).run(
      nextRevision,
      visibility,
      normalized.operation === "focused" ? normalized.focused_until ?? null : null,
      normalized.created_at,
      normalized.run_id,
      normalized.actor_id,
      actor.generation,
      normalized.expected_surface_revision,
    );
    if (updated.changes !== 1) {
      throw new DagLiveSurfaceProjectionError("surface_revision_conflict", "DAG live surface changed before control bookkeeping");
    }
    getDb().prepare(`
      INSERT INTO dag_surface_projection_controls(
        control_id, run_id, actor_id, node_id, surface_id, operation,
        expected_surface_revision, committed_surface_revision, focused_until,
        transaction_id, input_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.control_id,
      normalized.run_id,
      normalized.actor_id,
      actor.node_id,
      actor.surface_id,
      normalized.operation,
      normalized.expected_surface_revision,
      nextRevision,
      normalized.operation === "focused" ? normalized.focused_until ?? null : null,
      txId,
      inputDigest,
      normalized.created_at,
    );
    return {
      projection: requireProjection(normalized.run_id, normalized.actor_id),
      control_id: normalized.control_id,
      transaction_id: txId,
      deduplicated: false,
    };
  }).immediate();
}

function recoverableRunIds(): string[] {
  return (getDb().prepare(`
    SELECT DISTINCT e.run_id
    FROM dag_activity_events e
    JOIN dag_actors a
      ON a.run_id = e.run_id AND a.actor_id = e.actor_id AND a.node_id = e.node_id
      AND (e.surface_id IS NULL OR e.surface_id = a.surface_id)
    LEFT JOIN dag_surface_projection_queue q ON q.journal_seq = e.seq
    WHERE q.journal_seq IS NULL OR q.status = 'pending'
    ORDER BY e.run_id
  `).all() as Array<{ run_id: string }>).map((row) => row.run_id);
}

function recoverableActivityPage(runId: string, afterSeq: number): RecoverableActivityRow[] {
  return getDb().prepare(`
    SELECT e.seq, e.received_at, e.event_id, e.run_id, e.actor_id, e.event_json
    FROM dag_activity_events e
    JOIN dag_actors a
      ON a.run_id = e.run_id AND a.actor_id = e.actor_id AND a.node_id = e.node_id
      AND (e.surface_id IS NULL OR e.surface_id = a.surface_id)
    LEFT JOIN dag_surface_projection_queue q ON q.journal_seq = e.seq
    WHERE e.run_id = ? AND e.seq > ?
      AND (q.journal_seq IS NULL OR q.status = 'pending')
    ORDER BY e.seq
    LIMIT 500
  `).all(runId, afterSeq) as RecoverableActivityRow[];
}

function recoveryEntry(row: RecoverableActivityRow): DagActivityJournalEntry {
  const value = parseJsonRow<unknown>(row.event_json);
  const validation = validateDagActivityEventV1(value);
  if (!validation.valid) {
    throw new DagLiveSurfaceProjectionError(
      "projection_state_conflict",
      `Activity Journal contains invalid event ${row.event_id}`,
    );
  }
  return {
    seq: Number(row.seq),
    received_at: Number(row.received_at),
    event: value as DagActivityEventV1,
  };
}

/** Replay only missing/pending actor events without rescanning settled history. */
export function recoverDagLiveSurfaceProjections(runId?: string): DagLiveSurfaceRecoveryResult {
  const runIds = runId === undefined ? recoverableRunIds() : [assertIdentifier(runId, "run_id")];
  const result: DagLiveSurfaceRecoveryResult = { runs: runIds, projected_events: 0, failed: [] };
  const failedActors = new Set<string>();
  for (const currentRunId of runIds) {
    let afterSeq = 0;
    while (true) {
      const page = recoverableActivityPage(currentRunId, afterSeq);
      if (page.length === 0) break;
      for (const row of page) {
        try {
          const projected = projectDagActivityJournalEntry(recoveryEntry(row));
          result.projected_events += projected.applied_count;
        } catch (error) {
          const actorKey = `${currentRunId}\u0000${row.actor_id}`;
          if (!failedActors.has(actorKey)) {
            failedActors.add(actorKey);
            result.failed.push({
              run_id: currentRunId,
              event_id: row.event_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      afterSeq = Number(page.at(-1)!.seq);
      if (page.length < 500) break;
    }
  }
  return result;
}

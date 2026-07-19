import { createHash } from "node:crypto";
import {
  DAG_ACTOR_SURFACE_PATCH_PHASES,
  GENERATIVE_UI_IR_VERSION,
  GENERATIVE_UI_MAX_NODE_CONTENT_BYTES,
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
  type DagActorSurfaceBodyV1,
  type DagActorSurfacePatchPhaseV1,
  type DagActorSurfacePatchV1,
  type A2uiComponentV1,
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
import { getDagActorLease } from "../persistence/dag-actor-leases.js";
import { getCurrentDagRunRound } from "../persistence/dag-run-rounds.js";
import {
  commitDagActorSurfacePatchApplication,
  dagActorSurfacePatchDigest,
  ensureDagActorSurfaceView,
  getDagActorSurfaceView,
  getQueuedDagActorSurfacePatch,
  listContiguousPendingDagActorSurfacePatches,
  markStaleDagActorSurfacePatches,
  pruneDagActorSurfacePatchJournal,
  rejectDagActorSurfacePatch,
  type DagActorSurfacePatchApplyKind,
  type DagActorSurfaceViewRecord,
  type QueuedDagActorSurfacePatch,
} from "../persistence/dag-actor-surface-patches.js";
import { getRunArtifact } from "../persistence/run-artifacts.js";
import { encodeJson, getDb, parseJsonRow } from "../persistence/db.js";
import { getPluginArtifactBroker } from "../plugins/artifact-broker.js";
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
const ACTOR_PATCH_FOCUS_DURATION_MS = 12_000;
const ACTOR_PATCH_FOCUS_COOLDOWN_MS = 5_000;
const ACTOR_PATCH_COALESCE_WINDOW_MS = 75;
const MAX_SCHEDULED_ACTOR_PATCH_DRAINS = 256;
const ACTOR_COMPONENT_PREFIX = "actor.";

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

export interface DagActorSurfaceProjectionResult {
  run_id: string;
  actor_id: string;
  generation: number;
  journal_seq: number;
  applied_count: number;
  scheduled: boolean;
  view: DagActorSurfaceViewRecord;
}

export interface DagActorSurfaceRecoveryResult {
  runs: string[];
  applied_patches: number;
  stale_patches: number;
  failed: Array<{ run_id: string; actor_id: string; patch_id?: string; error: string }>;
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

type ProjectedFallback = NonNullable<GenerativeUiNodeV1["fallback"]>;

function actorComponentIds(body: DagActorSurfaceBodyV1): Map<string, string> {
  const ids = new Map<string, string>();
  const reserved = new Set(LIVE_SURFACE_A2UI.components.map((component) => component.id));
  for (const component of body.a2ui.components) {
    const namespaced = component.id === "root"
      ? `${ACTOR_COMPONENT_PREFIX}root`
      : `${ACTOR_COMPONENT_PREFIX}${createHash("sha256").update(component.id).digest("hex").slice(0, 24)}`;
    if (reserved.has(namespaced) || [...ids.values()].includes(namespaced)) {
      throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor component namespace collision");
    }
    ids.set(component.id, namespaced);
  }
  if (!ids.has("root")) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor A2UI root component is missing");
  }
  return ids;
}

function namespaceActorComponents(body: DagActorSurfaceBodyV1): A2uiComponentV1[] {
  const ids = actorComponentIds(body);
  const reference = (id: string): string => {
    const mapped = ids.get(id);
    if (!mapped) throw new DagLiveSurfaceProjectionError("a2ui_rejected", `Actor component reference is missing: ${id}`);
    return mapped;
  };
  return body.a2ui.components.map((component) => {
    const clone = structuredClone(component) as unknown as Record<string, unknown>;
    clone.id = reference(component.id);
    if (Array.isArray(clone.children)) {
      clone.children = clone.children.map((child) => reference(String(child)));
    } else if (clone.children && typeof clone.children === "object") {
      const children = clone.children as Record<string, unknown>;
      children.componentId = reference(String(children.componentId));
    }
    if (typeof clone.child === "string") clone.child = reference(clone.child);
    if (Array.isArray(clone.tabs)) {
      clone.tabs = clone.tabs.map((tab) => {
        const entry = tab as Record<string, unknown>;
        return { ...entry, child: reference(String(entry.child)) };
      });
    }
    if (typeof clone.trigger === "string") clone.trigger = reference(clone.trigger);
    if (typeof clone.content === "string") clone.content = reference(clone.content);
    return clone as unknown as A2uiComponentV1;
  });
}

function composedLiveSurfaceA2ui(body?: DagActorSurfaceBodyV1): HomerailA2uiSurfaceV1 {
  if (!body) return structuredClone(LIVE_SURFACE_A2UI);
  const composed: HomerailA2uiSurfaceV1 = {
    version: HOMERAIL_A2UI_VERSION,
    catalogId: HOMERAIL_A2UI_CATALOG_ID,
    components: [
      { id: "root", component: "Column", children: [`${ACTOR_COMPONENT_PREFIX}root`] },
      ...namespaceActorComponents(body),
    ],
  };
  if (composed.components.length > HOMERAIL_A2UI_MAX_COMPONENTS) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Composed DAG live surface exceeds the A2UI component budget");
  }
  return composed;
}

function actorViewContent(body: DagActorSurfaceBodyV1): Record<string, unknown> {
  return {
    data: structuredClone(body.data),
    fallback: structuredClone(body.fallback),
    ...(body.presentation_hint ? { presentation_hint: structuredClone(body.presentation_hint) } : {}),
  };
}

function composedProjectedContent(data: ProjectedData, body?: DagActorSurfaceBodyV1): Record<string, unknown> {
  return {
    data,
    ...(body ? { actor_view: actorViewContent(body) } : {}),
  };
}

function hostFallback(data: ProjectedData): ProjectedFallback {
  return {
    title: data.title,
    summary: data.state.summary,
    ...(data.findings.length ? { items: data.findings.map((finding) => finding.title) } : {}),
  };
}

function composedFallback(data: ProjectedData, body?: DagActorSurfaceBodyV1): ProjectedFallback {
  return body ? structuredClone(body.fallback) : hostFallback(data);
}

function actorBodyForProjection(projection: DagLiveSurfaceProjectionRecord): DagActorSurfaceBodyV1 | undefined {
  const view = getDagActorSurfaceView(projection.run_id, projection.actor_id);
  if (!view) return undefined;
  if (view.node_id !== projection.node_id
    || view.surface_id !== projection.surface_id
    || view.document_id !== projection.document_id) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface view ownership does not match Canvas projection");
  }
  return view.generation === projection.generation ? view.body : undefined;
}

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

function transactionId(kind: "activity" | "control" | "intervention" | "actor-patch" | "generation", id: string): string {
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

/**
 * Materialize concurrent entry Actors in workflow order before any Worker can
 * race to publish its first activity. Later updates patch these stable nodes.
 */
export function initializeDagLiveSurfaceRoster(
  actors: readonly DagActorRecord[],
  timestamp = Date.now(),
): GenerativeUiDocumentV1 | undefined {
  if (actors.length === 0) return undefined;
  const runId = actors[0].run_id;
  if (actors.some((actor) => actor.run_id !== runId)) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "DAG live surface roster spans multiple runs");
  }
  const actorIds = new Set<string>();
  const surfaceIds = new Set<string>();
  for (const actor of actors) {
    if (actorIds.has(actor.actor_id) || surfaceIds.has(actor.surface_id)) {
      throw new DagLiveSurfaceProjectionError("identity_mismatch", "DAG live surface roster contains duplicate identities");
    }
    actorIds.add(actor.actor_id);
    surfaceIds.add(actor.surface_id);
  }

  return getDb().transaction(() => {
    const projections = actors.map((actor) => {
      const projection = ensureProjection(actor, timestamp);
      ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now: timestamp });
      return projection;
    });
    const document = persistentGenerativeUiDocumentService.get(
      projections[0].document_id,
      scopeFor(runId),
    );
    if (!document) throw new Error(`A2UI document not found: ${projections[0].document_id}`);
    const existingIds = new Set(document.nodes.map((node) => node.id));
    const operations = actors.flatMap((actor, index) => {
      const projection = projections[index];
      if (existingIds.has(projection.surface_id)) return [];
      const event: DagActivityEventV1 = {
        schema_version: 1,
        event_id: `roster:${actor.actor_id}:g${actor.generation}`,
        run_id: runId,
        round_id: "roster",
        node_id: actor.node_id,
        actor_id: actor.actor_id,
        generation: actor.generation,
        surface_id: actor.surface_id,
        sequence: 0,
        timestamp,
        type: "started",
        payload: { message: "Waiting to start" },
      };
      const projected = buildProjectedNode({
        actor,
        projection: { ...projection, surface_revision: -1 },
        event,
        received_at: timestamp,
      });
      return [{ op: "put" as const, node: projected.node }];
    });
    if (operations.length === 0) return document;
    const rosterDigest = createHash("sha256")
      .update(JSON.stringify(actors.map((actor) => [actor.actor_id, actor.surface_id])))
      .digest("hex");
    const result = persistentGenerativeUiDocumentService.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: `dag-live-surface-roster-${rosterDigest}`,
      document_id: document.document_id,
      base_revision: document.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
      operations,
      created_at: new Date(timestamp).toISOString(),
    }, scopeFor(runId));
    if (result.status !== "applied" && result.status !== "duplicate") {
      throw new DagLiveSurfaceProjectionError(
        result.status === "conflict" ? "a2ui_revision_conflict" : "a2ui_rejected",
        "DAG live surface roster could not be materialized",
      );
    }
    return result.document;
  })();
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
  ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now: entry.received_at });

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
  let findings = previous?.state.round_id === input.event.round_id && previous.findings
    ? [...previous.findings]
    : [];
  const completedItems = activity === "completed" && Array.isArray(input.event.payload.items)
    ? input.event.payload.items
        .map(boundedString)
        .filter((item): item is string => item !== undefined)
        .slice(0, MAX_PROJECTED_FINDINGS)
    : [];
  if (completedItems.length > 0) {
    findings = completedItems.map((item, index) => ({
      id: `${input.event.event_id}:item:${index + 1}`,
      title: item,
      sequence: input.event.sequence,
      timestamp: input.event.timestamp,
    }));
  } else if (activity === "finding") {
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
  const hostContent = { data };
  while (
    data.findings.length > 1
    && Buffer.byteLength(JSON.stringify(hostContent), "utf8") > MAX_PROJECTED_CONTENT_BYTES
  ) {
    data.findings.shift();
  }
  if (Buffer.byteLength(JSON.stringify(hostContent), "utf8") > MAX_PROJECTED_CONTENT_BYTES) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Projected DAG live surface content exceeds its budget");
  }
  const actorBody = actorBodyForProjection(input.projection);
  const content = composedProjectedContent(data, actorBody);
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > GENERATIVE_UI_MAX_NODE_CONTENT_BYTES) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Composed DAG live surface content exceeds its budget");
  }
  const a2ui = composedLiveSurfaceA2ui(actorBody);

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
      a2ui,
      presentation: { density: "summary", canvas_size: "1x2" },
      lifecycle: { persistence: "session", removable: true },
      fallback: composedFallback(data, actorBody),
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
      presentation: { density: "summary", canvas_size: "1x2" },
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
    ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now: normalized.created_at });
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

function visibilityChanges(
  node: GenerativeUiStoredNodeV1,
  projection: DagLiveSurfaceProjectionRecord,
  visibility: DagLiveSurfaceVisibilityState,
  nextRevision: number,
  focusedUntil?: number,
): { content: Record<string, unknown>; a2ui: HomerailA2uiSurfaceV1; fallback: ProjectedFallback } {
  assertOwnedNode(node, projection);
  const data = projectedDataFromNode(node)!;
  data.actor.generation = projection.generation;
  data.state.visibility = visibility;
  data.state.surface_revision = nextRevision;
  if (focusedUntil === undefined) delete data.state.focused_until;
  else data.state.focused_until = focusedUntil;
  const body = actorBodyForProjection(projection);
  return {
    content: composedProjectedContent(data, body),
    a2ui: composedLiveSurfaceA2ui(body),
    fallback: composedFallback(data, body),
  };
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
    ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now: normalized.created_at });
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
            ...visibilityChanges(node, projection, "focused", nextRevision, normalized.focused_until),
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

interface ActorBindingScope {
  inTemplate: boolean;
  value: unknown;
}

function actorPointer(root: unknown, path: string): unknown {
  if (!path.startsWith("/")) return undefined;
  let current = root;
  for (const encoded of path.split("/").slice(1)) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function resolveActorPath(path: string, body: DagActorSurfaceBodyV1, scope: ActorBindingScope): unknown {
  const dataModel = { actor_view: { data: body.data } };
  return path.startsWith("/")
    ? actorPointer(dataModel, path)
    : scope.inTemplate
      ? actorPointer(scope.value, `/${path}`)
      : undefined;
}

function resolveActorBinding(
  value: unknown,
  body: DagActorSurfaceBodyV1,
  scope: ActorBindingScope,
): unknown {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const path = (value as { path?: unknown }).path;
  return typeof path === "string" ? resolveActorPath(path, body, scope) : undefined;
}

function actorComponentEdges(component: Record<string, unknown>): Array<{ id: string; templatePath?: string }> {
  const children = component.children;
  if (Array.isArray(children)) {
    return children.filter((entry): entry is string => typeof entry === "string").map((id) => ({ id }));
  }
  if (children && typeof children === "object" && !Array.isArray(children)) {
    const path = (children as Record<string, unknown>).path;
    const id = (children as Record<string, unknown>).componentId;
    return typeof path === "string" && typeof id === "string" ? [{ id, templatePath: path }] : [];
  }
  if (typeof component.child === "string") return [{ id: component.child }];
  if (Array.isArray(component.tabs)) {
    return component.tabs.flatMap((tab) => tab && typeof tab === "object" && typeof (tab as { child?: unknown }).child === "string"
      ? [{ id: (tab as { child: string }).child }]
      : []);
  }
  return [];
}

function assertBrokerArtifactUri(uri: unknown, runId: string): void {
  if (typeof uri !== "string" || !uri.startsWith("/")) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor media must use a Manager broker URI");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri, "http://homerail.invalid");
  } catch {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor media URI is invalid");
  }
  if (parsed.origin !== "http://homerail.invalid"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || `${parsed.pathname}` !== uri) {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor media URI must be credential-free and canonical");
  }

  const runMatch = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(uri);
  if (runMatch) {
    let uriRunId: string;
    let name: string;
    try {
      uriRunId = decodeURIComponent(runMatch[1]);
      name = decodeURIComponent(runMatch[2]);
    } catch {
      throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Run artifact URI encoding is invalid");
    }
    const canonical = `/api/runs/${encodeURIComponent(uriRunId)}/artifacts/${encodeURIComponent(name)}/content`;
    const artifact = uriRunId === runId && canonical === uri ? getRunArtifact(uriRunId, name) : undefined;
    if (!artifact || artifact.status !== "ready") {
      throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Run artifact is not published for this Actor run");
    }
    return;
  }

  const pluginMatch = /^\/api\/plugins\/artifacts\/([^/]+)\/([^/]+)\/([0-9a-f]{64})$/.exec(uri);
  if (pluginMatch) {
    try {
      const pluginId = decodeURIComponent(pluginMatch[1]);
      const requestId = decodeURIComponent(pluginMatch[2]);
      const result = getPluginArtifactBroker().read({
        plugin_id: pluginId,
        request_id: requestId,
        digest: pluginMatch[3],
      });
      if (result.metadata.read_path !== uri) throw new Error("non-canonical broker path");
      return;
    } catch {
      throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Plugin artifact is not published by the Manager broker");
    }
  }

  throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor media URI is outside the Manager artifact brokers");
}

function assertBrokerAllowedBody(body: DagActorSurfaceBodyV1, runId: string): void {
  if (body.a2ui.surfaceProperties?.iconUrl) {
    assertBrokerArtifactUri(body.a2ui.surfaceProperties.iconUrl, runId);
  }
  const components = new Map<string, Record<string, unknown>>();
  for (const component of body.a2ui.components as unknown as Record<string, unknown>[]) {
    if (typeof component.id === "string") components.set(component.id, component);
  }
  const visit = (id: string, scope: ActorBindingScope, ancestors: ReadonlySet<string>): void => {
    const component = components.get(id);
    if (!component || ancestors.has(id)) return;
    switch (component.component) {
      case "Image":
      case "AudioPlayer":
        assertBrokerArtifactUri(resolveActorBinding(component.url, body, scope), runId);
        break;
      case "Video":
        assertBrokerArtifactUri(resolveActorBinding(component.url, body, scope), runId);
        if (component.posterUrl !== undefined) {
          assertBrokerArtifactUri(resolveActorBinding(component.posterUrl, body, scope), runId);
        }
        break;
      case "HrArtifact":
        assertBrokerArtifactUri(resolveActorBinding(component.uri, body, scope), runId);
        break;
      default:
        break;
    }
    const next = new Set(ancestors);
    next.add(id);
    for (const edge of actorComponentEdges(component)) {
      if (!edge.templatePath) {
        visit(edge.id, scope, next);
        continue;
      }
      const items = resolveActorPath(edge.templatePath, body, scope);
      if (!Array.isArray(items)) continue;
      for (const item of items) visit(edge.id, { inTemplate: true, value: item }, next);
    }
  };
  visit("root", { inTemplate: false, value: { actor_view: { data: body.data } } }, new Set());
  for (const reference of body.fallback.artifact_refs ?? []) {
    assertBrokerArtifactUri(reference.uri, runId);
  }
}

function assertCurrentActorPatchTarget(target: QueuedDagActorSurfacePatch, actor: DagActorRecord): void {
  const patch = target.patch;
  if (target.queue.status !== "pending"
    || patch.run_id !== actor.run_id
    || patch.actor_id !== actor.actor_id
    || patch.node_id !== actor.node_id
    || target.surface_id !== actor.surface_id) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch ownership is not current");
  }
  if (patch.generation !== actor.generation) {
    throw new DagLiveSurfaceProjectionError("generation_conflict", "Actor surface patch generation is not current");
  }
  if (!actor.session_id || patch.session_id !== actor.session_id) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch session is not current");
  }
  const round = getCurrentDagRunRound(actor.run_id);
  if (!round || round.round_id !== patch.round_id) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch round is not current");
  }
  const lease = getDagActorLease({ run_id: actor.run_id, actor_id: actor.actor_id });
  if (!lease || lease.state !== "leased" || lease.lease_generation !== patch.lease_generation) {
    throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch lease is not current");
  }
}

function initialProjectedData(input: {
  actor: DagActorRecord;
  projection: DagLiveSurfaceProjectionRecord;
  target: QueuedDagActorSurfacePatch;
  surface_revision: number;
}): ProjectedData {
  return {
    projector: { id: PROJECTOR_ID, version: PROJECTOR_DATA_VERSION },
    actor: {
      id: input.actor.actor_id,
      role: input.actor.role,
      node_id: input.actor.node_id,
      generation: input.actor.generation,
    },
    title: input.actor.role,
    state: {
      activity: "started",
      visibility: "visible",
      label: "Started",
      summary: "Started",
      tone: "info",
      progress: 0,
      event_id: `surface-init:${input.actor.generation}`,
      round_id: input.target.patch.round_id,
      sequence: 0,
      updated_at: input.target.received_at,
      surface_revision: input.surface_revision,
    },
    findings: [],
  };
}

function initialActorSurfaceNode(input: {
  actor: DagActorRecord;
  projection: DagLiveSurfaceProjectionRecord;
  target: QueuedDagActorSurfacePatch;
  body: DagActorSurfaceBodyV1;
  data: ProjectedData;
  focused_until?: number;
}): GenerativeUiNodeV1 {
  const focused = input.focused_until !== undefined;
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: input.projection.surface_id,
    kind: GENERATED_VIEW_KIND,
    kind_version: GENERATED_VIEW_KIND_VERSION,
    owner: { id: CORE_PLUGIN_ID, version: activeCoreVersion() },
    surface: GenerativeUiSurface.EXECUTION,
    importance: focused ? GenerativeUiImportance.CRITICAL : GenerativeUiImportance.PRIMARY,
    status: { phase: GenerativeUiPhase.RUNNING, label: "Started", progress: 0 },
    content: composedProjectedContent(input.data, input.body),
    a2ui: composedLiveSurfaceA2ui(input.body),
    presentation: { density: "summary", canvas_size: "1x2" },
    lifecycle: { persistence: "session", removable: true },
    fallback: composedFallback(input.data, input.body),
    provenance: { actor: "agent", actor_id: input.actor.actor_id, run_id: input.actor.run_id },
  };
}

function ensureActorPatchProjection(target: QueuedDagActorSurfacePatch): {
  actor: DagActorRecord;
  projection: DagLiveSurfaceProjectionRecord;
  view: DagActorSurfaceViewRecord;
} {
  const actor = getDagActor(target.patch.run_id, target.patch.actor_id);
  if (!actor) throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch Actor is unavailable");
  assertCurrentActorPatchTarget(target, actor);
  let projection = ensureProjection(actor, target.received_at);
  projection = advanceProjectionGeneration(projection, actor, target.received_at);
  const view = ensureDagActorSurfaceView({
    actor,
    document_id: projection.document_id,
    now: target.received_at,
  });
  return { actor, projection, view };
}

function coalescedActorPatchGroup(
  contiguous: QueuedDagActorSurfacePatch[],
  actor: DagActorRecord,
): QueuedDagActorSurfacePatch[] {
  const first = contiguous[0];
  if (!first || first.patch.op !== "replace_body" || first.patch.phase !== "partial") return first ? [first] : [];
  const componentDigest = dagActorSurfacePatchDigest(first.patch.body.a2ui.components);
  const group: QueuedDagActorSurfacePatch[] = [];
  for (const candidate of contiguous) {
    if (candidate.patch.op !== "replace_body"
      || candidate.patch.phase !== "partial"
      || candidate.patch.session_id !== first.patch.session_id
      || candidate.patch.round_id !== first.patch.round_id
      || candidate.patch.lease_generation !== first.patch.lease_generation
      || dagActorSurfacePatchDigest(candidate.patch.body.a2ui.components) !== componentDigest) break;
    try {
      assertCurrentActorPatchTarget(candidate, actor);
      assertBrokerAllowedBody(candidate.patch.body, candidate.patch.run_id);
      composedLiveSurfaceA2ui(candidate.patch.body);
    } catch {
      break;
    }
    group.push(candidate);
  }
  return group.length > 0 ? group : [first];
}

function assertMonotonicActorPatchPhase(
  view: DagActorSurfaceViewRecord,
  patch: DagActorSurfacePatchV1,
): void {
  if (!view.phase || view.round_id !== patch.round_id) return;
  if (view.phase === "final") {
    throw new DagLiveSurfaceProjectionError(
      "a2ui_rejected",
      `Actor Surface phase final already closed round ${patch.round_id}`,
    );
  }
  if (DAG_ACTOR_SURFACE_PATCH_PHASES.indexOf(patch.phase)
    < DAG_ACTOR_SURFACE_PATCH_PHASES.indexOf(view.phase)) {
    throw new DagLiveSurfaceProjectionError(
      "a2ui_rejected",
      `Actor Surface phase cannot move backward from ${view.phase} to ${patch.phase}`,
    );
  }
}

function applyActorPatchGroup(group: QueuedDagActorSurfacePatch[]): number {
  const target = group.at(-1);
  if (!target) return 0;
  const { actor, projection, view } = ensureActorPatchProjection(target);
  if (view.body_revision + group.length !== target.patch.patch_sequence) {
    throw new DagLiveSurfaceProjectionError("projection_state_conflict", "Actor surface patch group is not contiguous");
  }
  assertMonotonicActorPatchPhase(view, target.patch);
  for (const candidate of group) {
    assertCurrentActorPatchTarget(candidate, actor);
    if (candidate.patch.op === "replace_body") {
      assertBrokerAllowedBody(candidate.patch.body, candidate.patch.run_id);
      composedLiveSurfaceA2ui(candidate.patch.body);
    }
  }

  const body = target.patch.op === "replace_body" ? target.patch.body : undefined;
  const nextBodyDigest = body ? dagActorSurfacePatchDigest(body) : undefined;
  const nextComponentDigest = body ? dagActorSurfacePatchDigest(body.a2ui.components) : undefined;
  const bodyChanged = view.body_digest !== nextBodyDigest || Boolean(view.body) !== Boolean(body);
  const structureChanged = Boolean(view.body) !== Boolean(body)
    || view.component_digest !== nextComponentDigest;
  const milestonePhase = new Set<DagActorSurfacePatchPhaseV1>(["verified", "refined", "final"])
    .has(target.patch.phase)
    && target.patch.phase !== view.phase;

  const scope = scopeFor(actor.run_id);
  const document = persistentGenerativeUiDocumentService.get(projection.document_id, scope);
  if (!document) throw new DagLiveSurfaceProjectionError("projection_state_conflict", "Actor surface Canvas document is unavailable");
  const existing = document.nodes.find((node) => node.id === projection.surface_id);
  if (existing) {
    assertOwnedNode(existing, projection);
    const expectedA2ui = composedLiveSurfaceA2ui(view.body);
    if (digest(existing.a2ui) !== digest(expectedA2ui)) {
      throw new DagLiveSurfaceProjectionError("projection_state_conflict", "Actor surface components do not match the materialized view");
    }
  }
  if (projection.visibility_state === "removed") {
    throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Actor patch cannot restore a removed Canvas surface");
  }

  const focusAllowed = view.last_focus_at === undefined
    || target.received_at >= view.last_focus_at + ACTOR_PATCH_FOCUS_COOLDOWN_MS;
  const shouldFocus = Boolean(existing || body) && focusAllowed && (structureChanged || milestonePhase);
  const visualChange = bodyChanged || shouldFocus;
  let applyKind: Exclude<DagActorSurfacePatchApplyKind, "coalesced"> = "no_op";
  if (visualChange) {
    if (target.patch.op === "clear_body" && bodyChanged) applyKind = "clear_body";
    else if (structureChanged) applyKind = "patch_components";
    else applyKind = "update_data_model";
  }
  if (!visualChange) {
    commitDagActorSurfacePatchApplication({
      target,
      expected_body_revision: view.body_revision,
      ...(body ? { body } : {}),
      apply_kind: "no_op",
      coalesced_journal_seqs: group.slice(0, -1).map((entry) => entry.journal_seq),
      applied_at: target.received_at,
    });
    return group.length;
  }

  const nextSurfaceRevision = projection.surface_revision + 1;
  const focusedUntil = shouldFocus
    ? Math.min(MAX_FOCUS_UNTIL, target.received_at + ACTOR_PATCH_FOCUS_DURATION_MS)
    : projection.focused_until;
  const visibility = shouldFocus ? "focused" : nextVisibility(projection, target.received_at);
  const data = existing
    ? projectedDataFromNode(existing)
    : initialProjectedData({ actor, projection, target, surface_revision: nextSurfaceRevision });
  if (!data) throw new DagLiveSurfaceProjectionError("projection_state_conflict", "Actor surface host data is unavailable");
  data.actor.generation = actor.generation;
  data.state.surface_revision = nextSurfaceRevision;
  data.state.visibility = visibility;
  if (visibility === "focused" && focusedUntil !== undefined) data.state.focused_until = focusedUntil;
  else delete data.state.focused_until;

  const txId = transactionId(
    "actor-patch",
    `${actor.run_id}\u0000${actor.actor_id}\u0000${actor.generation}\u0000${target.patch.patch_id}`,
  );
  const operation = existing
    ? {
        op: "patch" as const,
        node_id: existing.id,
        if_revision: existing.revision,
        changes: {
          importance: visibility === "focused" ? GenerativeUiImportance.CRITICAL : GenerativeUiImportance.PRIMARY,
          content: composedProjectedContent(data, body),
          fallback: composedFallback(data, body),
          ...(structureChanged ? { a2ui: composedLiveSurfaceA2ui(body) } : {}),
        },
      }
    : {
        op: "put" as const,
        node: initialActorSurfaceNode({
          actor,
          projection,
          target,
          body: body!,
          data,
          ...(focusedUntil === undefined ? {} : { focused_until: focusedUntil }),
        }),
      };
  const result = persistentGenerativeUiDocumentService.apply({
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: txId,
    document_id: document.document_id,
    base_revision: document.revision,
    actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
    operations: [operation],
    created_at: new Date(target.received_at).toISOString(),
  }, scope);
  if (result.status === "conflict") {
    throw new DagLiveSurfaceProjectionError("a2ui_revision_conflict", "Actor surface Canvas changed before patch commit");
  }
  if (result.status !== "applied") {
    throw new DagLiveSurfaceProjectionError(
      "a2ui_rejected",
      `Actor surface Canvas transaction was ${result.status}: ${JSON.stringify(result.errors ?? [])}`,
    );
  }

  const projectionUpdated = getDb().prepare(`
    UPDATE dag_surface_projections
    SET surface_revision = ?, visibility_state = ?, focused_until = ?, updated_at = MAX(updated_at, ?)
    WHERE run_id = ? AND actor_id = ? AND generation = ? AND surface_revision = ?
  `).run(
    nextSurfaceRevision,
    visibility,
    visibility === "focused" ? focusedUntil ?? null : null,
    target.received_at,
    actor.run_id,
    actor.actor_id,
    actor.generation,
    projection.surface_revision,
  );
  if (projectionUpdated.changes !== 1) {
    throw new DagLiveSurfaceProjectionError("surface_revision_conflict", "Actor surface projection changed before patch bookkeeping");
  }
  commitDagActorSurfacePatchApplication({
    target,
    expected_body_revision: view.body_revision,
    ...(body ? { body } : {}),
    apply_kind: applyKind,
    transaction_id: txId,
    coalesced_journal_seqs: group.slice(0, -1).map((entry) => entry.journal_seq),
    ...(shouldFocus ? { focus_at: target.received_at } : {}),
    applied_at: target.received_at,
  });
  return group.length;
}

function rejectableActorPatchError(error: unknown): error is DagLiveSurfaceProjectionError {
  return error instanceof DagLiveSurfaceProjectionError
    && (error.code === "a2ui_rejected" || error.code === "identity_mismatch");
}

function drainActorSurfacePatches(runId: string, actorId: string): number {
  let processed = 0;
  while (processed < 500) {
    const actor = getDagActor(runId, actorId);
    if (!actor) throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch Actor is unavailable");
    let projection = ensureProjection(actor, Date.now());
    projection = advanceProjectionGeneration(projection, actor, Date.now());
    const view = ensureDagActorSurfaceView({ actor, document_id: projection.document_id });
    const contiguous = listContiguousPendingDagActorSurfacePatches({
      run_id: runId,
      actor_id: actorId,
      generation: actor.generation,
      after_patch_sequence: view.body_revision,
    });
    if (contiguous.length === 0) break;
    let group = coalescedActorPatchGroup(contiguous, actor);
    try {
      processed += getDb().transaction(() => applyActorPatchGroup(group)).immediate();
      continue;
    } catch (error) {
      if (group.length > 1) {
        group = [group[0]];
        try {
          processed += getDb().transaction(() => applyActorPatchGroup(group)).immediate();
          continue;
        } catch (singleError) {
          error = singleError;
        }
      }
      if (!rejectableActorPatchError(error)) throw error;
      const currentView = getDagActorSurfaceView(runId, actorId);
      if (!currentView || currentView.generation !== group[0].patch.generation) throw error;
      rejectDagActorSurfacePatch({
        target: group[0],
        expected_body_revision: currentView.body_revision,
        failure: { code: error.code, message: error.message },
      });
      processed += 1;
    }
  }
  pruneDagActorSurfacePatchJournal(runId, actorId);
  return processed;
}

const scheduledActorPatchDrains = new Map<string, ReturnType<typeof setTimeout>>();

function actorPatchDrainKey(runId: string, actorId: string): string {
  return `${runId}\u0000${actorId}`;
}

function cancelActorPatchDrain(runId: string, actorId: string): void {
  const key = actorPatchDrainKey(runId, actorId);
  const timer = scheduledActorPatchDrains.get(key);
  if (!timer) return;
  clearTimeout(timer);
  scheduledActorPatchDrains.delete(key);
}

export function flushDagActorSurfacePatches(runId: string, actorId: string): number {
  cancelActorPatchDrain(assertIdentifier(runId, "run_id"), assertIdentifier(actorId, "actor_id"));
  return drainActorSurfacePatches(runId, actorId);
}

/** Queue-aware projector entrypoint. Partial updates inside the short window are durably merged. */
export function projectDagActorSurfacePatch(journalSeq: number): DagActorSurfaceProjectionResult {
  if (!Number.isSafeInteger(journalSeq) || journalSeq < 1) throw new Error("journal seq must be a positive safe integer");
  const target = getQueuedDagActorSurfacePatch(journalSeq);
  if (!target) throw new Error(`Actor surface patch queue entry is unavailable: ${journalSeq}`);
  const actor = getDagActor(target.patch.run_id, target.patch.actor_id);
  if (!actor) throw new DagLiveSurfaceProjectionError("identity_mismatch", "Actor surface patch Actor is unavailable");
  if (target.patch.generation < actor.generation && target.queue.status === "pending") {
    markStaleDagActorSurfacePatches({
      run_id: actor.run_id,
      actor_id: actor.actor_id,
      before_generation: actor.generation,
    });
  } else if (target.patch.generation > actor.generation) {
    throw new DagLiveSurfaceProjectionError("generation_conflict", "Actor surface patch generation is ahead of its Actor");
  }

  let projection = ensureProjection(actor, target.received_at);
  projection = advanceProjectionGeneration(projection, actor, target.received_at);
  let view = ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now: target.received_at });
  if (target.queue.status !== "pending" || target.patch.generation !== actor.generation) {
    return {
      run_id: actor.run_id,
      actor_id: actor.actor_id,
      generation: actor.generation,
      journal_seq: journalSeq,
      applied_count: 0,
      scheduled: false,
      view,
    };
  }

  const key = actorPatchDrainKey(actor.run_id, actor.actor_id);
  const recentPartial = target.patch.phase === "partial"
    && view.last_applied_at !== undefined
    && target.received_at < view.last_applied_at + ACTOR_PATCH_COALESCE_WINDOW_MS;
  if (recentPartial && (scheduledActorPatchDrains.has(key)
    || scheduledActorPatchDrains.size < MAX_SCHEDULED_ACTOR_PATCH_DRAINS)) {
    if (!scheduledActorPatchDrains.has(key)) {
      const delay = Math.max(1, view.last_applied_at! + ACTOR_PATCH_COALESCE_WINDOW_MS - target.received_at);
      const timer = setTimeout(() => {
        scheduledActorPatchDrains.delete(key);
        try {
          drainActorSurfacePatches(actor.run_id, actor.actor_id);
        } catch (error) {
          console.warn("[dag-actor-surface] scheduled projection failed", {
            runId: actor.run_id,
            actorId: actor.actor_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, delay);
      timer.unref?.();
      scheduledActorPatchDrains.set(key, timer);
    }
    return {
      run_id: actor.run_id,
      actor_id: actor.actor_id,
      generation: actor.generation,
      journal_seq: journalSeq,
      applied_count: 0,
      scheduled: true,
      view,
    };
  }

  cancelActorPatchDrain(actor.run_id, actor.actor_id);
  const appliedCount = drainActorSurfacePatches(actor.run_id, actor.actor_id);
  view = getDagActorSurfaceView(actor.run_id, actor.actor_id)!;
  return {
    run_id: actor.run_id,
    actor_id: actor.actor_id,
    generation: actor.generation,
    journal_seq: journalSeq,
    applied_count: appliedCount,
    scheduled: false,
    view,
  };
}

/** Clear only the old Actor-owned body when a logical Actor generation advances. */
export function resetDagLiveSurfaceActorBody(input: {
  run_id: string;
  actor_id: string;
  now?: number;
}): DagActorSurfaceViewRecord {
  const runId = assertIdentifier(input.run_id, "run_id");
  const actorId = assertIdentifier(input.actor_id, "actor_id");
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const actor = getDagActor(runId, actorId);
    if (!actor) throw new Error(`Unknown DAG actor: ${runId}/${actorId}`);
    let projection = ensureProjection(actor, now);
    const fromGeneration = projection.generation;
    projection = advanceProjectionGeneration(projection, actor, now);
    const view = ensureDagActorSurfaceView({ actor, document_id: projection.document_id, now });
    if (fromGeneration === actor.generation) return view;

    const scope = scopeFor(runId);
    const document = persistentGenerativeUiDocumentService.get(projection.document_id, scope);
    const node = document?.nodes.find((candidate) => candidate.id === projection.surface_id);
    if (!document || !node) return view;
    assertOwnedNode(node, projection);
    const data = projectedDataFromNode(node);
    if (!data) throw new DagLiveSurfaceProjectionError("projection_state_conflict", "Generation reset host data is unavailable");
    const nextRevision = projection.surface_revision + 1;
    data.actor.generation = actor.generation;
    data.state.surface_revision = nextRevision;
    const txId = transactionId("generation", `${runId}\u0000${actorId}\u0000${actor.generation}`);
    const result = persistentGenerativeUiDocumentService.apply({
      ir_version: GENERATIVE_UI_IR_VERSION,
      transaction_id: txId,
      document_id: document.document_id,
      base_revision: document.revision,
      actor: { type: GenerativeUiActorType.SYSTEM, id: PROJECTOR_ID },
      operations: [{
        op: "patch",
        node_id: node.id,
        if_revision: node.revision,
        changes: {
          content: composedProjectedContent(data),
          a2ui: composedLiveSurfaceA2ui(),
          fallback: hostFallback(data),
        },
      }],
      created_at: new Date(now).toISOString(),
    }, scope);
    if (result.status === "conflict") {
      throw new DagLiveSurfaceProjectionError("a2ui_revision_conflict", "Canvas changed before Actor generation reset");
    }
    if (result.status !== "applied") {
      throw new DagLiveSurfaceProjectionError("a2ui_rejected", "Canvas rejected Actor generation reset");
    }
    const updated = getDb().prepare(`
      UPDATE dag_surface_projections
      SET surface_revision = ?, updated_at = MAX(updated_at, ?)
      WHERE run_id = ? AND actor_id = ? AND generation = ? AND surface_revision = ?
    `).run(nextRevision, now, runId, actorId, actor.generation, projection.surface_revision);
    if (updated.changes !== 1) {
      throw new DagLiveSurfaceProjectionError("surface_revision_conflict", "Projection changed before Actor generation reset bookkeeping");
    }
    return getDagActorSurfaceView(runId, actorId)!;
  }).immediate();
}

/** Recover only pending queues and generation mismatches; settled journal history is not replayed. */
export function recoverDagActorSurfacePatches(runId?: string): DagActorSurfaceRecoveryResult {
  const normalizedRunId = runId === undefined ? undefined : assertIdentifier(runId, "run_id");
  const conditions = normalizedRunId === undefined ? "" : "AND actor.run_id = ?";
  const rows = getDb().prepare(`
    SELECT DISTINCT actor.run_id, actor.actor_id
    FROM dag_actors actor
    LEFT JOIN dag_actor_surface_views view
      ON view.run_id = actor.run_id AND view.actor_id = actor.actor_id
    LEFT JOIN dag_actor_surface_patch_queue queue
      ON queue.run_id = actor.run_id AND queue.actor_id = actor.actor_id AND queue.status = 'pending'
    WHERE (view.generation < actor.generation OR queue.journal_seq IS NOT NULL)
      ${conditions}
    ORDER BY actor.run_id, actor.actor_id
  `).all(...(normalizedRunId === undefined ? [] : [normalizedRunId])) as Array<{ run_id: string; actor_id: string }>;
  const result: DagActorSurfaceRecoveryResult = {
    runs: [...new Set(rows.map((row) => row.run_id))],
    applied_patches: 0,
    stale_patches: 0,
    failed: [],
  };
  for (const row of rows) {
    try {
      const actor = getDagActor(row.run_id, row.actor_id);
      if (!actor) continue;
      const view = getDagActorSurfaceView(row.run_id, row.actor_id);
      if (view && view.generation < actor.generation) {
        resetDagLiveSurfaceActorBody({ run_id: row.run_id, actor_id: row.actor_id });
      }
      result.stale_patches += markStaleDagActorSurfacePatches({
        run_id: row.run_id,
        actor_id: row.actor_id,
        before_generation: actor.generation,
      });
      result.applied_patches += flushDagActorSurfacePatches(row.run_id, row.actor_id);
    } catch (error) {
      result.failed.push({
        run_id: row.run_id,
        actor_id: row.actor_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
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

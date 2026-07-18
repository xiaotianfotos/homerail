import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import { persistentGenerativeUiDocumentService } from "../src/generative-ui/shadow-service.js";
import {
  appendDagActorSurfacePatch,
  commitDagActorSurfacePatchApplication,
  DagActorSurfacePatchConflictError,
  ensureDagActorSurfaceView,
  getDagActorSurfaceView,
  listContiguousPendingDagActorSurfacePatches,
  listDagActorSurfaceSnapshots,
} from "../src/persistence/dag-actor-surface-patches.js";
import {
  advanceDagActorGeneration,
  getDagActor,
  registerDagActor,
  updateDagActorBinding,
} from "../src/persistence/dag-actors.js";
import { acquireDagActorLease, ensureDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { expectCurrentSchemaMigrationVersion } from "./schema-migration-helpers.js";
import { createInitialDagRunRound } from "../src/persistence/dag-run-rounds.js";
import { ensureRunDir } from "../src/persistence/store.js";

const RUN_ID = "run-surface-patch";
const ACTOR_ID = "researcher";
const NODE_ID = "research";
const SURFACE_ID = "surface:researcher";
const SESSION_ID = "session-1";
const ROUND_ID = "round-1";
const SIBLING_ACTOR_ID = "reviewer";
const SIBLING_NODE_ID = "review";
const SIBLING_SURFACE_ID = "surface:reviewer";
const SIBLING_SESSION_ID = "session-reviewer";

function surfacePatch(sequence: number, overrides: Partial<DagActorSurfacePatchV1> = {}): DagActorSurfacePatchV1 {
  return {
    schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
    run_id: RUN_ID,
    node_id: NODE_ID,
    session_id: SESSION_ID,
    round_id: ROUND_ID,
    actor_id: ACTOR_ID,
    generation: 1,
    lease_generation: 1,
    patch_id: `patch-${sequence}`,
    patch_sequence: sequence,
    timestamp: 1_800_000_000_000 + sequence,
    op: "replace_body",
    phase: sequence === 1 ? "started" : "partial",
    body: {
      a2ui: {
        version: HOMERAIL_A2UI_VERSION,
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["summary"] },
          { id: "summary", component: "Text", text: { path: "/actor_view/data/summary" } },
        ],
      },
      data: { summary: `Result ${sequence}` },
      fallback: { title: "Research", summary: `Result ${sequence}` },
    },
    ...overrides,
  } as DagActorSurfacePatchV1;
}

function initializeActor(): void {
  ensureRunDir(RUN_ID);
  const registered = registerDagActor({
    run_id: RUN_ID,
    actor_id: ACTOR_ID,
    node_id: NODE_ID,
    role: "research",
    surface_id: SURFACE_ID,
  }).actor;
  updateDagActorBinding({
    run_id: RUN_ID,
    actor_id: ACTOR_ID,
    expected_version: registered.version,
    session_id: SESSION_ID,
  });
  createInitialDagRunRound({
    run_id: RUN_ID,
    round_id: ROUND_ID,
    target_actor_ids: [ACTOR_ID],
    opened_at: 100,
  });
  const dormant = ensureDagActorLease({
    run_id: RUN_ID,
    actor_id: ACTOR_ID,
    now: 100,
  });
  acquireDagActorLease({
    run_id: RUN_ID,
    actor_id: ACTOR_ID,
    target_type: "worker",
    target_id: "worker-1",
    expected_version: dormant.version,
    now: 101,
  });
}

function initializeSiblingActor(): void {
  const registered = registerDagActor({
    run_id: RUN_ID,
    actor_id: SIBLING_ACTOR_ID,
    node_id: SIBLING_NODE_ID,
    role: "review",
    surface_id: SIBLING_SURFACE_ID,
  }).actor;
  updateDagActorBinding({
    run_id: RUN_ID,
    actor_id: SIBLING_ACTOR_ID,
    expected_version: registered.version,
    session_id: SIBLING_SESSION_ID,
  });
  const dormant = ensureDagActorLease({
    run_id: RUN_ID,
    actor_id: SIBLING_ACTOR_ID,
    now: 100,
  });
  acquireDagActorLease({
    run_id: RUN_ID,
    actor_id: SIBLING_ACTOR_ID,
    target_type: "worker",
    target_id: "worker-2",
    expected_version: dormant.version,
    now: 101,
  });
}

describe("DAG Actor surface patch persistence", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-actor-surface-patch-"));
    process.env.HOMERAIL_HOME = home;
    initializeActor();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("migrates an old database to migration 30 exactly once and validates ownership", () => {
    getDb().exec(`
      DROP TABLE dag_actor_surface_snapshots;
      DROP TABLE dag_actor_surface_views;
      DROP TABLE dag_actor_surface_patch_queue;
      DROP TABLE dag_actor_surface_patch_journal;
      DELETE FROM schema_migrations WHERE version = 30;
    `);
    closeDb();

    const migrated = getDb();
    expectCurrentSchemaMigrationVersion(migrated);
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'dag_actor_surface_%'
      ORDER BY name
    `).all()).toEqual([
      { name: "dag_actor_surface_patch_journal" },
      { name: "dag_actor_surface_patch_queue" },
      { name: "dag_actor_surface_snapshots" },
      { name: "dag_actor_surface_views" },
    ]);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(getDagActor(RUN_ID, ACTOR_ID)).toMatchObject({ node_id: NODE_ID, surface_id: SURFACE_ID });

    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 30").get())
      .toEqual({ count: 1 });
  });

  it("fails closed when the append-only journal trigger is removed", () => {
    getDb().exec("DROP TRIGGER trg_dag_actor_surface_patch_journal_no_update");
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 30 is incomplete: trigger trg_dag_actor_surface_patch_journal_no_update is missing or invalid",
    );
  });

  it("redacts before append, deduplicates exact patch ids, and rejects sequence reuse", () => {
    const withSecret = surfacePatch(1);
    if (withSecret.op !== "replace_body") throw new Error("unexpected patch operation");
    withSecret.body.data = { summary: "Result", api_key: "sk-this-must-not-persist" };
    const first = appendDagActorSurfacePatch(withSecret);
    expect(first).toMatchObject({ inserted: true, deduplicated: false, queue: { status: "pending" } });
    expect(first.journal.patch.op === "replace_body" && first.journal.patch.body.data)
      .toMatchObject({ api_key: "***REDACTED***" });
    expect(appendDagActorSurfacePatch(withSecret)).toMatchObject({ inserted: false, deduplicated: true });

    const changedId = structuredClone(withSecret);
    if (changedId.op !== "replace_body") throw new Error("unexpected patch operation");
    changedId.body.fallback.summary = "Different content";
    expect(() => appendDagActorSurfacePatch(changedId)).toThrowError(
      expect.objectContaining({ code: "patch_id_collision" }),
    );
    expect(() => appendDagActorSurfacePatch(surfacePatch(1, { patch_id: "different-id" }))).toThrowError(
      expect.objectContaining({ code: "sequence_collision" }),
    );
    expect(() => appendDagActorSurfacePatch(surfacePatch(2, { session_id: "sibling-session" }))).toThrowError(
      expect.objectContaining({ code: "session_mismatch" }),
    );
    expect(() => appendDagActorSurfacePatch(surfacePatch(2, { lease_generation: 2 }))).toThrowError(
      expect.objectContaining({ code: "lease_conflict" }),
    );
  });

  it("scopes patch ids to an Actor generation", () => {
    initializeSiblingActor();
    const patchId = "update-1";
    expect(appendDagActorSurfacePatch(surfacePatch(1, { patch_id: patchId })))
      .toMatchObject({ inserted: true, deduplicated: false });
    expect(appendDagActorSurfacePatch(surfacePatch(1, {
      actor_id: SIBLING_ACTOR_ID,
      node_id: SIBLING_NODE_ID,
      session_id: SIBLING_SESSION_ID,
      patch_id: patchId,
    }))).toMatchObject({ inserted: true, deduplicated: false });

    const rows = getDb().prepare(`
      SELECT actor_id, patch_id FROM dag_actor_surface_patch_journal
      WHERE run_id = ? AND generation = 1 AND patch_id = ?
      ORDER BY actor_id
    `).all(RUN_ID, patchId);
    expect(rows).toEqual([
      { actor_id: ACTOR_ID, patch_id: patchId },
      { actor_id: SIBLING_ACTOR_ID, patch_id: patchId },
    ]);
  });

  it("rejects different content under the same patch id in one Actor generation", () => {
    const original = surfacePatch(1, { patch_id: "update-1" });
    appendDagActorSurfacePatch(original);
    const changed = structuredClone(original);
    if (changed.op !== "replace_body") throw new Error("unexpected patch operation");
    changed.body.fallback.summary = "Different content";
    expect(() => appendDagActorSurfacePatch(changed)).toThrowError(
      expect.objectContaining({ code: "patch_id_collision" }),
    );
  });

  it("queues out-of-order patches but only exposes a contiguous Actor sequence", () => {
    appendDagActorSurfacePatch(surfacePatch(2));
    expect(listContiguousPendingDagActorSurfacePatches({
      run_id: RUN_ID,
      actor_id: ACTOR_ID,
      generation: 1,
      after_patch_sequence: 0,
    })).toEqual([]);
    appendDagActorSurfacePatch(surfacePatch(1));
    expect(listContiguousPendingDagActorSurfacePatches({
      run_id: RUN_ID,
      actor_id: ACTOR_ID,
      generation: 1,
      after_patch_sequence: 0,
    }).map((entry) => entry.patch.patch_sequence)).toEqual([1, 2]);
    expect(() => appendDagActorSurfacePatch(surfacePatch(67))).toThrowError(
      expect.objectContaining({ code: "sequence_gap" }),
    );
  });

  it("materializes independent body revisions and snapshots the old generation without mutation", () => {
    persistentGenerativeUiDocumentService.createOrGet({
      documentId: "actor-surface-document",
      scope: { type: "run", id: RUN_ID },
      createdAt: new Date(100).toISOString(),
    });
    const actor = getDagActor(RUN_ID, ACTOR_ID)!;
    expect(ensureDagActorSurfaceView({ actor, document_id: "actor-surface-document", now: 100 }))
      .toMatchObject({ generation: 1, body_revision: 0, visual_revision: 0 });
    const accepted = appendDagActorSurfacePatch(surfacePatch(1));
    const target = listContiguousPendingDagActorSurfacePatches({
      run_id: RUN_ID,
      actor_id: ACTOR_ID,
      generation: 1,
      after_patch_sequence: 0,
    })[0];
    const committed = commitDagActorSurfacePatchApplication({
      target,
      expected_body_revision: 0,
      body: target.patch.op === "replace_body" ? target.patch.body : undefined,
      apply_kind: "patch_components",
      transaction_id: "surface-patch-transaction-1",
      applied_at: accepted.journal.received_at,
    });
    expect(committed).toMatchObject({ body_revision: 1, visual_revision: 1, phase: "started" });
    expect(committed.body?.data).toEqual({ summary: "Result 1" });
    expect(() => getDb().prepare(`
      UPDATE dag_actor_surface_patch_journal SET phase = 'final' WHERE journal_seq = ?
    `).run(accepted.journal.journal_seq)).toThrow(/append-only/);

    const current = getDagActor(RUN_ID, ACTOR_ID)!;
    const next = advanceDagActorGeneration({
      run_id: RUN_ID,
      actor_id: ACTOR_ID,
      expected_generation: current.generation,
      expected_version: current.version,
      session_id: "session-2",
    });
    const reset = ensureDagActorSurfaceView({ actor: next, document_id: "actor-surface-document", now: 200 });
    expect(reset).toMatchObject({ generation: 2, body_revision: 0, visual_revision: 0 });
    expect(reset.body).toBeUndefined();
    expect(listDagActorSurfaceSnapshots({ run_id: RUN_ID, actor_id: ACTOR_ID })).toEqual([
      expect.objectContaining({
        generation: 1,
        superseded_by_generation: 2,
        body_revision: 1,
        body: expect.objectContaining({ data: { summary: "Result 1" } }),
      }),
    ]);
    expect(() => getDb().prepare(`
      UPDATE dag_actor_surface_snapshots SET body_revision = 2
      WHERE run_id = ? AND actor_id = ? AND generation = 1
    `).run(RUN_ID, ACTOR_ID)).toThrow(/append-only/);
    expect(getDagActorSurfaceView(RUN_ID, ACTOR_ID)).toMatchObject({ generation: 2, body_revision: 0 });
  });

  it("uses typed conflicts for stale body revisions", () => {
    persistentGenerativeUiDocumentService.createOrGet({
      documentId: "actor-surface-document",
      scope: { type: "run", id: RUN_ID },
      createdAt: new Date(100).toISOString(),
    });
    ensureDagActorSurfaceView({ actor: getDagActor(RUN_ID, ACTOR_ID)!, document_id: "actor-surface-document" });
    const inserted = appendDagActorSurfacePatch(surfacePatch(1));
    const target = listContiguousPendingDagActorSurfacePatches({
      run_id: RUN_ID,
      actor_id: ACTOR_ID,
      generation: 1,
      after_patch_sequence: 0,
    })[0];
    expect(() => commitDagActorSurfacePatchApplication({
      target,
      expected_body_revision: 1,
      body: target.patch.op === "replace_body" ? target.patch.body : undefined,
      apply_kind: "patch_components",
      transaction_id: "wrong-revision",
      applied_at: inserted.journal.received_at,
    })).toThrowError(DagActorSurfacePatchConflictError);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  HOMERAIL_A2UI_MAX_COMPONENTS,
  type DagActivityEventV1,
} from "homerail-protocol";
import {
  controlDagLiveSurface,
  DagLiveSurfaceProjectionError,
  getDagLiveSurfaceDocument,
  getDagLiveSurfaceProjection,
  isDagLiveSurfaceProjectionNode,
  listDagLiveSurfaceProjections,
  listDagLiveSurfaceQueue,
  projectDagActivityJournalEntry,
  recoverDagLiveSurfaceProjections,
} from "../src/generative-ui/dag-live-surface-projector.js";
import {
  appendDagActivityEvent,
  type DagActivityJournalEntry,
} from "../src/persistence/dag-activity-journal.js";
import {
  advanceDagActorGeneration,
  getDagActor,
  registerDagActor,
} from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { ensureRunDir } from "../src/persistence/store.js";

const BASE_TIME = 1_784_000_000_000;

function register(runId: string, actorId: string, nodeId = actorId, surfaceId = `surface:${actorId}`): void {
  registerDagActor({
    run_id: runId,
    actor_id: actorId,
    node_id: nodeId,
    role: `${actorId} worker`,
    surface_id: surfaceId,
  });
}

function activity(input: {
  run_id: string;
  actor_id: string;
  sequence: number;
  type?: DagActivityEventV1["type"];
  generation?: number;
  node_id?: string;
  surface_id?: string;
  event_id?: string;
  payload?: DagActivityEventV1["payload"];
}): DagActivityEventV1 {
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: input.event_id ?? `${input.run_id}-${input.actor_id}-g${input.generation ?? 1}-s${input.sequence}`,
    run_id: input.run_id,
    round_id: `round-${input.generation ?? 1}`,
    node_id: input.node_id ?? input.actor_id,
    actor_id: input.actor_id,
    generation: input.generation ?? 1,
    surface_id: input.surface_id ?? `surface:${input.actor_id}`,
    sequence: input.sequence,
    timestamp: BASE_TIME + input.sequence,
    type: input.type ?? "progress",
    payload: input.payload ?? { message: `step ${input.sequence}`, progress: input.sequence * 10 },
  };
}

function appendAndProject(event: DagActivityEventV1): ReturnType<typeof projectDagActivityJournalEntry> {
  return projectDagActivityJournalEntry(appendDagActivityEvent(event));
}

function contentData(runId: string, actorId: string): Record<string, unknown> {
  const document = getDagLiveSurfaceDocument(runId);
  const node = document?.nodes.find((candidate) => candidate.id === `surface:${actorId}`);
  return node?.content.data as Record<string, unknown>;
}

describe("DAG Live Surface Projector", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-surface-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("upgrades v20 through v22 once and validates its ownership indexes on restart", () => {
    getDb().exec(`
      DROP TABLE dag_surface_projection_controls;
      DROP TABLE dag_surface_projection_queue;
      DROP TABLE dag_surface_projections;
      DROP INDEX idx_dag_actors_projection_identity;
      DELETE FROM schema_migrations WHERE version IN (21, 22);
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version IN (21, 22) ORDER BY version").all())
      .toEqual([{ version: 21 }, { version: 22 }]);
    expect(migrated.prepare("PRAGMA index_list(dag_actors)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_dag_actors_projection_identity", unique: 1 }),
    ]));
    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (21, 22)").get())
      .toEqual({ count: 2 });
  });

  it("upgrades an existing v21 database with projection identity triggers", () => {
    getDb().exec(`
      DROP TRIGGER trg_dag_surface_projection_queue_journal_identity;
      DROP TRIGGER trg_dag_surface_projection_queue_identity_immutable;
      DELETE FROM schema_migrations WHERE version = 22;
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 22").get())
      .toEqual({ version: 22 });
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_dag_surface_projection_queue_%'
      ORDER BY name
    `).all()).toEqual([
      { name: "trg_dag_surface_projection_queue_identity_immutable" },
      { name: "trg_dag_surface_projection_queue_journal_identity" },
    ]);
  });

  it("fails closed when a v21 marker points at an unbounded transaction index", () => {
    getDb().exec(`
      DROP INDEX idx_dag_surface_projection_queue_transaction_id;
      CREATE UNIQUE INDEX idx_dag_surface_projection_queue_transaction_id
        ON dag_surface_projection_queue(transaction_id);
    `);
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 21 is incomplete: index idx_dag_surface_projection_queue_transaction_id is missing or invalid",
    );
  });

  it("fails closed when the projection queue journal-identity trigger is missing", () => {
    getDb().exec("DROP TRIGGER trg_dag_surface_projection_queue_journal_identity");
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 22 is incomplete: trigger trg_dag_surface_projection_queue_journal_identity is missing or invalid",
    );
  });

  it("fails closed when a projection trigger name is occupied by a no-op definition", () => {
    getDb().exec(`
      DROP TRIGGER trg_dag_surface_projection_queue_journal_identity;
      CREATE TRIGGER trg_dag_surface_projection_queue_journal_identity
        BEFORE INSERT ON dag_surface_projection_queue
        BEGIN
          SELECT COUNT(*) FROM dag_activity_events;
        END;
    `);
    closeDb();
    expect(() => getDb()).toThrow(
      "Schema migration 22 is incomplete: trigger trg_dag_surface_projection_queue_journal_identity is missing or invalid",
    );
  });

  it("projects three actors into three stable native A2UI blocks without cross-over", () => {
    const runId = "three-actors";
    ensureRunDir(runId);
    for (const actorId of ["research", "build", "verify"]) register(runId, actorId);

    for (const actorId of ["research", "build", "verify"]) {
      appendAndProject(activity({
        run_id: runId,
        actor_id: actorId,
        sequence: 1,
        type: "started",
        payload: { message: `${actorId} started` },
      }));
    }

    const document = getDagLiveSurfaceDocument(runId)!;
    expect(document.revision).toBe(3);
    expect(document.nodes.map((node) => node.id).sort()).toEqual([
      "surface:build",
      "surface:research",
      "surface:verify",
    ]);
    expect(document.nodes.every((node) => node.kind === "com.homerail.core/generated_view" && node.kind_version === 2))
      .toBe(true);
    expect(document.nodes.every((node) => node.a2ui?.catalogId === "https://homerail.dev/a2ui/catalogs/core/v1"))
      .toBe(true);
    expect(listDagLiveSurfaceProjections(runId)).toMatchObject([
      { actor_id: "build", surface_id: "surface:build", surface_revision: 1 },
      { actor_id: "research", surface_id: "surface:research", surface_revision: 1 },
      { actor_id: "verify", surface_id: "surface:verify", surface_revision: 1 },
    ]);

    appendAndProject(activity({ run_id: runId, actor_id: "research", sequence: 2, payload: { message: "source found" } }));
    const updated = getDagLiveSurfaceDocument(runId)!;
    expect(updated.revision).toBe(4);
    expect(updated.nodes.find((node) => node.id === "surface:research")?.revision).toBe(2);
    expect(updated.nodes.find((node) => node.id === "surface:build")?.revision).toBe(1);
    expect(contentData(runId, "research")).toMatchObject({
      actor: { id: "research", node_id: "research" },
      state: { summary: "source found", sequence: 2 },
    });
  });

  it("queues out-of-order activity, deduplicates replay, and rejects late generations", () => {
    const runId = "ordered-events";
    ensureRunDir(runId);
    register(runId, "worker");

    const second = appendDagActivityEvent(activity({ run_id: runId, actor_id: "worker", sequence: 2 }));
    expect(projectDagActivityJournalEntry(second)).toMatchObject({ applied_count: 0 });
    expect(getDagLiveSurfaceDocument(runId)).toMatchObject({ revision: 0, nodes: [] });
    expect(listDagLiveSurfaceQueue({ run_id: runId })).toMatchObject([{ status: "pending", activity_sequence: 2 }]);

    const first = appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      type: "started",
    }));
    expect(projectDagActivityJournalEntry(first)).toMatchObject({ applied_count: 2 });
    expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({
      last_activity_sequence: 2,
      surface_revision: 2,
    });
    expect(projectDagActivityJournalEntry(first)).toMatchObject({ inserted: false, applied_count: 0 });
    expect(getDagLiveSurfaceDocument(runId)?.revision).toBe(2);

    const actor = getDagActor(runId, "worker")!;
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: "worker",
      expected_generation: actor.generation,
      expected_version: actor.version,
    });
    const late = appendDagActivityEvent(activity({ run_id: runId, actor_id: "worker", sequence: 3, generation: 1 }));
    expect(projectDagActivityJournalEntry(late)).toMatchObject({ queue: { status: "stale" }, applied_count: 0 });
    expect(getDagLiveSurfaceDocument(runId)?.revision).toBe(2);

    const generationTwoSecond = appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 2,
      generation: 2,
    }));
    expect(projectDagActivityJournalEntry(generationTwoSecond).applied_count).toBe(0);
    const generationTwoFirst = appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      generation: 2,
      type: "started",
    }));
    expect(projectDagActivityJournalEntry(generationTwoFirst).applied_count).toBe(2);
    expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({
      generation: 2,
      last_activity_sequence: 2,
      surface_revision: 4,
    });
  });

  it("fails closed when an actor event claims another node or surface", () => {
    const runId = "ownership";
    ensureRunDir(runId);
    register(runId, "alpha");
    register(runId, "beta");
    const spoofed = appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "alpha",
      node_id: "beta",
      surface_id: "surface:beta",
      sequence: 1,
    }));
    expect(() => projectDagActivityJournalEntry(spoofed)).toThrowError(
      expect.objectContaining<DagLiveSurfaceProjectionError>({ code: "identity_mismatch" }),
    );
    expect(listDagLiveSurfaceProjections(runId)).toEqual([]);
    expect(listDagLiveSurfaceQueue({ run_id: runId })).toEqual([]);
  });

  it("binds every projection queue row to the exact immutable journal identity", () => {
    const runId = "queue-identity";
    ensureRunDir(runId);
    register(runId, "alpha");
    register(runId, "beta");
    const entry = appendDagActivityEvent(activity({ run_id: runId, actor_id: "alpha", sequence: 1 }));
    const insert = getDb().prepare(`
      INSERT INTO dag_surface_projection_queue(
        journal_seq, event_id, run_id, actor_id, node_id, surface_id,
        generation, activity_sequence, status, transaction_id,
        surface_revision, queued_at, applied_at, failure_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, NULL)
    `);

    expect(() => insert.run(
      entry.seq,
      entry.event.event_id,
      runId,
      "beta",
      "beta",
      "surface:beta",
      1,
      1,
      entry.received_at,
    )).toThrow("projection queue journal identity mismatch");

    insert.run(
      entry.seq,
      entry.event.event_id,
      runId,
      "alpha",
      "alpha",
      "surface:alpha",
      1,
      1,
      entry.received_at,
    );
    expect(() => getDb().prepare(`
      UPDATE dag_surface_projection_queue SET actor_id = 'beta' WHERE journal_seq = ?
    `).run(entry.seq)).toThrow("projection queue identity is immutable");
  });

  it("commits the A2UI transaction and queue cursor atomically", () => {
    const runId = "atomic-commit";
    ensureRunDir(runId);
    register(runId, "worker");
    const entry = appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      type: "started",
    }));
    getDb().exec(`
      CREATE TRIGGER reject_live_surface_queue_commit
      BEFORE UPDATE OF status ON dag_surface_projection_queue
      WHEN OLD.status = 'pending' AND NEW.status = 'applied'
      BEGIN
        SELECT RAISE(ABORT, 'forced projector bookkeeping failure');
      END
    `);

    expect(() => projectDagActivityJournalEntry(entry)).toThrow("forced projector bookkeeping failure");
    expect(getDagLiveSurfaceDocument(runId)).toMatchObject({ revision: 0, nodes: [] });
    expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({ surface_revision: 0 });
    expect(listDagLiveSurfaceQueue({ run_id: runId })).toMatchObject([{ status: "pending" }]);

    getDb().exec("DROP TRIGGER reject_live_surface_queue_commit");
    expect(projectDagActivityJournalEntry(entry)).toMatchObject({ inserted: false, applied_count: 1 });
    expect(getDagLiveSurfaceDocument(runId)).toMatchObject({ revision: 1, nodes: [{ id: "surface:worker" }] });
  });

  it("replays a crash-pending journal into the same document on every restart", () => {
    const runId = "restart-replay";
    ensureRunDir(runId);
    register(runId, "worker");
    appendDagActivityEvent(activity({ run_id: runId, actor_id: "worker", sequence: 1, type: "started" }));
    appendDagActivityEvent(activity({ run_id: runId, actor_id: "worker", sequence: 2, type: "completed" }));
    closeDb();

    expect(recoverDagLiveSurfaceProjections(runId)).toMatchObject({ projected_events: 2, failed: [] });
    const firstSnapshot = JSON.stringify(getDagLiveSurfaceDocument(runId));
    const firstTransactions = getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get();
    closeDb();

    expect(recoverDagLiveSurfaceProjections(runId)).toMatchObject({ projected_events: 0, failed: [] });
    expect(JSON.stringify(getDagLiveSurfaceDocument(runId))).toBe(firstSnapshot);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM generative_ui_transactions").get())
      .toEqual(firstTransactions);
    expect(recoverDagLiveSurfaceProjections()).toEqual({ runs: [], projected_events: 0, failed: [] });
  });

  it("ignores legacy journal rows without a registered logical actor during startup recovery", () => {
    const runId = "legacy-journal-only";
    ensureRunDir(runId);
    appendDagActivityEvent(activity({ run_id: runId, actor_id: "worker", sequence: 1 }));
    closeDb();

    expect(recoverDagLiveSurfaceProjections()).toEqual({ runs: [], projected_events: 0, failed: [] });
    expect(listDagLiveSurfaceQueue({ run_id: runId })).toEqual([]);
  });

  it("continues recovery after a poison row so later valid actor activity is not starved", () => {
    const runId = "poison-then-valid";
    ensureRunDir(runId);
    register(runId, "worker");
    appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      generation: 2,
      event_id: "future-generation",
    }));
    appendDagActivityEvent(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      generation: 1,
      event_id: "current-generation",
      type: "started",
    }));
    closeDb();

    expect(recoverDagLiveSurfaceProjections()).toMatchObject({
      runs: [runId],
      projected_events: 1,
      failed: [{ run_id: runId, event_id: "future-generation" }],
    });
    expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({
      generation: 1,
      last_activity_sequence: 1,
      surface_revision: 1,
    });
  });

  it("uses a fixed bounded A2UI catalog while retaining only recent findings", () => {
    const runId = "bounded-payload";
    ensureRunDir(runId);
    register(runId, "worker");
    appendAndProject(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      type: "started",
      payload: {
        message: "started",
        components: Array.from({ length: 200 }, (_, index) => ({ id: `untrusted-${index}` })),
      },
    }));
    const largeText = "汉🚀\u0000".repeat(700);
    for (let sequence = 2; sequence <= 13; sequence += 1) {
      appendAndProject(activity({
        run_id: runId,
        actor_id: "worker",
        sequence,
        type: "finding",
        payload: { title: `Finding ${sequence} ${largeText}`, detail: largeText },
      }));
    }

    expect(appendAndProject(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 14,
      type: "progress",
      payload: { message: "continued after large findings", progress: 75 },
    }))).toMatchObject({ applied_count: 1, queue: { status: "applied" } });

    const document = getDagLiveSurfaceDocument(runId)!;
    const node = document.nodes[0]!;
    expect(node.a2ui?.components.length).toBeLessThanOrEqual(HOMERAIL_A2UI_MAX_COMPONENTS);
    expect(node.a2ui?.components.map((component) => component.id)).not.toContain("untrusted-1");
    expect((node.content.data as { findings: unknown[] }).findings).toHaveLength(8);
    expect(JSON.stringify(node.content)).not.toContain("untrusted-199");
    expect(Buffer.byteLength(JSON.stringify(node.content), "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(listDagLiveSurfaceQueue({ run_id: runId }).every((entry) => entry.status === "applied")).toBe(true);
  });

  it("accepts a trusted control immediately after an actor generation advances", () => {
    const runId = "generation-control";
    ensureRunDir(runId);
    register(runId, "worker");
    appendAndProject(activity({ run_id: runId, actor_id: "worker", sequence: 1, type: "started" }));
    expect(appendAndProject(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 3,
      payload: { message: "old generation gap" },
    }))).toMatchObject({ applied_count: 0, queue: { status: "pending" } });
    const actor = getDagActor(runId, "worker")!;
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: "worker",
      expected_generation: actor.generation,
      expected_version: actor.version,
    });

    expect(controlDagLiveSurface({
      control_id: "generation-two-focus",
      run_id: runId,
      actor_id: "worker",
      operation: "focused",
      expected_surface_revision: 1,
      created_at: 0,
    })).toMatchObject({
      projection: { generation: 2, surface_revision: 2, visibility_state: "focused" },
    });
    expect(contentData(runId, "worker")).toMatchObject({
      actor: { id: "worker", generation: 2 },
      state: { surface_revision: 2, visibility: "focused" },
    });
    expect(listDagLiveSurfaceQueue({ run_id: runId })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activity_sequence: 3,
        status: "stale",
        applied_at: expect.any(Number),
        queued_at: expect.any(Number),
      }),
    ]));
    const stale = listDagLiveSurfaceQueue({ run_id: runId })
      .find((entry) => entry.activity_sequence === 3)!;
    expect(stale.applied_at).toBeGreaterThanOrEqual(stale.queued_at);
  });

  it("keeps a valid surface visible across a non-visual generation transition", () => {
    const runId = "non-visual-generation";
    ensureRunDir(runId);
    register(runId, "worker");
    appendAndProject(activity({ run_id: runId, actor_id: "worker", sequence: 1, type: "started" }));
    const actor = getDagActor(runId, "worker")!;
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: "worker",
      expected_generation: actor.generation,
      expected_version: actor.version,
    });
    expect(appendAndProject(activity({
      run_id: runId,
      actor_id: "worker",
      sequence: 1,
      generation: 2,
      type: "tool_used",
      payload: { tool: "search" },
    }))).toMatchObject({ applied_count: 1, queue: { status: "applied" } });

    const projection = getDagLiveSurfaceProjection(runId, "worker")!;
    const node = getDagLiveSurfaceDocument(runId)!.nodes[0]!;
    expect(projection).toMatchObject({ generation: 2, visibility_state: "visible" });
    expect(contentData(runId, "worker")).toMatchObject({ actor: { generation: 1 } });
    expect(isDagLiveSurfaceProjectionNode(node, projection)).toBe(true);
  });

  it("focuses and removes a surface through revision-checked idempotent controls", () => {
    const runId = "surface-controls";
    ensureRunDir(runId);
    getDb().transaction(() => {
      register(runId, "worker");
      appendAndProject(activity({ run_id: runId, actor_id: "worker", sequence: 1, type: "started" }));

      const focus = controlDagLiveSurface({
        control_id: "focus-1",
        run_id: runId,
        actor_id: "worker",
        operation: "focused",
        expected_surface_revision: 1,
        focused_until: BASE_TIME + 10_000,
        created_at: BASE_TIME + 100,
      });
      expect(focus).toMatchObject({ deduplicated: false, projection: { surface_revision: 2, visibility_state: "focused" } });
      expect(getDagLiveSurfaceDocument(runId)?.nodes[0]).toMatchObject({ importance: "critical", revision: 2 });
      expect(controlDagLiveSurface({
        control_id: "focus-1",
        run_id: runId,
        actor_id: "worker",
        operation: "focused",
        expected_surface_revision: 1,
        focused_until: BASE_TIME + 10_000,
        created_at: BASE_TIME + 999,
      })).toMatchObject({ deduplicated: true, projection: { surface_revision: 2 } });
      expect(() => controlDagLiveSurface({
        control_id: "stale-focus",
        run_id: runId,
        actor_id: "worker",
        operation: "focused",
        expected_surface_revision: 1,
      })).toThrowError(expect.objectContaining<DagLiveSurfaceProjectionError>({ code: "surface_revision_conflict" }));

      expect(controlDagLiveSurface({
        control_id: "remove-1",
        run_id: runId,
        actor_id: "worker",
        operation: "removed",
        expected_surface_revision: 2,
        created_at: BASE_TIME + 200,
      })).toMatchObject({ projection: { surface_revision: 3, visibility_state: "removed" } });
      expect(getDagLiveSurfaceDocument(runId)?.nodes).toEqual([]);

      expect(appendAndProject(activity({
        run_id: runId,
        actor_id: "worker",
        sequence: 2,
        payload: { message: "late progress after removal", progress: 50 },
      }))).toMatchObject({ applied_count: 1 });
      expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({
        activity_state: "progress",
        last_activity_sequence: 2,
        surface_revision: 3,
        visibility_state: "removed",
      });
      expect(getDagLiveSurfaceDocument(runId)?.nodes).toEqual([]);
    }).immediate();

    closeDb();
    expect(recoverDagLiveSurfaceProjections(runId)).toMatchObject({ projected_events: 0, failed: [] });
    expect(getDagLiveSurfaceProjection(runId, "worker")).toMatchObject({
      last_activity_sequence: 2,
      surface_revision: 3,
      visibility_state: "removed",
    });
    expect(getDagLiveSurfaceDocument(runId)?.nodes).toEqual([]);
  });
});

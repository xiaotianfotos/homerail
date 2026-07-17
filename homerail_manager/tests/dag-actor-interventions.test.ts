import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeDagActorIntervention,
  createDagActorIntervention,
  createDagSurfaceGenerationSnapshot,
  DagActorInterventionConflictError,
  failDagActorIntervention,
  getDagActorIntervention,
  listDagActorInterventions,
  listDagSurfaceGenerationSnapshots,
  markDagActorInterventionApplying,
} from "../src/persistence/dag-actor-interventions.js";
import { registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { ensureRunDir } from "../src/persistence/store.js";

describe("DAG actor intervention persistence", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-interventions-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-1");
    registerDagActor({
      run_id: "run-1",
      actor_id: "research",
      node_id: "research-node",
      role: "research",
      surface_id: "surface:research",
    });
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("creates and validates the strict intervention and dispatch-fence schemas on fresh and upgraded databases", () => {
    expect(getDb().prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 30 });
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    getDb().exec(`
      DROP TABLE dag_actor_dispatch_exclusions;
      DELETE FROM schema_migrations WHERE version = 27;
    `);
    closeDb();
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toEqual({ version: 27 });
    expect(getDb().prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dag_actor_dispatch_exclusions'
    `).get()).toEqual({ name: "dag_actor_dispatch_exclusions" });
    getDb().exec(`
      DROP TABLE dag_actor_dispatch_exclusions;
      DROP TABLE dag_surface_generation_snapshots;
      DROP TABLE dag_actor_interventions;
      DELETE FROM schema_migrations WHERE version IN (26, 27);
    `);
    closeDb();
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 26").get()).toEqual({ version: 26 });
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toEqual({ version: 27 });
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 26").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 28").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 29").get())
      .toEqual({ count: 1 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 30").get())
      .toEqual({ count: 1 });
  });

  it("reconciles the shifted pre-merge migration 27-29 chain without losing persisted data", () => {
    getDb().prepare(`
      INSERT INTO dag_run_skill_contexts(
        run_id, agent_id, context_version, context_digest, total_bytes,
        skill_count, context_json, created_at
      ) VALUES (?, ?, 1, ?, 0, 0, '{}', ?)
    `).run("run-1", "legacy-agent", "a".repeat(64), 100);
    getDb().exec(`
      DROP TABLE dag_actor_dispatch_exclusions;
      DELETE FROM schema_migrations WHERE version IN (27, 28, 29, 30);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (27, 'legacy-live-commands'),
        (28, 'legacy-skill-context'),
        (29, 'legacy-surface-patches');
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare(
      "SELECT version FROM schema_migrations WHERE version >= 27 ORDER BY version",
    ).all()).toEqual([
      { version: 27 },
      { version: 28 },
      { version: 29 },
      { version: 30 },
    ]);
    expect(migrated.prepare(`
      SELECT agent_id, context_json FROM dag_run_skill_contexts
      WHERE run_id = ? AND agent_id = ?
    `).get("run-1", "legacy-agent")).toEqual({
      agent_id: "legacy-agent",
      context_json: "{}",
    });
    expect(migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'dag_actor_dispatch_exclusions'
    `).get()).toEqual({ name: "dag_actor_dispatch_exclusions" });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("persists the Inbox before applying, deduplicates retries, and enforces Actor CAS", () => {
    const request = {
      intervention_id: "intervention-1",
      run_id: "run-1",
      actor_id: "research",
      operation: "retry" as const,
      instruction: "Retry with token=secret-value",
      expected_actor_generation: 1,
      expected_actor_version: 1,
      idempotency_key: "retry-1",
      created_at: 100,
    };
    const created = createDagActorIntervention(request);
    expect(created).toMatchObject({ changed: true, deduplicated: false, intervention: { status: "queued" } });
    expect(JSON.stringify(getDagActorIntervention("intervention-1"))).not.toContain("secret-value");
    expect(createDagActorIntervention(request)).toMatchObject({ changed: false, deduplicated: true });
    expect(() => createDagActorIntervention({ ...request, intervention_id: "other", instruction: "different" }))
      .toThrowError(expect.objectContaining<DagActorInterventionConflictError>({ code: "intervention_identity_conflict" }));
    expect(() => createDagActorIntervention({
      ...request,
      intervention_id: "intervention-2",
      idempotency_key: "retry-2",
    })).toThrowError(expect.objectContaining<DagActorInterventionConflictError>({ code: "intervention_in_progress" }));
  });

  it("enforces transition order and retains applied audit plus immutable Surface history", () => {
    createDagActorIntervention({
      intervention_id: "intervention-1",
      run_id: "run-1",
      actor_id: "research",
      operation: "checkpoint_fork",
      instruction: "Continue from the selected checkpoint",
      expected_actor_generation: 1,
      expected_actor_version: 1,
      idempotency_key: "fork-1",
      checkpoint_version: 3,
      created_at: 100,
    });
    markDagActorInterventionApplying({ intervention_id: "intervention-1", from_generation: 1, started_at: 110 });
    createDagSurfaceGenerationSnapshot({
      run_id: "run-1",
      actor_id: "research",
      generation: 1,
      node_id: "research-node",
      surface_id: "surface:research",
      document_id: "document-1",
      node_revision: 2,
      document_revision: 4,
      surface_revision: 2,
      activity_state: "finding",
      visibility_state: "visible",
      last_event_id: "event-1",
      node_snapshot: { content: { api_key: "sk-private", summary: "old result" } },
      superseded_by_generation: 2,
      intervention_id: "intervention-1",
      created_at: 115,
    });
    const completed = completeDagActorIntervention({
      intervention_id: "intervention-1",
      from_generation: 1,
      to_generation: 2,
      resulting_actor_version: 2,
      completed_at: 120,
    });
    expect(completed.intervention).toMatchObject({ status: "applied", from_generation: 1, to_generation: 2 });
    const history = listDagSurfaceGenerationSnapshots({ run_id: "run-1", actor_id: "research" });
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("sk-private");
    expect(() => getDb().prepare(`
      UPDATE dag_surface_generation_snapshots SET surface_revision = 9
      WHERE run_id = 'run-1' AND actor_id = 'research' AND generation = 1
    `).run()).toThrow(/append-only/);
    expect(listDagActorInterventions({ run_id: "run-1", actor_id: "research" })).toHaveLength(1);
  });

  it("records bounded failures without opening a second active intervention", () => {
    createDagActorIntervention({
      intervention_id: "intervention-fail",
      run_id: "run-1",
      actor_id: "research",
      operation: "interrupt",
      expected_actor_generation: 1,
      expected_actor_version: 1,
      idempotency_key: "interrupt-1",
      created_at: 100,
    });
    const failed = failDagActorIntervention({
      intervention_id: "intervention-fail",
      failure: { message: "transport failed", api_key: "sk-private" },
      completed_at: 120,
    });
    expect(failed.intervention.status).toBe("failed");
    expect(JSON.stringify(failed.intervention)).not.toContain("sk-private");
    expect(() => completeDagActorIntervention({
      intervention_id: "intervention-fail",
      from_generation: 1,
      to_generation: 2,
      resulting_actor_version: 2,
    })).toThrowError(expect.objectContaining<DagActorInterventionConflictError>({ code: "intervention_status_conflict" }));
  });

  it("requires checkpoint_version only for checkpoint_fork", () => {
    expect(() => createDagActorIntervention({
      intervention_id: "invalid-retry",
      run_id: "run-1",
      actor_id: "research",
      operation: "retry",
      expected_actor_generation: 1,
      expected_actor_version: 1,
      idempotency_key: "invalid-retry",
      checkpoint_version: 1,
    })).toThrow("checkpoint_version is required only for checkpoint_fork");
    expect(() => createDagActorIntervention({
      intervention_id: "invalid-fork",
      run_id: "run-1",
      actor_id: "research",
      operation: "checkpoint_fork",
      expected_actor_generation: 1,
      expected_actor_version: 1,
      idempotency_key: "invalid-fork",
    })).toThrow("checkpoint_version is required only for checkpoint_fork");
  });
});

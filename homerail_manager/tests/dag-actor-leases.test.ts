import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireDagActorLease,
  assessDagActorLease,
  DagActorLeaseConflictError,
  deleteExpiredDagActorRuntime,
  ensureDagActorLease,
  getDagActorCheckpoint,
  getDagActorLease,
  getLatestDagActorCheckpoint,
  listDagProvisionedWorkers,
  listExpiredDagActorLeases,
  registerDagProvisionedWorker,
  releaseDagActorLease,
  renewDagActorLease,
  retireDagActorLease,
  setDagActorLeasePinned,
  transitionDagProvisionedWorker,
  type DagActorCheckpointV1,
  writeDagActorCheckpoint,
} from "../src/persistence/dag-actor-leases.js";
import { getDagActor, registerDagActor } from "../src/persistence/dag-actors.js";
import { clearTables, closeDb, getDb } from "../src/persistence/db.js";
import { ensureRunDir } from "../src/persistence/store.js";
import { expectCurrentSchemaMigrationVersion } from "./schema-migration-helpers.js";

function checkpoint(overrides: Partial<DagActorCheckpointV1> = {}): DagActorCheckpointV1 {
  return {
    schema_version: 1,
    objective: "Continue the durable research objective",
    confirmed_conclusions: ["The primary source confirms the first conclusion"],
    unresolved_items: ["Verify the second claim"],
    key_event_refs: ["event-2", "event-1"],
    artifact_refs: ["report:artifact-1"],
    workspace_ref: "workspace://run-1",
    surface_binding: "surface-researcher",
    context_summary: "Bounded provider-neutral context",
    round_id: "round-1",
    actor_generation: 1,
    captured_at: 90,
    ...overrides,
  };
}

function registerActor(
  actorId = "researcher",
  nodeId = actorId,
  surfaceId = `surface-${actorId}`,
): void {
  registerDagActor({
    run_id: "run-1",
    actor_id: actorId,
    node_id: nodeId,
    role: "research",
    surface_id: surfaceId,
  });
}

describe("DAG actor lease persistence", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-actor-leases-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-1");
    registerActor();
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reads an exact portable checkpoint version without changing the latest pointer", () => {
    const first = writeDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher", checkpoint: checkpoint(), now: 100 });
    const second = writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint({ captured_at: 110, context_summary: "Second checkpoint" }),
      expected_checkpoint_version: 1,
      now: 120,
    });

    expect(getDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher", checkpoint_version: 1 }))
      .toEqual(first);
    expect(getLatestDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher" }))
      .toEqual(second);
    expect(getDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher", checkpoint_version: 99 }))
      .toBeUndefined();
  });

  it("creates and revalidates the strict actor lease schema on a fresh database", () => {
    const db = getDb();
    expectCurrentSchemaMigrationVersion(db);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'dag_actor_runtimes', 'dag_actor_checkpoints', 'dag_actor_provisioned_workers'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "dag_actor_checkpoints" },
      { name: "dag_actor_provisioned_workers" },
      { name: "dag_actor_runtimes" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare(`
      INSERT INTO dag_actor_runtimes(
        run_id, actor_id, state, lease_generation, target_type, target_id,
        idle_deadline, pinned, retained_until, state_changed_at, created_at, updated_at
      ) VALUES ('run-1', 'researcher', 'dormant', 0, 'worker', 'worker-1', NULL, 0, 100, 0, 0, 0)
    `).run()).toThrow(/CHECK constraint failed/);

    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24").get())
      .toEqual({ count: 1 });
  });

  it("migrates a v23 database idempotently without changing existing actors", () => {
    const actorBefore = getDagActor("run-1", "researcher");
    const db = getDb();
    db.exec(`
      DROP TABLE dag_actor_provisioned_workers;
      DROP TABLE dag_actor_checkpoints;
      DROP TABLE dag_actor_runtimes;
      DELETE FROM schema_migrations WHERE version = 24;
    `);
    closeDb();

    const migrated = getDb();
    expect(migrated.prepare("SELECT version FROM schema_migrations WHERE version = 24").get())
      .toEqual({ version: 24 });
    expect(getDagActor("run-1", "researcher")).toEqual(actorBefore);
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.prepare("PRAGMA index_list(dag_actor_runtimes)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_actor_runtimes_expired", unique: 0, partial: 1 }),
        expect.objectContaining({ name: "idx_dag_actor_runtimes_retention", unique: 0, partial: 1 }),
      ]));
    expect(migrated.prepare("PRAGMA index_list(dag_actor_provisioned_workers)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_dag_actor_provisioned_workers_container", unique: 1 }),
        expect.objectContaining({ name: "idx_dag_actor_provisioned_workers_current", unique: 1, partial: 1 }),
      ]));

    closeDb();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24").get())
      .toEqual({ count: 1 });
  });

  it("fails closed when a v24 partial uniqueness index is weakened", () => {
    getDb().exec(`
      DROP INDEX idx_dag_actor_provisioned_workers_current;
      CREATE INDEX idx_dag_actor_provisioned_workers_current
        ON dag_actor_provisioned_workers(run_id, actor_id, lease_generation);
    `);
    closeDb();

    expect(() => getDb()).toThrow(
      "Schema migration 24 is incomplete: index idx_dag_actor_provisioned_workers_current is missing or invalid",
    );
  });

  it("acquires, renews, rebinds, releases, and fences stale physical generations", () => {
    const dormant = ensureDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      retention_ttl_ms: 1_000,
      now: 100,
    });
    expect(dormant).toMatchObject({ state: "dormant", lease_generation: 0, version: 1 });

    const acquired = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-1",
      expected_version: dormant.version,
      idle_ttl_ms: 100,
      retention_ttl_ms: 1_000,
      now: 200,
    });
    expect(acquired).toMatchObject({
      state: "leased",
      lease_generation: 1,
      target_id: "worker-1",
      idle_deadline: 300,
      version: 2,
    });

    const sameTarget = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-1",
      expected_version: acquired.version,
      idle_ttl_ms: 200,
      retention_ttl_ms: 1_000,
      now: 250,
    });
    expect(sameTarget).toMatchObject({ lease_generation: 1, idle_deadline: 450, version: 3 });

    const renewed = renewDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "provisioned_worker",
      target_id: "worker-1",
      expected_version: sameTarget.version,
      idle_ttl_ms: 300,
      now: 300,
    });
    expect(renewed).toMatchObject({ lease_generation: 1, idle_deadline: 600, version: 4 });

    const rebound = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-2",
      expected_version: renewed.version,
      idle_ttl_ms: 100,
      retention_ttl_ms: 1_000,
      now: 400,
    });
    expect(rebound).toMatchObject({ lease_generation: 2, target_id: "worker-2", version: 5 });
    expect(assessDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "provisioned_worker",
      target_id: "worker-1",
      now: 450,
    })).toMatchObject({ current: false, reason: "generation_mismatch" });
    expect(assessDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 2,
      target_type: "provisioned_worker",
      target_id: "worker-2",
      now: 450,
    })).toMatchObject({ current: true });

    const released = releaseDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 2,
      target_type: "provisioned_worker",
      target_id: "worker-2",
      expected_version: rebound.version,
      retention_ttl_ms: 1_000,
      now: 500,
    });
    expect(released).toMatchObject({
      state: "dormant",
      lease_generation: 2,
      retained_until: 1_500,
      version: 6,
    });
    expect(released).not.toHaveProperty("target_id");
    expect(assessDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 2,
      target_type: "provisioned_worker",
      target_id: "worker-2",
      now: 500,
    })).toMatchObject({ current: false, reason: "not_leased" });
    expect(() => renewDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 2,
      target_type: "provisioned_worker",
      target_id: "worker-2",
      now: 600,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({ code: "lease_state_conflict" }));

    expect(acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-3",
      expected_version: released.version,
      idle_ttl_ms: 100,
      retention_ttl_ms: 1_000,
      now: 600,
    })).toMatchObject({ lease_generation: 3, target_id: "worker-3" });
  });

  it("exempts pinned leases from idle expiry and resets retention when unpinned", () => {
    const acquired = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "worker",
      target_id: "worker-1",
      idle_ttl_ms: 100,
      retention_ttl_ms: 1_000,
      now: 100,
    });
    const pinned = setDagActorLeasePinned({
      run_id: "run-1",
      actor_id: "researcher",
      pinned: true,
      expected_version: acquired.version,
      retention_ttl_ms: 1_000,
      now: 150,
    });
    expect(listExpiredDagActorLeases({ now: 300 })).toEqual([]);
    expect(assessDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "worker",
      target_id: "worker-1",
      now: 300,
    })).toMatchObject({ current: true });

    const unpinned = setDagActorLeasePinned({
      run_id: "run-1",
      actor_id: "researcher",
      pinned: false,
      expected_version: pinned.version,
      retention_ttl_ms: 1_000,
      now: 300,
    });
    expect(listExpiredDagActorLeases({ now: 300 }).map((lease) => lease.actor_id))
      .toEqual(["researcher"]);
    expect(() => renewDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "worker",
      target_id: "worker-1",
      expected_version: unpinned.version,
      idle_ttl_ms: 100,
      now: 300,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({ code: "lease_expired" }));

    const dormant = releaseDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "worker",
      target_id: "worker-1",
      expected_version: unpinned.version,
      retention_ttl_ms: 100,
      now: 300,
    });
    const dormantPinned = setDagActorLeasePinned({
      run_id: "run-1",
      actor_id: "researcher",
      pinned: true,
      expected_version: dormant.version,
      retention_ttl_ms: 100,
      now: 350,
    });
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "researcher", now: 1_000 }))
      .toMatchObject({ deleted: false, reason: "pinned" });
    const dormantUnpinned = setDagActorLeasePinned({
      run_id: "run-1",
      actor_id: "researcher",
      pinned: false,
      expected_version: dormantPinned.version,
      retention_ttl_ms: 100,
      now: 1_000,
    });
    expect(dormantUnpinned.retained_until).toBe(1_100);
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "researcher", now: 1_099 }))
      .toMatchObject({ deleted: false, reason: "retained" });
  });

  it("writes append-only canonical checkpoints with monotonic versions and integrity checks", () => {
    const first = writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint(),
      expected_checkpoint_version: 0,
      now: 100,
    });
    expect(first).toMatchObject({ checkpoint_version: 1, created_at: 100 });
    expect(first.checkpoint_sha256).toMatch(/^[0-9a-f]{64}$/);
    const raw = getDb().prepare(`
      SELECT checkpoint_json FROM dag_actor_checkpoints
      WHERE run_id = 'run-1' AND actor_id = 'researcher' AND checkpoint_version = 1
    `).get() as { checkpoint_json: string };
    expect(raw.checkpoint_json).toBe(JSON.stringify({
      actor_generation: 1,
      artifact_refs: ["report:artifact-1"],
      captured_at: 90,
      confirmed_conclusions: ["The primary source confirms the first conclusion"],
      context_summary: "Bounded provider-neutral context",
      key_event_refs: ["event-2", "event-1"],
      objective: "Continue the durable research objective",
      round_id: "round-1",
      schema_version: 1,
      surface_binding: "surface-researcher",
      unresolved_items: ["Verify the second claim"],
      workspace_ref: "workspace://run-1",
    }));

    const second = writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint({ captured_at: 190, context_summary: "Second durable snapshot" }),
      expected_checkpoint_version: 1,
      now: 200,
    });
    expect(second.checkpoint_version).toBe(2);
    expect(getLatestDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher" }))
      .toEqual(second);
    expect(() => writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint({ captured_at: 200 }),
      expected_checkpoint_version: 1,
      now: 200,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({ code: "checkpoint_version_conflict" }));
    expect(() => writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint({ actor_generation: 2 }),
      now: 200,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({ code: "checkpoint_generation_conflict" }));
    expect(() => getDb().prepare(`
      UPDATE dag_actor_checkpoints SET checkpoint_json = '{}' WHERE checkpoint_version = 2
    `).run()).toThrow(/append-only/);

    getDb().exec("DROP TRIGGER trg_dag_actor_checkpoints_no_update");
    getDb().prepare(`
      UPDATE dag_actor_checkpoints SET checkpoint_sha256 = ? WHERE checkpoint_version = 2
    `).run("0".repeat(64));
    expect(() => getLatestDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher" }))
      .toThrow(/failed integrity validation/);
  });

  it("deletes only retention-expired dormant or retired actors and their checkpoints", () => {
    registerActor("leased", "leased-node");
    registerActor("pinned", "pinned-node");
    registerActor("retired", "retired-node");

    writeDagActorCheckpoint({
      run_id: "run-1",
      actor_id: "researcher",
      checkpoint: checkpoint(),
      now: 100,
    });
    const dormantLease = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "worker",
      target_id: "worker-researcher",
      idle_ttl_ms: 1_000,
      retention_ttl_ms: 100,
      now: 100,
    });
    releaseDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: dormantLease.lease_generation,
      target_type: "worker",
      target_id: "worker-researcher",
      expected_version: dormantLease.version,
      retention_ttl_ms: 100,
      now: 200,
    });

    acquireDagActorLease({
      run_id: "run-1",
      actor_id: "leased",
      target_type: "worker",
      target_id: "worker-leased",
      idle_ttl_ms: 1_000,
      retention_ttl_ms: 100,
      now: 100,
    });
    ensureDagActorLease({
      run_id: "run-1",
      actor_id: "pinned",
      pinned: true,
      retention_ttl_ms: 100,
      now: 100,
    });
    const retiring = ensureDagActorLease({
      run_id: "run-1",
      actor_id: "retired",
      retention_ttl_ms: 100,
      now: 100,
    });
    retireDagActorLease({
      run_id: "run-1",
      actor_id: "retired",
      expected_version: retiring.version,
      retention_ttl_ms: 100,
      now: 200,
    });

    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "researcher", now: 299 }))
      .toMatchObject({ deleted: false, reason: "retained" });
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "researcher", now: 300 }))
      .toEqual({ deleted: true, deleted_checkpoints: 1 });
    expect(getDagActor("run-1", "researcher")).toBeUndefined();
    expect(getLatestDagActorCheckpoint({ run_id: "run-1", actor_id: "researcher" })).toBeUndefined();
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "leased", now: 10_000 }))
      .toMatchObject({ deleted: false, reason: "leased" });
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "pinned", now: 10_000 }))
      .toMatchObject({ deleted: false, reason: "pinned" });
    expect(deleteExpiredDagActorRuntime({ run_id: "run-1", actor_id: "retired", now: 300 }))
      .toEqual({ deleted: true, deleted_checkpoints: 0 });
    expect(getDagActor("run-1", "retired")).toBeUndefined();
  });

  it("persists provisioned ownership through restart and enforces lifecycle transitions", () => {
    const lease = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-1",
      idle_ttl_ms: 2_000,
      retention_ttl_ms: 1_000,
      now: 100,
    });
    const active = registerDagProvisionedWorker({
      run_id: "run-1",
      node_id: "researcher",
      actor_id: "researcher",
      lease_generation: lease.lease_generation,
      worker_id: "worker-1",
      container_id: "container-1",
      docker_node_id: "docker-node-1",
      now: 200,
    });
    expect(active).toMatchObject({ status: "active", version: 1, registered_at: 200 });
    expect(registerDagProvisionedWorker({
      run_id: "run-1",
      node_id: "researcher",
      actor_id: "researcher",
      lease_generation: lease.lease_generation,
      worker_id: "worker-1",
      container_id: "container-1",
      docker_node_id: "docker-node-1",
      now: 250,
    })).toEqual(active);

    closeDb();
    expect(listDagProvisionedWorkers({ statuses: ["active"] })).toEqual([active]);
    const releasing = transitionDagProvisionedWorker({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      expected_status: "active",
      status: "releasing",
      expected_version: 1,
      now: 300,
    });
    expect(releasing).toMatchObject({ status: "releasing", release_requested_at: 300, version: 2 });
    const failed = transitionDagProvisionedWorker({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      expected_status: "releasing",
      status: "failed",
      expected_version: releasing.version,
      failure: { message: "remove failed", authorization: "Bearer secret-token-value" },
      now: 400,
    });
    expect(failed).toMatchObject({
      status: "failed",
      terminal_at: 400,
      failure: { message: "remove failed", authorization: "***REDACTED***" },
      version: 3,
    });
    const retried = transitionDagProvisionedWorker({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      expected_status: "failed",
      status: "releasing",
      expected_version: failed.version,
      now: 500,
    });
    expect(retried).toMatchObject({ status: "releasing", release_requested_at: 500, version: 4 });
    expect(retried).not.toHaveProperty("failure");
    const released = transitionDagProvisionedWorker({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      expected_status: "releasing",
      status: "released",
      expected_version: retried.version,
      now: 600,
    });
    expect(released).toMatchObject({ status: "released", terminal_at: 600, version: 5 });
    expect(() => transitionDagProvisionedWorker({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      expected_status: "released",
      status: "active",
      now: 700,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({
      code: "provisioned_worker_status_conflict",
    }));

    const currentLease = getDagActorLease({ run_id: "run-1", actor_id: "researcher" })!;
    const dormant = releaseDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      lease_generation: 1,
      target_type: "provisioned_worker",
      target_id: "worker-1",
      expected_version: currentLease.version,
      retention_ttl_ms: 1_000,
      now: 700,
    });
    const rebound = acquireDagActorLease({
      run_id: "run-1",
      actor_id: "researcher",
      target_type: "provisioned_worker",
      target_id: "worker-1",
      expected_version: dormant.version,
      idle_ttl_ms: 2_000,
      retention_ttl_ms: 1_000,
      now: 800,
    });
    expect(rebound.lease_generation).toBe(2);
    expect(() => registerDagProvisionedWorker({
      run_id: "run-1",
      node_id: "researcher",
      actor_id: "researcher",
      lease_generation: 1,
      worker_id: "worker-1",
      container_id: "container-stale",
      docker_node_id: "docker-node-1",
      now: 900,
    })).toThrowError(expect.objectContaining<DagActorLeaseConflictError>({ code: "lease_generation_conflict" }));
    expect(registerDagProvisionedWorker({
      run_id: "run-1",
      node_id: "researcher",
      actor_id: "researcher",
      lease_generation: 2,
      worker_id: "worker-1",
      container_id: "container-2",
      docker_node_id: "docker-node-1",
      now: 900,
    })).toMatchObject({ lease_generation: 2, status: "active" });
    expect(listDagProvisionedWorkers({ run_id: "run-1", actor_id: "researcher" }))
      .toHaveLength(2);

    clearTables([
      "dag_actor_provisioned_workers",
      "dag_actor_checkpoints",
      "dag_actor_runtimes",
    ]);
    expect(listDagProvisionedWorkers()).toEqual([]);
  });
});

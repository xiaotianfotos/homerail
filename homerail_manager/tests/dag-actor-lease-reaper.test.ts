import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireDagActorLease,
  getDagActorLease,
  getLatestDagActorCheckpoint,
  listDagProvisionedWorkers,
  registerDagProvisionedWorker,
  releaseDagActorLease,
  retireDagActorLease,
  setDagActorLeasePinned,
  writeDagActorCheckpoint,
} from "../src/persistence/dag-actor-leases.js";
import { getDagActor, registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb } from "../src/persistence/db.js";
import { ensureRunDir, loadRunMetadata, writeRunMetadata } from "../src/persistence/store.js";
import { reapDagActorLeases } from "../src/runtime/dag-actor-lease-reaper.js";

describe("DAG actor lease reaper", () => {
  let home: string;
  let oldHome: string | undefined;
  let oldIdleTtl: string | undefined;
  let now: number;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    oldIdleTtl = process.env.HOMERAIL_DAG_WORKER_IDLE_TTL_MS;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-lease-reaper-"));
    process.env.HOMERAIL_HOME = home;
    now = Date.now();
    ensureRunDir("run-reaper");
    registerDagActor({
      run_id: "run-reaper",
      actor_id: "actor-1",
      node_id: "node-1",
      role: "research",
      surface_id: "surface-1",
    });
  });

  afterEach(() => {
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldIdleTtl === undefined) delete process.env.HOMERAIL_DAG_WORKER_IDLE_TTL_MS;
    else process.env.HOMERAIL_DAG_WORKER_IDLE_TTL_MS = oldIdleTtl;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function setRunStatus(status: "active" | "waiting" | "completed" | "failed" | "cancelled"): void {
    const metadata = loadRunMetadata("run-reaper")!;
    writeRunMetadata("run-reaper", {
      ...metadata,
      status,
      ...(status === "active" || status === "waiting" ? {} : { completedAt: now }),
    });
  }

  function acquireWorker(workerId = "worker-1"): ReturnType<typeof acquireDagActorLease> {
    const lease = acquireDagActorLease({
      run_id: "run-reaper",
      actor_id: "actor-1",
      target_type: "worker",
      target_id: workerId,
      idle_ttl_ms: 10,
      retention_ttl_ms: 20,
      now,
    });
    registerDagProvisionedWorker({
      run_id: "run-reaper",
      actor_id: "actor-1",
      node_id: "node-1",
      lease_generation: lease.lease_generation,
      worker_id: workerId,
      container_id: `container-${workerId}`,
      docker_node_id: "docker-node-1",
      now,
    });
    return lease;
  }

  it("releases an idle waiting actor before deprovisioning its worker", async () => {
    setRunStatus("waiting");
    acquireWorker();
    const seen: string[] = [];
    const report = await reapDagActorLeases({
      now: now + 10,
      deprovisionFn: async () => {
        const lease = getDagActorLease({ run_id: "run-reaper", actor_id: "actor-1" });
        seen.push(lease?.state ?? "missing");
        return { stopped: true, removed: true, dockerCleanupVerified: true };
      },
    });

    expect(report).toMatchObject({ released: 1, worker_cleanup_attempted: 1, worker_cleanup_failed: 0 });
    expect(seen).toEqual(["dormant"]);
    expect(getDagActorLease({ run_id: "run-reaper", actor_id: "actor-1" })).toMatchObject({
      state: "dormant",
      lease_generation: 1,
    });
  });

  it("renews an active long-running lease before it spends its hot TTL", async () => {
    acquireWorker();
    process.env.HOMERAIL_DAG_WORKER_IDLE_TTL_MS = "10";
    expect((await reapDagActorLeases({ now: now + 5 })).renewed).toBe(1);
    expect(getDagActorLease({ run_id: "run-reaper", actor_id: "actor-1" })).toMatchObject({
      state: "leased",
      idle_deadline: now + 15,
    });
  });

  it("reclaims an active provisioned worker detached from the current lease generation", async () => {
    acquireWorker("worker-1");
    acquireWorker("worker-2");
    const removed: string[] = [];

    const report = await reapDagActorLeases({
      now: now + 2,
      deprovisionFn: async (_dockerNodeId, containerId) => {
        removed.push(containerId);
        return { stopped: true, removed: true, dockerCleanupVerified: true };
      },
    });

    expect(report).toMatchObject({ worker_cleanup_attempted: 1, worker_cleanup_failed: 0 });
    expect(removed).toEqual(["container-worker-1"]);
    expect(listDagProvisionedWorkers({ run_id: "run-reaper" })).toEqual([
      expect.objectContaining({ worker_id: "worker-1", status: "released" }),
      expect.objectContaining({ worker_id: "worker-2", status: "active" }),
    ]);
  });

  it("reclaims an active provisioned worker left behind after terminal lease retirement", async () => {
    setRunStatus("completed");
    const lease = acquireWorker();
    retireDagActorLease({
      run_id: "run-reaper",
      actor_id: "actor-1",
      lease_generation: lease.lease_generation,
      target_type: lease.target_type!,
      target_id: lease.target_id!,
      expected_version: lease.version,
      now: now + 1,
    });

    const report = await reapDagActorLeases({
      now: now + 2,
      deprovisionFn: async () => ({ stopped: true, removed: true, dockerCleanupVerified: true }),
    });

    expect(report).toMatchObject({ worker_cleanup_attempted: 1, worker_cleanup_failed: 0 });
    expect(listDagProvisionedWorkers({ run_id: "run-reaper" })[0]).toMatchObject({ status: "released" });
  });

  it("respects explicit pins while a waiting actor is otherwise idle-expired", async () => {
    acquireWorker();
    setRunStatus("waiting");
    const leased = getDagActorLease({ run_id: "run-reaper", actor_id: "actor-1" })!;
    setDagActorLeasePinned({
      run_id: "run-reaper",
      actor_id: "actor-1",
      pinned: true,
      expected_version: leased.version,
      now: now + 1,
    });
    expect((await reapDagActorLeases({ now: now + 10 })).released).toBe(0);
    expect(getDagActorLease({ run_id: "run-reaper", actor_id: "actor-1" })?.state).toBe("leased");
  });

  it("deletes only terminal, retention-expired dormant runtime and checkpoints", async () => {
    setRunStatus("completed");
    const lease = acquireDagActorLease({
      run_id: "run-reaper",
      actor_id: "actor-1",
      target_type: "worker",
      target_id: "worker-1",
      idle_ttl_ms: 100,
      retention_ttl_ms: 10,
      now,
    });
    writeDagActorCheckpoint({
      run_id: "run-reaper",
      actor_id: "actor-1",
      now: now + 1,
      checkpoint: {
        schema_version: 1,
        objective: "Retain this actor until the terminal retention window expires",
        confirmed_conclusions: [],
        unresolved_items: [],
        key_event_refs: [],
        artifact_refs: [],
        surface_binding: "surface-1",
        context_summary: "Checkpoint retained until actor retention expiry.",
        round_id: "round-1",
        actor_generation: 1,
        captured_at: now + 1,
      },
    });
    releaseDagActorLease({
      run_id: "run-reaper",
      actor_id: "actor-1",
      lease_generation: lease.lease_generation,
      target_type: "worker",
      target_id: "worker-1",
      expected_version: lease.version,
      retention_ttl_ms: 10,
      now: now + 1,
    });

    expect((await reapDagActorLeases({ now: now + 10 })).runtimes_deleted).toBe(0);
    expect(getLatestDagActorCheckpoint({ run_id: "run-reaper", actor_id: "actor-1" })).toBeDefined();
    expect((await reapDagActorLeases({ now: now + 11 })).runtimes_deleted).toBe(1);
    expect(getDagActor("run-reaper", "actor-1")).toBeUndefined();
    expect(getLatestDagActorCheckpoint({ run_id: "run-reaper", actor_id: "actor-1" })).toBeUndefined();
  });
});

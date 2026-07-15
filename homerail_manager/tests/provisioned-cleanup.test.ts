import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearListeners, subscribe } from "../src/events/bus.js";
import {
  _clearAllProvisionedWorkers,
  deprovisionProvisionedWorker,
  deprovisionProvisionedForRun,
  listProvisionedForRun,
  registerProvisionedWorker,
} from "../src/orchestration/provisioned-cleanup.js";
import {
  acquireDagActorLease,
  listDagProvisionedWorkers,
} from "../src/persistence/dag-actor-leases.js";
import { registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb } from "../src/persistence/db.js";
import { ensureRunDir, loadRunMetadata, writeRunMetadata } from "../src/persistence/store.js";

describe("provisioned worker cleanup", () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-provisioned-cleanup-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-cleanup");
    registerDagActor({
      run_id: "run-cleanup",
      actor_id: "coder-actor",
      node_id: "coder",
      role: "coding",
      surface_id: "surface-coder",
    });
  });

  afterEach(() => {
    _clearAllProvisionedWorkers();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function registerWorker(workerId = "worker-1") {
    const lease = acquireDagActorLease({
      run_id: "run-cleanup",
      actor_id: "coder-actor",
      target_type: "provisioned_worker",
      target_id: workerId,
      idle_ttl_ms: 60_000,
      retention_ttl_ms: 60_000,
    });
    return registerProvisionedWorker({
      runId: "run-cleanup",
      nodeId: "coder",
      actorId: "coder-actor",
      leaseGeneration: lease.lease_generation,
      workerId,
      containerId: `container-${workerId}`,
      dockerNodeId: "docker-node-1",
    });
  }

  it("keeps a failed durable cleanup row and retries it after a cold restart", async () => {
    registerWorker();
    const failed = new Promise<Record<string, unknown>>((resolve) => {
      subscribe("dag:cleanup_failed", (payload) => resolve(payload as Record<string, unknown>));
    });

    expect(deprovisionProvisionedForRun("run-cleanup", {
      deprovisionFn: async () => { throw new Error("docker unavailable"); },
    })).toBe(true);
    await expect(failed).resolves.toMatchObject({ runId: "run-cleanup", workerId: "worker-1" });
    expect(listDagProvisionedWorkers({ run_id: "run-cleanup" })[0]).toMatchObject({
      status: "failed",
      failure: { message: "docker unavailable" },
    });

    closeDb();
    expect(listProvisionedForRun("run-cleanup")).toHaveLength(1);
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      subscribe("dag:cleanup_completed", (payload) => resolve(payload as Record<string, unknown>));
    });
    expect(deprovisionProvisionedForRun("run-cleanup", {
      deprovisionFn: async () => ({ stopped: true, removed: true, dockerCleanupVerified: true }),
    })).toBe(true);
    await expect(completed).resolves.toMatchObject({
      runId: "run-cleanup",
      workerId: "worker-1",
      stopped: true,
      removed: true,
    });
    expect(listDagProvisionedWorkers({ run_id: "run-cleanup" })[0]).toMatchObject({ status: "released" });
  });

  it("does not mark a worker released unless physical removal is confirmed", async () => {
    const entry = registerWorker();

    await expect(deprovisionProvisionedWorker(entry, {
      deprovisionFn: async () => ({ stopped: false, removed: false, dockerCleanupVerified: false }),
    })).resolves.toBe(false);
    expect(listDagProvisionedWorkers({ run_id: "run-cleanup" })[0]).toMatchObject({
      status: "failed",
      failure: {
        message: expect.stringContaining("did not confirm container removal"),
      },
    });

    await expect(deprovisionProvisionedWorker(entry, {
      deprovisionFn: async () => ({ stopped: true, removed: true, dockerCleanupVerified: true }),
    })).resolves.toBe(true);
    expect(listDagProvisionedWorkers({ run_id: "run-cleanup" })[0]).toMatchObject({ status: "released" });
  });

  it("uses durable ownership for cancelled and terminal run cleanup", async () => {
    registerWorker();
    const metadata = loadRunMetadata("run-cleanup")!;
    writeRunMetadata("run-cleanup", { ...metadata, status: "cancelled", completedAt: Date.now() });
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      subscribe("dag:cleanup_completed", (payload) => resolve(payload as Record<string, unknown>));
    });

    expect(deprovisionProvisionedForRun("run-cleanup", {
      deprovisionFn: async () => ({ stopped: true, removed: true, dockerCleanupVerified: true }),
    })).toBe(true);
    await completed;
    expect(listProvisionedForRun("run-cleanup")[0]).toMatchObject({
      actorId: "coder-actor",
      leaseGeneration: 1,
    });
    expect(listDagProvisionedWorkers({ run_id: "run-cleanup" })[0].status).toBe("released");
  });
});

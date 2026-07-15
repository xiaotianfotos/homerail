import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb } from "../src/persistence/db.js";
import {
  _clearAllProvisionedWorkers,
  registerProvisionedWorker,
} from "../src/orchestration/provisioned-cleanup.js";
import { loadRunMetadata, writeRunMetadata } from "../src/persistence/store.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import {
  DEFAULT_WORKSPACE_RETENTION_SETTINGS,
  loadWorkspaceRetentionSettings,
  saveWorkspaceRetentionSettings,
} from "../src/persistence/workspace-retention-settings.js";
import {
  _clearActiveRuns,
  completeActiveRun,
  createActiveRun,
} from "../src/runtime/active-runs.js";
import {
  cleanupRunWorkspaces,
  resolveWorkspaceRetentionPolicy,
  runWorkspacePath,
  setRunWorkspacePinned,
} from "../src/runtime/workspace-retention.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { requiresDagMutationAuthorization } from "../src/server/mutations.js";
import { createServer } from "../src/server/http.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("workspace retention", () => {
  let oldHome: string | undefined;
  let oldMutationToken: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-retention-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllProvisionedWorkers();
  });

  afterEach(() => {
    closeDb();
    _clearActiveRuns();
    _clearAllProvisionedWorkers();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = oldMutationToken;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function addRun(
    runId: string,
    status: "active" | "completed" | "failed" | "cancelled",
    completedAt?: number,
  ): string {
    writeRunMetadata(runId, {
      runId,
      createdAt: completedAt ? completedAt - DAY_MS : Date.now(),
      completedAt,
      status,
      nodeStates: {},
      handoffedNodes: [],
    });
    const workspace = runWorkspacePath(runId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "artifact.txt"), runId);
    return workspace;
  }

  it("defaults successful and failed runs to seven days and persists UI settings", () => {
    expect(loadWorkspaceRetentionSettings({})).toEqual(DEFAULT_WORKSPACE_RETENTION_SETTINGS);
    expect(resolveWorkspaceRetentionPolicy({})).toMatchObject({
      enabled: true,
      successMs: 7 * DAY_MS,
      failureMs: 7 * DAY_MS,
    });

    saveWorkspaceRetentionSettings({ enabled: false, success_days: 14, failure_days: 21 });
    expect(loadWorkspaceRetentionSettings({})).toEqual({
      enabled: false,
      success_days: 14,
      failure_days: 21,
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(tmpHome, "manager", "workspace-retention.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("previews and then removes only expired, terminal, unpinned workspaces", async () => {
    const now = Date.now();
    const expiredSuccess = addRun("success-old", "completed", now - 8 * DAY_MS);
    const expiredFailure = addRun("failure-old", "failed", now - 8 * DAY_MS);
    const recent = addRun("success-recent", "completed", now - 6 * DAY_MS);
    const active = addRun("active-run", "active");
    const pinned = addRun("failed-pinned", "failed", now - 20 * DAY_MS);
    setRunWorkspacePinned("failed-pinned", true);

    const preview = await cleanupRunWorkspaces({ dryRun: true, now });
    expect(preview.eligible).toBe(2);
    expect(preview.removed).toBe(0);
    expect(fs.existsSync(expiredSuccess)).toBe(true);
    expect(fs.existsSync(expiredFailure)).toBe(true);

    const report = await cleanupRunWorkspaces({ dryRun: false, now });
    expect(report.removed).toBe(2);
    expect(report.failed).toBe(0);
    expect(fs.existsSync(expiredSuccess)).toBe(false);
    expect(fs.existsSync(expiredFailure)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(pinned)).toBe(true);
    expect(loadRunMetadata("success-old")?.workspaceRetention?.cleanedAt).toEqual(expect.any(Number));
  }, 15_000);

  it("unlinks an expired workspace symlink without touching its target", async () => {
    const now = Date.now();
    writeRunMetadata("linked-run", {
      runId: "linked-run",
      createdAt: now - 10 * DAY_MS,
      completedAt: now - 8 * DAY_MS,
      status: "cancelled",
      nodeStates: {},
      handoffedNodes: [],
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-retention-outside-"));
    const outsideFile = path.join(outside, "keep.txt");
    fs.writeFileSync(outsideFile, "keep");
    const link = runWorkspacePath("linked-run");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    try {
      const report = await cleanupRunWorkspaces({ dryRun: false, now });
      expect(report.removed).toBe(1);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects workspace paths that escape through an intermediate symlink", async () => {
    const now = Date.now();
    writeRunMetadata("linked-parent/run", {
      runId: "linked-parent/run",
      createdAt: now - 10 * DAY_MS,
      completedAt: now - 8 * DAY_MS,
      status: "completed",
      nodeStates: {},
      handoffedNodes: [],
    });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-retention-parent-outside-"));
    const outsideRun = path.join(outside, "run");
    fs.mkdirSync(outsideRun);
    const outsideFile = path.join(outsideRun, "keep.txt");
    fs.writeFileSync(outsideFile, "keep");
    const link = path.dirname(runWorkspacePath("linked-parent/run"));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    try {
      const report = await cleanupRunWorkspaces({ dryRun: false, now });
      expect(report.removed).toBe(0);
      expect(report.items.find((item) => item.run_id === "linked-parent/run")?.reason)
        .toContain("Unsafe resolved run workspace path");
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("keep");
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows manual cleanup while automatic cleanup is disabled", async () => {
    const now = Date.now();
    const workspace = addRun("manual-cleanup", "completed", now - 8 * DAY_MS);
    const policy = {
      ...resolveWorkspaceRetentionPolicy({}),
      enabled: false,
    };

    const report = await cleanupRunWorkspaces({ dryRun: false, now, policy });

    expect(report.removed).toBe(1);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("cleans terminal runs that remain in the in-memory run store", async () => {
    const runId = "completed-in-process";
    const run = createActiveRun(runId, parseDAGYaml(`
name: retention-completed-in-process
agents:
  worker:
    agent_type: deterministic
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`));
    completeActiveRun(runId);
    const workspace = runWorkspacePath(runId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "artifact.txt"), runId);

    const report = await cleanupRunWorkspaces({
      dryRun: false,
      now: (run.completedAt ?? Date.now()) + 8 * DAY_MS,
    });

    expect(report.removed).toBe(1);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("protects a truly active in-memory run even if persisted metadata appears terminal", async () => {
    const now = Date.now();
    const runId = "active-in-process";
    createActiveRun(runId, parseDAGYaml(`
name: retention-active-in-process
agents:
  worker:
    agent_type: deterministic
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`));
    const persisted = loadRunMetadata(runId);
    if (!persisted) throw new Error("active run metadata was not persisted");
    writeRunMetadata(runId, {
      ...persisted,
      status: "completed",
      completedAt: now - 8 * DAY_MS,
    });
    const workspace = runWorkspacePath(runId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "artifact.txt"), runId);

    const report = await cleanupRunWorkspaces({ dryRun: false, now });

    expect(report.removed).toBe(0);
    expect(report.items.find((item) => item.run_id === runId)?.reason)
      .toBe("run_active_in_memory");
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it("protects workspaces while provisioned worker cleanup is pending", async () => {
    const now = Date.now();
    const runId = "worker-cleanup-pending";
    createActiveRun(runId, parseDAGYaml(`
name: retention-worker-cleanup-pending
agents:
  worker: { agent_type: deterministic }
nodes:
  worker-node:
    agent: worker
    outputs:
      done: { to: "" }
`));
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: "worker-node",
      target_type: "worker",
      target_id: "worker-1",
    });
    _clearActiveRuns();
    const workspace = addRun(runId, "completed", now - 8 * DAY_MS);
    registerProvisionedWorker({
      runId,
      nodeId: "worker-node",
      actorId: "worker-node",
      leaseGeneration: lease.lease_generation,
      workerId: "worker-1",
      containerId: "container-1",
      dockerNodeId: "docker-node-1",
    });

    const report = await cleanupRunWorkspaces({ dryRun: false, now });

    expect(report.removed).toBe(0);
    expect(report.items.find((item) => item.run_id === runId)?.reason)
      .toBe("worker_cleanup_pending");
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it("serializes deletion against pinning and competing cleanup", async () => {
    const now = Date.now();
    const workspace = addRun("cleanup-race", "completed", now - 8 * DAY_MS);
    let releaseRemoval!: () => void;
    const removalReleased = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => { removalStarted = resolve; });

    const firstCleanup = cleanupRunWorkspaces({
      dryRun: false,
      now,
      _removeWorkspace: async (target) => {
        removalStarted();
        await removalReleased;
        await fs.promises.rm(target, { recursive: true, force: true });
      },
    });
    await started;

    try {
      expect(() => setRunWorkspacePinned("cleanup-race", true)).toThrow("cleanup is in progress");
      const competing = await cleanupRunWorkspaces({ dryRun: false, now });
      expect(competing.items.find((item) => item.run_id === "cleanup-race")?.reason)
        .toBe("workspace_cleanup_inflight");
    } finally {
      releaseRemoval();
    }
    const completed = await firstCleanup;
    expect(completed.removed).toBe(1);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("never removes the reserved default workspace", async () => {
    const now = Date.now();
    const workspace = addRun("default", "completed", now - 30 * DAY_MS);

    const report = await cleanupRunWorkspaces({ dryRun: false, now });

    expect(report.removed).toBe(0);
    expect(report.items.find((item) => item.run_id === "default")?.reason).toBe("reserved_default_workspace");
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it("rejects run workspace paths that escape the managed root", () => {
    expect(() => runWorkspacePath("../../outside")).toThrow("Unsafe run workspace path");
  });

  it("protects retention mutations with the control-plane authorization boundary", () => {
    expect(requiresDagMutationAuthorization("/api/settings/workspace-retention", "POST")).toBe(true);
    expect(requiresDagMutationAuthorization("/api/dag/workspaces/cleanup", "POST")).toBe(true);
    expect(requiresDagMutationAuthorization("/api/runs/run-1/workspace-retention", "POST")).toBe(true);
  });

  it("rejects non-numeric retention values at the persisted API boundary", () => {
    expect(() => saveWorkspaceRetentionSettings({
      enabled: true,
      success_days: "7",
      failure_days: 7,
    })).toThrow("success_days must be an integer");
  });

  it("persists settings and defaults cleanup to dry-run through the HTTP API", async () => {
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "retention-secret";
    const server = createServer(0, undefined, undefined, false);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      "Content-Type": "application/json",
      "x-homerail-dag-token": "retention-secret",
    };

    try {
      const unauthorized = await fetch(`${baseUrl}/api/settings/workspace-retention`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, success_days: 9, failure_days: 11 }),
      });
      expect(unauthorized.status).toBe(403);

      const update = await fetch(`${baseUrl}/api/settings/workspace-retention`, {
        method: "POST",
        headers,
        body: JSON.stringify({ enabled: true, success_days: 9, failure_days: 11 }),
      });
      expect(update.status).toBe(200);

      const info = await fetch(`${baseUrl}/api/settings/storage-info`);
      expect(await info.json()).toMatchObject({
        success: true,
        data: {
          cleanup_supported: true,
          workspace_retention: { enabled: true, success_days: 9, failure_days: 11 },
        },
      });

      const cleanup = await fetch(`${baseUrl}/api/dag/workspaces/cleanup`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(await cleanup.json()).toMatchObject({
        success: true,
        data: { dry_run: true, removed: 0 },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

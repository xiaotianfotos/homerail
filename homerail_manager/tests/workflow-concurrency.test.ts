import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  deriveWorkflowConcurrencyPolicy,
  releaseWorkflowRunReservation,
  reserveWorkflowRun,
} from "../src/persistence/dag-run-admission.js";
import { upsertDagWorkflowFromYaml } from "../src/persistence/dag-workflows.js";
import { _clearActiveRuns, getActiveRun } from "../src/runtime/active-runs.js";
import { fireDagEventTrigger, startDagTriggerScheduler } from "../src/runtime/dag-triggers.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function workflow(id: string, triggers: string): string {
  const triggerBlock = triggers.trim()
    ? `  triggers:\n${triggers.replace(/^/gm, "    ")}\n`
    : "";
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: ${id}, name: ${id} }
spec:
${triggerBlock}  agents: {}
  nodes:
    prepare:
      kind: command
      outputs: { proposed: {}, failed: {} }
      config:
        command: [node, -e, "console.log(JSON.stringify({change:'ship'}))"]
        timeout_ms: 5000
        parse_stdout: json
        success_port: proposed
        failure_port: failed
    review:
      kind: approval
      inputs: { proposal: {} }
      outputs: { approved: {}, rejected: {} }
      config:
        approval_id: concurrency-check
        proposer_actor: agent:prepare
        authorized_actors: [owner]
        approved_port: approved
        rejected_port: rejected
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    rejected: { kind: terminal, outcome: failure, inputs: { result: {} } }
    failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: prepare.proposed, to: review.proposal }
    - { from: prepare.failed, to: failed.result, condition: on_failure }
    - { from: review.approved, to: done.result }
    - { from: review.rejected, to: rejected.result, condition: on_failure }
`;
}

describe("workflow-level run admission", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldAllowlist: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-concurrency-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    closeDb();
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllowlist;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("derives the strictest policy across every enabled trigger", () => {
    expect(deriveWorkflowConcurrencyPolicy({
      push: { overlap: "allow", max_concurrency: 4, enabled: true },
      timer: { overlap: "skip", max_concurrency: 2, enabled: true },
      disabled: { overlap: "skip", max_concurrency: 1, enabled: false },
    })).toEqual({
      overlap: "skip",
      max_concurrency: 2,
      trigger_ids: ["push", "timer"],
    });
    expect(deriveWorkflowConcurrencyPolicy(undefined)).toBeUndefined();
  });

  it("serializes reservations before a dag_runs row exists", () => {
    const policy = { overlap: "allow", max_concurrency: 1, trigger_ids: ["push"] } as const;
    expect(reserveWorkflowRun({
      runId: "reserved-1",
      workflowId: "reserved-workflow",
      source: "test:first",
      policy,
    })).toMatchObject({ reserved: true });
    expect(() => reserveWorkflowRun({
      runId: "reserved-2",
      workflowId: "reserved-workflow",
      source: "test:second",
      policy,
    })).toThrowError(expect.objectContaining({ reason: "max_concurrency" }));
    releaseWorkflowRunReservation("reserved-1");
    expect(reserveWorkflowRun({
      runId: "reserved-2",
      workflowId: "reserved-workflow",
      source: "test:second",
      policy,
    })).toMatchObject({ reserved: true });
  });

  it("cleans a crash-window reservation as soon as its run row exists", () => {
    const policy = { overlap: "allow", max_concurrency: 1, trigger_ids: ["push"] } as const;
    reserveWorkflowRun({
      runId: "crash-window-run",
      workflowId: "restart-workflow",
      source: "test:before-crash",
      policy,
    });
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO dag_runs(run_id, status, created_at, updated_at, workflow_id, metadata)
      VALUES (?, 'active', ?, ?, ?, '{}')
    `).run("crash-window-run", now, now, "restart-workflow");

    expect(() => reserveWorkflowRun({
      runId: "competing-run",
      workflowId: "restart-workflow",
      source: "test:while-active",
      policy,
    })).toThrowError(expect.objectContaining({ reason: "max_concurrency" }));
    expect(getDb().prepare(
      "SELECT COUNT(*) AS count FROM dag_run_admissions WHERE run_id = ?",
    ).get("crash-window-run")).toEqual({ count: 0 });

    getDb().prepare("UPDATE dag_runs SET status = 'completed', updated_at = ? WHERE run_id = ?")
      .run(Date.now(), "crash-window-run");
    expect(reserveWorkflowRun({
      runId: "after-restart-run",
      workflowId: "restart-workflow",
      source: "test:after-terminal",
      policy,
    })).toMatchObject({ reserved: true });
  });

  it("expires orphaned reservations that never created a run row", () => {
    const policy = { overlap: "allow", max_concurrency: 1, trigger_ids: ["push"] } as const;
    reserveWorkflowRun({
      runId: "orphaned-reservation",
      workflowId: "orphaned-workflow",
      source: "test:orphaned",
      policy,
    });
    getDb().prepare("UPDATE dag_run_admissions SET created_at = 0 WHERE run_id = ?")
      .run("orphaned-reservation");

    expect(reserveWorkflowRun({
      runId: "replacement-run",
      workflowId: "orphaned-workflow",
      source: "test:replacement",
      policy,
    })).toMatchObject({ reserved: true });
  });

  it("applies one concurrency limit across different triggers and manual runs", () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflow("shared-admission", `
push:
  type: event
  event: repo.push
  overlap: allow
  max_concurrency: 3
timer:
  type: event
  event: schedule.tick
  overlap: allow
  max_concurrency: 1
`) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const stop = startDagTriggerScheduler(orchestrator, 60_000);
    try {
      const first = fireDagEventTrigger("repo.push", "sha-1", { ref: "main" })[0];
      expect(first).toMatchObject({ dispatched: true });
      expect(getActiveRun(first.run_id!)?.status).toBe("active");
      expect(fireDagEventTrigger("schedule.tick", "tick-1", {})[0]).toMatchObject({
        dispatched: false,
        reason: "max_concurrency",
      });
      expect(() => orchestrator.createRun({
        workflowId: "shared-admission",
        runId: "manual-competing-run",
      })).toThrowError(expect.objectContaining({ reason: "max_concurrency" }));
    } finally {
      stop();
    }
  });

  it("makes a skip policy global even when another trigger allows overlap", () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflow("strict-admission", `
push:
  type: event
  event: repo.push
  overlap: allow
  max_concurrency: 4
release:
  type: event
  event: release.ready
  overlap: skip
  max_concurrency: 4
`) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const stop = startDagTriggerScheduler(orchestrator, 60_000);
    try {
      expect(fireDagEventTrigger("repo.push", "sha-1", {})[0]).toMatchObject({ dispatched: true });
      expect(fireDagEventTrigger("release.ready", "release-1", {})[0]).toMatchObject({
        dispatched: false,
        reason: "overlap_policy",
      });
    } finally {
      stop();
    }
  });

  it("records the admission schema migration without restricting workflows that have no triggers", () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflow("unrestricted", "") });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));

    expect(orchestrator.createRun({ workflowId: "unrestricted", runId: "manual-1" }).status).toBe("active");
    expect(orchestrator.createRun({ workflowId: "unrestricted", runId: "manual-2" }).status).toBe("active");
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 5").get()).toEqual({ version: 5 });
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toEqual({ version: 6 });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_run_admissions").get()).toEqual({ count: 0 });
  });

  it("adds the admission table when opening a legacy database", () => {
    closeDb();
    const managerDir = path.join(tmpHome, "manager");
    fs.mkdirSync(managerDir, { recursive: true });
    const legacy = new Database(path.join(managerDir, "homerail.db"));
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 'legacy');
      CREATE TABLE dag_runs(run_id TEXT PRIMARY KEY, status TEXT, created_at INTEGER, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL);
    `);
    legacy.close();

    const db = getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dag_run_admissions'").get())
      .toEqual({ name: "dag_run_admissions" });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 5").get()).toEqual({ version: 5 });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toEqual({ version: 6 });
  });

  it("enforces the same admission policy through event and manual HTTP entrypoints", async () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflow("http-admission", `
push:
  type: event
  event: repo.push
  overlap: allow
  max_concurrency: 2
timer:
  type: event
  event: schedule.tick
  overlap: allow
  max_concurrency: 1
`) });
    const server = createServer(0, undefined, undefined, false);
    const baseUrl = `http://127.0.0.1:${await listen(server)}`;
    const headers = { "Content-Type": "application/json" };
    try {
      const firstResponse = await fetch(`${baseUrl}/api/dag/triggers/events/repo.push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotency_key: "sha-http-1", payload: { ref: "main" } }),
      });
      const first = await firstResponse.json() as { data: { deliveries: Array<{ dispatched: boolean }> } };
      expect(firstResponse.status).toBe(200);
      expect(first.data.deliveries[0]).toMatchObject({ dispatched: true });

      const manualResponse = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workflow_id: "http-admission", runId: "http-manual-competing" }),
      });
      const manual = await manualResponse.json() as {
        error: string;
        data: { reason: string; workflow_id: string; active_count: number };
      };
      expect(manualResponse.status).toBe(409);
      expect(manual.error).toContain("max_concurrency");
      expect(manual.data).toMatchObject({
        reason: "max_concurrency",
        workflow_id: "http-admission",
        active_count: 1,
      });

      const atomicResponse = await fetch(`${baseUrl}/api/runs/create-and-run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workflow_id: "http-admission", runId: "http-atomic-competing" }),
      });
      const atomic = await atomicResponse.json() as {
        data: { reason: string; workflow_id: string; active_count: number };
      };
      expect(atomicResponse.status).toBe(409);
      expect(atomic.data).toMatchObject({
        reason: "max_concurrency",
        workflow_id: "http-admission",
        active_count: 1,
      });

      const secondResponse = await fetch(`${baseUrl}/api/dag/triggers/events/schedule.tick`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotency_key: "tick-http-1", payload: {} }),
      });
      const second = await secondResponse.json() as {
        data: { deliveries: Array<{ dispatched: boolean; reason: string }> };
      };
      expect(secondResponse.status).toBe(200);
      expect(second.data.deliveries[0]).toMatchObject({
        dispatched: false,
        reason: "max_concurrency",
      });
    } finally {
      await closeServer(server);
    }
  });
});

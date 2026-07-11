import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { subscribe } from "../src/events/bus.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { instantiateDAGPattern } from "../src/orchestration/dag-patterns.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  createPendingApproval,
  decideApproval,
  getApproval,
  getDagState,
  listPendingApprovals,
  reserveDagBudget,
  updateDagState,
} from "../src/persistence/dag-runtime-primitives.js";
import { listDagTriggers } from "../src/persistence/dag-triggers.js";
import { upsertDagWorkflowFromYaml } from "../src/persistence/dag-workflows.js";
import { listPersistedRunIds, loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  appendRunNode,
  buildCurrentDispatchEnvelope,
  decideActiveRunApproval,
  expireActiveRunApprovals,
  failActiveRun,
  getActiveRun,
  handoffActiveRun,
  recordAdvisorCall,
  requestNodeCorrection,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";
import { fireDagEventTrigger, startDagTriggerScheduler } from "../src/runtime/dag-triggers.js";
import { isDagApprovalRequestAuthorized, requiresDagMutationAuthorization } from "../src/server/mutations.js";

function yaml(id: string, body: string): string {
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: ${id}, name: ${id} }
spec:
${body.replace(/^/gm, "  ")}
`;
}

describe("DAG runtime pattern primitives", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldAllowlist: string | undefined;
  let oldDynamicCommands: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    oldDynamicCommands = process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-primitives-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS = "true";
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
    if (oldDynamicCommands === undefined) delete process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS;
    else process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS = oldDynamicCommands;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("executes an allowlisted deterministic command and captures typed evidence", () => {
    const telemetry: unknown[] = [];
    const unsubscribe = subscribe("dag:deterministic_command", (payload) => telemetry.push(payload));
    const parsed = parseWorkflowSource(yaml("command-check", `
contracts:
  Check: { type: object }
agents: {}
nodes:
  check:
    kind: command
    inputs: { task: { contract: Check } }
    outputs: { passed: {}, failed: {} }
    config:
      command_field: command
      timeout_ms: 5000
      success_port: passed
      failure_port: failed
      parse_stdout: json
  done: { kind: terminal, outcome: success, inputs: { result: {} } }
  failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: $run.input, to: check.task }
  - { from: check.passed, to: done.result }
  - { from: check.failed, to: failed.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("command-run", parsed, JSON.stringify({
      command: ["node", "-e", "console.log(JSON.stringify({metric:3,api_key:'sk-commandsecret12345'}))"],
      api_key: "sk-inputsecret123456",
    }));
    expect(executor.tick("command-run")).toBe(1);
    expect(getActiveRun("command-run")?.status).toBe("completed");
    const snapshot = getActiveRun("command-run");
    expect(snapshot?.dagRun.nodeStates.get("check")).toBe("COMPLETED");
    const persisted = JSON.stringify(loadRunSnapshot("command-run")?.handoffs ?? []);
    expect(persisted).toContain("sk-commandsecret12345");
    expect(persisted).toContain("sk-inputsecret123456");
    expect(JSON.stringify(telemetry)).not.toContain("sk-commandsecret12345");
    expect(JSON.stringify(telemetry)).not.toContain("sk-inputsecret123456");
    expect(JSON.stringify(telemetry)).toContain("***REDACTED***");
    unsubscribe();
  });

  it("selects an authoritative command input while other ports gate readiness", () => {
    const parsed = parseWorkflowSource(yaml("command-selected-input", `
agents:
  source: { system: Supply input. }
nodes:
  order_source: { kind: agent, agent: source, outputs: { order: {} } }
  verdict_source: { kind: agent, agent: source, outputs: { verdict: {} } }
  check:
    kind: command
    inputs: { verdict: {}, order: {} }
    outputs: { passed: {}, failed: {} }
    config:
      input: order
      command_field: check_command
      timeout_ms: 5000
      success_port: passed
      failure_port: failed
  done: { kind: terminal, outcome: success, inputs: { result: {} } }
  failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: order_source.order, to: check.order }
  - { from: verdict_source.verdict, to: check.verdict }
  - { from: check.passed, to: done.result }
  - { from: check.failed, to: failed.result, condition: on_failure }
`));
    parsed.meta.agents!.source = { ...parsed.meta.agents!.source, agent_type: "deterministic" };
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("command-selected-input-run", parsed);
    expect(executor.tick("command-selected-input-run")).toBe(2);
    handoffActiveRun("command-selected-input-run", "verdict_source", "verdict", { verdict: "pass" });
    handoffActiveRun("command-selected-input-run", "order_source", "order", {
      check_command: ["node", "-e", "process.exit(0)"],
    });
    expect(executor.tick("command-selected-input-run")).toBeGreaterThan(0);
    expect(getActiveRun("command-selected-input-run")?.status).toBe("completed");
  });

  it("runs the ratchet through adjacent command measurements and enrolls the floor", () => {
    const workflowId = "ratchet-runtime-test";
    const parsed = instantiateDAGPattern("ratchet", {
      workflow_id: workflowId,
      target: 0,
      max_iterations: 2,
    }).parsed;
    parsed.meta.agents.improver = { ...parsed.meta.agents.improver, agent_type: "deterministic" };
    const measureCommand = [
      "node",
      "-e",
      "const fs=require('fs'),p=require('path').join(process.env.HOMERAIL_HOME,'ratchet.metric');let n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):3;n=Math.max(0,n-1);fs.writeFileSync(p,String(n));console.log(n)",
    ];
    const rollbackCommand = ["node", "-e", "process.exit(0)"];
    const executor = new GraphExecutor({
      dispatch: () => ({ status: "dispatched", targetType: "fake", targetId: "ratchet-test" }),
    });
    executor.createRun("ratchet-runtime-run", parsed, JSON.stringify({ measure_command: measureCommand, rollback_command: rollbackCommand }));

    expect(executor.tick("ratchet-runtime-run")).toBeGreaterThan(0);
    expect(getActiveRun("ratchet-runtime-run")?.dagRun.nodeStates.get("improve")).toBe("RUNNING");
    handoffActiveRun("ratchet-runtime-run", "improve", "changed", { measure_command: measureCommand, rollback_command: rollbackCommand });

    expect(executor.tick("ratchet-runtime-run")).toBeGreaterThan(0);
    if (getActiveRun("ratchet-runtime-run")?.dagRun.nodeStates.get("improve") === "READY") {
      expect(executor.tick("ratchet-runtime-run")).toBeGreaterThan(0);
    }
    expect(getActiveRun("ratchet-runtime-run")?.dagRun.nodeStates.get("improve")).toBe("RUNNING");
    handoffActiveRun("ratchet-runtime-run", "improve", "changed", { measure_command: measureCommand, rollback_command: rollbackCommand });

    expect(executor.tick("ratchet-runtime-run")).toBeGreaterThan(0);
    expect(getActiveRun("ratchet-runtime-run")?.status).toBe("completed");
    expect(getDagState("standing-goal-floors", workflowId)?.value).toBe(0);
  });

  it("does not allow a path-shaped executable to bypass the command allowlist", () => {
    const parsed = parseWorkflowSource(yaml("command-path-check", `
agents: {}
nodes:
  check:
    kind: command
    outputs: { passed: {}, failed: {} }
    config:
      command: [/tmp/untrusted/node, -e, process.exit(0)]
      timeout_ms: 5000
      success_port: passed
      failure_port: failed
  done: { kind: terminal, outcome: success, inputs: { result: {} } }
  failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: check.passed, to: done.result }
  - { from: check.failed, to: failed.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("command-path-run", parsed);
    executor.tick("command-path-run");
    expect(getActiveRun("command-path-run")?.status).toBe("failed");
  });

  it("updates a trust ledger atomically and demotes on verified failure", () => {
    const source = yaml("trust-state", `
contracts:
  Verdict: { type: object }
agents: {}
nodes:
  update:
    kind: state
    inputs: { verdict: { contract: Verdict } }
    outputs: { done: {}, conflict: {} }
    config:
      namespace: trust
      key: lint
      operation: trust_update
      pass_field: verdict
      auto_min_runs: 2
      auto_min_rate: 1
      watch_min_rate: 0.9
      success_port: done
      conflict_port: conflict
  terminal: { kind: terminal, outcome: success, inputs: { result: {} } }
  conflict: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: $run.input, to: update.verdict }
  - { from: update.done, to: terminal.result }
  - { from: update.conflict, to: conflict.result, condition: on_failure }
`);
    for (const [runId, verdict] of [["trust-pass", "pass"], ["trust-fail", "fail"]] as const) {
      const executor = new GraphExecutor(new FakeDAGDispatcher());
      executor.createRun(runId, parseWorkflowSource(source), JSON.stringify({ verdict }));
      executor.tick(runId);
    }
    expect(getDagState("trust", "lint")).toMatchObject({
      version: 2,
      value: { runs: 2, passes: 1, rate: 0.5, tier: "watch", last_result: "fail" },
    });
  });

  it("atomically reserves declared budget without double admission", () => {
    updateDagState({ namespace: "budget", key: "daily", value: 1 });
    expect(reserveDagBudget({
      namespace: "budget",
      key: "daily",
      amount: 3,
      limit: 5,
      runId: "budget-run-1",
      nodeId: "budget-gate",
    })).toMatchObject({ admitted: true, spent: 4, requested: 3, remaining: 1 });
    expect(reserveDagBudget({
      namespace: "budget",
      key: "daily",
      amount: 2,
      limit: 5,
      runId: "budget-run-2",
      nodeId: "budget-gate",
    })).toMatchObject({ admitted: false, spent: 4, requested: 2, remaining: 1 });
    expect(getDagState("budget", "daily")).toMatchObject({ version: 2, value: 4 });
  });

  it("persists approval across recovery and requires actor plus proposal hash", () => {
    const parsed = parseWorkflowSource(yaml("approval-flow", `
contracts:
  Proposal: { type: object }
agents: {}
nodes:
  approve:
    kind: approval
    inputs: { proposal: { contract: Proposal } }
    outputs: { approved: {}, rejected: {} }
    config:
      approval_id: release
      proposer_actor: "agent:release-proposer"
      authorized_actors: [matrix]
      approved_port: approved
      rejected_port: rejected
  accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
  denied: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: $run.input, to: approve.proposal }
  - { from: approve.approved, to: accepted.result }
  - { from: approve.rejected, to: denied.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("approval-run", parsed, JSON.stringify({ change: "ship" }));
    executor.tick("approval-run");
    const pending = getApproval("approval-run", "approve")!;
    expect(getActiveRun("approval-run")?.dagRun.nodeStates.get("approve")).toBe("WAITING_FOR_APPROVAL");
    expect(listPendingApprovals()).toHaveLength(1);
    expect(pending.proposer_actor).toBe("agent:release-proposer");

    // Simulate a legacy or externally altered row that bypassed DSL validation.
    getDb().prepare(`
      UPDATE dag_approvals SET authorized_actors = ? WHERE run_id = ? AND node_id = ?
    `).run(JSON.stringify(["agent:release-proposer", "matrix"]), "approval-run", "approve");
    _clearActiveRuns();
    closeDb();
    expect(recoverAllActiveRuns().recovered).toContain("approval-run");
    expect(() => decideActiveRunApproval({
      runId: "approval-run",
      nodeId: "approve",
      decision: "approved",
      actor: "agent:release-proposer",
      proposalHash: pending.proposal_hash,
    })).toThrow("cannot approve its own proposal");
    decideActiveRunApproval({ runId: "approval-run", nodeId: "approve", decision: "approved", actor: "matrix", proposalHash: pending.proposal_hash });
    expect(getActiveRun("approval-run")?.status).toBe("completed");
    expect(() => createPendingApproval({
      runId: "approval-run",
      nodeId: "approve",
      approvalId: "release",
      proposal: { change: "replace after restart" },
      proposerActor: "agent:release-proposer",
      authorizedActors: ["matrix"],
    })).toThrow("approval decision is immutable: already approved");
    expect(getApproval("approval-run", "approve")).toMatchObject({
      status: "approved",
      actor: "matrix",
      proposal: { change: "ship" },
    });
  });

  it("schedules legacy waiting approvals without proposer identity for deterministic expiry", () => {
    const managerDir = path.join(tmpHome, "manager");
    fs.mkdirSync(managerDir, { recursive: true });
    const legacy = new Database(path.join(managerDir, "homerail.db"));
    legacy.exec(`
      CREATE TABLE dag_approvals (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        status TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        authorized_actors TEXT NOT NULL,
        decision TEXT,
        actor TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY(run_id, node_id)
      );
    `);
    legacy.prepare(`
      INSERT INTO dag_approvals(
        run_id, node_id, approval_id, status, proposal_hash, proposal_json,
        authorized_actors, created_at, updated_at
      ) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?)
    `).run(
      "legacy-run",
      "approve",
      "release",
      "legacy-hash",
      JSON.stringify({ change: "legacy" }),
      JSON.stringify(["matrix"]),
      1,
      1,
    );
    legacy.close();

    const columns = getDb().prepare("PRAGMA table_info(dag_approvals)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("proposer_actor");
    expect(getApproval("legacy-run", "approve")).toMatchObject({
      status: "waiting",
      expires_at: 0,
      proposer_actor: "",
    });
    expect(() => decideApproval({
      runId: "legacy-run",
      nodeId: "approve",
      decision: "approved",
      actor: "matrix",
      proposalHash: "legacy-hash",
    })).toThrow("approval expired");
    expect(getApproval("legacy-run", "approve")?.status).toBe("expired");
    expect(getDb().prepare("SELECT version FROM schema_migrations WHERE version = 4").get()).toBeTruthy();
  });

  it("rejects self-approval and preserves a decided approval on re-entry", () => {
    const parsed = parseWorkflowSource(yaml("approval-immutable", `
agents: {}
nodes:
  approve:
    kind: approval
    outputs: { approved: {}, rejected: {} }
    config:
      approval_id: release
      proposer_actor: "agent:proposer"
      authorized_actors: [matrix]
      approved_port: approved
      rejected_port: rejected
  accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
  denied: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: approve.approved, to: accepted.result }
  - { from: approve.rejected, to: denied.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("approval-immutable-run", parsed);
    executor.tick("approval-immutable-run");
    const pending = createPendingApproval({
      runId: "approval-immutable-run",
      nodeId: "approve",
      approvalId: "release",
      proposal: { change: "ship" },
      proposerActor: "agent:proposer",
      authorizedActors: ["agent:proposer", "matrix"],
    });
    getDb().prepare("UPDATE dag_approvals SET proposer_actor = '' WHERE run_id = ? AND node_id = ?")
      .run(pending.run_id, pending.node_id);
    expect(() => decideApproval({
      runId: pending.run_id,
      nodeId: pending.node_id,
      decision: "approved",
      actor: "matrix",
      proposalHash: pending.proposal_hash,
    })).toThrow("approval proposer identity is unavailable");
    getDb().prepare("UPDATE dag_approvals SET proposer_actor = ? WHERE run_id = ? AND node_id = ?")
      .run("agent:proposer", pending.run_id, pending.node_id);
    expect(() => decideApproval({
      runId: pending.run_id,
      nodeId: pending.node_id,
      decision: "approved",
      actor: "agent:proposer",
      proposalHash: pending.proposal_hash,
    })).toThrow("cannot approve its own proposal");

    decideApproval({
      runId: pending.run_id,
      nodeId: pending.node_id,
      decision: "approved",
      actor: "matrix",
      proposalHash: pending.proposal_hash,
    });
    expect(() => createPendingApproval({
      runId: pending.run_id,
      nodeId: pending.node_id,
      approvalId: "release",
      proposal: { change: "replace decision" },
      proposerActor: "agent:proposer",
      authorizedActors: ["matrix"],
    })).toThrow("approval decision is immutable: already approved");
    expect(getApproval(pending.run_id, pending.node_id)).toMatchObject({
      status: "approved",
      decision: "approved",
      actor: "matrix",
      proposal: { change: "ship" },
    });
  });

  it("keeps approval waiting when its decision handoff violates the output contract", () => {
    const parsed = parseWorkflowSource(yaml("approval-contract-preflight", `
contracts:
  ImpossibleDecision:
    type: object
    required: [required_only]
    properties: { required_only: { type: string } }
agents: {}
nodes:
  approve:
    kind: approval
    outputs: { approved: { contract: ImpossibleDecision }, rejected: {} }
    config:
      approval_id: release
      proposer_actor: "agent:proposer"
      authorized_actors: [matrix]
      approved_port: approved
      rejected_port: rejected
  accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
  denied: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: approve.approved, to: accepted.result }
  - { from: approve.rejected, to: denied.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("approval-contract-run", parsed);
    executor.tick("approval-contract-run");
    const pending = getApproval("approval-contract-run", "approve")!;

    expect(() => decideActiveRunApproval({
      runId: "approval-contract-run",
      nodeId: "approve",
      decision: "approved",
      actor: "matrix",
      proposalHash: pending.proposal_hash,
    })).toThrow("DAG_HANDOFF_CONTRACT_VIOLATION");
    expect(getApproval("approval-contract-run", "approve")?.status).toBe("waiting");
    expect(getActiveRun("approval-contract-run")?.dagRun.nodeStates.get("approve")).toBe("WAITING_FOR_APPROVAL");
  });

  it("expires a durable approval and routes it through the rejected port", () => {
    const parsed = parseWorkflowSource(yaml("approval-expiry", `
agents: {}
nodes:
  approve:
    kind: approval
    outputs: { approved: {}, rejected: {} }
    config:
      approval_id: release
      proposer_actor: "agent:release-proposer"
      authorized_actors: [matrix]
      expires_after_ms: 1000
      approved_port: approved
      rejected_port: rejected
  accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
  denied: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: approve.approved, to: accepted.result }
  - { from: approve.rejected, to: denied.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("approval-expiry-run", parsed);
    executor.tick("approval-expiry-run");
    const approval = getApproval("approval-expiry-run", "approve")!;
    expect(expireActiveRunApprovals((approval.expires_at ?? Date.now()) + 1)).toHaveLength(1);
    expect(getApproval("approval-expiry-run", "approve")).toMatchObject({
      status: "expired",
      decision: "rejected",
      actor: "system:expiry",
    });
    expect(getActiveRun("approval-expiry-run")?.status).toBe("failed");
  });

  it("contains an expiry handoff contract failure to the affected run", () => {
    const parsed = parseWorkflowSource(yaml("approval-expiry-contract", `
contracts:
  Text: { type: string }
agents: {}
nodes:
  approve:
    kind: approval
    outputs: { approved: {}, rejected: { contract: Text } }
    config:
      approval_id: release
      proposer_actor: "agent:release-proposer"
      authorized_actors: [matrix]
      expires_after_ms: 1000
      approved_port: approved
      rejected_port: rejected
  accepted: { kind: terminal, outcome: success, inputs: { result: {} } }
  denied: { kind: terminal, outcome: failure, inputs: { result: { contract: Text } } }
edges:
  - { from: approve.approved, to: accepted.result }
  - { from: approve.rejected, to: denied.result, condition: on_failure }
`));
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("approval-expiry-contract-run", parsed);
    executor.tick("approval-expiry-contract-run");
    const approval = getApproval("approval-expiry-contract-run", "approve")!;
    expect(() => expireActiveRunApprovals((approval.expires_at ?? Date.now()) + 1)).not.toThrow();
    expect(getActiveRun("approval-expiry-contract-run")?.status).toBe("failed");
  });

  it("requires local access or an explicit token for human approval decisions", () => {
    expect(isDagApprovalRequestAuthorized({ remoteAddress: "127.0.0.1" })).toBe(true);
    expect(isDagApprovalRequestAuthorized({ remoteAddress: "203.0.113.50" })).toBe(false);
    expect(isDagApprovalRequestAuthorized({
      remoteAddress: "203.0.113.50",
      configuredToken: "secret",
      bodyToken: "secret",
    })).toBe(true);
    expect(isDagApprovalRequestAuthorized({
      remoteAddress: "127.0.0.1",
      configuredToken: "secret",
      bodyToken: "wrong",
    })).toBe(false);
  });

  it("protects every run mutation and persisted workflow/profile sync route", () => {
    for (const pathname of [
      "/api/runs",
      "/api/runs/create-and-run",
      "/api/runs/emergency-stop",
      "/api/runs/run-1/invoke",
      "/api/runs/run-1/cancel",
      "/api/runs/run-1/inject",
      "/api/runs/run-1/node/node-1/checkpoint-resume",
      "/api/runs/run-1/dynamic/nodes",
      "/api/runs/run-1/manager/commands",
      "/api/dag/workflows/sync",
      "/api/dag/profiles/sync",
    ]) {
      expect(requiresDagMutationAuthorization(pathname, "POST"), pathname).toBe(true);
    }
    expect(requiresDagMutationAuthorization("/api/runs/run-1/node/node-1/approval", "POST")).toBe(false);
    expect(requiresDagMutationAuthorization("/api/dag/validate", "POST")).toBe(false);
    expect(requiresDagMutationAuthorization("/api/runs", "GET")).toBe(false);
  });

  it("fans out a dynamic worker count and completes n-of-m early", () => {
    const parsed = parseWorkflowSource(yaml("dynamic-fanout", `
contracts:
  Plan:
    type: object
    required: [items, shared]
    properties:
      items: { type: array, minItems: 1 }
      shared: { type: object }
  WorkerResult:
    type: object
    required: [status, evidence]
    properties:
      status: { enum: [success, failed] }
      evidence: {}
agents:
  worker: { system: Process one item and hand off result or failed. }
nodes:
  fan:
    kind: fanout
    inputs: { plan: { contract: Plan } }
    outputs: { passed: {}, failed: {} }
    config:
      input: plan
      item_field: items
      context_field: shared
      worker_agent: worker
      max_items: 5
      max_parallelism: 2
      completion: n_of_m
      threshold: 2
      result_contract: WorkerResult
      result_port: passed
      failed_port: failed
      cancel_remaining: true
  done: { kind: terminal, outcome: success, inputs: { result: {} } }
  failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: $run.input, to: fan.plan }
  - { from: fan.passed, to: done.result }
  - { from: fan.failed, to: failed.result, condition: on_failure }
`));
    parsed.meta.agents!.worker.agent_type = "deterministic";
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun("fanout-run", parsed, JSON.stringify({
      items: ["a", "b", "c"],
      shared: { repo_dir: "/workspace/repo", head_sha: "abc123" },
    }));
    expect(executor.tick("fanout-run")).toBe(3);
    expect(dispatcher.dispatched.map((entry) => entry.nodeId)).toEqual(["fan__item_0001", "fan__item_0002"]);
    expect(dispatcher.dispatched[0]?.inputs.item?.[0]).toEqual({
      item: "a",
      index: 0,
      total: 3,
      context: { repo_dir: "/workspace/repo", head_sha: "abc123" },
    });
    expect(getActiveRun("fanout-run")?.dagRun.graph.nodes.find(
      (node) => node.node_id === "fan__item_0001",
    )?.extra?.workflow_spec_v1).toMatchObject({ output_contracts: { result: "WorkerResult" } });
    expect(() => handoffActiveRun("fanout-run", "fan__item_0001", "result", { evidence: "missing status" }))
      .toThrow("DAG_HANDOFF_CONTRACT_VIOLATION");
    expect(getActiveRun("fanout-run")?.status).toBe("active");
    expect(requestNodeCorrection("fanout-run", "fan__item_0001", "missing status").status).toBe("scheduled");
    handoffActiveRun("fanout-run", "fan__item_0001", "result", { status: "success", evidence: "a" });
    failActiveRun("fanout-run", "fan__item_0002", "worker exhausted correction attempts");
    expect(getActiveRun("fanout-run")?.status).toBe("active");
    expect(getActiveRun("fanout-run")?.dagRun.nodeStates.get("fan__item_0003")).toBe("READY");
    expect(executor.tick("fanout-run")).toBe(1);
    handoffActiveRun("fanout-run", "fan__item_0003", "result", { status: "success", evidence: "c" });
    expect(getActiveRun("fanout-run")?.status).toBe("completed");
    expect(loadRunSnapshot("fanout-run")?.handoffs.find((entry) => (
      entry.fromNode === "fan" && entry.port === "passed"
    ))?.content).toMatchObject({
      context: { repo_dir: "/workspace/repo", head_sha: "abc123" },
    });
    expect(() => handoffActiveRun("fanout-run", "fan__item_0002", "result", { status: "success", evidence: "late" }))
      .toThrow("not active");
  });

  it("enforces max_nodes when a running DAG appends dynamic nodes", () => {
    const parsed = parseWorkflowSource(yaml("bounded-dynamic-graph", `
agents:
  worker: { system: Work. }
nodes:
  work: { kind: agent, agent: worker, outputs: { done: {} } }
  done: { kind: terminal, outcome: success, inputs: { result: {} } }
edges:
  - { from: work.done, to: done.result }
`));
    parsed.meta.limits = { ...(parsed.meta.limits ?? {}), max_nodes: 1 };
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("bounded-dynamic-run", parsed);
    expect(() => appendRunNode("bounded-dynamic-run", {
      node: {
        node_id: "extra",
        name: "extra",
        description: "must be rejected",
        node_type: "agent",
        agent: "worker",
        after: [],
        outputs: {},
      },
    })).toThrow("max_nodes (1) exceeded");
  });

  it("resolves distinct advisor runtime bindings in the executor envelope", () => {
    const parsed = parseWorkflowSource(yaml("advisor-envelope", `
contracts: { Task: { type: string } }
agents:
  executor: { system: Execute. }
  expert: { system: Advise. }
nodes:
  execute:
    kind: agent
    agent: executor
    advisors:
      - { id: architecture, agent: expert, max_calls: 2, timeout_ms: 5000, max_tokens: 1000 }
    inputs: { task: { contract: Task } }
    outputs: { done: {} }
  terminal: { kind: terminal, outcome: success, inputs: { result: {} } }
edges:
  - { from: $run.input, to: execute.task }
  - { from: execute.done, to: terminal.result }
`));
    parsed.meta.agents!.executor = { ...parsed.meta.agents!.executor, agent_type: "deterministic", model: "executor-model" };
    parsed.meta.agents!.expert = { ...parsed.meta.agents!.expert, agent_type: "deterministic", model: "advisor-model" };
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("advisor-run", parsed, "task");
    expect(buildCurrentDispatchEnvelope("advisor-run", "execute")).toMatchObject({
      ok: true,
      envelope: {
        agentConfig: { model: "executor-model" },
        advisors: [{ id: "architecture", agent_id: "expert", model: "advisor-model", max_calls: 2, calls_used: 0 }],
      },
    });
    expect(recordAdvisorCall("advisor-run", "execute", "architecture")).toBe(1);
    expect(buildCurrentDispatchEnvelope("advisor-run", "execute")).toMatchObject({
      ok: true,
      envelope: { advisors: [{ id: "architecture", max_calls: 2, calls_used: 1 }] },
    });
  });

  it("delivers persisted event triggers idempotently", () => {
    upsertDagWorkflowFromYaml({ yaml_text: yaml("triggered-check", `
triggers:
  push:
    type: event
    event: repo.push
    overlap: allow
    max_concurrency: 2
agents: {}
nodes:
  check:
    kind: command
    outputs: { done: {}, failed: {} }
    config:
      command: [node, -e, process.exit(0)]
      timeout_ms: 5000
      success_port: done
      failure_port: failed
  terminal: { kind: terminal, outcome: success, inputs: { result: {} } }
  failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
edges:
  - { from: check.done, to: terminal.result }
  - { from: check.failed, to: failed.result, condition: on_failure }
`) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const stop = startDagTriggerScheduler(orchestrator, 60_000);
    try {
      expect(listDagTriggers()).toHaveLength(1);
      expect(fireDagEventTrigger("repo.push", "sha-1", { ref: "main" })[0]).toMatchObject({ dispatched: true });
      expect(fireDagEventTrigger("repo.push", "sha-1", { ref: "main" })[0]).toMatchObject({ dispatched: false, reason: "duplicate" });
      expect(listPersistedRunIds()).toHaveLength(1);
    } finally {
      stop();
    }
  });
});

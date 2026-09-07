import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DagCredentialBrokerCallRequest } from "homerail-protocol";

import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  completeCredentialBrokerMutation,
  dispatchCredentialBrokerMutation,
  prepareCredentialBrokerMutation,
} from "../src/persistence/credential-broker-mutations.js";
import { getDagSessionIndex, listDagSessionIndex, upsertDagSessionIndex } from "../src/persistence/dag-session-index.js";
import {
  _clearAllPersistence,
  loadRunMetadata,
  serializeRunMetadata,
  writeRunMetadata,
} from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  dispatchRecoveredRuns,
  getActiveRun,
  handoffActiveRun,
  recoverAllActiveRuns,
  restoreActiveRun,
} from "../src/runtime/active-runs.js";

/** Dispatcher that records envelopes. The status field controls whether the
 * node is treated as dispatched (RUNNING) by the engine. */
class CaptureDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }
}

function singleNodeDag() {
  return parseDAGYaml(`
name: cold-recovery
workflow_id: cold-recovery
pattern:
  id: heartbeat
  version: 1.0.0
  source: https://x.com/i/status/2074169173178212621
  parameters:
    workflow_id: cold-recovery
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
}

/** A -> B: work hands off to review, which lets us test mailbox replay. */
function chainedDag() {
  return parseDAGYaml(`
name: cold-recovery-chain
workflow_id: cold-recovery-chain
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  coder:
    agent: worker
    outputs:
      done:
        to: review
  review:
    agent: worker
    after: [coder]
    outputs:
      done:
        to: ""
`);
}

function blockedDownstreamDag() {
  return parseDAGYaml(`
name: cold-recovery-blocked
workflow_id: cold-recovery-blocked
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  root:
    agent: worker
    outputs:
      done:
        to: ""
  observer:
    agent: worker
    after: [root]
    outputs:
      done:
        to: ""
`);
}

function dormantWhileDag() {
  return parseDAGYaml(`
name: cold-recovery-dormant-while
workflow_id: cold-recovery-dormant-while
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
nodes:
  gate:
    type: while_gateway
    gateway_config:
      field: status
      operator: eq
      value: approved
      max_iterations: 2
      continue_port: improve
      done_port: reached
      exhausted_port: stopped
    outputs:
      improve:
        to: worker.in:task
      reached:
        to: success.in:result
      stopped:
        to: exhausted.in:result
  worker:
    agent: worker
    after: [gate]
    outputs:
      measured:
        to: gate.in:state
        retry_policy: { max_retries: 2 }
  success:
    agent: worker
    after: [gate]
    outputs: { done: { to: "" } }
  exhausted:
    agent: worker
    after: [gate]
    outputs: { done: { to: "" } }
`);
}

function recoverableWhileDag() {
  return parseDAGYaml(`
name: cold-recovery-recoverable-while
workflow_id: cold-recovery-recoverable-while
workspace:
  project_id: project-a
agents:
  worker:
    agent_type: deterministic
nodes:
  gate:
    type: while_gateway
    gateway_config:
      field: status
      operator: eq
      value: approved
      max_iterations: 2
      continue_port: improve
      done_port: reached
      exhausted_port: stopped
    outputs:
      improve: { to: worker.in:task }
      reached: { to: success.in:result }
      stopped: { to: exhausted.in:result }
  worker:
    agent: worker
    after: [gate]
    outputs:
      measured: { to: gate.in:state, retry_policy: { max_retries: 2 } }
      error: { to: recovery.in:error }
  recovery:
    agent: worker
    after: [gate, worker]
    outputs:
      measured: { to: gate.in:state, retry_policy: { max_retries: 2 } }
  success:
    agent: worker
    after: [gate]
    outputs: { done: { to: "" } }
  exhausted:
    agent: worker
    after: [gate]
    outputs: { done: { to: "" } }
`);
}

describe("manager cold recovery", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-cold-recovery-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("restores an active run into the in-memory store after a simulated restart", () => {
    createActiveRun("run-recover-basic", singleNodeDag());
    // Simulate restart: wipe memory, keep SQLite. work stays READY (never dispatched).
    _clearActiveRuns();
    expect(getActiveRun("run-recover-basic")).toBeUndefined();

    const summary = recoverAllActiveRuns();

    expect(summary.recovered).toEqual(["run-recover-basic"]);
    const run = getActiveRun("run-recover-basic");
    expect(run).toBeDefined();
    expect(run!.status).toBe("active");
    expect(run!.dagRun.nodeStates.get("work")).toBe("READY");
    // Counters and limits survive the round-trip.
    expect(run!.counters.dispatches).toBe(0);
    expect(run!.limits.max_dispatches).toBeGreaterThan(0);
    expect(run!.dagRun.graph.nodes).toHaveLength(1);
    expect(run!.nodeIndex.has("work")).toBe(true);
    expect(run!.pattern).toEqual({
      id: "heartbeat",
      version: "1.0.0",
      source: "https://x.com/i/status/2074169173178212621",
      parameters: { workflow_id: "cold-recovery" },
    });
  });

  it("fails a recovered broker gateway whose completed result violates its output contract", () => {
    const runId = "run-recovered-broker-contract";
    const parsed = parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: recovered-broker-contract, name: Recovered broker contract }
spec:
  contracts:
    Task: { type: object }
    Text: { type: string }
  agents:
    worker: { system: Produce one candidate. }
  nodes:
    prepare:
      kind: agent
      agent: worker
      inputs: { task: { contract: Task } }
      outputs: { candidate: {} }
    validate:
      kind: broker
      inputs: { candidate: {} }
      outputs: { result: { contract: Text }, error: {} }
      config:
        input: candidate
        credential_ref: recovery-credential
        purpose: validate one candidate
        broker: recovery_broker
        action: validate
        result_port: result
        error_port: error
    done: { kind: terminal, outcome: success, inputs: { result: { contract: Text } } }
    failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: prepare.task }
    - { from: prepare.candidate, to: validate.candidate }
    - { from: validate.result, to: done.result }
    - { from: validate.error, to: failed.result, condition: on_failure }
`);
    createActiveRun(runId, parsed);
    const active = getActiveRun(runId)!;
    active.dagRun.nodeStates.set("prepare", "COMPLETED");
    active.dagRun.nodeStates.set("validate", "RUNNING");
    active.dagRun.handoffedNodes.add("prepare");
    const session = upsertDagSessionIndex({
      run_id: runId,
      node_id: "validate",
      project_key: "recovery-project",
      session_id: "recovery-gateway-session",
      attempt: 1,
      status: "running",
    });
    writeRunMetadata(runId, serializeRunMetadata(active));
    const request: DagCredentialBrokerCallRequest = {
      request_id: "recovered-gateway-request",
      idempotency_key: "recovered-gateway-request",
      transport_kind: "manager_gateway",
      run_id: runId,
      node_id: "validate",
      session_id: session.session_id,
      round_id: active.currentRound.round_id,
      gateway_attempt: session.attempt,
      credential_ref: "recovery-credential",
      broker: "recovery_broker",
      action: "validate",
      input: {},
    };
    prepareCredentialBrokerMutation({
      request,
      request_digest: "a".repeat(64),
      semantic_target: "resource:recovered-gateway",
      source_id: "manager:validate",
    });
    dispatchCredentialBrokerMutation(request.request_id);
    completeCredentialBrokerMutation(request.request_id, { invalid: "not text" });

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    expect(summary.skipped).not.toContain(runId);
    expect(summary.failed.map((failure) => failure.runId)).toContain(runId);
    const recovered = getActiveRun(runId);
    expect(recovered).toBeDefined();
    expect(recovered?.dagRun.nodeStates.get("validate")).toBe("FAILED");
    expect(recovered?.status).not.toBe("active");
    expect(loadRunMetadata(runId)?.status).not.toBe("active");
    expect(getDagSessionIndex(runId, "validate")?.status).toBe("failed");
  });

  it("replays handoff history so a downstream node receives upstream output in its mailbox", () => {
    createActiveRun("run-chain", chainedDag());
    // Dispatch coder, then hand off to review (which seeds review's mailbox).
    const dispatcher = new CaptureDispatcher();
    dispatchReadyNodes("run-chain", dispatcher); // coder -> RUNNING
    handoffActiveRun("run-chain", "coder", "done", "coder-output");
    // review is now READY with coder-output in its mailbox; dispatch it.
    dispatchReadyNodes("run-chain", dispatcher); // review -> RUNNING
    expect(dispatcher.dispatched.map((e) => e.nodeId)).toEqual([
      "coder",
      "review",
    ]);

    // Simulate restart.
    _clearActiveRuns();
    recoverAllActiveRuns();

    const run = getActiveRun("run-chain")!;
    expect(run.dagRun.nodeStates.get("coder")).toBe("COMPLETED");
    // review was RUNNING at crash -> demoted to FAILED.
    expect(run.dagRun.nodeStates.get("review")).toBe("FAILED");
    // But the mailbox replay happened before demotion: review's mailbox holds
    // the coder handoff content, proving history was replayed.
    const reviewMailbox = run.dagRun.mailboxes.get("review");
    expect(reviewMailbox).toBeDefined();
    const portValues = reviewMailbox!.get("done") ?? reviewMailbox!.get("prompt");
    expect(portValues).toContain("coder-output");
  });

  it("demotes nodes that were RUNNING at crash time to FAILED and marks their session failed", () => {
    createActiveRun("run-running", singleNodeDag());
    dispatchReadyNodes("run-running", new CaptureDispatcher()); // work -> RUNNING
    const events: Array<{ nodeId: string; reason: string }> = [];
    subscribe("dag:node_failed", (payload) =>
      events.push(payload as { nodeId: string; reason: string }),
    );

    _clearActiveRuns();
    recoverAllActiveRuns();

    const run = getActiveRun("run-running")!;
    expect(run.dagRun.nodeStates.get("work")).toBe("FAILED");
    expect(getDagSessionIndex("run-running", "work")?.status).toBe("failed");
    expect(events.some((e) => e.nodeId === "work")).toBe(true);
  });

  it("preserves a dormant RUNNING while source that is waiting for feedback", () => {
    createActiveRun("run-dormant-while", dormantWhileDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-dormant-while", dispatcher)).toBe(1);
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("gate")).toBe("RUNNING");
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("worker")).toBe("READY");

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    expect(summary.recovered).toContain("run-dormant-while");
    expect(summary.failed).toEqual([]);
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("gate")).toBe("RUNNING");
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("worker")).toBe("READY");

    expect(dispatchReadyNodes("run-dormant-while", dispatcher)).toBe(1);
    handoffActiveRun("run-dormant-while", "worker", "measured", { status: "approved" });
    expect(dispatchReadyNodes("run-dormant-while", dispatcher)).toBe(1);
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("gate")).toBe("COMPLETED");
    expect(getActiveRun("run-dormant-while")?.dagRun.nodeStates.get("success")).toBe("READY");
  });

  it("fails a dormant RUNNING while source when its in-flight feedback worker is lost", () => {
    createActiveRun("run-orphaned-while-worker", dormantWhileDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-orphaned-while-worker", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-orphaned-while-worker", dispatcher)).toBe(1);
    expect(getActiveRun("run-orphaned-while-worker")?.dagRun.nodeStates.get("gate")).toBe("RUNNING");
    expect(getActiveRun("run-orphaned-while-worker")?.dagRun.nodeStates.get("worker")).toBe("RUNNING");

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    const run = getActiveRun("run-orphaned-while-worker")!;
    expect(summary.failed).toEqual([expect.objectContaining({
      runId: "run-orphaned-while-worker",
      demotedNodes: expect.arrayContaining(["gate", "worker"]),
    })]);
    expect(run.status).toBe("failed");
    expect(run.dagRun.nodeStates.get("gate")).toBe("FAILED");
    expect(run.dagRun.nodeStates.get("worker")).toBe("FAILED");
    expect(run.dagRun.nodeStates.get("success")).toBe("SKIPPED");
    expect(run.dagRun.nodeStates.get("exhausted")).toBe("SKIPPED");
    expect(loadRunMetadata("run-orphaned-while-worker")?.status).toBe("failed");
  });

  it("preserves a dormant while source when orphan failure wakes a live recovery path", () => {
    createActiveRun("run-recoverable-while-worker", recoverableWhileDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-recoverable-while-worker", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-recoverable-while-worker", dispatcher)).toBe(1);

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    const run = getActiveRun("run-recoverable-while-worker")!;
    expect(summary.recovered).toContain("run-recoverable-while-worker");
    expect(summary.failed).toEqual([]);
    expect(run.status).toBe("active");
    expect(run.dagRun.nodeStates.get("gate")).toBe("RUNNING");
    expect(run.dagRun.nodeStates.get("worker")).toBe("FAILED");
    expect(run.dagRun.nodeStates.get("recovery")).toBe("READY");

    expect(dispatchReadyNodes("run-recoverable-while-worker", dispatcher)).toBe(1);
    handoffActiveRun("run-recoverable-while-worker", "recovery", "measured", { status: "approved" });
    expect(dispatchReadyNodes("run-recoverable-while-worker", dispatcher)).toBe(1);
    expect(run.dagRun.nodeStates.get("gate")).toBe("COMPLETED");
    expect(run.dagRun.nodeStates.get("success")).toBe("READY");
  });

  it("fails recovery when orphan demotion leaves only blocked pending nodes", () => {
    createActiveRun("run-blocked-after-restart", blockedDownstreamDag());
    dispatchReadyNodes("run-blocked-after-restart", new CaptureDispatcher());

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    const run = getActiveRun("run-blocked-after-restart")!;
    expect(summary.failed.map((f) => f.runId)).toContain("run-blocked-after-restart");
    const failure = summary.failed.find((f) => f.runId === "run-blocked-after-restart")!;
    expect(failure.demotedNodes).toContain("root");
    expect(failure.reason).toContain("orphaned running nodes");
    expect(run.status).toBe("failed");
    expect(run.dagRun.nodeStates.get("root")).toBe("FAILED");
    expect(run.dagRun.nodeStates.get("observer")).toBe("SKIPPED");
    expect(loadRunMetadata("run-blocked-after-restart")?.status).toBe("failed");
  });

  it("settles persisted failed and ready states left by an older recovery", () => {
    createActiveRun("run-legacy-recovery-state", blockedDownstreamDag());
    const run = getActiveRun("run-legacy-recovery-state")!;
    run.dagRun.nodeStates.set("root", "FAILED");
    run.dagRun.nodeStates.set("observer", "READY");
    writeRunMetadata("run-legacy-recovery-state", serializeRunMetadata(run));

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    const recovered = getActiveRun("run-legacy-recovery-state")!;
    expect(summary.failed.map((f) => f.runId)).toContain("run-legacy-recovery-state");
    const failure = summary.failed.find((f) => f.runId === "run-legacy-recovery-state")!;
    expect(failure.demotedNodes).toEqual([]);
    expect(failure.reason).toContain("blocked by failed dependency");
    expect(recovered.status).toBe("failed");
    expect(recovered.dagRun.nodeStates.get("observer")).toBe("SKIPPED");
  });

  it("skips runs that are already terminal in persisted metadata", () => {
    createActiveRun("run-completed", singleNodeDag());
    // Mark the persisted run terminal without going through the in-memory run.
    const run = getActiveRun("run-completed")!;
    run.status = "completed";
    run.completedAt = Date.now();
    // Re-serialize to persist the terminal status.
    writeRunMetadata("run-completed", serializeRunMetadata(run));
    // A terminal row must be filtered by the indexed status column before the
    // recovery path attempts to parse its potentially very large metadata.
    getDb().prepare("UPDATE dag_runs SET metadata = ? WHERE run_id = ?")
      .run("{ intentionally invalid terminal metadata", "run-completed");

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    expect(summary.recovered).not.toContain("run-completed");
    expect(getActiveRun("run-completed")).toBeUndefined();
  });

  it("is idempotent: a second recovery pass skips already-restored runs", () => {
    createActiveRun("run-idempotent", singleNodeDag());
    _clearActiveRuns();

    const first = recoverAllActiveRuns();
    expect(first.recovered).toEqual(["run-idempotent"]);

    const second = recoverAllActiveRuns();
    expect(second.recovered).toEqual([]);
    expect(second.skipped).toContain("run-idempotent");
  });

  it("restores a run that never dispatched so its READY node can still run", () => {
    // A run that was created but never dispatched: work stays READY.
    createActiveRun("run-never-dispatched", singleNodeDag());
    _clearActiveRuns();

    recoverAllActiveRuns();

    const run = getActiveRun("run-never-dispatched")!;
    expect(run.dagRun.nodeStates.get("work")).toBe("READY");
    expect(run.status).toBe("active");

    // Dispatch now that a (fake) worker has reconnected.
    const worker = new CaptureDispatcher();
    const dispatched = dispatchRecoveredRuns(worker);
    expect(dispatched).toBe(1);
    expect(worker.dispatched.map((e) => e.nodeId)).toEqual(["work"]);
    expect(run.dagRun.nodeStates.get("work")).toBe("RUNNING");
  });

  it("re-dispatches recovered READY nodes once a worker connects", () => {
    createActiveRun("run-resume", chainedDag());
    const d = new CaptureDispatcher();
    dispatchReadyNodes("run-resume", d); // coder RUNNING
    handoffActiveRun("run-resume", "coder", "done", "out"); // coder COMPLETED, review READY
    // review is READY but not yet dispatched.
    expect(d.dispatched.map((e) => e.nodeId)).toEqual(["coder"]);

    _clearActiveRuns();
    recoverAllActiveRuns();

    const worker = new CaptureDispatcher();
    const dispatched = dispatchRecoveredRuns(worker);
    expect(dispatched).toBe(1);
    expect(worker.dispatched.map((e) => e.nodeId)).toEqual(["review"]);
  });

  it("restores per-node sessions including attempt/parent for checkpoint-resume continuity", () => {
    createActiveRun("run-sessions", singleNodeDag());
    dispatchReadyNodes("run-sessions", new CaptureDispatcher());
    // Seed a second-attempt session row directly to simulate a prior resume.
    upsertDagSessionIndex({
      run_id: "run-sessions",
      node_id: "work",
      project_key: "project-a",
      session_id: "session-attempt-2",
      attempt: 2,
      parent_session_id: "session-attempt-1",
      forked_from_entry_uuid: "entry-x",
      resume_instruction: "do it again",
      status: "active",
    });

    _clearActiveRuns();
    recoverAllActiveRuns();

    const run = getActiveRun("run-sessions")!;
    const session = run.nodeSessions.get("work");
    expect(session?.sessionId).toBe("session-attempt-2");
    expect(session?.attempt).toBe(2);
    expect(session?.parentSessionId).toBe("session-attempt-1");
    expect(session?.forkedFromEntryUuid).toBe("entry-x");
    expect(session?.resumeInstruction).toBe("do it again");
  });

  it("emits dag:run_recovered for observability", () => {
    createActiveRun("run-event", singleNodeDag());
    dispatchReadyNodes("run-event", new CaptureDispatcher());
    _clearActiveRuns();

    const events: unknown[] = [];
    subscribe("dag:run_recovered", (payload) => events.push(payload));

    recoverAllActiveRuns();

    expect(events).toHaveLength(1);
    const payload = events[0] as { runId: string; recoveredAt: number };
    expect(payload.runId).toBe("run-event");
    expect(payload.recoveredAt).toBeGreaterThan(0);
  });

  it("restores a run directly via restoreActiveRun from metadata", () => {
    createActiveRun("run-direct", singleNodeDag());
    dispatchReadyNodes("run-direct", new CaptureDispatcher());
    _clearActiveRuns();

    const metadata = loadRunMetadata("run-direct")!;
    const result = restoreActiveRun(metadata);

    expect(result.status).toBe("restored");
    if (result.status === "restored") {
      expect(result.run.runId).toBe("run-direct");
      expect(result.demotedFromRunning).toEqual(["work"]);
    }
  });

  it("terminalizes a recovered run stranded on an untaken settled branch", () => {
    createActiveRun("run-settled-pending", chainedDag());
    const beforeRestart = getActiveRun("run-settled-pending")!;
    beforeRestart.dagRun.nodeStates.set("coder", "SKIPPED");
    beforeRestart.dagRun.nodeStates.set("review", "PENDING");
    beforeRestart.dagRun.afterSatisfied.set("review", new Set());
    beforeRestart.dagRun.inputSatisfied.set("review", new Set());
    beforeRestart.dagRun.mailboxes.set("review", new Map());
    writeRunMetadata("run-settled-pending", serializeRunMetadata(beforeRestart));
    _clearActiveRuns();

    expect(recoverAllActiveRuns()).toMatchObject({ recovered: ["run-settled-pending"], failed: [] });
    const recovered = getActiveRun("run-settled-pending");
    expect(recovered?.dagRun.nodeStates.get("review")).toBe("SKIPPED");
    expect(recovered?.status).toBe("completed");
    expect(loadRunMetadata("run-settled-pending")?.status).toBe("completed");
  });

  it("fills newly added counter collections when restoring older metadata", () => {
    createActiveRun("run-old-counters", singleNodeDag());
    const metadata = loadRunMetadata("run-old-counters")!;
    if (metadata.counters) {
      delete (metadata.counters as Partial<typeof metadata.counters> & { gateway_results?: unknown }).gateway_results;
    }
    writeRunMetadata("run-old-counters", metadata);
    _clearActiveRuns();

    const result = restoreActiveRun(loadRunMetadata("run-old-counters")!);

    expect(result.status).toBe("restored");
    if (result.status === "restored") {
      expect(result.run.counters.gateway_results).toEqual({});
    }
  });

  it("restores the full node session index for every node in the run", () => {
    createActiveRun("run-multi-session", chainedDag());
    dispatchReadyNodes("run-multi-session", new CaptureDispatcher());
    handoffActiveRun(
      "run-multi-session",
      "coder",
      "done",
      "coder-done",
    );
    dispatchReadyNodes("run-multi-session", new CaptureDispatcher());
    _clearActiveRuns();

    recoverAllActiveRuns();

    const run = getActiveRun("run-multi-session")!;
    const restoredIds = new Set(run.nodeSessions.keys());
    expect(restoredIds).toEqual(new Set(["coder", "review"]));
    // Cross-check against the persisted index.
    expect(listDagSessionIndex("run-multi-session").length).toBe(2);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
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

  it("fails recovery when orphan demotion leaves only blocked pending nodes", () => {
    createActiveRun("run-blocked-after-restart", blockedDownstreamDag());
    dispatchReadyNodes("run-blocked-after-restart", new CaptureDispatcher());

    _clearActiveRuns();
    const summary = recoverAllActiveRuns();

    const run = getActiveRun("run-blocked-after-restart")!;
    expect(summary.failed).toContain("run-blocked-after-restart");
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
    expect(summary.failed).toContain("run-legacy-recovery-state");
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

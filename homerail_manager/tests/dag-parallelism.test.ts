import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  DAGDispatcher,
  DispatchEnvelope,
  DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  cancelActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  dispatchRecoveredRuns,
  failActiveRun,
  getActiveRun,
  handoffActiveRun,
  markNodeDispatched,
  recoverAllActiveRuns,
  requestNodeCorrection,
} from "../src/runtime/active-runs.js";

class CaptureDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }
}

function threeEntryDag(maxParallelism = 1) {
  return parseDAGYaml(`
name: workflow-parallelism
workflow_id: workflow-parallelism
limits:
  max_parallelism: ${maxParallelism}
  max_corrections_per_node: 1
agents:
  worker: { agent_type: deterministic }
nodes:
  alpha:
    agent: worker
    outputs: { done: { to: "" } }
  beta:
    agent: worker
    outputs: { done: { to: "" } }
  gamma:
    agent: worker
    outputs: { done: { to: "" } }
`);
}

describe("workflow max_parallelism", () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-parallelism-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllDispatches();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllDispatches();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("projects WorkflowSpec policies.max_parallelism into runtime limits", () => {
    const parsed = parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: projected-parallelism, name: Projected Parallelism }
spec:
  policies: { max_parallelism: 1 }
  contracts: { Task: { type: string } }
  agents: { worker: { system: Work. } }
  nodes:
    work:
      kind: agent
      agent: worker
      inputs: { task: { contract: Task } }
      outputs: { result: {} }
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: work.task }
    - { from: work.result, to: done.result }
`);

    expect(parsed.meta.limits).toMatchObject({ max_parallelism: 1 });
  });

  it("keeps workflow and fan-out parallelism as independent limits", () => {
    const parsed = parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: layered-parallelism, name: Layered Parallelism }
spec:
  policies: { max_parallelism: 1 }
  contracts: { Items: { type: array } }
  agents: { worker: { system: Work. } }
  nodes:
    fan:
      kind: fanout
      inputs: { items: { contract: Items } }
      outputs: { passed: {}, failed: {} }
      config:
        input: items
        worker_agent: worker
        max_items: 3
        max_parallelism: 3
        completion: all
        result_port: passed
        failed_port: failed
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: fan.items }
    - { from: fan.passed, to: done.result }
    - { from: fan.failed, to: failed.result, condition: on_failure }
`);

    expect(parsed.meta.limits).toMatchObject({ max_parallelism: 1 });
    expect(parsed.graph.nodes.find((node) => node.node_id === "fan")?.gateway_config)
      .toMatchObject({ max_parallelism: 3 });
  });

  it("admits only one of three ready entry nodes and releases capacity on retry, terminal, and cancellation", () => {
    const runId = "bounded-three-entry";
    const dispatcher = new CaptureDispatcher();
    createActiveRun(runId, threeEntryDag());

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.map((entry) => entry.nodeId)).toEqual(["alpha"]);
    expect(Array.from(getActiveRun(runId)!.dagRun.nodeStates.values()).filter((state) => state === "RUNNING"))
      .toHaveLength(1);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(0);

    expect(requestNodeCorrection(runId, "alpha", "retry the same actor")).toMatchObject({ status: "scheduled" });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.map((entry) => entry.nodeId)).toEqual(["alpha", "alpha"]);
    expect(Array.from(getActiveRun(runId)!.dagRun.nodeStates.values()).filter((state) => state === "RUNNING"))
      .toHaveLength(1);

    handoffActiveRun(runId, "alpha", "done", { ok: true });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("beta");

    failActiveRun(runId, "beta", "expected test failure");
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("gamma");
    expect(Array.from(getActiveRun(runId)!.dagRun.nodeStates.values()).filter((state) => state === "RUNNING"))
      .toHaveLength(1);

    expect(cancelActiveRun(runId)?.status).toBe("cancelled");
    const afterCancel = new CaptureDispatcher();
    createActiveRun("bounded-after-cancel", threeEntryDag());
    expect(dispatchReadyNodes("bounded-after-cancel", afterCancel)).toBe(1);
    expect(afterCancel.dispatched.map((entry) => entry.nodeId)).toEqual(["alpha"]);
  });

  it("enforces the same limit for direct dispatch admission", () => {
    const runId = "bounded-direct-admission";
    createActiveRun(runId, threeEntryDag());

    expect(markNodeDispatched(runId, "alpha")).toBe(true);
    expect(markNodeDispatched(runId, "beta")).toBe(false);

    handoffActiveRun(runId, "alpha", "done", { ok: true });
    expect(markNodeDispatched(runId, "beta")).toBe(true);
  });

  it("restores the limit without leaking an orphaned running slot", () => {
    const runId = "bounded-recovery";
    const beforeRestart = new CaptureDispatcher();
    createActiveRun(runId, threeEntryDag());
    expect(dispatchReadyNodes(runId, beforeRestart)).toBe(1);

    _clearActiveRuns();
    const recovery = recoverAllActiveRuns();
    expect(recovery.recovered).toEqual([runId]);
    expect(getActiveRun(runId)).toMatchObject({ limits: { max_parallelism: 1 } });

    const afterRestart = new CaptureDispatcher();
    expect(dispatchRecoveredRuns(afterRestart)).toBe(1);
    expect(afterRestart.dispatched.map((entry) => entry.nodeId)).toEqual(["beta"]);
    expect(Array.from(getActiveRun(runId)!.dagRun.nodeStates.values()).filter((state) => state === "RUNNING"))
      .toHaveLength(1);
  });
});

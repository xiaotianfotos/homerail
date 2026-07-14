import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  failActiveRun,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";

function failureBranchYaml(): string {
  return `
name: failure-routing
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    agent: worker
    outputs:
      done:
        to: success.in:task
      error:
        to: recovery.in:task
  success:
    agent: worker
    after: [start]
    outputs:
      done:
        to: ""
  recovery:
    agent: worker
    after: [start]
    outputs:
      done:
        to: ""
`;
}

describe("DAG failure routing", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-failure-routing-"));
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
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("marks failure ports as on_failure edges while preserving success edges", () => {
    const parsed = parseDAGYaml(failureBranchYaml());

    expect(parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "start",
      from_port: "done",
      to_node: "success",
      condition: "on_success",
    }));
    expect(parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "start",
      from_port: "error",
      to_node: "recovery",
      condition: "on_failure",
    }));
  });

  it.each(["blocked", "stale"])("treats the %s port as a failure route", (port) => {
    const parsed = parseDAGYaml(`
name: negative-routing
agents:
  worker: { agent_type: deterministic }
nodes:
  start:
    agent: worker
    outputs:
      ${port}: { to: recovery.in:task }
  recovery:
    agent: worker
    after: [start]
    outputs: { done: { to: "" } }
`);

    expect(parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "start",
      from_port: port,
      to_node: "recovery",
      condition: "on_failure",
    }));
    createActiveRun(`run-${port}`, parsed);
    expect(handoffActiveRun(`run-${port}`, "start", port, { reason: port })?.dagRun.nodeStates.get("recovery"))
      .toBe("READY");
  });

  it("skips the failure branch when a node handoffs on a success port", () => {
    const parsed = parseDAGYaml(failureBranchYaml());
    createActiveRun("run-success", parsed);

    const run = handoffActiveRun("run-success", "start", "done", "ok");

    expect(run?.status).toBe("active");
    expect(run?.dagRun.nodeStates.get("start")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("READY");
    expect(run?.dagRun.nodeStates.get("recovery")).toBe("SKIPPED");
  });

  it("routes a failure-port handoff to the recovery branch and skips success dependents", () => {
    const parsed = parseDAGYaml(failureBranchYaml());
    createActiveRun("run-failure-branch", parsed);

    const run = handoffActiveRun("run-failure-branch", "start", "error", { reason: "boom" });

    expect(run?.status).toBe("active");
    expect(run?.dagRun.nodeStates.get("start")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("recovery")).toBe("READY");

    const dispatcher = new FakeDAGDispatcher();
    const count = dispatchReadyNodes("run-failure-branch", dispatcher);
    expect(count).toBe(1);
    expect(dispatcher.dispatched[0]).toMatchObject({
      runId: "run-failure-branch",
      nodeId: "recovery",
      inputs: { task: [{ reason: "boom" }] },
    });
  });

  it("marks a terminal failure-port handoff as a failed run", () => {
    const parsed = parseDAGYaml(`
name: terminal-failure-routing
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    agent: worker
    outputs:
      error:
        to: ""
  success:
    agent: worker
    after: [start]
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-terminal-failure", parsed);

    const run = handoffActiveRun("run-terminal-failure", "start", "error", "failed");

    expect(run?.status).toBe("failed");
    expect(run?.dagRun.nodeStates.get("start")).toBe("FAILED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("SKIPPED");
  });

  it("fails immediately when a terminal failure leaves a while source open", () => {
    const parsed = parseDAGYaml(`
name: terminal-failure-open-loop
agents:
  worker:
    agent_type: deterministic
nodes:
  gate:
    type: while_gateway
    gateway_config:
      field: score
      operator: gte
      value: 1
      max_iterations: 2
      continue_port: improve
      done_port: reached
      exhausted_port: exhausted
    outputs:
      improve:
        to: rollback.in:task
      reached:
        to: success.in:result
      exhausted:
        to: exhausted.in:result
  rollback:
    agent: worker
    after: [gate]
    outputs:
      retry:
        to: gate.in:measurement
        retry_policy:
          max_retries: 2
      error:
        to: ""
  success:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: ""
  exhausted:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-terminal-failure-open-loop", parsed);
    expect(dispatchReadyNodes("run-terminal-failure-open-loop", new FakeDAGDispatcher())).toBe(1);
    expect(getActiveRun("run-terminal-failure-open-loop")?.dagRun.nodeStates.get("gate")).toBe("RUNNING");

    const run = handoffActiveRun("run-terminal-failure-open-loop", "rollback", "error", { reason: "rollback failed" });

    expect(run?.status).toBe("failed");
    expect(run?.dagRun.nodeStates.get("rollback")).toBe("FAILED");
    expect(run?.dagRun.nodeStates.get("gate")).toBe("CANCELLED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("exhausted")).toBe("SKIPPED");
  });

  it("keeps the run active when node_error has an on_failure recovery branch", () => {
    const parsed = parseDAGYaml(failureBranchYaml());
    createActiveRun("run-node-error-branch", parsed);

    const run = failActiveRun("run-node-error-branch", "start", "agent ended without DAG handoff");

    expect(run?.status).toBe("active");
    expect(run?.dagRun.nodeStates.get("start")).toBe("FAILED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("recovery")).toBe("READY");

    const dispatcher = new FakeDAGDispatcher();
    const count = dispatchReadyNodes("run-node-error-branch", dispatcher);
    expect(count).toBe(1);
    expect(dispatcher.dispatched[0]).toMatchObject({
      runId: "run-node-error-branch",
      nodeId: "recovery",
      inputs: { task: [{ error: "agent ended without DAG handoff" }] },
    });
    expect(getActiveRun("run-node-error-branch")?.dagRun.nodeStates.get("recovery")).toBe("RUNNING");
  });
});

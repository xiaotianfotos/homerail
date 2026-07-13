import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { _clearListeners } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";

function conditionGatewayYaml(): string {
  return `
name: condition-gateway
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    agent: worker
    outputs:
      done:
        to: gate.in:decision
  gate:
    type: gateway
    gateway_config:
      type: condition
      field: status
      routes:
        pass: approved
        fail: rejected
      default_port: rejected
    after: [start]
    outputs:
      approved:
        to: good.in:task
      rejected:
        to: bad.in:task
  good:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: ""
  bad:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: ""
`;
}

function loopGatewayYaml(): string {
  return `
name: loop-gateway
agents:
  worker:
    agent_type: deterministic
nodes:
  loop:
    type: loop_gateway
    gateway_config:
      items: [alpha, beta]
      item_port: next_item
      result_port: worker_done
      done_port: done
    outputs:
      next_item:
        to: worker.in:task
      done:
        to: summary.in:result
  worker:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: loop.in:worker_done
  summary:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: ""
`;
}

function loopGatewayWithDoneDescendantYaml(): string {
  return `
name: loop-gateway-done-descendant
agents:
  worker:
    agent_type: deterministic
nodes:
  loop:
    type: loop_gateway
    gateway_config:
      items: [alpha, beta]
      item_port: next_item
      result_port: worker_done
      done_port: done
    outputs:
      next_item:
        to: worker.in:task
      done:
        to: summary.in:result
  worker:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: loop.in:worker_done
  summary:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: recorded.in:result
  recorded:
    agent: worker
    after: [summary]
    outputs:
      done:
        to: ""
`;
}

function multiNodeLoopBodyYaml(): string {
  return `
name: multi-node-loop-body
agents:
  worker:
    agent_type: deterministic
nodes:
  loop:
    type: loop_gateway
    gateway_config:
      items: [alpha, beta]
      item_port: next_item
      result_port: body_done
      done_port: done
    outputs:
      next_item:
        to: worker.in:task
      done:
        to: summary.in:result
  worker:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: measure.in:result
  measure:
    agent: worker
    after: [loop, worker]
    outputs:
      done:
        to: loop.in:body_done
  summary:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: ""
`;
}

function joinGatewayYaml(mode = "n_of_m", threshold = 2): string {
  return `
name: join-gateway
agents:
  worker:
    agent_type: deterministic
nodes:
  voter_one:
    agent: worker
    outputs:
      vote:
        to: join.in:one
  voter_two:
    agent: worker
    outputs:
      vote:
        to: join.in:two
  voter_three:
    agent: worker
    outputs:
      vote:
        to: join.in:three
  join:
    type: join_gateway
    gateway_config:
      mode: ${mode}
      threshold: ${threshold}
      field: decision
      success_values: [approve]
      passed_port: accepted
      failed_port: rejected
    after: [voter_one, voter_two, voter_three]
    outputs:
      accepted:
        to: accepted.in:result
      rejected:
        to: rejected.in:result
  accepted:
    agent: worker
    after: [join]
    outputs:
      done:
        to: ""
  rejected:
    agent: worker
    after: [join]
    outputs:
      done:
        to: ""
`;
}

function whileGatewayYaml(maxIterations = 2, maxRetries = 2): string {
  return `
name: while-gateway
agents:
  worker:
    agent_type: deterministic
nodes:
  gate:
    type: while_gateway
    gateway_config:
      field: score
      operator: gte
      value: 3
      max_iterations: ${maxIterations}
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
        to: gate.in:measurement
        retry_policy:
          max_retries: ${maxRetries}
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
`;
}

class CollectingDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: `fake-${this.dispatched.length}` };
  }
}

describe("DAG gateway nodes", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-gateway-"));
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

  it("routes condition gateways to the selected output and skips untaken branches", () => {
    const parsed = parseDAGYaml(conditionGatewayYaml());
    createActiveRun("run-condition-gateway", parsed);
    handoffActiveRun("run-condition-gateway", "start", "done", { status: "pass" });

    expect(dispatchReadyNodes("run-condition-gateway", new FakeDAGDispatcher())).toBe(1);

    const run = getActiveRun("run-condition-gateway");
    expect(run?.dagRun.nodeStates.get("gate")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("good")).toBe("READY");
    expect(run?.dagRun.nodeStates.get("bad")).toBe("SKIPPED");
  });

  it("accepts JSON-string handoffs from model-backed agents at gateway boundaries", () => {
    const parsed = parseDAGYaml(conditionGatewayYaml());
    createActiveRun("run-condition-json-string", parsed);
    handoffActiveRun("run-condition-json-string", "start", "done", JSON.stringify({ status: "pass" }));

    expect(dispatchReadyNodes("run-condition-json-string", new FakeDAGDispatcher())).toBe(1);
    const run = getActiveRun("run-condition-json-string");
    expect(run?.dagRun.nodeStates.get("good")).toBe("READY");
    expect(run?.dagRun.nodeStates.get("bad")).toBe("SKIPPED");
  });

  it("contains gateway output contract violations to the affected run", () => {
    const parsed = parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: gateway-contract-containment, name: Gateway contract containment }
spec:
  contracts:
    Text: { type: string }
  agents:
    worker: { system: Produce one result. }
  nodes:
    start:
      kind: agent
      agent: worker
      outputs: { done: {} }
    gate:
      kind: condition
      inputs: { decision: {} }
      outputs: { approved: { contract: Text } }
      config:
        field: status
        routes: { pass: approved }
        default: approved
    accepted:
      kind: terminal
      outcome: success
      inputs: { result: { contract: Text } }
  edges:
    - { from: start.done, to: gate.decision }
    - { from: gate.approved, to: accepted.result }
`);
    createActiveRun("run-gateway-contract-containment", parsed);
    handoffActiveRun("run-gateway-contract-containment", "start", "done", { status: "pass" });

    expect(() => dispatchReadyNodes(
      "run-gateway-contract-containment",
      new FakeDAGDispatcher(),
    )).not.toThrow();
    expect(getActiveRun("run-gateway-contract-containment")).toMatchObject({ status: "failed" });
    expect(getActiveRun("run-gateway-contract-containment")?.dagRun.nodeStates.get("gate")).toBe("FAILED");
  });

  it("iterates a JSON-string item array emitted by a model-backed loader", () => {
    const parsed = parseDAGYaml(`
name: loop-json-string
agents:
  worker:
    agent_type: deterministic
nodes:
  load:
    agent: worker
    outputs:
      items:
        to: loop.in:items
  loop:
    type: loop_gateway
    after: [load]
    outputs:
      next_item:
        to: worker.in:task
      done:
        to: ""
  worker:
    agent: worker
    after: [loop]
    outputs:
      done:
        to: loop.in:result
`);
    createActiveRun("run-loop-json-string", parsed);
    handoffActiveRun("run-loop-json-string", "load", "items", JSON.stringify(["alpha", "beta"]));

    expect(dispatchReadyNodes("run-loop-json-string", new FakeDAGDispatcher())).toBe(1);
    expect(getActiveRun("run-loop-json-string")?.dagRun.mailboxes.get("worker")?.get("task")?.[0]).toMatchObject({
      item: "alpha",
      index: 0,
      total: 2,
    });
  });

  it("drains a gateway transition and dispatches the newly opened agent in one executor tick", () => {
    const parsed = parseDAGYaml(conditionGatewayYaml());
    const dispatcher = new CollectingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun("run-condition-drain", parsed);
    handoffActiveRun("run-condition-drain", "start", "done", { status: "pass" });

    expect(executor.tick("run-condition-drain")).toBe(2);
    expect(dispatcher.dispatched.map((item) => item.nodeId)).toEqual(["good"]);
    expect(getActiveRun("run-condition-drain")?.dagRun.nodeStates.get("good")).toBe("RUNNING");
  });

  it("recursively skips descendants of an untaken gateway branch", () => {
    const parsed = parseDAGYaml(`
name: branch-skip-propagation
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    agent: worker
    outputs:
      done:
        to: gate.in:decision
  gate:
    type: condition_gateway
    gateway_config:
      field: status
      routes:
        pass: approved
        fail: rejected
    after: [start]
    outputs:
      approved:
        to: approved.in:task
      rejected:
        to: rejected.in:task
  approved:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: approved_terminal.in:result
      failed:
        to: approved_failure_terminal.in:error
  approved_terminal:
    agent: worker
    after: [approved]
    outputs:
      done:
        to: ""
  approved_failure_terminal:
    agent: worker
    after: [approved]
    outputs:
      done:
        to: ""
  rejected:
    agent: worker
    after: [gate]
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-branch-skip-propagation", parsed);
    handoffActiveRun("run-branch-skip-propagation", "start", "done", { status: "fail" });

    expect(dispatchReadyNodes("run-branch-skip-propagation", new FakeDAGDispatcher())).toBe(1);
    const run = getActiveRun("run-branch-skip-propagation");
    expect(run?.dagRun.nodeStates.get("approved")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("approved_terminal")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("approved_failure_terminal")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("rejected")).toBe("READY");
  });

  it("iterates loop gateways over configured items and then opens the done branch", () => {
    const parsed = parseDAGYaml(loopGatewayYaml());
    createActiveRun("run-loop-gateway", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-loop-gateway", dispatcher)).toBe(1);
    expect(getActiveRun("run-loop-gateway")?.dagRun.nodeStates.get("worker")).toBe("READY");

    expect(dispatchReadyNodes("run-loop-gateway", dispatcher)).toBe(1);
    expect(dispatcher.dispatched[0].inputs.task[0]).toMatchObject({ item: "alpha", index: 0, total: 2 });
    handoffActiveRun("run-loop-gateway", "worker", "done", JSON.stringify({ item: "alpha", result: "pass" }));

    expect(dispatchReadyNodes("run-loop-gateway", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-loop-gateway", dispatcher)).toBe(1);
    expect(dispatcher.dispatched[1].inputs.task[0]).toMatchObject({ item: "beta", index: 1, total: 2 });
    handoffActiveRun("run-loop-gateway", "worker", "done", JSON.stringify({ item: "beta", result: "pass" }));

    expect(dispatchReadyNodes("run-loop-gateway", dispatcher)).toBe(1);
    const run = getActiveRun("run-loop-gateway");
    expect(run?.dagRun.nodeStates.get("loop")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("summary")).toBe("READY");
    const expectedResults = [
      { item: "alpha", result: "pass" },
      { item: "beta", result: "pass" },
    ];
    expect(run?.counters.gateway_results.loop).toEqual(expectedResults);
    expect(run?.dagRun.mailboxes.get("summary")?.get("result")?.[0]).toEqual({
      total: 2,
      completed: true,
      results: expectedResults,
    });
  });

  it("does not skip a future loop output or its descendants during iteration", () => {
    const parsed = parseDAGYaml(loopGatewayWithDoneDescendantYaml());
    createActiveRun("run-loop-future-branch", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    expect(getActiveRun("run-loop-future-branch")?.dagRun.nodeStates.get("summary")).toBe("PENDING");
    expect(getActiveRun("run-loop-future-branch")?.dagRun.nodeStates.get("recorded")).toBe("PENDING");
    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    handoffActiveRun("run-loop-future-branch", "worker", "done", { item: "alpha", result: "pass" });

    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    handoffActiveRun("run-loop-future-branch", "worker", "done", { item: "beta", result: "pass" });

    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    expect(getActiveRun("run-loop-future-branch")?.dagRun.nodeStates.get("summary")).toBe("READY");
    expect(getActiveRun("run-loop-future-branch")?.dagRun.nodeStates.get("recorded")).toBe("PENDING");
    expect(dispatchReadyNodes("run-loop-future-branch", dispatcher)).toBe(1);
    handoffActiveRun("run-loop-future-branch", "summary", "done", { persisted: true });
    expect(getActiveRun("run-loop-future-branch")?.dagRun.nodeStates.get("recorded")).toBe("READY");
  });

  it("resets every node in a multi-node loop body for the next iteration", () => {
    const parsed = parseDAGYaml(multiNodeLoopBodyYaml());
    createActiveRun("run-multi-node-loop", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-multi-node-loop", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-multi-node-loop", dispatcher)).toBe(1);
    handoffActiveRun("run-multi-node-loop", "worker", "done", { item: "alpha" });
    expect(getActiveRun("run-multi-node-loop")?.dagRun.nodeStates.get("measure")).toBe("READY");
    expect(dispatchReadyNodes("run-multi-node-loop", dispatcher)).toBe(1);
    handoffActiveRun("run-multi-node-loop", "measure", "done", { item: "alpha", result: "pass" });

    expect(dispatchReadyNodes("run-multi-node-loop", dispatcher)).toBe(1);
    expect(getActiveRun("run-multi-node-loop")?.dagRun.nodeStates.get("worker")).toBe("READY");
    expect(getActiveRun("run-multi-node-loop")?.dagRun.nodeStates.get("measure")).toBe("PENDING");
    expect(dispatchReadyNodes("run-multi-node-loop", dispatcher)).toBe(1);
    handoffActiveRun("run-multi-node-loop", "worker", "done", { item: "beta" });
    expect(getActiveRun("run-multi-node-loop")?.dagRun.nodeStates.get("measure")).toBe("READY");
  });

  it("aggregates n-of-m join inputs and opens the passing branch", () => {
    const parsed = parseDAGYaml(joinGatewayYaml());
    createActiveRun("run-join-passed", parsed);

    handoffActiveRun("run-join-passed", "voter_one", "vote", { decision: "approve" });
    handoffActiveRun("run-join-passed", "voter_two", "vote", { decision: "reject" });
    handoffActiveRun("run-join-passed", "voter_three", "vote", { decision: "approve" });

    expect(dispatchReadyNodes("run-join-passed", new FakeDAGDispatcher())).toBe(1);
    const run = getActiveRun("run-join-passed");
    expect(run?.dagRun.nodeStates.get("join")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("accepted")).toBe("READY");
    expect(run?.dagRun.nodeStates.get("rejected")).toBe("SKIPPED");
    expect(run?.dagRun.mailboxes.get("accepted")?.get("result")?.[0]).toMatchObject({
      mode: "n_of_m",
      total: 3,
      successes: 2,
      threshold: 2,
      passed: true,
    });
  });

  it("opens the failing join branch when the quorum is not met", () => {
    const parsed = parseDAGYaml(joinGatewayYaml());
    createActiveRun("run-join-failed", parsed);

    handoffActiveRun("run-join-failed", "voter_one", "vote", { decision: "approve" });
    handoffActiveRun("run-join-failed", "voter_two", "vote", { decision: "reject" });
    handoffActiveRun("run-join-failed", "voter_three", "vote", { decision: "reject" });

    expect(dispatchReadyNodes("run-join-failed", new FakeDAGDispatcher())).toBe(1);
    const run = getActiveRun("run-join-failed");
    expect(run?.dagRun.nodeStates.get("accepted")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("rejected")).toBe("READY");
  });

  it("repeats a while gateway until its completion predicate matches", () => {
    const parsed = parseDAGYaml(whileGatewayYaml());
    createActiveRun("run-while-complete", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-while-complete", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-complete", dispatcher)).toBe(1);
    handoffActiveRun("run-while-complete", "worker", "measured", { score: 1 });

    expect(dispatchReadyNodes("run-while-complete", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-complete", dispatcher)).toBe(1);
    handoffActiveRun("run-while-complete", "worker", "measured", { score: 3 });

    expect(dispatchReadyNodes("run-while-complete", dispatcher)).toBe(1);
    const run = getActiveRun("run-while-complete");
    expect(run?.dagRun.nodeStates.get("gate")).toBe("COMPLETED");
    expect(run?.dagRun.nodeStates.get("success")).toBe("READY");
    expect(run?.dagRun.nodeStates.get("exhausted")).toBe("SKIPPED");
    expect(run?.counters.gateway_iterations.gate).toBe(2);
  });

  it("routes a while gateway to exhausted after its iteration limit", () => {
    const parsed = parseDAGYaml(whileGatewayYaml());
    createActiveRun("run-while-exhausted", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-while-exhausted", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-exhausted", dispatcher)).toBe(1);
    handoffActiveRun("run-while-exhausted", "worker", "measured", { score: 1 });
    expect(dispatchReadyNodes("run-while-exhausted", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-exhausted", dispatcher)).toBe(1);
    handoffActiveRun("run-while-exhausted", "worker", "measured", { score: 2 });

    expect(dispatchReadyNodes("run-while-exhausted", dispatcher)).toBe(1);
    const run = getActiveRun("run-while-exhausted");
    expect(run?.dagRun.nodeStates.get("success")).toBe("SKIPPED");
    expect(run?.dagRun.nodeStates.get("exhausted")).toBe("READY");
  });

  it("enforces an edge-specific retry limit on feedback edges", () => {
    const parsed = parseDAGYaml(whileGatewayYaml(5, 1));
    createActiveRun("run-while-retry-limit", parsed);
    const dispatcher = new CollectingDispatcher();

    expect(dispatchReadyNodes("run-while-retry-limit", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-retry-limit", dispatcher)).toBe(1);
    handoffActiveRun("run-while-retry-limit", "worker", "measured", { score: 1 });
    expect(dispatchReadyNodes("run-while-retry-limit", dispatcher)).toBe(1);
    expect(dispatchReadyNodes("run-while-retry-limit", dispatcher)).toBe(1);

    expect(() => handoffActiveRun(
      "run-while-retry-limit",
      "worker",
      "measured",
      { score: 2 },
    )).toThrow("edge retry limit (1) exceeded");
    expect(getActiveRun("run-while-retry-limit")?.status).toBe("failed");
  });
});

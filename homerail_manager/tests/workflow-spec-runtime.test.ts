import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import {
  FakeDAGDispatcher,
  type DAGDispatcher,
  type DispatchEnvelope,
  type DispatchResult,
} from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { parseWorkflowSourceFile } from "../src/orchestration/workflow-spec-v1.js";
import {
  _clearDagWorkflowTablesForTest,
  upsertDagRuntimeProfileFromYaml,
  upsertDagWorkflowFromYaml,
} from "../src/persistence/dag-workflows.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunMetadata } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
  requestNodeCorrection,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";

function workflowSource(outcome: "success" | "failure" | "cancelled" = "success"): string {
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: v1-runtime-${outcome}, name: V1 Runtime ${outcome} }
spec:
  contracts:
    Text:
      type: string
      maxLength: 100
  agents:
    worker: { system: Return a short result. }
  nodes:
    execute:
      kind: agent
      agent: worker
      allowed_builtin_tools: [Write]
      allowed_dag_tools: [handoff]
      inputs: { task: { contract: Text } }
      outputs: { result: { contract: Text } }
    terminal:
      kind: terminal
      outcome: ${outcome}
      inputs: { result: { contract: Text } }
  edges:
    - { from: $run.input, to: execute.task }
    - { from: execute.result, to: terminal.result }
`;
}

function publicV1Asset(file: string) {
  const parsed = parseWorkflowSourceFile(path.resolve("..", "assets", "orchestrations", file));
  parsed.meta.agents = Object.fromEntries(Object.entries(parsed.meta.agents ?? {}).map(([id, agent]) => [
    id,
    { ...agent, agent_type: "deterministic" },
  ]));
  return parsed;
}

class RepeatableDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: `fake-${this.dispatched.length}` };
  }
}

describe("WorkflowSpec v1 runtime projection", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workflow-spec-runtime-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearDagWorkflowTablesForTest();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearDagWorkflowTablesForTest();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("runs a synced v1 workflow from its immutable canonical revision", () => {
    const synced = upsertDagWorkflowFromYaml({ yaml_text: workflowSource() });
    syncDeterministicProfile("v1-runtime-success");
    const dispatcher = new FakeDAGDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    const created = orchestrator.createAndRun({
      workflowId: "v1-runtime-success",
      runId: "v1-runtime-run",
      prompt: "hello",
      profile: "deterministic",
    });

    expect(created).toMatchObject({
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      sourceApiVersion: "homerail.ai/v1",
      dispatched: 1,
    });
    expect(dispatcher.dispatched[0].inputs).toMatchObject({ task: ["hello"] });
    expect(dispatcher.dispatched[0].allowedBuiltinTools).toEqual(["Write"]);
    expect(dispatcher.dispatched[0].allowedDagTools).toEqual(["handoff"]);

    const completed = handoffActiveRun(created.runId, "execute", "result", "verified");
    expect(completed?.status).toBe("completed");
    expect(loadRunMetadata(created.runId)).toMatchObject({
      status: "completed",
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      contracts: { Text: { type: "string", maxLength: 100 } },
    });
  });

  it("keeps a contract-invalid handoff recoverable for bounded correction", () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflowSource() });
    syncDeterministicProfile("v1-runtime-success");
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const created = orchestrator.createAndRun({
      workflowId: "v1-runtime-success",
      runId: "v1-contract-failure",
      prompt: "hello",
      profile: "deterministic",
    });

    expect(() => handoffActiveRun(created.runId, "execute", "result", { invalid: true }))
      .toThrow("DAG_HANDOFF_CONTRACT_VIOLATION execute.result (Text)");
    expect(getActiveRun(created.runId)?.status).toBe("active");
    expect(loadRunMetadata(created.runId)?.nodeStates.execute).toBe("RUNNING");
    expect(requestNodeCorrection(created.runId, "execute", "invalid result contract").status).toBe("scheduled");
    expect(handoffActiveRun(created.runId, "execute", "result", "verified")?.status).toBe("completed");
  });

  it.each([
    ["failure", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("honors explicit %s terminal outcome independently of port naming", (outcome, expected) => {
    upsertDagWorkflowFromYaml({ yaml_text: workflowSource(outcome) });
    syncDeterministicProfile(`v1-runtime-${outcome}`);
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const created = orchestrator.createAndRun({
      workflowId: `v1-runtime-${outcome}`,
      runId: `v1-terminal-${outcome}`,
      prompt: "hello",
      profile: "deterministic",
    });

    handoffActiveRun(created.runId, "execute", "result", "finished");
    expect(getActiveRun(created.runId)?.status).toBe(expected);
  });

  it.each([
    ["failure", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("preserves explicit %s terminal outcome across cold recovery", (outcome, expected) => {
    upsertDagWorkflowFromYaml({ yaml_text: workflowSource(outcome) });
    syncDeterministicProfile(`v1-runtime-${outcome}`);
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    const created = orchestrator.createRun({
      workflowId: `v1-runtime-${outcome}`,
      runId: `v1-recovered-terminal-${outcome}`,
      prompt: "hello",
      profile: "deterministic",
    });

    expect(loadRunMetadata(created.runId)?.graph?.edges).toContainEqual(expect.objectContaining({
      from_node: "execute",
      from_port: "result",
      terminal_outcome: outcome,
    }));
    _clearActiveRuns();
    expect(recoverAllActiveRuns().recovered).toContain(created.runId);
    expect(dispatchReadyNodes(created.runId, new FakeDAGDispatcher())).toBe(1);

    handoffActiveRun(created.runId, "execute", "result", "finished");
    expect(getActiveRun(created.runId)?.status).toBe(expected);
  });

  it("rejects run input that does not satisfy the entry contract", () => {
    upsertDagWorkflowFromYaml({ yaml_text: workflowSource() });
    syncDeterministicProfile("v1-runtime-success");
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));

    expect(() => orchestrator.createRun({
      workflowId: "v1-runtime-success",
      runId: "v1-invalid-input",
      prompt: JSON.stringify({ not: "text" }),
      profile: "deterministic",
    })).toThrow("DAG_RUN_INPUT_CONTRACT_VIOLATION execute.task");
  });

  it("cold-recovers v1 provenance, contracts, and reserved run input", () => {
    const synced = upsertDagWorkflowFromYaml({ yaml_text: workflowSource() });
    syncDeterministicProfile("v1-runtime-success");
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    orchestrator.createRun({
      workflowId: "v1-runtime-success",
      runId: "v1-cold-recovery",
      prompt: "recover me",
      profile: "deterministic",
    });

    _clearActiveRuns();
    expect(recoverAllActiveRuns()).toMatchObject({ recovered: ["v1-cold-recovery"] });
    expect(getActiveRun("v1-cold-recovery")).toMatchObject({
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      sourceApiVersion: "homerail.ai/v1",
    });
    const envelope = buildCurrentDispatchEnvelope("v1-cold-recovery", "execute");
    expect(envelope).toMatchObject({ ok: true, envelope: { inputs: { task: ["recover me"] } } });
  });

  it("runs the public fan-out and join example to success", () => {
    const executor = new GraphExecutor(new RepeatableDispatcher());
    executor.createRun(
      "v1-example-fanout",
      publicV1Asset("workflow-spec-v1-fanout.yaml.template"),
      "Review the release",
    );

    expect(executor.tick("v1-example-fanout")).toBe(1);
    handoffActiveRun("v1-example-fanout", "plan", "plan", {
      objective: "Check build and tests",
      steps: [
        "build",
        { id: "2", description: "test" },
      ],
    });
    expect(executor.tick("v1-example-fanout")).toBe(2);
    handoffActiveRun("v1-example-fanout", "worker_one", "result", { status: "success", evidence: "build passed" });
    handoffActiveRun("v1-example-fanout", "worker_two", "result", { status: "done", evidence: "tests passed" });
    expect(executor.tick("v1-example-fanout")).toBe(1);

    expect(getActiveRun("v1-example-fanout")?.status).toBe("completed");
  });

  it("runs the public condition example through its success terminal", () => {
    const executor = new GraphExecutor(new RepeatableDispatcher());
    executor.createRun(
      "v1-example-condition",
      publicV1Asset("workflow-spec-v1-condition.yaml.template"),
      "Approve a reversible release",
    );

    expect(executor.tick("v1-example-condition")).toBe(1);
    handoffActiveRun("v1-example-condition", "classify", "decision", {
      route: "approve",
      reason: "all checks passed",
    });
    expect(executor.tick("v1-example-condition")).toBe(1);

    expect(getActiveRun("v1-example-condition")?.status).toBe("completed");
  });

  it("runs the public foreach example and validates its collected summary", () => {
    const executor = new GraphExecutor(new RepeatableDispatcher());
    executor.createRun(
      "v1-example-foreach",
      publicV1Asset("workflow-spec-v1-foreach.yaml.template"),
      JSON.stringify(["alpha", "beta"]),
    );

    expect(executor.tick("v1-example-foreach")).toBe(2);
    handoffActiveRun("v1-example-foreach", "worker", "result", { item: "alpha", result: "done" });
    expect(executor.tick("v1-example-foreach")).toBe(2);
    handoffActiveRun("v1-example-foreach", "worker", "result", { item: "beta", result: "done" });
    expect(executor.tick("v1-example-foreach")).toBe(1);

    expect(getActiveRun("v1-example-foreach")?.status).toBe("completed");
    expect(getActiveRun("v1-example-foreach")?.counters.gateway_results.each).toEqual([
      { item: "alpha", result: "done" },
      { item: "beta", result: "done" },
    ]);
  });

  it("runs the public bounded-while example to explicit exhaustion", () => {
    const executor = new GraphExecutor(new RepeatableDispatcher());
    executor.createRun(
      "v1-example-while",
      publicV1Asset("workflow-spec-v1-bounded-while.yaml.template"),
      JSON.stringify({ score: 10 }),
    );

    expect(executor.tick("v1-example-while")).toBe(2);
    for (const score of [20, 30, 40]) {
      handoffActiveRun("v1-example-while", "improve", "measured", { score });
      executor.tick("v1-example-while");
    }

    expect(getActiveRun("v1-example-while")?.status).toBe("failed");
    expect(getActiveRun("v1-example-while")?.counters.gateway_iterations.target).toBe(3);
  });
});

function syncDeterministicProfile(workflowId: string): void {
  upsertDagRuntimeProfileFromYaml({
    workflow_id: workflowId,
    yaml_text: `
profile_id: deterministic
default:
  agent_type: deterministic
`,
  });
}

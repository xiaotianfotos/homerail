import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
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
  getActiveRun,
  handoffActiveRun,
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

    const completed = handoffActiveRun(created.runId, "execute", "result", "verified");
    expect(completed?.status).toBe("completed");
    expect(loadRunMetadata(created.runId)).toMatchObject({
      status: "completed",
      workflowRevision: 1,
      canonicalHash: synced.workflow.canonical_hash,
      contracts: { Text: { type: "string", maxLength: 100 } },
    });
  });

  it("fails the node when a handoff violates its named contract", () => {
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
    expect(getActiveRun(created.runId)?.status).toBe("failed");
    expect(loadRunMetadata(created.runId)?.nodeStates.execute).toBe("FAILED");
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

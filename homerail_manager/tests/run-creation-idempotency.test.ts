import * as fs from "node:fs";
import * as http from "node:http";
import { createServer } from "../src/server/http.js";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import type { CreateRunRequest } from "../src/orchestration/change-orchestrator.js";
import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import {
  _clearDagWorkflowTablesForTest,
  upsertDagRuntimeProfileFromYaml,
  upsertDagWorkflowFromYaml,
} from "../src/persistence/dag-workflows.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunMetadata, writeRunMetadata } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  cancelActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import {
  creationRequestDigest,
  RunCreationConflictError,
} from "../src/orchestration/run-creation-identity.js";


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workflowSource(workflowId: string, outcome: "success" | "failure" | "cancelled" = "success"): string {
  return `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: ${workflowId}, name: Idempotency ${workflowId} }
spec:
  policies: { max_tool_calls_per_node: 9 }
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
      max_builtin_tool_calls: 7
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

class CapturingDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Run creation idempotency", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-run-idempotency-"));
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

  function setup(workflowId = "idem-test"): { orchestrator: ChangeOrchestrator; dispatcher: CapturingDispatcher } {
    const yaml = workflowSource(workflowId);
    upsertDagWorkflowFromYaml({ yaml_text: yaml });
    syncDeterministicProfile(workflowId);
    const dispatcher = new CapturingDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    return { orchestrator, dispatcher };
  }

  // -------------------------------------------------------------------------
  // Test 1: createRun twice with same explicit runId/request returns equal
  // summary and one durable run identity/creationRequestDigest.
  // -------------------------------------------------------------------------
  it("test 1: duplicate createRun returns equal summary with one durable digest", () => {
    const { orchestrator } = setup();
    const req = { runId: "dup-1", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    const first = orchestrator.createRun(req);
    const second = orchestrator.createRun(req);

    expect(second).toEqual(first);

    const meta = loadRunMetadata("dup-1");
    expect(meta).toBeDefined();
    expect(meta!.creationRequestDigest).toBeDefined();
    expect(meta!.creationRequestDigest).toBe(creationRequestDigest(req));
  });

  // -------------------------------------------------------------------------
  // Test 2: createAndRun twice same ID dispatches exactly once (second dispatched=0).
  // -------------------------------------------------------------------------
  it("test 2: createAndRun twice dispatches exactly once", () => {
    const { orchestrator, dispatcher } = setup();
    const req = { runId: "dup-2", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    const first = orchestrator.createAndRun(req);
    expect(first.dispatched).toBe(1);

    const second = orchestrator.createAndRun(req);
    expect(second.dispatched).toBe(0);

    // Only one envelope dispatched total
    expect(dispatcher.dispatched).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 3: createRun without invoke, clear active memory and close/reopen DB,
  // then createAndRun resumes the existing initial pending node exactly once.
  // -------------------------------------------------------------------------
  it("test 3: cold recovery resumes pending node exactly once", () => {
    const { orchestrator } = setup();
    const req = { runId: "dup-3", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    // Create run without invoking (status is active but no dispatch yet from createRun)
    orchestrator.createRun(req);

    // Simulate cold start: clear memory and close/reopen DB
    _clearActiveRuns();
    closeDb();

    // Now createAndRun should resume the existing run and dispatch once
    const dispatcher2 = new CapturingDispatcher();
    const orchestrator2 = new ChangeOrchestrator(new GraphExecutor(dispatcher2));
    const result = orchestrator2.createAndRun(req);

    expect(result.dispatched).toBe(1);
    expect(dispatcher2.dispatched).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: createAndRun -> handoffActiveRun -> repeat returns completed with
  // dispatched=0 and no extra dispatcher call.
  // -------------------------------------------------------------------------
  it("test 4: completed run repeated returns dispatched=0 with no extra dispatch", () => {
    const { orchestrator, dispatcher } = setup();
    const req = { runId: "dup-4", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    const created = orchestrator.createAndRun(req);
    expect(created.dispatched).toBe(1);

    // Complete the run via handoff
    handoffActiveRun(created.runId, "execute", "result", "done");

    // Repeat: should return completed with dispatched=0
    const repeated = orchestrator.createAndRun(req);
    expect(repeated.status).toBe("completed");
    expect(repeated.dispatched).toBe(0);

    // No extra dispatcher calls
    expect(dispatcher.dispatched).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: cancelActiveRun then clear memory/closeDb -> repeat returns cancelled,
  // no new dispatch; original digest survives.
  // -------------------------------------------------------------------------
  it("test 5: cancelled run survives cold restart with no new dispatch", () => {
    const { orchestrator } = setup();
    const req = { runId: "dup-5", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    orchestrator.createAndRun(req);
    cancelActiveRun("dup-5");

    const originalMeta = loadRunMetadata("dup-5");
    const originalDigest = originalMeta!.creationRequestDigest;

    // Cold start
    _clearActiveRuns();
    closeDb();

    const dispatcher2 = new CapturingDispatcher();
    const orchestrator2 = new ChangeOrchestrator(new GraphExecutor(dispatcher2));
    const result = orchestrator2.createAndRun(req);

    expect(result.status).toBe("cancelled");
    expect(result.dispatched).toBe(0);
    expect(dispatcher2.dispatched).toHaveLength(0);

    // Original digest survives
    const metaAfter = loadRunMetadata("dup-5");
    expect(metaAfter!.creationRequestDigest).toBe(originalDigest);
  });

  // -------------------------------------------------------------------------
  // Test 6: changed semantic fields each produce request_mismatch conflict.
  // Original metadata initialPrompt and createdAt unchanged.
  // -------------------------------------------------------------------------
  it("test 6: changed semantic fields conflict with request_mismatch", () => {
    const { orchestrator } = setup();
    const baseReq: CreateRunRequest = { runId: "dup-6", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    orchestrator.createRun(baseReq);

    const originalMeta = loadRunMetadata("dup-6");
    const originalPrompt = originalMeta!.initialPrompt;
    const originalCreatedAt = originalMeta!.createdAt;

    const mutations: Array<{ label: string; mutate: (r: CreateRunRequest) => CreateRunRequest }> = [
      { label: "prompt", mutate: (r) => ({ ...r, prompt: "changed" }) },
      { label: "profile", mutate: (r) => ({ ...r, profile: "other" }) },
      { label: "llmSettingId", mutate: (r) => ({ ...r, llmSettingId: "llm-999" }) },
      { label: "expectedWorkflowRevision", mutate: (r) => ({ ...r, expectedWorkflowRevision: 99 }) },
      { label: "expectedCanonicalHash", mutate: (r) => ({ ...r, expectedCanonicalHash: "deadbeef" }) },
      { label: "expectedProfileUpdatedAt", mutate: (r) => ({ ...r, expectedProfileUpdatedAt: "2099-01-01T00:00:00Z" }) },
      { label: "inputScope", mutate: (r) => ({ ...r, inputScope: "other-scope" }) },
      { label: "inputArtifacts", mutate: (r) => ({ ...r, inputArtifacts: [{ artifact_id: "artifact-a", logical_name: "input-a", mount_path: "input/a.txt" }] }) },
    ];

    for (const { label, mutate } of mutations) {
      const mutated = mutate(baseReq);
      try {
        orchestrator.createRun(mutated);
        expect.fail(`Expected RunCreationConflictError for ${label}`);
      } catch (err) {
        expect(err).toBeInstanceOf(RunCreationConflictError);
        expect((err as RunCreationConflictError).reason).toBe("request_mismatch");
        expect((err as RunCreationConflictError).runId).toBe("dup-6");
      }
    }

    // Original metadata unchanged
    const metaAfter = loadRunMetadata("dup-6");
    expect(metaAfter!.initialPrompt).toBe(originalPrompt);
    expect(metaAfter!.createdAt).toBe(originalCreatedAt);
  });

  // -------------------------------------------------------------------------
  // Test 7: simulate old persisted metadata by deleting creationRequestDigest;
  // repeated create rejects legacy_run without altering metadata.
  // -------------------------------------------------------------------------
  it("test 7: legacy run without creationRequestDigest rejects with legacy_run", () => {
    const { orchestrator } = setup();
    const req = { runId: "dup-7", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    orchestrator.createRun(req);

    // Simulate legacy metadata: load and remove creationRequestDigest
    const meta = loadRunMetadata("dup-7");
    expect(meta).toBeDefined();
    const legacyMeta = { ...meta! };
    delete legacyMeta.creationRequestDigest;
    writeRunMetadata("dup-7", legacyMeta);

    // Verify digest is gone
    const strippedMeta = loadRunMetadata("dup-7");
    expect(strippedMeta!.creationRequestDigest).toBeUndefined();

    // Attempt to create same run: should throw legacy_run
    try {
      orchestrator.createRun(req);
      expect.fail("Expected RunCreationConflictError for legacy_run");
    } catch (err) {
      expect(err).toBeInstanceOf(RunCreationConflictError);
      expect((err as RunCreationConflictError).reason).toBe("legacy_run");
      expect((err as RunCreationConflictError).runId).toBe("dup-7");
    }

    // Metadata still has no creationRequestDigest (not altered by the error path)
    const metaFinal = loadRunMetadata("dup-7");
    expect(metaFinal!.creationRequestDigest).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 8: identical request after workflow definition changes still returns
  // the first frozen workflow revision/hash; changing requested expected
  // revision conflicts.
  // -------------------------------------------------------------------------
  it("test 8: frozen workflow revision survives definition changes", () => {
    const { orchestrator } = setup();
    const req = { runId: "dup-8", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    const first = orchestrator.createRun(req);
    const frozenRevision = first.workflowRevision;
    const frozenHash = first.canonicalHash;

    // Upsert a modified workflow (changes canonical hash)
    const modifiedYaml = workflowSource("idem-test", "failure");
    upsertDagWorkflowFromYaml({ yaml_text: modifiedYaml });

    // Identical request still returns original frozen revision/hash
    const second = orchestrator.createRun(req);
    expect(second.workflowRevision).toBe(frozenRevision);
    expect(second.canonicalHash).toBe(frozenHash);

    // Changing expectedWorkflowRevision produces a different digest -> request_mismatch
    const mutatedReq: CreateRunRequest = { ...req, expectedWorkflowRevision: 99 };
    try {
      orchestrator.createRun(mutatedReq);
      expect.fail("Expected RunCreationConflictError for changed expected revision");
    } catch (err) {
      expect(err).toBeInstanceOf(RunCreationConflictError);
      expect((err as RunCreationConflictError).reason).toBe("request_mismatch");
    }
  });

  // -------------------------------------------------------------------------
  // Test 9: creationRequestDigest ignores runId/admissionSource, canonicalizes
  // object key order in inputArtifacts, and preserves array order.
  // Different semantic values produce different hashes.
  // -------------------------------------------------------------------------
  it("test 9: creationRequestDigest ignores runId/admissionSource, canonicalizes key order", () => {
    const base = { workflowId: "w", prompt: "p", profile: "det" };

    // Ignores runId and admissionSource
    const withRunIdA = { ...base, runId: "aaa", admissionSource: "x" };
    const withRunIdB = { ...base, runId: "bbb", admissionSource: "y" };
    const without = { ...base };
    expect(creationRequestDigest(withRunIdA)).toBe(creationRequestDigest(without));
    expect(creationRequestDigest(withRunIdB)).toBe(creationRequestDigest(without));

    // Canonicalizes object key order in inputArtifacts
    const artifactsA = [
      { artifact_id: "artifact-a", logical_name: "input-a", mount_path: "input/a.txt" },
    ];
    // Same semantic content, different key insertion order
    const artifactsB = [
      { mount_path: "input/a.txt", artifact_id: "artifact-a", logical_name: "input-a" },
    ];
    const reqA = { ...base, inputArtifacts: artifactsA };
    const reqB = { ...base, inputArtifacts: artifactsB };
    expect(creationRequestDigest(reqA)).toBe(creationRequestDigest(reqB));

    // Preserves array order: different order -> different digest
    const orderedA = [
      { artifact_id: "artifact-a", logical_name: "input-a", mount_path: "input/a.txt" },
      { artifact_id: "artifact-b", logical_name: "input-b", mount_path: "input/b.txt" },
    ];
    const orderedB = [
      { artifact_id: "artifact-b", logical_name: "input-b", mount_path: "input/b.txt" },
      { artifact_id: "artifact-a", logical_name: "input-a", mount_path: "input/a.txt" },
    ];
    const reqOrdA = { ...base, inputArtifacts: orderedA };
    const reqOrdB = { ...base, inputArtifacts: orderedB };
    expect(creationRequestDigest(reqOrdA)).not.toBe(creationRequestDigest(reqOrdB));

    // Different semantic values produce different hashes
    const reqPromptDiff = { ...base, prompt: "different" };
    expect(creationRequestDigest(base)).not.toBe(creationRequestDigest(reqPromptDiff));

    const reqProfileDiff = { ...base, profile: "other" };
    expect(creationRequestDigest(base)).not.toBe(creationRequestDigest(reqProfileDiff));
  });

  // -------------------------------------------------------------------------
  // Test 10: cold-restored already-RUNNING orphan does not cause a new dispatch.
  // -------------------------------------------------------------------------
  it("test 10: cold-restored running orphan does not redispatch", () => {
    const { orchestrator, dispatcher } = setup();
    const req = { runId: "dup-10", workflowId: "idem-test", prompt: "hello", profile: "deterministic" };

    // Create and invoke: first node gets dispatched and enters running state
    const created = orchestrator.createAndRun(req);
    expect(created.dispatched).toBe(1);
    expect(dispatcher.dispatched).toHaveLength(1);

    // Simulate cold start: clear memory and close/reopen DB
    _clearActiveRuns();
    closeDb();

    // New process calls createAndRun with the same request
    const dispatcher2 = new CapturingDispatcher();
    const orchestrator2 = new ChangeOrchestrator(new GraphExecutor(dispatcher2));
    const result = orchestrator2.createAndRun(req);

    // The orphaned running node is demoted; no new dispatch should occur
    expect(dispatcher2.dispatched).toHaveLength(0);

    // Status reflects actual recovery outcome (not falsely reported as active)
    expect(result.status).not.toBe("active");
  });
  // Judger-owned HTTP acceptance. These assertions are outside the coder's write scope.
  it("HTTP creation pins revisions and replays terminal receipts without Worker resources", async () => {
    const { orchestrator } = setup();
    const first = orchestrator.createRun({ runId:"reference",workflowId:"idem-test",profile:"deterministic",prompt:"hello" });
    const server: http.Server = createServer(0, undefined, new CapturingDispatcher(), false, {autoDetectCodex:false});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address||typeof address!=="object")throw new Error("no address");
    const url=`http://127.0.0.1:${address.port}`;
    const post=async(route:string,body:unknown)=>{
      const response=await fetch(url+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json() as {data?:{status?:string;dispatched?:number;reason?:string;code?:string}}};
    };
    try {
      const request={runId:"http-pinned",workflow_id:"idem-test",profile:"deterministic",prompt:"hello",workflow_revision:first.workflowRevision,canonical_hash:first.canonicalHash};
      expect((await post("/api/runs",request)).status).toBe(201);
      expect((await post("/api/runs",{...request,workflow_revision:99}))).toMatchObject({status:409,body:{data:{reason:"request_mismatch",code:"RUN_CREATION_CONFLICT"}}});
      expect((await post("/api/runs",{...request,runId:"invalid-version",workflow_revision:0})).status).toBe(400);
      cancelActiveRun("http-pinned");
      // No dag-resources.json in this test home: a fresh invocation would be unavailable.
      const replay=await post("/api/runs/create-and-run",request);
      expect(replay).toMatchObject({status:201,body:{data:{status:"cancelled",dispatched:0}}});
      expect((await post("/api/runs/create-and-run",{...request,prompt:"different"}))).toMatchObject({status:409,body:{data:{reason:"request_mismatch"}}});
    } finally {
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });

});

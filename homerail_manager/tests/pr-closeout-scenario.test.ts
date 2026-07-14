import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { compileWorkflowSource, parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { closeDb } from "../src/persistence/db.js";
import { listPendingApprovals } from "../src/persistence/dag-runtime-primitives.js";
import { getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import { _clearActiveRuns, decideActiveRunApproval, getActiveRun } from "../src/runtime/active-runs.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";

function envelope(status: string, phase = "draft") {
  return {
    trigger_id: "manual",
    trigger_type: "manual",
    fire_key: `closeout:${status}`,
    payload: {
      repo: "xiaotianfotos/homerail",
      pr: 26,
      base: "a".repeat(40),
      head: "b".repeat(40),
      phase,
      closeout_status: status,
      blockers: [],
      evidence: [{ source: "local", status: "passed", head: "b".repeat(40) }],
    },
  };
}

describe("PR closeout scenario", () => {
  let oldHome: string | undefined;
  let tmpHome: string;
  const file = path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-closeout.yaml.template");

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-pr-closeout-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("compiles to deterministic routing plus an owner-only approval", () => {
    const result = compileWorkflowSource(fs.readFileSync(file, "utf8"));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({ workflow_id: "pr-closeout", node_count: 8, edge_count: 8 });
    expect(result.canonical?.artifacts).toEqual([
      expect.objectContaining({
        name: "pr-closeout.json",
        source: { type: "handoff", node: "artifact_snapshot", port: "snapshot" },
        contract: "CloseoutEnvelope",
      }),
    ]);
    expect(result.canonical?.nodes.every((node) => !node.agent)).toBe(true);
    expect(result.canonical?.nodes.find((node) => node.id === "merge_approval")?.config).toMatchObject({
      proposer_actor: "system:pr-closeout",
      authorized_actors: ["human:owner"],
    });
    expect(result.canonical?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: { node: "status_gate", port: "blocked" }, condition: "on_failure" }),
      expect.objectContaining({ from: { node: "status_gate", port: "stale" }, condition: "on_failure" }),
    ]));
  });

  it("completes draft closeout without a model or merge mutation", async () => {
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun("draft-closeout", parseWorkflowSource(fs.readFileSync(file, "utf8")), JSON.stringify(envelope("ready_for_review")));
    executor.tick("draft-closeout");

    expect(getActiveRun("draft-closeout")?.status).toBe("completed");
    expect(dispatcher.dispatched).toHaveLength(0);
    expect(loadRunSnapshot("draft-closeout")?.handoffs).toContainEqual(expect.objectContaining({
      fromNode: "status_gate",
      port: "ready_for_review",
    }));
    expect(await finalizeRunArtifacts("draft-closeout", "success")).toEqual([
      expect.objectContaining({ name: "pr-closeout.json", status: "ready" }),
    ]);
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath("draft-closeout", "pr-closeout.json")!, "utf8")))
      .toMatchObject({ payload: { closeout_status: "ready_for_review" } });
  });

  it("pauses a merge candidate for durable human approval", () => {
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun("merge-closeout", parseWorkflowSource(fs.readFileSync(file, "utf8")), JSON.stringify(envelope("ready_for_human_merge_candidate", "merge")));
    executor.tick("merge-closeout");

    expect(getActiveRun("merge-closeout")?.status).toBe("active");
    expect(dispatcher.dispatched).toHaveLength(0);
    expect(listPendingApprovals()).toContainEqual(expect.objectContaining({
      run_id: "merge-closeout",
      node_id: "merge_approval",
      status: "waiting",
      proposer_actor: "system:pr-closeout",
    }));
    const pending = listPendingApprovals()[0];
    decideActiveRunApproval({
      runId: "merge-closeout",
      nodeId: "merge_approval",
      decision: "approved",
      actor: "human:owner",
      proposalHash: pending.proposal_hash,
    });
    executor.tick("merge-closeout");
    expect(getActiveRun("merge-closeout")?.status).toBe("completed");
    expect(loadRunSnapshot("merge-closeout")?.handoffs).toContainEqual(expect.objectContaining({
      fromNode: "merge_approval",
      port: "approved",
      content: expect.objectContaining({ actor: "human:owner", decision: "approved" }),
    }));
  });

  it("terminates stale evidence as cancelled instead of completed", async () => {
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    executor.createRun("stale-closeout", parseWorkflowSource(fs.readFileSync(file, "utf8")), JSON.stringify(envelope("stale_evidence")));
    executor.tick("stale-closeout");

    expect(getActiveRun("stale-closeout")?.status).toBe("cancelled");
    expect(loadRunSnapshot("stale-closeout")?.handoffs).toContainEqual(expect.objectContaining({
      fromNode: "status_gate",
      port: "stale",
    }));
    expect(await finalizeRunArtifacts("stale-closeout", "failure")).toEqual([
      expect.objectContaining({ name: "pr-closeout.json", status: "ready", publish: "always" }),
    ]);
  });
});

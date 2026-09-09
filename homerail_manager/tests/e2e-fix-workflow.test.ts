import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { E2E_FIX_STAGES, parseE2eFixWorkflow, type E2eFixStage } from "../src/orchestration/e2e-fix-workflow.js";
import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { _clearActiveRuns, getActiveRun, handoffActiveRun } from "../src/runtime/active-runs.js";
import { closeDb } from "../src/persistence/db.js";
import { subscribe } from "../src/events/bus.js";
import { loadRunSnapshot } from "../src/persistence/store.js";

// Model transport simulation only. It responds when the native runtime sends
// a dispatch; the test never chooses a next node or advances individual rounds.
class FixtureModels implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];
  executor!: GraphExecutor;
  settle!: () => void;
  reject!: (error: unknown) => void;
  constructor(private acceptBroken: boolean) {}
  dispatch(envelope: DispatchEnvelope) {
    this.dispatched.push(envelope);
    queueMicrotask(() => {
      try {
        const value = envelope.inputs.evidence.at(-1) as any;
        let output: unknown;
        if (envelope.nodeId === "plan") {
          output = { strategy: "Correct numeric addition within frozen scope", allowed_paths: ["sum.cjs"] };
        } else if (envelope.nodeId === "fix") {
          const versions = [
            "module.exports = (a, b) => a - b;\n",
            "module.exports = (a, b) => Math.abs(a + b);\n",
            "module.exports = (a, b) => a + b;\n",
            "module.exports = (a, b) => { if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers only'); return a + b; };\n",
          ];
          output = { summary: `Candidate ${value.round}`, edits: [{ path: "sum.cjs", old: value.source, new: versions[value.round - 1] }] };
        } else if (envelope.nodeId.startsWith("review_")) {
          // A genuine read-only probe catches a defect the frozen positive test
          // misses. No constant fake request_changes based just on round count.
          const probe = spawnSync(process.execPath, ["-e",
            `const module = {exports:{}}; ${value.source}; require('node:assert/strict').equal(module.exports(-2,-3),-5);`], { encoding: "utf8" });
          output = { vote: probe.status === 0 ? "approve" : "request_changes",
            summary: `${envelope.nodeId}: negative operands probe`,
            findings: probe.status === 0 ? [] : ["Negative operands return the wrong sum"] };
        } else {
          const evidence = value.values?.[0] ?? value;
          const accepted = this.acceptBroken || (evidence.outcome === "ci_passed"
            || (evidence.outcome === "reviewed" && evidence.approvals >= 2 && evidence.findings.length === 0));
          output = { verdict: accepted ? "accept" : "revise", reason: accepted ? "Evidence supports acceptance" : "Repair the retained test/review/CI failure" };
        }
        handoffActiveRun(envelope.runId, envelope.nodeId, "result", output);
        this.executor.tick(envelope.runId); // Same response-driven drain as Worker transport.
        const current = getActiveRun(envelope.runId)!;
        if (current.status !== "active") this.settle();
        else if (!Array.from(current.dagRun.nodeStates).some(([id, state]) => id !== "cycle" && state === "RUNNING")) {
          throw new Error(`Native graph stalled: ${JSON.stringify({ states: Object.fromEntries(current.dagRun.nodeStates), counters: current.counters })}`);
        }
      } catch (error) { this.reject(error); }
    });
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "fixture-model" };
  }
}

describe("native E2E Fix topology (real Git/tests, simulated models/GitHub)", () => {
  let root: string;
  let oldHome: string | undefined;
  let oldAllow: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fix-topology-"));
    oldHome = process.env.HOMERAIL_HOME; oldAllow = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    process.env.HOMERAIL_HOME = path.join(root, "home");
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
    closeDb(); _clearActiveRuns();
  });
  afterEach(() => {
    _clearActiveRuns(); closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = oldHome;
    if (oldAllow === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST; else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllow;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(maxRounds = 4, options: { acceptBroken?: boolean; requireTypeGuard?: boolean } = {}) {
    const stageCommands = Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage, [process.execPath,
      path.resolve("tests/fixtures/e2e-fix-stage.mjs"), root, stage]])) as Record<E2eFixStage, string[]>;
    const parsed = parseE2eFixWorkflow({ workflowId: "e2e-fix-topology", maxRounds, stageCommands, stageTimeoutMs: 15000,
      durableStages: process.platform === "linux" });
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    const models = new FixtureModels(options.acceptBroken === true);
    const executor = new GraphExecutor(models); models.executor = executor;
    const completion = new Promise<void>((resolve, reject) => { models.settle = resolve; models.reject = reject; });
    executor.createRun("one-root", parsed, JSON.stringify({ task_id: "fixture", root_run_id: "one-root", require_type_guard: options.requireTypeGuard }));
    const unsubscribers = (["dag:run_completed", "dag:run_failed", "dag:run_cancelled"] as const).map(type =>
      subscribe(type, event => { if ("runId" in event && event.runId === "one-root") models.settle(); }));
    try {
      executor.tick("one-root");
      if (getActiveRun("one-root")?.status !== "active") models.settle();
      await completion;
    } finally { unsubscribers.forEach(unsubscribe => unsubscribe()); }
    const ledger = JSON.parse(fs.readFileSync(path.join(root, "ledger.json"), "utf8"));
    const evidenceDir = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
    if (evidenceDir) {
      // Opt-in proof export, outside the repository. Normal tests remain isolated.
      const destination = path.join(evidenceDir, path.basename(root));
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "proof.json"), JSON.stringify({
        scope: "native graph + real Git/tests; model/GitHub providers simulated",
        external_start_calls: 1, external_per_round_advance_calls: 0,
        maxRounds, options, ledger,
        snapshot: loadRunSnapshot("one-root"),
        dispatches: models.dispatched.map(e => ({ nodeId: e.nodeId, runId: e.runId,
          sessionId: e.sessionId, inputBytes: Buffer.byteLength(JSON.stringify(e.inputs)) })),
      }, null, 2));
      for (const file of fs.readdirSync(root).filter(name => /^(test|ci)-\d+\.log$/.test(name))) {
        fs.copyFileSync(path.join(root, file), path.join(destination, file));
      }
    }
    return { models, active: getActiveRun("one-root")!, ledger };
  }

  it("runs test failure → negative review → clean repair in one graph without per-round external calls", async () => {
    const { models, active, ledger } = await run();
    expect(active.status, JSON.stringify({ counters: active.counters, ledger })).toBe("completed");
    expect(ledger.rounds.map((r: any) => r.test.result)).toEqual(["failed", "passed", "passed"]);
    expect(ledger.rounds[0].reviews).toBeUndefined();
    expect(ledger.rounds[1].reviews.map((r: any) => r.vote)).toEqual(["request_changes", "request_changes", "request_changes"]);
    expect(ledger.rounds[2].acceptance).toEqual({ eligible: true, reasons: [], approvals: 3 });
    expect(ledger.publication_count).toBe(1);
    expect(ledger.calls.filter((s: string) => s === "initialize")).toHaveLength(1);
    expect(models.dispatched.every(e => e.runId === "one-root")).toBe(true);
    expect(models.dispatched.every(e => e.allowedBuiltinTools?.length === 0 && e.codexSandbox === "read-only")).toBe(true);
    const sessions = models.dispatched.map(e => e.sessionId);
    expect(sessions.every(Boolean)).toBe(true);
    expect(new Set(sessions).size).toBe(sessions.length);
    expect(models.dispatched.every(e => Buffer.byteLength(JSON.stringify(e.inputs)) < 96000)).toBe(true);
    expect(fs.readFileSync(path.join(root, "test-1.log"), "utf8")).toContain("AssertionError");
    const snapshot = loadRunSnapshot("one-root");
    expect(snapshot?.handoffs.filter(h => h.fromNode === "test")).toHaveLength(3);
    expect(new Set(ledger.rounds.map((r: any) => r.candidate.head)).size).toBe(3);
  }, 60_000);

  it("routes a post-publication CI failure through Codex judgment and another round to the same PR", async () => {
    const { active, ledger } = await run(4, { requireTypeGuard: true });
    expect(active.status, JSON.stringify({ counters: active.counters, ledger })).toBe("completed");
    expect(ledger.rounds).toHaveLength(4);
    expect(ledger.rounds[2].ci.jobs[0].conclusion).toBe("failure");
    expect(ledger.rounds[3].ci.jobs[0].conclusion).toBe("success");
    expect(ledger.rounds[2].publication.pr).toBe(ledger.rounds[3].publication.pr);
    expect(ledger.publication_count).toBe(2);
    expect(ledger.rounds[3].acceptance.eligible).toBe(true);
  }, 60_000);

  it("stops at the repair bound instead of inventing success or publishing a broken candidate", async () => {
    const { active, ledger } = await run(2);
    expect(active.status).toBe("cancelled");
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.publication_count).toBeUndefined();
  }, 60_000);

  it("does not let a model accept a failed real test", async () => {
    const { active, ledger } = await run(4, { acceptBroken: true });
    expect(active.status).toBe("cancelled");
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.rounds[0].test.exit_code).not.toBe(0);
    expect(ledger.publication_count).toBeUndefined();
  }, 60_000);
});

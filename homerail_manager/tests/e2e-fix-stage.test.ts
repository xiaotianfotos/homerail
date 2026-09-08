import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeE2eFixTask, runE2eFixStage, type E2eFixTaskConfig } from "../src/runtime/e2e-fix-stage.js";
import { E2E_FIX_STAGES, parseE2eFixWorkflow, type E2eFixStage } from "../src/orchestration/e2e-fix-workflow.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { _clearActiveRuns, handoffActiveRun, getActiveRun, failActiveRun, requestNodeCorrection } from "../src/runtime/active-runs.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { appendNodeUsage, appendChatEntry, loadRunSnapshot } from "../src/persistence/store.js";
import { subscribe } from "../src/events/bus.js";
import { e2eFixDocker } from "../src/runtime/e2e-fix-test.js";

function config(root: string, image = "sha256:" + "1".repeat(64)): E2eFixTaskConfig {
  return { version: 1, task_id: "issue-fixture", root_run_id: "native-root", mode: "simulation", source_repo: path.join(root, "repo"), repo: "fixture/repo", base: "a".repeat(40),
    issue: { number: 1, title: "Fix addition for signed integers", body: "sum(2,3) and sum(-2,-3) must add correctly" },
    allowed_paths: ["sum.cjs"], protected_paths: ["tests"], max_rounds: 4, max_infra_retries: 1, context_bytes: 96000, total_timeout_ms: 180000,
    policy: { required_tests: ["positive-addition"], required_ci_jobs: ["fixture-ci"], ci_workflow_path: ".github/workflows/ci.yml",
      reviewer_ids: ["review_a", "review_b", "review_c"], review_approvals: 2 },
    tests: [{ id: "positive-addition", image, argv: ["node", "/checks/check.cjs"], cwd: ".", timeout_ms: 10000,
      memory_mb: 256, workspace_mb: 64, cpus: 1, pids_limit: 64,
      files: { "check.cjs": "require('node:assert/strict').equal(require('/work/sum.cjs')(2,3),5);console.log('assertion completed');" } }],
  };
}

describe("trusted E2E Fix task configuration", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-task-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it("rejects a direct stage call without native execution identity", () => {
    expect(() => runE2eFixStage(root, "initialize", "{}", "")).toThrow(/native durable/);
  });
  it.skipIf(process.platform !== "linux")("pins policy and detects edited frozen configuration", () => {
    const value = config(root); const sha = freezeE2eFixTask(root, value); expect(freezeE2eFixTask(root, value)).toBe(sha);
    value.max_rounds = 20; fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(value));
    expect(() => freezeE2eFixTask(root, value)).toThrow(/immutable/);
  });
  it("rejects a policy omitting required trusted checks", () => {
    const value = config(root); value.policy.required_tests = ["invented-pass"];
    expect(() => freezeE2eFixTask(root, value)).toThrow(/set mismatch/);
  });
});

type Scenario = "test-review-loop" | "invalid-proposal" | "unknown-ci" | "stale-ci" | "unresolved-review" | "dismissed-review" | "duplicate-disposition" | "ci-feedback"
  | "model-truncated" | "model-unknown" | "model-accept" | "model-same-plan" | "model-no-strategy" | "model-stale-evidence";

class Models implements DAGDispatcher {
  constructor(readonly scenario: Scenario) {}
  executor!: GraphExecutor;
  calls: DispatchEnvelope[] = [];
  error?: unknown;
  dispatch(envelope: DispatchEnvelope) {
    this.calls.push(envelope);
    queueMicrotask(() => {
      try {
        const value: any = envelope.inputs.evidence.at(-1);
        let result: unknown;
        if (envelope.nodeId === "plan") result = { strategy: value.previous?.evidence?.retry_strategy && this.scenario !== "model-same-plan"
          ? "Use one short unique edit under the fixed output budget" : "Implement signed addition using current evidence", allowed_paths: ["sum.cjs"] };
        else if (envelope.nodeId === "fix") {
          if (this.scenario.startsWith("model-") && value.round === 1) {
            const session = this.scenario === "model-stale-evidence" ? "old-session" : envelope.sessionId;
            const scope = { run_id: envelope.runId, node_id: envelope.nodeId, session_id: session,
              round_id: getActiveRun(envelope.runId)!.currentRound.round_id };
            const finish = this.scenario === "model-unknown" ? null : "max-tokens";
            for (let i = 0; i < 2; i++) appendChatEntry(envelope.runId, envelope.nodeId, {
              role: "worker", type: "response", timestamp: Date.now(), content: { ...scope, type: "usage", execution_id: "failed-execution",
                usage: { input_tokens: 101, output_tokens: 8191, cache_read_input_tokens: 0 }, duration_ms: 1234, finish_reason: finish },
            });
            const diagnostics = { finish_reason: finish, output_tokens: 8191, output_token_limit: 8192 };
            appendChatEntry(envelope.runId, envelope.nodeId, { role: "worker", type: "response", timestamp: Date.now(),
              content: { ...scope, message: "agent ended without DAG handoff", attempt_diagnostics: diagnostics } });
            if (finish && session === envelope.sessionId) expect(requestNodeCorrection(envelope.runId, envelope.nodeId,
              "agent ended without DAG handoff", diagnostics).status).toBe("unavailable");
            failActiveRun(envelope.runId, envelope.nodeId, "agent ended without DAG handoff");
            this.executor.tick(envelope.runId);
            return;
          }
          const code = this.scenario === "test-review-loop" ? ["module.exports=(a,b)=>a-b;\n", "module.exports=(a,b)=>Math.abs(a+b);\n", "module.exports=(a,b)=>a+b;\n"][value.round - 1]
            : this.scenario === "ci-feedback" && value.round === 2 ? "module.exports=(a,b)=>a+b+0;\n" : "module.exports=(a,b)=>a+b;\n";
          result = { summary: "repair candidate " + value.round, edits: [{ path: "sum.cjs", old: this.scenario === "invalid-proposal" && value.round === 1 ? "stale source" : value.sources["sum.cjs"], new: code }] };
        } else if (envelope.nodeId.startsWith("review_")) {
          // Deterministic reviewer substitute. It examines the source actually
          // delivered by the stage, independently of sibling votes.
          const bad = value.sources["sum.cjs"].includes("Math.abs") || (["unresolved-review", "dismissed-review", "duplicate-disposition"].includes(this.scenario) && envelope.nodeId === "review_c");
          result = { vote: bad ? "request_changes" : "approve", summary: envelope.nodeId + ": signed-input review",
            findings: bad ? [value.sources["sum.cjs"].includes("Math.abs") ? "Negative sums are incorrectly made positive" : "Fixture disputed concern"] : [] };
        } else {
          const evidence = value.values?.[0] ?? value;
          const good = evidence.outcome === "ci_passed" || (evidence.outcome === "reviewed" && !evidence.findings.length);
          const disputed = ["unresolved-review", "dismissed-review", "duplicate-disposition"].includes(this.scenario);
          const dispositions = disputed && this.scenario !== "unresolved-review" && evidence.findings?.length
            ? evidence.findings.map((f: any) => ({ finding_id: f.id, action: "dismiss", reason: "Fixture concern is contradicted by the retained source and test evidence",
              evidence_sha256: [evidence.evidence_sha256[0]] })) : [];
          if (this.scenario === "duplicate-disposition" && dispositions.length) dispositions.push(dispositions[0]);
          result = { dispositions, verdict: good || disputed || this.scenario === "model-accept" ? "accept" : "revise",
            ...(this.scenario.startsWith("model-") && this.scenario !== "model-no-strategy" ? { retry_strategy: "Use one short unique edit under the fixed output budget" } : {}),
            reason: good ? "All supplied evidence supports acceptance" : "Address the real retained failure" };
        }
        if (envelope.nodeId === "plan" && this.scenario === "model-same-plan" && value.round > 1) {
          // JSON key order and cosmetic whitespace cannot bypass the unchanged-plan fence.
          result = { allowed_paths: ["sum.cjs"], strategy: " Implement signed addition using current evidence " };
        }
        appendNodeUsage({ runId: envelope.runId, nodeId: envelope.nodeId, scope: { session_id: envelope.sessionId },
          usage: { input_tokens: 101, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, timestamp: Date.now() });
        appendNodeUsage({ runId: envelope.runId, nodeId: envelope.nodeId,
          usage: { input_tokens: 99999, output_tokens: 99999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, timestamp: Date.now() });
        handoffActiveRun(envelope.runId, envelope.nodeId, "result", result);
        this.executor.tick(envelope.runId);
      } catch (error) { this.error = error; }
    });
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "model-substitute" };
  }
}

describe.skipIf(process.platform !== "linux" || !process.env.HOMERAIL_E2E_FIX_TEST_IMAGE)("native graph with trusted stages and real Docker tests", () => {
  it.each<Scenario>(["test-review-loop", "invalid-proposal", "unknown-ci", "stale-ci", "unresolved-review", "dismissed-review", "duplicate-disposition", "ci-feedback",
    "model-truncated", "model-unknown", "model-accept", "model-same-plan", "model-no-strategy", "model-stale-evidence"])("autonomously handles %s in one root", async (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-native-stages-"));
    const oldHome = process.env.HOMERAIL_HOME; const oldAllow = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    const task = path.join(root, "task");
    process.env.HOMERAIL_HOME = path.join(root, "home"); process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
    _clearActiveRuns(); closeDb();
    const unsubscribers: Array<() => void> = [];
    try {
      const configuration = config(root, process.env.HOMERAIL_E2E_FIX_TEST_IMAGE);
      fs.mkdirSync(configuration.source_repo);
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", configuration.source_repo, ...args], { encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
      };
      git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(configuration.source_repo, "sum.cjs"), "module.exports=(a,b)=>0;\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      configuration.base = git("rev-parse", "HEAD"); freezeE2eFixTask(task, configuration);
      fs.writeFileSync(path.join(task, "fixture-scenario.json"), JSON.stringify(scenario));
      const stageCommands = Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage, [process.execPath, "--import", "tsx",
        path.resolve("tests/fixtures/e2e-fix-native-stage.ts"), task, stage]])) as Record<E2eFixStage, string[]>;
      const parsed = parseE2eFixWorkflow({ workflowId: "trusted-stages", maxRounds: 4, stageCommands, stageTimeoutMs: 30000 });
      for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
      const models = new Models(scenario); const executor = new GraphExecutor(models); models.executor = executor;
      const done = new Promise<void>(resolve => {
        for (const name of ["dag:run_completed", "dag:run_failed", "dag:run_cancelled"] as const) unsubscribers.push(subscribe(name, event => {
          if ("runId" in event && event.runId === "native-root") resolve();
        }));
      });
      executor.createRun("native-root", parsed, JSON.stringify({ task_id: configuration.task_id }));
      executor.tick("native-root");
      await done;
      const snapshot = loadRunSnapshot("native-root")!;
      const destination = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
      if (destination) {
        const proofDir = path.join(destination, "native-stages", path.basename(root)); fs.mkdirSync(proofDir, { recursive: true });
        fs.cpSync(task, path.join(proofDir, "task"), { recursive: true });
        fs.writeFileSync(path.join(proofDir, "proof.json"), JSON.stringify({ scope: "real native stages/Git/Docker, simulated models/GitHub", scenario, snapshot,
          dispatches: models.calls.map(c => ({ node: c.nodeId, session: c.sessionId, input_bytes: Buffer.byteLength(JSON.stringify(c.inputs)) })),
          commands: getDb().prepare("SELECT execution_id, identity_json, consumed FROM dag_durable_commands").all() }));
      }
      expect(models.error).toBeUndefined();
      const unknownCi = ["unknown-ci", "stale-ci"].includes(scenario);
      const blockedReview = ["unresolved-review", "duplicate-disposition"].includes(scenario);
      const blockedModel = ["model-unknown", "model-accept", "model-no-strategy", "model-stale-evidence"].includes(scenario);
      expect(getActiveRun("native-root")?.status, JSON.stringify(snapshot.handoffs.at(-1))).toBe(scenario === "model-same-plan" ? "failed" : unknownCi || blockedReview || blockedModel ? "cancelled" : "completed");
      const read = (round: number, name: string) => JSON.parse(fs.readFileSync(path.join(task, "rounds", String(round), name + ".json"), "utf8"));
      const rounds = scenario === "test-review-loop" ? 3 : ["invalid-proposal", "ci-feedback", "model-truncated"].includes(scenario) ? 2 : 1;
      if (scenario.startsWith("model-")) {
        expect(read(1, "test")).toMatchObject({ outcome: "model_failure", tests: [], candidate: null });
        expect(fs.existsSync(path.join(task, "rounds", "1", "tests"))).toBe(false);
        expect(fs.existsSync(path.join(task, "rounds", "1", "fixer.json"))).toBe(false);
        expect(read(1, "fixer_failure").attempts).toHaveLength(scenario === "model-stale-evidence" ? 0 : 1);
        expect(models.calls.some(c => c.nodeId.startsWith("review_") && (c.inputs.evidence.at(-1) as any).round === 1)).toBe(false);
        if (scenario === "model-truncated") expect(read(2, "context").previous.evidence).toMatchObject({
          retry_strategy: expect.any(String), model_failure: { outcome: "output_truncated", attempts: [{ output_tokens: 8191 }] },
        });
        if (scenario === "model-same-plan") {
          expect(models.calls.filter(c => c.nodeId === "plan")).toHaveLength(2);
          expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(1);
          expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
          return;
        }
      }
      if (scenario === "test-review-loop") {
        expect(read(1, "test").outcome).toBe("code_failure");
        expect(read(2, "test").outcome).toBe("passed"); expect(read(2, "review_evidence").findings.length).toBe(3);
      } else if (scenario === "invalid-proposal") {
        expect(read(1, "test")).toMatchObject({ outcome: "proposal_rejected", tests: [], candidate: null });
        expect(fs.existsSync(path.join(task, "rounds", "1", "tests"))).toBe(false);
        expect(read(2, "context")).toMatchObject({ parent: configuration.base, previous: { evidence: { proposal_error: expect.any(String) } } });
      } else if (unknownCi) {
        expect(read(1, "ci").outcome).toBe("infrastructure_failure");
        expect(read(1, "ci_judger").value.verdict).toBe("revise");
      } else if (scenario === "ci-feedback") {
        expect(read(1, "ci").outcome).toBe("code_failure");
        expect(read(2, "context").previous.evidence.details.logs[0].tail).toContain("CI fixture assertion failure");
        expect(read(2, "publish").publication.pr).toBe(read(1, "publish").publication.pr);
        expect(models.calls.filter(c => c.nodeId === "judge_ci")).toHaveLength(2);
      }
      if (blockedReview || blockedModel) {
        expect(read(1, "record_candidate_judgment").action).toBe("pause");
        expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
      } else expect(read(rounds, "complete")).toMatchObject({ action: unknownCi ? "pause" : "complete",
        production_eligible: false, acceptance: { eligible: !unknownCi } });
      for (let round = 1; round <= rounds; round++) {
        if (scenario.startsWith("model-") && round === 1) continue;
        expect(read(round, "fixer").usages).toHaveLength(1);
        expect(read(round, "fixer").usages[0].usage.input_tokens).toBe(101);
      }
      expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(rounds);
      expect(new Set(models.calls.map(c => c.sessionId)).size).toBe(models.calls.length);
      expect(models.calls.every(c => Buffer.byteLength(JSON.stringify(c.inputs)) <= 96000)).toBe(true);
      expect(snapshot.handoffs.filter(h => h.fromNode === "test")).toHaveLength(rounds);
    } finally {
      unsubscribers.forEach(close => close()); _clearActiveRuns(); closeDb();
      if (fs.existsSync(task)) {
        const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name); if (entry.isDirectory() && entry.name !== "objects.git") walk(file);
          else if (entry.name === "container.json") { const id = JSON.parse(fs.readFileSync(file, "utf8")).id; e2eFixDocker(["container", "rm", "--force", id]); }
        } }; walk(task);
      }
      if (oldHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = oldHome;
      if (oldAllow === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST; else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllow;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

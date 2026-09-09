import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeE2eFixTask, runE2eFixStage, type E2eFixTaskConfig } from "../src/runtime/e2e-fix-stage.js";
import { E2E_FIX_STAGES, parseE2eFixWorkflow, type E2eFixStage } from "../src/orchestration/e2e-fix-workflow.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { _clearActiveRuns, handoffActiveRun, getActiveRun, failActiveRun, requestNodeCorrection, reconstructTerminalCommandCheckpoint, recoverE2eFixReviewRun } from "../src/runtime/active-runs.js";
import { recoveryDigest } from "../src/runtime/dag-dispatch-recovery.js";
import { freezeE2eFixRuntime } from "../src/runtime/e2e-fix-runtime.js";
import { assertE2eFixStageRuntime, reviewRecoveryArgv } from "../src/runtime/e2e-fix-stage-runtime.js";
import { durableCommandDirectory } from "../src/runtime/durable-command.js";
import { getDagSessionIndex } from "../src/persistence/dag-session-index.js";
import { createServer } from "../src/server/http.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { appendNodeUsage, appendChatEntry, loadRunSnapshot } from "../src/persistence/store.js";
import { subscribe } from "../src/events/bus.js";
import { e2eFixDocker } from "../src/runtime/e2e-fix-test.js";
import { e2eFixDigest } from "../src/runtime/e2e-fix-candidates.js";

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
  it("rejects ambiguous host Fixer configuration before freezing policy", () => {
    const value = config(root);
    value.host_codex = { model: "fixture", timeout_ms: 1000, output_bytes: 4000, fixer: "true" as unknown as boolean };
    expect(() => freezeE2eFixTask(root, value)).toThrow(/host Codex bounds/);
  });
});

type Scenario = "fixed-test-review-loop" | "fixed-ci-feedback" | "fixed-quorum" | "fixed-unknown-ci" | "fixed-stagnation" | "review-source-projection" | "blocked-plan" | "stagnation-test" | "stagnation-same-plan" | "oom-test" | "install-failure" | "setup-success" | "missing-template" | "interrupted-test" | "review-contract-correct" | "review-contract-correct-retry" | "review-contract-exhausted" | "approve-observations" | "test-review-loop" | "review-context-budget" | "review-context-oversize" | "invalid-proposal" | "unknown-ci" | "stale-ci" | "unresolved-review" | "dismissed-review" | "duplicate-disposition" | "ci-feedback"
  | "model-truncated" | "model-unknown" | "model-accept" | "model-same-plan" | "model-no-strategy" | "model-stale-evidence";

class Models implements DAGDispatcher {
  constructor(readonly scenario: Scenario) {}
  executor!: GraphExecutor;
  calls: DispatchEnvelope[] = [];
  error?: unknown;
  failedDispatches: DispatchEnvelope[] = [];
  dispatch(envelope: DispatchEnvelope) {
    if (this.scenario === "review-contract-correct-retry" && envelope.nodeId === "plan" && !this.failedDispatches.length) {
      this.failedDispatches.push(envelope);
      return { status: "failed" as const, reason: "Injected pre-execution transport failure", retryable: true };
    }
    if (this.scenario.startsWith("fixed-")) {
      expect(["fix", "review_a", "review_b", "review_c"]).toContain(envelope.nodeId);
    }
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
          const code = ["test-review-loop", "fixed-test-review-loop"].includes(this.scenario) ? ["module.exports=(a,b)=>a-b;\n", "module.exports=(a,b)=>Math.abs(a+b);\n", "module.exports=(a,b)=>a+b;\n"][value.round - 1]
            : ["ci-feedback", "fixed-ci-feedback"].includes(this.scenario) && value.round === 2 ? "module.exports=(a,b)=>a+b+0;\n" : "module.exports=(a,b)=>a+b;\n";
          result = { summary: "repair candidate " + value.round, edits: [{ path: "sum.cjs", old: this.scenario === "invalid-proposal" && value.round === 1 ? "stale source" : value.sources["sum.cjs"],
            new: this.scenario.startsWith("review-context-") && value.round === 1 ? "module.exports=(a,b)=>Math.abs(a+b);\n" : code }] };
          if (this.scenario === "review-source-projection") result = { summary: "Fix the signed sum without copying unchanged context", edits: [
            { path: "sum.cjs", old: "=>0", new: "=>a+b" },
          ] };
          if (this.scenario.startsWith("stagnation-") || this.scenario === "fixed-stagnation") result = { summary: "Cosmetic unsuccessful change", edits: [{
            path: "sum.cjs", old: value.sources["sum.cjs"], new: `module.exports=(a,b)=>a-b; // attempt ${value.round}\n`,
          }] };
          if (this.scenario === "model-truncated") result = { summary: "repair with short independent snippets", edits: [
            { path: "sum.cjs", old: "=>0", new: "=>a+b" },
            { path: "sum.cjs", old: "module.exports", new: "// add signed numbers\nmodule.exports" },
          ] };
        } else if (envelope.nodeId.startsWith("review_")) {
          if (this.scenario.startsWith("fixed-")) {
            expect(value.publication).toMatchObject({ pr: 7, state: "open", observed_head: value.candidate.head });
            expect(value.repair_context.plan.strategy).toBe("Implement signed addition using the fixed caller design");
          }
          // Deterministic reviewer substitute. It examines the source actually
          // delivered by the stage, independently of sibling votes. For a
          // projection it inspects only added lines, never the omitted source.
          const source = value.sources?.["sum.cjs"] ?? value.source_context.diff.split("\n")
            .filter((line: string) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
          const bad = source.includes("Math.abs") || (["unresolved-review", "dismissed-review", "duplicate-disposition", "fixed-quorum"].includes(this.scenario) && envelope.nodeId === "review_c");
          result = { vote: bad ? "request_changes" : "approve", summary: envelope.nodeId + ": signed-input review",
            findings: bad ? [source.includes("Math.abs") ? "Negative sums are incorrectly made positive" : "Fixture disputed concern"] : [] };
          if (this.scenario.startsWith("review-contract-") && envelope.nodeId === "review_a"
            && (this.scenario === "review-contract-exhausted" || !envelope.inputs.correction?.length)) {
            result = { vote: "approve", summary: "Correct signed addition", findings: ["The candidate correctly adds signed values"] };
          }
          if (this.scenario === "approve-observations") (result as { findings: string[] }).findings = ["The source correctly implements addition"];
          if (this.scenario.startsWith("review-context-") && bad) {
            (result as { findings: string[] }).findings = Array.from({ length: 8 }, (_, i) =>
              `Finding ${i}: negative sums are incorrectly made positive. ` + "Signed addition must preserve negative results. ".repeat(10));
          }
        } else {
          const evidence = value.values?.[0] ?? value;
          const good = evidence.outcome === "ci_passed" || (evidence.outcome === "reviewed" && !evidence.findings.length);
          const disputed = ["approve-observations", "unresolved-review", "dismissed-review", "duplicate-disposition"].includes(this.scenario);
          const dispositions = disputed && this.scenario !== "unresolved-review" && evidence.findings?.length
            ? evidence.findings.map((f: any) => ({ finding_id: f.id, action: "dismiss", reason: "Fixture concern is contradicted by the retained source and test evidence",
              evidence_sha256: [evidence.evidence_sha256[0]] })) : [];
          if (this.scenario === "duplicate-disposition" && dispositions.length) dispositions.push(dispositions[0]);
          if (this.scenario === "review-context-budget" && evidence.findings?.length) {
            dispositions.push(...evidence.findings.map((f: any, i: number) => ({ finding_id: f.id,
              action: i < 2 ? "dismiss" : "revise", reason: "Retained Judger assessment",
              evidence_sha256: [i === 1 ? "0".repeat(64) : evidence.evidence_sha256[0]] })));
          }
          result = { dispositions, verdict: good || disputed || this.scenario === "model-accept" ? "accept" : "revise",
            ...((this.scenario.startsWith("model-") && this.scenario !== "model-no-strategy") || ["review-context-budget", "ci-feedback"].includes(this.scenario)
              ? { retry_strategy: "Use one short unique edit under the fixed output budget" } : {}),
            reason: good ? "All supplied evidence supports acceptance" : "Address the real retained failure" };
        }
        if (envelope.nodeId === "plan" && this.scenario === "model-same-plan" && value.round > 1) {
          // JSON key order and cosmetic whitespace cannot bypass the unchanged-plan fence.
          result = { allowed_paths: ["sum.cjs"], strategy: " Implement signed addition using current evidence " };
        }
        if (envelope.nodeId === "plan" && this.scenario === "stagnation-test" && value.round === 3) {
          result = { allowed_paths: ["sum.cjs"], strategy: "Trace operand signs and replace the incorrect arithmetic operation" };
        }
        if (envelope.nodeId === "plan" && this.scenario === "blocked-plan") result = {
          strategy: "No evidenced in-scope repair", allowed_paths: ["sum.cjs"], blocked_reason: "The failing recovery test is outside the authorized scope",
        };
        appendNodeUsage({ runId: envelope.runId, nodeId: envelope.nodeId, scope: { session_id: envelope.sessionId },
          usage: { input_tokens: 101, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, timestamp: Date.now() });
        appendNodeUsage({ runId: envelope.runId, nodeId: envelope.nodeId,
          usage: { input_tokens: 99999, output_tokens: 99999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, timestamp: Date.now() });
        try { handoffActiveRun(envelope.runId, envelope.nodeId, "result", result); }
        catch (error) {
          if (!this.scenario.startsWith("review-contract-") || envelope.nodeId !== "review_a") throw error;
          expect(String(error)).toContain("DAG_HANDOFF_CONTRACT_VIOLATION");
          const correction = requestNodeCorrection(envelope.runId, envelope.nodeId, String(error), { port: "result", content: result });
          if (correction.status === "exhausted") failActiveRun(envelope.runId, envelope.nodeId, "Review contract correction exhausted");
          else expect(correction.status).toBe("scheduled");
        }
        this.executor.tick(envelope.runId);
      } catch (error) {
        this.error = error;
        failActiveRun(envelope.runId, envelope.nodeId, "Deterministic model fixture failed");
        this.executor.tick(envelope.runId);
      }
    });
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "model-substitute" };
  }
}

describe.skipIf(process.platform !== "linux" || !process.env.HOMERAIL_E2E_FIX_TEST_IMAGE)("native graph with trusted stages and real Docker tests", () => {
  it.each<Scenario>(["fixed-test-review-loop", "fixed-ci-feedback", "fixed-quorum", "fixed-unknown-ci", "fixed-stagnation", "review-source-projection", "blocked-plan", "stagnation-test", "stagnation-same-plan", "oom-test", "install-failure", "setup-success", "missing-template", "interrupted-test", "review-contract-correct", "review-contract-correct-retry", "review-contract-exhausted", "approve-observations", "test-review-loop", "review-context-budget", "review-context-oversize", "invalid-proposal", "unknown-ci", "stale-ci", "unresolved-review", "dismissed-review", "duplicate-disposition", "ci-feedback",
    "model-truncated", "model-unknown", "model-accept", "model-same-plan", "model-no-strategy", "model-stale-evidence"])("autonomously handles %s in one root", async (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-native-stages-"));
    const oldHome = process.env.HOMERAIL_HOME; const oldAllow = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    const task = path.join(root, "task");
    process.env.HOMERAIL_HOME = path.join(root, "home"); process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
    _clearActiveRuns(); closeDb();
    const unsubscribers: Array<() => void> = [];
    try {
      const configuration = config(root, process.env.HOMERAIL_E2E_FIX_TEST_IMAGE);
      if (scenario.startsWith("fixed-")) configuration.design = { strategy: "Implement signed addition using the fixed caller design" };
      // A correction must still leave room for final CI judgment in the last allowed round.
      if (scenario.startsWith("review-contract-correct")) configuration.max_rounds = 1;
      if (scenario === "oom-test") {
        configuration.tests[0].memory_mb = 64;
        configuration.tests[0].files["check.cjs"] = "const held=[];for(;;)held.push(Buffer.alloc(16*1024*1024,1));";
      }
      if (scenario === "install-failure") configuration.tests[0].setup_argv = ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"];
      if (scenario === "setup-success") {
        configuration.tests[0].setup_argv = ["node", "/checks/setup.cjs"];
        configuration.tests[0].files["setup.cjs"] = "require('node:fs').writeFileSync('/work/setup-ready','done');";
        configuration.tests[0].files["check.cjs"] = "require('node:assert/strict').equal(require('node:fs').readFileSync('/work/setup-ready','utf8'),'done');" + configuration.tests[0].files["check.cjs"];
      }
      if (scenario === "missing-template") configuration.tests[0].workspace_template = "/opt/homerail-missing-dependencies";
      if (scenario === "interrupted-test") configuration.tests[0].files["check.cjs"] = "process.kill(process.pid, 'SIGKILL');";
      if (scenario.startsWith("review-context-")) {
        configuration.context_bytes = 64000;
        configuration.issue.body += "\n" + "Retain the complete issue acceptance scope. ".repeat(scenario === "review-context-oversize" ? 1000 : 900);
      }
      if (scenario === "review-source-projection") configuration.context_bytes = 64000;
      fs.mkdirSync(configuration.source_repo);
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", configuration.source_repo, ...args], { encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
      };
      git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(configuration.source_repo, "sum.cjs"), "module.exports=(a,b)=>0;\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      if (scenario === "review-source-projection") {
        // The plan fits the frozen bound, but adding trusted test/repair evidence
        // crosses it. Exercise projection at review admission, not plan rejection.
        fs.writeFileSync(path.join(configuration.source_repo, "sum.cjs"), "// unchanged context\n".repeat(2860) + "module.exports=(a,b)=>0;\n");
        git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "large unchanged source");
      }
      configuration.base = git("rev-parse", "HEAD"); freezeE2eFixTask(task, configuration);
      fs.writeFileSync(path.join(task, "fixture-scenario.json"), JSON.stringify(scenario));
      const stageCommands = Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage, [process.execPath, "--import", "tsx",
        path.resolve("tests/fixtures/e2e-fix-native-stage.ts"), task, stage]])) as Record<E2eFixStage, string[]>;
      const parsed = parseE2eFixWorkflow({ workflowId: "trusted-stages", maxRounds: configuration.max_rounds, fixedDesign: Boolean(configuration.design), stageCommands, stageTimeoutMs: 30000 });
      // Existing frozen workflows lacked the conditional approval contract.
      // Keep this legacy fixture to prove the downstream gate still rejects it.
      if (scenario === "approve-observations") delete (parsed.meta.contracts!.Review as { allOf?: unknown }).allOf;
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
      if (scenario.startsWith("fixed-")) {
        expect(models.calls.every(c => ["fix", "review_a", "review_b", "review_c"].includes(c.nodeId))).toBe(true);
        expect(snapshot.metadata.nodeStates.plan).toBeUndefined();
        expect(snapshot.metadata.nodeStates.judge_candidate).toBeUndefined();
        expect(snapshot.metadata.nodeStates.judge_ci).toBeUndefined();
        const paused = ["fixed-unknown-ci", "fixed-stagnation"].includes(scenario);
        expect(getActiveRun("native-root")?.status).toBe(paused ? "cancelled" : "completed");
        const roundCount = scenario === "fixed-test-review-loop" || scenario === "fixed-stagnation" ? 3 : scenario === "fixed-ci-feedback" ? 2 : 1;
        const designHashes = new Set<string>(); const published: any[] = [];
        for (let n = 1; n <= roundCount; n++) {
          const dir = path.join(task, "rounds", String(n));
          const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
          designHashes.add(read("freeze_plan").plan_sha256);
          for (const model of ["planner", "candidate_judger", "ci_judger"]) expect(fs.existsSync(path.join(dir, model + ".json"))).toBe(false);
          expect(fs.existsSync(path.join(dir, "host-codex"))).toBe(false);
          if (fs.existsSync(path.join(dir, "publish.json"))) published.push(read("publish").publication);
          if (scenario === "fixed-test-review-loop" && n === 2) {
            expect(read("review_evidence").reports.every((r: any) => r.vote === "request_changes")).toBe(true);
            expect(read("record_candidate_judgment").action).toBe("revise");
          }
          if (scenario === "fixed-test-review-loop" && n === 3) {
            expect(read("freeze_plan").previous.evidence.findings[0].message).toContain("Negative sums");
          }
          if (scenario === "fixed-ci-feedback" && n === 2) expect(read("freeze_plan").previous.evidence.details.logs[0].tail).toContain("CI fixture assertion failure");
        }
        expect(designHashes.size).toBe(1);
        expect(published.map(p => p.pr)).toEqual(Array(scenario === "fixed-stagnation" ? 0 : roundCount - (scenario === "fixed-test-review-loop" ? 1 : 0)).fill(7));
        expect(new Set(models.calls.map(c => c.sessionId)).size).toBe(models.calls.length);
        const final = path.join(task, "rounds", String(roundCount));
        if (!paused) expect(JSON.parse(fs.readFileSync(path.join(final, "complete.json"), "utf8"))).toMatchObject({ action: "complete", decision_source: "trusted_review_quorum", acceptance: { eligible: true } });
        if (scenario === "fixed-quorum") {
          const reviewed = JSON.parse(fs.readFileSync(path.join(final, "review_evidence.json"), "utf8"));
          expect(reviewed.findings).toHaveLength(1); // Retained dissent, not a fabricated Judger dismissal.
          expect(reviewed.reports.filter((r: any) => r.vote === "approve")).toHaveLength(2);
        }
        return;
      }
      if (scenario === "review-context-oversize") {
        expect(getActiveRun("native-root")?.status).toBe("failed");
        const folder = path.join(task, "rounds", "1");
        expect(JSON.parse(fs.readFileSync(path.join(folder, "test.json"), "utf8")).outcome).toBe("passed");
        for (const reviewer of configuration.policy.reviewer_ids) {
          expect(JSON.parse(fs.readFileSync(path.join(folder, reviewer + ".json"), "utf8")).value.findings).toHaveLength(8);
        }
        expect(JSON.stringify(snapshot.handoffs.at(-1))).toContain("stage output exceeds frozen context bound");
        expect(fs.existsSync(path.join(folder, "review_evidence.json"))).toBe(false);
        expect(models.calls.some(call => call.nodeId.startsWith("judge_"))).toBe(false);
        const stateDigest = recoveryDigest(snapshot.metadata);
        const changes = getDb().prepare("SELECT total_changes() AS changes").get();
        const checkpoint = reconstructTerminalCommandCheckpoint(snapshot, stateDigest, "review_evidence");
        expect(Object.entries(checkpoint.nodeStates).filter(([, state]) => state === "READY")).toEqual([["review_evidence", "READY"]]);
        expect(checkpoint.createdAt).toBe(snapshot.metadata.createdAt);
        expect(checkpoint.currentRound).toMatchObject({ round_id: snapshot.metadata.currentRound!.round_id, ordinal: 1,
          opened_at: snapshot.metadata.currentRound!.opened_at, status: "active" });
        expect(checkpoint.currentRound!.closed_at).toBeUndefined();
        const { abort_reason: _, ...spent } = snapshot.metadata.counters!;
        expect(checkpoint.counters).toEqual(spent);
        for (const [id, state] of Object.entries(snapshot.metadata.nodeStates)) {
          if (state === "COMPLETED") expect(checkpoint.nodeStates[id]).toBe("COMPLETED");
        }
        expect(getDb().prepare("SELECT total_changes() AS changes").get()).toEqual(changes);
        expect(recoveryDigest(loadRunSnapshot("native-root")!.metadata)).toBe(stateDigest);
        checkpoint.graph!.nodes.find(n => n.node_id === "review_evidence")!.gateway_config!.command = ["changed-copy"];
        expect(recoveryDigest(snapshot.metadata)).toBe(stateDigest);
        expect(() => reconstructTerminalCommandCheckpoint(snapshot, "0".repeat(64), "review_evidence")).toThrow(/state conflict/);
        const changedMailbox = structuredClone(snapshot);
        changedMailbox.metadata.dagRuntimeState!.mailboxes.review_evidence.test.push({ forged: true });
        expect(() => reconstructTerminalCommandCheckpoint(changedMailbox, recoveryDigest(changedMailbox.metadata), "review_evidence")).toThrow(/replay differs/);
        const missingHandoff = structuredClone(snapshot);
        missingHandoff.handoffs.splice(missingHandoff.handoffs.findIndex(h => h.fromNode === "review_a"), 1);
        expect(() => reconstructTerminalCommandCheckpoint(missingHandoff, stateDigest, "review_evidence")).toThrow(/not quiescent/);
        const laterRound = structuredClone(snapshot);
        laterRound.metadata.currentRound!.ordinal = 2;
        expect(() => reconstructTerminalCommandCheckpoint(laterRound, recoveryDigest(laterRound.metadata), "review_evidence")).toThrow(/state conflict/);
        // The replacement here is an inert runtime fixture. This proves only
        // admission/transaction/fences, not that genuinely large data will fit.
        // No tick follows recovery, so no model/test/command can execute again.
        const runtimeSource = path.join(root, "runtime-source");
        fs.mkdirSync(path.join(runtimeSource, "dist/runtime"), { recursive: true });
        fs.writeFileSync(path.join(runtimeSource, "package.json"), JSON.stringify({ name: "recovery-runtime-fixture", type: "module" }));
        fs.writeFileSync(path.join(runtimeSource, "dist/runtime/e2e-fix-stage-cli.js"), "throw new Error('fixture must never be executed');");
        const runtime = freezeE2eFixRuntime(path.join(root, "replacement-runtime"), runtimeSource);
        const request = { request_id: "review-recovery-1", expected_state_sha256: stateDigest, reason: "Verify explicit deterministic-stage runtime revision",
          task_directory: task, runtime_directory: runtime.directory, runtime_sha256: runtime.sha256 };
        process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST += "," + runtime.node;
        const unchanged = () => expect(recoveryDigest(loadRunSnapshot("native-root")!.metadata)).toBe(stateDigest);
        const clock = vi.spyOn(Date, "now").mockReturnValue(snapshot.metadata.createdAt + configuration.total_timeout_ms + 1);
        try { expect(() => recoverE2eFixReviewRun("native-root", request)).toThrow(/deadline mismatch/); }
        finally { clock.mockRestore(); }
        unchanged();
        fs.writeFileSync(path.join(runtime.directory, "extra.js"), "unexpected");
        expect(() => recoverE2eFixReviewRun("native-root", request)).toThrow(/Unexpected recovery runtime file/);
        unchanged(); fs.unlinkSync(path.join(runtime.directory, "extra.js"));
        const completedCommand = getDb().prepare("SELECT execution_id FROM dag_durable_commands WHERE run_id = ? LIMIT 1").get("native-root") as { execution_id: string };
        const commandLog = path.join(durableCommandDirectory(completedCommand.execution_id), "stdout.log");
        const originalLog = fs.readFileSync(commandLog);
        fs.appendFileSync(commandLog, "changed");
        expect(() => recoverE2eFixReviewRun("native-root", request)).toThrow(/uncertain/);
        unchanged(); fs.writeFileSync(commandLog, originalLog);
        const failedSession = getDagSessionIndex("native-root", "review_evidence");
        getDb().exec("CREATE TRIGGER reject_review_recovery BEFORE INSERT ON dag_e2e_fix_review_recoveries BEGIN SELECT RAISE(ABORT, 'injected recovery commit failure'); END");
        expect(() => recoverE2eFixReviewRun("native-root", request)).toThrow(/injected recovery commit failure/);
        unchanged();
        expect(getActiveRun("native-root")?.status).toBe("failed");
        expect(getDagSessionIndex("native-root", "review_evidence")).toEqual(failedSession);
        getDb().exec("DROP TRIGGER reject_review_recovery");
        const callsBefore = models.calls.length;
        const result = recoverE2eFixReviewRun("native-root", request);
        expect(result.deduplicated).toBe(false);
        expect(result.receipt.changed_nodes).toEqual(["review_evidence"]);
        expect(result.receipt.original_deadline).toBe(snapshot.metadata.createdAt + configuration.total_timeout_ms);
        expect(getActiveRun("native-root")?.dagRun.nodeStates.get("review_evidence")).toBe("READY");
        expect(getDagSessionIndex("native-root", "review_evidence")?.session_id).not.toBe(failedSession?.session_id);
        expect(recoverE2eFixReviewRun("native-root", request)).toEqual({ ...result, deduplicated: true });
        expect(() => recoverE2eFixReviewRun("native-root", { ...request, reason: "changed request" })).toThrow(/request conflict/);
        expect(models.calls).toHaveLength(callsBefore);
        expect(getDb().prepare("SELECT count(*) AS count FROM dag_e2e_fix_review_recoveries").get()).toEqual({ count: 1 });
        const commandCount = getDb().prepare("SELECT count(*) AS count FROM dag_durable_commands").get();
        const previousToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
        process.env.HOMERAIL_DAG_MUTATION_TOKEN = "review-recovery-test-token";
        const server = createServer(0, undefined, models, false);
        try {
          await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
          const address = server.address() as { port: number };
          const rejected = await fetch(`http://127.0.0.1:${address.port}/api/runs/native-root/e2e-fix-review-recovery`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
          });
          expect(rejected.status).toBe(403); await rejected.text();
          const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/native-root/e2e-fix-review-recovery`, {
            method: "POST", headers: { "content-type": "application/json", "x-homerail-dag-token": process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? "" },
            body: JSON.stringify(request),
          });
          const body = await response.json();
          expect(response.status).toBe(200); expect(body.data).toMatchObject({ deduplicated: true, dispatched: 0, receipt: result.receipt });
          expect(getDb().prepare("SELECT count(*) AS count FROM dag_durable_commands").get()).toEqual(commandCount);
          expect(models.calls).toHaveLength(callsBefore);
        } finally {
          await new Promise<void>(resolve => server.close(() => resolve()));
          if (previousToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
          else process.env.HOMERAIL_DAG_MUTATION_TOKEN = previousToken;
        }
        const oldRuntime = process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256;
        process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256 = runtime.sha256;
        const policy = fs.readFileSync(path.join(task, "config.sha256"), "utf8");
        const pinned = { root_run_id: "native-root", runtime_sha256: "a".repeat(64) };
        try {
          expect(() => assertE2eFixStageRuntime(task, "review_evidence", pinned, policy, reviewRecoveryArgv(request))).not.toThrow();
          expect(() => assertE2eFixStageRuntime(task, "plan", pinned, policy, reviewRecoveryArgv(request))).toThrow(/runtime identity/);
          expect(() => assertE2eFixStageRuntime(task, "review_evidence", pinned, policy, ["different-command"])).toThrow(/runtime identity/);
          expect(() => assertE2eFixStageRuntime(task, "review_evidence", pinned, "b".repeat(64), reviewRecoveryArgv(request))).toThrow(/runtime identity/);
        } finally {
          if (oldRuntime === undefined) delete process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256;
          else process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256 = oldRuntime;
        }
        return;
      }
      if (scenario.startsWith("review-contract-")) {
        const calls = models.calls.filter(c => c.nodeId === "review_a");
        expect(calls).toHaveLength(2);
        expect(calls[1].inputs.evidence).toEqual(calls[0].inputs.evidence);
        expect(JSON.stringify(calls[1].inputs.correction)).toContain("Previous rejected handoff");
        expect(JSON.stringify(calls[1].inputs.correction)).toContain("The candidate correctly adds signed values");
        expect(models.calls.filter(c => c.nodeId === "review_b")).toHaveLength(1);
        expect(models.calls.filter(c => c.nodeId === "review_c")).toHaveLength(1);
        expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(1);
        expect(snapshot.handoffs.filter(h => h.fromNode === "test")).toHaveLength(1);
        expect(snapshot.metadata.counters!.corrections.review_a).toBe(1);
        if (scenario === "review-contract-exhausted") {
          expect(snapshot.metadata.status).toBe("failed");
          expect(snapshot.handoffs.some(h => h.fromNode === "review_a")).toBe(false);
          expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
          expect(models.calls.some(c => c.nodeId.startsWith("judge_"))).toBe(false);
          return;
        }
        expect(snapshot.handoffs.filter(h => h.fromNode === "review_a")).toHaveLength(1);
        expect(snapshot.metadata.status).toBe("completed");
        expect(models.calls.filter(c => c.nodeId === "judge_ci")).toHaveLength(1);
        expect(snapshot.metadata.counters!.dispatches).toBe(scenario === "review-contract-correct-retry" ? 9 : 8);
        if (scenario === "review-contract-correct-retry") {
          expect(models.failedDispatches).toHaveLength(1);
          expect(snapshot.metadata.counters!.dispatch_retries.plan).toBe(1);
        }
      }
      if (scenario === "blocked-plan") {
        expect(snapshot.metadata.status).toBe("failed");
        expect(models.calls.map(c => c.nodeId)).toEqual(["plan"]);
        const reason = JSON.parse(fs.readFileSync(path.join(task, "rounds", "1", "planner_blocked.json"), "utf8"));
        expect(reason.reason).toContain("outside the authorized scope");
        expect(fs.existsSync(path.join(task, "rounds", "1", "planner.json"))).toBe(true);
        expect(fs.existsSync(path.join(task, "rounds", "1", "capture.json"))).toBe(false);
        expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
        return;
      }
      if (scenario.startsWith("stagnation-")) {
        const read = (round: number, name: string) => JSON.parse(fs.readFileSync(path.join(task, "rounds", String(round), name + ".json"), "utf8"));
        const count = scenario === "stagnation-test" ? 3 : 2;
        expect(read(2, "record_candidate_judgment").stagnation).toMatchObject({ consecutive_failures: 2, action: "replan" });
        expect(read(3, "context").previous.evidence.previous_plan).toEqual(read(2, "freeze_plan").plan);
        if (scenario === "stagnation-test") {
          expect(read(3, "candidate_judger").value.verdict).toBe("revise");
          expect(read(3, "record_candidate_judgment")).toMatchObject({ action: "pause", stagnation: { consecutive_failures: 3, action: "pause" } });
          expect(snapshot.metadata.status).toBe("cancelled");
        } else {
          expect(snapshot.metadata.status).toBe("failed");
          expect(fs.existsSync(path.join(task, "rounds", "3", "fixer.json"))).toBe(false);
        }
        const captures = Array.from({ length: count }, (_, i) => read(i + 1, "capture").candidate);
        expect(new Set(captures.map(c => c.tree)).size).toBe(count);
        expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(count);
        expect(models.calls.some(c => c.nodeId.startsWith("review_"))).toBe(false);
        expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
        return;
      }
      if (["interrupted-test", "missing-template", "install-failure", "oom-test"].includes(scenario)) {
        const read = (name: string) => JSON.parse(fs.readFileSync(path.join(task, "rounds", "1", name + ".json"), "utf8"));
        expect(read("test").outcome).toBe("infrastructure_failure");
        // The native test route stops before spending any reviewer/Judger tokens.
        expect(fs.existsSync(path.join(task, "rounds", "1", "candidate_judger.json"))).toBe(false);
        expect(models.calls.some(c => c.nodeId.startsWith("judge_"))).toBe(false);
        expect(snapshot.metadata.status).toBe("cancelled");
        const attempts = path.join(task, "rounds", "1", "tests", configuration.tests[0].id);
        expect(fs.readdirSync(attempts).sort()).toEqual(["1", "2"]);
        const receipts = [1, 2].map(attempt => JSON.parse(fs.readFileSync(path.join(attempts, String(attempt), "receipt.json"), "utf8")));
        expect(receipts.every(r => r.result === "interrupted")).toBe(true);
        if (scenario === "oom-test") {
          // Verify Docker's actual cgroup OOM observation, not an invented exit 137.
          expect(receipts.every(r => r.state.OOMKilled === true)).toBe(true);
        } else {
          expect(receipts.every(r => r.exit_code === 125)).toBe(true);
          for (const attempt of [1, 2]) {
            const log = fs.readFileSync(path.join(attempts, String(attempt), "test.log"), "utf8");
            expect(log).toContain(scenario === "interrupted-test" ? "trusted test command did not complete SIGKILL" : "trusted test preparation failed");
            if (scenario === "install-failure") expect(log).toContain("npm error code EUSAGE");
            expect(log).not.toContain("assertion completed");
          }
        }
        expect(receipts[0].candidate).toEqual(receipts[1].candidate);
        expect(new Set(receipts.map(r => r.container_id)).size).toBe(2);
        expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(1);
        expect(models.calls.filter(c => c.nodeId === "plan")).toHaveLength(1);
        expect(models.calls.some(c => c.nodeId.startsWith("review_"))).toBe(false);
        expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
        return;
      }
      const unknownCi = ["unknown-ci", "stale-ci"].includes(scenario);
      const blockedReview = ["approve-observations", "unresolved-review", "duplicate-disposition"].includes(scenario);
      const blockedModel = ["model-unknown", "model-accept", "model-no-strategy", "model-stale-evidence"].includes(scenario);
      expect(getActiveRun("native-root")?.status, JSON.stringify(snapshot.handoffs.at(-1))).toBe(scenario === "model-same-plan" ? "failed" : unknownCi || blockedReview || blockedModel ? "cancelled" : "completed");
      const read = (round: number, name: string) => JSON.parse(fs.readFileSync(path.join(task, "rounds", String(round), name + ".json"), "utf8"));
      const rounds = scenario === "test-review-loop" ? 3 : ["review-context-budget", "invalid-proposal", "ci-feedback", "model-truncated"].includes(scenario) ? 2 : 1;
      if (scenario === "approve-observations") {
        const review = read(1, "review_evidence");
        expect(review.review_contract_errors).toHaveLength(3);
        expect(review.reports.every((r: any) => r.vote === "approve")).toBe(true);
        expect(read(1, "candidate_judger").value.verdict).toBe("accept");
        expect(read(1, "candidate_judger").value.dispositions).toHaveLength(3);
        expect(read(1, "record_candidate_judgment").action).toBe("pause");
        expect(snapshot.metadata.nodeStates.publish).toBe("SKIPPED");
      }
      if (scenario === "review-source-projection") {
        const tested = read(1, "test");
        expect(tested.sources).toBeUndefined();
        expect(tested.source_context.full_sources_artifact).toBe("test_sources.json");
        expect(tested.source_context.limitation).toContain("not the omitted source");
        expect(tested.source_context.diff).toContain("+module.exports=(a,b)=>a+b;");
        expect(e2eFixDigest(JSON.stringify(read(1, "test_sources")))).toBe(tested.source_evidence.sha256);
        expect(Buffer.byteLength(JSON.stringify({ ...tested, sources: read(1, "test_sources") }))).toBeGreaterThan(configuration.context_bytes);
        expect(Buffer.byteLength(JSON.stringify(tested))).toBeLessThanOrEqual(configuration.context_bytes);
        for (const dispatch of models.calls.filter(c => c.nodeId.startsWith("review_") || c.nodeId === "judge_candidate")) {
          const value = dispatch.inputs.evidence.at(-1) as any;
          const evidence = value.values?.[0] ?? value;
          expect(evidence.repair_context).toEqual(tested.repair_context);
          expect(evidence.source_context).toEqual(tested.source_context);
        }
      }
      if (scenario === "review-context-budget") {
        const review = read(1, "review_evidence");
        expect(review.findings).toHaveLength(24);
        expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(configuration.context_bytes);
        expect(Buffer.byteLength(JSON.stringify({ ...review, reports: review.reports.map((report: any) => ({ ...report,
          findings: review.findings.filter((finding: any) => report.finding_ids.includes(finding.id)) })) }))).toBeGreaterThan(configuration.context_bytes);
        for (const report of review.reports) {
          expect(report.findings).toBeUndefined();
          expect(report.finding_ids).toHaveLength(8);
          expect(read(1, report.reviewer_id).value.findings).toHaveLength(8);
        }
        expect(read(1, "record_candidate_judgment").action).toBe("revise");
        const feedback = read(2, "context").previous.evidence;
        expect(feedback.findings).toEqual(review.findings.slice(1));
        expect(feedback.retry_strategy).toBe("Use one short unique edit under the fixed output budget");
        expect(read(1, "candidate_judger").value.dispositions).toHaveLength(24);
        expect(read(1, "record_candidate_judgment").dispositions).toHaveLength(24);
        expect(read(2, "planner").value.strategy).toBe(feedback.retry_strategy);
      }
      if (scenario.startsWith("model-")) {
        expect(read(1, "test")).toMatchObject({ outcome: "model_failure", tests: [], candidate: null });
        expect(fs.existsSync(path.join(task, "rounds", "1", "tests"))).toBe(false);
        expect(fs.existsSync(path.join(task, "rounds", "1", "fixer.json"))).toBe(false);
        expect(read(1, "fixer_failure").attempts).toHaveLength(scenario === "model-stale-evidence" ? 0 : 1);
        expect(models.calls.some(c => c.nodeId.startsWith("review_") && (c.inputs.evidence.at(-1) as any).round === 1)).toBe(false);
        if (scenario === "model-truncated") {
          expect(read(2, "context").previous.evidence).toMatchObject({
            retry_strategy: expect.any(String), model_failure: { outcome: "output_truncated", attempts: [{ output_tokens: 8191 }] },
          });
          expect(read(2, "fixer").value.edits).toHaveLength(2);
          expect(read(2, "fixer").value.edits.every((edit: {path: string}) => edit.path === "sum.cjs")).toBe(true);
        }
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
        expect(read(2, "context").previous.evidence.retry_strategy).toBe(read(1, "ci_judger").value.retry_strategy);
        expect(read(2, "planner").value.strategy).toBe(read(1, "ci_judger").value.retry_strategy);
        const secondReviewers = models.calls.filter(c => c.nodeId.startsWith("review_") && (c.inputs.evidence.at(-1) as any).round === 2);
        expect(secondReviewers).toHaveLength(3);
        for (const dispatch of secondReviewers) {
          const evidence = dispatch.inputs.evidence.at(-1) as any;
          expect(evidence.repair_context).toMatchObject({ plan: read(2, "freeze_plan").plan,
            plan_sha256: read(2, "freeze_plan").plan_sha256, parent_head: read(1, "capture").candidate.head,
            previous: read(2, "context").previous });
          // This deterministic fixture proves delivery, not semantic correctness of its cosmetic patch.
          expect(evidence.repair_context.round_diff).toContain("-module.exports=(a,b)=>a+b;");
          expect(evidence.repair_context.round_diff).toContain("+module.exports=(a,b)=>a+b+0;");
          expect(read(2, "test_sources")).toEqual(evidence.sources);
          expect(evidence.source_evidence.sha256).toBe(e2eFixDigest(JSON.stringify(read(2, "test_sources"))));
        }
        expect(read(2, "publish").publication.pr).toBe(read(1, "publish").publication.pr);
        expect(models.calls.filter(c => c.nodeId === "judge_ci")).toHaveLength(2);
      }
      if (blockedReview || blockedModel) {
        expect(read(1, "record_candidate_judgment").action).toBe("pause");
        if (scenario === "duplicate-disposition") {
          expect(read(1, "record_candidate_judgment").feedback.findings).toEqual(read(1, "review_evidence").findings);
        }
        expect(fs.existsSync(path.join(task, "simulated-pr.json"))).toBe(false);
      } else expect(read(rounds, "complete")).toMatchObject({ action: unknownCi ? "pause" : "complete",
        production_eligible: false, acceptance: { eligible: !unknownCi } });
      for (let round = 1; round <= rounds; round++) {
        if (scenario.startsWith("model-") && round === 1) continue;
        expect(read(round, "fixer").usages).toHaveLength(1);
        expect(read(round, "fixer").usages[0].usage.input_tokens).toBe(101);
      }
      expect(models.calls.filter(c => c.nodeId === "fix")).toHaveLength(rounds);
      // Corrections retain the logical session/broker fence; each Worker
      // execution is separately scoped. Genuine repair rounds get fresh sessions.
      expect(new Set(models.calls.map(c => c.sessionId)).size).toBe(models.calls.length - (scenario.startsWith("review-contract-correct") ? 1 : 0));
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

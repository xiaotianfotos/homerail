import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DAGDispatcher, DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { edgeMatchesHandoff } from "../src/orchestration/dag-engine.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { createCredential } from "../src/persistence/credentials.js";
import { closeDb } from "../src/persistence/db.js";
import {
  resolveDagRunInputBindings,
  stageDagRunInputArtifact,
} from "../src/persistence/run-input-artifacts.js";
import {
  getRunArtifactBlobPath,
  listRunArtifacts,
} from "../src/persistence/run-artifacts.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";
import {
  _clearActiveRuns,
  createActiveRun,
  getActiveRun,
  getVerifiedRunWorkspaceEvidence,
  handoffActiveRun,
  recordActiveRunBrokerActionSuccess,
} from "../src/runtime/active-runs.js";

const TEMPLATE = path.resolve(import.meta.dirname, "../../assets/orchestrations/auto-fix-v2.yaml.template");
const MANIFEST_SHA256 = "1".repeat(64);

class RecordingDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope) {
    this.dispatched.push(envelope);
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "fake" };
  }
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.error));
  return String(result.stdout).trim();
}

function jsonSha(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sort(nested)]));
  };
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

async function tickUntil(
  executor: GraphExecutor,
  predicate: () => boolean,
  message: string | (() => string),
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    executor.tick("autofix-v2-run");
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

describe("Auto Fix v2 local-test convergence architecture", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousCommandAllowlist: string | undefined;
  let head: string;

  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    previousCommandAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-autofix-v2-"));
    process.env.HOMERAIL_HOME = home;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    closeDb();
    _clearActiveRuns();
    createCredential({
      id: "github-autofix",
      credential_type: "api_key",
      name: "Autofix broker token",
      secret: { value: "fake-github-token" },
    }, { actor: "test" });

    const repository = path.join(home, "workspace", "autofix-v2-run", "repo");
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "HomeRail Test"]);
    git(repository, ["config", "user.email", "homerail@example.invalid"]);
    fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "fixture"]);
    head = git(repository, ["rev-parse", "HEAD"]);
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousCommandAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = previousCommandAllowlist;
    const inputRoot = path.join(home, "workspace", "autofix-v2-run", "input");
    if (fs.existsSync(inputRoot)) fs.chmodSync(inputRoot, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });

  function createRun(taskCount = 1) {
    const parsed = parseWorkflowSource(fs.readFileSync(TEMPLATE, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    const task = stageDagRunInputArtifact({
      scope_id: "pilot",
      name: "task.md",
      media_type: "text/markdown",
      content: "# Real issue\n\nImplement the acceptance criteria.\n",
    });
    const planContent = {
      version: 1,
      task_document_sha256: task.sha256,
      tasks: Array.from({ length: taskCount }, (_unused, index) => ({
        id: taskCount === 1 ? "runtime" : `runtime-${index + 1}`,
        title: `Runtime ${index + 1}`,
        description: `Implement runtime part ${index + 1}`,
        files: [`src/runtime-${index + 1}.ts`],
        acceptance: ["passes"],
      })),
      local_tests: [{ id: "focused", command: "npm test -- --run focused", timeout_seconds: 900 }],
      shared: {
        repository_path: "repo",
        task_document: "input/task.md",
        task_plan: "input/task-plan.json",
        pr_context: "input/pr-context.json",
      },
    };
    const plan = stageDagRunInputArtifact({
      scope_id: "pilot",
      name: "task-plan.json",
      media_type: "application/json",
      content: JSON.stringify(planContent),
    });
    const pr = stageDagRunInputArtifact({
      scope_id: "pilot",
      name: "pr-context.json",
      media_type: "application/json",
      content: JSON.stringify({
        version: 1,
        owner: "acme",
        repo: "widget",
        pull_number: 172,
        clone_url: "https://github.com/acme/widget.git",
        head_ref: "autofix/issue-172",
        base_ref: "main",
        initial_head_sha: head,
        base_sha: head,
        task_document_sha256: task.sha256,
        require_draft: true,
        writable_paths: ["src", "tests"],
      }),
    });
    const bindings = resolveDagRunInputBindings("pilot", [
      { artifact_id: task.artifact_id, logical_name: "task_document", mount_path: "input/task.md" },
      { artifact_id: plan.artifact_id, logical_name: "task_plan", mount_path: "input/task-plan.json" },
      { artifact_id: pr.artifact_id, logical_name: "pr_context", mount_path: "input/pr-context.json" },
    ]);
    createActiveRun("autofix-v2-run", parsed, { initialPrompt: "{}", inputArtifacts: bindings });
    return { parsed, planContent };
  }

  function writeReport(workspace: string, phase: "aggregate" | "fix", status: "passed" | "failed") {
    const relative = `.homerail/test-reports/${phase}.json`;
    const absolute = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const report = {
      version: 1,
      phase,
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      status,
      commands: [{
        id: "focused",
        command: "npm test -- --run focused",
        timeout_seconds: 900,
        status,
        exit_code: status === "passed" ? 0 : 1,
        duration_ms: 12,
      }],
      summary: status === "passed" ? "focused test passed" : "focused test failed",
    };
    const bytes = `${JSON.stringify(report)}\n`;
    fs.writeFileSync(absolute, bytes);
    return { path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), status };
  }

  function recordReviewEvidence(
    nodeId: string,
    sessionId: string,
    decision: Record<string, unknown>,
    evidenceHead = head,
  ) {
    const quality = decision.quality as Record<string, unknown>;
    recordActiveRunBrokerActionSuccess({
      run_id: "autofix-v2-run",
      node_id: nodeId,
      session_id: sessionId,
      credential_ref: "github-autofix",
      broker: "github_pr",
      action: "pull_request_snapshot",
      result: { head_sha: evidenceHead },
    });
    recordActiveRunBrokerActionSuccess({
      run_id: "autofix-v2-run",
      node_id: nodeId,
      session_id: sessionId,
      credential_ref: "github-autofix",
      broker: "github_pr",
      action: "assess_review",
      result: {
        findings_sha256: jsonSha(decision.findings),
        coverage_ratio: quality.coverage_ratio,
        coverage_complete: quality.coverage_complete,
        test_report_sha256: quality.test_report_sha256,
        defect_load: quality.defect_load,
        score: quality.score,
        status: quality.status,
      },
    });
  }

  function reviewDecision(testReportSha: string, clean: boolean) {
    const findings = clean ? [] : [{
      id: "missing-guard",
      severity: "medium",
      category: "correctness",
      actionable: true,
      evidence: "The changed path lacks the required guard.",
      recommendation: "Add the guard and its focused test.",
    }];
    return {
      verdict: clean ? "clean" : "changes_requested",
      head_sha: head,
      summary: clean ? "No actionable defects remain." : "One actionable defect remains.",
      findings,
      feedback: clean ? [] : ["Add the missing guard and focused test."],
      fix_tasks: clean ? [] : [{ id: "round-fix", feedback: ["Add the missing guard and focused test."] }],
      quality: {
        status: clean ? "clean" : "needs_fix",
        findings_sha256: jsonSha(findings),
        coverage_ratio: 1,
        coverage_complete: true,
        test_report_sha256: testReportSha,
        defect_load: clean ? 0 : 3,
        score: clean ? 100 : 97,
      },
    };
  }

  function recordMutationEvidence(nodeId: string, sessionId: string) {
    for (const [action, result] of [
      ["pull_request_snapshot", { head_sha: head }],
      ["commit_workspace", { head_sha: head, manifest_sha256: MANIFEST_SHA256 }],
    ] as const) {
      recordActiveRunBrokerActionSuccess({
        run_id: "autofix-v2-run",
        node_id: nodeId,
        session_id: sessionId,
        credential_ref: "github-autofix",
        broker: "github_pr",
        action,
        result,
      });
    }
  }

  async function reachInitialReview(executor: GraphExecutor, dispatcher: RecordingDispatcher) {
    const { planContent } = createRun();
    handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", planContent);
    executor.tick("autofix-v2-run");
    const implementer = dispatcher.dispatched.find((entry) => entry.nodeId === "implement__item_0001");
    const abortReason = getActiveRun("autofix-v2-run")?.counters.abort_reason;
    expect(implementer, `fanout did not dispatch: ${String(abortReason ?? "unknown reason")}`)
      .toBeDefined();
    const workerPath = "workers/implement/inv_0001/item_0001";
    fs.writeFileSync(
      path.join(home, "workspace", "autofix-v2-run", workerPath, "worker.txt"),
      "implemented\n",
    );
    handoffActiveRun("autofix-v2-run", implementer!.nodeId, "result", {
      status: "implemented",
      task_id: "runtime",
      workspace_path: workerPath,
      summary: "implemented",
      tests: ["focused"],
    });
    await tickUntil(
      executor,
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "aggregate"),
      "aggregate was not dispatched",
    );
    const aggregate = dispatcher.dispatched.find((entry) => entry.nodeId === "aggregate")!;
    recordMutationEvidence("aggregate", aggregate.sessionId!);
    const report = writeReport(
      path.join(home, "workspace", "autofix-v2-run", "repo"),
      "aggregate",
      "passed",
    );
    handoffActiveRun("autofix-v2-run", "aggregate", "candidate", {
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "candidate",
      test_report: report,
    });
    await tickUntil(
      executor,
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "review_initial"),
      "initial review was not dispatched",
    );
    return {
      initial: dispatcher.dispatched.find((entry) => entry.nodeId === "review_initial")!,
      testReportSha: report.sha256,
    };
  }

  async function completeFixRound(
    executor: GraphExecutor,
    dispatcher: RecordingDispatcher,
    invocation: number,
  ) {
    const fixerId = invocation === 1
      ? "fix__item_0001"
      : `fix__inv_${String(invocation).padStart(4, "0")}__item_0001`;
    await tickUntil(
      executor,
      () => dispatcher.dispatched.some((entry) => entry.nodeId === fixerId),
      `fixer invocation ${invocation} was not dispatched`,
    );
    const fixer = dispatcher.dispatched.find((entry) => entry.nodeId === fixerId)!;
    recordMutationEvidence(fixer.nodeId, fixer.sessionId!);
    const fixPath = `fixers/fix/inv_${String(invocation).padStart(4, "0")}/item_0001`;
    const report = writeReport(
      path.join(home, "workspace", "autofix-v2-run", fixPath),
      "fix",
      "passed",
    );
    handoffActiveRun("autofix-v2-run", fixer.nodeId, "result", {
      status: "fixed",
      previous_head_sha: head,
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: `fixed round ${invocation}`,
      test_report: report,
    });
    await tickUntil(
      executor,
      () => dispatcher.dispatched.filter((entry) => entry.nodeId === "review_revision").length === invocation,
      `revision review ${invocation} was not dispatched`,
    );
    return {
      revision: dispatcher.dispatched.filter((entry) => entry.nodeId === "review_revision").at(-1)!,
      testReportSha: report.sha256,
    };
  }

  it("compiles without online-CI nodes and declares Manager-verified local reports", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const parsed = parseWorkflowSource(source);
    expect(parsed.meta.workflow_id).toBe("auto-fix-v2");
    expect(parsed.meta.agents?.analyzer).toBeUndefined();
    expect(source).not.toMatch(/action:\s*(?:validate_head|required_checks|checks_snapshot)/);
    expect(source).not.toMatch(/\bmax_[a-z_]*tool_calls[a-z_]*:/);
    expect(source).toContain('{"version":1,"phase":"aggregate"');
    expect(source).toContain('{"version":1,"phase":"fix"');
    expect(source).toContain('"exit_code":0');
    expect(source).toContain('"duration_ms":0');
    expect(source).toContain("Do not add fields such as tests_passed");
    expect(source).toContain("The broker returns a complete review_decision");
    expect(source).toContain("Do not use aliases such as file, title, body, or review_notes");
    expect(source).toContain("result_required_workspace_files:");
    expect(source).toContain("required_workspace_files:");
    expect(source).toContain("clean_reviews_required: 2");
    expect(parsed.graph.nodes.find((node) => node.node_id === "aggregate")?.extra?.workflow_spec_v1)
      .toMatchObject({
        output_workspace_file_requirements: {
          candidate: [{ path_field: "test_report.path", sha256_field: "test_report.sha256", contract: "TestReport" }],
        },
      });
    expect(parsed.graph.nodes.find((node) => node.node_id === "fix")?.gateway_config)
      .toMatchObject({
        result_required_workspace_files: [{
          path_field: "test_report.path",
          sha256_field: "test_report.sha256",
          contract: "TestReport",
        }],
      });
    expect(parsed.graph.nodes.find((node) => node.node_id === "fix_round_gate")?.gateway_config)
      .toMatchObject({
        max_iterations: 4,
        unwrap_single_join_value: true,
        field: "quality.status",
      });
    for (const [fromNode, fromPort] of [
      ["fix_round_gate", "unexpected_clean"],
      ["initial_confirmation_pair", "invalid"],
      ["revision_confirmation_pair", "invalid"],
      ["final_confirmation_pair", "invalid"],
    ] as const) {
      const edge = parsed.graph.edges.find((candidate) => (
        candidate.from_node === fromNode && candidate.from_port === fromPort
      ));
      expect(edge).toBeDefined();
      expect(edgeMatchesHandoff(edge!, fromPort)).toBe(true);
    }
    expect(validateJsonContract(parsed.meta.contracts?.TaskPlan, {
      version: 1,
      task_document_sha256: "a".repeat(64),
      tasks: [{ id: "one", title: "One", description: "Do it", files: ["src/a.ts"], acceptance: ["passes"] }],
      local_tests: [{ id: "test", command: "npm test", timeout_seconds: 900 }],
      shared: { repository_path: "repo", task_document: "input/task.md", task_plan: "input/task-plan.json", pr_context: "input/pr-context.json" },
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(parsed.meta.contracts?.TaskPlan, {
      version: 1,
      task_document_sha256: "a".repeat(64),
      tasks: [{ id: "one", title: "One", description: "Do it", files: ["src/a.ts"], acceptance: ["passes"] }],
      local_tests: [{ id: "unbounded", command: "npm test" }],
      shared: { repository_path: "repo", task_document: "input/task.md", task_plan: "input/task-plan.json", pr_context: "input/pr-context.json" },
    })).toMatchObject({ valid: false });
  });

  it("projects the read-only git metadata policy into real dispatch envelopes", () => {
    const { parsed, planContent } = createRun();
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", planContent);
    executor.tick("autofix-v2-run");

    const implementer = dispatcher.dispatched.find((entry) => entry.nodeId === "implement__item_0001");
    const abortReason = getActiveRun("autofix-v2-run")?.counters.abort_reason;
    expect(parsed.graph.nodes.find((node) => node.node_id === "implement")?.extra?.workflow_spec_v1)
      .toBeDefined();
    expect(implementer, `fanout did not dispatch: ${String(abortReason ?? "unknown reason")}`)
      .toBeDefined();
    expect(implementer?.workspaceAccess).toMatchObject({
      writable_paths: ["workers/implement/inv_0001/item_0001"],
      readonly_paths: ["input", "repo"],
      git_metadata_read_only: true,
    });
  });

  it("isolates three parallel implementers from sibling worktrees and shared Git metadata", () => {
    const { planContent } = createRun(3);
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", planContent);
    executor.tick("autofix-v2-run");

    const implementers = dispatcher.dispatched
      .filter((entry) => entry.nodeId.startsWith("implement__item_"));
    expect(implementers).toHaveLength(3);
    for (const [index, implementer] of implementers.entries()) {
      const ownPath = `workers/implement/inv_0001/item_${String(index + 1).padStart(4, "0")}`;
      const siblingPaths = [1, 2, 3]
        .filter((item) => item !== index + 1)
        .map((item) => `workers/implement/inv_0001/item_${String(item).padStart(4, "0")}`);
      expect(implementer.workspaceAccess).toMatchObject({
        writable_paths: [ownPath],
        readonly_paths: ["input", "repo"],
        git_metadata_read_only: true,
        snapshot_exclude_paths: siblingPaths,
      });
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps fanout worktree metadata valid when the run home uses an alternate filesystem spelling",
    () => {
      const aliasedHome = `${home}-alias`;
      fs.symlinkSync(home, aliasedHome, "dir");
      try {
        process.env.HOMERAIL_HOME = aliasedHome;
        closeDb();
        _clearActiveRuns();

        const { planContent } = createRun();
        const dispatcher = new RecordingDispatcher();
        const executor = new GraphExecutor(dispatcher);
        handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", planContent);
        executor.tick("autofix-v2-run");

        const implementer = dispatcher.dispatched.find((entry) => entry.nodeId === "implement__item_0001");
        const abortReason = getActiveRun("autofix-v2-run")?.counters.abort_reason;
        expect(implementer, `fanout did not dispatch: ${String(abortReason ?? "unknown reason")}`)
          .toBeDefined();
        const workerWorkspace = path.join(
          aliasedHome,
          "workspace",
          "autofix-v2-run",
          "workers",
          "implement",
          "inv_0001",
          "item_0001",
        );
        expect(git(workerWorkspace, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
        const pointer = fs.readFileSync(path.join(workerWorkspace, ".git"), "utf8")
          .replace(/^gitdir:\s*/u, "")
          .trim();
        const lexicalRunRoot = path.join(aliasedHome, "workspace", "autofix-v2-run");
        const lexicalAdminPath = path.resolve(workerWorkspace, pointer);
        expect(path.relative(lexicalRunRoot, lexicalAdminPath)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      } finally {
        _clearActiveRuns();
        closeDb();
        process.env.HOMERAIL_HOME = home;
        fs.unlinkSync(aliasedHome);
      }
    },
  );

  it("requires a valid report, runs a second real fixer, then converges after two fresh clean reviews", async () => {
    const { planContent } = createRun();
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    handoffActiveRun("autofix-v2-run", "prepare_repository", "ready", planContent);
    executor.tick("autofix-v2-run");

    const implementer = dispatcher.dispatched.find((entry) => entry.nodeId === "implement__item_0001");
    const abortReason = getActiveRun("autofix-v2-run")?.counters.abort_reason;
    expect(implementer, `fanout did not dispatch: ${String(abortReason ?? "unknown reason")}`)
      .toBeDefined();
    const workerPath = "workers/implement/inv_0001/item_0001";
    const workerWorkspace = path.join(home, "workspace", "autofix-v2-run", workerPath);
    fs.writeFileSync(path.join(workerWorkspace, "worker.txt"), "implemented\n");
    handoffActiveRun("autofix-v2-run", implementer!.nodeId, "result", {
      status: "implemented",
      task_id: "runtime",
      workspace_path: workerPath,
      summary: "implemented",
      tests: ["focused"],
    });
    await tickUntil(executor, () => dispatcher.dispatched.some((entry) => entry.nodeId === "aggregate"), "aggregate was not dispatched");
    const aggregate = dispatcher.dispatched.find((entry) => entry.nodeId === "aggregate")!;
    for (const [action, result] of [
      ["pull_request_snapshot", { head_sha: head }],
      ["commit_workspace", { head_sha: head, manifest_sha256: MANIFEST_SHA256 }],
    ] as const) {
      recordActiveRunBrokerActionSuccess({
        run_id: "autofix-v2-run",
        node_id: "aggregate",
        session_id: aggregate.sessionId!,
        credential_ref: "github-autofix",
        broker: "github_pr",
        action,
        result,
      });
    }
    const aggregateReport = writeReport(path.join(home, "workspace", "autofix-v2-run", "repo"), "aggregate", "passed");
    expect(() => handoffActiveRun("autofix-v2-run", "aggregate", "candidate", {
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "candidate",
      test_report: { ...aggregateReport, sha256: "0".repeat(64) },
    })).toThrow(/DAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT/);
    const reportPath = path.join(home, "workspace", "autofix-v2-run", "repo", aggregateReport.path);
    const savedReportPath = `${reportPath}.saved`;
    fs.renameSync(reportPath, savedReportPath);
    fs.symlinkSync(savedReportPath, reportPath);
    expect(() => handoffActiveRun("autofix-v2-run", "aggregate", "candidate", {
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "candidate",
      test_report: aggregateReport,
    })).toThrow(/symbolic link/);
    fs.unlinkSync(reportPath);
    fs.renameSync(savedReportPath, reportPath);
    handoffActiveRun("autofix-v2-run", "aggregate", "candidate", {
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "candidate",
      test_report: aggregateReport,
    });
    const aggregateArtifact = listRunArtifacts("autofix-v2-run")
      .find((artifact) => artifact.source.type === "workspace_evidence" && artifact.source.node_id === "aggregate");
    expect(aggregateArtifact).toMatchObject({ status: "ready", sha256: aggregateReport.sha256 });
    expect(fs.readFileSync(getRunArtifactBlobPath("autofix-v2-run", aggregateArtifact!.name)!, "utf8"))
      .toBe(fs.readFileSync(reportPath, "utf8"));
    fs.rmSync(reportPath);
    expect(getVerifiedRunWorkspaceEvidence("autofix-v2-run", head, "TestReport"))
      .toMatchObject({ sha256: aggregateReport.sha256, artifact_name: aggregateArtifact!.name });

    await tickUntil(executor, () => dispatcher.dispatched.some((entry) => entry.nodeId === "review_initial"), "initial review was not dispatched");
    const initial = dispatcher.dispatched.find((entry) => entry.nodeId === "review_initial")!;
    expect(initial.outputContracts).toMatchObject({
      reviewed: {
        contract: "ReviewDecision",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "head_sha", "summary", "findings", "feedback", "fix_tasks", "quality"],
        },
      },
    });
    const requested = reviewDecision(aggregateReport.sha256, false);
    recordReviewEvidence("review_initial", initial.sessionId!, requested);
    handoffActiveRun("autofix-v2-run", "review_initial", "reviewed", requested);

    await tickUntil(executor, () => dispatcher.dispatched.some((entry) => entry.nodeId === "fix__item_0001"), "fixer was not dispatched");
    const fixer = dispatcher.dispatched.find((entry) => entry.nodeId === "fix__item_0001")!;
    const fixPath = "fixers/fix/inv_0001/item_0001";
    for (const [action, result] of [
      ["pull_request_snapshot", { head_sha: head }],
      ["commit_workspace", { head_sha: head, manifest_sha256: MANIFEST_SHA256 }],
    ] as const) {
      recordActiveRunBrokerActionSuccess({
        run_id: "autofix-v2-run",
        node_id: fixer.nodeId,
        session_id: fixer.sessionId!,
        credential_ref: "github-autofix",
        broker: "github_pr",
        action,
        result,
      });
    }
    const fixReport = writeReport(path.join(home, "workspace", "autofix-v2-run", fixPath), "fix", "passed");
    handoffActiveRun("autofix-v2-run", fixer.nodeId, "result", {
      status: "fixed",
      previous_head_sha: head,
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "fixed",
      test_report: fixReport,
    });
    const fixReportPath = path.join(home, "workspace", "autofix-v2-run", fixPath, fixReport.path);
    fs.rmSync(fixReportPath);
    expect(getVerifiedRunWorkspaceEvidence("autofix-v2-run", head, "TestReport"))
      .toMatchObject({ sha256: fixReport.sha256 });

    await tickUntil(executor, () => dispatcher.dispatched.some((entry) => entry.nodeId === "review_revision"), "revision review was not dispatched");
    const firstRevision = dispatcher.dispatched.find((entry) => entry.nodeId === "review_revision")!;
    const stillRequested = reviewDecision(fixReport.sha256, false);
    recordReviewEvidence("review_revision", firstRevision.sessionId!, stillRequested);
    handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", stillRequested);

    await tickUntil(
      executor,
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "fix__inv_0002__item_0001"),
      "second fixer was not dispatched",
    );
    const secondFixer = dispatcher.dispatched.find((entry) => entry.nodeId === "fix__inv_0002__item_0001")!;
    const secondFixPath = "fixers/fix/inv_0002/item_0001";
    for (const [action, result] of [
      ["pull_request_snapshot", { head_sha: head }],
      ["commit_workspace", { head_sha: head, manifest_sha256: MANIFEST_SHA256 }],
    ] as const) {
      recordActiveRunBrokerActionSuccess({
        run_id: "autofix-v2-run",
        node_id: secondFixer.nodeId,
        session_id: secondFixer.sessionId!,
        credential_ref: "github-autofix",
        broker: "github_pr",
        action,
        result,
      });
    }
    const secondFixReport = writeReport(
      path.join(home, "workspace", "autofix-v2-run", secondFixPath),
      "fix",
      "passed",
    );
    handoffActiveRun("autofix-v2-run", secondFixer.nodeId, "result", {
      status: "fixed",
      previous_head_sha: head,
      head_sha: head,
      manifest_sha256: MANIFEST_SHA256,
      summary: "fixed again",
      test_report: secondFixReport,
    });

    await tickUntil(
      executor,
      () => dispatcher.dispatched.filter((entry) => entry.nodeId === "review_revision").length === 2,
      "second revision review was not dispatched",
    );
    const revision = dispatcher.dispatched.filter((entry) => entry.nodeId === "review_revision").at(-1)!;
    const clean = reviewDecision(secondFixReport.sha256, true);
    recordReviewEvidence("review_revision", revision.sessionId!, clean);
    handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", clean);

    await tickUntil(executor, () => dispatcher.dispatched.some((entry) => entry.nodeId === "confirm_revision"), "confirmation review was not dispatched");
    const confirmation = dispatcher.dispatched.find((entry) => entry.nodeId === "confirm_revision")!;
    recordReviewEvidence("confirm_revision", confirmation.sessionId!, clean);
    handoffActiveRun("autofix-v2-run", "confirm_revision", "reviewed", clean);
    await tickUntil(executor, () => getActiveRun("autofix-v2-run")?.status === "completed", () => {
      const run = getActiveRun("autofix-v2-run");
      return `run did not converge: status=${run?.status} states=${JSON.stringify(Object.fromEntries(run?.dagRun.nodeStates ?? []))}`;
    });

    expect(new Set([initial.sessionId, firstRevision.sessionId, revision.sessionId, confirmation.sessionId]).size).toBe(4);
    expect(getActiveRun("autofix-v2-run")?.counters.fanout_invocations).toMatchObject({ implement: 1, fix: 2 });
    expect(getActiveRun("autofix-v2-run")?.status).toBe("completed");
    const artifacts = await finalizeRunArtifacts("autofix-v2-run", "success");
    const finalResult = artifacts.find((artifact) => artifact.name === "autofix-result.json");
    expect(finalResult?.error).toBeUndefined();
    expect(finalResult).toMatchObject({ status: "ready" });
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath("autofix-v2-run", "autofix-result.json")!, "utf8")))
      .toMatchObject({
        version: 1,
        status: "ready_for_ci",
        repository: "acme/widget",
        pull_number: 172,
        head_sha: head,
        review_confirmation_count: 2,
        quality_score: 100,
      });
  }, 30_000);

  it("rejects two clean reviews when their exact heads differ", async () => {
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const { initial, testReportSha } = await reachInitialReview(executor, dispatcher);
    const clean = reviewDecision(testReportSha, true);
    recordReviewEvidence("review_initial", initial.sessionId!, clean);
    handoffActiveRun("autofix-v2-run", "review_initial", "reviewed", clean);

    await tickUntil(
      executor,
      () => dispatcher.dispatched.some((entry) => entry.nodeId === "confirm_initial"),
      "confirmation review was not dispatched",
    );
    const confirmation = dispatcher.dispatched.find((entry) => entry.nodeId === "confirm_initial")!;
    const driftedHead = "c".repeat(40);
    const drifted = { ...clean, head_sha: driftedHead };
    recordReviewEvidence("confirm_initial", confirmation.sessionId!, drifted, driftedHead);
    handoffActiveRun("autofix-v2-run", "confirm_initial", "reviewed", drifted);

    await tickUntil(
      executor,
      () => getActiveRun("autofix-v2-run")?.status === "failed",
      "mismatched clean review heads did not fail closed",
    );
    expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get("verify_confirmation")).toBe("FAILED");
    expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get("finalize_ready")).not.toBe("COMPLETED");
  }, 30_000);

  it("runs four real fixers before exhausting to needs_human", async () => {
    const dispatcher = new RecordingDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const { initial, testReportSha } = await reachInitialReview(executor, dispatcher);
    const initialDecision = reviewDecision(testReportSha, false);
    recordReviewEvidence("review_initial", initial.sessionId!, initialDecision);
    handoffActiveRun("autofix-v2-run", "review_initial", "reviewed", initialDecision);

    const reviewSessions = [initial.sessionId!];
    for (let invocation = 1; invocation <= 4; invocation++) {
      const { revision, testReportSha: fixReportSha } = await completeFixRound(
        executor,
        dispatcher,
        invocation,
      );
      reviewSessions.push(revision.sessionId!);
      const requested = reviewDecision(fixReportSha, false);
      recordReviewEvidence("review_revision", revision.sessionId!, requested);
      handoffActiveRun("autofix-v2-run", "review_revision", "reviewed", requested);
    }

    await tickUntil(
      executor,
      () => getActiveRun("autofix-v2-run")?.status === "cancelled",
      "run did not exhaust to needs_human",
    );
    expect(new Set(reviewSessions).size).toBe(5);
    expect(getActiveRun("autofix-v2-run")?.counters.fanout_invocations).toMatchObject({
      implement: 1,
      fix: 4,
    });
    expect(getActiveRun("autofix-v2-run")?.dagRun.nodeStates.get("fix_round_gate")).toBe("CANCELLED");
    expect(getActiveRun("autofix-v2-run")?.counters.gateway_iterations.fix_round_gate).toBe(4);
    expect(getActiveRun("autofix-v2-run")?.dagRun.graph.nodes.some((node) => node.node_id.includes("inv_0005"))).toBe(false);
  }, 30_000);
});

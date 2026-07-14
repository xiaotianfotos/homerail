import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { compileWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import { getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import {
  _clearActiveRuns,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import {
  _invokeHostCodexVoiceToolForTest,
} from "../src/server/host-codex-manager-agent.js";
import {
  ensureManagerSkillsInstalled,
  readManagerSkill,
} from "../src/server/manager-skills.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";

function passingReviewReport(): Record<string, unknown> {
  const categories = ["runtime", "security", "tests", "frontend"];
  return {
    repo: "xiaotianfotos/homerail",
    pr: 25,
    base: "a".repeat(40),
    head: "b".repeat(40),
    status: "pass",
    confidence: "high",
    summary: "No actionable findings",
    actionable_count: 0,
    findings: [],
    reviewer_results: categories.map((reviewer) => ({
      reviewer,
      status: "complete",
      summary: `${reviewer} review complete`,
      findings: [],
    })),
  };
}

describe("PR Review scenario assets", () => {
  let oldHome: string | undefined;
  let oldAssetDir: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAssetDir = process.env.HOMERAIL_ASSET_DIR;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-pr-review-scenario-"));
    process.env.HOMERAIL_HOME = tmpHome;
    delete process.env.HOMERAIL_ASSET_DIR;
    closeDb();
    _clearActiveRuns();
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldAssetDir === undefined) delete process.env.HOMERAIL_ASSET_DIR;
    else process.env.HOMERAIL_ASSET_DIR = oldAssetDir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("compiles the concrete topology with four reviewers and 2-of-3 verification", () => {
    const file = path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-review.yaml.template");
    const source = fs.readFileSync(file, "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({ workflow_id: "pr-review" });
    expect(result.canonical?.artifacts).toEqual([
      expect.objectContaining({
        name: "pr-review.json",
        source: { type: "handoff", node: "publish", port: "published" },
        contract: "PublishedReview",
      }),
      expect.objectContaining({
        name: "pr-review.md",
        source: { type: "handoff", node: "publish", port: "published", json_pointer: "/markdown" },
        media_type: "text/markdown",
      }),
    ]);
    const nodes = result.canonical?.nodes ?? [];
    expect(nodes.filter((node) => node.id.endsWith("_review")).map((node) => node.id).sort()).toEqual([
      "frontend_review",
      "runtime_review",
      "security_review",
      "test_review",
    ]);
    expect(nodes.find((node) => node.id === "verification_quorum")?.config).toMatchObject({
      mode: "n_of_m",
      threshold: 2,
      field: "vote",
    });
    expect(nodes.find((node) => node.id === "quorum_result")?.config).toMatchObject({
      mode: "any",
      field: "passed",
      passed_port: "decided",
    });
    expect(nodes.find((node) => node.id === "publication_outcome")?.config).toMatchObject({
      field: "quorum.passed",
      default: "rejected",
    });
    expect(nodes.filter((node) => node.agent === "refiner")).toHaveLength(1);
    expect(nodes.filter((node) => node.agent === "publisher")).toHaveLength(1);
    const agents = parseWorkflowSource(source).meta.agents ?? {};
    for (const agentId of [
      "preparer",
      "runtime_reviewer",
      "security_reviewer",
      "test_reviewer",
      "frontend_reviewer",
      "synthesizer",
      "refiner",
      "evidence_voter",
      "false_positive_voter",
      "coverage_voter",
      "publisher",
    ]) {
      expect(agents[agentId]?.system).toMatch(/final action MUST\s+call\s+(?:the\s+)?handoff/);
    }
    expect(agents.preparer?.system).toContain('"repository_path":"/workspace/repository"');
    expect(agents.preparer?.system).toContain("base_clone_url");
    expect(agents.preparer?.system).toContain("head_clone_url");
    expect(agents.preparer?.system).not.toContain("https://github.com/<repo>.git");
    expect(agents.preparer?.system).not.toContain('"status":"ready"');
    expect(nodes.find((node) => node.id === "synthesize")?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "context" }),
    ]));

    const publishedContract = parseWorkflowSource(source).meta.contracts?.PublishedReview;
    const publication = {
      report: passingReviewReport(),
      markdown: "# Review",
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    };
    expect(validateJsonContract(publishedContract, publication)).toMatchObject({ valid: true });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      quorum: { passed: true, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      report: { status: "inconclusive" },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      report: { ...passingReviewReport(), status: "inconclusive" },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(publishedContract, {
      ...publication,
      report: { status: "pass" },
    })).toMatchObject({ valid: false });

    const inputContract = parseWorkflowSource(source).meta.contracts?.PRReviewInput;
    const reviewInput = {
      repo: "enterprise/homerail",
      pr: 8,
      base: "a".repeat(40),
      head: "b".repeat(40),
      base_clone_url: "https://github.example/enterprise/homerail.git",
      head_clone_url: "https://github.example/contributor/homerail.git",
      expected_usage: 8,
      budget_key: "pr-review:enterprise/homerail:2026-07-13",
    };
    expect(validateJsonContract(inputContract, reviewInput)).toMatchObject({ valid: true });
    expect(validateJsonContract(inputContract, {
      ...reviewInput,
      base_clone_url: "https://token@github.example/enterprise/homerail.git",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(inputContract, {
      ...reviewInput,
      head_clone_url: "https://github.example/contributor/homerail.git?token=secret",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(inputContract, {
      ...reviewInput,
      head: "b".repeat(12),
    })).toMatchObject({ valid: false });
  });

  it("installs Manager guidance and lists tracked template assets", async () => {
    expect(ensureManagerSkillsInstalled().installed).toContain("homerail-pr-review");
    expect(readManagerSkill("homerail-pr-review")?.content).toContain("create_and_run");

    const listed = await _invokeHostCodexVoiceToolForTest("list_orchestrations", {});
    const text = listed.result.content.map((entry) => entry.text).join("\n");
    expect(text).toContain("pr-review.yaml.template");
  });

  it("keeps the GitHub adapter thin, advisory, and off untrusted fork PRs", () => {
    const workflow = fs.readFileSync(path.resolve(process.cwd(), "..", ".github", "workflows", "pr-review.yml"), "utf8");
    const parsed = parseYaml(workflow) as { jobs: { review: { env: Record<string, string>; steps: Array<{ name: string; env?: Record<string, string> }> } } };
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow.match(/continue-on-error: true/g)).toHaveLength(2);
    expect(workflow).toContain("dag run-template pr-review");
    expect(workflow).toContain('dag artifact "$RUN_ID" pr-review.json');
    expect(workflow).toContain('dag artifact "$RUN_ID" pr-review.md');
    expect(workflow).not.toContain("--output-dir");
    expect(workflow).toContain("$GITHUB_STEP_SUMMARY");
    expect(parsed.jobs.review.env.HOMERAIL_GITHUB_API_BASE_URL).toBe("${{ github.api_url }}");
    expect(parsed.jobs.review.env).not.toHaveProperty("HOMERAIL_HOME");
    expect(parsed.jobs.review.steps.find((step) => step.name === "Run HomeRail PR Review DAG")?.env?.HOMERAIL_HOME)
      .toBe("${{ runner.temp }}/homerail-pr-review-cli-${{ github.run_id }}");
  });

  it("keeps PR closeout manual, thin, isolated, and unable to merge", () => {
    const workflow = fs.readFileSync(path.resolve(process.cwd(), "..", ".github", "workflows", "pr-closeout.yml"), "utf8");
    const parsed = parseYaml(workflow) as { jobs: { closeout: { env: Record<string, string>; steps: Array<{ name: string; env?: Record<string, string> }> } } };
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("dag run-template pr-closeout");
    expect(workflow).toContain('dag artifact "$RUN_ID" pr-closeout.json');
    expect(workflow).not.toContain("closeout-report");
    expect(workflow).toContain("HOMERAIL_HOME: ${{ runner.temp }}/homerail-pr-closeout-cli-${{ github.run_id }}");
    expect(workflow).not.toContain("gh pr merge");
    expect(workflow).toContain("This workflow never merges the pull request.");
    expect(parsed.jobs.closeout.env).not.toHaveProperty("HOMERAIL_HOME");
    expect(parsed.jobs.closeout.steps.find((step) => step.name === "Start deterministic closeout")?.env?.HOMERAIL_HOME)
      .toBe("${{ runner.temp }}/homerail-pr-closeout-cli-${{ github.run_id }}");
  });

  it("executes budget, four reviews, synthesis, 2-of-3 quorum, and publication", async () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-review.yaml.template"),
      "utf8",
    );
    const parsed = parseWorkflowSource(source);
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const input = {
      trigger_id: "manual",
      trigger_type: "manual",
      fire_key: "manual:xiaotianfotos/homerail#25:bbbbbbb",
      payload: {
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
        base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        head_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        expected_usage: 8,
        budget_key: "pr-review:xiaotianfotos/homerail:2026-07-12",
      },
    };
    executor.createRun("pr-review-runtime", parsed, JSON.stringify(input));
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("prepare");

    const context = {
      repo: "xiaotianfotos/homerail",
      pr: 25,
      base: "a".repeat(40),
      head: "b".repeat(40),
      repository_path: "/workspace/repository",
      changed_files: ["src/run.ts"],
      diff_stat: "1 file changed",
    };
    handoffActiveRun("pr-review-runtime", "prepare", "ready", context);
    expect(executor.tick("pr-review-runtime")).toBe(4);

    const categories = ["runtime", "security", "tests", "frontend"] as const;
    for (const category of categories) {
      handoffActiveRun("pr-review-runtime", `${category === "tests" ? "test" : category}_review`, "reviewed", {
        reviewer: category,
        status: "complete",
        summary: `${category} review complete`,
        findings: [],
      });
    }
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("synthesize");

    const report = passingReviewReport();
    handoffActiveRun("pr-review-runtime", "synthesize", "drafted", report);
    expect(executor.tick("pr-review-runtime")).toBe(3);
    handoffActiveRun("pr-review-runtime", "evidence_vote", "voted", {
      voter: "evidence", vote: "accept", confidence: "high", evidence: "grounded", finding_verdicts: [],
    });
    handoffActiveRun("pr-review-runtime", "false_positive_vote", "voted", {
      voter: "false_positive", vote: "reject", confidence: "medium", evidence: "one concern", finding_verdicts: [],
    });
    handoffActiveRun("pr-review-runtime", "coverage_vote", "voted", {
      voter: "coverage", vote: "accept", confidence: "high", evidence: "all scopes present", finding_verdicts: [],
    });
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("refine");

    handoffActiveRun("pr-review-runtime", "refine", "refined", report);
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("publish");

    handoffActiveRun("pr-review-runtime", "publish", "published", {
      report,
      markdown: "# HomeRail PR Review\n\nNo actionable findings.",
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    });
    executor.tick("pr-review-runtime");

    expect(getActiveRun("pr-review-runtime")?.status).toBe("completed");
    expect(loadRunSnapshot("pr-review-runtime")?.handoffs).toContainEqual(expect.objectContaining({
      fromNode: "publish",
      port: "published",
    }));

    expect(await finalizeRunArtifacts("pr-review-runtime", "success")).toEqual([
      expect.objectContaining({ name: "pr-review.json", status: "ready" }),
      expect.objectContaining({ name: "pr-review.md", status: "ready" }),
    ]);
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath("pr-review-runtime", "pr-review.json")!, "utf8")))
      .toMatchObject({ report: { status: "pass" }, quorum: { passed: true, successes: 2 } });
    expect(fs.readFileSync(getRunArtifactBlobPath("pr-review-runtime", "pr-review.md")!, "utf8"))
      .toBe("# HomeRail PR Review\n\nNo actionable findings.\n");
  });
});

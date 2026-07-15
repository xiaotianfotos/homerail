import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
  failActiveRun,
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

function installPrepareCommandStub(
  parsed: ReturnType<typeof parseWorkflowSource>,
  options: { diffTruncated?: boolean } = {},
): void {
  const prepare = parsed.graph.nodes.find((node) => node.node_id === "prepare");
  if (!prepare?.gateway_config) throw new Error("prepare command node is missing");
  const diffTruncated = options.diffTruncated ?? false;
  prepare.gateway_config.command = [
    "node",
    "-e",
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s),r=Array.isArray(i.request)?i.request.at(-1):undefined,p=r?.input?.payload;if(!p)throw new Error('missing request');process.stdout.write(JSON.stringify({repo:p.repo,pr:p.pr,base:p.base,head:p.head,repository_path:'/workspace/repository',changed_files:['src/run.ts'],diff_stat:'1 file changed',diff_patch:'diff --git a/src/run.ts b/src/run.ts',diff_truncated:" + JSON.stringify(diffTruncated) + "}))})",
  ];
}

function productionPrepareCommand(): string {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-review.yaml.template"),
    "utf8",
  );
  const parsed = parseWorkflowSource(source);
  const command = parsed.graph.nodes.find((node) => node.node_id === "prepare")?.gateway_config?.command;
  if (!Array.isArray(command) || typeof command[2] !== "string") {
    throw new Error("production prepare command is missing");
  }
  return command[2];
}

function prepareCommandInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: [{
      input: {
        payload: {
          repo: "enterprise/homerail",
          pr: 8,
          base: "a".repeat(40),
          head: "b".repeat(40),
          base_clone_url: "https://github.example/enterprise/homerail.git",
          head_clone_url: "https://github.example/enterprise/homerail.git",
          expected_usage: 8,
          budget_key: "pr-review:enterprise/homerail:prepare-command",
          ...overrides,
        },
      },
    }],
  };
}

describe("PR Review scenario assets", () => {
  let oldHome: string | undefined;
  let oldAssetDir: string | undefined;
  let oldCommandAllowlist: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAssetDir = process.env.HOMERAIL_ASSET_DIR;
    oldCommandAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-pr-review-scenario-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
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
    if (oldCommandAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldCommandAllowlist;
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
        source: { type: "handoff", node: "refine", port: "finalized" },
        contract: "FinalReview",
      }),
      expect.objectContaining({
        name: "pr-review.md",
        source: { type: "handoff", node: "publish", port: "published", json_pointer: "/markdown" },
        media_type: "text/markdown",
      }),
    ]);
    const nodes = result.canonical?.nodes ?? [];
    expect(nodes.filter((node) => node.id.endsWith("_review") && !node.id.startsWith("normalize_"))
      .map((node) => node.id).sort()).toEqual([
      "frontend_review",
      "runtime_review",
      "security_review",
      "test_review",
    ]);
    for (const reviewer of ["runtime", "security", "test", "frontend"]) {
      expect(nodes.find((node) => node.id === `${reviewer}_review`)?.config).toMatchObject({
        allowed_builtin_tools: [],
        allowed_dag_tools: ["handoff"],
      });
      expect(nodes.find((node) => node.id === `normalize_${reviewer}_review`)).toMatchObject({
        kind: "command",
        depends_on: [`${reviewer}_review`],
        outputs: [expect.objectContaining({ name: "reviewed", contract: "ReviewerResult" })],
        config: expect.objectContaining({
          success_port: "reviewed",
          failure_port: "reviewed",
          parse_stdout: "json",
          result_payload: "value",
        }),
      });
    }
    expect(nodes.find((node) => node.id === "collect_reviews")?.config).toMatchObject({
      mode: "all",
      field: "status",
      success_values: ["complete", "failed"],
    });
    expect(nodes.find((node) => node.id === "verification_quorum")?.config).toMatchObject({
      mode: "n_of_m",
      threshold: 2,
      field: "vote",
    });
    expect(nodes.find((node) => node.id === "coverage_vote")?.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "voted", contract: "CoverageVote" }),
    ]));
    for (const voter of ["evidence_vote", "false_positive_vote"]) {
      expect(nodes.find((node) => node.id === voter)).toMatchObject({
        config: expect.objectContaining({
          allowed_builtin_tools: [],
          allowed_dag_tools: ["handoff"],
        }),
        inputs: expect.arrayContaining([
          expect.objectContaining({ name: "report", contract: "DraftReviewReport" }),
          expect.objectContaining({ name: "context", contract: "ReviewContext" }),
        ]),
      });
    }
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
    expect(nodes.find((node) => node.agent === "publisher")?.config).toMatchObject({
      allowed_builtin_tools: [],
      allowed_dag_tools: ["get_graph_context", "handoff"],
    });
    const agents = parseWorkflowSource(source).meta.agents ?? {};
    for (const agentId of [
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
    for (const agentId of [
      "runtime_reviewer",
      "security_reviewer",
      "test_reviewer",
      "frontend_reviewer",
      "evidence_voter",
      "false_positive_voter",
    ]) {
      expect(agents[agentId]?.system).toContain("diff_truncated");
    }
    for (const agentId of [
      "runtime_reviewer",
      "synthesizer",
      "evidence_voter",
      "false_positive_voter",
    ]) {
      expect(agents[agentId]?.system).toMatch(/GitHub\s+Enterprise/);
      expect(agents[agentId]?.system).toContain("clone_url");
    }
    const prepare = nodes.find((node) => node.id === "prepare");
    expect(prepare).toMatchObject({
      kind: "command",
      config: expect.objectContaining({
        command: ["node", "-e", expect.any(String)],
        cwd: "$run_workspace",
        stdin_field: "$inputs",
        success_port: "ready",
        failure_port: "failed",
        parse_stdout: "json",
        result_payload: "value",
      }),
    });
    const prepareCode = String((prepare?.config?.command as unknown[] | undefined)?.[2]);
    expect(prepareCode).toContain("base_clone_url");
    expect(prepareCode).toContain("head_clone_url");
    expect(prepareCode).toContain("[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\.git$");
    expect(prepareCode).toContain("credential.helper=");
    expect(prepareCode).toContain("GIT_CONFIG_NOSYSTEM");
    expect(prepareCode).toContain("protocol.file.allow=never");
    expect(prepareCode).toContain("--shortstat");
    expect(prepareCode).toContain("--unified=80");
    expect(prepareCode).toContain("diff_patch");
    expect(prepareCode).toContain("diff_truncated");
    expect(prepareCode).toContain("repository_path: '/workspace/repository'");
    expect(agents).not.toHaveProperty("preparer");
    expect(result.canonical?.policies?.max_corrections_per_node).toBe(5);
    expect(nodes.find((node) => node.id === "synthesize")?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "context" }),
    ]));

    const contracts = parseWorkflowSource(source).meta.contracts ?? {};
    expect(validateJsonContract(contracts.ReviewContext, {
      repo: "xiaotianfotos/homerail",
      pr: 25,
      base: "a".repeat(40),
      head: "b".repeat(40),
      repository_path: "/workspace/repository",
      changed_files: ["src/run.ts"],
      diff_stat: "1 file changed",
      diff_patch: "diff --git a/src/run.ts b/src/run.ts",
      diff_truncated: false,
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.ReviewContext, {
      repo: "xiaotianfotos/homerail",
      pr: 25,
      base: "a".repeat(40),
      head: "b".repeat(40),
      repository_path: "/workspace/repository",
      changed_files: ["src/run.ts"],
      diff_stat: "1 file changed",
      diff_patch: "diff --git a/src/run.ts b/src/run.ts\n... truncated",
      diff_truncated: true,
    })).toMatchObject({ valid: true });
    const finalReview = {
      report: passingReviewReport(),
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    };
    expect(validateJsonContract(contracts.FinalReview, finalReview)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      quorum: { passed: true, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      report: { status: "inconclusive" },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      report: { ...passingReviewReport(), status: "inconclusive" },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.FinalReview, {
      ...finalReview,
      report: { status: "pass" },
    })).toMatchObject({ valid: false });

    const publication = {
      run_id: "a".repeat(24),
      markdown: `# Review\n\n**HomeRail Run ID:** \`${"a".repeat(24)}\``,
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    };
    expect(validateJsonContract(contracts.PublishedReview, publication)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.PublishedReview, {
      ...publication,
      run_id: "${run_id}",
      markdown: "# Review\n\n**HomeRail Run ID:** `${run_id}`",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.PublishedReview, {
      ...publication,
      quorum: { passed: true, successes: 1, total: 3, threshold: 2 },
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
      base_clone_url: "https://github.example/git/enterprise/homerail.git",
    })).toMatchObject({ valid: false });
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

  it("executes production prepare URL validation against hostile clone URLs", () => {
    const cwd = path.join(tmpHome, "prepare-url-validation");
    fs.mkdirSync(cwd, { recursive: true });
    const command = productionPrepareCommand();
    for (const base_clone_url of [
      "https://token@github.example/enterprise/homerail.git",
      "http://github.example/enterprise/homerail.git",
      "https://github.example/enterprise/homerail.git?token=secret",
      "https://github.example/git/enterprise/homerail.git",
    ]) {
      const result = spawnSync(process.execPath, ["-e", command], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify(prepareCommandInput({ base_clone_url })),
        maxBuffer: 2_000_000,
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("repository URL must be credential-free HTTPS");
      expect(fs.existsSync(path.join(cwd, "repository"))).toBe(false);
    }
  }, 30_000);

  it.runIf(process.platform !== "win32")(
    "executes production prepare truncation with deterministic Git output",
    () => {
      const cwd = path.join(tmpHome, "prepare-truncation");
      const bin = path.join(cwd, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const fakeGit = path.join(bin, "fake-git.cjs");
      const head = "b".repeat(40);
      fs.writeFileSync(fakeGit, [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const has = (value) => args.includes(value);",
        "if (has('clone')) fs.mkdirSync(args.at(-1), { recursive: true });",
        `else if (has('rev-parse')) process.stdout.write(${JSON.stringify(head)});`,
        `else if (has('diff') && has('--name-only')) process.stdout.write(${JSON.stringify("src/quoted.ts\0")});`,
        "else if (has('diff') && has('--shortstat')) process.stdout.write('1 file changed, 1 insertion(+), 1 deletion(-)');",
        "else if (has('diff')) process.stdout.write('\"'.repeat(700000));",
      ].join("\n"));
      const git = path.join(bin, "git");
      fs.writeFileSync(git, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeGit)});\n`);
      fs.chmodSync(git, 0o755);

      const result = spawnSync(process.execPath, ["-e", productionPrepareCommand()], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify(prepareCommandInput()),
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        maxBuffer: 2_000_000,
      });
      if (result.status !== 0) {
        throw new Error(`production prepare command failed: ${result.stderr || result.stdout}`);
      }
      const context = JSON.parse(result.stdout) as {
        head: string;
        changed_files: string[];
        diff_patch: string;
        diff_truncated: boolean;
      };
      expect(context).toMatchObject({
        head,
        changed_files: ["src/quoted.ts"],
        diff_truncated: true,
      });
      expect(context.diff_patch).toContain("HomeRail diff truncated by deterministic evidence limit");
      expect(context.diff_patch.length).toBeLessThan(500000);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(900000);
    },
    30_000,
  );

  it("installs Manager guidance and lists tracked template assets", async () => {
    expect(ensureManagerSkillsInstalled().installed).toContain("homerail-pr-review");
    expect(readManagerSkill("homerail-pr-review")?.content).toContain("create_and_run");

    const listed = await _invokeHostCodexVoiceToolForTest("list_orchestrations", {});
    const text = listed.result.content.map((entry) => entry.text).join("\n");
    expect(text).toContain("pr-review.yaml.template");
  });

  it("starts PR Review from Host Codex with code-resolved immutable GitHub metadata", async () => {
    let createRunBody: Record<string, unknown> | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/repos/xiaotianfotos/homerail/pulls/25") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          title: "Native A2UI",
          user: { login: "contributor" },
          base: {
            sha: "a".repeat(40),
            repo: {
              full_name: "xiaotianfotos/homerail",
              clone_url: "https://github.com/xiaotianfotos/homerail.git",
            },
          },
          head: {
            sha: "b".repeat(40),
            repo: {
              full_name: "contributor/homerail",
              clone_url: "https://github.com/contributor/homerail.git",
            },
          },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/runs/create-and-run") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          createRunBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { runId: "host-pr-review-run" } }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const previousGithubApi = process.env.HOMERAIL_GITHUB_API_BASE_URL;
    process.env.HOMERAIL_GITHUB_API_BASE_URL = baseUrl;
    try {
      const invoked = await _invokeHostCodexVoiceToolForTest(
        "run_pr_review",
        { repo: "xiaotianfotos/homerail", pr: 25, expected_usage: 8 },
        { managerRestUrl: `${baseUrl}/api` },
      );
      expect(JSON.parse(invoked.result.content[0].text)).toMatchObject({
        run_id: "host-pr-review-run",
        workflow_id: "pr-review",
        base: "a".repeat(40),
        head: "b".repeat(40),
      });
      expect(createRunBody).toMatchObject({ yamlPath: "assets/orchestrations/pr-review.yaml.template" });
      const envelope = JSON.parse(String(createRunBody?.prompt)) as Record<string, unknown>;
      expect(envelope).toMatchObject({
        trigger_id: "manager-agent",
        payload: {
          repo: "xiaotianfotos/homerail",
          pr: 25,
          base: "a".repeat(40),
          head: "b".repeat(40),
          base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
          head_clone_url: "https://github.com/contributor/homerail.git",
          expected_usage: 8,
        },
      });
    } finally {
      if (previousGithubApi === undefined) delete process.env.HOMERAIL_GITHUB_API_BASE_URL;
      else process.env.HOMERAIL_GITHUB_API_BASE_URL = previousGithubApi;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the manual GitHub adapter thin and truthful", () => {
    const workflow = fs.readFileSync(path.resolve(process.cwd(), "..", ".github", "workflows", "pr-review.yml"), "utf8");
    const runner = fs.readFileSync(path.resolve(process.cwd(), "..", "scripts", "run-dag-patterns-live-runner.sh"), "utf8");
    const reviewRunner = fs.readFileSync(path.resolve(process.cwd(), "..", "scripts", "run-pr-review-live-runner.sh"), "utf8");
    const parsed = parseYaml(workflow) as { jobs: { review: { env: Record<string, string>; steps: Array<{ name: string; env?: Record<string, string> }> } } };
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).not.toContain("github.event.pull_request");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).not.toContain("continue-on-error: true");
    expect(workflow).toContain("bash scripts/run-pr-review-live-runner.sh");
    expect(workflow).toContain("npm run build:packages");
    expect(workflow).toContain("HOMERAIL_PATTERN_MODEL: qwen3.6");
    expect(workflow).not.toContain("HOMERAIL_PR_REVIEW_MANAGER_URL");
    expect(runner).toContain("dag run-template pr-review");
    expect(runner).toContain('dag artifact "$REVIEW_RUN_ID" pr-review.json');
    expect(runner).toContain('dag artifact "$REVIEW_RUN_ID" pr-review.md');
    expect(runner).toContain('--setting-id "$SETTING_ID"');
    expect(reviewRunner).toContain("HOMERAIL_LIVE_TASK=pr-review");
    expect(workflow).not.toContain("--output-dir");
    expect(workflow).toContain("$GITHUB_STEP_SUMMARY");
    expect(parsed.jobs.review.env.HOMERAIL_GITHUB_API_BASE_URL).toBe("${{ github.api_url }}");
    expect(parsed.jobs.review.env.HOMERAIL_PATTERN_MODEL_BASE_URL).toBe("${{ secrets.HOMERAIL_PATTERN_MODEL_BASE_URL }}");
    expect(parsed.jobs.review.env).not.toHaveProperty("HOMERAIL_HOME");
    expect(parsed.jobs.review.env).not.toHaveProperty("HOMERAIL_MANAGER_URL");
    expect(parsed.jobs.review.steps.find((step) => step.name === "Run HomeRail PR Review DAG")?.env)
      .not.toHaveProperty("HOMERAIL_HOME");
  });

  it("validates completed and inconclusive CI artifacts without hiding infrastructure failures", () => {
    const validator = path.resolve(process.cwd(), "..", "scripts", "validate-pr-review-artifacts.mjs");
    const dir = path.join(tmpHome, "artifact-validator");
    fs.mkdirSync(dir, { recursive: true });
    const commandPath = path.join(dir, "command.json");
    const reportPath = path.join(dir, "pr-review.json");
    const markdownPath = path.join(dir, "pr-review.md");
    const runId = "a".repeat(24);
    const artifacts = [
      { name: "pr-review.json", status: "ready" },
      { name: "pr-review.md", status: "ready" },
    ];
    const runValidator = (
      status: string,
      report: Record<string, unknown>,
      quorum: Record<string, unknown>,
      markdown = [
        "# Review",
        `**HomeRail Run ID:** \`${runId}\``,
        `Repo: ${report.repo}`,
        `Base: ${report.base}`,
        `Head: ${report.head}`,
        `Status: ${report.status}`,
        "Quorum result",
      ].join("\n\n"),
    ) => {
      fs.writeFileSync(commandPath, JSON.stringify({ run_id: runId, status, artifacts }));
      fs.writeFileSync(reportPath, JSON.stringify({ report, quorum }));
      fs.writeFileSync(markdownPath, markdown);
      return spawnSync(process.execPath, [validator, commandPath, reportPath, markdownPath], { encoding: "utf8" });
    };

    expect(runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 2, total: 3, threshold: 2 },
    ).status).toBe(0);
    expect(runValidator(
      "cancelled",
      { ...passingReviewReport(), status: "inconclusive" },
      { passed: false, successes: 1, total: 3, threshold: 2 },
    ).status).toBe(0);

    const invalid = runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 2, total: 3, threshold: 2 },
      "# Review\n\n**HomeRail Run ID:** `${run_id}`",
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("does not contain the exact HomeRail run_id field");
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
    installPrepareCommandStub(parsed);
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
    expect(dispatcher.dispatched.map((envelope) => envelope.nodeId).sort()).toEqual([
      "frontend_review",
      "runtime_review",
      "security_review",
      "test_review",
    ]);

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
      voter: "coverage", vote: "accept", confidence: "high", evidence: "all scopes present",
    });
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("refine");

    const finalReview = {
      report,
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    };
    handoffActiveRun("pr-review-runtime", "refine", "finalized", finalReview);
    expect(executor.tick("pr-review-runtime")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("publish");

    handoffActiveRun("pr-review-runtime", "publish", "published", {
      run_id: "pr-review-runtime",
      markdown: "# HomeRail PR Review\n\n**HomeRail Run ID:** `pr-review-runtime`\n\nNo actionable findings.",
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
      .toBe("# HomeRail PR Review\n\n**HomeRail Run ID:** `pr-review-runtime`\n\nNo actionable findings.\n");
  });

  it("fails verification closed when the deterministic diff evidence is truncated", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-review.yaml.template"),
      "utf8",
    );
    const parsed = parseWorkflowSource(source);
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed, { diffTruncated: true });
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-truncated-evidence";
    const input = {
      trigger_id: "manual",
      trigger_type: "manual",
      fire_key: "manual:xiaotianfotos/homerail#25:truncated",
      payload: {
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
        base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        head_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        expected_usage: 8,
        budget_key: "pr-review:xiaotianfotos/homerail:truncated",
      },
    };
    executor.createRun(runId, parsed, JSON.stringify(input));
    expect(executor.tick(runId)).toBeGreaterThan(0);
    expect(loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "prepare" && handoff.port === "ready",
    )?.content).toMatchObject({ diff_truncated: true });
    expect(dispatcher.dispatched.map((envelope) => envelope.nodeId).sort()).toEqual([
      "frontend_review",
      "runtime_review",
      "security_review",
      "test_review",
    ]);

    for (const reviewer of ["runtime", "security", "test", "frontend"] as const) {
      failActiveRun(runId, `${reviewer}_review`, "bounded diff_patch was truncated");
    }
    expect(executor.tick(runId)).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("synthesize");

    const reviewerResults = (["runtime", "security", "tests", "frontend"] as const).map((reviewer) => ({
      reviewer,
      status: "failed",
      summary: `${reviewer} reviewer refused truncated diff evidence`,
      findings: [],
    }));
    handoffActiveRun(runId, "synthesize", "drafted", {
      ...passingReviewReport(),
      status: "inconclusive",
      confidence: "low",
      summary: "The deterministic diff evidence was truncated.",
      reviewer_results: reviewerResults,
    });
    expect(executor.tick(runId)).toBe(3);
    handoffActiveRun(runId, "evidence_vote", "voted", {
      voter: "evidence",
      vote: "reject",
      confidence: "high",
      evidence: "diff_truncated=true",
      finding_verdicts: [],
    });
    handoffActiveRun(runId, "false_positive_vote", "voted", {
      voter: "false_positive",
      vote: "reject",
      confidence: "high",
      evidence: "diff_truncated=true",
      finding_verdicts: [],
    });
    handoffActiveRun(runId, "coverage_vote", "voted", {
      voter: "coverage",
      vote: "reject",
      confidence: "high",
      evidence: "all four reviewers failed closed on truncated evidence",
    });
    expect(executor.tick(runId)).toBeGreaterThan(0);
    expect(loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "verification_quorum" && handoff.port === "rejected",
    )?.content).toMatchObject({
      passed: false,
      successes: 0,
      failures: 3,
      total: 3,
      threshold: 2,
    });
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("refine");
  });

  it("normalizes a reviewer failure and continues to synthesis", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "..", "assets", "orchestrations", "pr-review.yaml.template"),
      "utf8",
    );
    const parsed = parseWorkflowSource(source);
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const input = {
      trigger_id: "manual",
      trigger_type: "manual",
      fire_key: "manual:xiaotianfotos/homerail#25:reviewer-failure",
      payload: {
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
        base_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        head_clone_url: "https://github.com/xiaotianfotos/homerail.git",
        expected_usage: 8,
        budget_key: "pr-review:xiaotianfotos/homerail:reviewer-failure",
      },
    };
    executor.createRun("pr-review-reviewer-failure", parsed, JSON.stringify(input));
    executor.tick("pr-review-reviewer-failure");

    for (const category of ["runtime", "tests", "frontend"] as const) {
      handoffActiveRun(
        "pr-review-reviewer-failure",
        `${category === "tests" ? "test" : category}_review`,
        "reviewed",
        {
          reviewer: category,
          status: "complete",
          summary: `${category} review complete`,
          findings: [],
        },
      );
    }
    failActiveRun(
      "pr-review-reviewer-failure",
      "security_review",
      "agent ended without DAG handoff after correction exhaustion",
    );
    expect(executor.tick("pr-review-reviewer-failure")).toBeGreaterThan(0);
    expect(dispatcher.dispatched.at(-1)?.nodeId).toBe("synthesize");

    const normalized = loadRunSnapshot("pr-review-reviewer-failure")?.handoffs.find((handoff) =>
      handoff.fromNode === "normalize_security_review" && handoff.port === "reviewed"
    );
    expect(normalized?.content).toMatchObject({
      reviewer: "security",
      status: "failed",
      findings: [],
    });
    expect(String((normalized?.content as { summary?: unknown } | undefined)?.summary))
      .toContain("agent ended without DAG handoff after correction exhaustion");
  });
});

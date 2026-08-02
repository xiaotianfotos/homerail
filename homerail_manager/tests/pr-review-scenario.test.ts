import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import {
  compileWorkflowSource,
  parseWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";
import { closeDb } from "../src/persistence/db.js";
import { getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  failActiveRun,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";
import { _invokeHostCodexVoiceToolForTest } from "../src/server/host-codex-manager-agent.js";
import { ensureManagerSkillsInstalled, readManagerSkill } from "../src/server/manager-skills.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")";
const workflowPath = path.join(repositoryRoot, "assets", "orchestrations", "pr-review.yaml.template");

type ModelId = "qwen" | "kimi" | "glm";
type Vote = "approve" | "request_changes" | "abstain";

const finding = {
  category: "runtime",
  severity: "high",
  title: "Changed branch drops persisted state",
  file: "src/run.ts",
  line: 12,
  evidence: "The changed branch returns before persistence.",
  recommendation: "Persist state before returning.",
  confidence: "high",
};

function modelReview(
  reviewer: ModelId,
  vote: Vote = "approve",
  options: { failed?: boolean } = {},
): Record<string, unknown> {
  const failed = options.failed ?? vote === "abstain";
  return {
    reviewer,
    status: failed ? "failed" : "complete",
    vote: failed ? "abstain" : vote,
    summary: failed ? `${reviewer} could not complete the review` : `${reviewer} review complete`,
    reviewed_files: failed ? [] : ["src/run.ts"],
    unreviewed_files: failed ? ["src/run.ts"] : [],
    evidence_truncated: failed,
    findings: !failed && vote === "request_changes" ? [finding] : [],
  };
}

function passingReviewReport(status: "pass" | "findings" | "inconclusive" = "pass"): Record<string, unknown> {
  return {
    repo: "xiaotianfotos/homerail",
    pr: 25,
    base: "a".repeat(40),
    head: "b".repeat(40),
    status,
    execution_health: "healthy",
    domain_outcome: status === "pass" ? "approved" : status === "findings" ? "changes_requested" : "inconclusive",
    confidence: status === "inconclusive" ? "low" : "medium",
    summary: "Three-model review: 2 approve, 1 request changes, 0 abstain.",
    actionable_count: 0,
    findings: [],
    reviewer_results: [
      modelReview("qwen"),
      modelReview("kimi"),
      modelReview("glm", "request_changes"),
    ],
  };
}

function reviewInput(): Record<string, unknown> {
  return {
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
    },
  };
}

function installPrepareCommandStub(
  parsed: ReturnType<typeof parseWorkflowSource>,
  options: { diffTruncated?: boolean } = {},
): void {
  const prepare = parsed.graph.nodes.find((node) => node.node_id === "prepare");
  if (!prepare?.gateway_config) throw new Error("prepare command node is missing");
  prepare.gateway_config.command = [
    "node",
    "-e",
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s),r=Array.isArray(i.request)?i.request.at(-1):undefined,p=r?.payload;if(!p)throw new Error('missing request');process.stdout.write(JSON.stringify({repo:p.repo,pr:p.pr,base:p.base,head:p.head,repository_path:'/workspace/repository',changed_files:['src/run.ts'],diff_stat:'1 file changed',diff_patch:'diff --git a/src/run.ts b/src/run.ts',diff_chunks:[{index:1,path:'review-evidence/diff-0001.patch',bytes:39,files:['src/run.ts']}],diff_bytes:39,diff_truncated:" +
      JSON.stringify(options.diffTruncated ?? false) +
      ",commit_metadata:[],commit_metadata_truncated:false}))})",
  ];
}

function productionPrepareCommand(): string {
  const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
  const command = parsed.graph.nodes.find((node) => node.node_id === "prepare")?.gateway_config?.command;
  if (!Array.isArray(command) || typeof command[2] !== "string") {
    throw new Error("production prepare command is missing");
  }
  return command[2];
}

function prepareCommandInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request: [{
      payload: {
        repo: "enterprise/homerail",
        pr: 8,
        base: "a".repeat(40),
        head: "b".repeat(40),
        base_clone_url: "https://github.example/enterprise/homerail.git",
        head_clone_url: "https://github.example/enterprise/homerail.git",
        ...overrides,
      },
    },
  ];
}

function commandCode(nodeId: string): { code: string; args: string[] } {
  const compiled = compileWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
  expect(compiled.valid).toBe(true);
  const command = compiled.canonical?.nodes.find((node) => node.id === nodeId)?.config?.command;
  if (!Array.isArray(command) || typeof command[2] !== "string") {
    throw new Error(`${nodeId} command is missing`);
  }
  return { code: command[2], args: command.slice(3).map(String) };
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

  it("compiles exactly three independent model reviews and deterministic 2-of-3 approval", () => {
    const source = fs.readFileSync(workflowPath, "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({ workflow_id: "pr-review" });
    expect(result.canonical?.artifacts).toEqual([
      expect.objectContaining({
        name: "pr-review.json",
        source: { type: "handoff", node: "decide", port: "decided" },
        contract: "FinalReview",
      }),
    ]);

    const nodes = result.canonical?.nodes ?? [];
    const modelNodes = ["qwen_review", "kimi_review", "glm_review"];
    expect(nodes.filter((node) => node.kind === "agent").map((node) => node.id).sort())
      .toEqual([...modelNodes].sort());
    for (const nodeId of modelNodes) {
      expect(nodes.find((node) => node.id === nodeId)).toMatchObject({
        outputs: expect.arrayContaining([expect.objectContaining({ name: "voted", contract: "VerificationVote" })]),
        config: expect.objectContaining({
          allowed_builtin_tools: ["Glob", "Grep", "LS", "Read"],
          allowed_dag_tools: ["handoff"],
          workspace_access: { writable_paths: [], readonly_paths: ["repository", "review-evidence"] },
        }),
      });
    }
    expect(nodes.find((node) => node.id === "decide")).toMatchObject({
      kind: "command",
      outputs: expect.arrayContaining([expect.objectContaining({ name: "decided", contract: "FinalReview" })]),
    });
    expect(nodes.find((node) => node.id === "collect_reviews")?.config).toMatchObject({
      mode: "all",
      field: "status",
      success_values: ["complete", "failed"],
    });
    for (const removed of [
      "privacy_review",
      "runtime_review",
      "security_review",
      "test_review",
      "frontend_review",
      "synthesize",
      "refine",
      "normalize_review",
    ]) {
      expect(nodes.find((node) => node.id === removed)).toBeUndefined();
    }
    expect(result.canonical?.policies).toMatchObject({
      max_parallelism: 3,
      max_dispatches: 12,
      max_corrections_per_node: 2,
      max_tool_calls_per_node: 50,
    });

    const contracts = parseWorkflowSource(source).meta.contracts ?? {};
    for (const reviewer of ["qwen", "kimi", "glm"] as const) {
      expect(validateJsonContract(contracts.VerificationVote, modelReview(reviewer))).toMatchObject({ valid: true });
    }
    expect(validateJsonContract(contracts.VerificationVote, {
      ...modelReview("qwen"),
      reviewer: "runtime",
    })).toMatchObject({ valid: false });

    const agents = parseWorkflowSource(source).meta.agents ?? {};
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toMatch(/final action MUST\s+call\s+(?:the\s+)?handoff/);
    }
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toContain("input.context.diff_chunks");
      expect(agents[agentId]?.system).toMatch(/Independently review/);
      expect(agents[agentId]?.system).toContain("No draft report exists or is required");
      expect(agents[agentId]?.system).toMatch(/copy\s+input\.context\.changed_files exactly/);
      expect(agents[agentId]?.system).toContain("including lockfiles");
      expect(agents[agentId]?.system).toContain("untrusted source");
    }
  });

  it("counts approvals deterministically and blocks request-changes or split votes", () => {
    const { code, args } = commandCode("decide");
    const context = {
      repo: "xiaotianfotos/homerail",
      pr: 25,
      base: "a".repeat(40),
      head: "b".repeat(40),
    };
    const execute = (reviews: Array<Record<string, unknown>>) => {
      const result = spawnSync(process.execPath, ["-e", code, ...args], {
        encoding: "utf8",
        input: JSON.stringify({ context: [context], reviews: [{ values: reviews }] }),
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as {
        repor
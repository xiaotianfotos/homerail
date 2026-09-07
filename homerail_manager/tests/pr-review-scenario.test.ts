import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  changedFileCoverageAttestation,
  changedFileCoverageDigest,
  validateChangedFileCoverageAttestation,
} from "homerail-protocol";

import {
  FakeDAGDispatcher,
  type DAGDispatcher,
  type DispatchEnvelope,
} from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { subscribe } from "../src/events/bus.js";
import {
  compileWorkflowSource,
  parseWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  advanceDagActorGeneration,
  getDagActorByNode,
} from "../src/persistence/dag-actors.js";
import { getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  autoHandoffAfterCorrectionExhausted,
  getActiveRun,
  handoffActiveRun,
  requestNodeCorrection,
} from "../src/runtime/active-runs.js";
import { finalizeRunArtifacts } from "../src/runtime/run-artifact-service.js";
import { _invokeHostCodexVoiceToolForTest } from "../src/server/host-codex-manager-agent.js";
import { ensureManagerSkillsInstalled, readManagerSkill } from "../src/server/manager-skills.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(repositoryRoot, "assets", "orchestrations", "pr-review.yaml.template");

type ModelId = "qwen" | "kimi" | "glm";
type Vote = "approve" | "request_changes" | "abstain";
type Coverage = { digest: string; count: number };

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

const changedFiles = ["src/run.ts"];
const coverage: Coverage = {
  digest: changedFileCoverageDigest(changedFiles).digest,
  count: changedFileCoverageDigest(changedFiles).count,
};

function coverageFor(files: readonly string[]): Coverage {
  const { digest, count } = changedFileCoverageDigest(files);
  return { digest, count };
}

function cryptoDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function modelReview(
  reviewer: ModelId,
  vote: Vote = "approve",
  options: {
    failed?: boolean;
    coverage?: Coverage;
    findings?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const failed = options.failed ?? vote === "abstain";
  return {
    reviewer,
    status: failed ? "failed" : "complete",
    vote: failed ? "abstain" : vote,
    summary: failed ? `${reviewer} could not complete the review` : `${reviewer} review complete`,
    coverage: options.coverage ?? coverage,
    findings: options.findings ?? (!failed && vote === "request_changes" ? [finding] : []),
  };
}

function acceptedDiagnostics(): Array<Record<string, unknown>> {
  return [{
    attempt: 1,
    category: "accepted",
    finish_reason: "end_turn",
    output_tokens: 4200,
    output_token_limit: 10000,
    tool_arguments_parse_state: "parsed",
    contract_validation_stage: "contract_validated",
    message: null,
  }];
}

function normalizedReview(
  reviewer: ModelId,
  vote: Vote = "approve",
  options: {
    failed?: boolean;
    coverage?: Coverage;
    findings?: Array<Record<string, unknown>>;
    diagnostics?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const failed = options.failed ?? vote === "abstain";
  const reviewerCoverage = options.coverage ?? coverage;
  const coverageValid = reviewerCoverage.digest === coverage.digest
    && reviewerCoverage.count === coverage.count;
  const diagnostics = options.diagnostics ?? [{
    attempt: 1,
    category: failed ? "unknown" : "accepted",
  }];
  const category = String(diagnostics.at(-1)?.category ?? "unknown");
  return {
    ...modelReview(reviewer, vote, {
      ...options,
      coverage: reviewerCoverage,
      findings: options.findings ?? (!failed && vote === "request_changes" ? [finding] : []),
    }),
    reviewed_files: coverageValid ? [...changedFiles] : [],
    unreviewed_files: coverageValid ? [] : [...changedFiles],
    evidence_truncated: failed ? category !== "reviewer_abstained" : false,
    diagnostics,
  };
}

function passingReviewReport(): Record<string, unknown> {
  return {
    repo: "xiaotianfotos/homerail",
    pr: 25,
    base: "a".repeat(40),
    head: "b".repeat(40),
    status: "pass",
    confidence: "high",
    summary: "Three-model review: 3 approve, 0 request changes, 0 abstain; 0 retained actionable findings.",
    coverage,
    actionable_count: 0,
    findings: [],
    reviewer_results: [
      normalizedReview("qwen"),
      normalizedReview("kimi"),
      normalizedReview("glm"),
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

function trustedContext(files: string[] = changedFiles): Record<string, unknown> {
  return {
    repo: "xiaotianfotos/homerail",
    pr: 25,
    base: "a".repeat(40),
    head: "b".repeat(40),
    repository_path: "/workspace/repository",
    changed_files: files,
    coverage: coverageFor(files),
    diff_stat: `${files.length} files changed`,
    diff_patch: "diff --git a/src/run.ts b/src/run.ts",
    diff_chunks: [{
      index: 1,
      path: "review-evidence/diff-0001.patch",
      bytes: 39,
      files,
    }],
    diff_bytes: 39,
    diff_truncated: false,
  };
}

function installPrepareCommandStub(
  parsed: ReturnType<typeof parseWorkflowSource>,
  options: { diffTruncated?: boolean; files?: string[] } = {},
): void {
  const prepare = parsed.graph.nodes.find((node) => node.node_id === "prepare");
  if (!prepare?.gateway_config) throw new Error("prepare command node is missing");
  const files = options.files ?? changedFiles;
  const preparedCoverage = coverageFor(files);
  prepare.gateway_config.command = [
    "node",
    "-e",
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s),r=Array.isArray(i.request)?i.request.at(-1):undefined,p=r?.payload;if(!p)throw new Error('missing request');process.stdout.write(JSON.stringify({repo:p.repo,pr:p.pr,base:p.base,head:p.head,repository_path:'/workspace/repository',changed_files:" +
      JSON.stringify(files) +
      ",coverage:{digest:" +
      JSON.stringify(preparedCoverage.digest) +
      ",count:" +
      preparedCoverage.count +
      "},diff_stat:'1 file changed',diff_patch:'diff --git a/src/run.ts b/src/run.ts',diff_chunks:[{index:1,path:'review-evidence/diff-0001.patch',bytes:39,files:" +
      JSON.stringify(files) +
      "}],diff_bytes:39,diff_truncated:" +
      JSON.stringify(options.diffTruncated ?? false) +
      ",commit_metadata:[],commit_metadata_truncated:false}))})",
  ];
}

function productionPrepareCommand(gitShim?: string): string {
  const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
  const command = parsed.graph.nodes.find((node) => node.node_id === "prepare")?.gateway_config?.command;
  if (!Array.isArray(command) || typeof command[2] !== "string") {
    throw new Error("production prepare command is missing");
  }
  if (!gitShim) return command[2];
  const marker = "spawnSync('git', [...common, ...args], {";
  if (!command[2].includes(marker)) throw new Error("production prepare git invocation is missing");
  return command[2].replace(
    marker,
    `spawnSync(process.execPath, [${JSON.stringify(gitShim)}, ...common, ...args], {`,
  );
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
    }],
  };
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

function installFakeGit(cwd: string, files: string[]): string {
  const head = "b".repeat(40);
  const patch = files.map((file) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${"a".repeat(1600)}`,
    `+${"b".repeat(1600)}`,
    "",
  ].join("\n")).join("");
  const fakeGit = path.join(cwd, "fake-git.cjs");
  fs.writeFileSync(fakeGit, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const has = (value) => args.includes(value);",
    "if (has('clone')) fs.mkdirSync(args.at(-1), { recursive: true });",
    `else if (has('rev-parse')) process.stdout.write(${JSON.stringify(head)});`,
    "else if (has('rev-list')) process.stdout.write('1');",
    `else if (has('log')) process.stdout.write(${JSON.stringify(`${head}\0Example User\0user@example.com\0GitHub\0noreply@github.com\0Example change\0`)});`,
    `else if (has('diff') && has('--name-only')) process.stdout.write(${JSON.stringify(`${files.join("\0")}\0`)});`,
    `else if (has('diff') && has('--shortstat')) process.stdout.write(${JSON.stringify(`${files.length} files changed`)});`,
    `else if (has('diff')) process.stdout.write(${JSON.stringify(patch)});`,
  ].join("\n"));
  return fakeGit;
}

class ReentrantDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope) {
    this.dispatched.push(envelope);
    return { status: "dispatched" as const, targetType: "fake" as const, targetId: "fake" };
  }
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
    expect(result.canonical?.capabilities).toEqual(["runtime_evidence"]);
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
        outputs: expect.arrayContaining([
          expect.objectContaining({ name: "voted", contract: "VerificationVote" }),
          expect.objectContaining({ name: "failed", contract: "VerificationVote" }),
        ]),
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
      max_dispatches: 16,
      max_corrections_per_node: 2,
      max_tool_calls_per_node: 0,
    });

    const contracts = parseWorkflowSource(source).meta.contracts ?? {};
    for (const reviewer of ["qwen", "kimi", "glm"] as const) {
      expect(validateJsonContract(contracts.VerificationVote, modelReview(reviewer))).toMatchObject({ valid: true });
      expect(validateJsonContract(contracts.VerificationVote, modelReview(reviewer, "request_changes")))
        .toMatchObject({ valid: true });
    }
    const incompleteAbstention = modelReview("qwen", "abstain");
    delete incompleteAbstention.coverage;
    expect(validateJsonContract(contracts.VerificationVote, incompleteAbstention)).toMatchObject({ valid: true });
    const completeWithoutCoverage = modelReview("qwen");
    delete completeWithoutCoverage.coverage;
    expect(validateJsonContract(contracts.VerificationVote, completeWithoutCoverage)).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.VerificationVote, {
      ...modelReview("qwen", "abstain"),
      vote: "request_changes",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.VerificationVote, {
      ...modelReview("qwen"),
      reviewer: "runtime",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.VerificationVote, {
      ...modelReview("qwen"),
      coverage: { digest: "not-a-digest", count: 1 },
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.VerificationVote, {
      ...modelReview("qwen"),
      reviewed_files: ["src/run.ts"],
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.ReviewContext, trustedContext())).toMatchObject({ valid: false });
    const compactContext = { ...trustedContext() } as Record<string, unknown>;
    delete compactContext.changed_files;
    expect(validateJsonContract(contracts.ReviewContext, compactContext)).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.TrustedReviewContext, trustedContext())).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.ReviewEvidenceState, {
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
      attempt_diagnostics: [{
        attempt: 1,
        failure_category: "provider_output_truncated",
        finish_reason: "max_tokens",
        output_tokens: 9000,
        output_token_limit: 10000,
        tool_argument_parse_state: "invalid",
        contract_stage: "unknown",
      }],
      accepted_findings: [finding],
      coverage_attestation: null,
      projection_truncated: false,
      omitted_findings: 0,
      omitted_diagnostics: 0,
    })).toMatchObject({ valid: true });

    const agents = parseWorkflowSource(source).meta.agents ?? {};
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toMatch(/final action MUST\s+call (?:the\s+)?handoff/);
    }
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toContain("input.context.diff_chunks");
      expect(agents[agentId]?.system).toMatch(/Independently review/);
      expect(agents[agentId]?.system).toContain("No draft report exists or is required");
      expect(agents[agentId]?.system).toContain("input.context.coverage");
      expect(agents[agentId]?.system).toMatch(/copy\s+input\.context\.coverage exactly/);
      expect(agents[agentId]?.system).not.toMatch(/copy\s+input\.context\.changed_files exactly/);
      expect(agents[agentId]?.system).not.toContain("input.context.changed_files");
      expect(agents[agentId]?.system).toContain("untrusted source");
      expect(agents[agentId]?.system).toContain("input:correction exists");
      expect(agents[agentId]?.system).toMatch(/do not re-analyze/);
      expect(agents[agentId]?.system).toMatch(/accepted evidence/);
      expect(agents[agentId]?.system).toContain("If evidence is incomplete, call handoff on voted without coverage");
      expect(agents[agentId]?.system).toContain("never call it as a probe or test");
      expect(agents[agentId]?.system).toContain("never use the failed port");
    }
  });

  it("retains every complete finding and passes only with two approvals plus zero findings", () => {
    const { code, args } = commandCode("decide");
    const context = trustedContext();
    const execute = (reviews: Array<Record<string, unknown>>) => {
      const result = spawnSync(process.execPath, ["-e", code, ...args], {
        encoding: "utf8",
        input: JSON.stringify({ trusted: [context], reviews: [{ values: reviews }] }),
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as {
        report: { status: string; actionable_count: number; findings: unknown[]; coverage: Coverage };
        quorum: { passed: boolean; successes: number; total: number; threshold: number };
      };
    };

    expect(execute([
      normalizedReview("qwen"),
      normalizedReview("kimi"),
      normalizedReview("glm", "request_changes"),
    ])).toMatchObject({
      report: { status: "findings", actionable_count: 1, coverage },
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    });
    expect(execute([
      normalizedReview("qwen", "request_changes"),
      normalizedReview("kimi", "request_changes"),
      normalizedReview("glm"),
    ])).toMatchObject({
      report: { status: "findings", actionable_count: 1 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
    expect(execute([
      normalizedReview("qwen", "request_changes"),
      {
        ...normalizedReview("kimi", "request_changes"),
        findings: [{ ...finding, evidence: "A distinct exact-line failure mode." }],
      },
      normalizedReview("glm"),
    ])).toMatchObject({
      report: { status: "findings", actionable_count: 2 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
    expect(execute([
      normalizedReview("qwen"),
      normalizedReview("kimi", "request_changes"),
      normalizedReview("glm", "abstain", {
        diagnostics: [{ attempt: 1, category: "reviewer_abstained" }],
      }),
    ])).toMatchObject({
      report: { status: "findings", actionable_count: 1 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
    expect(execute([
      normalizedReview("qwen"),
      normalizedReview("kimi", "abstain"),
      normalizedReview("glm", "abstain"),
    ])).toMatchObject({
      report: { status: "inconclusive", actionable_count: 0 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
  });

  it("requires the explicit runtime_evidence capability before ReviewEvidenceState is usable", () => {
    const workflow: Record<string, unknown> = {
      api_version: "homerail.ai/v1",
      kind: "Workflow",
      metadata: { id: "evidence-abuse", name: "Evidence Abuse" },
      spec: {
        agents: { worker: { system: "Work." } },
        contracts: {
          ReviewEvidenceState: { type: "object", additionalProperties: false, required: ["reviewer"], properties: { reviewer: { type: "string" } } },
        },
        nodes: {
          review: {
            kind: "agent",
            agent: "worker",
            allowed_dag_tools: ["handoff"],
            inputs: { evidence: { contract: "ReviewEvidenceState" } },
            outputs: { done: {} },
          },
          done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        },
        edges: [{ from: "review.done", to: "done.result" }],
      },
    };

    const withoutCapability = compileWorkflowSource(JSON.stringify(workflow));
    expect(withoutCapability.valid).toBe(false);
    expect(withoutCapability.diagnostics).toContainEqual(expect.objectContaining({
      code: "DAG_SEMANTIC_RUNTIME_EVIDENCE_CAPABILITY_REQUIRED",
      path: "/spec/nodes/review/inputs/evidence/contract",
    }));

    workflow.spec.capabilities = ["runtime_evidence"];
    const withCapability = compileWorkflowSource(JSON.stringify(workflow));
    expect(withCapability.valid, withCapability.diagnostics.map((entry) => entry.message).join("; ")).toBe(true);
    expect(withCapability.canonical?.capabilities).toEqual(["runtime_evidence"]);
  });

  it("normalizes an incomplete model output to a precise provider truncation", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext(["src/run.ts", "src/other.ts"])],
        evidence: [{
          reviewer: "qwen_review",
          attempt_diagnostics: [{
            attempt: 1,
            failure_category: "provider_output_truncated",
            finish_reason: "max_tokens",
            output_tokens: 9000,
            output_token_limit: 10000,
            tool_argument_parse_state: "invalid",
            contract_stage: "unknown",
          }],
          accepted_findings: [],
        }],
        success: [{
          ...modelReview("qwen"),
          coverage: { digest: "0".repeat(64), count: 2 },
        }],
        failure: [],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: ["src/run.ts", "src/other.ts"],
      evidence_truncated: true,
      findings: [],
      diagnostics: [expect.objectContaining({
        attempt: 1,
        category: "provider_output_truncated",
        finish_reason: "max_tokens",
        output_tokens: 9000,
        output_token_limit: 10000,
        tool_arguments_parse_state: "parse_failed",
        contract_validation_stage: null,
      })],
    });
  });

  it.each([
    ["provider_output_truncated", "provider_output_truncated", true],
    ["handoff_arguments_invalid", "handoff_arguments_invalid", true],
    ["contract_validation_failed", "contract_validation_failed", true],
    ["transport_failed", "transport_failed", true],
    ["reviewer_abstained", "unknown", true],
    ["unknown", "unknown", true],
  ] as const)("normalizes the %s attempt category as %s with evidence_truncated=%s", (category, expectedCategory, truncated) => {
    const { code, args } = commandCode("normalize_kimi_review");
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [{
          reviewer: "kimi_review",
          attempt_diagnostics: [{ attempt: 1, failure_category: category }],
          accepted_findings: [],
        }],
        success: [],
        failure: [{ error: `attempt ended with ${category}` }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "kimi",
      status: "failed",
      vote: "abstain",
      evidence_truncated: truncated,
      diagnostics: [{ attempt: 1, category: expectedCategory }],
    });
  });

  it("keeps a deliberate abstention distinct from provider truncation", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [],
        success: [{
          reviewer: "qwen",
          status: "failed",
          vote: "abstain",
          summary: "I reviewed the diff but deliberately abstain from voting.",
          coverage,
          findings: [],
        }],
        failure: [],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      reviewed_files: ["src/run.ts"],
      unreviewed_files: [],
      evidence_truncated: false,
      diagnostics: [{ attempt: 1, category: "reviewer_abstained" }],
      summary: "I reviewed the diff but deliberately abstain from voting.",
    });
  });

  it.each([
    ["normalize_qwen_review", "qwen"],
    ["normalize_kimi_review", "kimi"],
    ["normalize_glm_review", "glm"],
  ] as const)("rejects an empty-findings request_changes vote in %s", (nodeId, reviewer) => {
    const { code, args } = commandCode(nodeId);
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [],
        success: [{
          ...modelReview(reviewer, "request_changes"),
          findings: [],
        }],
        failure: [],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer,
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      findings: [],
      diagnostics: [{
        attempt: 1,
        category: "contract_validation_failed",
        message: "request_changes vote requires at least one retained finding",
      }],
    });
  });

  it("deduplicates repeated accepted finding chunks and bounds malformed arguments", () => {
    const { code, args } = commandCode("normalize_glm_review");
    const files = Array.from({ length: 50 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const preparedCoverage = coverageFor(files);
    const evidenceFinding = { ...finding, title: "Preserved finding", file: files[0], line: 1 };
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext(files)],
        evidence: [{
          reviewer: "glm_review",
          attempt_diagnostics: [{
            attempt: 1,
            failure_category: "handoff_arguments_invalid",
            finish_reason: "end_turn",
            output_tokens: 8000,
            output_token_limit: 10000,
            tool_argument_parse_state: "invalid",
            contract_stage: "contract_validation",
          }],
          accepted_findings: [evidenceFinding, evidenceFinding],
        }],
        success: [],
        failure: [{ error: "handoff arguments invalid" }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "glm",
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: files,
      evidence_truncated: true,
      diagnostics: [{ attempt: 1, category: "handoff_arguments_invalid", tool_arguments_parse_state: "parse_failed" }],
    });
    const published = JSON.parse(result.stdout) as { findings: Array<{ title: string }> };
    expect(published.findings).toEqual([{ ...evidenceFinding }]);
  });

  it("ignores review evidence fenced to a different reviewer identity", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [{
          reviewer: "kimi_review",
          attempt_diagnostics: [{ attempt: 1, failure_category: "provider_output_truncated" }],
          accepted_findings: [{ ...finding, title: "Foreign finding" }],
        }],
        success: [],
        failure: [{ error: "agent ended without a complete vote" }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      findings: [],
      evidence_truncated: true,
      diagnostics: [{ attempt: 1, category: "unknown" }],
    });
  });

  it("publishes an accepted terminal attempt for a successful correction", () => {
    const { code, args } = commandCode("normalize_kimi_review");
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [{
          reviewer: "kimi_review",
          attempt_diagnostics: [{ attempt: 1, failure_category: "contract_validation_failed" }],
          accepted_findings: [finding],
        }],
        success: [{
          reviewer: "kimi",
          status: "complete",
          vote: "request_changes",
          summary: "Corrected handoff.",
          coverage,
          findings: [finding],
        }],
        failure: [],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "kimi",
      status: "complete",
      vote: "request_changes",
      reviewed_files: ["src/run.ts"],
      evidence_truncated: false,
      findings: [finding],
      diagnostics: [
        { attempt: 1, category: "contract_validation_failed" },
        { attempt: 2, category: "accepted" },
      ],
    });
  });

  it("keeps accepted findings monotonic when a correction submits an empty approval", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const preserved = { ...finding, title: "Preserved accepted finding" };
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trustedContext()],
        evidence: [{
          reviewer: "qwen_review",
          attempt_diagnostics: [{ attempt: 1, failure_category: "contract_validation_failed" }],
          accepted_findings: [preserved],
        }],
        success: [{
          reviewer: "qwen",
          status: "complete",
          vote: "approve",
          summary: "Corrected only the missing coverage field.",
          coverage,
          findings: [],
        }],
        failure: [],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      reviewed_files: ["src/run.ts"],
      unreviewed_files: [],
      evidence_truncated: false,
      findings: [preserved],
    });
  });

  it("rejects an unstructured reviewer failure-port probe for correction", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-failure-port-probe";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    expect(() => handoffActiveRun(runId, "kimi_review", "failed", "probe"))
      .toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
    expect(getActiveRun(runId)?.dagRun.handoffedNodes.has("kimi_review")).toBe(false);
  });

  it("accepts a structured incomplete-evidence abstention without coverage", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-incomplete-abstention";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    expect(() => handoffActiveRun(runId, "qwen_review", "voted", {
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      summary: "The immutable diff evidence is incomplete.",
      findings: [],
    })).not.toThrow();
    expect(getActiveRun(runId)?.dagRun.handoffedNodes.has("qwen_review")).toBe(true);
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("normalize_qwen_review")).toBe("READY");

    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi"));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm"));
    expect(executor.tick(runId)).toBeGreaterThan(0);

    const normalized = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "normalize_qwen_review" && handoff.port === "reviewed",
    )?.content;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: ["src/run.ts"],
      evidence_truncated: true,
      diagnostics: [{ attempt: 1, category: "unknown" }],
    });
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "pass", confidence: "medium", actionable_count: 0 },
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    });
    expect(getActiveRun(runId)?.status).toBe("completed");
  });

  it("executes the compact graph with exactly three model calls", async () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-three-model-runtime";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));

    expect(executor.tick(runId)).toBeGreaterThan(0);
    expect(dispatcher.dispatched.map((envelope) => envelope.nodeId).sort()).toEqual([
      "glm_review",
      "kimi_review",
      "qwen_review",
    ]);
    handoffActiveRun(runId, "qwen_review", "voted", modelReview("qwen"));
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi"));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm"));

    expect(executor.tick(runId)).toBeGreaterThan(0);
    expect(dispatcher.dispatched.map((envelope) => envelope.nodeId)).toEqual([
      "glm_review",
      "kimi_review",
      "qwen_review",
    ]);
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: {
        status: "pass",
        coverage,
        reviewer_results: expect.arrayContaining([
          expect.objectContaining({ reviewer: "qwen", vote: "approve", coverage }),
          expect.objectContaining({ reviewer: "kimi", vote: "approve", coverage }),
          expect.objectContaining({ reviewer: "glm", vote: "approve", coverage }),
        ]),
      },
      quorum: { passed: true, successes: 3, total: 3, threshold: 2 },
    });

    expect(getActiveRun(runId)?.status).toBe("completed");
    expect(await finalizeRunArtifacts(runId, "success")).toEqual([
      expect.objectContaining({ name: "pr-review.json", status: "ready" }),
    ]);
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath(runId, "pr-review.json")!, "utf8")))
      .toMatchObject({ report: { status: "pass", coverage }, quorum: { passed: true, successes: 3 } });
  });

  it("completes with retained findings when two models approve and one requests changes", async () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-finding-veto-runtime";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    handoffActiveRun(runId, "qwen_review", "voted", modelReview("qwen"));
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi"));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm", "request_changes"));
    expect(executor.tick(runId)).toBeGreaterThan(0);

    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "findings", actionable_count: 1 },
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    });
    expect(getActiveRun(runId)?.status).toBe("cancelled");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("decision_failed")).not.toBe("COMPLETED");
    expect(await finalizeRunArtifacts(runId, "failure")).toEqual([
      expect.objectContaining({ name: "pr-review.json", status: "ready", publish: "always" }),
    ]);
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath(runId, "pr-review.json")!, "utf8")))
      .toMatchObject({ report: { status: "findings" }, quorum: { passed: false, successes: 2 } });
  });

  it("turns one correction-exhausted model into abstain while retaining another model's finding", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-model-abstention";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    handoffActiveRun(runId, "qwen_review", "voted", modelReview("qwen"));
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi", "request_changes"));
    autoHandoffAfterCorrectionExhausted(
      runId,
      "glm_review",
      "agent ended without a contract-valid handoff",
    );
    expect(getActiveRun(runId)?.status).toBe("active");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("glm_review")).toBe("FAILED");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("normalize_glm_review")).toBe("READY");
    expect(executor.tick(runId)).toBeGreaterThan(0);
    const normalized = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "normalize_glm_review" && handoff.port === "reviewed",
    )?.content;
    expect(normalized).toMatchObject({
      reviewer: "glm",
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      unreviewed_files: ["src/run.ts"],
      diagnostics: [{ attempt: 1, category: "unknown" }],
    });
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "findings", actionable_count: 1 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
  });

  it("projects the final failed attempt before correction exhaustion", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new ReentrantDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-final-exhausted-evidence";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    const findings = [1, 2, 3].map((attempt) => ({
      ...finding,
      title: `Finding from failed attempt ${attempt}`,
      evidence: `Evidence retained from failed attempt ${attempt}.`,
      recommendation: `Fix failed attempt ${attempt}.`,
    }));
    for (const [index, retainedFinding] of findings.entries()) {
      expect(() => handoffActiveRun(runId, "qwen_review", "voted", {
        reviewer: "qwen",
        status: "complete",
        vote: "request_changes",
        summary: `Incomplete attempt ${index + 1}`,
        findings: [retainedFinding],
      })).toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);

      const correction = requestNodeCorrection(
        runId,
        "qwen_review",
        "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted: coverage attestation is missing",
        { finish_reason: "end_turn", output_tokens: 500 + index },
      );
      if (index < 2) {
        expect(correction.status).toBe("scheduled");
        expect(executor.tick(runId)).toBeGreaterThan(0);
      } else {
        expect(correction).toMatchObject({ status: "exhausted", attempts: 2, maxAttempts: 2 });
      }
    }

    const finalProjection = getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence")?.[0] as Record<string, unknown>;
    expect(finalProjection).toMatchObject({
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
      accepted_findings: findings,
    });
    expect(finalProjection.attempt_diagnostics).toEqual([
      expect.objectContaining({ attempt: 1, failure_category: "contract_validation_failed" }),
      expect.objectContaining({ attempt: 2, failure_category: "contract_validation_failed" }),
      expect.objectContaining({ attempt: 3, failure_category: "contract_validation_failed" }),
    ]);

    autoHandoffAfterCorrectionExhausted(
      runId,
      "qwen_review",
      "agent exhausted correction attempts without a contract-valid handoff",
    );
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi"));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm"));
    expect(executor.tick(runId)).toBeGreaterThan(0);

    const normalized = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "normalize_qwen_review" && handoff.port === "reviewed",
    )?.content as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      findings,
      diagnostics: [
        expect.objectContaining({ attempt: 1, category: "contract_validation_failed" }),
        expect.objectContaining({ attempt: 2, category: "contract_validation_failed" }),
        expect.objectContaining({ attempt: 3, category: "contract_validation_failed" }),
      ],
    });
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "findings", actionable_count: 3, findings },
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    });
    expect(getActiveRun(runId)?.status).toBe("cancelled");
  });

  it("keeps an oversized accepted-finding set fail-closed through the bounded projection", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new ReentrantDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-oversized-evidence-projection";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    const largeFindings = Array.from({ length: 10 }, (_, index) => ({
      ...finding,
      severity: index === 9 ? "critical" : "medium",
      title: `Large retained finding ${index + 1}`,
      file: `src/large-${index + 1}.ts`,
      line: index + 1,
      evidence: String(index + 1).repeat(12_000),
      recommendation: `R${index + 1}`.repeat(4_000),
    }));
    expect(() => handoffActiveRun(runId, "qwen_review", "voted", {
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      summary: "Large accepted findings with a missing coverage attestation.",
      findings: largeFindings,
    })).toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
    const projectionEvents: unknown[] = [];
    const unsubscribe = subscribe("dag:review_evidence_projection_truncated", (payload) => {
      projectionEvents.push(payload);
    });
    expect(requestNodeCorrection(
      runId,
      "qwen_review",
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted: coverage attestation is missing",
      { finish_reason: "end_turn", output_tokens: 1200 },
    ).status).toBe("scheduled");
    unsubscribe();

    const projection = getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence")?.[0] as Record<string, unknown>;
    expect(projection).toMatchObject({
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
      projection_truncated: true,
    });
    const retained = projection.accepted_findings as Array<Record<string, unknown>>;
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(largeFindings.length);
    expect(projection.omitted_findings).toBe(largeFindings.length - retained.length);
    expect(retained[0]?.severity).toBe("critical");
    expect(projectionEvents).toContainEqual(expect.objectContaining({
      runId,
      nodeId: "qwen_review",
      omittedFindings: largeFindings.length - retained.length,
    }));

    expect(executor.tick(runId)).toBeGreaterThan(0);
    autoHandoffAfterCorrectionExhausted(
      runId,
      "qwen_review",
      "agent ended without a contract-valid handoff",
    );
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi"));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm"));
    expect(executor.tick(runId)).toBeGreaterThan(0);

    const normalized = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "normalize_qwen_review" && handoff.port === "reviewed",
    )?.content as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      findings: retained.map(({ id: _id, ...publicFinding }) => publicFinding),
    });
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "findings", actionable_count: retained.length },
      quorum: { passed: false, successes: 2, total: 3, threshold: 2 },
    });
    expect(getActiveRun(runId)?.status).toBe("cancelled");
  });

  it("recovers a 50-file three-finding incomplete handoff through minimal correction", async () => {
    const files = Array.from({ length: 50 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const preparedCoverage = coverageFor(files);
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed, { files });
    const dispatcher = new ReentrantDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-50-file-correction";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    expect(dispatcher.dispatched.map((envelope) => envelope.nodeId).sort()).toEqual([
      "glm_review",
      "kimi_review",
      "qwen_review",
    ]);

    const findings = [0, 1, 2].map((offset) => ({
      category: "runtime",
      severity: "high",
      title: `Finding ${offset + 1}`,
      file: files[offset * 3],
      line: offset + 1,
      evidence: `Reproducible evidence for finding ${offset + 1}.`,
      recommendation: `Fix finding ${offset + 1}.`,
      confidence: "high",
    }));

    // Qwen's first attempt is contract-invalid: it omits the coverage
    // attestation entirely. The Manager-owned evidence bridge accepts the
    // bounded findings and persists the exact attempt diagnostic.
    const incompleteFirstAttempt = {
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      summary: "Three findings found.",
      findings,
    };
    expect(() => handoffActiveRun(runId, "qwen_review", "voted", incompleteFirstAttempt))
      .toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);

    // The Manager-owned evidence bridge persists the bounded findings and the
    // exact attempt diagnostic, then injects the projection into the
    // normalize node's ReviewEvidenceState input before dispatching the
    // minimal correction.
    expect(requestNodeCorrection(
      runId,
      "qwen_review",
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted: coverage attestation is missing",
      {
        finish_reason: "end_turn",
        output_tokens: 9000,
        output_token_limit: 10000,
        tool_argument_parse_state: "missing",
      },
    ).status).toBe("scheduled");
    const injectedEvidence = getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence")?.[0] as Record<string, unknown>;
    expect(injectedEvidence).toMatchObject({
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
      accepted_findings: findings,
    });
    expect(injectedEvidence.attempt_diagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        failure_category: "contract_validation_failed",
        finish_reason: "end_turn",
        output_tokens: 9000,
        output_token_limit: 10000,
        tool_argument_parse_state: "missing",
      }),
    ]);
    expect(executor.tick(runId)).toBeGreaterThan(0);
    const correctionEnvelope = dispatcher.dispatched.at(-1);
    expect(correctionEnvelope?.nodeId).toBe("qwen_review");
    const correctionPrompt = String(correctionEnvelope?.inputs.correction?.[0] ?? "");
    expect(correctionPrompt).toContain("Correction attempt 1/2");
    expect(correctionPrompt).not.toContain("src/file-50.ts");
    expect(correctionPrompt).not.toMatch(/git diff|reserialize|changed_files/i);
    expect(correctionPrompt).toMatch(/Reuse completed evidence/i);

    // The correction attempt is truncated by the provider, but the final
    // payload still contains the valid compact coverage attestation.
    handoffActiveRun(
      runId,
      "qwen_review",
      "failed",
      modelReview("qwen", "abstain", { coverage: preparedCoverage }),
    );
    handoffActiveRun(runId, "kimi_review", "voted", modelReview("kimi", "approve", { coverage: preparedCoverage }));
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm", "approve", { coverage: preparedCoverage }));
    expect(executor.tick(runId)).toBeGreaterThan(0);

    const normalized = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "normalize_qwen_review" && handoff.port === "reviewed",
    )?.content as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      reviewed_files: files,
      unreviewed_files: [],
      coverage: preparedCoverage,
      diagnostics: [
        expect.objectContaining({
          attempt: 1,
          category: "contract_validation_failed",
          finish_reason: "end_turn",
          output_tokens: 9000,
          output_token_limit: 10000,
          tool_arguments_parse_state: "missing",
          contract_validation_stage: null,
          message: null,
        }),
      ],
    });
    expect(normalized.findings).toEqual(findings);

    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content as Record<string, unknown>;
    const report = decision.report as Record<string, unknown>;
    expect(report).toMatchObject({
      status: "findings",
      actionable_count: 3,
      findings,
    });
    expect((report.reviewer_results as Array<Record<string, unknown>>)
      .find((reviewer) => reviewer.reviewer === "qwen")?.findings).toEqual(findings);
    expect(getActiveRun(runId)?.status).toBe("cancelled");
    expect(await finalizeRunArtifacts(runId, "failure")).toEqual([
      expect.objectContaining({ name: "pr-review.json", status: "ready", publish: "always" }),
    ]);
    const artifact = JSON.parse(fs.readFileSync(getRunArtifactBlobPath(runId, "pr-review.json")!, "utf8"));
    expect(artifact.report).toMatchObject({ status: "findings", actionable_count: 3, findings });
    expect((artifact.report.reviewer_results as Array<Record<string, unknown>>)
      .find((reviewer) => reviewer.reviewer === "qwen")).toMatchObject({
      findings,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: "contract_validation_failed" }),
      ]),
    });
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "isolates interleaved three-reviewer projection files and survives database reopen",
    () => {
      const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
      for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
      installPrepareCommandStub(parsed);
      const dispatcher = new FakeDAGDispatcher();
      const executor = new GraphExecutor(dispatcher);
      const runId = "pr-review-three-isolated-projections";
      executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
      executor.tick(runId);

      const workspace = path.join(tmpHome, "workspace", runId);
      const reviews: Array<[ModelId, string]> = [
        ["qwen", "Qwen isolated projection finding"],
        ["glm", "GLM isolated projection finding"],
        ["kimi", "Kimi isolated projection finding"],
      ];
      const handoff = (reviewer: ModelId, title: string) => {
        handoffActiveRun(runId, `${reviewer}_review`, "voted", modelReview(reviewer, "request_changes", {
          findings: [{ ...finding, title }],
        }));
      };
      const projectionFiles = (): string[] => {
        const files: string[] = [];
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.name.endsWith(".json")) {
              try {
                const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { schema?: string };
                if (parsed.schema === "review-evidence-projection-v1") files.push(full);
              } catch {
                // Non-projection JSON in the workspace is irrelevant.
              }
            }
          }
        };
        walk(workspace);
        return files.sort();
      };

      handoff("qwen", reviews[0]![1]);
      handoff("glm", reviews[1]![1]);
      handoff("kimi", reviews[2]![1]);

      const initial = projectionFiles();
      expect(initial).toHaveLength(3);
      const relativePaths = initial.map((file) => path.relative(workspace, file).split(path.sep).join("/"));
      expect(relativePaths).not.toContain("review-evidence/projection.json");
      for (const segments of initial.map((file) => path.relative(workspace, file).split(path.sep))) {
        for (const segment of segments) {
          expect(segment).toMatch(/^[A-Za-z0-9._-]+$/);
        }
      }

      const byReviewer = new Map(initial.map((file) => {
        const content = JSON.parse(fs.readFileSync(file, "utf8")) as {
          reviewer: string;
          accepted_findings: Array<{ title: string }>;
        };
        return [content.reviewer, { file, content }] as const;
      }));
      expect(Array.from(byReviewer.keys()).sort()).toEqual(["glm_review", "kimi_review", "qwen_review"]);
      for (const [reviewer, title] of reviews) {
        const entry = byReviewer.get(`${reviewer}_review`);
        expect(entry?.content.accepted_findings.map((item) => item.title)).toEqual([title]);
        const serialized = JSON.stringify(entry?.content);
        for (const [otherReviewer, otherTitle] of reviews) {
          if (otherReviewer !== reviewer) {
            expect(serialized).not.toContain(otherTitle);
          }
        }
        expect(fs.statSync(entry!.file).mode & 0o777).toBe(0o600);
      }
      expect(new Set(initial.map((file) => fs.readFileSync(file, "utf8"))).size).toBe(3);

      const bytesBefore = new Map(initial.map((file) => [file, fs.readFileSync(file)]));
      expect(requestNodeCorrection(
        runId,
        "qwen_review",
        "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
        { finish_reason: "max_tokens", output_tokens: 900 },
      ).status).toBe("scheduled");
      const afterUpdate = projectionFiles();
      expect(afterUpdate).toHaveLength(3);
      for (const file of afterUpdate) {
        const content = JSON.parse(fs.readFileSync(file, "utf8")) as {
          reviewer: string;
          attempt_diagnostics: unknown[];
        };
        if (content.reviewer === "qwen_review") {
          expect(content.attempt_diagnostics).toHaveLength(1);
        } else {
          expect(fs.readFileSync(file)).toEqual(bytesBefore.get(file));
        }
      }

      closeDb();
      getDb();
      expect(projectionFiles().map((file) => fs.readFileSync(file, "utf8")))
        .toEqual(afterUpdate.map((file) => fs.readFileSync(file, "utf8")));
    },
    60_000,
  );

  it("injects only the current session/generation projection into correction mailboxes", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-fresh-fence-correction";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    const nodeId = "qwen_review";
    const sameIdFinding = (evidence: string, recommendation: string) => ({
      ...finding,
      title: "Finding id reused across dispatch fences",
      evidence,
      recommendation,
    });
    const staleFinding = sameIdFinding("stale dispatch evidence", "stale dispatch fix");
    const freshFinding = sameIdFinding("fresh dispatch evidence", "fresh dispatch fix");
    const incomplete = (reviewer: ModelId, findings: Array<Record<string, unknown>>) => ({
      reviewer,
      status: "complete",
      vote: "request_changes",
      summary: "Incomplete handoff",
      findings,
    });

    expect(() => handoffActiveRun(runId, nodeId, "voted", incomplete("qwen", [staleFinding])))
      .toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
    expect(requestNodeCorrection(
      runId,
      nodeId,
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
      { finish_reason: "max_tokens", output_tokens: 900 },
    ).status).toBe("scheduled");

    const run = getActiveRun(runId)!;
    const sessionBefore = run.nodeSessions.get(nodeId)!;
    const actor = getDagActorByNode(runId, nodeId)!;
    const freshSessionId = `${sessionBefore.sessionId}-fresh`;
    run.nodeSessions.set(nodeId, {
      ...sessionBefore,
      sessionId: freshSessionId,
      attempt: sessionBefore.attempt + 1,
      status: "active",
    });
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: actor.actor_id,
      expected_generation: actor.generation,
      expected_version: actor.version,
      session_id: freshSessionId,
      attempt: sessionBefore.attempt + 1,
    });
    run.counters.corrections[nodeId] = 0;
    run.dagRun.nodeStates.set(nodeId, "READY");
    run.dagRun.handoffedNodes.delete(nodeId);
    expect(() => handoffActiveRun(runId, nodeId, "voted", incomplete("qwen", [freshFinding])))
      .toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
    expect(requestNodeCorrection(
      runId,
      nodeId,
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
      { finish_reason: "end_turn", output_tokens: 700 },
    ).status).toBe("scheduled");

    const injected = getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence")?.[0] as Record<string, unknown>;
    expect(injected).toMatchObject({
      schema: "review-evidence-projection-v1",
      reviewer: "qwen_review",
    });
    expect((injected.accepted_findings as Array<Record<string, unknown>>).map((item) => item.evidence))
      .toEqual(["fresh dispatch evidence"]);
    expect(injected.attempt_diagnostics).toEqual([
      expect.objectContaining({
        attempt: 1,
        failure_category: "contract_validation_failed",
        finish_reason: "end_turn",
        output_tokens: 700,
      }),
    ]);
  });

  it("rejects a stale transport handoff without altering the current projection or mailbox", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-stale-handoff-isolation";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    const accepted = { ...finding, title: "Current accepted projection finding" };
    expect(() => handoffActiveRun(runId, "qwen_review", "voted", {
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      summary: "Incomplete handoff",
      findings: [accepted],
    })).toThrow(/DAG_HANDOFF_CONTRACT_VIOLATION/);
    expect(requestNodeCorrection(
      runId,
      "qwen_review",
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
      { finish_reason: "end_turn", output_tokens: 600 },
    ).status).toBe("scheduled");

    const workspace = path.join(tmpHome, "workspace", runId);
    const projectionFiles = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith(".json")) {
            try {
              const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { schema?: string };
              if (parsed.schema === "review-evidence-projection-v1") files.push(full);
            } catch {
              // Non-projection JSON in the workspace is irrelevant.
            }
          }
        }
      };
      walk(workspace);
      return files.sort();
    };
    const currentProjection = projectionFiles();
    expect(currentProjection).toHaveLength(1);
    const mailboxBefore = getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence");
    const bytesBefore = fs.readFileSync(currentProjection[0]!);

    expect(() => handoffActiveRun(
      runId,
      "qwen_review",
      "voted",
      { reviewer: "qwen", status: "complete", vote: "approve", summary: "stale transport", coverage, findings: [] },
      {
        transport: true,
        roundId: "round-0000",
        actorId: "qwen_review",
        generation: 1,
        leaseGeneration: 1,
      },
    )).toThrow(/DAG_HANDOFF_ROUND_CONFLICT/);

    expect(getActiveRun(runId)?.dagRun.mailboxes
      .get("normalize_qwen_review")?.get("evidence")).toEqual(mailboxBefore);
    expect(fs.readFileSync(currentProjection[0]!)).toEqual(bytesBefore);
  });

  it("publishes repeated ~50-file success runs deterministically", () => {
    const files = Array.from({ length: 50 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const preparedCoverage = coverageFor(files);
    for (let round = 1; round <= 2; round++) {
      const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
      for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
      installPrepareCommandStub(parsed, { files });
      const dispatcher = new FakeDAGDispatcher();
      const executor = new GraphExecutor(dispatcher);
      const runId = `pr-review-50-file-success-${round}`;
      executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
      executor.tick(runId);
      for (const reviewer of ["qwen", "kimi", "glm"] as const) {
        handoffActiveRun(runId, `${reviewer}_review`, "voted", modelReview(reviewer, "approve", {
          coverage: preparedCoverage,
        }));
      }
      expect(executor.tick(runId)).toBeGreaterThan(0);
      const decision = loadRunSnapshot(runId)?.handoffs.find(
        (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
      )?.content as Record<string, unknown>;
      expect(decision).toMatchObject({
        report: {
          status: "pass",
          coverage: preparedCoverage,
        },
        quorum: { passed: true, successes: 3, total: 3, threshold: 2 },
      });
      expect(getActiveRun(runId)?.status).toBe("completed");
    }
  });

  it("computes trusted digest/count outside model output and reconstructs canonical reviewed files", () => {
    const cwd = path.join(tmpHome, "prepare-50-file-coverage");
    fs.mkdirSync(cwd, { recursive: true });
    const files = Array.from({ length: 50 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const fakeGit = installFakeGit(cwd, files);

    const preparedResult = spawnSync(process.execPath, ["-e", productionPrepareCommand(fakeGit)], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify(prepareCommandInput()),
      maxBuffer: 2_000_000,
    });
    if (preparedResult.status !== 0) throw new Error(preparedResult.stderr || preparedResult.stdout);
    const prepared = JSON.parse(preparedResult.stdout) as {
      changed_files: string[];
      coverage: Coverage;
      commit_metadata: unknown[];
    };
    expect(prepared.changed_files).toEqual(files);
    expect(prepared.coverage).toEqual(coverageFor(files));

    const build = commandCode("build_review_context");
    const compactResult = spawnSync(process.execPath, ["-e", build.code, ...build.args], {
      encoding: "utf8",
      input: JSON.stringify({ prepared: [prepared] }),
    });
    expect(compactResult.status, compactResult.stderr).toBe(0);
    const compact = JSON.parse(compactResult.stdout) as Record<string, unknown>;
    expect(compact).not.toHaveProperty("changed_files");
    expect(compact).not.toHaveProperty("commit_metadata");
    expect(compact.coverage).toEqual(coverageFor(files));

    const trustedBuild = commandCode("build_trusted_review_context");
    const trustedResult = spawnSync(process.execPath, ["-e", trustedBuild.code, ...trustedBuild.args], {
      encoding: "utf8",
      input: JSON.stringify({ prepared: [prepared] }),
    });
    expect(trustedResult.status, trustedResult.stderr).toBe(0);
    const trusted = JSON.parse(trustedResult.stdout) as Record<string, unknown>;
    expect(trusted.changed_files).toEqual(files);

    const normalize = commandCode("normalize_qwen_review");
    const normalizedResult = spawnSync(process.execPath, ["-e", normalize.code, ...normalize.args], {
      encoding: "utf8",
      input: JSON.stringify({
        trusted: [trusted],
        evidence: [],
        success: [{
          reviewer: "qwen",
          status: "complete",
          vote: "request_changes",
          summary: "Complete review.",
          coverage: coverageFor(files),
          findings: [finding],
        }],
        failure: [],
      }),
    });
    expect(normalizedResult.status, normalizedResult.stderr).toBe(0);
    expect(JSON.parse(normalizedResult.stdout)).toMatchObject({
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      reviewed_files: files,
      unreviewed_files: [],
      findings: [finding],
      diagnostics: [{ attempt: 1, category: "accepted" }],
    });
  }, 30_000);

  it("computes canonical coverage for unsorted duplicate paths while preserving Git order", () => {
    const cwd = path.join(tmpHome, "prepare-canonical-coverage");
    fs.mkdirSync(cwd, { recursive: true });
    const files = ["src/z.ts", "src/a.ts", "src/m.ts", "src/a.ts", "src/z.ts", "src/a.ts"];
    const fakeGit = installFakeGit(cwd, files);

    const preparedResult = spawnSync(process.execPath, ["-e", productionPrepareCommand(fakeGit)], {
      cwd,
      encoding: "utf8",
      input: JSON.stringify(prepareCommandInput()),
      maxBuffer: 2_000_000,
    });
    if (preparedResult.status !== 0) throw new Error(preparedResult.stderr || preparedResult.stdout);
    const prepared = JSON.parse(preparedResult.stdout) as {
      changed_files: string[];
      coverage: Coverage;
    };

    const canonical = coverageFor(files);
    expect(prepared.changed_files).toEqual(files);
    expect(prepared.coverage).toEqual(canonical);
    expect(canonical.count).toBe(3);

    // The prepare node output must satisfy strict protocol validation for the
    // same changed-file set once wrapped in the full attestation schema (the
    // runtime evidence bridge does exactly this wrap for compact coverage),
    // and must be independent of order and duplicates.
    const attestation = changedFileCoverageAttestation(files);
    expect(attestation).toMatchObject(prepared.coverage);
    expect(validateChangedFileCoverageAttestation({
      schema: "changed-file-coverage-v1",
      ...prepared.coverage,
    }, files).valid).toBe(true);
    expect(validateChangedFileCoverageAttestation(
      { schema: "changed-file-coverage-v1", ...prepared.coverage },
      ["src/m.ts", "src/z.ts", "src/a.ts"],
    ).valid).toBe(true);

    // The prior workflow algorithm (SHA-256 of JSON.stringify in Git order
    // with duplicate count) diverges and is rejected by strict validation.
    const legacyDigest = cryptoDigest(JSON.stringify(files));
    expect(prepared.coverage.digest).not.toBe(legacyDigest);
    expect(validateChangedFileCoverageAttestation({
      schema: "changed-file-coverage-v1",
      digest: legacyDigest,
      count: files.length,
    }, files).valid).toBe(false);
  }, 30_000);

  it("accepts an exact coverage attestation when changed_files contains duplicates", () => {
    const files = ["src/z.ts", "src/a.ts", "src/m.ts", "src/a.ts", "src/z.ts", "src/a.ts"];
    const trusted = trustedContext(files);
    const attestation = coverageFor(files);
    expect(trusted.changed_files).toHaveLength(6);
    expect(attestation.count).toBe(3);

    for (const nodeId of [
      "normalize_qwen_review",
      "normalize_kimi_review",
      "normalize_glm_review",
    ] as const) {
      const { code, args } = commandCode(nodeId);
      const reviewer = nodeId.replace("normalize_", "").replace("_review", "");
      const normalizedResult = spawnSync(process.execPath, ["-e", code, ...args], {
        encoding: "utf8",
        input: JSON.stringify({
          trusted: [trusted],
          evidence: [],
          success: [{
            reviewer,
            status: "complete",
            vote: "request_changes",
            summary: "Complete review.",
            coverage: attestation,
            findings: [finding],
          }],
          failure: [],
        }),
      });
      expect(normalizedResult.status, normalizedResult.stderr).toBe(0);
      expect(JSON.parse(normalizedResult.stdout)).toMatchObject({
        reviewer,
        status: "complete",
        vote: "request_changes",
        coverage: attestation,
        reviewed_files: files,
        unreviewed_files: [],
      });
    }
  }, 30_000);

  it("rejects hostile clone URLs before invoking git", () => {
    const cwd = path.join(tmpHome, "prepare-url-validation");
    fs.mkdirSync(cwd, { recursive: true });
    for (const base_clone_url of [
      "https://token@github.example/enterprise/homerail.git",
      "http://github.example/enterprise/homerail.git",
      "https://github.example/enterprise/homerail.git?token=secret",
      "https://github.example/git/enterprise/homerail.git",
    ]) {
      const result = spawnSync(process.execPath, ["-e", productionPrepareCommand()], {
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
    "groups small changed-file patches into bounded evidence chunks with trusted coverage",
    () => {
      const cwd = path.join(tmpHome, "prepare-chunk-grouping");
      fs.mkdirSync(cwd, { recursive: true });
      const files = Array.from({ length: 28 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
      const fakeGit = installFakeGit(cwd, files);

      const result = spawnSync(process.execPath, ["-e", productionPrepareCommand(fakeGit)], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify(prepareCommandInput()),
        maxBuffer: 2_000_000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      const context = JSON.parse(result.stdout) as {
        changed_files: string[];
        coverage: Coverage;
        diff_chunks: Array<{ index: number; path: string; bytes: number; files: string[] }>;
        diff_bytes: number;
      };
      expect(context.changed_files).toEqual(files);
      expect(context.coverage).toEqual(coverageFor(files));
      expect(context.diff_chunks.length).toBeGreaterThan(0);
      expect(context.diff_chunks.length).toBeLessThan(files.length);
      expect(context.diff_chunks.every((chunk) =>
        chunk.bytes <= 120000 && fs.existsSync(path.join(cwd, chunk.path))
      )).toBe(true);
      expect(new Set(context.diff_chunks.flatMap((chunk) => chunk.files))).toEqual(new Set(files));
      expect(context.diff_chunks.reduce((total, chunk) => total + chunk.bytes, 0)).toBe(context.diff_bytes);
    },
    30_000,
  );

  it("installs Manager guidance and lists tracked template assets", async () => {
    expect(ensureManagerSkillsInstalled().installed).toContain("homerail-pr-review");
    expect(readManagerSkill("homerail-pr-review")?.content).toContain("create_and_run");
    const listed = await _invokeHostCodexVoiceToolForTest("list_orchestrations", {});
    expect(listed.result.content.map((entry) => entry.text).join("\n")).toContain("pr-review.yaml.template");
  });

  it("starts PR Review with code-resolved immutable GitHub metadata", async () => {
    let createRunBody: Record<string, unknown> | undefined;
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/repos/xiaotianfotos/homerail/pulls/25") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
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
      if (request.method === "POST" && request.url === "/api/runs/create-and-run") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          createRunBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: { runId: "host-pr-review-run" } }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const previousGithubApi = process.env.HOMERAIL_GITHUB_API_BASE_URL;
    process.env.HOMERAIL_GITHUB_API_BASE_URL = baseUrl;
    try {
      const invoked = await _invokeHostCodexVoiceToolForTest(
        "run_pr_review",
        { repo: "xiaotianfotos/homerail", pr: 25 },
        { managerRestUrl: `${baseUrl}/api` },
      );
      expect(JSON.parse(invoked.result.content[0].text)).toMatchObject({
        run_id: "host-pr-review-run",
        workflow_id: "pr-review",
        base: "a".repeat(40),
        head: "b".repeat(40),
      });
      const envelope = JSON.parse(String(createRunBody?.prompt));
      expect(envelope).toMatchObject({
        payload: {
          repo: "xiaotianfotos/homerail",
          pr: 25,
          base: "a".repeat(40),
          head: "b".repeat(40),
        },
      });
    } finally {
      if (previousGithubApi === undefined) delete process.env.HOMERAIL_GITHUB_API_BASE_URL;
      else process.env.HOMERAIL_GITHUB_API_BASE_URL = previousGithubApi;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the GitHub adapter owner-only, ready-triggered, and release-backed", () => {
    const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "pr-review.yml"), "utf8");
    const runner = fs.readFileSync(path.join(repositoryRoot, "scripts", "run-stable-dag-runner.sh"), "utf8");
    const reviewRunner = fs.readFileSync(path.join(repositoryRoot, "scripts", "run-pr-review-stable-runner.sh"), "utf8");
    const parsed = parseYaml(workflow) as {
      jobs: { review: { env: Record<string, string>; steps: Array<{ name: string; env?: Record<string, string> }> } };
    };
    expect(workflow).toContain("types: [opened, reopened, ready_for_review]");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("github.actor == 'xiaotianfotos'");
    expect(workflow).toContain("github.event.pull_request.draft == false");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("run-pr-review-stable-runner.sh");
    expect(workflow).not.toContain("report-pr-privacy-advisory.mjs");
    expect(workflow).not.toContain("pr-privacy-review.json");
    expect(workflow).toContain("render-pr-review-markdown.mjs");
    expect(runner).toContain("dag run-template");
    expect(runner).toContain('stable_hr dag artifact "$RUN_ID" "$artifact"');
    expect(runner).toContain('--profile "$PROFILE_ID"');
    expect(reviewRunner).toContain("HOMERAIL_STABLE_TASK=pr-review");
    expect(parsed.jobs.review.env.HOMERAIL_GITHUB_API_BASE_URL).toBe("${{ github.api_url }}");
    expect(parsed.jobs.review.env).not.toHaveProperty("HOMERAIL_HOME");
  });

  it("validates pass, findings, and inconclusive artifacts against the model votes", () => {
    const validator = path.join(repositoryRoot, "scripts", "validate-pr-review-artifacts.mjs");
    const dir = path.join(tmpHome, "artifact-validator");
    fs.mkdirSync(dir, { recursive: true });
    const commandPath = path.join(dir, "command.json");
    const reportPath = path.join(dir, "pr-review.json");
    const markdownPath = path.join(dir, "pr-review.md");
    const runId = "a".repeat(24);
    const artifacts = [
      { name: "pr-review.json", status: "ready" },
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
      { passed: true, successes: 3, total: 3, threshold: 2 },
    ).status).toBe(0);

    const emptyCoverage = coverageFor([]);
    const emptyDiffReport = {
      ...passingReviewReport(),
      coverage: emptyCoverage,
      reviewer_results: (["qwen", "kimi", "glm"] as const).map((reviewer) => ({
        ...normalizedReview(reviewer),
        coverage: emptyCoverage,
        reviewed_files: [],
        unreviewed_files: [],
      })),
    };
    expect(runValidator(
      "completed",
      emptyDiffReport,
      { passed: true, successes: 3, total: 3, threshold: 2 },
    ).status).toBe(0);
    const renderer = path.join(repositoryRoot, "scripts", "render-pr-review-markdown.mjs");
    const rendered = spawnSync(process.execPath, [renderer, commandPath, reportPath], { encoding: "utf8" });
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain(`**HomeRail Run ID:** \`${runId}\``);
    expect(rendered.stdout).toContain("| qwen | complete | approve |");
    expect(rendered.stdout).not.toContain("${run_id}");
    expect(runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 3, total: 3, threshold: 2 },
      rendered.stdout,
    ).status).toBe(0);

    const findingsReport = {
      ...passingReviewReport(),
      status: "findings",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen", "request_changes"),
        normalizedReview("kimi"),
        normalizedReview("glm"),
      ],
    };
    expect(runValidator(
      "cancelled",
      findingsReport,
      { passed: false, successes: 2, total: 3, threshold: 2 },
    ).status).toBe(0);

    const findingsFromFailedReviewer = {
      ...passingReviewReport(),
      status: "findings",
      confidence: "medium",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen", "abstain", {
          coverage: { digest: "0".repeat(64), count: 1 },
          findings: [finding],
          diagnostics: [{ attempt: 1, category: "provider_output_truncated" }],
        }),
        normalizedReview("kimi"),
        normalizedReview("glm"),
      ],
    };
    expect(runValidator(
      "cancelled",
      findingsFromFailedReviewer,
      { passed: false, successes: 2, total: 3, threshold: 2 },
    ).status).toBe(0);

    const inconclusiveReport = {
      ...passingReviewReport(),
      status: "inconclusive",
      confidence: "low",
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "abstain"),
        normalizedReview("glm", "abstain", {
          diagnostics: [{ attempt: 1, category: "reviewer_abstained" }],
        }),
      ],
    };
    expect(runValidator(
      "cancelled",
      inconclusiveReport,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    ).status).toBe(0);

    const truncated = {
      ...inconclusiveReport,
      status: "findings",
      confidence: "medium",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm", "abstain", {
          coverage: { digest: "0".repeat(64), count: 1 },
          diagnostics: [{
            attempt: 1,
            category: "provider_output_truncated",
            finish_reason: "max_tokens",
            output_tokens: 10000,
            output_token_limit: 10000,
            tool_arguments_parse_state: "parse_failed",
            contract_validation_stage: "coverage_attestation",
            message: "final payload truncated",
          }],
        }),
      ],
    };
    expect(runValidator(
      "cancelled",
      truncated,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    ).status).toBe(0);

    const contradictory = runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 2, total: 3, threshold: 2 },
    );
    expect(contradictory.status).toBe(1);
    expect(contradictory.stderr).toContain("does not match the model approval votes");

    const abstentionAsTruncation = {
      ...inconclusiveReport,
      status: "findings",
      confidence: "medium",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm", "abstain", {
          coverage: { digest: "0".repeat(64), count: 1 },
          diagnostics: [{ attempt: 1, category: "reviewer_abstained" }],
        }),
      ],
    };
    const deliberatelyAbstained = runValidator(
      "cancelled",
      abstentionAsTruncation,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    );
    expect(deliberatelyAbstained.status).toBe(0);

    const wrongCategory = {
      ...inconclusiveReport,
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm", "abstain", {
          coverage: { digest: "0".repeat(64), count: 1 },
          diagnostics: [{ attempt: 1, category: "invented_failure" }],
        }),
      ],
    };
    const invalidCategory = runValidator(
      "cancelled",
      wrongCategory,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    );
    expect(invalidCategory.status).toBe(1);
    expect(invalidCategory.stderr).toContain("attempt diagnostic has an invalid category");

    const unredacted = {
      ...inconclusiveReport,
      status: "findings",
      confidence: "medium",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm", "abstain", {
          coverage: { digest: "0".repeat(64), count: 1 },
          diagnostics: [{
            attempt: 1,
            category: "transport_failed",
            message: "https://secret.example/token leaked",
          }],
        }),
      ],
    };
    const leaked = runValidator(
      "cancelled",
      unredacted,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    );
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain("unredacted");

    const placeholder = runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 3, total: 3, threshold: 2 },
      "# Review\n\n**HomeRail Run ID:** `${run_id}`",
    );
    expect(placeholder.status).toBe(1);
  });

  it("keeps PR closeout manual and unable to merge", () => {
    const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "pr-closeout.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request_target:");
    expect(workflow).toContain("dag run-template pr-closeout");
    expect(workflow).not.toContain("gh pr merge");
    expect(workflow).toContain("This workflow never merges the pull request.");
  });
});

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
  changedFilesCoverage,
  classifyReviewAttemptCategory,
  coverageAttestationMatches,
} from "homerail-protocol";

import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { recordReviewerAttemptEvidence } from "../src/orchestration/response-bridge.js";
import {
  compileWorkflowSource,
  parseWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { loadReviewAttemptEvidence } from "../src/persistence/dag-review-evidence.js";
import { closeDb } from "../src/persistence/db.js";
import { getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  failActiveRun,
  getActiveRun,
  getCurrentNodeSession,
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

function coverageFor(files: readonly string[] = ["src/run.ts"]) {
  return changedFilesCoverage(files);
}

function attemptDiagnostic(overrides: Record<string, unknown> = {}) {
  return {
    attempt: 1,
    category: "accepted",
    termination_reason: "end_turn",
    output_tokens: 12,
    output_token_limit: null,
    tool_argument_parse: "ok",
    contract_stage: "accepted",
    redacted_reason: "",
    ...overrides,
  };
}

function modelReview(
  reviewer: ModelId,
  vote: Vote = "approve",
  options: { failed?: boolean; intentionalAbstention?: boolean; findings?: unknown[]; coverage?: unknown } = {},
): Record<string, unknown> {
  const failed = options.failed ?? vote === "abstain";
  return {
    reviewer,
    status: failed ? "failed" : "complete",
    vote: failed ? "abstain" : vote,
    summary: failed ? `${reviewer} could not complete the review` : `${reviewer} review complete`,
    coverage: options.coverage ?? coverageFor(),
    evidence_truncated: failed ? options.intentionalAbstention !== true : false,
    findings: options.findings ?? (!failed && vote === "request_changes" ? [finding] : []),
  };
}

function normalizedReview(
  reviewer: ModelId,
  vote: Vote = "approve",
  options: { failed?: boolean; intentionalAbstention?: boolean } = {},
): Record<string, unknown> {
  const failed = options.failed ?? vote === "abstain";
  const attempts = failed
    ? [attemptDiagnostic({
        attempt: 1,
        category: options.intentionalAbstention ? "reviewer_abstained" : "provider_output_truncated",
        termination_reason: options.intentionalAbstention ? "end_turn" : "max_tokens",
        contract_stage: options.intentionalAbstention ? "accepted" : "not_reached",
      })]
    : [attemptDiagnostic()];
  return {
    ...modelReview(reviewer, vote, options),
    reviewed_files: failed ? [] : ["src/run.ts"],
    unreviewed_files: failed ? ["src/run.ts"] : [],
    attempts,
    coverage: failed ? null : coverageFor(),
  };
}

function reviewerTerminalPayload(runId: string, nodeId: string, content: unknown): Record<string, unknown> {
  const session = getCurrentNodeSession(runId, nodeId);
  const actor = getDagActorByNode(runId, nodeId);
  return {
    runId,
    nodeId,
    ...(session?.sessionId ? { session_id: session.sessionId } : {}),
    ...(actor ? { generation: actor.generation } : {}),
    content,
    termination_metadata: {
      stop_reason: "end_turn",
      output_tokens: 12,
      output_token_limit: null,
      tool_argument_parse: "ok",
    },
  };
}

function recordAcceptedReviewerAttempt(runId: string, nodeId: string, content: unknown): void {
  expect(recordReviewerAttemptEvidence(reviewerTerminalPayload(runId, nodeId, content), {
    category: "accepted",
    contractStage: "accepted",
  })).toBe(true);
}

function passingReviewReport(): Record<string, unknown> {
  return {
    repo: "xiaotianfotos/homerail",
    pr: 25,
    base: "a".repeat(40),
    head: "b".repeat(40),
    status: "pass",
    confidence: "medium",
    summary: "Three-model review: 2 approve, 1 request changes, 0 abstain.",
    actionable_count: 0,
    findings: [],
    reviewer_results: [
      normalizedReview("qwen"),
      normalizedReview("kimi"),
      normalizedReview("glm", "request_changes"),
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
      ",commit_metadata:[],commit_metadata_truncated:false,changed_files_digest:" + JSON.stringify(changedFilesCoverage(["src/run.ts"]).digest) + ",changed_files_count:1}))})",
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
        outputs: expect.arrayContaining([expect.objectContaining({ name: "voted", contract: "ReviewerHandoff" })]),
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
      expect(validateJsonContract(contracts.ReviewerHandoff, modelReview(reviewer))).toMatchObject({ valid: true });
    }
    expect(validateJsonContract(contracts.ReviewerHandoff, {
      ...modelReview("qwen"),
      reviewer: "runtime",
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.ReviewerHandoff, {
      ...modelReview("qwen"),
      coverage: { digest: "a".repeat(64), count: 1 },
    })).toMatchObject({ valid: true });
    expect(validateJsonContract(contracts.ReviewerHandoff, {
      ...modelReview("qwen", "approve"),
      findings: [finding],
    })).toMatchObject({ valid: false });
    expect(validateJsonContract(contracts.ReviewerHandoff, {
      ...modelReview("qwen", "request_changes"),
      findings: [],
    })).toMatchObject({ valid: false });

    const agents = parseWorkflowSource(source).meta.agents ?? {};
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toMatch(/final action MUST\s+call\s+(?:the\s+)?handoff/);
    }
    for (const agentId of ["qwen_reviewer", "kimi_reviewer", "glm_reviewer"]) {
      expect(agents[agentId]?.system).toContain("input.context.diff_chunks");
      expect(agents[agentId]?.system).toMatch(/Independently review/);
      expect(agents[agentId]?.system).toContain("No draft report exists or is required");
      expect(agents[agentId]?.system).toContain("changed_files_digest");
      expect(agents[agentId]?.system).toContain("Never echo");
      expect(agents[agentId]?.system).toContain("input:reviewer_state");
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
        report: { status: string; actionable_count: number; findings: unknown[] };
        quorum: { passed: boolean; successes: number; total: number; threshold: number };
      };
    };

    expect(execute([
      modelReview("qwen"),
      modelReview("kimi"),
      modelReview("glm", "request_changes"),
    ])).toMatchObject({
      report: { status: "pass", actionable_count: 0 },
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    });
    expect(execute([
      modelReview("qwen", "request_changes"),
      modelReview("kimi", "request_changes"),
      modelReview("glm"),
    ])).toMatchObject({
      report: { status: "findings", actionable_count: 1 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
    expect(execute([
      modelReview("qwen"),
      modelReview("kimi", "request_changes"),
      modelReview("glm", "abstain"),
    ])).toMatchObject({
      report: { status: "inconclusive", actionable_count: 0 },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
  });

  it("normalizes incomplete model output to a classified abstention", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const files = ["src/run.ts", "src/other.ts"];
    const coverage = coverageFor(files);
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        context: [{
          changed_files: files,
          changed_files_digest: coverage.digest,
          changed_files_count: coverage.count,
        }],
        failure: [{ error: "provider output ended mid-JSON" }],
        evidence: [{
          findings: [],
          attempts: [attemptDiagnostic({
            category: "provider_output_truncated",
            termination_reason: "max_tokens",
            contract_stage: "not_reached",
          })],
          coverage: null,
        }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const normalized = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: files,
      evidence_truncated: true,
      findings: [],
    });
    expect((normalized.attempts as Array<Record<string, unknown>>).at(-1))
      .toMatchObject({ category: "provider_output_truncated", termination_reason: "max_tokens" });
  });

  it("expands a valid compact attestation to canonical coverage and rejects mismatches", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const files = Array.from({ length: 49 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const coverage = coverageFor(files);
    const execute = (success: unknown, evidence: unknown) => {
      const result = spawnSync(process.execPath, ["-e", code, ...args], {
        encoding: "utf8",
        input: JSON.stringify({
          context: [{
            changed_files: files,
            changed_files_digest: coverage.digest,
            changed_files_count: coverage.count,
          }],
          success: Array.isArray(success) ? success : [success],
          evidence: [evidence],
        }),
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    const accepted = execute(modelReview("qwen", "request_changes", {
      findings: [finding],
      coverage,
    }), {
      findings: [finding],
      attempts: [attemptDiagnostic()],
      coverage,
    });
    expect(accepted).toMatchObject({
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      reviewed_files: files,
      unreviewed_files: [],
      evidence_truncated: false,
      findings: [finding],
      coverage: { digest: coverage.digest, count: 49 },
    });
    expect(accepted.attempts).toEqual([attemptDiagnostic()]);

    const mismatched = execute({
      ...modelReview("qwen", "approve"),
      coverage: { digest: "a".repeat(64), count: 49 },
    }, {
      findings: [],
      attempts: [attemptDiagnostic()],
      coverage,
    });
    expect(mismatched).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: files,
      evidence_truncated: true,
    });
    expect((mismatched.attempts as Array<Record<string, unknown>>).at(-1))
      .toMatchObject({ category: "contract_validation_failed", contract_stage: "rejected" });
  });

  it("keeps changed-file coverage deterministic SHA-256 and rejects mismatches", () => {
    const cases = [
      [],
      ["src/run.ts"],
      Array.from({ length: 49 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`),
      ["src/unicodé.ts", "docs/说明.md", "a/b c.ts"],
      ["src/lone\uD800.ts"],
      ["a\nb\tc", "\"quoted\\\\path\""],
    ];
    for (const files of cases) {
      const expected = createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex");
      expect(changedFilesCoverage(files)).toEqual({ digest: expected, count: files.length });
    }
    const coverage = coverageFor(["src/run.ts", "src/store.ts"]);
    expect(coverageAttestationMatches({ digest: coverage.digest, count: coverage.count }, coverage))
      .toBe(true);
    expect(coverageAttestationMatches({ digest: coverage.digest, count: coverage.count - 1 }, coverage))
      .toBe(false);
    expect(coverageAttestationMatches({ digest: "a".repeat(64), count: coverage.count }, coverage))
      .toBe(false);
  });

  it("preserves accepted findings across an incomplete Qwen final handoff", () => {
    const { code, args } = commandCode("normalize_qwen_review");
    const files = Array.from({ length: 49 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
    const coverage = coverageFor(files);
    const threeFindings = [
      { ...finding, title: "First regression", file: "src/run.ts" },
      { ...finding, title: "Second regression", file: "src/store.ts", line: 22 },
      { ...finding, title: "Third regression", file: "src/queue.ts", line: 31 },
    ];
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        context: [{
          changed_files: files,
          changed_files_digest: coverage.digest,
          changed_files_count: coverage.count,
        }],
        failure: [{ error: "provider output ended mid-JSON" }],
        evidence: [{
          findings: threeFindings,
          attempts: [
            attemptDiagnostic({ attempt: 1 }),
            attemptDiagnostic({
              attempt: 2,
              category: "contract_validation_failed",
              termination_reason: "end_turn",
              contract_stage: "rejected",
              redacted_reason: "coverage attestation mismatch",
            }),
            attemptDiagnostic({
              attempt: 3,
              category: "provider_output_truncated",
              termination_reason: "max_tokens",
              contract_stage: "not_reached",
            }),
          ],
          coverage,
        }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const normalized = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "qwen",
      status: "failed",
      vote: "abstain",
      evidence_truncated: true,
      reviewed_files: [],
      unreviewed_files: files,
    });
    expect(normalized.findings).toEqual(threeFindings);
    expect((normalized.attempts as Array<Record<string, unknown>>).map((attempt) => attempt.category)).toEqual([
      "accepted",
      "contract_validation_failed",
      "provider_output_truncated",
    ]);
  });

  it("keeps an intentional abstention distinct from structured-output loss", () => {
    const { code, args } = commandCode("normalize_kimi_review");
    const files = ["src/run.ts", "src/store.ts"];
    const coverage = coverageFor(files);
    const result = spawnSync(process.execPath, ["-e", code, ...args], {
      encoding: "utf8",
      input: JSON.stringify({
        context: [{
          changed_files: files,
          changed_files_digest: coverage.digest,
          changed_files_count: coverage.count,
        }],
        success: [{
          ...modelReview("kimi", "abstain", { intentionalAbstention: true }),
          coverage,
        }],
        evidence: [{
          findings: [],
          attempts: [attemptDiagnostic({
            category: "reviewer_abstained",
            termination_reason: "end_turn",
          })],
          coverage,
        }],
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const normalized = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(normalized).toMatchObject({
      reviewer: "kimi",
      status: "failed",
      vote: "abstain",
      evidence_truncated: false,
      reviewed_files: [],
      unreviewed_files: files,
    });
    expect((normalized.attempts as Array<Record<string, unknown>>).at(-1))
      .toMatchObject({ category: "reviewer_abstained" });
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
    handoffActiveRun(runId, "glm_review", "voted", modelReview("glm", "request_changes"));
    recordAcceptedReviewerAttempt(runId, "qwen_review", modelReview("qwen"));
    recordAcceptedReviewerAttempt(runId, "kimi_review", modelReview("kimi"));
    recordAcceptedReviewerAttempt(runId, "glm_review", modelReview("glm", "request_changes"));

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
      report: { status: "pass", reviewer_results: expect.arrayContaining([
        expect.objectContaining({ reviewer: "qwen", vote: "approve" }),
        expect.objectContaining({ reviewer: "kimi", vote: "approve" }),
        expect.objectContaining({ reviewer: "glm", vote: "request_changes" }),
      ]) },
      quorum: { passed: true, successes: 2, total: 3, threshold: 2 },
    });

    expect(getActiveRun(runId)?.status).toBe("completed");
    expect(await finalizeRunArtifacts(runId, "success")).toEqual([
      expect.objectContaining({ name: "pr-review.json", status: "ready" }),
    ]);
    expect(JSON.parse(fs.readFileSync(getRunArtifactBlobPath(runId, "pr-review.json")!, "utf8")))
      .toMatchObject({ report: { status: "pass" }, quorum: { passed: true, successes: 2 } });
  });

  it("turns one failed model into abstain and keeps a split decision inconclusive", () => {
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
    failActiveRun(runId, "glm_review", "agent ended without a contract-valid handoff");
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
    });
    const decision = loadRunSnapshot(runId)?.handoffs.find(
      (handoff) => handoff.fromNode === "decide" && handoff.port === "decided",
    )?.content;
    expect(decision).toMatchObject({
      report: { status: "inconclusive" },
      quorum: { passed: false, successes: 1, total: 3, threshold: 2 },
    });
  });

  it("correction reuses bounded accepted state without the full context", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-correction-state";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    // Attempt 1: parseable JSON with three findings but an invalid compact
    // coverage attestation. The Manager persists the findings as accepted
    // evidence even though the handoff is contract-rejected for correction.
    const content = {
      ...modelReview("qwen", "request_changes", {
        findings: [finding, { ...finding, title: "Second regression", line: 22 }],
      }),
      coverage: { digest: "b".repeat(64), count: 1 },
    };
    expect(recordReviewerAttemptEvidence(
      reviewerTerminalPayload(runId, "qwen_review", content),
      {
        category: "contract_validation_failed",
        contractStage: "rejected",
        redactedReason: "coverage attestation mismatch",
      },
    )).toBe(true);
    expect(loadReviewAttemptEvidence(runId, "qwen_review").findings).toHaveLength(2);

    const correction = requestNodeCorrection(
      runId,
      "qwen_review",
      "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted (ReviewerHandoff): coverage mismatch",
    );
    expect(correction.status).toBe("scheduled");

    const envelope = buildCurrentDispatchEnvelope(runId, "qwen_review");
    expect(envelope.ok).toBe(true);
    const inputs = envelope.envelope.inputs;
    expect(Object.keys(inputs).sort()).toEqual(["correction", "reviewer_state"]);
    expect(inputs.context).toBeUndefined();
    expect(inputs.correction.at(-1)).toContain("Correction attempt 1/2");
    expect(inputs.correction.at(-1)).toContain("coverage attestation mismatch");
    const state = inputs.reviewer_state.at(-1) as Record<string, unknown>;
    expect(state.findings).toHaveLength(2);
    expect(state.coverage).toMatchObject({ count: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(state).length).toBeLessThan(64 * 1024);
  });

  it("records bounded attempt diagnostics for every failure category", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-attempt-categories";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    expect(recordReviewerAttemptEvidence(
      reviewerTerminalPayload(runId, "qwen_review", modelReview("qwen")),
      { transport: true, contractStage: "not_reached", redactedReason: "DAG_TRANSPORT_LEASE_STALE run/node" },
    )).toBe(true);
    expect(recordReviewerAttemptEvidence(
      reviewerTerminalPayload(runId, "kimi_review", modelReview("kimi")),
      { contractStage: "rejected", redactedReason: "DAG_HANDOFF_CONTRACT_VIOLATION kimi_review.voted (ReviewerHandoff): coverage mismatch" },
    )).toBe(true);
    expect(recordReviewerAttemptEvidence(
      {
        ...reviewerTerminalPayload(runId, "glm_review", modelReview("glm")),
        termination_metadata: {
          stop_reason: "max_tokens",
          output_tokens: 411,
          output_token_limit: null,
          tool_argument_parse: "unknown",
        },
      },
      { contractStage: "not_reached", redactedReason: "provider output ended mid-JSON" },
    )).toBe(true);

    expect(loadReviewAttemptEvidence(runId, "qwen_review").attempts.at(-1))
      .toMatchObject({ category: "transport_failed", contract_stage: "not_reached" });
    expect(loadReviewAttemptEvidence(runId, "kimi_review").attempts.at(-1))
      .toMatchObject({ category: "contract_validation_failed", contract_stage: "rejected" });
    expect(loadReviewAttemptEvidence(runId, "glm_review").attempts.at(-1))
      .toMatchObject({
        category: "provider_output_truncated",
        termination_reason: "max_tokens",
        output_tokens: 411,
      });
  });

  it("classifies every bounded attempt failure category deterministically", () => {
    expect(classifyReviewAttemptCategory({ terminationReason: "max_tokens" }))
      .toBe("provider_output_truncated");
    expect(classifyReviewAttemptCategory({ toolArgumentParse: "invalid" }))
      .toBe("handoff_arguments_invalid");
    expect(classifyReviewAttemptCategory({
      redactedReason: "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted (ReviewerHandoff)",
    })).toBe("contract_validation_failed");
    expect(classifyReviewAttemptCategory({ redactedReason: "COVERAGE_ATTESTATION mismatch" }))
      .toBe("contract_validation_failed");
    expect(classifyReviewAttemptCategory({
      transport: true,
      redactedReason: "DAG_TRANSPORT_LEASE_STALE run/node",
    })).toBe("transport_failed");
    expect(classifyReviewAttemptCategory({ redactedReason: "DAG_TRANSPORT_GENERATION_CONFLICT" }))
      .toBe("transport_failed");
    expect(classifyReviewAttemptCategory({ status: "failed", vote: "abstain" }))
      .toBe("reviewer_abstained");
    expect(classifyReviewAttemptCategory({ status: "complete", contractStage: "accepted" }))
      .toBe("accepted");
    expect(classifyReviewAttemptCategory({})).toBe("unknown");
  });

  it("persists invalid handoff tool arguments as a distinct attempt category", () => {
    const parsed = parseWorkflowSource(fs.readFileSync(workflowPath, "utf8"));
    for (const agent of Object.values(parsed.meta.agents ?? {})) agent.agent_type = "deterministic";
    installPrepareCommandStub(parsed);
    const dispatcher = new FakeDAGDispatcher();
    const executor = new GraphExecutor(dispatcher);
    const runId = "pr-review-invalid-arguments";
    executor.createRun(runId, parsed, JSON.stringify(reviewInput()));
    executor.tick(runId);

    expect(recordReviewerAttemptEvidence(
      {
        ...reviewerTerminalPayload(runId, "qwen_review", modelReview("qwen")),
        termination_metadata: {
          stop_reason: "end_turn",
          output_tokens: 9,
          output_token_limit: null,
          tool_argument_parse: "invalid",
        },
      },
      {
        contractStage: "not_reached",
        redactedReason: "handoff top-level keys are outside the allowed shape",
      },
    )).toBe(true);
    expect(loadReviewAttemptEvidence(runId, "qwen_review").attempts.at(-1)).toMatchObject({
      category: "handoff_arguments_invalid",
      tool_argument_parse: "invalid",
      contract_stage: "not_reached",
      output_tokens: 9,
    });
  });

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
    "groups small changed-file patches into bounded evidence chunks",
    () => {
      const cwd = path.join(tmpHome, "prepare-chunk-grouping");
      const bin = path.join(cwd, "bin");
      fs.mkdirSync(bin, { recursive: true });
      const files = Array.from({ length: 28 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
      const patch = files.map((file) => [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1 +1 @@",
        `-${"a".repeat(1600)}`,
        `+${"b".repeat(1600)}`,
        "",
      ].join("\n")).join("");
      const head = "b".repeat(40);
      const fakeGit = path.join(bin, "fake-git.cjs");
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
      const git = path.join(bin, "git");
      fs.writeFileSync(git, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeGit)});\n`);
      fs.chmodSync(git, 0o755);

      const result = spawnSync(process.execPath, ["-e", productionPrepareCommand()], {
        cwd,
        encoding: "utf8",
        input: JSON.stringify(prepareCommandInput()),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        maxBuffer: 2_000_000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      const context = JSON.parse(result.stdout) as {
        changed_files: string[];
        diff_chunks: Array<{ index: number; path: string; bytes: number; files: string[] }>;
        diff_bytes: number;
      };
      expect(context.changed_files).toEqual(files);
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
      { passed: true, successes: 2, total: 3, threshold: 2 },
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
      { passed: true, successes: 2, total: 3, threshold: 2 },
      rendered.stdout,
    ).status).toBe(0);

    const findingsReport = {
      ...passingReviewReport(),
      status: "findings",
      actionable_count: 1,
      findings: [finding],
      reviewer_results: [
        normalizedReview("qwen", "request_changes"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm"),
      ],
    };
    expect(runValidator(
      "cancelled",
      findingsReport,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    ).status).toBe(0);

    const inconclusiveReport = {
      ...passingReviewReport(),
      status: "inconclusive",
      confidence: "low",
      reviewer_results: [
        normalizedReview("qwen"),
        normalizedReview("kimi", "request_changes"),
        normalizedReview("glm", "abstain"),
      ],
    };
    expect(runValidator(
      "cancelled",
      inconclusiveReport,
      { passed: false, successes: 1, total: 3, threshold: 2 },
    ).status).toBe(0);

    const contradictory = runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 3, total: 3, threshold: 2 },
    );
    expect(contradictory.status).toBe(1);
    expect(contradictory.stderr).toContain("does not match the model approval votes");

    const placeholder = runValidator(
      "completed",
      passingReviewReport(),
      { passed: true, successes: 2, total: 3, threshold: 2 },
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

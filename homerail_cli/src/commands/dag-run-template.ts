import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BaseResponse, HomeRailClient } from "../client.js";
import { getClient } from "../index.js";
import {
  manualCloseoutEnvelope,
  resolvePrCloseoutInput,
  writePrCloseoutEvidence,
} from "./dag-pr-closeout.js";
import { orchestrationsDir, resolveTemplatePath } from "./templates.js";

interface GlobalOpts {
  baseUrl?: string;
  json?: boolean;
  requestTimeout?: number;
}

interface RunTemplateOptions {
  input: string;
  profile?: string;
  settingId?: string;
  runId?: string;
  wait?: boolean;
  timeout: string;
  interval: string;
  outputDir?: string;
}

interface ReviewReportOptions {
  outputDir: string;
}

export interface ResolvedPrReviewInput {
  repo: string;
  pr: number;
  base: string;
  head: string;
  expected_usage: number;
  budget_key: string;
  title?: string;
  author?: string;
}

interface PublishedReview {
  report: Record<string, unknown>;
  markdown: string;
  json_path: string;
  markdown_path: string;
  quorum: Record<string, unknown>;
}

interface PrReviewEvidence {
  run_id: string;
  run_status: string;
  runtime_ms: number | null;
  report: Record<string, unknown>;
  quorum: Record<string, unknown>;
  verification: {
    votes: Record<string, unknown>[];
    quorum: Record<string, unknown>;
  };
  budget: Record<string, unknown>;
  metrics: Record<string, unknown> | null;
  artifacts: { json: string; markdown: string };
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function positiveNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "HomeRail-PR-Review",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function resolvePrReviewInput(
  input: Record<string, unknown>,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): Promise<ResolvedPrReviewInput> {
  const repo = optionalString(input.repo);
  const pr = Number(input.pr);
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error("pr-review input.repo must be owner/name");
  if (!Number.isInteger(pr) || pr < 1) throw new Error("pr-review input.pr must be a positive integer");

  let base = optionalString(input.base);
  let head = optionalString(input.head);
  let title = optionalString(input.title);
  let author = optionalString(input.author);
  if (!base || !head) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
      headers: githubHeaders(options.env ?? process.env),
    });
    if (!response.ok) throw new Error(`GitHub PR lookup failed: HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    const baseRecord = data.base as Record<string, unknown> | undefined;
    const headRecord = data.head as Record<string, unknown> | undefined;
    const userRecord = data.user as Record<string, unknown> | undefined;
    base ??= optionalString(baseRecord?.sha);
    head ??= optionalString(headRecord?.sha);
    title ??= optionalString(data.title);
    author ??= optionalString(userRecord?.login);
  }
  if (!base || !SHA_PATTERN.test(base)) throw new Error("pr-review base must be a commit SHA");
  if (!head || !SHA_PATTERN.test(head)) throw new Error("pr-review head must be a commit SHA");

  const expectedUsage = input.expected_usage === undefined ? 8 : Number(input.expected_usage);
  if (!Number.isFinite(expectedUsage) || expectedUsage < 0 || expectedUsage > 100) {
    throw new Error("pr-review expected_usage must be between 0 and 100");
  }
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  return {
    repo,
    pr,
    base,
    head,
    expected_usage: expectedUsage,
    budget_key: optionalString(input.budget_key) ?? `pr-review:${repo}:${date}`,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
  };
}

export function manualRunEnvelope(input: ResolvedPrReviewInput): Record<string, unknown> {
  return {
    trigger_id: "manual",
    trigger_type: "manual",
    fire_key: `manual:${input.repo}#${input.pr}:${input.head}`,
    payload: input,
  };
}

function responseData(response: unknown): Record<string, unknown> {
  const data = (response as { data?: unknown }).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

async function startTemplateRun(
  client: HomeRailClient,
  template: string,
  input: Record<string, unknown>,
  opts: RunTemplateOptions,
): Promise<{ runId: string; workflowId: string; response: BaseResponse }> {
  const filePath = resolveTemplatePath(orchestrationsDir(), template);
  if (!fs.existsSync(filePath)) throw new Error(`DAG template not found: ${template}`);
  const syncResponse = await client.post<BaseResponse>("/api/dag/workflows/sync", {
    yaml_text: fs.readFileSync(filePath, "utf8"),
    source_path: filePath,
  });
  const workflow = responseData(syncResponse).workflow as Record<string, unknown> | undefined;
  const workflowId = optionalString(workflow?.workflow_id);
  if (!workflowId) throw new Error("Manager did not return workflow_id after template sync");
  const response = await client.post<BaseResponse>("/api/runs/create-and-run", {
    workflow_id: workflowId,
    prompt: JSON.stringify(input),
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.settingId ? { llm_setting_id: opts.settingId } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  });
  const data = responseData(response);
  const runId = optionalString(data.run_id) ?? optionalString(data.runId);
  if (!runId) throw new Error("Manager did not return run id");
  return { runId, workflowId, response };
}

async function waitForTerminal(
  client: HomeRailClient,
  runId: string,
  timeoutSeconds: number,
  intervalSeconds: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let last: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    last = responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/status`));
    const status = optionalString(last.status) ?? "unknown";
    if (TERMINAL_STATUSES.has(status)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
  }
  throw new Error(`timed out waiting for PR review run ${runId}; last status: ${String(last.status ?? "unknown")}`);
}

function parsePublishedReview(value: unknown): PublishedReview | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!record.report || typeof record.markdown !== "string" || !record.quorum) return undefined;
  return record as unknown as PublishedReview;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function handoffNode(raw: Record<string, unknown>): string {
  return String(raw.fromNode ?? raw.from_node ?? raw.node ?? "");
}

function assertReportIdentity(report: Record<string, unknown>, budget: Record<string, unknown>): void {
  const input = budget.input as Record<string, unknown> | undefined;
  const payload = input?.payload as Record<string, unknown> | undefined;
  if (!payload) throw new Error("PR review budget handoff has no authoritative input payload");
  for (const field of ["repo", "pr", "base", "head"] as const) {
    if (report[field] !== payload[field]) {
      throw new Error(
        `PR review published report identity mismatch for ${field}: expected ${String(payload[field])}, received ${String(report[field])}`,
      );
    }
  }
}

function findingKey(value: Record<string, unknown>): string {
  return `${String(value.file ?? "")}\u0000${String(value.line ?? "")}\u0000${String(value.title ?? "")}`;
}

function recordFindings(report: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(report.findings)
    ? report.findings.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
    : [];
}

function assertFindingVerification(
  report: Record<string, unknown>,
  draft: Record<string, unknown>,
  votes: Record<string, unknown>[],
): void {
  const draftKeys = new Set(recordFindings(draft).map(findingKey));
  const finalKeys = new Set(recordFindings(report).map(findingKey));
  const rejectedKeys = new Set<string>();
  for (const voter of ["evidence", "false_positive"]) {
    const vote = votes.find((value) => value.voter === voter);
    const verdicts = vote?.finding_verdicts;
    if (!Array.isArray(verdicts)) {
      throw new Error(`PR review ${voter} verifier has no per-finding verdicts`);
    }
    const records = verdicts.filter(
      (value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)),
    );
    const verdictByKey = new Map(records.map((value) => [findingKey(value), value]));
    for (const key of draftKeys) {
      const verdict = verdictByKey.get(key);
      if (!verdict) throw new Error(`PR review ${voter} verifier did not cover a drafted finding`);
      if (verdict.verdict === "rejected") rejectedKeys.add(key);
      else if (verdict.verdict !== "confirmed") {
        throw new Error(`PR review ${voter} verifier returned an invalid finding verdict`);
      }
    }
  }
  const expectedKeys = new Set([...draftKeys].filter((key) => !rejectedKeys.has(key)));
  for (const key of finalKeys) {
    if (rejectedKeys.has(key)) throw new Error("PR review retained a finding rejected by a verifier");
    if (!expectedKeys.has(key)) throw new Error("PR review published a finding that was not in the verified draft");
  }
  for (const key of expectedKeys) {
    if (!finalKeys.has(key)) throw new Error("PR review refiner removed a finding confirmed by both verifiers");
  }
}

function assertQuorumEvidence(
  report: Record<string, unknown>,
  published: Record<string, unknown>,
  persisted: Record<string, unknown>,
  votes: Record<string, unknown>[],
): void {
  const successes = votes.filter((vote) => vote.vote === "accept").length;
  if (persisted.total !== 3 || persisted.threshold !== 2) {
    throw new Error("PR review persisted verifier quorum is not 2-of-3");
  }
  if (persisted.successes !== successes || persisted.passed !== (successes >= 2)) {
    throw new Error("PR review persisted verifier quorum disagrees with verifier votes");
  }
  for (const field of ["passed", "successes", "total", "threshold"] as const) {
    if (published[field] !== persisted[field]) {
      throw new Error(`PR review published quorum mismatch for ${field}`);
    }
  }
  if (persisted.passed === false && report.status !== "inconclusive") {
    throw new Error("PR review rejected quorum must publish an inconclusive report");
  }
}

function runtimeMs(status: Record<string, unknown>): number | null {
  const created = Date.parse(String(status.created_at ?? ""));
  const completed = Date.parse(String(status.completed_at ?? ""));
  return Number.isFinite(created) && Number.isFinite(completed) ? Math.max(0, completed - created) : null;
}

function markdownWithRuntime(
  published: PublishedReview,
  runId: string,
  status: string,
  elapsed: number | null,
  metrics: Record<string, unknown> | null,
  budget: Record<string, unknown>,
  votes: Record<string, unknown>[],
): string {
  const totals = metrics?.totals as Record<string, unknown> | undefined;
  const tokens = totals?.tokens as Record<string, unknown> | undefined;
  const usage = tokens
    ? `${Number(tokens.input ?? 0) + Number(tokens.output ?? 0)} tokens`
    : "unavailable";
  const verifierLines = votes.map((vote) =>
    `- ${String(vote.voter ?? "unknown")}: ${String(vote.vote ?? "unknown")} (${String(vote.confidence ?? "unknown")})`
  ).join("\n");
  return `${published.markdown.trim()}\n\n## HomeRail Run\n\n- Run: \`${runId}\`\n- Status: \`${status}\`\n- Runtime: ${elapsed === null ? "unavailable" : `${Math.round(elapsed / 1000)}s`}\n- Model usage: ${usage}\n- Budget: requested ${String(budget.requested ?? "unknown")}, spent ${String(budget.spent ?? "unknown")}, remaining ${String(budget.remaining ?? "unknown")} of ${String(budget.limit ?? "unknown")}\n\n## Verification Votes\n\n${verifierLines}\n`;
}

export async function writePrReviewEvidence(
  client: HomeRailClient,
  runId: string,
  outputDir: string,
  knownStatus?: Record<string, unknown>,
): Promise<PrReviewEvidence> {
  const status = knownStatus ?? responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/status`));
  const handoffResponse = await client.get(`/api/runs/${encodeURIComponent(runId)}/handoffs`);
  const handoffs = responseData(handoffResponse).handoffs;
  if (!Array.isArray(handoffs)) throw new Error("Manager returned no persisted handoffs for PR review");
  const records = handoffs.map((raw) => raw as Record<string, unknown>);
  const published = handoffs
    .slice()
    .reverse()
    .map((raw) => raw as Record<string, unknown>)
    .filter((raw) => ["publish", "publish_accepted", "publish_rejected"].includes(handoffNode(raw)))
    .map((raw) => parsePublishedReview(raw.content))
    .find((value): value is PublishedReview => Boolean(value));
  if (!published) throw new Error(`PR review run ${runId} has no published report handoff`);
  const budget = records
    .filter((raw) => handoffNode(raw) === "budget")
    .map((raw) => parseRecord(raw.content))
    .find((value): value is Record<string, unknown> => Boolean(value?.admitted));
  if (!budget) throw new Error(`PR review run ${runId} has no admitted budget evidence`);
  const draft = records
    .filter((raw) => handoffNode(raw) === "synthesize")
    .map((raw) => parseRecord(raw.content))
    .find((value): value is Record<string, unknown> => Boolean(value));
  if (!draft) throw new Error(`PR review run ${runId} has no synthesized draft evidence`);
  const voteNodes = new Set(["evidence_vote", "false_positive_vote", "coverage_vote"]);
  const votes = records
    .filter((raw) => voteNodes.has(handoffNode(raw)))
    .map((raw) => parseRecord(raw.content))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  if (new Set(votes.map((vote) => vote.voter)).size !== 3) {
    throw new Error(`PR review run ${runId} does not contain three independent verifier votes`);
  }
  const persistedQuorum = records
    .filter((raw) => handoffNode(raw) === "verification_quorum")
    .map((raw) => parseRecord(raw.content))
    .find((value): value is Record<string, unknown> => Boolean(value));
  if (!persistedQuorum) throw new Error(`PR review run ${runId} has no persisted verifier quorum`);
  assertReportIdentity(published.report, budget);
  assertFindingVerification(published.report, draft, votes);
  assertQuorumEvidence(published.report, published.quorum, persistedQuorum, votes);

  let metrics: Record<string, unknown> | null = null;
  try {
    metrics = responseData(await client.get(`/api/dag-status/${encodeURIComponent(runId)}/metrics`));
  } catch {
    // A report remains useful when an older Manager cannot provide metrics.
  }
  const runStatus = optionalString(status.status) ?? "unknown";
  const elapsed = runtimeMs(status);
  const markdown = markdownWithRuntime(published, runId, runStatus, elapsed, metrics, budget, votes);
  const target = path.resolve(outputDir);
  fs.mkdirSync(target, { recursive: true });
  const jsonPath = path.join(target, "report.json");
  const markdownPath = path.join(target, "report.md");
  const evidence: PrReviewEvidence = {
    run_id: runId,
    run_status: runStatus,
    runtime_ms: elapsed,
    report: published.report,
    quorum: published.quorum,
    verification: { votes, quorum: published.quorum },
    budget,
    metrics,
    artifacts: { json: jsonPath, markdown: markdownPath },
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  return evidence;
}

export function registerDagRunTemplateCommands(dag: Command, program: Command): void {
  dag
    .command("run-template <template>")
    .description("Resolve structured input, sync a tracked DAG template, and start a run")
    .requiredOption("--input <json>", "Structured template input JSON")
    .option("--profile <profile>", "Runtime profile id")
    .option("--setting-id <id>", "Database LLM setting id")
    .option("--run-id <id>", "Explicit run id")
    .option("--wait", "Wait for terminal status and materialize scenario evidence", false)
    .option("--timeout <sec>", "Wait timeout in seconds", "1800")
    .option("--interval <sec>", "Status poll interval in seconds", "2")
    .option("--output-dir <path>", "Evidence output directory")
    .action(async (template: string, opts: RunTemplateOptions) => {
      const global = program.opts<GlobalOpts>();
      try {
        const logicalInput = parseObject(opts.input, "--input");
        const normalizedTemplate = path.basename(template).replace(/\.(yaml|yml)(\.template)?$/, "");
        const client = getClient(global);
        const input = normalizedTemplate === "pr-review"
          ? manualRunEnvelope(await resolvePrReviewInput(logicalInput))
          : normalizedTemplate === "pr-closeout"
            ? manualCloseoutEnvelope(await resolvePrCloseoutInput(logicalInput, { client }))
            : logicalInput;
        const started = await startTemplateRun(client, template, input, opts);
        if (!opts.wait) {
          const output = { run_id: started.runId, workflow_id: started.workflowId, input };
          console.log(global.json ? JSON.stringify(output) : `Run started: ${started.runId}\nWorkflow: ${started.workflowId}`);
          return;
        }
        const status = await waitForTerminal(
          client,
          started.runId,
          positiveNumber(opts.timeout, "--timeout"),
          positiveNumber(opts.interval, "--interval"),
        );
        if (normalizedTemplate === "pr-closeout") {
          const evidence = await writePrCloseoutEvidence(
            client,
            started.runId,
            opts.outputDir ?? path.join("artifacts", "pr-closeout"),
            status,
          );
          console.log(global.json ? JSON.stringify(evidence) : fs.readFileSync((evidence.artifacts as { markdown: string }).markdown, "utf8"));
          return;
        }
        if (normalizedTemplate !== "pr-review") {
          console.log(global.json ? JSON.stringify(status) : `Run ${started.runId}: ${String(status.status ?? "unknown")}`);
          return;
        }
        const evidence = await writePrReviewEvidence(
          client,
          started.runId,
          opts.outputDir ?? path.join("artifacts", "pr-review"),
          status,
        );
        console.log(global.json ? JSON.stringify(evidence) : fs.readFileSync(evidence.artifacts.markdown, "utf8"));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dag
    .command("review-report <runId>")
    .description("Materialize Markdown and JSON evidence for a completed PR Review run")
    .option("--output-dir <path>", "Evidence output directory", path.join("artifacts", "pr-review"))
    .action(async (runId: string, opts: ReviewReportOptions) => {
      const global = program.opts<GlobalOpts>();
      try {
        const evidence = await writePrReviewEvidence(getClient(global), runId, opts.outputDir);
        console.log(global.json ? JSON.stringify(evidence) : fs.readFileSync(evidence.artifacts.markdown, "utf8"));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  dag
    .command("closeout-report <runId>")
    .description("Materialize Markdown and JSON evidence for a terminal PR Closeout run")
    .option("--output-dir <path>", "Evidence output directory", path.join("artifacts", "pr-closeout"))
    .action(async (runId: string, opts: ReviewReportOptions) => {
      const global = program.opts<GlobalOpts>();
      try {
        const evidence = await writePrCloseoutEvidence(getClient(global), runId, opts.outputDir);
        const artifacts = evidence.artifacts as { markdown: string };
        console.log(global.json ? JSON.stringify(evidence) : fs.readFileSync(artifacts.markdown, "utf8"));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}

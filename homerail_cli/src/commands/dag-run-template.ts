import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_PR_REVIEW_EXPECTED_USAGE,
  defaultPrReviewBudgetKey,
  isFullGitRevision,
} from "homerail-protocol";

import type { BaseResponse, HomeRailClient } from "../client.js";
import { getClient } from "../index.js";
import {
  manualCloseoutEnvelope,
  resolvePrCloseoutInput,
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
}

export interface ResolvedPrReviewInput {
  repo: string;
  pr: number;
  base: string;
  head: string;
  base_clone_url: string;
  head_clone_url: string;
  expected_usage: number;
  budget_key: string;
  title?: string;
  author?: string;
}

interface RunArtifactSummary {
  name: string;
  status: string;
  media_type?: string;
  required?: boolean;
  size_bytes?: number;
  sha256?: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_ARTIFACT_STATUSES = new Set(["ready", "failed", "skipped"]);

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

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function trustedCloneUrl(
  repository: Record<string, unknown> | undefined,
  expectedRepo: string | undefined,
  label: "base" | "head",
): { cloneUrl: string; origin: string } {
  const fullName = optionalString(repository?.full_name);
  if (!fullName || !REPO_PATTERN.test(fullName)) {
    throw new Error(`GitHub PR ${label} repository did not contain a valid full_name`);
  }
  if (expectedRepo && fullName.toLowerCase() !== expectedRepo.toLowerCase()) {
    throw new Error(`GitHub PR ${label} repository does not match ${expectedRepo}`);
  }
  const raw = optionalString(repository?.clone_url);
  let parsed: URL;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    throw new Error(`GitHub PR ${label} repository did not contain a valid clone_url`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== `/${fullName}.git`
  ) {
    throw new Error(`GitHub PR ${label} clone_url must be credential-free HTTPS for ${fullName}`);
  }
  return { cloneUrl: parsed.toString(), origin: parsed.origin };
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
    apiBaseUrl?: string;
  } = {},
): Promise<ResolvedPrReviewInput> {
  const repo = optionalString(input.repo);
  const pr = Number(input.pr);
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error("pr-review input.repo must be owner/name");
  if (!Number.isInteger(pr) || pr < 1) throw new Error("pr-review input.pr must be a positive integer");

  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const apiBaseUrl = (options.apiBaseUrl ?? env.HOMERAIL_GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const response = await fetchImpl(`${apiBaseUrl}/repos/${repo}/pulls/${pr}`, {
    headers: githubHeaders(env),
  });
  if (!response.ok) throw new Error(`GitHub PR lookup failed: HTTP ${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  const baseRecord = optionalRecord(data.base);
  const headRecord = optionalRecord(data.head);
  const userRecord = optionalRecord(data.user);
  const baseRepository = trustedCloneUrl(optionalRecord(baseRecord?.repo), repo, "base");
  const headRepository = trustedCloneUrl(optionalRecord(headRecord?.repo), undefined, "head");
  if (headRepository.origin !== baseRepository.origin) {
    throw new Error("GitHub PR base/head clone URLs must use the same origin");
  }

  const base = optionalString(input.base) ?? optionalString(baseRecord?.sha);
  const head = optionalString(input.head) ?? optionalString(headRecord?.sha);
  const title = optionalString(input.title) ?? optionalString(data.title);
  const author = optionalString(input.author) ?? optionalString(userRecord?.login);
  if (!isFullGitRevision(base)) throw new Error("pr-review base must be a full commit SHA");
  if (!isFullGitRevision(head)) throw new Error("pr-review head must be a full commit SHA");

  const expectedUsage = input.expected_usage === undefined
    ? DEFAULT_PR_REVIEW_EXPECTED_USAGE
    : Number(input.expected_usage);
  if (!Number.isFinite(expectedUsage) || expectedUsage < 0 || expectedUsage > 100) {
    throw new Error("pr-review expected_usage must be between 0 and 100");
  }
  return {
    repo,
    pr,
    base,
    head,
    base_clone_url: baseRepository.cloneUrl,
    head_clone_url: headRepository.cloneUrl,
    expected_usage: expectedUsage,
    budget_key: optionalString(input.budget_key) ?? defaultPrReviewBudgetKey(repo, options.now),
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
): Promise<{ runId: string; workflowId: string }> {
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
  return { runId, workflowId };
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
  throw new Error(`timed out waiting for DAG run ${runId}; last status: ${String(last.status ?? "unknown")}`);
}

async function listRunArtifacts(client: HomeRailClient, runId: string): Promise<RunArtifactSummary[]> {
  const response = await client.get(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  const artifacts = responseData(response).artifacts;
  return Array.isArray(artifacts)
    ? artifacts.filter((item): item is RunArtifactSummary => Boolean(item && typeof item === "object"))
    : [];
}

async function waitForArtifacts(
  client: HomeRailClient,
  runId: string,
  timeoutSeconds: number,
  intervalSeconds: number,
): Promise<RunArtifactSummary[]> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let last: RunArtifactSummary[] = [];
  while (Date.now() <= deadline) {
    last = await listRunArtifacts(client, runId);
    if (last.length === 0 || last.every((artifact) => TERMINAL_ARTIFACT_STATUSES.has(artifact.status))) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
  }
  const pending = last.filter((artifact) => !TERMINAL_ARTIFACT_STATUSES.has(artifact.status)).map((artifact) => artifact.name);
  throw new Error(`timed out waiting for DAG artifacts for ${runId}: ${pending.join(", ") || "unknown"}`);
}

function printTerminalSummary(
  runId: string,
  workflowId: string,
  status: Record<string, unknown>,
  artifacts: RunArtifactSummary[],
  json: boolean,
): void {
  const output = {
    run_id: runId,
    workflow_id: workflowId,
    status: String(status.status ?? "unknown"),
    artifacts,
  };
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }
  const lines = [`Run ${runId}: ${output.status}`, `Workflow: ${workflowId}`];
  if (artifacts.length === 0) {
    lines.push("Artifacts: none declared");
  } else {
    lines.push("Artifacts:");
    for (const artifact of artifacts) lines.push(`  ${artifact.status.padEnd(8)} ${artifact.name}`);
    lines.push(`Retrieve with: hr dag artifact ${runId} <name> --output <path>`);
  }
  console.log(lines.join("\n"));
}

export function registerDagRunTemplateCommands(dag: Command, program: Command): void {
  dag
    .command("run-template <template>")
    .description("Resolve structured input, sync a tracked DAG template, and start a run")
    .requiredOption("--input <json>", "Structured template input JSON")
    .option("--profile <profile>", "Runtime profile id")
    .option("--setting-id <id>", "Database LLM setting id")
    .option("--run-id <id>", "Explicit run id")
    .option("--wait", "Wait for terminal status and declared artifacts", false)
    .option("--timeout <sec>", "Wait timeout in seconds", "1800")
    .option("--interval <sec>", "Status poll interval in seconds", "2")
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
        const timeout = positiveNumber(opts.timeout, "--timeout");
        const interval = positiveNumber(opts.interval, "--interval");
        const status = await waitForTerminal(client, started.runId, timeout, interval);
        const artifacts = await waitForArtifacts(client, started.runId, timeout, interval);
        printTerminalSummary(started.runId, started.workflowId, status, artifacts, Boolean(global.json));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });
}

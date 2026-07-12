import * as fs from "node:fs";
import * as path from "node:path";

import type { HomeRailClient } from "../client.js";

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCEPTED_CHECK_CONCLUSIONS = new Set(["success", "neutral"]);

export interface PrCloseoutEvidence {
  source: "local" | "homerail_run";
  name: string;
  head: string;
  status: string;
  fresh: boolean;
  platform?: string;
  command?: string;
  run_id?: string;
  kind?: string;
  report_status?: string;
  actionable_count?: number;
  validated?: boolean;
}

export interface ResolvedPrCloseoutInput {
  repo: string;
  pr: number;
  base: string;
  head: string;
  phase: "draft" | "merge";
  closeout_status: "ready_for_review" | "ready_for_human_merge_candidate" | "blocked" | "stale_evidence";
  blockers: Array<{ code: string; message: string }>;
  evidence: PrCloseoutEvidence[];
  github: Record<string, unknown>;
}

interface ResolveOptions {
  client?: HomeRailClient;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  apiBaseUrl?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "HomeRail-PR-Closeout",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  endpoint: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${baseUrl}${endpoint}`, { headers: githubHeaders(env) });
  if (!response.ok) throw new Error(`GitHub closeout lookup failed for ${endpoint}: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function githubReviewThreads(
  fetchImpl: typeof fetch,
  baseUrl: string,
  repo: string,
  pr: number,
  env: NodeJS.ProcessEnv,
): Promise<{ verified: boolean; unresolved: number | null }> {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (!token) return { verified: false, unresolved: null };
  const [owner, name] = repo.split("/");
  const response = await fetchImpl(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { ...githubHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}",
      variables: { owner, name, number: pr },
    }),
  });
  if (!response.ok) return { verified: false, unresolved: null };
  const body = await response.json() as Record<string, unknown>;
  if (Array.isArray(body.errors) && body.errors.length > 0) return { verified: false, unresolved: null };
  const data = body.data as Record<string, unknown> | undefined;
  const repository = data?.repository as Record<string, unknown> | undefined;
  const pullRequest = repository?.pullRequest as Record<string, unknown> | undefined;
  const threads = pullRequest?.reviewThreads as Record<string, unknown> | undefined;
  const nodes = Array.isArray(threads?.nodes) ? threads.nodes as Record<string, unknown>[] : undefined;
  return nodes
    ? { verified: true, unresolved: nodes.filter((node) => node.isResolved !== true).length }
    : { verified: false, unresolved: null };
}

function requiredPlatforms(files: string[], explicit: unknown): string[] {
  const required = new Set<string>(["linux"]);
  if (Array.isArray(explicit)) {
    for (const value of explicit) {
      if (typeof value !== "string" || !value.trim()) throw new Error("pr-closeout required_platforms must contain strings");
      required.add(value.trim().toLowerCase());
    }
  } else if (explicit !== undefined) {
    throw new Error("pr-closeout required_platforms must be an array");
  }
  for (const file of files.map((value) => value.toLowerCase())) {
    if (/(^|\/)(electron|desktop|windows|win32)(\/|\.|$)/.test(file)) required.add("windows");
    if (/(^|\/)(electron|desktop|macos|darwin)(\/|\.|$)/.test(file)) required.add("macos");
    if (/(dockerfile|docker-compose|^docker\/|\/docker\/)/.test(file)) required.add("docker");
  }
  return [...required].sort();
}

function responseData(response: unknown): Record<string, unknown> {
  const data = (response as { data?: unknown }).data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
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

function findHead(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHead(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = optionalString(record.head);
  if (direct && SHA_PATTERN.test(direct)) return direct;
  for (const nested of Object.values(record)) {
    const found = findHead(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function hasValidationPass(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => hasValidationPass(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.validation_status === "passed" || record.validation_status === "pass") return true;
  if (record.status === "passed" || record.status === "pass") return true;
  return Object.values(record).some((item) => hasValidationPass(item, depth + 1));
}

async function resolveRunEvidence(client: HomeRailClient, runId: string, currentHead: string): Promise<PrCloseoutEvidence> {
  const status = responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/status`));
  const handoffData = responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/handoffs`));
  const handoffs = Array.isArray(handoffData.handoffs)
    ? handoffData.handoffs.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const head = findHead(handoffs) ?? "unknown";
  const published = handoffs
    .slice()
    .reverse()
    .map((handoff) => parseRecord(handoff.content))
    .find((content) => parseRecord(content?.report));
  const report = parseRecord(published?.report);
  const validated = Boolean(report) || hasValidationPass(handoffs);
  return {
    source: "homerail_run",
    name: `HomeRail run ${runId}`,
    run_id: runId,
    head,
    status: String(status.status ?? "unknown"),
    fresh: head === currentHead,
    validated,
    kind: report ? "pr_review" : "dag_validation",
    ...(report ? {
      report_status: String(report.status ?? "unknown"),
      actionable_count: Number(report.actionable_count ?? 0),
    } : {}),
  };
}

function resolveLocalEvidence(value: unknown, currentHead: string): PrCloseoutEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("pr-closeout local_evidence must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`pr-closeout local_evidence[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const name = optionalString(record.name);
    const head = optionalString(record.head);
    const status = optionalString(record.status);
    if (!name || !head || !SHA_PATTERN.test(head) || !status) {
      throw new Error(`pr-closeout local_evidence[${index}] requires name, commit head, and status`);
    }
    return {
      source: "local",
      name,
      head,
      status,
      fresh: head === currentHead,
      ...(optionalString(record.platform) ? { platform: optionalString(record.platform) } : {}),
      ...(optionalString(record.command) ? { command: optionalString(record.command) } : {}),
    };
  });
}

function latestReviewStates(reviews: Record<string, unknown>[]): Record<string, string> {
  const latest: Record<string, string> = {};
  for (const review of reviews) {
    const user = review.user as Record<string, unknown> | undefined;
    const login = optionalString(user?.login);
    const state = optionalString(review.state)?.toUpperCase();
    if (login && state && state !== "COMMENTED" && state !== "PENDING") latest[login] = state;
  }
  return latest;
}

export async function resolvePrCloseoutInput(
  input: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ResolvedPrCloseoutInput> {
  const repo = optionalString(input.repo);
  const pr = Number(input.pr);
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error("pr-closeout input.repo must be owner/name");
  if (!Number.isInteger(pr) || pr < 1) throw new Error("pr-closeout input.pr must be a positive integer");

  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const apiBaseUrl = (options.apiBaseUrl ?? env.HOMERAIL_GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const [owner] = repo.split("/");
  const repository = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}`, env);
  const pull = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}/pulls/${pr}`, env);
  const baseRecord = pull.base as Record<string, unknown> | undefined;
  const headRecord = pull.head as Record<string, unknown> | undefined;
  const base = optionalString(baseRecord?.sha);
  const head = optionalString(headRecord?.sha);
  const baseRef = optionalString(baseRecord?.ref) ?? "";
  const defaultBranch = optionalString(repository.default_branch) ?? "main";
  if (!base || !SHA_PATTERN.test(base) || !head || !SHA_PATTERN.test(head)) {
    throw new Error("GitHub PR response did not contain immutable base/head SHAs");
  }

  const checksResponse = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}/commits/${head}/check-runs?per_page=100`, env);
  const statusesResponse = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}/commits/${head}/status`, env);
  const reviewsResponse = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}/pulls/${pr}/reviews?per_page=100`, env);
  const filesResponse = await githubJson(fetchImpl, apiBaseUrl, `/repos/${repo}/pulls/${pr}/files?per_page=100`, env);
  const reviewThreads = await githubReviewThreads(fetchImpl, apiBaseUrl, repo, pr, env);
  const checks = Array.isArray(checksResponse.check_runs)
    ? checksResponse.check_runs.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const statuses = Array.isArray(statusesResponse.statuses)
    ? statusesResponse.statuses.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : [];
  const reviews = Array.isArray(reviewsResponse)
    ? reviewsResponse as unknown as Record<string, unknown>[]
    : Array.isArray(reviewsResponse.items)
      ? reviewsResponse.items as Record<string, unknown>[]
      : [];
  const changedFiles = (Array.isArray(filesResponse) ? filesResponse : Array.isArray(filesResponse.items) ? filesResponse.items : [])
    .map((item) => optionalString((item as Record<string, unknown>).filename))
    .filter((item): item is string => Boolean(item));
  const platforms = requiredPlatforms(changedFiles, input.required_platforms);

  let dependency: Record<string, unknown> | null = null;
  if (baseRef && baseRef !== defaultBranch) {
    const dependencies = await githubJson(
      fetchImpl,
      apiBaseUrl,
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${baseRef}`)}&per_page=100`,
      env,
    );
    const items = Array.isArray(dependencies) ? dependencies : Array.isArray(dependencies.items) ? dependencies.items : [];
    dependency = (items as Record<string, unknown>[]).find((item) => Number(item.number) !== pr) ?? null;
  }

  const phaseInput = optionalString(input.phase);
  if (phaseInput && phaseInput !== "draft" && phaseInput !== "merge") {
    throw new Error("pr-closeout phase must be draft or merge");
  }
  const isDraft = pull.draft === true;
  const phase = (phaseInput ?? (isDraft ? "draft" : "merge")) as "draft" | "merge";
  const runIds = input.validation_runs === undefined ? [] : input.validation_runs;
  if (!Array.isArray(runIds) || runIds.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("pr-closeout validation_runs must be an array of run ids");
  }
  const runEvidence = options.client
    ? await Promise.all(runIds.map((runId) => resolveRunEvidence(options.client!, runId.trim(), head)))
    : [];
  if (!options.client && runIds.length > 0) throw new Error("pr-closeout cannot resolve validation_runs without a Manager client");
  const evidence = [...resolveLocalEvidence(input.local_evidence, head), ...runEvidence];
  const blockers: Array<{ code: string; message: string }> = [];
  const requestedBase = optionalString(input.base);
  const requestedHead = optionalString(input.head);
  if ((requestedBase && requestedBase !== base) || (requestedHead && requestedHead !== head)) {
    blockers.push({ code: "pr_identity_drift", message: "The PR base or head changed after closeout was requested." });
  }
  if (phase === "draft" && !isDraft) {
    blockers.push({ code: "phase_mismatch", message: "The PR is no longer a Draft; run merge closeout instead." });
  }
  const freshPassed = evidence.filter((item) =>
    item.fresh && (item.source === "local" ? item.status === "passed" : item.status === "completed" && item.validated === true)
  );
  if (freshPassed.length === 0) {
    blockers.push({ code: "validation_evidence_missing", message: "No passing validation evidence is bound to the current PR head." });
  }

  const relevantChecks = checks.filter((check) => !/PR Closeout/i.test(String(check.name ?? "")));
  const pendingChecks = relevantChecks.filter((check) => String(check.status ?? "") !== "completed");
  const failedChecks = relevantChecks.filter((check) =>
    String(check.status ?? "") === "completed" && !ACCEPTED_CHECK_CONCLUSIONS.has(String(check.conclusion ?? ""))
  );
  const failedStatuses = statuses.filter((status) => String(status.state ?? "") !== "success");
  const reviewStates = latestReviewStates(reviews);
  const changesRequested = Object.entries(reviewStates).filter(([, state]) => state === "CHANGES_REQUESTED").map(([login]) => login);
  const mergeableState = String(pull.mergeable_state ?? "unknown");

  if (phase === "merge") {
    if (isDraft) blockers.push({ code: "pr_is_draft", message: "The PR must leave draft before merge closeout." });
    if (dependency) blockers.push({ code: "dependency_open", message: `Stacked dependency PR #${String(dependency.number)} is still open.` });
    if (pull.mergeable !== true || ["dirty", "blocked", "unknown"].includes(mergeableState)) {
      blockers.push({ code: "not_mergeable", message: `GitHub reports mergeable=${String(pull.mergeable)} and state=${mergeableState}.` });
    }
    if (relevantChecks.length === 0) blockers.push({ code: "checks_missing", message: "No GitHub checks exist for the current head." });
    if (pendingChecks.length > 0) blockers.push({ code: "checks_pending", message: `${pendingChecks.length} GitHub checks are still pending.` });
    if (failedChecks.length > 0 || failedStatuses.length > 0) {
      blockers.push({ code: "checks_failed", message: "At least one GitHub check or commit status is not successful." });
    }
    if (changesRequested.length > 0) {
      blockers.push({ code: "changes_requested", message: `Changes are still requested by: ${changesRequested.join(", ")}.` });
    }
    if (!reviewThreads.verified) {
      blockers.push({ code: "review_threads_unverified", message: "Unresolved review threads could not be verified with the GitHub GraphQL API." });
    } else if ((reviewThreads.unresolved ?? 0) > 0) {
      blockers.push({ code: "review_threads_open", message: `${reviewThreads.unresolved} review threads remain unresolved.` });
    }
    const observedPlatforms = new Set<string>();
    for (const item of evidence) if (item.platform) observedPlatforms.add(item.platform.toLowerCase());
    for (const check of relevantChecks) {
      const name = String(check.name ?? "").toLowerCase();
      for (const platform of platforms) if (name.includes(platform)) observedPlatforms.add(platform);
      if (name.includes("windows")) observedPlatforms.add("windows");
      if (name.includes("macos") || name.includes("mac os")) observedPlatforms.add("macos");
      if (name.includes("docker")) observedPlatforms.add("docker");
      if (name.includes("linux")) observedPlatforms.add("linux");
    }
    const missingPlatforms = platforms.filter((platform) => !observedPlatforms.has(platform));
    if (missingPlatforms.length > 0) {
      blockers.push({ code: "platform_evidence_missing", message: `Missing required platform evidence: ${missingPlatforms.join(", ")}.` });
    }
    const prReview = evidence.find((item) =>
      item.fresh && item.kind === "pr_review" && item.status === "completed" && item.report_status === "pass" && item.actionable_count === 0
    );
    if (!prReview) {
      blockers.push({ code: "pr_review_missing", message: "No conclusive zero-finding HomeRail PR Review is bound to the current head." });
    }
  }

  const staleOnly = evidence.length > 0 && evidence.every((item) => !item.fresh);
  const closeoutStatus = staleOnly
    ? "stale_evidence"
    : blockers.length > 0
      ? "blocked"
      : phase === "draft"
        ? "ready_for_review"
        : "ready_for_human_merge_candidate";
  return {
    repo,
    pr,
    base,
    head,
    phase,
    closeout_status: closeoutStatus,
    blockers,
    evidence,
    github: {
      draft: isDraft,
      mergeable: pull.mergeable ?? null,
      mergeable_state: mergeableState,
      base_ref: baseRef,
      default_branch: defaultBranch,
      dependency: dependency ? { number: dependency.number, title: dependency.title, state: dependency.state } : null,
      checks: relevantChecks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion })),
      statuses: statuses.map((status) => ({ context: status.context, state: status.state })),
      review_states: reviewStates,
      review_threads: reviewThreads,
      changed_files: changedFiles,
      required_platforms: platforms,
    },
  };
}

export function manualCloseoutEnvelope(input: ResolvedPrCloseoutInput): Record<string, unknown> {
  return {
    trigger_id: "manual",
    trigger_type: "manual",
    fire_key: `pr-closeout:${input.repo}#${input.pr}:${input.head}:${input.phase}`,
    payload: input,
  };
}

export async function writePrCloseoutEvidence(
  client: HomeRailClient,
  runId: string,
  outputDir: string,
  status?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const runStatus = status ?? responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/status`));
  const handoffData = responseData(await client.get(`/api/runs/${encodeURIComponent(runId)}/handoffs`));
  const handoffs = Array.isArray(handoffData.handoffs) ? handoffData.handoffs as Record<string, unknown>[] : [];
  const routed = handoffs.find((handoff) => String(handoff.fromNode ?? handoff.from_node ?? "") === "status_gate");
  const envelope = parseRecord(routed?.content);
  const snapshot = parseRecord(envelope?.payload) ?? envelope;
  if (!snapshot || !optionalString(snapshot.closeout_status)) {
    throw new Error(`PR closeout run ${runId} has no authoritative status handoff`);
  }
  const approval = handoffs
    .filter((handoff) => String(handoff.fromNode ?? handoff.from_node ?? "") === "merge_approval")
    .map((handoff) => parseRecord(handoff.content))
    .find(Boolean) ?? null;
  const evidence = {
    run_id: runId,
    run_status: String(runStatus.status ?? "unknown"),
    closeout_status: snapshot.closeout_status,
    repo: snapshot.repo,
    pr: snapshot.pr,
    base: snapshot.base,
    head: snapshot.head,
    phase: snapshot.phase,
    blockers: snapshot.blockers,
    validation_evidence: snapshot.evidence,
    github: snapshot.github,
    approval,
    merge_performed: false,
  };
  const blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers as Record<string, unknown>[] : [];
  const markdown = `# HomeRail PR Closeout\n\n` +
    `- PR: ${String(snapshot.repo)}#${String(snapshot.pr)}\n` +
    `- Head: \`${String(snapshot.head)}\`\n` +
    `- Phase: \`${String(snapshot.phase)}\`\n` +
    `- Result: **${String(snapshot.closeout_status)}**\n` +
    `- Run: \`${runId}\`\n` +
    `- Merge performed: no\n\n` +
    `## Blockers\n\n` +
    (blockers.length === 0 ? "None.\n" : blockers.map((item) => `- \`${String(item.code)}\`: ${String(item.message)}`).join("\n") + "\n");
  const target = path.resolve(outputDir);
  fs.mkdirSync(target, { recursive: true });
  const jsonPath = path.join(target, "closeout.json");
  const markdownPath = path.join(target, "closeout.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  return { ...evidence, artifacts: { json: jsonPath, markdown: markdownPath } };
}

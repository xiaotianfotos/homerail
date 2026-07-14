/**
 * Pure validation for HomeRail PR Review evidence consumed by PR closeout.
 *
 * The caller owns Manager I/O. This module deliberately accepts already-loaded
 * run metadata and handoffs so the CLI and Worker share one evidence boundary.
 * @version 0.1.0
 */

import { isFullGitRevision } from "./pr-review.js";

const REVIEW_STATUSES = new Set(["pass", "findings", "inconclusive"]);
const REVIEW_CONFIDENCE = new Set(["high", "medium", "low"]);
const REVIEWER_IDS = new Set(["runtime", "security", "tests", "frontend"]);

export interface PrReviewCloseoutIdentity {
  repo: string;
  pr: number;
  base: string;
  head: string;
}

export interface PrReviewCloseoutHandoff {
  fromNode?: unknown;
  from_node?: unknown;
  port?: unknown;
  content?: unknown;
}

export interface PrReviewCloseoutEvidenceInput {
  metadata: Record<string, unknown>;
  handoffs: PrReviewCloseoutHandoff[];
  expected: PrReviewCloseoutIdentity;
}

export interface PrReviewCloseoutValidation {
  recognized: boolean;
  valid: boolean;
  passed: boolean;
  head: string;
  report_status?: string;
  actionable_count?: number;
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalid(
  error: string,
  options: {
    recognized?: boolean;
    head?: string;
    reportStatus?: string;
    actionableCount?: number;
  } = {},
): PrReviewCloseoutValidation {
  return {
    recognized: options.recognized ?? true,
    valid: false,
    passed: false,
    head: options.head ?? "unknown",
    ...(options.reportStatus === undefined ? {} : { report_status: options.reportStatus }),
    ...(options.actionableCount === undefined ? {} : { actionable_count: options.actionableCount }),
    error,
  };
}

function publishedHandoff(handoff: PrReviewCloseoutHandoff): boolean {
  const fromNode = handoff.fromNode ?? handoff.from_node;
  return fromNode === "publish" && handoff.port === "published";
}

/**
 * Validate the exact persisted artifact handoff produced by the built-in
 * `pr-review` workflow. No recursive key discovery or implicit defaults are
 * allowed: provenance, PR identity, report fields, and quorum must all agree.
 */
export function validatePrReviewCloseoutEvidence(
  input: PrReviewCloseoutEvidenceInput,
): PrReviewCloseoutValidation {
  const workflowId = input.metadata.workflowId ?? input.metadata.workflow_id;
  if (workflowId !== "pr-review") {
    return invalid("run workflow_id is not pr-review", { recognized: false });
  }

  const handoff = input.handoffs.slice().reverse().find(publishedHandoff);
  if (!handoff) return invalid("pr-review publish.published handoff is missing");

  const publication = record(handoff.content);
  if (!publication) return invalid("pr-review published handoff must contain one JSON object");
  const report = record(publication.report);
  if (!report) return invalid("pr-review published handoff is missing report");

  const reportHead = isFullGitRevision(report.head)
    ? report.head
    : "unknown";
  const reportStatus = typeof report.status === "string" ? report.status : undefined;
  const actionableCount = Number.isInteger(report.actionable_count) && Number(report.actionable_count) >= 0
    ? Number(report.actionable_count)
    : undefined;
  const partial = {
    head: reportHead,
    ...(reportStatus === undefined ? {} : { reportStatus }),
    ...(actionableCount === undefined ? {} : { actionableCount }),
  };

  if (report.repo !== input.expected.repo || report.pr !== input.expected.pr) {
    return invalid("pr-review report repository identity does not match the closeout request", partial);
  }
  if (report.base !== input.expected.base || report.head !== input.expected.head) {
    return invalid("pr-review report base/head does not match the current pull request", partial);
  }
  if (!isFullGitRevision(input.expected.base) || !isFullGitRevision(input.expected.head)) {
    return invalid("closeout expected base/head must be full Git revisions", partial);
  }
  if (!reportStatus || !REVIEW_STATUSES.has(reportStatus)) {
    return invalid("pr-review report status is missing or invalid", partial);
  }
  if (!nonEmptyString(report.summary) || !REVIEW_CONFIDENCE.has(String(report.confidence))) {
    return invalid("pr-review report summary or confidence is invalid", partial);
  }
  if (actionableCount === undefined) {
    return invalid("pr-review report actionable_count must be an explicit non-negative integer", partial);
  }
  if (!Array.isArray(report.findings) || report.findings.length !== actionableCount) {
    return invalid("pr-review findings must match actionable_count", partial);
  }
  if (!Array.isArray(report.reviewer_results) || report.reviewer_results.length !== 4) {
    return invalid("pr-review report must contain exactly four reviewer_results", partial);
  }
  const reviewerIds = new Set<string>();
  for (const item of report.reviewer_results) {
    const reviewer = record(item);
    if (
      !reviewer ||
      typeof reviewer.reviewer !== "string" ||
      !REVIEWER_IDS.has(reviewer.reviewer) ||
      (reviewer.status !== "complete" && reviewer.status !== "failed") ||
      !nonEmptyString(reviewer.summary) ||
      !Array.isArray(reviewer.findings)
    ) {
      return invalid("pr-review reviewer_results contains an invalid reviewer result", partial);
    }
    reviewerIds.add(reviewer.reviewer);
  }
  if (reviewerIds.size !== REVIEWER_IDS.size) {
    return invalid("pr-review reviewer_results must cover four distinct review categories", partial);
  }
  if (!nonEmptyString(publication.markdown)) {
    return invalid("pr-review published markdown is missing", partial);
  }

  const quorum = record(publication.quorum);
  if (!quorum) return invalid("pr-review published quorum is missing", partial);
  const successes = quorum.successes;
  if (
    typeof quorum.passed !== "boolean" ||
    !Number.isInteger(successes) ||
    Number(successes) < 0 ||
    Number(successes) > 3 ||
    quorum.total !== 3 ||
    quorum.threshold !== 2 ||
    quorum.passed !== (Number(successes) >= 2)
  ) {
    return invalid("pr-review published quorum is inconsistent", partial);
  }
  if (quorum.passed === false && reportStatus !== "inconclusive") {
    return invalid("a rejected pr-review quorum must publish an inconclusive report", partial);
  }
  if (reportStatus === "pass" && actionableCount !== 0) {
    return invalid("a passing pr-review report must have zero actionable findings", partial);
  }
  if (reportStatus === "findings" && actionableCount === 0) {
    return invalid("a findings pr-review report must contain actionable findings", partial);
  }
  if (
    reportStatus === "pass" &&
    report.reviewer_results.some((item) => record(item)?.status !== "complete")
  ) {
    return invalid("a passing pr-review report cannot contain a failed reviewer", partial);
  }

  return {
    recognized: true,
    valid: true,
    passed: reportStatus === "pass" && actionableCount === 0 && quorum.passed === true,
    head: reportHead,
    report_status: reportStatus,
    actionable_count: actionableCount,
  };
}

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
  evidence_valid?: boolean;
  validated?: boolean;
  validation_error?: string;
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

export interface PrCloseoutRunSnapshot {
  metadata: Record<string, unknown>;
  status: Record<string, unknown>;
  handoffs: PrReviewCloseoutHandoff[];
}

export interface PrCloseoutResolverAdapter {
  github(pathname: string): Promise<unknown>;
  reviewThreads(repo: string, pr: number): Promise<{ verified: boolean; unresolved: number | null }>;
  run?: (runId: string) => Promise<PrCloseoutRunSnapshot>;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCEPTED_CHECK_CONCLUSIONS = new Set(["success", "neutral"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function responseRecords(value: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return records(value);
  const body = record(value);
  return records(body?.[key]);
}

function requiredPlatforms(files: string[], explicit: unknown): string[] {
  const required = new Set<string>(["linux"]);
  if (Array.isArray(explicit)) {
    for (const value of explicit) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error("pr-closeout required_platforms must contain strings");
      }
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

function localEvidence(value: unknown, currentHead: string): PrCloseoutEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("pr-closeout local_evidence must be an array");
  return value.map((item, index) => {
    const evidence = record(item);
    const name = optionalString(evidence?.name);
    const head = optionalString(evidence?.head);
    const status = optionalString(evidence?.status);
    if (!name || !isFullGitRevision(head) || !status) {
      throw new Error(`pr-closeout local_evidence[${index}] requires name, commit head, and status`);
    }
    const platform = optionalString(evidence?.platform);
    const command = optionalString(evidence?.command);
    return {
      source: "local" as const,
      name,
      head,
      status,
      fresh: head === currentHead,
      ...(platform ? { platform } : {}),
      ...(command ? { command } : {}),
    };
  });
}

function latestReviewStates(reviews: Record<string, unknown>[]): Record<string, string> {
  const latest: Record<string, string> = {};
  for (const review of reviews) {
    const user = record(review.user);
    const login = optionalString(user?.login);
    const state = optionalString(review.state)?.toUpperCase();
    if (login && state && state !== "COMMENTED" && state !== "PENDING") latest[login] = state;
  }
  return latest;
}

async function runEvidence(
  adapter: PrCloseoutResolverAdapter,
  runId: string,
  expected: PrReviewCloseoutIdentity,
): Promise<PrCloseoutEvidence> {
  if (!adapter.run) throw new Error("pr-closeout cannot resolve validation_runs without a Manager client");
  const snapshot = await adapter.run(runId);
  const validation = validatePrReviewCloseoutEvidence({
    metadata: snapshot.metadata,
    handoffs: snapshot.handoffs,
    expected,
  });
  return {
    source: "homerail_run",
    name: `HomeRail run ${runId}`,
    run_id: runId,
    head: validation.head,
    status: String(snapshot.status.status ?? "unknown"),
    fresh: validation.head === expected.head,
    evidence_valid: validation.valid,
    validated: validation.passed,
    kind: validation.recognized ? "pr_review" : "unrecognized_run",
    ...(validation.report_status === undefined ? {} : { report_status: validation.report_status }),
    ...(validation.actionable_count === undefined ? {} : { actionable_count: validation.actionable_count }),
    ...(validation.error ? { validation_error: validation.error } : {}),
  };
}

/**
 * Resolve one deterministic closeout snapshot from injected GitHub and Manager
 * adapters. Both the CLI and Manager Agent use this exact blocker matrix.
 */
export async function resolvePrCloseout(
  input: Record<string, unknown>,
  adapter: PrCloseoutResolverAdapter,
): Promise<ResolvedPrCloseoutInput> {
  const repo = optionalString(input.repo);
  const pr = Number(input.pr);
  if (!repo || !REPO_PATTERN.test(repo)) throw new Error("pr-closeout input.repo must be owner/name");
  if (!Number.isInteger(pr) || pr < 1) throw new Error("pr-closeout input.pr must be a positive integer");
  const phaseInput = optionalString(input.phase);
  if (phaseInput && phaseInput !== "draft" && phaseInput !== "merge") {
    throw new Error("pr-closeout phase must be draft or merge");
  }
  const rawRunIds = input.validation_runs ?? [];
  if (!Array.isArray(rawRunIds) || rawRunIds.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("pr-closeout validation_runs must be an array of run ids");
  }
  const runIds = rawRunIds.map((value) => String(value).trim());

  const repository = record(await adapter.github(`/repos/${repo}`)) ?? {};
  const pull = record(await adapter.github(`/repos/${repo}/pulls/${pr}`)) ?? {};
  const baseRecord = record(pull.base);
  const headRecord = record(pull.head);
  const base = optionalString(baseRecord?.sha);
  const head = optionalString(headRecord?.sha);
  const baseRef = optionalString(baseRecord?.ref) ?? "";
  const defaultBranch = optionalString(repository.default_branch) ?? "main";
  if (!isFullGitRevision(base) || !isFullGitRevision(head)) {
    throw new Error("GitHub PR response did not contain immutable base/head SHAs");
  }

  const [checksBody, statusesBody, reviewsBody, filesBody, reviewThreads] = await Promise.all([
    adapter.github(`/repos/${repo}/commits/${head}/check-runs?per_page=100`),
    adapter.github(`/repos/${repo}/commits/${head}/status`),
    adapter.github(`/repos/${repo}/pulls/${pr}/reviews?per_page=100`),
    adapter.github(`/repos/${repo}/pulls/${pr}/files?per_page=100`),
    adapter.reviewThreads(repo, pr),
  ]);
  const checks = responseRecords(checksBody, "check_runs");
  const statuses = responseRecords(statusesBody, "statuses");
  const reviews = responseRecords(reviewsBody, "items");
  const fileRecords = responseRecords(filesBody, "items");
  const changedFiles = fileRecords
    .map((item) => optionalString(item.filename))
    .filter((item): item is string => Boolean(item));
  const platforms = requiredPlatforms(changedFiles, input.required_platforms);

  let dependency: Record<string, unknown> | null = null;
  if (baseRef && baseRef !== defaultBranch) {
    const [owner] = repo.split("/");
    const dependencies = await adapter.github(
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${baseRef}`)}&per_page=100`,
    );
    dependency = responseRecords(dependencies, "items").find((item) => Number(item.number) !== pr) ?? null;
  }

  const isDraft = pull.draft === true;
  const phase = (phaseInput ?? (isDraft ? "draft" : "merge")) as "draft" | "merge";
  const expected = { repo, pr, base, head };
  const persistedEvidence = await Promise.all(runIds.map((runId) => runEvidence(adapter, runId, expected)));
  const evidence = [...localEvidence(input.local_evidence, head), ...persistedEvidence];
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
    item.fresh && (item.source === "local"
      ? item.status === "passed"
      : item.status === "completed" && item.validated === true)
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
  const changesRequested = Object.entries(reviewStates)
    .filter(([, state]) => state === "CHANGES_REQUESTED")
    .map(([login]) => login);
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
      item.fresh && item.validated === true && item.kind === "pr_review" &&
      item.status === "completed" && item.report_status === "pass" && item.actionable_count === 0
    );
    if (!prReview) {
      blockers.push({ code: "pr_review_missing", message: "No conclusive zero-finding HomeRail PR Review is bound to the current head." });
    }
  }

  const recognizedEvidence = evidence.filter((item) => item.source === "local" || item.evidence_valid === true);
  const staleOnly = recognizedEvidence.length > 0 && recognizedEvidence.every((item) => !item.fresh);
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

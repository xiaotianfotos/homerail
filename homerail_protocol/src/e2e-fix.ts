/**
 * E2E Fix stage identity and final acceptance policy.
 * @version 0.1.0
 *
 * This is a pure policy check, NOT test execution attestation. Its caller must
 * load evidence from the trusted execution/review/publication stores, verify
 * bytes and provenance, and supply the frozen policy. Model handoffs must never
 * be accepted as this entire input. Passing means eligible for completion;
 * the durable Manager transition is responsible for committing that decision.
 */
import { z } from "zod";

const id = z.string().trim().min(1).max(300);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uniqueIds = z.array(id).min(1).max(100).refine(xs => new Set(xs).size === xs.length, "duplicate IDs");

export const E2eFixCandidateSchema = z.object({
  task_id: id,
  root_run_id: id,
  round: z.number().int().positive(),
  plan_sha256: digest,
  policy_sha256: digest,
  repo: z.string().regex(/^[^\s/]+\/[^\s/]+$/),
  base: revision,
  head: revision,
  tree: revision,
}).strict();
export type E2eFixCandidate = z.infer<typeof E2eFixCandidateSchema>;

export const E2eFixAcceptancePolicySchema = z.object({
  sha256: digest,
  required_tests: uniqueIds,
  required_ci_jobs: uniqueIds,
  ci_workflow_path: id,
  reviewer_ids: uniqueIds,
  review_approvals: z.number().int().min(2),
}).strict().refine(p => p.review_approvals <= p.reviewer_ids.length, "approval threshold exceeds reviewer count");

const bound = z.object({ candidate: E2eFixCandidateSchema, artifact_sha256: digest });
const test = bound.extend({
  check_id: id,
  execution_id: id,
  result: z.enum(["passed", "failed", "unknown", "interrupted"]),
  exit_code: z.number().int().nullable(),
  signal: id.nullable(),
}).strict();
const review = bound.extend({
  reviewer_id: id,
  dispatch_id: id,
  session_id: id,
  status: z.enum(["complete", "incomplete", "failed"]),
  vote: z.enum(["approve", "request_changes", "abstain"]),
  finding_ids: z.array(digest).max(100),
}).strict();
const disposition = z.object({
  finding_id: digest,
  action: z.enum(["dismiss", "revise", "escalate"]),
  reason: z.string().trim().min(1).max(8000),
  evidence_sha256: z.array(digest).min(1).max(20),
}).strict();

export const E2eFixAcceptanceInputSchema = z.object({
  candidate: E2eFixCandidateSchema,
  policy: E2eFixAcceptancePolicySchema,
  fixer_dispatch_id: id,
  fixer_session_id: id,
  tests: z.array(test).max(100),
  reviews: z.array(review).max(100),
  judgment: bound.extend({
    dispatch_id: id,
    session_id: id,
    verdict: z.enum(["accept", "revise", "pause"]),
    // Bind dispositions to the exact set of reports the Judger actually saw.
    review_artifact_sha256: z.array(digest).max(100),
    dispositions: z.array(disposition).max(300),
  }).strict(),
  publication: bound.extend({
    pr: z.number().int().positive(),
    observed_head: revision,
    state: z.enum(["open", "closed", "unknown"]),
  }).strict(),
  ci: bound.extend({
    workflow_run_id: id,
    workflow_path: id,
    pr: z.number().int().positive(),
    workflow_attempt: z.number().int().positive(),
    observed_pr_head: revision,
    status: z.enum(["completed", "in_progress", "unknown"]),
    jobs: z.array(z.object({
      // Canonical job + matrix key from the frozen policy, not a fuzzy name.
      key: id,
      conclusion: z.enum(["success", "failure", "skipped", "cancelled", "timed_out", "unknown"]),
    }).strict()).max(200),
  }).strict(),
}).strict();
export type E2eFixAcceptanceInput = z.infer<typeof E2eFixAcceptanceInputSchema>;

export interface E2eFixAcceptanceResult {
  eligible: boolean;
  reasons: string[];
  approvals: number;
}

export function sameE2eFixCandidate(a: E2eFixCandidate, b: E2eFixCandidate): boolean {
  return (Object.keys(E2eFixCandidateSchema.shape) as (keyof E2eFixCandidate)[])
    .every(key => a[key] === b[key]);
}

/** Check already authenticated records; a model's boolean/hash is not proof. */
export function evaluateE2eFixAcceptance(value: unknown): E2eFixAcceptanceResult {
  const parsed = E2eFixAcceptanceInputSchema.safeParse(value);
  if (!parsed.success) return { eligible: false, reasons: ["invalid_evidence_contract"], approvals: 0 };
  const x = parsed.data;
  const reasons = new Set<string>();
  const fail = (reason: string) => reasons.add(reason);
  const unique = (values: string[]) => new Set(values).size === values.length;
  const equalSet = (a: string[], b: string[]) => a.length === b.length && unique(a) && unique(b)
    && a.every(v => b.includes(v));
  if (x.policy.sha256 !== x.candidate.policy_sha256) fail("policy_changed");
  if ([...x.tests, ...x.reviews, x.judgment, x.publication, x.ci]
    .some(e => !sameE2eFixCandidate(e.candidate, x.candidate))) fail("candidate_identity_mismatch");

  // The adapter selects one authoritative attempt per required check. Never
  // search an arbitrary history for any old success and ignore the latest fail.
  if (!unique(x.tests.map(t => t.check_id))) fail("ambiguous_test_attempt");
  if (!unique(x.tests.map(t => t.execution_id))) fail("test_execution_reused");
  for (const key of x.policy.required_tests) {
    const t = x.tests.find(t => t.check_id === key);
    if (!t || t.result !== "passed" || t.exit_code !== 0 || t.signal !== null) fail(`test_not_passed:${key}`);
  }

  if (!equalSet(x.reviews.map(r => r.reviewer_id), x.policy.reviewer_ids)) fail("reviewer_set_mismatch");
  if (!unique([x.fixer_dispatch_id, x.judgment.dispatch_id, ...x.reviews.map(r => r.dispatch_id)])
    || !unique([x.fixer_session_id, x.judgment.session_id, ...x.reviews.map(r => r.session_id)])) fail("roles_not_independent");
  if (x.reviews.some(r => r.status !== "complete" && r.vote !== "abstain")) fail("incomplete_review_cannot_vote");
  if (x.reviews.some(r => r.vote === "approve" && r.finding_ids.length > 0)) fail("approve_with_findings");
  const approvals = x.reviews.filter(r => r.status === "complete" && r.vote === "approve").length;
  if (approvals < x.policy.review_approvals) fail("insufficient_approvals");
  if (x.judgment.verdict !== "accept") fail("judger_not_accepted");
  if (!equalSet(x.judgment.review_artifact_sha256, x.reviews.map(r => r.artifact_sha256))) fail("judger_review_set_mismatch");
  const findings = [...new Set(x.reviews.flatMap(r => r.finding_ids))];
  if (!equalSet(findings, x.judgment.dispositions.map(d => d.finding_id))) fail("finding_disposition_mismatch");
  if (x.judgment.dispositions.some(d => d.action !== "dismiss")) fail("unresolved_findings");

  if (x.publication.state !== "open" || x.publication.observed_head !== x.candidate.head) fail("publication_not_current");
  if (x.ci.status !== "completed" || x.ci.observed_pr_head !== x.candidate.head) fail("ci_not_current");
  if (x.ci.pr !== x.publication.pr || x.ci.workflow_path !== x.policy.ci_workflow_path) fail("ci_target_mismatch");
  if (!unique(x.ci.jobs.map(j => j.key))) fail("ambiguous_ci_jobs");
  for (const key of x.policy.required_ci_jobs) {
    if (x.ci.jobs.find(j => j.key === key)?.conclusion !== "success") fail(`ci_not_passed:${key}`);
  }
  return { eligible: reasons.size === 0, reasons: [...reasons], approvals };
}

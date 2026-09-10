import { evaluateE2eFixReviewAcceptance } from "../src/e2e-fix.js";
import { describe, expect, it } from "vitest";
import { evaluateE2eFixAcceptance, type E2eFixAcceptanceInput } from "../src/e2e-fix.js";

function evidence(): E2eFixAcceptanceInput {
  const candidate = {
    task_id: "issue-289-case-1", root_run_id: "root-1", round: 3,
    plan_sha256: "a".repeat(64), policy_sha256: "b".repeat(64),
    repo: "owner/repo", base: "1".repeat(40), head: "2".repeat(40), tree: "3".repeat(40),
  };
  const bind = (hex: string) => ({ candidate: { ...candidate }, artifact_sha256: hex.repeat(64) });
  const finding = "c".repeat(64);
  return {
    candidate,
    policy: {
      sha256: candidate.policy_sha256, required_tests: ["regression"],
      required_ci_jobs: ["linux/20", "linux/24", "windows/24", "ui-coverage", "docker"],
      ci_workflow_path: ".github/workflows/ci.yml",
      reviewer_ids: ["qwen", "kimi", "glm"], review_approvals: 2,
    },
    fixer_dispatch_id: "fixer-3", fixer_session_id: "fixer-session-3",
    tests: [{ ...bind("4"), check_id: "regression", execution_id: "test-execution-3", result: "passed", exit_code: 0, signal: null }],
    reviews: ["qwen", "kimi", "glm"].map((reviewer_id, i) => ({
      ...bind(String(i + 5)), reviewer_id, dispatch_id: `review-${reviewer_id}-3`,
      session_id: `session-${reviewer_id}-3`, status: "complete",
      vote: i === 2 ? "request_changes" : "approve", finding_ids: i === 2 ? [finding] : [],
    })),
    judgment: {
      ...bind("8"), dispatch_id: "judger-3", session_id: "judger-session-3", verdict: "accept",
      review_artifact_sha256: ["5", "6", "7"].map(s => s.repeat(64)),
      dispositions: [{ finding_id: finding, action: "dismiss", reason: "Claim contradicts runtime version and measured execution.", evidence_sha256: ["d".repeat(64)] }],
    },
    publication: { ...bind("9"), pr: 123, observed_head: candidate.head, state: "open" },
    ci: {
      ...bind("a"), pr: 123, workflow_path: ".github/workflows/ci.yml", workflow_run_id: "456", workflow_attempt: 1, observed_pr_head: candidate.head,
      status: "completed", jobs: ["linux/20", "linux/24", "windows/24", "ui-coverage", "docker"]
        .map(key => ({ key, conclusion: "success" })),
    },
  };
}

function rejected(x: unknown, reason: string) {
  expect(evaluateE2eFixAcceptance(x)).toMatchObject({ eligible: false, reasons: expect.arrayContaining([reason]) });
}

describe("E2E Fix frozen completion policy (trusted-store records only)", () => {
  it("accepts all required CI plus two complete votes with an evidenced finding disposition", () => {
    expect(evaluateE2eFixAcceptance(evidence())).toEqual({ eligible: true, reasons: [], approvals: 2 });
  });

  it.each(["failed", "incomplete"] as const)("represents a %s third reviewer as abstention, never as a vote", status => {
    const x = evidence();
    Object.assign(x.reviews[2], { status, vote: "abstain", finding_ids: [] });
    x.judgment.dispositions = [];
    expect(evaluateE2eFixAcceptance(x).eligible).toBe(true);
    x.reviews[2].vote = "approve";
    rejected(x, "incomplete_review_cannot_vote");
  });

  it.each(["failure", "skipped", "cancelled", "timed_out", "unknown"] as const)("rejects required CI %s even with two approvals", conclusion => {
    const x = evidence(); x.ci.jobs[0].conclusion = conclusion;
    rejected(x, "ci_not_passed:linux/20");
  });
  it("does not mistake a missing matrix job for success", () => {
    const x = evidence(); x.ci.jobs.splice(2, 1);
    rejected(x, "ci_not_passed:windows/24");
  });
  it("rejects ambiguous duplicate jobs rather than selecting a convenient success", () => {
    const x = evidence(); x.ci.jobs.push({ key: "linux/20", conclusion: "failure" });
    rejected(x, "ambiguous_ci_jobs");
  });
  it("allows a non-required platform job to be skipped", () => {
    const x = evidence(); x.ci.jobs.push({ key: "optional-platform", conclusion: "skipped" });
    expect(evaluateE2eFixAcceptance(x).eligible).toBe(true);
  });
  it.each(["task_id", "root_run_id", "round", "plan_sha256", "policy_sha256", "repo", "base", "head", "tree"] as const)("rejects old or unrelated test evidence differing in %s", key => {
    const x = evidence();
    const values = { task_id: "other", root_run_id: "other", round: 2, plan_sha256: "e".repeat(64), policy_sha256: "e".repeat(64), repo: "other/repo", base: "e".repeat(40), head: "e".repeat(40), tree: "e".repeat(40) };
    Object.assign(x.tests[0].candidate, { [key]: values[key] });
    rejected(x, "candidate_identity_mismatch");
  });
  it("rejects old review/Judger/publication/CI identities too", () => {
    for (const which of ["review", "judgment", "publication", "ci"]) {
      const x = evidence();
      const record = which === "review" ? x.reviews[0] : x[which as "judgment" | "publication" | "ci"];
      record.candidate.head = "f".repeat(40);
      rejected(x, "candidate_identity_mismatch");
    }
  });
  it("rejects policy drift", () => {
    const x = evidence(); x.policy.sha256 = "f".repeat(64); rejected(x, "policy_changed");
  });
  it("does not accept test report text in place of a complete evidence input", () => {
    rejected({ status: "passed", exit_code: 0, tests: 3000 }, "invalid_evidence_contract");
  });
  it("requires a real passing result, zero exit and no kill signal", () => {
    for (const change of [{ result: "unknown" }, { exit_code: 7 }, { signal: "SIGKILL" }]) {
      const x = evidence(); Object.assign(x.tests[0], change); rejected(x, "test_not_passed:regression");
    }
  });
  it("does not reuse an old passing attempt over a newer failed attempt", () => {
    const x = evidence(); x.tests.push({ ...x.tests[0], execution_id: "new-attempt", result: "failed" });
    rejected(x, "ambiguous_test_attempt");
  });
  it("rejects duplicate reviewers and shared fixer/reviewer/Judger sessions", () => {
    const x = evidence(); x.reviews[1].reviewer_id = x.reviews[0].reviewer_id; rejected(x, "reviewer_set_mismatch");
    const y = evidence(); y.reviews[0].session_id = y.fixer_session_id; rejected(y, "roles_not_independent");
    const z = evidence(); z.judgment.dispatch_id = z.reviews[0].dispatch_id; rejected(z, "roles_not_independent");
  });
  it("does not let two votes erase a valid finding or bypass the Judger", () => {
    const x = evidence(); x.judgment.dispositions[0].action = "revise"; rejected(x, "unresolved_findings");
    x.judgment.dispositions = []; rejected(x, "finding_disposition_mismatch");
    const y = evidence(); y.judgment.verdict = "pause"; rejected(y, "judger_not_accepted");
  });
  it("rejects undocumented dismissal and approvals containing findings", () => {
    const x = evidence(); x.judgment.dispositions[0].evidence_sha256 = []; rejected(x, "invalid_evidence_contract");
    const y = evidence(); y.reviews[0].finding_ids = ["c".repeat(64)]; rejected(y, "approve_with_findings");
  });
  it("binds the Judger decision to all actual review report artifacts", () => {
    const x = evidence(); x.judgment.review_artifact_sha256.pop(); rejected(x, "judger_review_set_mismatch");
    const y = evidence(); y.reviews[2].artifact_sha256 = "f".repeat(64); rejected(y, "judger_review_set_mismatch");
  });
  it("rejects remote head drift even if annotated candidate identities match", () => {
    const x = evidence(); x.publication.observed_head = "f".repeat(40); rejected(x, "publication_not_current");
    const y = evidence(); y.ci.observed_pr_head = "f".repeat(40); rejected(y, "ci_not_current");
  });
  it("cannot substitute another PR or workflow that happens to test the same head", () => {
    const x = evidence(); x.ci.pr = 999; rejected(x, "ci_target_mismatch");
    const y = evidence(); y.ci.workflow_path = ".github/workflows/optional.yml"; rejected(y, "ci_target_mismatch");
  });
  it("rejects insufficient approvals and impossible threshold policies", () => {
    const x = evidence(); x.reviews[0].vote = "abstain"; rejected(x, "insufficient_approvals");
    const y = evidence(); y.policy.review_approvals = 4; rejected(y, "invalid_evidence_contract");
  });
});


describe("fixed-design review quorum without a model Judger", () => {
  const input = () => { const { judgment: _judgment, ...value } = evidence(); return value; };
  it("accepts the configured majority without inventing a Judger or erasing dissent", () => {
    const x = input();
    expect(x.reviews[2].finding_ids.length).toBeGreaterThan(0);
    expect(evaluateE2eFixReviewAcceptance(x)).toEqual({ eligible: true, reasons: [], approvals: 2 });
    expect(evaluateE2eFixAcceptance(x).eligible).toBe(false); // Legacy policy still requires its actual Judger.
  });
  it("rejects a supplied model judgment in the program-only gate", () => {
    expect(evaluateE2eFixReviewAcceptance(evidence()).eligible).toBe(false);
  });
  it("does not let majority votes bypass failed CI or stale PR identity", () => {
    const x = input(); x.ci.jobs[0].conclusion = "failure";
    expect(evaluateE2eFixReviewAcceptance(x).eligible).toBe(false);
    x.ci.jobs[0].conclusion = "success"; x.publication.observed_head = "f".repeat(40);
    expect(evaluateE2eFixReviewAcceptance(x).eligible).toBe(false);
  });
  it("requires independent complete approvals and keeps missing votes nonpassing", () => {
    const x = input(); x.reviews[1].session_id = x.fixer_session_id;
    expect(evaluateE2eFixReviewAcceptance(x).reasons).toContain("roles_not_independent");
    x.reviews[1].session_id = "another-review-session"; x.reviews[1].status = "incomplete";
    expect(evaluateE2eFixReviewAcceptance(x).eligible).toBe(false);
  });
});

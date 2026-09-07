import { describe, expect, it } from "vitest";

import { validatePrReviewCloseoutEvidence } from "../src/pr-closeout.js";

const expected = {
  repo: "xiaotianfotos/homerail",
  pr: 26,
  base: "a".repeat(40),
  head: "b".repeat(40),
};

function publication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    report: {
      repo: expected.repo,
      pr: expected.pr,
      base: expected.base,
      head: expected.head,
      status: "pass",
      confidence: "high",
      summary: "No actionable findings",
      actionable_count: 0,
      findings: [],
      reviewer_results: ["qwen", "kimi", "glm"].map((reviewer) => ({
        reviewer,
        status: "complete",
        vote: "approve",
        summary: `${reviewer} review complete`,
        reviewed_files: ["src/index.ts"],
        unreviewed_files: [],
        evidence_truncated: false,
        findings: [],
      })),
    },
    quorum: { passed: true, successes: 3, total: 3, threshold: 2 },
    ...overrides,
  };
}

function validate(options: {
  metadata?: Record<string, unknown>;
  handoffs?: Array<Record<string, unknown>>;
} = {}) {
  return validatePrReviewCloseoutEvidence({
    metadata: options.metadata ?? { workflowId: "pr-review" },
    handoffs: options.handoffs ?? [{ fromNode: "decide", port: "decided", content: publication() }],
    expected,
  });
}

describe("PR closeout evidence validation", () => {
  it("accepts only a complete passing publication from the built-in PR Review workflow", () => {
    expect(validate()).toEqual({
      recognized: true,
      valid: true,
      passed: true,
      head: expected.head,
      report_status: "pass",
      actionable_count: 0,
    });
  });

  it("accepts a two-approval pass when the third reviewer safely abstains", () => {
    const value = publication();
    const reviewers = (value.report as Record<string, unknown>).reviewer_results as Array<Record<string, unknown>>;
    reviewers[2] = {
      ...reviewers[2],
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: ["src/index.ts"],
      evidence_truncated: true,
    };
    (value.report as Record<string, unknown>).confidence = "medium";
    value.quorum = { passed: true, successes: 2, total: 3, threshold: 2 };
    expect(validate({
      handoffs: [{ fromNode: "decide", port: "decided", content: value }],
    })).toMatchObject({ valid: true, passed: true, report_status: "pass" });
  });

  it("rejects findings hidden inside a failed reviewer", () => {
    const value = publication();
    const report = value.report as Record<string, unknown>;
    const reviewers = report.reviewer_results as Array<Record<string, unknown>>;
    reviewers[2] = {
      ...reviewers[2],
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: ["src/index.ts"],
      evidence_truncated: true,
      findings: [{
        category: "runtime",
        severity: "high",
        title: "Hidden failure",
        file: "src/index.ts",
        line: 1,
        evidence: "A failed reviewer cannot publish trusted findings.",
        recommendation: "Normalize failed evidence to an empty finding set.",
        confidence: "high",
      }],
    };
    report.confidence = "medium";
    value.quorum = { passed: true, successes: 2, total: 3, threshold: 2 };

    expect(validate({
      handoffs: [{ fromNode: "decide", port: "decided", content: value }],
    })).toMatchObject({ valid: false, passed: false, error: expect.stringContaining("does not preserve every reviewer finding") });
  });

  it("accepts a failed reviewer finding only when the final report retains it", () => {
    const value = publication();
    const report = value.report as Record<string, unknown>;
    const reviewers = report.reviewer_results as Array<Record<string, unknown>>;
    const retainedFinding = {
      category: "runtime",
      severity: "high",
      title: "Recovered failure",
      file: "src/index.ts",
      line: 1,
      evidence: "The durable evidence bridge retained a bounded finding.",
      recommendation: "Fix the recovered defect before merging.",
      confidence: "high",
    };
    reviewers[2] = {
      ...reviewers[2],
      status: "failed",
      vote: "abstain",
      reviewed_files: [],
      unreviewed_files: ["src/index.ts"],
      evidence_truncated: true,
      findings: [retainedFinding],
    };
    report.status = "findings";
    report.confidence = "medium";
    report.actionable_count = 1;
    report.findings = [retainedFinding];
    value.quorum = { passed: false, successes: 2, total: 3, threshold: 2 };

    expect(validate({
      handoffs: [{ fromNode: "decide", port: "decided", content: value }],
    })).toMatchObject({ valid: true, passed: false, report_status: "findings", actionable_count: 1 });
  });

  it("rejects an unrelated workflow even when nested content claims pass", () => {
    expect(validate({
      metadata: { workflowId: "some-other-workflow" },
      handoffs: [{
        fromNode: "result",
        port: "done",
        content: { head: expected.head, nested: { status: "pass" }, report: { status: "pass" } },
      }],
    })).toMatchObject({
      recognized: false,
      valid: false,
      passed: false,
      head: "unknown",
      error: "run workflow_id is not pr-review",
    });
  });

  it("requires the persisted decide.decided handoff provenance", () => {
    expect(validate({
      handoffs: [{ fromNode: "synthesize", port: "drafted", content: publication() }],
    })).toMatchObject({ valid: false, passed: false, error: expect.stringContaining("decide.decided") });
  });

  it("does not default a missing actionable_count to zero", () => {
    const value = publication();
    const report = value.report as Record<string, unknown>;
    delete report.actionable_count;
    expect(validate({
      handoffs: [{ from_node: "decide", port: "decided", content: JSON.stringify(value) }],
    })).toMatchObject({
      recognized: true,
      valid: false,
      passed: false,
      report_status: "pass",
      error: expect.stringContaining("actionable_count"),
    });
  });

  it("rejects a mismatched report identity and an inconsistent quorum", () => {
    const wrongHead = publication();
    (wrongHead.report as Record<string, unknown>).head = "c".repeat(40);
    expect(validate({
      handoffs: [{ fromNode: "decide", port: "decided", content: wrongHead }],
    })).toMatchObject({ valid: false, passed: false, head: "c".repeat(40), error: expect.stringContaining("base/head") });

    expect(validate({
      handoffs: [{
        fromNode: "decide",
        port: "decided",
        content: publication({ quorum: { passed: true, successes: 1, total: 3, threshold: 2 } }),
      }],
    })).toMatchObject({ valid: false, passed: false, error: expect.stringContaining("quorum") });
  });
});

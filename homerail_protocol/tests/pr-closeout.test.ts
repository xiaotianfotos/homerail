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
      reviewer_results: ["runtime", "security", "tests", "frontend"].map((reviewer) => ({
        reviewer,
        status: "complete",
        summary: `${reviewer} review complete`,
        findings: [],
      })),
    },
    markdown: "# HomeRail PR Review\n\nNo actionable findings.",
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
    handoffs: options.handoffs ?? [{ fromNode: "publish", port: "published", content: publication() }],
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

  it("requires the persisted publish.published handoff provenance", () => {
    expect(validate({
      handoffs: [{ fromNode: "synthesize", port: "drafted", content: publication() }],
    })).toMatchObject({ valid: false, passed: false, error: expect.stringContaining("publish.published") });
  });

  it("does not default a missing actionable_count to zero", () => {
    const value = publication();
    const report = value.report as Record<string, unknown>;
    delete report.actionable_count;
    expect(validate({
      handoffs: [{ from_node: "publish", port: "published", content: JSON.stringify(value) }],
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
      handoffs: [{ fromNode: "publish", port: "published", content: wrongHead }],
    })).toMatchObject({ valid: false, passed: false, head: "c".repeat(40), error: expect.stringContaining("base/head") });

    expect(validate({
      handoffs: [{
        fromNode: "publish",
        port: "published",
        content: publication({ quorum: { passed: true, successes: 1, total: 3, threshold: 2 } }),
      }],
    })).toMatchObject({ valid: false, passed: false, error: expect.stringContaining("quorum") });
  });
});

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PR_REVIEW_EXPECTED_USAGE,
  defaultPrReviewBudgetKey,
  isFullGitRevision,
} from "../src/pr-review.js";

describe("PR Review scenario defaults", () => {
  it("shares one documented admission estimate and daily budget key", () => {
    expect(DEFAULT_PR_REVIEW_EXPECTED_USAGE).toBe(8);
    expect(defaultPrReviewBudgetKey(
      "xiaotianfotos/homerail",
      new Date("2026-07-12T23:59:59.000Z"),
    )).toBe("pr-review:xiaotianfotos/homerail:2026-07-12");
  });
});

describe("isFullGitRevision", () => {
  it("accepts full SHA-1 and SHA-256 revisions only", () => {
    expect(isFullGitRevision("a".repeat(40))).toBe(true);
    expect(isFullGitRevision("B".repeat(64))).toBe(true);
    expect(isFullGitRevision("a".repeat(39))).toBe(false);
    expect(isFullGitRevision("a".repeat(41))).toBe(false);
    expect(isFullGitRevision("g".repeat(40))).toBe(false);
  });
});

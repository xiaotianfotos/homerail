import { describe, expect, it } from "vitest";
import { assessE2eFixProgress, e2eFixFailureFingerprint, sameE2eFixPlan, type E2eFixFailureObservation } from "../src/runtime/e2e-fix-progress.js";

const failure: E2eFixFailureObservation = { phase: "candidate", outcome: "code_failure",
  checks: [{ id: "signed-addition", result: "failed", diagnostic: "expected -5, received 5\n" }], findings: [], detail: "" };

describe("E2E Fix repeated failure policy", () => {
  it("requires replanning on the second unchanged failure and stops after the third", () => {
    const sha = e2eFixFailureFingerprint(failure);
    expect(assessE2eFixProgress(sha, [])).toMatchObject({ consecutive_failures: 1, action: "continue" });
    expect(assessE2eFixProgress(sha, [sha])).toMatchObject({ consecutive_failures: 2, action: "replan" });
    expect(assessE2eFixProgress(sha, [sha, sha])).toMatchObject({ consecutive_failures: 3, action: "pause" });
  });
  it("preserves changed assertion values, check results and phase boundaries", () => {
    const sha = e2eFixFailureFingerprint(failure);
    for (const changed of [
      { ...failure, checks: [{ ...failure.checks[0], diagnostic: "expected -5, received -4" }] },
      { ...failure, checks: [{ ...failure.checks[0], result: "passed" }] },
      { ...failure, phase: "ci" as const },
    ]) expect(e2eFixFailureFingerprint(changed)).not.toBe(sha);
    expect(assessE2eFixProgress(sha, [sha, null])).toMatchObject({ consecutive_failures: 1, action: "continue" });
  });
  it("ignores ANSI decoration, duplicate findings and ordering without deleting raw evidence", () => {
    const a = { ...failure, findings: ["defect B", "defect A", "defect A"] };
    const b = { ...failure, checks: [{ ...failure.checks[0], diagnostic: "\u001b[31mexpected -5, received 5\u001b[39m\r\n" }], findings: ["defect A", "defect B"] };
    expect(e2eFixFailureFingerprint(a)).toBe(e2eFixFailureFingerprint(b));
    expect(a.findings).toHaveLength(3);
  });
  it("rejects cosmetic replans while allowing an actual changed strategy or scope", () => {
    const a = { strategy: "Fix signed addition", allowed_paths: ["a.ts", "b.ts"] };
    expect(sameE2eFixPlan(a, { strategy: " Fix  signed\naddition ", allowed_paths: ["b.ts", "a.ts", "a.ts"] })).toBe(true);
    expect(sameE2eFixPlan(a, { ...a, strategy: "Trace the negative-input branch before editing" })).toBe(false);
    expect(sameE2eFixPlan(a, { ...a, allowed_paths: ["a.ts"] })).toBe(false);
  });
});

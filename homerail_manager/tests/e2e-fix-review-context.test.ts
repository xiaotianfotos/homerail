import { describe, expect, it, vi } from "vitest";
import { publishE2eFixReviewContext } from "../src/runtime/e2e-fix-review-context.js";
import type { E2eFixCandidates } from "../src/runtime/e2e-fix-candidates.js";

const candidate = { task_id: "fixture", root_run_id: "root", round: 1, repo: "fixture/repo",
  base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40),
  plan_sha256: "d".repeat(64), policy_sha256: "e".repeat(64) };
const publication = { candidate, pr: 7, state: "open" as const,
  observed_head: candidate.head, artifact_sha256: "f".repeat(64) };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const candidates = { reviewDiff: () => "-return 0;\n+return a+b;" } as unknown as E2eFixCandidates;

describe("publication review-context admission", () => {
  it("projects before publishing when tests fit but publication metadata does not", () => {
    const evidence = { candidate, sources: { "sum.cjs": "// 保留源码\n".repeat(1000) } };
    const limit = bytes(evidence) + 10;
    expect(bytes({ ...evidence, publication })).toBeGreaterThan(limit);
    const publish = vi.fn(() => publication);
    const result = publishE2eFixReviewContext(evidence, candidates, limit, publish);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty("sources");
    expect(result).toMatchObject({ publication, source_context: {
      limitation: expect.stringContaining("Reviewers receive this projection, not the omitted source"),
    } });
    expect(bytes(result)).toBeLessThanOrEqual(limit);
  });

  it.each([false, true])("rejects unshrinkable input before any PR write (already projected: %s)", projected => {
    const evidence = { candidate, issue: "Required scope. ".repeat(1000),
      ...(projected ? { source_context: { kind: "base_to_candidate_diff", diff: "+return a+b;" } }
        : { sources: { "sum.cjs": "return a+b;" } }) };
    const publish = vi.fn(() => publication);
    expect(() => publishE2eFixReviewContext(evidence, candidates, bytes(evidence) + 10, publish))
      .toThrow("before publication");
    expect(publish).not.toHaveBeenCalled();
  });

  it("admits the maximum safe PR number without a post-publication overflow", () => {
    const receipt = { ...publication, pr: Number.MAX_SAFE_INTEGER };
    const evidence = { candidate, sources: { "sum.cjs": "return a+b;" } };
    const limit = bytes({ ...evidence, publication: receipt });
    const result = publishE2eFixReviewContext(evidence, candidates, limit, () => receipt);
    expect(result).toEqual({ ...evidence, publication: receipt });
    expect(bytes(result)).toBe(limit);
  });
});

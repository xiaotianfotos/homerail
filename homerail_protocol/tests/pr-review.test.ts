import { describe, expect, it } from "vitest";

import {
  ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
  buildReviewEvidenceProjection,
  canonicalChangedFileCoverage,
  changedFileCoverageAttestation,
  changedFileCoverageDigest,
  classifyReviewFailure,
  coverageAttestationMatches,
  extractReviewEvidence,
  findingDedupKey,
  isFullGitRevision,
  normalizeReviewFinding,
  REVIEW_EVIDENCE_PROJECTION_MAX_BYTES,
  REVIEW_EVIDENCE_SCHEMA_ID,
  sanitizeAttemptDiagnostic,
  validateChangedFileCoverageAttestation,
  validateReviewEvidenceProjection,
  type ReviewFindingV1,
} from "../src/pr-review.js";
import { reviewFindingDedupKey, sha256Hex } from "../src/sha256.js";

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["你好, HomeRail 🚆", "77e1142f9cd5d2c09653fd522f8a553215f20a3732835364701f32fccb666110"],
  ])("matches the fixed SHA-256 vector for %j", (input, digest) => {
    expect(sha256Hex(input)).toBe(digest);
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

describe("canonical changed-file coverage", () => {
  const files = ["b.txt", "a.txt", "c/d.txt", "b.txt", ""];

  it("computes a deterministic SHA-256 digest and unique count", () => {
    const first = changedFileCoverageDigest(files);
    const second = changedFileCoverageDigest(["c/d.txt", "a.txt", "b.txt"]);
    expect(first).toEqual(second);
    expect(first.count).toBe(3);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the canonical digest to sorted unique newline-joined paths", () => {
    const canonical = changedFileCoverageDigest(["c/d.txt", "b.txt", "a.txt", "b.txt", ""]);
    expect(canonical).toEqual({
      digest: "420e2782dc08d01733c663074b910ed3ab02961fe14a875eb96618bd8aa3175f",
      count: 3,
    });
    // The divergent Git-order JSON.stringify algorithm must not be reintroduced.
    expect(canonical.digest).not.toBe(
      "6ec9ab82dd890249284be894353a06b9f1f3b6ea65bc54c187e60950e3922b29",
    );
  });

  it("produces a compact attestation and validates it strictly", () => {
    const attestation = canonicalChangedFileCoverage(files);
    expect(attestation).toEqual({
      schema: "changed-file-coverage-v1",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      count: 3,
    });
    expect(coverageAttestationMatches(attestation, files)).toBe(true);
    expect(coverageAttestationMatches(attestation, ["a.txt", "b.txt"])).toBe(false);
    expect(coverageAttestationMatches({ ...attestation, digest: "a".repeat(64) }, files)).toBe(false);
    expect(coverageAttestationMatches({ ...attestation, count: 4 }, files)).toBe(false);
    expect(coverageAttestationMatches({ ...attestation, schema: "other" }, files)).toBe(false);
    expect(coverageAttestationMatches(attestation, ["a.txt", "c/d.txt", "b.txt"])).toBe(true);
  });

  it("fails closed on malformed attestations", () => {
    expect(validateChangedFileCoverageAttestation(null, files).valid).toBe(false);
    expect(validateChangedFileCoverageAttestation({ digest: "x", count: 3 }, files).valid).toBe(false);
    expect(validateChangedFileCoverageAttestation({
      schema: "changed-file-coverage-v1",
      digest: "ABCDEF".repeat(10).toLowerCase() + "xx",
      count: 3,
    }, files).valid).toBe(false);
  });
});

function sampleFinding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    id: reviewFindingDedupKey("src/app.ts", 12, "Unchecked response"),
    category: "security",
    severity: "high",
    title: "Unchecked response",
    file: "src/app.ts",
    line: 12,
    evidence: "fetch('/api') is not awaited",
    recommendation: "Await and validate the response",
    confidence: "high",
    ...overrides,
  };
}

describe("bounded review findings", () => {
  it("normalizes and deduplicates by a stable digest", () => {
    const normalized = normalizeReviewFinding({
      category: "security",
      severity: "high",
      title: "Unchecked response",
      file: "src/app.ts",
      line: 12,
      evidence: "fetch('/api') is not awaited",
      recommendation: "Await and validate",
      confidence: "high",
    });
    expect(normalized).toBeDefined();
    expect(normalized?.id).toBe(findingDedupKey(normalized!));
    expect(normalized?.id).toBe(reviewFindingDedupKey("src/app.ts", 12, "Unchecked response"));
    expect(normalizeReviewFinding({ ...sampleFinding(), line: 0 })).toBeUndefined();
    expect(normalizeReviewFinding({ ...sampleFinding(), category: "unknown" })).toBeUndefined();
    expect(normalizeReviewFinding({ ...sampleFinding(), title: "x".repeat(301) })).toBeUndefined();
  });

  it("redacts credential-like text inside finding fields", () => {
    const normalized = normalizeReviewFinding({
      ...sampleFinding(),
      evidence: "token=sk-secret-value-123456789 in logs",
    });
    expect(normalized?.evidence).not.toContain("sk-secret-value");
    expect(normalized?.evidence).toContain("REDACTED");
  });
});

describe("attempt diagnostic classification and sanitization", () => {
  it("classifies provider truncation distinctly from abstention", () => {
    expect(classifyReviewFailure("output limit reached, stop_reason=max_tokens")).toBe("provider_output_truncated");
    expect(classifyReviewFailure("DAG_HANDOFF_ARGUMENTS_INVALID unexpected key")).toBe("handoff_arguments_invalid");
    expect(classifyReviewFailure("DAG_HANDOFF_CONTRACT_VIOLATION voted")).toBe("contract_validation_failed");
    expect(classifyReviewFailure("Claude SDK transport error write EPIPE")).toBe("transport_failed");
    expect(classifyReviewFailure("reviewer abstained because evidence was incomplete")).toBe("reviewer_abstained");
    expect(classifyReviewFailure("handoff_applied")).toBe("accepted");
    expect(classifyReviewFailure("")).toBe("unknown");
  });

  it("keeps missing provider fields explicit unknown/null", () => {
    const diagnostic = sanitizeAttemptDiagnostic({}, { attempt: 2 });
    expect(diagnostic).toMatchObject({
      schema: ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
      attempt: 2,
      finish_reason: null,
      output_tokens: null,
      output_token_limit: null,
      tool_argument_parse_state: "unknown",
      contract_stage: "unknown",
      failure_category: "unknown",
    });
  });

  it("preserves available terminal metadata and redacts reason text", () => {
    const diagnostic = sanitizeAttemptDiagnostic({
      finish_reason: "max_tokens",
      output_tokens: "1234",
      output_token_limit: 4096,
      tool_argument_parse_state: "valid",
      contract_stage: "contract_validation",
      failure_reason: "apiKey=sk-secret-1234567890 output limit",
    }, { attempt: 1 });
    expect(diagnostic).toMatchObject({
      attempt: 1,
      finish_reason: "max_tokens",
      output_tokens: 1234,
      output_token_limit: 4096,
      tool_argument_parse_state: "valid",
      contract_stage: "contract_validation",
      failure_category: "provider_output_truncated",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sk-secret");
    expect(sanitizeAttemptDiagnostic("not an object")).toBeUndefined();
  });

  it("lets a Manager rejection override a Worker-side accepted classification", () => {
    expect(sanitizeAttemptDiagnostic({
      finish_reason: "end_turn",
      tool_argument_parse_state: "valid",
      contract_stage: "tool_arguments",
      failure_category: "accepted",
    }, {
      attempt: 1,
      failure_reason: "DAG_HANDOFF_CONTRACT_VIOLATION qwen_review.voted",
      contract_stage: "contract_validation",
    })).toMatchObject({
      attempt: 1,
      failure_category: "contract_validation_failed",
      contract_stage: "contract_validation",
    });
  });
});

describe("review evidence submission and projection", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const attestation = changedFileCoverageAttestation(files);

  it("extracts bounded findings and coverage from handoff content", () => {
    const submission = extractReviewEvidence({
      schema: REVIEW_EVIDENCE_SCHEMA_ID,
      reviewer: "qwen",
      coverage_attestation: attestation,
      findings: [sampleFinding(), sampleFinding(), sampleFinding()],
      diagnostics: [{ finish_reason: "max_tokens", output_tokens: 99 }],
    });
    expect(submission?.reviewer).toBe("qwen");
    expect(submission?.findings).toHaveLength(1);
    expect(submission?.coverage_attestation).toEqual(attestation);
    expect(submission?.diagnostics?.[0]).toMatchObject({
      schema: ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
      output_tokens: 99,
    });
    expect(extractReviewEvidence({ findings: [] })).toBeUndefined();
  });

  it("extracts nested evidence and rejects unbounded input", () => {
    const submission = extractReviewEvidence({
      evidence: {
        schema: REVIEW_EVIDENCE_SCHEMA_ID,
        reviewer: "kimi",
        findings: [sampleFinding()],
      },
    });
    expect(submission?.reviewer).toBe("kimi");
    expect(extractReviewEvidence({ evidence: { schema: "wrong", reviewer: "kimi" } })).toBeUndefined();
  });

  it("extracts reviewer-shaped handoff content with compact coverage", () => {
    const submission = extractReviewEvidence({
      reviewer: "qwen",
      status: "complete",
      vote: "request_changes",
      summary: "Three findings found.",
      coverage: { digest: attestation.digest, count: attestation.count },
      findings: [sampleFinding(), sampleFinding(), sampleFinding()],
    });
    expect(submission?.reviewer).toBe("qwen");
    expect(submission?.findings).toHaveLength(1);
    expect(submission?.coverage_attestation).toEqual(attestation);

    const nested = extractReviewEvidence({
      reviewer: "kimi",
      evidence: {
        reviewer: "kimi",
        findings: [sampleFinding()],
        coverage: { digest: attestation.digest, count: attestation.count },
      },
    });
    expect(nested?.reviewer).toBe("kimi");
    expect(nested?.coverage_attestation).toEqual(attestation);

    expect(extractReviewEvidence({
      reviewer: "qwen",
      status: "complete",
      vote: "approve",
      summary: "No findings.",
      findings: [],
    })).toBeUndefined();
    expect(extractReviewEvidence({ status: "complete", vote: "approve" })).toBeUndefined();
  });

  it("builds a bounded projection consumed by correction/normalization", () => {
    const projection = buildReviewEvidenceProjection({
      reviewer: "qwen",
      findings: [sampleFinding()],
      diagnostics: [{ finish_reason: "end_turn", output_tokens: 5 }],
      coverage_attestation: attestation,
    });
    expect(validateReviewEvidenceProjection(projection).valid).toBe(true);
    expect(projection?.accepted_findings).toHaveLength(1);
    expect(projection?.attempt_diagnostics).toHaveLength(1);
    expect(projection?.coverage_attestation).toEqual(attestation);
    expect(projection).toMatchObject({
      projection_truncated: false,
      omitted_findings: 0,
      omitted_diagnostics: 0,
    });
    expect(validateReviewEvidenceProjection({ ...projection, reviewer: "" }).valid).toBe(false);
    expect(validateReviewEvidenceProjection({ ...projection, coverage_attestation: { digest: "bad" } }).valid).toBe(false);
  });

  it("retains high-severity findings and marks oversized projections instead of dropping all evidence", () => {
    const findings = Array.from({ length: 10 }, (_, index) => sampleFinding({
      id: reviewFindingDedupKey(`src/large-${index}.ts`, index + 1, `Large finding ${index}`),
      severity: index === 9 ? "critical" : "medium",
      title: `Large finding ${index}`,
      file: `src/large-${index}.ts`,
      line: index + 1,
      evidence: String(index).repeat(12_000),
      recommendation: `R${index}`.repeat(4_000),
    }));
    const submission = extractReviewEvidence({
      reviewer: "qwen",
      findings,
      coverage: { digest: attestation.digest, count: attestation.count },
    });
    expect(submission?.findings).toHaveLength(findings.length);

    const projection = buildReviewEvidenceProjection({
      reviewer: "qwen",
      findings: submission!.findings,
      diagnostics: Array.from({ length: 8 }, (_, index) => ({
        attempt: index + 1,
        finish_reason: `attempt-${index + 1}`,
        failure_category: "contract_validation_failed",
      })),
      coverage_attestation: attestation,
    });
    expect(projection).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8"))
      .toBeLessThanOrEqual(REVIEW_EVIDENCE_PROJECTION_MAX_BYTES);
    expect(projection).toMatchObject({ projection_truncated: true });
    expect(projection!.accepted_findings.length).toBeGreaterThan(0);
    expect(projection!.accepted_findings.length).toBeLessThan(findings.length);
    expect(projection!.omitted_findings).toBe(findings.length - projection!.accepted_findings.length);
    expect(projection!.accepted_findings[0]?.severity).toBe("critical");
    expect(projection!.attempt_diagnostics.at(-1)?.attempt).toBe(8);
    expect(validateReviewEvidenceProjection(projection).valid).toBe(true);
  });
});

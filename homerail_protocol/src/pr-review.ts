/**
 * Shared PR Review scenario primitives.
 * @version 0.2.0
 */

import { sha256Hex } from "./sha256.js";

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Bounded redacted diagnostics never exceed this serialized size. */
export const MAX_REVIEW_ATTEMPT_DIAGNOSTIC_BYTES = 4096;
/** Accepted findings are bounded to this count per reviewer node. */
export const MAX_REVIEW_ACCEPTED_FINDINGS = 50;
/** Attempt diagnostics are bounded to this count per reviewer node. */
export const MAX_REVIEW_ATTEMPTS = 10;

/** Accept only complete SHA-1 or SHA-256 Git object identifiers. */
export function isFullGitRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_REVISION.test(value);
}

/**
 * Compact trusted changed-file coverage. The canonical representation is the
 * ordered array serialized with JSON.stringify; any other representation must
 * not be used for attestation digests. The digest is deterministic SHA-256
 * (lowercase hex) computed with the browser-safe `sha256Hex` primitive, which
 * matches Node's `createHash("sha256").update(json, "utf8").digest("hex")`.
 */
export interface ChangedFilesCoverage {
  digest: string;
  count: number;
}

export function changedFilesCoverage(changedFiles: readonly string[]): ChangedFilesCoverage {
  return {
    digest: sha256Hex(JSON.stringify(changedFiles)),
    count: changedFiles.length,
  };
}

/** Model-facing compact coverage attestation. */
export interface CoverageAttestation {
  digest: string;
  count: number;
}

export function isCoverageAttestation(value: unknown): value is CoverageAttestation {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).digest === "string"
    && SHA256_HEX.test(String((value as Record<string, unknown>).digest))
    && Number.isSafeInteger((value as Record<string, unknown>).count)
    && Number((value as Record<string, unknown>).count) >= 0;
}

export function coverageAttestationMatches(
  attestation: unknown,
  trusted: ChangedFilesCoverage,
): boolean {
  if (!isCoverageAttestation(attestation)) return false;
  return attestation.digest.toLowerCase() === trusted.digest.toLowerCase()
    && attestation.count === trusted.count;
}

export const REVIEW_ATTEMPT_CATEGORIES = [
  "accepted",
  "provider_output_truncated",
  "handoff_arguments_invalid",
  "contract_validation_failed",
  "transport_failed",
  "reviewer_abstained",
  "unknown",
] as const;

export type ReviewAttemptCategory = (typeof REVIEW_ATTEMPT_CATEGORIES)[number];

export const REVIEW_ATTEMPT_TOOL_PARSE_STATES = [
  "ok",
  "invalid",
  "not_applicable",
  "unknown",
] as const;

export type ReviewAttemptToolParseState = (typeof REVIEW_ATTEMPT_TOOL_PARSE_STATES)[number];

export const REVIEW_ATTEMPT_CONTRACT_STAGES = [
  "accepted",
  "rejected",
  "not_reached",
  "unknown",
] as const;

export type ReviewAttemptContractStage = (typeof REVIEW_ATTEMPT_CONTRACT_STAGES)[number];

/**
 * Bounded, redacted per-attempt diagnostic. Provider details are kept only in
 * run-scoped raw traces; this summary is what reaches Manager evidence and
 * published reviewer results.
 */
export interface ReviewAttemptDiagnostic {
  attempt: number;
  category: ReviewAttemptCategory;
  /** Explicit "unknown" when the provider exposes no termination reason. */
  termination_reason: string;
  output_tokens: number | null;
  output_token_limit: number | null;
  tool_argument_parse: ReviewAttemptToolParseState;
  contract_stage: ReviewAttemptContractStage;
  redacted_reason: string;
}

export interface ReviewAttemptClassificationInput {
  terminationReason?: unknown;
  toolArgumentParse?: unknown;
  contractStage?: unknown;
  redactedReason?: unknown;
  status?: unknown;
  vote?: unknown;
  transport?: boolean;
}

/**
 * Deterministic, provider-neutral failure classification. Missing provider
 * fields stay explicit "unknown"; a valid abstention is a reviewer decision,
 * not a transport or structured-output failure.
 */
export function classifyReviewAttemptCategory(
  input: ReviewAttemptClassificationInput,
): ReviewAttemptCategory {
  const reason = String(input.redactedReason ?? "").toUpperCase();
  if (input.transport === true || reason.includes("DAG_TRANSPORT_")) {
    return "transport_failed";
  }
  if (
    reason.includes("DAG_HANDOFF_CONTRACT_VIOLATION")
    || reason.includes("COVERAGE_ATTESTATION")
  ) {
    return "contract_validation_failed";
  }
  if (input.toolArgumentParse === "invalid") {
    return "handoff_arguments_invalid";
  }
  const termination = String(input.terminationReason ?? "").toUpperCase();
  if (termination === "TRUNCATED" || termination.includes("MAX_TOKENS") || termination === "MAXIMUM_TOKENS") {
    return "provider_output_truncated";
  }
  if (input.status === "failed" && input.vote === "abstain") {
    return "reviewer_abstained";
  }
  if (input.status === "complete" || input.contractStage === "accepted") {
    return "accepted";
  }
  return "unknown";
}

/** Bound and redact a diagnostic before persistence or publication. */
export function boundedReviewAttemptDiagnostic(
  diagnostic: ReviewAttemptDiagnostic,
): ReviewAttemptDiagnostic {
  return {
    attempt: Number.isSafeInteger(diagnostic.attempt) && diagnostic.attempt >= 1
      ? diagnostic.attempt
      : 1,
    category: REVIEW_ATTEMPT_CATEGORIES.includes(diagnostic.category)
      ? diagnostic.category
      : "unknown",
    termination_reason: String(diagnostic.termination_reason ?? "unknown")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 200) || "unknown",
    output_tokens: typeof diagnostic.output_tokens === "number" && Number.isFinite(diagnostic.output_tokens)
      ? Math.max(0, Math.floor(diagnostic.output_tokens))
      : null,
    output_token_limit: typeof diagnostic.output_token_limit === "number" && Number.isFinite(diagnostic.output_token_limit)
      ? Math.max(0, Math.floor(diagnostic.output_token_limit))
      : null,
    tool_argument_parse: REVIEW_ATTEMPT_TOOL_PARSE_STATES.includes(diagnostic.tool_argument_parse)
      ? diagnostic.tool_argument_parse
      : "unknown",
    contract_stage: REVIEW_ATTEMPT_CONTRACT_STAGES.includes(diagnostic.contract_stage)
      ? diagnostic.contract_stage
      : "unknown",
    redacted_reason: String(diagnostic.redacted_reason ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 1000),
  };
}

/** Deterministic finding deduplication key used by the pr-review scenario. */
export function reviewFindingKey(finding: { file?: unknown; line?: unknown; title?: unknown }): string {
  return [String(finding.file ?? ""), String(finding.line ?? ""), String(finding.title ?? "")].join(":");
}

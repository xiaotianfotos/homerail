/**
 * Shared PR Review scenario primitives.
 * @version 0.1.0
 */

import { redactTelemetry } from "./telemetry-redaction.js";
import {
  canonicalChangedFiles,
  changedFileCoverageAttestation,
  changedFileCoverageDigest,
  reviewFindingDedupKey,
  sha256Hex,
} from "./sha256.js";

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX64 = /^[0-9a-f]{64}$/;

export const CHANGED_FILE_COVERAGE_SCHEMA_ID = "changed-file-coverage-v1";
export const REVIEW_EVIDENCE_SCHEMA_ID = "review-evidence-v1";
export const REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID = "review-evidence-projection-v1";
export const ATTEMPT_DIAGNOSTIC_SCHEMA_ID = "attempt-diagnostic-v1";

export const REVIEW_MAX_FINDINGS = 50;
export const REVIEW_MAX_DIAGNOSTICS = 8;
export const REVIEW_FINDING_FIELD_LIMITS = {
  title: 300,
  file: 1000,
  evidence: 12000,
  recommendation: 8000,
} as const;
export const REVIEW_FINDING_MAX_BYTES = 32768;
export const REVIEW_DIAGNOSTIC_MAX_BYTES = 4096;
export const REVIEW_EVIDENCE_PROJECTION_MAX_BYTES = 65536;
const REVIEW_MAX_TOKEN_COUNT = 1_000_000_000;

export interface ValidationResultShape {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export interface ChangedFileCoverageAttestationV1 {
  schema: "changed-file-coverage-v1";
  digest: string;
  count: number;
}

export type ReviewFindingCategory = "runtime" | "security" | "tests" | "frontend";
export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low";
export type ReviewFindingConfidence = "high" | "medium" | "low";

export interface ReviewFindingV1 {
  /** Deterministic SHA-256 deduplication key (file, line, title). */
  id: string;
  category: ReviewFindingCategory;
  severity: ReviewFindingSeverity;
  title: string;
  file: string;
  line: number;
  evidence: string;
  recommendation: string;
  confidence: ReviewFindingConfidence;
}

export const REVIEW_FAILURE_CATEGORIES = [
  "provider_output_truncated",
  "handoff_arguments_invalid",
  "contract_validation_failed",
  "transport_failed",
  "reviewer_abstained",
  "accepted",
  "unknown",
] as const;

export type ReviewFailureCategory = (typeof REVIEW_FAILURE_CATEGORIES)[number];

export const REVIEW_TOOL_PARSE_STATES = ["valid", "invalid", "missing", "unknown"] as const;
export type ReviewToolArgumentParseState = (typeof REVIEW_TOOL_PARSE_STATES)[number];

export const REVIEW_CONTRACT_STAGES = [
  "tool_arguments",
  "contract_validation",
  "handoff_applied",
  "unknown",
] as const;
export type ReviewContractStage = (typeof REVIEW_CONTRACT_STAGES)[number];

/**
 * Provider-neutral bounded diagnostic for one review attempt. Fields that the
 * provider did not expose remain explicit null; never invent provider data.
 */
export interface AttemptDiagnosticV1 {
  schema: "attempt-diagnostic-v1";
  attempt: number;
  finish_reason: string | null;
  output_tokens: number | null;
  output_token_limit: number | null;
  tool_argument_parse_state: ReviewToolArgumentParseState;
  contract_stage: ReviewContractStage;
  failure_category: ReviewFailureCategory;
}

export interface ReviewEvidenceSubmissionV1 {
  schema: "review-evidence-v1";
  reviewer: string;
  coverage_attestation?: ChangedFileCoverageAttestationV1;
  findings: ReviewFindingV1[];
  diagnostics?: AttemptDiagnosticV1[];
}

export interface ReviewEvidenceProjectionV1 {
  schema: "review-evidence-projection-v1";
  reviewer: string;
  accepted_findings: ReviewFindingV1[];
  attempt_diagnostics: AttemptDiagnosticV1[];
  coverage_attestation?: ChangedFileCoverageAttestationV1 | null;
  projection_truncated: boolean;
  omitted_findings: number;
  omitted_diagnostics: number;
}

function validationResult(valid: boolean, errors: Array<{ path: string; message: string }> = []): ValidationResultShape {
  return { valid, errors };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Canonical trusted coverage for a changed-file inventory. */
export function canonicalChangedFileCoverage(files: readonly unknown[]): ChangedFileCoverageAttestationV1 {
  return changedFileCoverageAttestation(files);
}

/**
 * Strict attestation validation. A valid attestation must match the trusted
 * canonical digest and count exactly; anything else fails closed.
 */
export function validateChangedFileCoverageAttestation(
  value: unknown,
  expectedFiles: readonly unknown[],
): ValidationResultShape {
  const shape = validateChangedFileCoverageAttestationShape(value);
  if (!shape.valid) return shape;
  const attestation = record(value) as unknown as ChangedFileCoverageAttestationV1;
  const expected = changedFileCoverageDigest(expectedFiles);
  const errors: Array<{ path: string; message: string }> = [];
  if (attestation.count !== expected.count) {
    errors.push({
      path: "count",
      message: `count ${String(attestation.count)} does not match canonical coverage ${expected.count}`,
    });
  }
  if (attestation.digest !== expected.digest) {
    errors.push({ path: "digest", message: "digest does not match canonical changed-file coverage" });
  }
  return validationResult(errors.length === 0, errors);
}

/** Structural attestation validation without trusted file context. */
export function validateChangedFileCoverageAttestationShape(value: unknown): ValidationResultShape {
  const attestation = record(value);
  if (!attestation) {
    return validationResult(false, [{ path: "", message: "coverage attestation must be an object" }]);
  }
  if (attestation.schema !== CHANGED_FILE_COVERAGE_SCHEMA_ID) {
    return validationResult(false, [{ path: "schema", message: `schema must be ${CHANGED_FILE_COVERAGE_SCHEMA_ID}` }]);
  }
  const errors: Array<{ path: string; message: string }> = [];
  if (typeof attestation.digest !== "string" || !HEX64.test(attestation.digest)) {
    errors.push({ path: "digest", message: "digest must be 64 lowercase hex characters" });
  }
  if (!Number.isSafeInteger(attestation.count) || Number(attestation.count) < 0) {
    errors.push({ path: "count", message: "count must be a non-negative safe integer" });
  }
  return validationResult(errors.length === 0, errors);
}

export function coverageAttestationMatches(
  value: unknown,
  expectedFiles: readonly unknown[],
): boolean {
  return validateChangedFileCoverageAttestation(value, expectedFiles).valid;
}

/**
 * Normalize one model finding into the bounded durable shape. Returns
 * undefined when the finding is not a valid, bounded review finding.
 */
export function normalizeReviewFinding(value: unknown): ReviewFindingV1 | undefined {
  const finding = record(value);
  if (!finding) return undefined;
  const category = finding.category;
  const severity = finding.severity;
  const confidence = finding.confidence;
  if (!["runtime", "security", "tests", "frontend"].includes(String(category))) return undefined;
  if (!["critical", "high", "medium", "low"].includes(String(severity))) return undefined;
  if (!["high", "medium", "low"].includes(String(confidence))) return undefined;
  const line = finding.line;
  if (!Number.isSafeInteger(line) || Number(line) < 1) return undefined;

  const boundedText = (raw: unknown, limit: number): string | undefined => {
    if (typeof raw !== "string") return undefined;
    const redacted = String(redactTelemetry(raw)).trim();
    return redacted && redacted.length <= limit ? redacted : undefined;
  };
  const title = boundedText(finding.title, REVIEW_FINDING_FIELD_LIMITS.title);
  const file = boundedText(finding.file, REVIEW_FINDING_FIELD_LIMITS.file);
  const evidence = boundedText(finding.evidence, REVIEW_FINDING_FIELD_LIMITS.evidence);
  const recommendation = boundedText(finding.recommendation, REVIEW_FINDING_FIELD_LIMITS.recommendation);
  if (!title || !file || !evidence || !recommendation) return undefined;

  const normalized: ReviewFindingV1 = {
    id: reviewFindingDedupKey(file, Number(line), title),
    category: category as ReviewFindingCategory,
    severity: severity as ReviewFindingSeverity,
    title,
    file,
    line: Number(line),
    evidence,
    recommendation,
    confidence: confidence as ReviewFindingConfidence,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > REVIEW_FINDING_MAX_BYTES) return undefined;
  return normalized;
}

/** Deterministic deduplication key for a normalized finding. */
export function findingDedupKey(finding: ReviewFindingV1): string {
  return reviewFindingDedupKey(finding.file, finding.line, finding.title);
}

/**
 * Classify a bounded operational reason into the provider-neutral failure
 * category. Deliberate abstention is never reported as provider truncation.
 */
export function classifyReviewFailure(reason: unknown): ReviewFailureCategory {
  const text = typeof reason === "string" ? reason : String(reason ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";
  if (
    /(?:max[_ ]?tokens|output[_ ]?limit|truncat|stop[_ ]?reason[^A-Za-z]*max[_ ]?tokens|DAG_REVIEW_EVIDENCE_TRUNCATED)/i.test(normalized)
  ) {
    return "provider_output_truncated";
  }
  if (
    /(?:handoff.*(?:argument|parameter)|DAG_HANDOFF_ARGUMENTS_INVALID|unexpected.*(?:handoff|argument)|invalid.*(?:handoff|argument))/i.test(normalized)
  ) {
    return "handoff_arguments_invalid";
  }
  if (
    /(?:DAG_HANDOFF_CONTRACT_VIOLATION|DAG_HANDOFF_SCHEMA|contract[_ -]?valid|output contract|schema validation)/i.test(normalized)
  ) {
    return "contract_validation_failed";
  }
  if (
    /(?:transport|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|connection reset|timed out|timeout)/i.test(normalized)
  ) {
    return "transport_failed";
  }
  if (/(?:abstain|DAG_REVIEWER_ABSTAINED)/i.test(normalized)) {
    return "reviewer_abstained";
  }
  if (/(?:handoff_applied|accepted)/i.test(normalized)) {
    return "accepted";
  }
  return "unknown";
}

function finiteNumberOrNull(value: unknown): number | null {
  if (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= REVIEW_MAX_TOKEN_COUNT
  ) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= REVIEW_MAX_TOKEN_COUNT) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function boundedStringOrNull(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const redacted = String(redactTelemetry(value)).trim();
  if (!redacted) return null;
  return redacted.slice(0, limit);
}

function enumOrFallback<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T[number]
    : fallback;
}

/**
 * Sanitize a provider-neutral attempt diagnostic. Unknown provider fields
 * become explicit null; unknown enum values fall back to "unknown"; every
 * string is redacted and bounded. Returns undefined for non-object input.
 */
export function sanitizeAttemptDiagnostic(
  value: unknown,
  options: {
    attempt?: number;
    failure_reason?: unknown;
    contract_stage?: ReviewContractStage;
  } = {},
): AttemptDiagnosticV1 | undefined {
  const diagnostic = record(value);
  if (!diagnostic) return undefined;
  const rawAttempt = options.attempt ?? diagnostic.attempt;
  const attempt = typeof rawAttempt === "number" && Number.isSafeInteger(rawAttempt) && rawAttempt >= 1
    ? Math.min(rawAttempt, 1_000_000)
    : typeof rawAttempt === "string" && /^[1-9][0-9]{0,6}$/.test(rawAttempt.trim())
      ? Math.min(Number(rawAttempt.trim()), 1_000_000)
      : 1;
  const failureReason = typeof diagnostic.failure_reason === "string"
    ? diagnostic.failure_reason
    : options.failure_reason;
  const declaredCategory = enumOrFallback(diagnostic.failure_category, REVIEW_FAILURE_CATEGORIES, "unknown");
  const failureCategory = declaredCategory === "unknown"
    || (declaredCategory === "accepted" && options.failure_reason !== undefined)
    ? classifyReviewFailure(failureReason ?? diagnostic.finish_reason ?? "")
    : declaredCategory;
  const diagnosticValue: AttemptDiagnosticV1 = {
    schema: ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
    attempt,
    finish_reason: boundedStringOrNull(diagnostic.finish_reason, 128),
    output_tokens: finiteNumberOrNull(diagnostic.output_tokens),
    output_token_limit: finiteNumberOrNull(diagnostic.output_token_limit),
    tool_argument_parse_state: enumOrFallback(
      diagnostic.tool_argument_parse_state,
      REVIEW_TOOL_PARSE_STATES,
      "unknown",
    ),
    contract_stage: enumOrFallback(
      options.contract_stage ?? diagnostic.contract_stage,
      REVIEW_CONTRACT_STAGES,
      "unknown",
    ),
    failure_category: failureCategory,
  };
  if (Buffer.byteLength(JSON.stringify(diagnosticValue), "utf8") > REVIEW_DIAGNOSTIC_MAX_BYTES) {
    return undefined;
  }
  return diagnosticValue;
}

/**
 * Extract a bounded review evidence submission from handoff content. Supports
 * a bare `review-evidence-v1` object, a nested `evidence` field, and the
 * compact reviewer-shaped payload used by PR-review handoffs
 * (`reviewer` + `findings` + `coverage`). The attestation is normalized from
 * either a full `changed-file-coverage-v1` value or the compact
 * `{digest,count}` shape emitted by reviewers.
 * Returns undefined when no valid protocol evidence is present.
 */
function coverageAttestationFromUnknown(value: unknown): ChangedFileCoverageAttestationV1 | undefined {
  const coverage = record(value);
  if (!coverage) return undefined;
  const candidate = coverage.schema === CHANGED_FILE_COVERAGE_SCHEMA_ID
    ? coverage
    : typeof coverage.digest === "string" && typeof coverage.count === "number"
      ? {
          schema: CHANGED_FILE_COVERAGE_SCHEMA_ID,
          digest: coverage.digest,
          count: coverage.count,
        }
      : undefined;
  if (!candidate) return undefined;
  return validateChangedFileCoverageAttestationShape(candidate).valid
    ? candidate as unknown as ChangedFileCoverageAttestationV1
    : undefined;
}

function normalizeEvidenceSubmission(
  raw: Record<string, unknown>,
): ReviewEvidenceSubmissionV1 | undefined {
  const reviewer = typeof raw.reviewer === "string" && raw.reviewer.trim()
    ? raw.reviewer.trim().slice(0, 256)
    : undefined;
  if (!reviewer) return undefined;
  const findings: ReviewFindingV1[] = [];
  if (Array.isArray(raw.findings)) {
    for (const item of raw.findings.slice(0, REVIEW_MAX_FINDINGS * 2)) {
      const finding = normalizeReviewFinding(item);
      if (finding && !findings.some((existing) => existing.id === finding.id)) {
        findings.push(finding);
      }
      if (findings.length >= REVIEW_MAX_FINDINGS) break;
    }
  }
  const diagnostics: AttemptDiagnosticV1[] = [];
  if (Array.isArray(raw.diagnostics)) {
    for (const item of raw.diagnostics.slice(0, REVIEW_MAX_DIAGNOSTICS * 2)) {
      const diagnostic = sanitizeAttemptDiagnostic(item);
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }
  const attestation = coverageAttestationFromUnknown(raw.coverage_attestation ?? raw.coverage);
  if (findings.length === 0 && diagnostics.length === 0 && attestation === undefined) {
    return undefined;
  }
  const submission: ReviewEvidenceSubmissionV1 = {
    schema: REVIEW_EVIDENCE_SCHEMA_ID,
    reviewer,
    findings,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
  if (attestation) submission.coverage_attestation = attestation;
  return submission;
}

export function extractReviewEvidence(value: unknown): ReviewEvidenceSubmissionV1 | undefined {
  const content = record(value);
  if (!content) return undefined;
  const raw = content.schema === REVIEW_EVIDENCE_SCHEMA_ID
    ? content
    : record(content.evidence);
  if (raw) {
    if (raw.schema === REVIEW_EVIDENCE_SCHEMA_ID) {
      return normalizeEvidenceSubmission(raw);
    }
    const shaped = raw.schema === undefined ? normalizeEvidenceSubmission(raw) : undefined;
    if (shaped) return shaped;
  }
  if (content.schema === undefined && content.reviewer !== undefined) {
    return normalizeEvidenceSubmission(content);
  }
  return undefined;
}

/** Build a bounded correction/normalization evidence projection. */
export function buildReviewEvidenceProjection(input: {
  reviewer: string;
  findings: readonly ReviewFindingV1[];
  diagnostics: readonly AttemptDiagnosticV1[];
  coverage_attestation?: ChangedFileCoverageAttestationV1 | null;
}): ReviewEvidenceProjectionV1 | undefined {
  const reviewer = typeof input.reviewer === "string" && input.reviewer.trim()
    ? input.reviewer.trim().slice(0, 256)
    : "";
  if (!reviewer) return undefined;
  const findings: Array<{ finding: ReviewFindingV1; index: number }> = [];
  for (const item of input.findings) {
    const finding = normalizeReviewFinding(item);
    if (finding && !findings.some((existing) => existing.finding.id === finding.id)) {
      findings.push({ finding, index: findings.length });
    }
    if (findings.length >= REVIEW_MAX_FINDINGS) break;
  }
  const diagnostics: AttemptDiagnosticV1[] = [];
  for (const item of input.diagnostics.slice(0, REVIEW_MAX_DIAGNOSTICS)) {
    const diagnostic = sanitizeAttemptDiagnostic(item);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  const severityRank: Record<ReviewFindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  findings.sort((left, right) => (
    severityRank[left.finding.severity] - severityRank[right.finding.severity]
    || left.index - right.index
  ));
  const projection: ReviewEvidenceProjectionV1 = {
    schema: REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID,
    reviewer,
    accepted_findings: [],
    attempt_diagnostics: [],
    ...(input.coverage_attestation
      ? { coverage_attestation: input.coverage_attestation }
      : { coverage_attestation: null }),
    projection_truncated: true,
    omitted_findings: findings.length,
    omitted_diagnostics: diagnostics.length,
  };
  const withinProjectionLimit = (): boolean => (
    Buffer.byteLength(JSON.stringify(projection), "utf8") <= REVIEW_EVIDENCE_PROJECTION_MAX_BYTES
  );
  for (const { finding } of findings) {
    projection.accepted_findings.push(finding);
    projection.omitted_findings = findings.length - projection.accepted_findings.length;
    if (!withinProjectionLimit()) {
      projection.accepted_findings.pop();
      projection.omitted_findings = findings.length - projection.accepted_findings.length;
    }
  }
  // Diagnostics are advisory when space is constrained. Select newest first
  // so the normalizer retains the authoritative terminal attempt, then restore
  // chronological order in the projection.
  for (let index = diagnostics.length - 1; index >= 0; index--) {
    projection.attempt_diagnostics.unshift(diagnostics[index]!);
    projection.omitted_diagnostics = diagnostics.length - projection.attempt_diagnostics.length;
    if (!withinProjectionLimit()) {
      projection.attempt_diagnostics.shift();
      projection.omitted_diagnostics = diagnostics.length - projection.attempt_diagnostics.length;
    }
  }
  projection.projection_truncated = projection.omitted_findings > 0 || projection.omitted_diagnostics > 0;
  return projection;
}

/** Validate a correction/normalization evidence projection. */
export function validateReviewEvidenceProjection(value: unknown): ValidationResultShape {
  const projection = record(value);
  if (!projection) {
    return validationResult(false, [{ path: "", message: "evidence projection must be an object" }]);
  }
  const errors: Array<{ path: string; message: string }> = [];
  if (projection.schema !== REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID) {
    errors.push({ path: "schema", message: `schema must be ${REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID}` });
  }
  if (typeof projection.reviewer !== "string" || !projection.reviewer.trim()) {
    errors.push({ path: "reviewer", message: "reviewer must be a non-empty string" });
  }
  if (!Array.isArray(projection.accepted_findings)) {
    errors.push({ path: "accepted_findings", message: "accepted_findings must be an array" });
  } else if (projection.accepted_findings.some((item) => !normalizeReviewFinding(item))) {
    errors.push({ path: "accepted_findings", message: "accepted_findings contains an invalid finding" });
  }
  if (!Array.isArray(projection.attempt_diagnostics)) {
    errors.push({ path: "attempt_diagnostics", message: "attempt_diagnostics must be an array" });
  } else if (projection.attempt_diagnostics.some((item) => !sanitizeAttemptDiagnostic(item))) {
    errors.push({ path: "attempt_diagnostics", message: "attempt_diagnostics contains an invalid diagnostic" });
  }
  if (typeof projection.projection_truncated !== "boolean") {
    errors.push({ path: "projection_truncated", message: "projection_truncated must be a boolean" });
  }
  for (const field of ["omitted_findings", "omitted_diagnostics"] as const) {
    const maximum = field === "omitted_findings" ? REVIEW_MAX_FINDINGS : REVIEW_MAX_DIAGNOSTICS;
    if (
      !Number.isSafeInteger(projection[field])
      || Number(projection[field]) < 0
      || Number(projection[field]) > maximum
    ) {
      errors.push({ path: field, message: `${field} must be an integer between 0 and ${maximum}` });
    }
  }
  if (
    projection.projection_truncated === false
    && (projection.omitted_findings !== 0 || projection.omitted_diagnostics !== 0)
  ) {
    errors.push({ path: "projection_truncated", message: "an untruncated projection cannot omit evidence" });
  }
  if (
    projection.projection_truncated === true
    && projection.omitted_findings === 0
    && projection.omitted_diagnostics === 0
  ) {
    errors.push({ path: "projection_truncated", message: "a truncated projection must report omitted evidence" });
  }
  if (
    projection.coverage_attestation !== null
    && projection.coverage_attestation !== undefined
    && !validateChangedFileCoverageAttestationShape(projection.coverage_attestation).valid
  ) {
    errors.push({ path: "coverage_attestation", message: "coverage_attestation is invalid" });
  }
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > REVIEW_EVIDENCE_PROJECTION_MAX_BYTES) {
    errors.push({ path: "", message: "evidence projection exceeds the bounded byte limit" });
  }
  return validationResult(errors.length === 0, errors);
}

/** Canonical unique changed-file set (sorted, de-duplicated). */
export function canonicalChangedFilesList(files: readonly unknown[]): string[] {
  return canonicalChangedFiles(files);
}

/** SHA-256 hex helper re-exported for evidence digests. */
export { sha256Hex };

export {
  changedFileCoverageAttestation,
  changedFileCoverageDigest,
  reviewFindingDedupKey,
} from "./sha256.js";

/** Accept only complete SHA-1 or SHA-256 Git object identifiers. */
export function isFullGitRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_REVISION.test(value);
}

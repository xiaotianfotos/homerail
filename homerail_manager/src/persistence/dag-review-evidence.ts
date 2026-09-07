/**
 * Durable run-scoped review evidence.
 *
 * Accepted findings, compact coverage attestations, and provider-neutral
 * attempt diagnostics are stored append-only in the Manager DB, fenced to the
 * exact run/reviewer/node/session/round/generation while attempts accumulate
 * inside that fence. Re-delivery within one fence is idempotent: findings
 * deduplicate by deterministic finding id, diagnostics deduplicate per
 * attempt, and coverage deduplicates per round. Loaders and projections can
 * select one exact fence so evidence from a stale session/generation is never
 * aggregated into the current dispatch. A bounded redacted projection is
 * mirrored into the run workspace for deterministic command normalizers.
 * @version 0.1.0
 */

import { randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getHomerailHome } from "../config/env.js";
import { getDb, parseJsonRow } from "./db.js";
import { nowEpochMs } from "./time.js";
import {
  ATTEMPT_DIAGNOSTIC_SCHEMA_ID,
  REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID,
  buildReviewEvidenceProjection,
  extractReviewEvidence,
  normalizeReviewFinding,
  sanitizeAttemptDiagnostic,
  validateChangedFileCoverageAttestationShape,
  type AttemptDiagnosticV1,
  type ChangedFileCoverageAttestationV1,
  type ReviewEvidenceProjectionV1,
  type ReviewEvidenceSubmissionV1,
  type ReviewFindingV1,
} from "homerail-protocol";

export type ReviewEvidenceKind = "finding" | "diagnostic" | "coverage";

/**
 * One authoritative logical-dispatch fence. All writes, deduplication, reads,
 * and projections are scoped to this exact run/reviewer/node/session/round/
 * generation; attempts accumulate only within the fence.
 */
export interface ReviewEvidenceFence {
  runId: string;
  reviewer: string;
  nodeId: string;
  sessionId: string;
  roundId: string;
  generation: number;
}

export interface ReviewEvidenceIdentity extends ReviewEvidenceFence {
  attempt: number;
}

/**
 * Either a complete logical-dispatch fence or a full evidence identity. The
 * identity's `attempt` is intentionally ignored by fence-selection APIs; only
 * the authoritative run/reviewer/node/session/round/generation components
 * scope the read or projection.
 */
export type ReviewEvidenceFenceInput = ReviewEvidenceFence | ReviewEvidenceIdentity;

export interface ReviewEvidenceRecord {
  schemaVersion: 1;
  identity: ReviewEvidenceIdentity;
  kind: ReviewEvidenceKind;
  dedupKey: string;
  payload: ReviewFindingV1 | AttemptDiagnosticV1 | ChangedFileCoverageAttestationV1;
  createdAt: number;
}

export interface ReviewEvidenceWriteResult {
  status: "inserted" | "deduplicated";
  record?: ReviewEvidenceRecord;
}

export interface ReviewHandoffEvidenceInput {
  /** Provider-neutral transport diagnostic (from the Worker terminal payload). */
  transportDiagnostic?: unknown;
  /** Bounded evidence extracted from handoff content. */
  submission?: ReviewEvidenceSubmissionV1;
  /** Optional reason used to classify a failed attempt. */
  failureReason?: string;
}

export interface LoadedReviewEvidence {
  findings: ReviewFindingV1[];
  diagnostics: AttemptDiagnosticV1[];
  coverageAttestation?: ChangedFileCoverageAttestationV1 | null;
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) {
    throw new Error(`${label} must be a non-empty string of at most 256 characters`);
  }
  return value.trim();
}

function boundedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function validateFence(fence: ReviewEvidenceFence): ReviewEvidenceFence {
  return {
    runId: boundedIdentity(fence.runId, "evidence run_id"),
    reviewer: boundedIdentity(fence.reviewer, "evidence reviewer"),
    nodeId: boundedIdentity(fence.nodeId, "evidence node_id"),
    sessionId: boundedIdentity(fence.sessionId, "evidence session_id"),
    roundId: boundedIdentity(fence.roundId, "evidence round_id"),
    generation: boundedInteger(fence.generation, "evidence generation"),
  };
}

function validateIdentity(identity: ReviewEvidenceIdentity): ReviewEvidenceIdentity {
  const fence = validateFence(identity);
  return {
    ...fence,
    attempt: boundedInteger(identity.attempt, "evidence attempt"),
  };
}

function rowToRecord(row: {
  seq: number;
  schema_version: number;
  run_id: string;
  reviewer: string;
  node_id: string;
  session_id: string;
  round_id: string;
  generation: number;
  attempt: number;
  kind: ReviewEvidenceKind;
  dedup_key: string;
  payload_json: string;
  created_at: number;
}): ReviewEvidenceRecord {
  return {
    schemaVersion: row.schema_version as 1,
    identity: {
      runId: row.run_id,
      reviewer: row.reviewer,
      nodeId: row.node_id,
      sessionId: row.session_id,
      roundId: row.round_id,
      generation: row.generation,
      attempt: row.attempt,
    },
    kind: row.kind,
    dedupKey: row.dedup_key,
    payload: parseJsonRow<ReviewEvidenceRecord["payload"]>(row.payload_json),
    createdAt: row.created_at,
  };
}

function insertEvidence(
  identity: ReviewEvidenceIdentity,
  kind: ReviewEvidenceKind,
  dedupKey: string,
  payload: ReviewFindingV1 | AttemptDiagnosticV1 | ChangedFileCoverageAttestationV1,
  createdAt: number,
): ReviewEvidenceWriteResult {
  const db = getDb();
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 131072) {
    throw new Error("review evidence payload exceeds 128 KiB");
  }
  const result = db.prepare(`
    INSERT OR IGNORE INTO dag_review_evidence(
      schema_version, run_id, reviewer, node_id, session_id, round_id,
      generation, attempt, kind, dedup_key, payload_json, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.runId,
    identity.reviewer,
    identity.nodeId,
    identity.sessionId,
    identity.roundId,
    identity.generation,
    identity.attempt,
    kind,
    dedupKey,
    encoded,
    createdAt,
  );
  if (result.changes === 0) {
    return { status: "deduplicated" };
  }
  return {
    status: "inserted",
    record: {
      schemaVersion: 1,
      identity,
      kind,
      dedupKey,
      payload,
      createdAt,
    },
  };
}

/** Persist one bounded, redacted accepted finding (idempotent by finding id). */
export function recordReviewFinding(input: {
  identity: ReviewEvidenceIdentity;
  finding: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  const finding = normalizeReviewFinding(input.finding);
  if (!finding) throw new Error("review finding is invalid or exceeds bounded limits");
  return insertEvidence(
    identity,
    "finding",
    `finding:${finding.id}`,
    finding,
    input.createdAt ?? nowEpochMs(),
  );
}

/** Persist a compact coverage attestation (idempotent per round). */
export function recordReviewCoverage(input: {
  identity: ReviewEvidenceIdentity;
  attestation: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  if (!validateChangedFileCoverageAttestationShape(input.attestation).valid) {
    throw new Error("review coverage attestation is structurally invalid");
  }
  const attestation = input.attestation as ChangedFileCoverageAttestationV1;
  return insertEvidence(
    identity,
    "coverage",
    `coverage:${identity.roundId}`,
    attestation,
    input.createdAt ?? nowEpochMs(),
  );
}

/** Persist one bounded redacted attempt diagnostic (idempotent per attempt). */
export function recordAttemptDiagnostic(input: {
  identity: ReviewEvidenceIdentity;
  diagnostic: unknown;
  createdAt?: number;
}): ReviewEvidenceWriteResult {
  const identity = validateIdentity(input.identity);
  const diagnostic = sanitizeAttemptDiagnostic(input.diagnostic, { attempt: identity.attempt });
  if (!diagnostic || diagnostic.schema !== ATTEMPT_DIAGNOSTIC_SCHEMA_ID) {
    throw new Error("attempt diagnostic is invalid or exceeds bounded limits");
  }
  return insertEvidence(
    identity,
    "diagnostic",
    `attempt:${identity.attempt}`,
    diagnostic,
    input.createdAt ?? nowEpochMs(),
  );
}

/**
 * Persist everything carried by one accepted handoff: content findings,
 * coverage attestation, content diagnostics, and the transport diagnostic.
 */
export function recordReviewHandoffEvidence(
  identity: ReviewEvidenceIdentity,
  evidence: ReviewHandoffEvidenceInput,
): void {
  const validated = validateIdentity(identity);
  const safe = (write: () => ReviewEvidenceWriteResult): void => {
    try {
      write();
    } catch {
      // A single invalid item must never fail the authoritative handoff.
    }
  };
  for (const finding of evidence.submission?.findings ?? []) {
    safe(() => recordReviewFinding({ identity: validated, finding }));
  }
  if (evidence.submission?.coverage_attestation) {
    safe(() => recordReviewCoverage({
      identity: validated,
      attestation: evidence.submission?.coverage_attestation,
    }));
  }
  for (const diagnostic of evidence.submission?.diagnostics ?? []) {
    safe(() => recordAttemptDiagnostic({
      identity: validated,
      diagnostic: sanitizeAttemptDiagnostic(diagnostic, {
        attempt: validated.attempt,
        contract_stage: "handoff_applied",
      }),
    }));
  }
  if (evidence.transportDiagnostic !== undefined) {
    safe(() => recordAttemptDiagnostic({
      identity: validated,
      diagnostic: sanitizeAttemptDiagnostic(evidence.transportDiagnostic, {
        attempt: validated.attempt,
        failure_reason: evidence.failureReason,
        contract_stage: "handoff_applied",
      }),
    }));
  }
}

function assertFenceMatchesSelection(
  runId: string,
  reviewer: string | undefined,
  fence: ReviewEvidenceFence,
): ReviewEvidenceFence {
  const validated = validateFence(fence);
  if (validated.runId !== runId || (reviewer !== undefined && validated.reviewer !== reviewer)) {
    throw new Error("evidence fence does not match the requested run/reviewer");
  }
  return validated;
}

function resolveReviewEvidenceSelection(
  runIdOrContext: string | ReviewEvidenceFenceInput,
  reviewer?: string,
  fence?: ReviewEvidenceFence,
): { runId: string; reviewer: string; fence: ReviewEvidenceFence | undefined } {
  if (typeof runIdOrContext === "string") {
    if (reviewer === undefined) {
      throw new Error("evidence reviewer is required when selecting evidence by run id");
    }
    const runId = boundedIdentity(runIdOrContext, "evidence run_id");
    const actualReviewer = boundedIdentity(reviewer, "evidence reviewer");
    return {
      runId,
      reviewer: actualReviewer,
      fence: fence === undefined ? undefined : assertFenceMatchesSelection(runId, actualReviewer, fence),
    };
  }
  const validated = validateFence(runIdOrContext);
  return { runId: validated.runId, reviewer: validated.reviewer, fence: validated };
}

/**
 * Deterministic, traversal-safe, bounded path component. Safe characters are
 * preserved; anything else (or an over-long component) is replaced by a
 * stable SHA-256 digest so a raw identity value can never become a path.
 */
function pathSafeIdentityComponent(value: string): string {
  const raw = value.trim();
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  const safe = /^[A-Za-z0-9._-]+$/.test(raw) ? raw : `component-${digest}`;
  const maxLength = 80;
  return safe.length <= maxLength ? safe : `${safe.slice(0, 48)}-${digest}`;
}

/**
 * Relative workspace path for one reviewer's projection. Fence-scoped paths
 * include every validated identity component so stale sessions/rounds/
 * generations can never overwrite the current dispatch; the legacy
 * run/reviewer form stays reviewer-scoped for callers without a fence.
 */
function reviewEvidenceProjectionRelativePath(
  reviewer: string,
  fence: ReviewEvidenceFence | undefined,
): string {
  const safeReviewer = pathSafeIdentityComponent(reviewer);
  if (fence === undefined) {
    return path.join("review-evidence", safeReviewer, "projection.json");
  }
  return path.join(
    "review-evidence",
    safeReviewer,
    pathSafeIdentityComponent(fence.nodeId),
    pathSafeIdentityComponent(fence.sessionId),
    pathSafeIdentityComponent(fence.roundId),
    `generation-${fence.generation}.json`,
  );
}

/**
 * Exact run-workspace-relative path of the Manager-owned projection for one
 * logical review dispatch. The Worker receives this path only as a runtime
 * snapshot exclusion; workflow authors cannot add their own exclusions.
 */
export function reviewEvidenceProjectionWorkspacePath(
  context: ReviewEvidenceFenceInput,
): string {
  const selection = resolveReviewEvidenceSelection(context);
  return reviewEvidenceProjectionRelativePath(selection.reviewer, selection.fence)
    .replace(/\\/g, "/");
}

const REVIEW_EVIDENCE_COLUMNS = `
  seq, schema_version, run_id, reviewer, node_id, session_id,
  round_id, generation, attempt, kind, dedup_key, payload_json, created_at
`;

export function listReviewEvidenceRecords(
  runId: string,
  reviewer?: string,
  fence?: ReviewEvidenceFence,
): ReviewEvidenceRecord[] {
  const db = getDb();
  const conditions: string[] = ["run_id = ?"];
  const params: unknown[] = [runId];
  if (reviewer !== undefined) {
    conditions.push("reviewer = ?");
    params.push(reviewer);
  }
  if (fence !== undefined) {
    const validated = assertFenceMatchesSelection(runId, reviewer, fence);
    if (reviewer === undefined) {
      conditions.push("reviewer = ?");
      params.push(validated.reviewer);
    }
    conditions.push("node_id = ?", "session_id = ?", "round_id = ?", "generation = ?");
    params.push(validated.nodeId, validated.sessionId, validated.roundId, validated.generation);
  }
  const rows = db.prepare(`
    SELECT ${REVIEW_EVIDENCE_COLUMNS}
    FROM dag_review_evidence
    WHERE ${conditions.join(" AND ")}
    ORDER BY seq
  `).all(...params);
  return rows.map((row) => rowToRecord(row as Parameters<typeof rowToRecord>[0]));
}

/**
 * Load accepted findings, attempt diagnostics, and coverage for one reviewer.
 * Pass an exact logical-dispatch fence to exclude evidence from stale
 * sessions/rounds/generations while still accumulating every attempt inside
 * that fence.
 */
export function loadReviewEvidence(
  runId: string,
  reviewer: string,
  fence?: ReviewEvidenceFence,
): LoadedReviewEvidence {
  const records = listReviewEvidenceRecords(runId, reviewer, fence);
  const findings: ReviewFindingV1[] = [];
  const diagnostics: AttemptDiagnosticV1[] = [];
  let coverageAttestation: ChangedFileCoverageAttestationV1 | null = null;
  for (const record of records) {
    if (record.kind === "finding" && !findings.some((item) => item.id === (record.payload as ReviewFindingV1).id)) {
      findings.push(record.payload as ReviewFindingV1);
    } else if (record.kind === "diagnostic") {
      diagnostics.push(record.payload as AttemptDiagnosticV1);
    } else if (record.kind === "coverage") {
      coverageAttestation = record.payload as ChangedFileCoverageAttestationV1;
    }
  }
  return {
    findings,
    diagnostics,
    ...(coverageAttestation ? { coverageAttestation } : {}),
  };
}

/**
 * Build the bounded correction/normalization projection for one reviewer.
 * Pass the authoritative logical-dispatch fence so the projection never
 * aggregates evidence from stale sessions/rounds/generations.
 */
export function buildReviewEvidenceProjectionFor(
  context: ReviewEvidenceFenceInput,
): ReviewEvidenceProjectionV1 | undefined;
export function buildReviewEvidenceProjectionFor(
  runId: string,
  reviewer: string,
  fence?: ReviewEvidenceFence,
): ReviewEvidenceProjectionV1 | undefined;
export function buildReviewEvidenceProjectionFor(
  runIdOrContext: string | ReviewEvidenceFenceInput,
  reviewer?: string,
  fence?: ReviewEvidenceFence,
): ReviewEvidenceProjectionV1 | undefined {
  const selection = resolveReviewEvidenceSelection(runIdOrContext, reviewer, fence);
  const loaded = loadReviewEvidence(selection.runId, selection.reviewer, selection.fence);
  return buildReviewEvidenceProjection({
    reviewer: selection.reviewer,
    findings: loaded.findings,
    diagnostics: loaded.diagnostics,
    coverage_attestation: loaded.coverageAttestation ?? null,
  });
}

function safeRunWorkspace(runId: string): string | undefined {
  const home = getHomerailHome();
  const workspaceRoot = path.resolve(home, "workspace");
  const segments = runId.split("/").filter((segment) => /^[A-Za-z0-9._-]+$/.test(segment));
  if (segments.length === 0 || segments.join("/") !== runId) return undefined;
  const candidate = path.resolve(workspaceRoot, ...segments);
  const relative = path.relative(workspaceRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return candidate;
}

/**
 * Mirror a bounded redacted evidence projection into the run workspace so
 * deterministic command normalizers can consume Manager-owned evidence
 * without trusting a later truncated handoff.
 */
export function writeReviewEvidenceProjectionFile(context: ReviewEvidenceFenceInput): boolean;
export function writeReviewEvidenceProjectionFile(
  runId: string,
  reviewer: string,
  fence?: ReviewEvidenceFence,
): boolean;
export function writeReviewEvidenceProjectionFile(
  runIdOrContext: string | ReviewEvidenceFenceInput,
  reviewer?: string,
  fence?: ReviewEvidenceFence,
): boolean {
  try {
    const selection = resolveReviewEvidenceSelection(runIdOrContext, reviewer, fence);
    const projection = buildReviewEvidenceProjectionFor(selection.runId, selection.reviewer, selection.fence);
    if (!projection) return false;
    const runWorkspace = safeRunWorkspace(selection.runId);
    if (!runWorkspace) return false;
    const target = path.join(
      runWorkspace,
      reviewEvidenceProjectionRelativePath(selection.reviewer, selection.fence),
    );
    const evidenceDir = path.dirname(target);
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      evidenceDir,
      `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    try {
      // Atomic replacement: readers never observe a partially written JSON.
      fs.writeFileSync(temporary, JSON.stringify(projection), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
      try {
        fs.chmodSync(evidenceDir, 0o700);
        fs.chmodSync(target, 0o600);
      } catch {
        // Best-effort permissions on platforms without POSIX modes.
      }
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {
        // Best-effort cleanup of an aborted temporary file.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Build the workspace projection path for a run/reviewer (read-only helper). */
export function reviewEvidenceProjectionPath(context: ReviewEvidenceFenceInput): string | undefined;
export function reviewEvidenceProjectionPath(
  runId: string,
  reviewer: string,
  fence?: ReviewEvidenceFence,
): string | undefined;
export function reviewEvidenceProjectionPath(
  runIdOrContext: string | ReviewEvidenceFenceInput,
  reviewer?: string,
  fence?: ReviewEvidenceFence,
): string | undefined {
  const selection = resolveReviewEvidenceSelection(runIdOrContext, reviewer, fence);
  const runWorkspace = safeRunWorkspace(selection.runId);
  if (!runWorkspace) return undefined;
  return path.join(runWorkspace, reviewEvidenceProjectionRelativePath(selection.reviewer, selection.fence));
}

export { REVIEW_EVIDENCE_PROJECTION_SCHEMA_ID, extractReviewEvidence };

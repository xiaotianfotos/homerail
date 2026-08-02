/**
 * Bounded Manager-owned PR review evidence.
 *
 * Accepted reviewer findings, attempt diagnostics, and compact coverage
 * attestations are persisted here so they survive a later incomplete handoff
 * and a Manager cold restart. Writes are fenced to the exact run, node,
 * logical session, generation, and attempt; stale or cross-node writes are
 * rejected. Provider details never enter this store — only bounded, redacted
 * summaries do.
 * @version 0.1.0
 */

import { createHash } from "node:crypto";
import {
  boundedReviewAttemptDiagnostic,
  changedFilesCoverage,
  MAX_REVIEW_ACCEPTED_FINDINGS,
  MAX_REVIEW_ATTEMPTS,
  reviewFindingKey,
  type ChangedFilesCoverage,
  type ReviewAttemptCategory,
  type ReviewAttemptContractStage,
  type ReviewAttemptDiagnostic,
  type ReviewAttemptToolParseState,
} from "homerail-protocol";
import { getDagActorByNode } from "./dag-actors.js";
import { encodeJson, getDb, parseJsonRow } from "./db.js";

export const MAX_REVIEW_EVIDENCE_JSON_BYTES = 1024 * 1024;

const REVIEWER_NODE_RE = /^(qwen|kimi|glm)_review$/;

export function reviewerFromNodeId(nodeId: string): string | undefined {
  const match = REVIEWER_NODE_RE.exec(nodeId);
  return match?.[1];
}

export function isPrReviewReviewerNode(nodeId: string): boolean {
  return reviewerFromNodeId(nodeId) !== undefined;
}

export function normalizeNodeForReviewer(reviewer: string): string {
  return `normalize_${reviewer}_review`;
}

export interface ReviewAttemptEvidenceRecord {
  runId: string;
  nodeId: string;
  reviewer: string;
  sessionId: string;
  generation: number;
  attempt: number;
  evidenceKind: "attempt" | "findings" | "coverage";
  digest: string;
  evidence: unknown;
  createdAt: number;
}

export interface ReviewNodeEvidence {
  findings: Array<Record<string, unknown>>;
  attempts: ReviewAttemptDiagnostic[];
  coverage: ChangedFilesCoverage | null;
}

function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(encodeJson(value), "utf8").digest("hex");
}

function evidenceFromRow(row: Record<string, unknown>): ReviewAttemptEvidenceRecord {
  return {
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    reviewer: String(row.reviewer),
    sessionId: String(row.session_id),
    generation: Number(row.generation),
    attempt: Number(row.attempt),
    evidenceKind: String(row.evidence_kind) as ReviewAttemptEvidenceRecord["evidenceKind"],
    digest: String(row.evidence_digest),
    evidence: parseJsonRow(String(row.evidence_json)),
    createdAt: Number(row.created_at),
  };
}

function dedupeFindings(findings: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(findings)) return [];
  const seen = new Set<string>();
  const accepted: Array<Record<string, unknown>> = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    const record = finding as Record<string, unknown>;
    const key = reviewFindingKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(record);
    if (accepted.length >= MAX_REVIEW_ACCEPTED_FINDINGS) break;
  }
  return accepted;
}

export interface PersistReviewAttemptEvidenceInput {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId: string;
  generation: number;
  category: ReviewAttemptCategory;
  terminationReason?: string | null;
  outputTokens?: number | null;
  outputTokenLimit?: number | null;
  toolArgumentParse?: ReviewAttemptToolParseState;
  contractStage?: ReviewAttemptContractStage;
  redactedReason?: string;
  findings?: readonly unknown[];
  /** Trusted changed-file coverage resolved from the run's review context. */
  coverage?: ChangedFilesCoverage | null;
}

export interface PersistReviewAttemptEvidenceResult {
  stored: boolean;
  reason?: string;
}

/**
 * Persist one bounded attempt. Fencing is fail-closed: the write is rejected
 * unless the payload session and generation match the current logical actor.
 * Duplicate (run, node, kind, attempt) writes are idempotent.
 */
export function persistReviewAttemptEvidence(
  input: PersistReviewAttemptEvidenceInput,
): PersistReviewAttemptEvidenceResult {
  const reviewer = reviewerFromNodeId(input.nodeId);
  if (!reviewer) {
    return { stored: false, reason: "evidence node is not a PR review reviewer node" };
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > MAX_REVIEW_ATTEMPTS) {
    return { stored: false, reason: `attempt must be between 1 and ${MAX_REVIEW_ATTEMPTS}` };
  }
  const actor = getDagActorByNode(input.runId, input.nodeId);
  if (!actor) {
    return { stored: false, reason: "review actor record is missing" };
  }
  if (!actor.session_id || input.sessionId !== actor.session_id) {
    return { stored: false, reason: "review evidence session fence mismatch" };
  }
  if (input.generation !== actor.generation) {
    return { stored: false, reason: "review evidence generation fence mismatch" };
  }
  if (!input.coverage) {
    return { stored: false, reason: "trusted changed-file coverage is required" };
  }

  const diagnostic = boundedReviewAttemptDiagnostic({
    attempt: input.attempt,
    category: input.category,
    termination_reason: input.terminationReason ?? "unknown",
    output_tokens: input.outputTokens ?? null,
    output_token_limit: input.outputTokenLimit ?? null,
    tool_argument_parse: input.toolArgumentParse ?? "unknown",
    contract_stage: input.contractStage ?? "unknown",
    redacted_reason: input.redactedReason ?? "",
  });
  if (Buffer.byteLength(encodeJson(diagnostic), "utf8") > 4096) {
    return { stored: false, reason: "review attempt diagnostic exceeds the bounded size" };
  }
  const findings = dedupeFindings(input.findings);
  const coverage = input.coverage;
  const rows: Array<{ kind: "attempt" | "findings" | "coverage"; value: unknown }> = [
    { kind: "attempt", value: diagnostic },
  ];
  if (findings.length > 0) rows.push({ kind: "findings", value: findings });
  if (coverage) rows.push({ kind: "coverage", value: { digest: coverage.digest.toLowerCase(), count: coverage.count } });
  for (const row of rows) {
    const serialized = encodeJson(row.value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_EVIDENCE_JSON_BYTES) {
      return { stored: false, reason: `${row.kind} evidence exceeds the bounded size` };
    }
  }

  const now = Date.now();
  getDb().transaction(() => {
    for (const row of rows) {
      getDb().prepare(`
        INSERT OR IGNORE INTO dag_review_evidence(
          run_id, node_id, reviewer, session_id, generation, attempt,
          evidence_kind, evidence_digest, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.nodeId,
        reviewer,
        actor.session_id,
        actor.generation,
        input.attempt,
        row.kind,
        evidenceDigest(row.value),
        encodeJson(row.value),
        now,
      );
    }
  })();
  return { stored: true };
}

function loadEvidenceRows(runId: string, nodeId: string): ReviewAttemptEvidenceRecord[] {
  return (getDb().prepare(`
    SELECT * FROM dag_review_evidence
    WHERE run_id = ? AND node_id = ?
    ORDER BY attempt, evidence_kind
  `).all(runId, nodeId) as Array<Record<string, unknown>>)
    .map(evidenceFromRow);
}

export function loadReviewAttemptEvidence(runId: string, nodeId: string): ReviewNodeEvidence {
  const rows = loadEvidenceRows(runId, nodeId);
  const attempts: ReviewAttemptDiagnostic[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const seenFindings = new Set<string>();
  let coverage: ChangedFilesCoverage | null = null;
  for (const row of rows) {
    if (row.evidenceKind === "attempt" && row.attempt <= MAX_REVIEW_ATTEMPTS) {
      attempts.push(row.evidence as ReviewAttemptDiagnostic);
    } else if (row.evidenceKind === "findings") {
      for (const finding of dedupeFindings(row.evidence)) {
        if (findings.length >= MAX_REVIEW_ACCEPTED_FINDINGS) break;
        const key = reviewFindingKey(finding);
        if (seenFindings.has(key)) continue;
        seenFindings.add(key);
        findings.push(finding);
      }
    } else if (row.evidenceKind === "coverage") {
      const candidate = row.evidence as ChangedFilesCoverage;
      if (
        candidate
        && typeof candidate.digest === "string"
        && /^[0-9a-f]{64}$/i.test(candidate.digest)
        && Number.isSafeInteger(candidate.count)
        && candidate.count >= 0
      ) {
        coverage = { digest: candidate.digest.toLowerCase(), count: candidate.count };
      }
    }
  }
  return { findings, attempts, coverage };
}

export interface ReviewCorrectionState {
  findings: Array<Record<string, unknown>>;
  attempts: ReviewAttemptDiagnostic[];
  coverage: ChangedFilesCoverage | null;
}

/** Bounded accepted state offered to a correction turn. */
export function reviewEvidenceCorrectionState(runId: string, nodeId: string): ReviewCorrectionState | undefined {
  const evidence = loadReviewAttemptEvidence(runId, nodeId);
  if (evidence.attempts.length === 0 && evidence.findings.length === 0 && evidence.coverage === null) {
    return undefined;
  }
  return {
    findings: evidence.findings,
    attempts: evidence.attempts,
    coverage: evidence.coverage,
  };
}

export interface ReviewEvidenceMailboxRun {
  runId: string;
  dagRun: {
    mailboxes: Map<string, Map<string, unknown[]>>;
  };
}

/**
 * Inject the durable evidence into the downstream normalize node's mailbox.
 * The value is serialized with the run metadata so a cold restart can replay
 * it before normalization dispatches.
 */
export function injectReviewerEvidenceMailbox(
  run: ReviewEvidenceMailboxRun,
  nodeId: string,
): boolean {
  const reviewer = reviewerFromNodeId(nodeId);
  if (!reviewer) return false;
  const evidence = loadReviewAttemptEvidence(run.runId, nodeId);
  const mailbox = run.dagRun.mailboxes.get(normalizeNodeForReviewer(reviewer));
  if (!mailbox) return false;
  mailbox.set("evidence", [{
    findings: evidence.findings,
    attempts: evidence.attempts,
    coverage: evidence.coverage,
  }]);
  return true;
}

/** Resolve trusted changed-file coverage from the run's prepared context. */
export function resolveTrustedCoverageFromRun(
  runId: string,
  handoffs: ReadonlyArray<{ fromNode: string; port: string; content?: unknown }>,
): ChangedFilesCoverage | null {
  for (let index = handoffs.length - 1; index >= 0; index -= 1) {
    const record = handoffs[index];
    if (record.fromNode !== "build_review_context" || record.port !== "ready") continue;
    const content = record.content;
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const changed = (content as Record<string, unknown>).changed_files;
    if (!Array.isArray(changed) || changed.some((path) => typeof path !== "string")) continue;
    return changedFilesCoverage(changed as string[]);
  }
  return null;
}

#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const findingFields = [
  "category",
  "severity",
  "title",
  "file",
  "line",
  "evidence",
  "recommendation",
  "confidence",
];

function findingKey(finding) {
  return findingFields.map((field) => JSON.stringify(finding?.[field] ?? null)).join("\u0000");
}

export function validatePrReviewArtifacts(command, publication, markdown) {
  invariant(command && typeof command === "object" && !Array.isArray(command), "command.json root is not an object");
  invariant(
    typeof command.run_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(command.run_id),
    "command.json has no canonical run_id",
  );
  invariant(["completed", "cancelled"].includes(command.status), `run status is ${JSON.stringify(command.status)}`);

  const artifacts = new Map(
    (Array.isArray(command.artifacts) ? command.artifacts : []).map((artifact) => [artifact?.name, artifact]),
  );
  for (const name of ["pr-review.json"]) {
    invariant(artifacts.get(name)?.status === "ready", `${name} is not ready in command.json`);
  }

  invariant(publication && typeof publication === "object" && !Array.isArray(publication), "JSON root is not an object");
  invariant(
    publication.report && typeof publication.report === "object" && !Array.isArray(publication.report),
    "JSON has no structured report",
  );
  invariant(
    publication.quorum && typeof publication.quorum === "object" && !Array.isArray(publication.quorum),
    "JSON has no structured quorum",
  );

  const { report, quorum } = publication;
  invariant(quorum.total === 3 && quorum.threshold === 2, "JSON quorum is not the declared 2-of-3 vote");
  invariant(Number.isInteger(quorum.successes) && quorum.successes >= 0 && quorum.successes <= 3, "invalid quorum successes");
  invariant(typeof quorum.passed === "boolean", "invalid quorum passed flag");
  invariant(!quorum.passed || quorum.successes >= quorum.threshold, "a passed quorum lacks enough approvals");
  invariant(
    report.coverage
      && typeof report.coverage === "object"
      && !Array.isArray(report.coverage)
      && typeof report.coverage.digest === "string"
      && /^[0-9a-f]{64}$/.test(report.coverage.digest)
      && Number.isInteger(report.coverage.count)
      && report.coverage.count >= 0
      && report.coverage.count <= 5000,
    "report does not carry a canonical trusted coverage attestation",
  );

  if (quorum.passed) {
    invariant(command.status === "completed", "a passed quorum did not produce a completed run");
    invariant(report.status === "pass", "a passed quorum has an invalid report status");
  } else {
    invariant(command.status === "cancelled", "a rejected quorum did not produce a cancelled run");
    invariant(["findings", "inconclusive"].includes(report.status), "a rejected quorum has an invalid report status");
  }
  if (report.status === "pass") invariant(report.actionable_count === 0, "a passing report has actionable findings");
  if (report.status === "findings") {
    invariant(Number.isInteger(report.actionable_count) && report.actionable_count > 0, "a findings report has no actionable findings");
  }
  invariant(Array.isArray(report.findings), "report findings are missing");
  invariant(report.actionable_count === report.findings.length, "actionable_count does not match report findings");
  invariant(
    Array.isArray(report.reviewer_results) && report.reviewer_results.length === 3,
    "report does not contain three model reviewer results",
  );
  const reviewerNames = new Set();
  const reviewerFindingKeys = new Set();
  let approvals = 0;
  let changesRequested = 0;
  for (const reviewer of report.reviewer_results) {
    invariant(reviewer && typeof reviewer === "object" && !Array.isArray(reviewer), "reviewer result is not an object");
    invariant(["qwen", "kimi", "glm"].includes(reviewer.reviewer), "reviewer result has an invalid model identity");
    reviewerNames.add(reviewer.reviewer);
    invariant(["complete", "failed"].includes(reviewer.status), `${reviewer.reviewer} reviewer status is invalid`);
    invariant(["approve", "request_changes", "abstain"].includes(reviewer.vote), `${reviewer.reviewer} reviewer vote is invalid`);
    invariant(
      reviewer.coverage
        && typeof reviewer.coverage === "object"
        && !Array.isArray(reviewer.coverage)
        && typeof reviewer.coverage.digest === "string"
        && /^[0-9a-f]{64}$/.test(reviewer.coverage.digest)
        && Number.isInteger(reviewer.coverage.count)
        && reviewer.coverage.count >= 0
        && reviewer.coverage.count <= 5000,
      `${reviewer.reviewer} coverage attestation is malformed`,
    );
    const coverageMatchesReport = reviewer.coverage.digest === report.coverage.digest
      && reviewer.coverage.count === report.coverage.count;
    invariant(Array.isArray(reviewer.findings), `${reviewer.reviewer} findings are missing`);
    invariant(Array.isArray(reviewer.reviewed_files), `${reviewer.reviewer} reviewed_files is missing`);
    invariant(Array.isArray(reviewer.unreviewed_files), `${reviewer.reviewer} unreviewed_files is missing`);
    invariant(typeof reviewer.evidence_truncated === "boolean", `${reviewer.reviewer} evidence_truncated is missing`);
    invariant(Array.isArray(reviewer.diagnostics) && reviewer.diagnostics.length > 0, `${reviewer.reviewer} diagnostics are missing`);
    invariant(reviewer.diagnostics.length <= 8, `${reviewer.reviewer} diagnostics exceed the bounded attempt history`);
    validateAttemptDiagnostics(reviewer.diagnostics, reviewer.reviewer);
    const reviewedFiles = new Set(reviewer.reviewed_files);
    for (const file of reviewer.reviewed_files) {
      invariant(typeof file === "string" && file.length > 0, `${reviewer.reviewer} reviewed_files contains an invalid path`);
    }
    for (const file of reviewer.unreviewed_files) {
      invariant(typeof file === "string" && file.length > 0, `${reviewer.reviewer} unreviewed_files contains an invalid path`);
      invariant(!reviewedFiles.has(file), `${reviewer.reviewer} both reviewed and skipped ${file}`);
    }
    if (reviewer.status === "complete") {
      invariant(coverageMatchesReport, `${reviewer.reviewer} completed without the canonical coverage attestation`);
      invariant(reviewer.evidence_truncated === false, `${reviewer.reviewer} used truncated evidence`);
      invariant(reviewer.unreviewed_files.length === 0, `${reviewer.reviewer} left changed files unreviewed`);
      invariant(
        reviewer.coverage.count === 0 || reviewer.reviewed_files.length > 0,
        `${reviewer.reviewer} completed without canonical reviewed files`,
      );
      invariant(lastDiagnosticCategory(reviewer.diagnostics) === "accepted", `${reviewer.reviewer} completed without an accepted attempt category`);
      if (reviewer.vote === "approve") {
        approvals++;
        invariant(reviewer.findings.length === 0, `${reviewer.reviewer} approved with actionable findings`);
      } else {
        invariant(reviewer.vote === "request_changes", `${reviewer.reviewer} completed without a decisive vote`);
        changesRequested++;
        invariant(reviewer.findings.length > 0, `${reviewer.reviewer} requested changes without findings`);
        for (const finding of reviewer.findings) reviewerFindingKeys.add(findingKey(finding));
      }
    } else {
      invariant(reviewer.vote === "abstain", `${reviewer.reviewer} failed without abstaining`);
      const category = lastDiagnosticCategory(reviewer.diagnostics);
      const failureCategories = new Set([
        "provider_output_truncated",
        "handoff_arguments_invalid",
        "contract_validation_failed",
        "transport_failed",
        "unknown",
      ]);
      if (category === "reviewer_abstained") {
        invariant(reviewer.evidence_truncated === false, `${reviewer.reviewer} deliberate abstention was reported as truncation`);
      } else {
        invariant(failureCategories.has(category), `${reviewer.reviewer} failed with an invalid attempt category`);
        invariant(reviewer.evidence_truncated === true, `${reviewer.reviewer} failed without marking incomplete evidence`);
      }
      if (!coverageMatchesReport) {
        invariant(reviewer.reviewed_files.length === 0, `${reviewer.reviewer} claimed reviewed files without the canonical coverage attestation`);
      }
      invariant(
        reviewer.reviewed_files.length === 0 || reviewer.unreviewed_files.length === 0,
        `${reviewer.reviewer} both reviewed and skipped files after a failed vote`,
      );
      for (const finding of reviewer.findings) reviewerFindingKeys.add(findingKey(finding));
    }
  }
  invariant(reviewerNames.size === 3, "model reviewer identities are not distinct");
  const completeReviews = approvals + changesRequested;
  const expectedConfidence = completeReviews === 3 ? "high" : completeReviews === 2 ? "medium" : "low";
  invariant(report.confidence === expectedConfidence, "report confidence does not match complete reviewer evidence");
  const reportedFindingKeys = new Set(report.findings.map(findingKey));
  invariant(
    reviewerFindingKeys.size === reportedFindingKeys.size && [...reviewerFindingKeys].every((key) => reportedFindingKeys.has(key)),
    "published findings do not preserve the complete deduplicated reviewer finding set",
  );
  invariant(quorum.successes === approvals, "published quorum does not match the model approval votes");
  invariant(
    report.reviewer_results.every((reviewer) => reviewer.reviewed_files.length === 0 || reviewer.unreviewed_files.length === 0),
    "a reviewer cannot claim both reviewed and unreviewed files",
  );
  invariant(quorum.passed === (approvals >= 2 && report.actionable_count === 0), "quorum pass must require two approvals and zero retained findings");
  if (report.status === "pass") invariant(approvals >= 2, "passing report lacks two model approvals");
  if (report.status === "inconclusive") {
    invariant(approvals < 2 && report.actionable_count === 0, "inconclusive report has enough approvals or retained findings");
  }

  const serializedDiagnostics = JSON.stringify(
    report.reviewer_results.flatMap((reviewer) => reviewer.diagnostics ?? []),
  );
  const forbiddenDiagnostic = [
    /-----BEGIN [A-Z ]+-----/,
    /\bBearer\s+[A-Za-z0-9._~+/-]+/i,
    /\b(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]/i,
    /https?:\/\//i,
    /\b[A-Za-z0-9_-]{48,}\b/,
  ];
  invariant(
    !forbiddenDiagnostic.some((pattern) => pattern.test(serializedDiagnostics)),
    "reviewer diagnostics contain an unredacted value",
  );

  const runIdLine = `**HomeRail Run ID:** \`${command.run_id}\``;
  invariant(markdown.includes(runIdLine), "Markdown does not contain the exact HomeRail run_id field");
  invariant(!/\$\{run_id\}|not available in runtime context/i.test(markdown), "Markdown contains a run_id placeholder");
  invariant(markdown.includes(report.repo), "Markdown does not contain the reviewed repository");
  invariant(markdown.includes(report.base) && markdown.includes(report.head), "Markdown does not contain the reviewed base and head");
  invariant(markdown.toLowerCase().includes(String(report.status).toLowerCase()), "Markdown does not contain the report status");
  invariant(/quorum/i.test(markdown), "Markdown does not contain the quorum result");
}

const attemptCategories = new Set([
  "accepted",
  "provider_output_truncated",
  "handoff_arguments_invalid",
  "contract_validation_failed",
  "transport_failed",
  "reviewer_abstained",
  "unknown",
]);
const toolArgumentParseStates = new Set(["parsed", "parse_failed", "missing"]);
const contractValidationStages = new Set([
  "handoff_shape",
  "coverage_attestation",
  "findings_bounded",
  "contract_validated",
  "none",
]);

function lastDiagnosticCategory(diagnostics) {
  return diagnostics.length > 0 && typeof diagnostics.at(-1)?.category === "string"
    ? diagnostics.at(-1).category
    : undefined;
}

function validateNullableString(value, label, maxLength) {
  invariant(value == null || (typeof value === "string" && value.length >= 1 && value.length <= maxLength), `${label} is invalid`);
}

function validateNullableInteger(value, label, maximum) {
  invariant(
    value == null || (Number.isInteger(value) && value >= 0 && value <= maximum),
    `${label} is invalid`,
  );
}

function validateAttemptDiagnostics(diagnostics, reviewer) {
  for (const diagnostic of diagnostics) {
    invariant(diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic), `${reviewer} attempt diagnostic is not an object`);
    invariant(Number.isInteger(diagnostic.attempt) && diagnostic.attempt >= 1 && diagnostic.attempt <= 8, `${reviewer} attempt diagnostic has an invalid attempt`);
    invariant(attemptCategories.has(diagnostic.category), `${reviewer} attempt diagnostic has an invalid category`);
    validateNullableString(diagnostic.finish_reason, `${reviewer} finish_reason`, 128);
    validateNullableInteger(diagnostic.output_tokens, `${reviewer} output_tokens`, 1_000_000_000);
    validateNullableInteger(diagnostic.output_token_limit, `${reviewer} output_token_limit`, 1_000_000_000);
    invariant(
      diagnostic.tool_arguments_parse_state == null || toolArgumentParseStates.has(diagnostic.tool_arguments_parse_state),
      `${reviewer} tool_arguments_parse_state is invalid`,
    );
    invariant(
      diagnostic.contract_validation_stage == null || contractValidationStages.has(diagnostic.contract_validation_stage),
      `${reviewer} contract_validation_stage is invalid`,
    );
    validateNullableString(diagnostic.message, `${reviewer} diagnostic message`, 2048);
  }
}

const privacyCategories = new Set([
  "absolute_path",
  "local_network",
  "local_hostname",
  "local_identity",
  "email",
  "credential",
  "certificate",
  "internal_service",
  "incomplete_evidence",
  "reviewer_failure",
  "other",
]);
const privacySources = new Set(["diff", "commit_metadata", "review_context"]);
const privacyConfidence = new Set(["high", "medium", "low"]);

function isSafePrivacyLocation(location) {
  if (location === "review-context") return true;
  if (/^commit:(?:[0-9a-f]{12}|[0-9a-f]{40}) metadata$/.test(location)) return true;
  if (!/^[^\\:\u0000-\u001f\u007f]+(?::[1-9][0-9]*)?$/.test(location)) return false;
  const file = location.replace(/:[1-9][0-9]*$/, "");
  return !file.startsWith("/") && !file.split("/").includes("..");
}

export function validatePrivacyArtifact(privacy) {
  invariant(privacy && typeof privacy === "object" && !Array.isArray(privacy), "privacy JSON root is not an object");
  invariant(["clear", "human_review"].includes(privacy.status), "privacy status is invalid");
  invariant(typeof privacy.summary === "string" && privacy.summary.length > 0 && privacy.summary.length <= 2000, "privacy summary is invalid");
  invariant(Array.isArray(privacy.findings) && privacy.findings.length <= 50, "privacy findings are invalid");
  for (const finding of privacy.findings) {
    invariant(finding && typeof finding === "object" && !Array.isArray(finding), "privacy finding is not an object");
    invariant(privacyCategories.has(finding.category), "privacy finding category is invalid");
    invariant(privacySources.has(finding.source), "privacy finding source is invalid");
    invariant(privacyConfidence.has(finding.confidence), "privacy finding confidence is invalid");
    invariant(typeof finding.location === "string" && isSafePrivacyLocation(finding.location), "privacy finding location is unsafe");
    invariant(
      typeof finding.description === "string" && finding.description.length > 0 && finding.description.length <= 2000,
      "privacy finding description is invalid",
    );
  }
  invariant(
    (privacy.status === "clear" && privacy.findings.length === 0) ||
      (privacy.status === "human_review" && privacy.findings.length > 0),
    "privacy status contradicts its finding count",
  );

  const serialized = JSON.stringify(privacy);
  const forbidden = [
    /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i,
    /\/(?:Users|home|vol[0-9]*|mnt)\//,
    /\b(?:10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /https?:\/\//i,
    /-----BEGIN [A-Z ]+-----/,
    /\b[A-Za-z0-9_-]{48,}\b/,
  ];
  invariant(!forbidden.some((pattern) => pattern.test(serialized)), "privacy artifact contains an unredacted value");
}

function main(argv) {
  invariant(argv.length === 3, "usage: validate-pr-review-artifacts.mjs <command.json> <pr-review.json> <pr-review.md>");
  const [commandPath, reportPath, markdownPath] = argv;
  validatePrReviewArtifacts(
    JSON.parse(fs.readFileSync(commandPath, "utf8")),
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
    fs.readFileSync(markdownPath, "utf8"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Invalid PR review artifact: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

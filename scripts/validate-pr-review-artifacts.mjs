#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
  for (const name of ["pr-review.json", "pr-review.md", "pr-privacy-review.json"]) {
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
  invariant(quorum.passed === (quorum.successes >= quorum.threshold), "quorum passed flag contradicts successes");

  if (quorum.passed) {
    invariant(command.status === "completed", "a passed quorum did not produce a completed run");
    invariant(["pass", "findings"].includes(report.status), "a passed quorum has an invalid report status");
  } else {
    invariant(command.status === "cancelled", "a rejected quorum did not produce a cancelled run");
    invariant(report.status === "inconclusive", "a rejected quorum did not produce an inconclusive report");
  }
  if (report.status === "pass") invariant(report.actionable_count === 0, "a passing report has actionable findings");
  if (report.status === "findings") {
    invariant(Number.isInteger(report.actionable_count) && report.actionable_count > 0, "a findings report has no actionable findings");
  }

  const runIdLine = `**HomeRail Run ID:** \`${command.run_id}\``;
  invariant(markdown.includes(runIdLine), "Markdown does not contain the exact HomeRail run_id field");
  invariant(!/\$\{run_id\}|not available in runtime context/i.test(markdown), "Markdown contains a run_id placeholder");
  invariant(markdown.includes(report.repo), "Markdown does not contain the reviewed repository");
  invariant(markdown.includes(report.base) && markdown.includes(report.head), "Markdown does not contain the reviewed base and head");
  invariant(markdown.toLowerCase().includes(String(report.status).toLowerCase()), "Markdown does not contain the report status");
  invariant(/quorum/i.test(markdown), "Markdown does not contain the quorum result");
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
  invariant(argv.length === 4, "usage: validate-pr-review-artifacts.mjs <command.json> <pr-review.json> <pr-review.md> <pr-privacy-review.json>");
  const [commandPath, reportPath, markdownPath, privacyPath] = argv;
  validatePrReviewArtifacts(
    JSON.parse(fs.readFileSync(commandPath, "utf8")),
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
    fs.readFileSync(markdownPath, "utf8"),
  );
  validatePrivacyArtifact(JSON.parse(fs.readFileSync(privacyPath, "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Invalid PR review artifact: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

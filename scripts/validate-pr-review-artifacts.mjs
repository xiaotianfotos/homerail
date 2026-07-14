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
  for (const name of ["pr-review.json", "pr-review.md"]) {
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

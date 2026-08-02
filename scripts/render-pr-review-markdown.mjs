#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  return String(value ?? "").replace(/\r?\n+/g, " ").trim();
}

function tableCell(value) {
  return text(value).replaceAll("|", "\\|");
}

export function renderPrReviewMarkdown(command, publication) {
  invariant(command && typeof command === "object" && !Array.isArray(command), "command root is invalid");
  invariant(
    typeof command.run_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(command.run_id),
    "command run_id is invalid",
  );
  invariant(publication?.report && publication?.quorum, "review result is invalid");
  const { report, quorum } = publication;
  invariant(Array.isArray(report.reviewer_results) && report.reviewer_results.length === 3, "three model votes are required");
  invariant(Array.isArray(report.findings), "review findings are invalid");

  const lines = [
    "# HomeRail PR Review",
    "",
    `**HomeRail Run ID:** \`${command.run_id}\``,
    "",
    `- Repository: ${text(report.repo)}`,
    `- Pull request: #${report.pr}`,
    `- Base: \`${text(report.base)}\``,
    `- Head: \`${text(report.head)}\``,
    `- Status: **${text(report.status)}**`,
    `- Execution health: **${text(report.execution_health)}**`,
    `- Outcome: **${text(report.domain_outcome)}**`,
    `- Confidence: ${text(report.confidence)}`,
    `- Actionable findings: ${report.actionable_count}`,
    `- Quorum: ${quorum.successes}/${quorum.total} approvals (threshold ${quorum.threshold}) — ${quorum.passed ? "passed" : "blocked"}`,
    "",
    "## Summary",
    "",
    text(report.summary),
    "",
    "## Model votes",
    "",
    "| Model | Status | Vote | Summary |",
    "| --- | --- | --- | --- |",
    ...report.reviewer_results.map((reviewer) =>
      `| ${tableCell(reviewer.reviewer)} | ${tableCell(reviewer.status)} | ${tableCell(reviewer.vote)} | ${tableCell(reviewer.summary)} |`
    ),
    "",
    "## Findings",
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("No actionable findings.");
  } else {
    for (const item of report.findings) {
      lines.push(
        `### [${text(item.severity)}] ${text(item.title)}`,
        "",
        `- Location: \`${text(item.file)}:${item.line}\``,
        `- Category: ${text(item.category)}`,
        `- Confidence: ${text(item.confidence)}`,
        `- Evidence: ${text(item.evidence)}`,
        `- Recommendation: ${text(item.recommendation)}`,
        "",
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function main(argv) {
  invariant(argv.length === 2, "usage: render-pr-review-markdown.mjs <command.json> <pr-review.json>");
  const [commandPath, reportPath] = argv;
  process.stdout.write(renderPrReviewMarkdown(
    JSON.parse(fs.readFileSync(commandPath, "utf8")),
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
  ));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Unable to render PR review Markdown: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

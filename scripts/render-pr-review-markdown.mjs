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

function renderExecutionEvidence(evidence) {
  if (evidence === undefined || evidence === null) {
    return ["Execution evidence unavailable."];
  }
  const out = [];
  if (Array.isArray(evidence.reviewers) && evidence.reviewers.length > 0) {
    out.push(
      "| Slot | Provider/Model | Backend | Usage | Observed Tokens |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of evidence.reviewers) {
      const slot = text(entry.slot ?? entry.node_name ?? entry.role ?? "unknown");
      let identity = "unavailable";
      if (Array.isArray(entry.bindings) && entry.bindings.length > 0) {
        const parts = entry.bindings
          .map((b) => (b && b.provider && b.model ? `${b.provider}/${b.model}` : null))
          .filter(Boolean);
        if (parts.length > 0) identity = parts.join(", ");
      } else if (entry.provider && entry.model) {
        identity = `${entry.provider}/${entry.model}`;
      }
      const backend = text(entry.backend) || "unavailable";
      const usage = text(entry.usage_state) || "unavailable";
      const tokens = entry.observed_tokens != null ? String(entry.observed_tokens) : "unknown";
      out.push(`| ${tableCell(slot)} | ${tableCell(identity)} | ${tableCell(backend)} | ${tableCell(usage)} | ${tableCell(tokens)} |`);
    }
    out.push("");
  }
  const overallUsage = text(evidence.usage_state) || "unknown";
  const distinct = evidence.distinct_model_identities;
  out.push(`Overall usage state: ${overallUsage}.`);
  out.push("Observed token totals reflect partial or unknown accounting and are not settled billing.");
  if (distinct != null) {
    out.push(`Distinct configured provider/model count: ${distinct} — not proof of independent model weights.`);
  }
  return out;
}

export function renderPrReviewMarkdown(command, publication, executionEvidence = undefined) {
  invariant(command && typeof command === "object" && !Array.isArray(command), "command root is invalid");
  invariant(
    typeof command.run_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(command.run_id),
    "command run_id is invalid",
  );
  invariant(publication?.report && publication?.quorum, "review result is invalid");
  const { report, quorum } = publication;
  invariant(Array.isArray(report.reviewer_results) && report.reviewer_results.length === 3, "three reviewer votes are required");
  invariant(Array.isArray(report.findings), "review findings are invalid");
  if (executionEvidence !== undefined && executionEvidence !== null) {
    invariant(executionEvidence.schema === "pr-review-execution-evidence-v1", "execution evidence schema is invalid");
    invariant(executionEvidence.run_id === command.run_id, "execution evidence run identity mismatch");
    invariant(Array.isArray(executionEvidence.reviewers), "execution evidence reviewers array is invalid");
  }

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
    `- Confidence: ${text(report.confidence)}`,
    `- Actionable findings: ${report.actionable_count}`,
    `- Quorum gate: ${quorum.successes}/${quorum.total} reviewer executions (minimum ${quorum.threshold}) plus zero retained findings — ${quorum.passed ? "passed" : "blocked"}`,
    "",
    "## Summary",
    "",
    text(report.summary).replace(/^Three-model review:/, "Three-reviewer execution review:"),
    "",
    "## Reviewer votes",
    "",
    "| Slot | Status | Vote | Summary |",
    "| --- | --- | --- | --- |",
    ...report.reviewer_results.map((reviewer) =>
      `| ${tableCell(reviewer.reviewer)} | ${tableCell(reviewer.status)} | ${tableCell(reviewer.vote)} | ${tableCell(reviewer.summary)} |`
    ),
    "",
    "## Execution evidence",
    "",
    ...renderExecutionEvidence(executionEvidence),
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
  invariant(argv.length >= 2 && argv.length <= 3, "usage: render-pr-review-markdown.mjs <command.json> <pr-review.json> [execution-evidence.json]");
  const [commandPath, reportPath, evidencePath] = argv;
  let executionEvidence = undefined;
  if (evidencePath) {
    try {
      executionEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    } catch {
      executionEvidence = undefined;
    }
  }
  process.stdout.write(renderPrReviewMarkdown(
    JSON.parse(fs.readFileSync(commandPath, "utf8")),
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
    executionEvidence,
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

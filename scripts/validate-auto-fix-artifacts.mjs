#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const safeRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const exactRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function assertSafePublicationText(value) {
  const forbidden = [
    /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i,
    /\/(?:Users|home|vol[0-9]*|mnt)\//,
    /\b(?:10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
    /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  ];
  invariant(!forbidden.some((pattern) => pattern.test(value)), "Auto Fix publication contains local or credential material");
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  invariant(
    emails.every((email) => /@users\.noreply\.github\.com$/i.test(email)),
    "Auto Fix publication contains a non-noreply email address",
  );
}

export function validateAutoFixArtifacts(command, publication, patch, markdown) {
  invariant(command && typeof command === "object" && !Array.isArray(command), "command.json root is not an object");
  invariant(typeof command.run_id === "string" && safeRunId.test(command.run_id), "command.json has no canonical run_id");
  invariant(command.status === "completed", `run status is ${JSON.stringify(command.status)}`);
  const artifacts = new Map(
    (Array.isArray(command.artifacts) ? command.artifacts : []).map((artifact) => [artifact?.name, artifact]),
  );
  for (const name of ["auto-fix.json", "auto-fix.patch", "auto-fix.md"]) {
    invariant(artifacts.get(name)?.status === "ready", `${name} is not ready in command.json`);
  }

  invariant(publication && typeof publication === "object" && !Array.isArray(publication), "Auto Fix JSON root is not an object");
  invariant(publication.status === "ready", "Auto Fix JSON is not ready");
  invariant(typeof publication.repo === "string" && safeRepo.test(publication.repo), "Auto Fix JSON repository is invalid");
  invariant(Number.isInteger(publication.issue) && publication.issue > 0, "Auto Fix JSON issue is invalid");
  invariant(typeof publication.revision === "string" && exactRevision.test(publication.revision), "Auto Fix JSON revision is invalid");
  invariant(typeof publication.patch === "string" && publication.patch.length > 0 && publication.patch.length <= 1_000_000, "Auto Fix JSON patch is invalid");
  invariant(typeof publication.markdown === "string" && publication.markdown.length > 0 && publication.markdown.length <= 50_000, "Auto Fix JSON markdown is invalid");
  invariant(patch === publication.patch, "auto-fix.patch is not byte-for-byte equal to the JSON patch");
  const materializedMarkdown = publication.markdown.endsWith("\n")
    ? publication.markdown
    : `${publication.markdown}\n`;
  invariant(
    markdown === materializedMarkdown,
    "auto-fix.md differs from the JSON markdown beyond artifact newline normalization",
  );
  invariant(Array.isArray(publication.files_changed) && publication.files_changed.length > 0 && publication.files_changed.length <= 100, "Auto Fix JSON files_changed is invalid");
  invariant(new Set(publication.files_changed).size === publication.files_changed.length, "Auto Fix JSON files_changed contains duplicates");
  invariant(Array.isArray(publication.test_plan) && publication.test_plan.length <= 30, "Auto Fix JSON test_plan is invalid");
  invariant(typeof publication.explanation === "string" && publication.explanation.length > 0, "Auto Fix JSON explanation is missing");
  invariant(typeof publication.review_summary === "string" && publication.review_summary.length > 0, "Auto Fix JSON review summary is missing");
  invariant(markdown.includes(`#${publication.issue}`), "Auto Fix markdown does not contain the issue number");
  invariant(markdown.includes(publication.revision), "Auto Fix markdown does not contain the base revision");
  invariant(!/GIT binary patch|Binary files .* differ/.test(patch), "Binary patches are not supported by Auto Fix");
  assertSafePublicationText(JSON.stringify(publication));
  assertSafePublicationText(patch);
  assertSafePublicationText(markdown);
}

function main(argv) {
  invariant(argv.length === 4, "usage: validate-auto-fix-artifacts.mjs <command.json> <auto-fix.json> <auto-fix.patch> <auto-fix.md>");
  const [commandPath, reportPath, patchPath, markdownPath] = argv;
  validateAutoFixArtifacts(
    JSON.parse(fs.readFileSync(commandPath, "utf8")),
    JSON.parse(fs.readFileSync(reportPath, "utf8")),
    fs.readFileSync(patchPath, "utf8"),
    fs.readFileSync(markdownPath, "utf8"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Invalid Auto Fix artifact: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

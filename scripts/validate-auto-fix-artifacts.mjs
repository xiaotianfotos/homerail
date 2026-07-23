#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const safeRunId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const safeRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const exactRevision = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
}

const placeholderMarkers = new Set([
  "test", "fake", "dummy", "example", "placeholder", "redacted", "changeme", "sample", "fixture", "mock",
]);
const placeholderWords = new Set([
  ...placeholderMarkers,
  "sk", "pk", "api", "key", "apikey", "token", "local", "dev", "unit", "e2e",
  "notsecret", "nosecret", "notakey", "nokey", "testing", "readiness",
]);

// A placeholder bypass must be both semantically explicit and confined to test-like code.
function isTestFixturePath(file) {
  return typeof file === "string" && (
    /(^|\/)(?:tests?|__tests__|fixtures?|examples?|samples?|mocks?)(?:\/|$)/i.test(file)
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file)
  );
}

function isObviousPlaceholder(value, file) {
  if (!isTestFixturePath(file) || value.length < 8 || value.length > 64) return false;
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const placeholderCounter = (token) => /^(?:0+|1+)$/.test(token) && token.length <= 6;
  return tokens.length >= 2 && tokens.length <= 5
    && tokens.some((token) => placeholderMarkers.has(token))
    && tokens.every((token) => placeholderWords.has(token) || placeholderCounter(token))
    && entropy(value) <= 3.5;
}

function patchLocationResolver(value) {
  let file;
  let offset = 0;
  const locations = value.split("\n").map((line, lineIndex) => {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) file = match[2];
    const location = { offset, file, line: lineIndex + 1 };
    offset += line.length + 1;
    return location;
  });
  return (index) => {
    let low = 0;
    let high = locations.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      if (locations[middle].offset <= index) low = middle + 1;
      else high = middle - 1;
    }
    const location = locations[Math.max(0, high)];
    return { file: location.file, line: location.line };
  };
}

function locationLabel(context) {
  return context.file ? ` (${context.file}, patch line ${context.line})` : "";
}

function assertSafePublicationText(value, source) {
  const locate = patchLocationResolver(value);
  const forbidden = [
    ["a local Windows path", /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i],
    ["a local Unix path", /\/(?:Users|home|vol[0-9]*|mnt)\//],
    ["a private network address", /\b(?:10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b/],
    ["private key material", /-----BEGIN [A-Z ]+PRIVATE KEY-----/],
    ["a GitHub token", /\bgh[opsu]_[A-Za-z0-9]{20,}\b/],
  ];
  for (const [category, pattern] of forbidden) {
    const match = pattern.exec(value);
    if (match) {
      invariant(false, `Auto Fix publication ${source}${locationLabel(locate(match.index))} contains ${category}`);
    }
  }
  const credentialAssignment = /\b(api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{12,})/gi;
  for (const match of value.matchAll(credentialAssignment)) {
    const context = locate(match.index);
    invariant(
      source === "patch" && isObviousPlaceholder(match[2], context.file),
      `Auto Fix publication ${source}${locationLabel(context)} contains credential-like ${match[1].toLowerCase()} assignment`,
    );
  }
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) ?? [];
  invariant(
    emails.every((email) => /@users\.noreply\.github\.com$/i.test(email)),
    `Auto Fix publication ${source} contains a non-noreply email address`,
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
  invariant(publication.files_changed.every((item) => typeof item === "string"), "Auto Fix JSON files_changed entries are invalid");
  invariant(new Set(publication.files_changed).size === publication.files_changed.length, "Auto Fix JSON files_changed contains duplicates");
  invariant(Array.isArray(publication.test_plan) && publication.test_plan.length <= 30, "Auto Fix JSON test_plan is invalid");
  invariant(publication.test_plan.every((item) => typeof item === "string"), "Auto Fix JSON test_plan entries are invalid");
  invariant(typeof publication.explanation === "string" && publication.explanation.length > 0, "Auto Fix JSON explanation is missing");
  invariant(typeof publication.review_summary === "string" && publication.review_summary.length > 0, "Auto Fix JSON review summary is missing");
  invariant(markdown.includes(`#${publication.issue}`), "Auto Fix markdown does not contain the issue number");
  invariant(markdown.includes(publication.revision), "Auto Fix markdown does not contain the base revision");
  invariant(!/GIT binary patch|Binary files .* differ/.test(patch), "Binary patches are not supported by Auto Fix");
  assertSafePublicationText(publication.explanation, "explanation");
  assertSafePublicationText(publication.review_summary, "review summary");
  for (const item of publication.files_changed) assertSafePublicationText(item, "changed file");
  for (const item of publication.test_plan) assertSafePublicationText(item, "test plan");
  assertSafePublicationText(patch, "patch");
  assertSafePublicationText(markdown, "markdown");
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

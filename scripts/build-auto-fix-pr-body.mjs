#!/usr/bin/env node

import fs from "node:fs";

const [publicationPath, markdownPath, runId, outputPath] = process.argv.slice(2);
if (!publicationPath || !markdownPath || !runId || !outputPath || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(runId)) {
  throw new Error("usage: build-auto-fix-pr-body.mjs <auto-fix.json> <auto-fix.md> <run-id> <output.md>");
}
const publication = JSON.parse(fs.readFileSync(publicationPath, "utf8"));
const markdown = fs.readFileSync(markdownPath, "utf8");
if (!Number.isInteger(publication.issue) || publication.issue < 1 || !/^[0-9a-f]{40}$/i.test(publication.revision)) {
  throw new Error("Auto Fix publication identity is invalid");
}
fs.writeFileSync(outputPath, [
  "## HomeRail Auto Fix candidate",
  "",
  "This is a **Draft** candidate. A human must inspect the patch and mark it ready before normal PR review and CI begin.",
  "",
  `Closes #${publication.issue}`,
  `HomeRail Run ID: \`${runId}\``,
  `Base revision: \`${publication.revision}\``,
  "Deterministic gate: `npm run ci` passed in a credential-free container with networking disabled.",
  "",
  "<details>",
  "<summary>DAG investigation and review summary</summary>",
  "",
  markdown,
  "",
  "</details>",
  "",
].join("\n"), { mode: 0o600 });

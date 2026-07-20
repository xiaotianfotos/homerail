#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { validatePrivacyArtifact } from "./validate-pr-review-artifacts.mjs";

function escapeCommandProperty(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeCommandMessage(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function privacyAdvisoryCommands(privacy) {
  validatePrivacyArtifact(privacy);
  if (privacy.status === "clear") return [];
  return privacy.findings.map((finding) => {
    const match = finding.source === "diff" ? /^(.*):([1-9][0-9]*)$/.exec(finding.location) : null;
    const properties = ["title=Privacy advisory"];
    if (match) properties.push(`file=${escapeCommandProperty(match[1])}`, `line=${match[2]}`);
    const message = `${finding.category}: ${finding.description} (${finding.location})`;
    return `::error ${properties.join(",")}::${escapeCommandMessage(message)}`;
  });
}

function main(argv) {
  if (argv.length !== 1) throw new Error("usage: report-pr-privacy-advisory.mjs <pr-privacy-review.json>");
  const privacy = JSON.parse(fs.readFileSync(argv[0], "utf8"));
  const commands = privacyAdvisoryCommands(privacy);
  if (commands.length === 0) {
    console.log("Privacy advisory: no local or private information requires human inspection.");
    return;
  }
  for (const command of commands) console.log(command);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Privacy advisory failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

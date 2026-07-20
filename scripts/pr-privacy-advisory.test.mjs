import assert from "node:assert/strict";
import test from "node:test";
import { privacyAdvisoryCommands } from "./report-pr-privacy-advisory.mjs";
import { validatePrivacyArtifact } from "./validate-pr-review-artifacts.mjs";

test("a clear privacy advisory is silent and non-blocking", () => {
  const privacy = {
    status: "clear",
    summary: "No local or private information requires human inspection.",
    findings: [],
  };
  validatePrivacyArtifact(privacy);
  assert.deepEqual(privacyAdvisoryCommands(privacy), []);
});

test("human review emits only redacted GitHub error annotations", () => {
  const privacy = {
    status: "human_review",
    summary: "Two redacted locations need human inspection.",
    findings: [
      {
        category: "absolute_path",
        source: "diff",
        location: "docs/setup.md:24",
        description: "A machine-specific absolute path appears in a changed line; inspect it before publishing.",
        confidence: "high",
      },
      {
        category: "email",
        source: "commit_metadata",
        location: "commit:0123456789abcdef0123456789abcdef01234567 metadata",
        description: "Commit identity metadata may contain a personal address; inspect it before publishing.",
        confidence: "medium",
      },
    ],
  };
  const commands = privacyAdvisoryCommands(privacy);
  assert.equal(commands.length, 2);
  assert.match(commands[0], /^::error title=Privacy advisory,file=docs\/setup\.md,line=24::absolute_path:/);
  assert.match(commands[1], /^::error title=Privacy advisory::email:/);
  assert.doesNotMatch(commands.join("\n"), /@|192\.168\.|\/home\/|\/Users\//);
});

test("privacy artifacts reject unredacted values", () => {
  assert.throws(() => validatePrivacyArtifact({
    status: "human_review",
    summary: "Inspect a leaked value.",
    findings: [{
      category: "local_network",
      source: "diff",
      location: "docs/setup.md:24",
      description: "The leaked endpoint is 192.168.0.0.",
      confidence: "high",
    }],
  }), /unredacted value/);
});

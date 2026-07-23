import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyAutoFixPatch } from "./apply-auto-fix-patch.mjs";
import { validateAutoFixArtifacts } from "./validate-auto-fix-artifacts.mjs";

const revision = "a".repeat(40);
const patch = "diff --git a/example.txt b/example.txt\nindex 5626abf..f719efd 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-base\n+fixed\n";
const publication = {
  status: "ready",
  repo: "owner/repo",
  issue: 12,
  revision,
  patch,
  explanation: "Repair the regression.",
  files_changed: ["example.txt"],
  test_plan: ["Run the fixed suite."],
  review_summary: "Three reviewers approved.",
  markdown: `# Auto Fix #12\n\nBase: ${revision}\n`,
};
const command = {
  run_id: "auto-fix-1",
  status: "completed",
  artifacts: ["auto-fix.json", "auto-fix.patch", "auto-fix.md"].map((name) => ({ name, status: "ready" })),
};

test("validates exact patch bytes and normalized Markdown artifact bytes", () => {
  validateAutoFixArtifacts(command, publication, patch, publication.markdown);
  const markdownWithoutTrailingNewline = publication.markdown.slice(0, -1);
  validateAutoFixArtifacts(
    command,
    { ...publication, markdown: markdownWithoutTrailingNewline },
    patch,
    publication.markdown,
  );
  assert.throws(() => validateAutoFixArtifacts(command, publication, `${patch}\n`, publication.markdown), /byte-for-byte/);
  assert.throws(
    () => validateAutoFixArtifacts(command, publication, patch, `${publication.markdown}\n`),
    /newline normalization/,
  );
  assert.throws(
    () => {
      const unsafeMarkdown = `${publication.markdown}192.168.1.4`;
      validateAutoFixArtifacts(
        command,
        { ...publication, markdown: unsafeMarkdown },
        patch,
        `${unsafeMarkdown}\n`,
      );
    },
    /private network address/,
  );
});

test("allows obvious credential placeholders only in test fixture patches", () => {
  const placeholder = ["test", "api", "key", "0000"].join("-");
  const testFile = "tests/provider.test.ts";
  const testPatch = [
    `diff --git a/${testFile} b/${testFile}`,
    `--- a/${testFile}`,
    `+++ b/${testFile}`,
    "@@ -0,0 +1 @@",
    `+const api_key = '${placeholder}';`,
    "",
  ].join("\n");
  validateAutoFixArtifacts(
    command,
    { ...publication, patch: testPatch, files_changed: [testFile] },
    testPatch,
    publication.markdown,
  );

  const productionFile = "src/provider.ts";
  const productionPatch = testPatch
    .replaceAll(testFile, productionFile);
  assert.throws(
    () => validateAutoFixArtifacts(
      command,
      { ...publication, patch: productionPatch, files_changed: [productionFile] },
      productionPatch,
      publication.markdown,
    ),
    (error) => {
      assert.match(error.message, /src\/provider\.ts, patch line 5.*credential-like api_key assignment/);
      assert.equal(error.message.includes(placeholder), false);
      return true;
    },
  );
});

test("scans many placeholder assignments without quadratic patch rescans", () => {
  const additions = Array.from(
    { length: 4_000 },
    (_, index) => `+const fixture${index} = { api_key: 'test-api-key-0000' };`,
  );
  const patch = [
    "diff --git a/tests/many.test.ts b/tests/many.test.ts",
    "--- a/tests/many.test.ts",
    "+++ b/tests/many.test.ts",
    `@@ -0,0 +1,${additions.length} @@`,
    ...additions,
    "",
  ].join("\n");
  validateAutoFixArtifacts(
    command,
    { ...publication, patch, files_changed: ["tests/many.test.ts"] },
    patch,
    publication.markdown,
  );
});

test("rejects marker-bearing secret-like values and redacts the value", () => {
  const credential = ["sk", "test", "realcredential"].join("-");
  const file = "tests/provider.test.ts";
  const unsafePatch = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    `+const client_secret = '${credential}';`,
    "",
  ].join("\n");
  assert.throws(
    () => validateAutoFixArtifacts(
      command,
      { ...publication, patch: unsafePatch, files_changed: [file] },
      unsafePatch,
      publication.markdown,
    ),
    (error) => {
      assert.match(error.message, /tests\/provider\.test\.ts, patch line 5.*credential-like client_secret assignment/);
      assert.equal(error.message.includes(credential), false);
      return true;
    },
  );
});

test("scans publication fields before JSON escaping", () => {
  const credential = ["r4Nd0m", "S3cr3t", "V4lu3", "9XyZ"].join("");
  const unsafeExplanation = `Configuration uses api_key: "${credential}"`;
  assert.throws(
    () => validateAutoFixArtifacts(
      command,
      { ...publication, explanation: unsafeExplanation },
      patch,
      publication.markdown,
    ),
    (error) => {
      assert.match(error.message, /publication explanation contains credential-like api_key assignment/);
      assert.equal(error.message.includes(credential), false);
      return true;
    },
  );
});

function createRepository() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-"));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", directory, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  fs.writeFileSync(path.join(directory, "example.txt"), "base\n");
  execFileSync("git", ["-C", directory, "add", "example.txt"]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "base"]);
  return directory;
}

function writeArtifacts(directory, value, patchText) {
  const jsonPath = path.join(directory, "auto-fix.json");
  const patchPath = path.join(directory, "auto-fix.patch");
  fs.writeFileSync(jsonPath, JSON.stringify(value));
  fs.writeFileSync(patchPath, patchText);
  return { jsonPath, patchPath };
}

test("applies a bounded patch to an exact clean revision", () => {
  const repository = createRepository();
  const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-artifacts-"));
  const actualRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const artifacts = writeArtifacts(artifactDirectory, { ...publication, revision: actualRevision }, patch);
  assert.deepEqual(applyAutoFixPatch({ repository, publicationPath: artifacts.jsonPath, patchPath: artifacts.patchPath }), ["example.txt"]);
  assert.equal(
    fs.readFileSync(path.join(repository, "example.txt"), "utf8").replace(/\r\n/g, "\n"),
    "fixed\n",
  );
});

test("rejects workflow changes even when the patch is syntactically valid", () => {
  const repository = createRepository();
  const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-artifacts-"));
  fs.mkdirSync(path.join(repository, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(repository, ".github", "workflows", "ci.yml"), "name: CI\n");
  execFileSync("git", ["-C", repository, "add", ".github/workflows/ci.yml"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "add workflow"]);
  fs.writeFileSync(path.join(repository, ".github", "workflows", "ci.yml"), "name: Changed\n");
  const unsafePatch = execFileSync("git", ["-C", repository, "diff", "--binary"], { encoding: "utf8" });
  execFileSync("git", ["-C", repository, "restore", ".github/workflows/ci.yml"]);
  const actualRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const value = { ...publication, revision: actualRevision, patch: unsafePatch, files_changed: [".github/workflows/ci.yml"] };
  const artifacts = writeArtifacts(artifactDirectory, value, unsafePatch);
  assert.throws(
    () => applyAutoFixPatch({ repository, publicationPath: artifacts.jsonPath, patchPath: artifacts.patchPath }),
    /forbidden path/,
  );
});

test("rejects changes to the trusted Auto Fix publication adapter", () => {
  const repository = createRepository();
  const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-artifacts-"));
  fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repository, "scripts", "publish-auto-fix-pr.sh"), "#!/bin/sh\nexit 0\n");
  execFileSync("git", ["-C", repository, "add", "scripts/publish-auto-fix-pr.sh"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "add publisher"]);
  fs.writeFileSync(path.join(repository, "scripts", "publish-auto-fix-pr.sh"), "#!/bin/sh\necho unsafe\n");
  const unsafePatch = execFileSync("git", ["-C", repository, "diff", "--binary"], { encoding: "utf8" });
  execFileSync("git", ["-C", repository, "restore", "scripts/publish-auto-fix-pr.sh"]);
  const actualRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const value = { ...publication, revision: actualRevision, patch: unsafePatch, files_changed: ["scripts/publish-auto-fix-pr.sh"] };
  const artifacts = writeArtifacts(artifactDirectory, value, unsafePatch);
  assert.throws(
    () => applyAutoFixPatch({ repository, publicationPath: artifacts.jsonPath, patchPath: artifacts.patchPath }),
    /forbidden path/,
  );
});

test("rejects a patch that creates a symlink", () => {
  const repository = createRepository();
  const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-auto-fix-artifacts-"));
  fs.symlinkSync("example.txt", path.join(repository, "linked.txt"));
  execFileSync("git", ["-C", repository, "add", "linked.txt"]);
  const unsafePatch = execFileSync("git", ["-C", repository, "diff", "--cached", "--binary"], { encoding: "utf8" });
  execFileSync("git", ["-C", repository, "reset", "-q", "--", "linked.txt"]);
  fs.unlinkSync(path.join(repository, "linked.txt"));
  const actualRevision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const value = { ...publication, revision: actualRevision, patch: unsafePatch, files_changed: ["linked.txt"] };
  const artifacts = writeArtifacts(artifactDirectory, value, unsafePatch);
  assert.throws(
    () => applyAutoFixPatch({ repository, publicationPath: artifacts.jsonPath, patchPath: artifacts.patchPath }),
    /symlink or submodule/,
  );
});

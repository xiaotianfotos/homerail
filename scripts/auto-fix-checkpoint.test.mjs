import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  completeCheckpoint,
  hydrateCheckpoint,
  normalizeFixCandidate,
  recordCheckpoint,
} from "./auto-fix-checkpoint.mjs";

const revision = "a".repeat(40);
const candidate = {
  status: "fixed",
  patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
  explanation: "repair",
  files_changed: ["a"],
  test_plan: ["focused"],
};

async function inputFile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "homerail-auto-fix-checkpoint-"));
  const file = path.join(directory, "input.json");
  await writeFile(file, JSON.stringify({ repo: "owner/repo", issue: 92, revision }), { mode: 0o600 });
  return file;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("normalizes successful publication output into a resumable fixed candidate", () => {
  assert.deepEqual(normalizeFixCandidate({ ...candidate, status: "ready", markdown: "ignored" }), candidate);
  assert.equal(normalizeFixCandidate({ ...candidate, patch: "" }), undefined);
});

test("hydrates only a checkpoint for the exact issue revision", async () => {
  const file = await inputFile();
  const fetchImpl = async () => jsonResponse({
    success: true,
    data: { record: { value: {
      status: "candidate", repo: "owner/repo", issue: 92, revision,
      source_run_id: "run-1", candidate, validation_feedback: "trusted failure",
    } } },
  });
  assert.deepEqual(await hydrateCheckpoint(file, { fetchImpl }), {
    hydrated: true, sourceRunId: "run-1", hasValidationFeedback: true,
  });
  const hydrated = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(hydrated.checkpoint, {
    source_run_id: "run-1", revision, candidate, validation_feedback: "trusted failure",
  });
});

test("ignores stale checkpoint revisions", async () => {
  const file = await inputFile();
  const fetchImpl = async () => jsonResponse({
    success: true,
    data: { record: { value: {
      status: "candidate", repo: "owner/repo", issue: 92, revision: "b".repeat(40),
      source_run_id: "old-run", candidate,
    } } },
  });
  assert.deepEqual(await hydrateCheckpoint(file, { fetchImpl }), { hydrated: false });
  assert.equal(JSON.parse(await readFile(file, "utf8")).checkpoint, undefined);
});

test("records the newest ready candidate and bounded validation feedback", async () => {
  const file = await inputFile();
  const feedback = path.join(path.dirname(file), "validation.log");
  await writeFile(feedback, "failure evidence");
  let stored;
  const fetchImpl = async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/artifacts")) return jsonResponse({
      success: true,
      data: { artifacts: [
        { name: "candidate-v1.json", status: "ready" },
        { name: "candidate-v2.json", status: "ready" },
      ] },
    });
    if (pathname.endsWith("/candidate-v2.json/content")) {
      return new Response(JSON.stringify({ ...candidate, explanation: "revision" }), { status: 200 });
    }
    if (pathname.includes("/api/dag/state/") && init?.method === "POST") {
      stored = JSON.parse(init.body).value;
      return jsonResponse({ success: true, data: { updated: true } });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${pathname}`);
  };
  assert.deepEqual(await recordCheckpoint(file, "run-2", feedback, { fetchImpl }), {
    recorded: true, artifact: "candidate-v2.json",
  });
  assert.deepEqual(stored, {
    schema_version: 1,
    status: "candidate",
    repo: "owner/repo",
    issue: 92,
    revision,
    source_run_id: "run-2",
    source_artifact: "candidate-v2.json",
    candidate: { ...candidate, explanation: "revision" },
    validation_feedback: "failure evidence",
    updated_at: stored.updated_at,
  });
});

test("marks a published candidate complete without retaining its patch", async () => {
  const file = await inputFile();
  let stored;
  const fetchImpl = async (_url, init) => {
    stored = JSON.parse(init.body).value;
    return jsonResponse({ success: true, data: { updated: true } });
  };
  assert.deepEqual(await completeCheckpoint(file, "run-3", { fetchImpl }), { completed: true });
  assert.equal(stored.status, "completed");
  assert.equal(stored.candidate, undefined);
  assert.equal(stored.source_run_id, "run-3");
});

#!/usr/bin/env node

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const AUTO_FIX_CHECKPOINT_NAMESPACE = "auto-fix-checkpoints";
const MAX_FEEDBACK_BYTES = 30_000;
const CANDIDATE_ARTIFACTS = Object.freeze([
  "auto-fix.json",
  "candidate-v2.json",
  "candidate-v1.json",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function issueIdentity(input) {
  if (!input || typeof input !== "object") throw new Error("Auto Fix input must be an object");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo ?? "")) throw new Error("Auto Fix repo is invalid");
  if (!Number.isInteger(input.issue) || input.issue < 1) throw new Error("Auto Fix issue is invalid");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.revision ?? "")) throw new Error("Auto Fix revision is invalid");
  return { repo: input.repo, issue: input.issue, revision: input.revision };
}

export function checkpointKey(input) {
  const { repo, issue } = issueIdentity(input);
  return `${repo}#${issue}`;
}

export function normalizeFixCandidate(value) {
  if (!value || typeof value !== "object" || !["fixed", "ready"].includes(value.status)) return undefined;
  if (!nonEmpty(value.patch) || Buffer.byteLength(value.patch) > 400_000) return undefined;
  if (!nonEmpty(value.explanation) || value.explanation.length > 12_000) return undefined;
  if (!Array.isArray(value.files_changed) || value.files_changed.length < 1 || value.files_changed.length > 100 ||
      !value.files_changed.every((item) => nonEmpty(item) && item.length <= 1_000)) return undefined;
  if (!Array.isArray(value.test_plan) || value.test_plan.length > 30 ||
      !value.test_plan.every((item) => nonEmpty(item) && item.length <= 2_000)) return undefined;
  return {
    status: "fixed",
    patch: value.patch,
    explanation: value.explanation,
    files_changed: [...value.files_changed],
    test_plan: [...value.test_plan],
  };
}

function unwrap(body) {
  if (body && typeof body === "object" && "data" in body) return body.data;
  return body;
}

function managerClient({
  managerUrl = process.env.HOMERAIL_MANAGER_URL ?? "http://127.0.0.1:19191",
  mutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = managerUrl.replace(/\/+$/, "");
  const request = async (pathname, init, { allowNotFound = false, text = false } = {}) => {
    const response = await fetchImpl(`${base}${pathname}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(init?.method && init.method !== "GET" && mutationToken
          ? { "x-homerail-dag-token": mutationToken }
          : {}),
      },
    });
    if (allowNotFound && response.status === 404) return undefined;
    if (text) {
      const body = await response.text();
      if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${pathname}: HTTP ${response.status}`);
      return body;
    }
    const body = await response.json();
    if (!response.ok || body?.success === false) {
      throw new Error(`${init?.method ?? "GET"} ${pathname}: ${body?.error ?? body?.message ?? `HTTP ${response.status}`}`);
    }
    return unwrap(body);
  };
  return { request };
}

async function readInput(inputPath) {
  return JSON.parse(await readFile(inputPath, "utf8"));
}

async function writeInput(inputPath, value) {
  const temporary = `${inputPath}.checkpoint-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, inputPath);
}

function statePath(input) {
  return `/api/dag/state/${encodeURIComponent(AUTO_FIX_CHECKPOINT_NAMESPACE)}/${encodeURIComponent(checkpointKey(input))}`;
}

async function setCheckpoint(client, input, value) {
  return client.request(statePath(input), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export async function hydrateCheckpoint(inputPath, options = {}) {
  const input = await readInput(inputPath);
  const identity = issueIdentity(input);
  const client = managerClient(options);
  const data = await client.request(statePath(input), undefined, { allowNotFound: true });
  const value = data?.record?.value;
  const candidate = normalizeFixCandidate(value?.candidate);
  if (
    value?.status !== "candidate" || !candidate || value.repo !== identity.repo ||
    value.issue !== identity.issue || String(value.revision).toLowerCase() !== identity.revision.toLowerCase() ||
    !nonEmpty(value.source_run_id)
  ) {
    delete input.checkpoint;
    await writeInput(inputPath, input);
    return { hydrated: false };
  }
  input.checkpoint = {
    source_run_id: value.source_run_id,
    revision: identity.revision,
    candidate,
    ...(nonEmpty(value.validation_feedback)
      ? { validation_feedback: value.validation_feedback.slice(-MAX_FEEDBACK_BYTES) }
      : {}),
  };
  await writeInput(inputPath, input);
  return { hydrated: true, sourceRunId: value.source_run_id, hasValidationFeedback: Boolean(value.validation_feedback) };
}

async function readyCandidateArtifact(client, runId) {
  const listed = await client.request(`/api/runs/${encodeURIComponent(runId)}/artifacts`);
  const artifacts = Array.isArray(listed?.artifacts) ? listed.artifacts : [];
  for (const name of CANDIDATE_ARTIFACTS) {
    const artifact = artifacts.find((item) => item?.name === name && item?.status === "ready");
    if (!artifact) continue;
    const content = await client.request(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}/content`,
      undefined,
      { text: true },
    );
    const candidate = normalizeFixCandidate(JSON.parse(content));
    if (candidate) return { name, candidate };
  }
  return undefined;
}

export async function recordCheckpoint(inputPath, runId, feedbackPath, options = {}) {
  if (!nonEmpty(runId)) throw new Error("Auto Fix run id is required");
  const input = await readInput(inputPath);
  const identity = issueIdentity(input);
  const client = managerClient(options);
  const found = await readyCandidateArtifact(client, runId);
  if (!found) return { recorded: false, reason: "no_ready_candidate" };
  let validationFeedback;
  if (feedbackPath) {
    try {
      validationFeedback = (await readFile(feedbackPath, "utf8")).slice(-MAX_FEEDBACK_BYTES);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await setCheckpoint(client, input, {
    schema_version: 1,
    status: "candidate",
    ...identity,
    source_run_id: runId,
    source_artifact: found.name,
    candidate: found.candidate,
    ...(nonEmpty(validationFeedback) ? { validation_feedback: validationFeedback } : {}),
    updated_at: new Date().toISOString(),
  });
  return { recorded: true, artifact: found.name };
}

export async function completeCheckpoint(inputPath, runId, options = {}) {
  const input = await readInput(inputPath);
  const identity = issueIdentity(input);
  const client = managerClient(options);
  await setCheckpoint(client, input, {
    schema_version: 1,
    status: "completed",
    ...identity,
    source_run_id: runId,
    updated_at: new Date().toISOString(),
  });
  return { completed: true };
}

async function main() {
  const [command, inputPath, runId, feedbackPath] = process.argv.slice(2);
  if (!command || !inputPath) throw new Error("Usage: auto-fix-checkpoint.mjs <hydrate|record|complete> <input.json> [run-id] [feedback.log]");
  const result = command === "hydrate"
    ? await hydrateCheckpoint(inputPath)
    : command === "record"
      ? await recordCheckpoint(inputPath, runId, feedbackPath)
      : command === "complete"
        ? await completeCheckpoint(inputPath, runId)
        : (() => { throw new Error(`Unknown checkpoint command: ${command}`); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

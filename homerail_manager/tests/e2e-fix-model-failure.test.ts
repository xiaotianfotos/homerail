import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { appendChatEntry } from "../src/persistence/store.js";
import { _clearActiveRuns, createActiveRun, dispatchReadyNodes, failActiveRun, getActiveRun } from "../src/runtime/active-runs.js";
import { readE2eFixModelFailure } from "../src/runtime/e2e-fix-model-failure.js";

describe("E2E Fix failure evidence from persisted execution", () => {
  let home: string;
  let previousHome: string | undefined;
  let scope: Record<string, string>;
  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-model-failure-"));
    process.env.HOMERAIL_HOME = home;
    closeDb(); _clearActiveRuns();
    createActiveRun("failure-root", parseDAGYaml(`
name: failure-evidence
agents:
  worker: { agent_type: deterministic }
nodes:
  fix:
    agent: worker
    outputs:
      result: { to: "" }
`));
    dispatchReadyNodes("failure-root", { dispatched: [], dispatch() {
      return { status: "dispatched", targetType: "fake", targetId: "fake" };
    } });
    const run = getActiveRun("failure-root")!;
    scope = { run_id: run.runId, node_id: "fix", session_id: run.nodeSessions.get("fix")!.sessionId,
      round_id: run.currentRound.round_id };
  });
  afterEach(() => {
    _clearActiveRuns(); closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  function append(content: unknown) {
    appendChatEntry("failure-root", "fix", { role: "worker", type: "response", timestamp: Date.now(), content });
  }
  function usage(extra: Record<string, unknown> = {}) {
    return { ...scope, type: "usage", execution_id: "execution-one", finish_reason: "max-tokens", duration_ms: 100,
      usage: { input_tokens: 101, output_tokens: 8191, cache_read_input_tokens: 80 }, ...extra };
  }
  function error(extra: Record<string, unknown> = {}) {
    return { ...scope, message: "missing handoff", attempt_diagnostics: { finish_reason: "max-tokens", output_tokens: 8191, output_token_limit: 8192 }, ...extra };
  }
  function read() {
    failActiveRun("failure-root", "fix", "missing handoff");
    return readE2eFixModelFailure("failure-root", "fix", { error: "missing handoff" });
  }
  it("deduplicates cumulative snapshots and preserves the current execution diagnostic", () => {
    append(usage({ finish_reason: null })); append(usage()); append(error());
    const result = read();
    expect(result).toMatchObject({ outcome: "output_truncated", session_id: scope.session_id,
      diagnostic: { output_token_limit: 8192 }, attempts: [{ input_tokens: 101, output_tokens: 8191, cache_read_input_tokens: 80, finish_reason: "max-tokens" }] });
    expect(result.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["run_id", "node_id", "session_id", "round_id"])("ignores evidence with a stale %s", key => {
    append(usage({ [key]: "stale" })); append(error({ [key]: "stale" }));
    expect(read()).toMatchObject({ outcome: "unknown", diagnostic: null, attempts: [], usage_status: "unknown" });
  });
  it("does not treat a claimed failure on a running node as execution evidence", () => {
    append(usage()); append(error());
    expect(() => readE2eFixModelFailure("failure-root", "fix", { error: "missing handoff" })).toThrow(/provenance/);
  });
  it("requires matching retained error and terminal usage before allowing revision", () => {
    append(usage({ finish_reason: null })); append(error({ message: "different error" }));
    expect(read()).toMatchObject({ outcome: "unknown", diagnostic: null });
  });
  it("does not count invalid usage as proof of a completed provider attempt", () => {
    append(usage({ usage: { input_tokens: 1, output_tokens: -1, cache_read_input_tokens: 0 } })); append(error());
    expect(read()).toMatchObject({ outcome: "unknown", attempts: [], usage_status: "unknown" });
  });
  it("deduplicates scoped byte observations without carrying raw debug fields or summing copies", () => {
    const data = { version: 1, final: true, unit: "utf8_bytes", scope: "observed_root_session_events_not_tokens",
      stream_bytes: { text: 0, reasoning: 8000, tool_arguments: 512 },
      message_bytes: { text: 0, reasoning: 8000, tool_arguments: 512 },
      stream_events: 10, message_events: 1, interim_snapshots: 1, raw_output: "must not reach Judger" };
    const observation = { ...scope, type: "agent_debug", execution_id: "execution-one", source: "deepseek-harness",
      message: "output_observation", data };
    append(observation); append(observation);
    append({ ...observation, session_id: "stale", data: { ...data, stream_bytes: { text: 100, reasoning: 0, tool_arguments: 0 } } });
    append(usage()); append(error());
    const result = read();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ output_tokens: 8191,
      output_observation: { stream_bytes: data.stream_bytes, message_bytes: data.message_bytes } });
    expect(JSON.stringify(result)).not.toContain("must not reach Judger");
  });
  it.each([false, true])("retains unmetered streamed execution with prior usage=%s", priorUsage => {
    const observation = { ...scope, type: "agent_debug", execution_id: "unmetered",
      source: "deepseek-harness", message: "output_observation", data: {
        version: 1, final: false, unit: "utf8_bytes", scope: "observed_root_session_events_not_tokens",
        stream_bytes: { text: 0, reasoning: 16384, tool_arguments: 0 },
        message_bytes: { text: 0, reasoning: 0, tool_arguments: 0 },
        stream_events: 100, message_events: 0, interim_snapshots: 1,
      } };
    if (priorUsage) append(usage());
    append(observation); append(observation);
    append({ ...observation, session_id: "stale", execution_id: "stale" });
    const result = read();
    expect(result).toMatchObject({ outcome: "unknown",
      usage_status: priorUsage ? "partial_execution_snapshots" : "unknown" });
    expect(result.attempts.at(-1)).toMatchObject({
      execution_id: "unmetered", input_tokens: null, output_tokens: null, cache_read_input_tokens: null,
      duration_ms: null, finish_reason: null,
      output_observation: { final: false, stream_bytes: { reasoning: 16384 } },
    });
    expect(result.attempts).toHaveLength(priorUsage ? 2 : 1);
  });
  it("rejects malformed observations and does not use debug output as proof of truncation", () => {
    append({ ...scope, type: "agent_debug", execution_id: "execution-one", source: "deepseek-harness",
      message: "output_observation", data: { version: 1, final: true, unit: "tokens", output_tokens: 8191 } });
    append(usage({ finish_reason: null })); append(error());
    expect(read()).toMatchObject({ outcome: "unknown", attempts: [{ output_observation: null }] });
  });
});

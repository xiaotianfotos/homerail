import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  type DagActivityEventV1,
} from "homerail-protocol";
import { projectDagActivityJournalEntry } from "../src/generative-ui/dag-live-surface-projector.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { registerDagActor } from "../src/persistence/dag-actors.js";
import { closeDb } from "../src/persistence/db.js";
import { createInitialDagRunRound } from "../src/persistence/dag-run-rounds.js";
import { ensureRunDir } from "../src/persistence/store.js";
import { createServer } from "../src/server/http.js";
import { _invokeHostCodexVoiceToolForTest } from "../src/server/host-codex-manager-agent.js";
import {
  focusDagSupervisorActor,
  getDagSupervisionSnapshot,
  listDagSupervisorActors,
} from "../src/runtime/dag-manager-supervisor.js";

const BASE_TIME = 1_784_100_000_000;

function event(input: {
  run_id: string;
  actor_id: string;
  sequence: number;
  type: DagActivityEventV1["type"];
  payload?: DagActivityEventV1["payload"];
  round_id?: string;
}): DagActivityEventV1 {
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: `${input.run_id}-${input.actor_id}-${input.sequence}-${input.type}`,
    run_id: input.run_id,
    round_id: input.round_id ?? "round-0001",
    node_id: `node-${input.actor_id}`,
    actor_id: input.actor_id,
    generation: 1,
    surface_id: `surface:${input.actor_id}`,
    sequence: input.sequence,
    timestamp: BASE_TIME + input.sequence,
    type: input.type,
    payload: input.payload ?? { message: `${input.actor_id} ${input.type}` },
  };
}

function append(input: Parameters<typeof event>[0], project = false): void {
  const entry = appendDagActivityEvent(event(input));
  if (project) projectDagActivityJournalEntry(entry);
}

function setupRun(runId: string, actorIds: readonly string[]): void {
  ensureRunDir(runId);
  for (const actorId of actorIds) {
    registerDagActor({
      run_id: runId,
      actor_id: actorId,
      node_id: `node-${actorId}`,
      role: `${actorId} specialist`,
      surface_id: `surface:${actorId}`,
    });
    acquireDagActorLease({
      run_id: runId,
      actor_id: actorId,
      target_type: "worker",
      target_id: `private-worker-${actorId}`,
      now: BASE_TIME,
    });
  }
  createInitialDagRunRound({
    run_id: runId,
    round_id: "round-0001",
    target_actor_ids: actorIds,
    opened_at: BASE_TIME,
  });
  for (const actorId of actorIds) {
    append({ run_id: runId, actor_id: actorId, sequence: 1, type: "started" }, true);
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("DAG Manager Supervisor", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousMutationToken: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-supervisor-"));
    process.env.HOMERAIL_HOME = home;
    delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = previousMutationToken;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("aggregates redacted milestones once without exposing physical Worker identity", () => {
    const runId = "supervisor-three-actors";
    setupRun(runId, ["research", "build", "verify"]);
    append({
      run_id: runId,
      actor_id: "research",
      sequence: 2,
      type: "tool_used",
      payload: {
        tool_name: "web.search",
        arguments: { query: "latest changes", api_key: "sk-this-must-not-appear" },
      },
    });
    append({ run_id: runId, actor_id: "research", sequence: 3, type: "progress" });
    append({
      run_id: runId,
      actor_id: "research",
      sequence: 4,
      type: "finding",
      payload: { summary: "Found the release evidence with token=private-value" },
    });
    append({
      run_id: runId,
      actor_id: "build",
      sequence: 2,
      type: "blocked",
      payload: { reason: "Needs a signed artifact" },
    });
    append({
      run_id: runId,
      actor_id: "verify",
      sequence: 2,
      type: "completed",
      payload: { result: "All deterministic checks passed" },
    });

    const snapshot = getDagSupervisionSnapshot({
      run_id: runId,
      consumer_id: "manager-session-a",
      max_milestones: 8,
    });
    expect(snapshot.actor_count).toBe(3);
    expect(snapshot.actors.map((actor) => actor.actor_id)).toEqual(["build", "research", "verify"]);
    expect(snapshot.milestone_digest.suppressed_progress_events).toBe(1);
    expect(snapshot.milestone_digest.milestones.map((milestone) => milestone.type)).toEqual([
      "finding",
      "blocked",
      "completed",
    ]);
    expect(snapshot.milestone_digest.milestones[0]).toMatchObject({
      actor_id: "research",
      tools_used: ["web.search"],
    });
    expect(snapshot.milestone_digest.commentary).toHaveLength(1);
    expect(snapshot.round_summary).toMatchObject({
      round_id: "round-0001",
      complete: false,
      accepted_results: [
        { actor_id: "build", outcome: "blocked" },
        { actor_id: "research", outcome: "finding" },
        { actor_id: "verify", outcome: "completed" },
      ],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("private-worker-");
    expect(serialized).not.toContain("sk-this-must-not-appear");
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("target_id");
    expect(serialized).not.toContain("node_id");
    expect(serialized).not.toContain("surface_id");
    expect(serialized).not.toContain("lease_generation");
    expect(serialized).not.toContain("\"generation\"");

    const repeated = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "manager-session-a" });
    expect(repeated.milestone_digest).toMatchObject({ milestones: [], commentary: [] });
    const independent = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "manager-session-b" });
    expect(independent.milestone_digest.milestones).toHaveLength(3);

    append({
      run_id: runId,
      actor_id: "research",
      sequence: 5,
      type: "completed",
      payload: { result: "Research accepted" },
    });
    const completed = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "manager-session-a" });
    expect(completed.milestone_digest.milestones).toMatchObject([
      { actor_id: "research", type: "completed" },
    ]);
    expect(completed.round_summary?.complete).toBe(true);
    expect(completed.round_summary?.accepted_results).toMatchObject([
      { actor_id: "build", outcome: "blocked" },
      { actor_id: "research", outcome: "completed" },
      { actor_id: "verify", outcome: "completed" },
    ]);
  });

  it("suppresses high-frequency progress instead of flooding commentary", () => {
    const runId = "supervisor-progress-only";
    setupRun(runId, ["research"]);
    for (let sequence = 2; sequence <= 101; sequence += 1) {
      append({ run_id: runId, actor_id: "research", sequence, type: "progress" });
    }

    const snapshot = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "progress-reader" });
    expect(snapshot.milestone_digest).toMatchObject({
      has_more: false,
      suppressed_progress_events: 100,
      milestones: [],
      commentary: [],
    });
    expect(JSON.stringify(snapshot).length).toBeLessThan(32_000);
  });

  it("bounds milestone summaries and digest batches for Manager context", () => {
    const runId = "supervisor-bounded-context";
    setupRun(runId, ["research"]);
    for (let sequence = 2; sequence <= 14; sequence += 1) {
      append({
        run_id: runId,
        actor_id: "research",
        sequence,
        type: "finding",
        payload: { summary: `${sequence}:${"x".repeat(4_000)}` },
      });
    }

    const actors = listDagSupervisorActors(runId);
    expect(actors).toMatchObject({ actor_count: 1, actors_truncated: false });
    const snapshot = getDagSupervisionSnapshot({
      run_id: runId,
      consumer_id: "bounded-reader",
      max_milestones: 12,
    });
    expect(snapshot.milestone_digest.milestones).toHaveLength(12);
    expect(snapshot.milestone_digest.has_more).toBe(true);
    expect(snapshot.milestone_digest.milestones.every((milestone) => milestone.summary.length <= 240)).toBe(true);
    const remainder = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "bounded-reader" });
    expect(remainder.milestone_digest.milestones).toHaveLength(1);
    expect(remainder.milestone_digest.has_more).toBe(false);
  });

  it("focuses by stable actor id with CAS and retry-safe idempotency", () => {
    const runId = "supervisor-focus";
    setupRun(runId, ["research"]);

    const first = focusDagSupervisorActor({
      run_id: runId,
      actor_id: "research",
      idempotency_key: "focus-key-1",
      duration_ms: 5_000,
      now: BASE_TIME + 100,
    });
    expect(first).toMatchObject({
      actor_id: "research",
      visibility_state: "focused",
      focused_until: BASE_TIME + 5_100,
      deduplicated: false,
    });

    const retry = focusDagSupervisorActor({
      run_id: runId,
      actor_id: "research",
      idempotency_key: "focus-key-1",
      duration_ms: 5_000,
      now: BASE_TIME + 50_000,
    });
    expect(retry).toMatchObject({
      control_id: first.control_id,
      focused_until: first.focused_until,
      deduplicated: true,
    });
    expect(() => focusDagSupervisorActor({
      run_id: runId,
      actor_id: "research",
      idempotency_key: "focus-key-1",
      duration_ms: 6_000,
    })).toThrow("reused with different input");
    expect(() => focusDagSupervisorActor({
      run_id: runId,
      actor_id: "missing",
      idempotency_key: "missing-focus",
    })).toThrow("no projected surface");
  });

  it("serves bounded supervision through Host Codex tools and the Manager API", async () => {
    const runId = "supervisor-host-tool";
    setupRun(runId, ["research", "build", "verify"]);
    append({
      run_id: runId,
      actor_id: "research",
      sequence: 2,
      type: "finding",
      payload: { summary: "Primary source confirmed" },
    });
    const server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const managerRestUrl = `http://127.0.0.1:${await listen(server)}/api`;

    try {
      const listed = await _invokeHostCodexVoiceToolForTest(
        "list_dag_actors",
        { run_id: runId },
        { managerRestUrl, sessionId: "supervisor-host-session" },
      );
      expect(listed.result.content[0].text).toContain('"actor_id":"research"');
      expect(listed.result.content[0].text).not.toContain("private-worker-");
      expect(listed.result.content[0].text).not.toContain("lease_generation");

      const supervised = await _invokeHostCodexVoiceToolForTest(
        "get_dag_supervision",
        { run_id: runId },
        { managerRestUrl, sessionId: "supervisor-host-session" },
      );
      expect(supervised.result.content[0].text).toContain("Primary source confirmed");
      expect(supervised.voiceSurface.commentaryTexts).toEqual([
        "research specialist发现：Primary source confirmed",
      ]);

      const focused = await _invokeHostCodexVoiceToolForTest(
        "focus_dag_actor",
        {
          run_id: runId,
          actor_id: "research",
          idempotency_key: "host-focus-research",
          duration_ms: 5_000,
        },
        { managerRestUrl, sessionId: "supervisor-host-session" },
      );
      expect(focused.result.content[0].text).toContain('"visibility_state":"focused"');
      expect(focused.result.content[0].text).toContain('"deduplicated":false');
      const focusRetry = await _invokeHostCodexVoiceToolForTest(
        "focus_dag_actor",
        {
          run_id: runId,
          actor_id: "research",
          idempotency_key: "host-focus-research",
          duration_ms: 5_000,
        },
        { managerRestUrl, sessionId: "supervisor-host-session" },
      );
      expect(focusRetry.result.content[0].text).toContain('"deduplicated":true');
    } finally {
      await closeServer(server);
    }
  });
});

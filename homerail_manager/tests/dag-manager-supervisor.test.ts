import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  type DagActivityEventV1,
} from "homerail-protocol";
import {
  projectDagActivityJournalEntry,
  supersedeDagLiveSurfaceForIntervention,
} from "../src/generative-ui/dag-live-surface-projector.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import {
  advanceDagActorGeneration,
  getDagActor,
  registerDagActor,
} from "../src/persistence/dag-actors.js";
import {
  completeDagActorIntervention,
  createDagActorIntervention,
  markDagActorInterventionApplying,
} from "../src/persistence/dag-actor-interventions.js";
import { closeDb, getDb } from "../src/persistence/db.js";
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
  generation?: number;
}): DagActivityEventV1 {
  const generation = input.generation ?? 1;
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: `${input.run_id}-${input.actor_id}-g${generation}-${input.sequence}-${input.type}`,
    run_id: input.run_id,
    round_id: input.round_id ?? "round-0001",
    node_id: `node-${input.actor_id}`,
    actor_id: input.actor_id,
    generation,
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

function setupRun(
  runId: string,
  actorIds: readonly string[],
  round: {
    round_id?: string;
    status?: "active" | "waiting";
    await_node_id?: string;
    closed_at?: number;
    project_started?: boolean;
  } = {},
): void {
  const roundId = round.round_id ?? "round-0001";
  ensureRunDir(runId);
  getDb().transaction(() => {
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
      round_id: roundId,
      target_actor_ids: actorIds,
      ...(round.status ? { status: round.status } : {}),
      ...(round.await_node_id ? { await_node_id: round.await_node_id } : {}),
      opened_at: BASE_TIME,
      ...(round.closed_at === undefined ? {} : { closed_at: round.closed_at }),
    });
    for (const actorId of actorIds) {
      append(
        { run_id: runId, actor_id: actorId, sequence: 1, type: "started", round_id: roundId },
        round.project_started !== false,
      );
    }
  }).immediate();
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

  it("publishes a bounded round view without the private await node identity", () => {
    const runId = "supervisor-private-await-node";
    setupRun(runId, ["research"], {
      status: "waiting",
      await_node_id: "private-await-command-node",
      closed_at: BASE_TIME + 10,
    });

    const snapshot = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "round-view-reader" });
    expect(snapshot.current_round).toEqual({
      round_id: "round-0001",
      ordinal: 1,
      status: "waiting",
      target_actor_count: 1,
      target_actor_ids: ["research"],
      targets_truncated: false,
      opened_at: BASE_TIME,
      closed_at: BASE_TIME + 10,
    });
    expect(JSON.stringify(snapshot)).not.toContain("await_node_id");
    expect(JSON.stringify(snapshot)).not.toContain("private-await-command-node");
  });

  it("uses only current-generation results after an Actor retry", () => {
    const runId = "supervisor-current-generation";
    setupRun(runId, ["research"]);
    append({ run_id: runId, actor_id: "research", sequence: 2, type: "failed" });
    const actor = getDagActor(runId, "research");
    if (!actor) throw new Error("test actor missing");
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: actor.actor_id,
      expected_generation: actor.generation,
      expected_version: actor.version,
      attempt: 2,
    });

    const retried = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "generation-reader" });
    expect(retried.round_summary).toMatchObject({ complete: false, accepted_results: [] });

    append({
      run_id: runId,
      actor_id: "research",
      generation: 2,
      sequence: 1,
      type: "completed",
    });
    const completed = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "generation-reader" });
    expect(completed.round_summary).toMatchObject({
      complete: true,
      accepted_results: [{ actor_id: "research", outcome: "completed" }],
    });
  });

  it("finds current-round results beyond long historical progress chatter", () => {
    const runId = "supervisor-long-history";
    setupRun(runId, ["research"]);
    getDb().transaction(() => {
      for (let actorIndex = 0; actorIndex < 32; actorIndex += 1) {
        registerDagActor({
          run_id: runId,
          actor_id: `historical-${actorIndex}`,
          node_id: `node-historical-${actorIndex}`,
          role: "historical specialist",
          surface_id: `surface:historical-${actorIndex}`,
        });
      }
      for (let index = 0; index < 2_004; index += 1) {
        const actorIndex = index % 32;
        append({
          run_id: runId,
          actor_id: `historical-${actorIndex}`,
          round_id: "historical-round",
          sequence: Math.floor(index / 32) + 1,
          type: "progress",
        });
      }
    }).immediate();
    append({ run_id: runId, actor_id: "research", sequence: 2, type: "completed" });

    const snapshot = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "long-history-reader" });
    expect(snapshot.round_summary).toMatchObject({
      complete: true,
      accepted_result_count: 1,
      accepted_results: [{ actor_id: "research", outcome: "completed" }],
      results_truncated: false,
    });
  });

  it("marks Actor and result lists when the public supervision bound is reached", () => {
    const runId = "supervisor-bounded-actors";
    const actorIds = Array.from({ length: 65 }, (_, index) => `actor-${String(index + 1).padStart(2, "0")}`);
    setupRun(runId, actorIds, { project_started: false });
    getDb().transaction(() => {
      for (const actorId of actorIds) {
        append({ run_id: runId, actor_id: actorId, sequence: 2, type: "completed" });
      }
    }).immediate();

    const snapshot = getDagSupervisionSnapshot({ run_id: runId, consumer_id: "actor-bound-reader" });
    expect(snapshot).toMatchObject({ actor_count: 65, actors_truncated: true });
    expect(snapshot.actors).toHaveLength(64);
    expect(snapshot.current_round).toMatchObject({
      target_actor_count: 65,
      targets_truncated: true,
    });
    expect(snapshot.current_round?.target_actor_ids).toHaveLength(64);
    expect(snapshot.round_summary).toMatchObject({
      accepted_result_count: 65,
      results_truncated: true,
      complete: true,
    });
    expect(snapshot.round_summary?.accepted_results).toHaveLength(64);
  });

  it("ignores superseded generation events and explains an applied intervention once", () => {
    const runId = "supervisor-intervention-generation";
    setupRun(runId, ["research"]);
    append({
      run_id: runId,
      actor_id: "research",
      sequence: 2,
      type: "tool_used",
      payload: { tool_name: "old.private.tool" },
    });
    append({
      run_id: runId,
      actor_id: "research",
      sequence: 3,
      type: "finding",
      payload: { summary: "superseded result must not reach Manager" },
    });
    const actor = getDagActor(runId, "research")!;
    createDagActorIntervention({
      intervention_id: "supervisor-retry-research",
      run_id: runId,
      actor_id: "research",
      operation: "retry",
      expected_actor_generation: actor.generation,
      expected_actor_version: actor.version,
      idempotency_key: "supervisor-retry-research",
      created_at: BASE_TIME + 10,
    });
    markDagActorInterventionApplying({
      intervention_id: "supervisor-retry-research",
      from_generation: 1,
      started_at: BASE_TIME + 11,
    });
    const advanced = advanceDagActorGeneration({
      run_id: runId,
      actor_id: "research",
      expected_generation: actor.generation,
      expected_version: actor.version,
    });
    supersedeDagLiveSurfaceForIntervention({
      run_id: runId,
      actor_id: "research",
      intervention_id: "supervisor-retry-research",
      created_at: BASE_TIME + 12,
    });
    completeDagActorIntervention({
      intervention_id: "supervisor-retry-research",
      from_generation: 1,
      to_generation: 2,
      resulting_actor_version: advanced.version,
      completed_at: BASE_TIME + 13,
    });
    append({
      run_id: runId,
      actor_id: "research",
      generation: 2,
      sequence: 1,
      type: "finding",
      payload: { summary: "current corrected result" },
    });

    const snapshot = getDagSupervisionSnapshot({
      run_id: runId,
      consumer_id: "intervention-observer",
    });
    expect(snapshot.actors).toMatchObject([{
      actor_id: "research",
      latest_intervention: {
        intervention_id: "supervisor-retry-research",
        operation: "retry",
        status: "applied",
      },
    }]);
    expect(snapshot.milestone_digest.milestones).toMatchObject([{
      actor_id: "research",
      type: "finding",
      summary: "current corrected result",
      tools_used: [],
    }]);
    expect(snapshot.milestone_digest.intervention_milestones).toMatchObject([{
      intervention_id: "supervisor-retry-research",
      actor_id: "research",
      operation: "retry",
      status: "applied",
    }]);
    expect(snapshot.round_summary?.accepted_results).toMatchObject([{
      actor_id: "research",
      outcome: "finding",
      summary: "current corrected result",
    }]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("superseded result must not reach Manager");
    expect(serialized).not.toContain("old.private.tool");
    expect(serialized).not.toMatch(/private-worker-|node-research|lease_generation|\"generation\"/);

    const repeated = getDagSupervisionSnapshot({
      run_id: runId,
      consumer_id: "intervention-observer",
    });
    expect(repeated.milestone_digest).toMatchObject({
      milestones: [],
      intervention_milestones: [],
      commentary: [],
    });
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
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "supervisor-mutation-token";
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
      const unauthorized = await fetch(`${managerRestUrl}/runs/${runId}/supervision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumer_id: "unauthorized-reader" }),
      });
      expect(unauthorized.status).toBe(403);

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

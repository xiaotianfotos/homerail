import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DagActivityEventV1 } from "homerail-protocol";
import { closeDb, getDb } from "../src/persistence/db.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import { ensureRunDir } from "../src/persistence/store.js";
import { ingestDagActivityStream } from "../src/runtime/dag-activity-stream.js";
import { _clearActiveRuns, buildCurrentDispatchEnvelope, createActiveRun } from "../src/runtime/active-runs.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { createServer } from "../src/server/http.js";

function event(overrides: Partial<DagActivityEventV1> = {}): DagActivityEventV1 {
  return {
    schema_version: 1,
    event_id: "event-1",
    run_id: "run-activity",
    round_id: "round-1",
    node_id: "research",
    actor_id: "researcher",
    generation: 1,
    sequence: 1,
    timestamp: 1_784_000_000_000,
    type: "progress",
    payload: { message: "working" },
    ...overrides,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("DAG activity stream and replay API", () => {
  let home: string;
  let oldHome: string | undefined;
  let server: http.Server | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-activity-stream-"));
    process.env.HOMERAIL_HOME = home;
    ensureRunDir("run-activity");
    _clearActiveRuns();
  });

  afterEach(async () => {
    if (server) await close(server);
    server = undefined;
    _clearActiveRuns();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("accepts a valid stream event idempotently and rejects spoofed identity", () => {
    const data = { event: "dag_activity", activity: event() };
    const first = ingestDagActivityStream(data, { runId: "run-activity", nodeId: "research" });
    const duplicate = ingestDagActivityStream(data, { runId: "run-activity", nodeId: "research" });

    expect(first).toMatchObject({ inserted: true, deduplicated: false });
    expect(duplicate).toMatchObject({ inserted: false, deduplicated: true, seq: first?.seq });
    expect(() => ingestDagActivityStream(data, {
      runId: "run-activity",
      nodeId: "different-node",
    })).toThrow("identity does not match");
    expect(() => ingestDagActivityStream(data, {
      runId: "run-activity",
      nodeId: "research",
      roundId: "different-round",
    })).toThrow("identity does not match");
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_activity_events").get())
      .toEqual({ count: 1 });
  });

  it("keeps non-activity stream messages outside the journal", () => {
    expect(ingestDagActivityStream({ event: "usage", usage: {} }, {
      runId: "run-activity",
      nodeId: "research",
    })).toBeUndefined();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_activity_events").get())
      .toEqual({ count: 0 });
  });

  it("dispatches the last durable actor sequence to a subsequent Worker round", () => {
    const dag = parseDAGYaml(`
name: activity-dispatch
workflow_id: activity-dispatch
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  research:
    agent: worker
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-dispatch-activity", dag);
    appendDagActivityEvent(event({
      event_id: "dispatch-1",
      run_id: "run-dispatch-activity",
      node_id: "research",
      actor_id: "research",
      sequence: 1,
    }));
    appendDagActivityEvent(event({
      event_id: "dispatch-2",
      run_id: "run-dispatch-activity",
      node_id: "research",
      actor_id: "research",
      sequence: 2,
    }));

    const built = buildCurrentDispatchEnvelope("run-dispatch-activity", "research");

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.envelope.activity).toMatchObject({
      actorId: "research",
      generation: 1,
      sequenceStart: 2,
      roundId: built.envelope.sessionId,
    });
  });

  it("checks streamed activity against the logical actor registry", () => {
    const dag = parseDAGYaml(`
name: activity-actor-identity
workflow_id: activity-actor-identity
agents:
  worker:
    agent_type: deterministic
    system: HANDOFF port=done content=ok
nodes:
  research:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
        surface_id: surface-research
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-actor-activity", dag);
    const built = buildCurrentDispatchEnvelope("run-actor-activity", "research");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const valid = event({
      event_id: "registry-valid",
      run_id: "run-actor-activity",
      round_id: built.envelope.sessionId,
      actor_id: "researcher",
      surface_id: "surface-research",
    });

    expect(ingestDagActivityStream({ event: "dag_activity", activity: valid }, {
      runId: "run-actor-activity",
      nodeId: "research",
      roundId: built.envelope.sessionId,
    })).toMatchObject({ inserted: true });
    expect(() => ingestDagActivityStream({
      event: "dag_activity",
      activity: { ...valid, event_id: "spoofed-actor", actor_id: "other", sequence: 2 },
    }, {
      runId: "run-actor-activity",
      nodeId: "research",
      roundId: built.envelope.sessionId,
    })).toThrow("actor identity does not match");
    expect(() => ingestDagActivityStream({
      event: "dag_activity",
      activity: { ...valid, event_id: "future-generation", generation: 2, sequence: 2 },
    }, {
      runId: "run-actor-activity",
      nodeId: "research",
      roundId: built.envelope.sessionId,
    })).toThrow("generation is ahead");
    expect(() => ingestDagActivityStream({
      event: "dag_activity",
      activity: { ...valid, event_id: "spoofed-surface", surface_id: "other", sequence: 2 },
    }, {
      runId: "run-actor-activity",
      nodeId: "research",
      roundId: built.envelope.sessionId,
    })).toThrow("surface identity does not match");
  });

  it("replays bounded activity pages by run and actor", async () => {
    appendDagActivityEvent(event({ event_id: "research-1", actor_id: "researcher", sequence: 1 }));
    appendDagActivityEvent(event({ event_id: "writer-1", actor_id: "writer", sequence: 1 }));
    appendDagActivityEvent(event({ event_id: "research-2", actor_id: "researcher", sequence: 2 }));
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const baseUrl = `http://127.0.0.1:${await listen(server)}`;

    const firstResponse = await fetch(`${baseUrl}/api/runs/run-activity/activities?actor_id=researcher&limit=1`);
    const first = await firstResponse.json() as {
      success: boolean;
      data: { events: Array<{ seq: number; event: DagActivityEventV1 }>; next_after_seq: number; has_more: boolean };
    };
    expect(firstResponse.status).toBe(200);
    expect(first.data.events.map((entry) => entry.event.event_id)).toEqual(["research-1"]);
    expect(first.data.has_more).toBe(true);

    const nextResponse = await fetch(
      `${baseUrl}/api/runs/run-activity/activities?actor_id=researcher&after_seq=${first.data.next_after_seq}`,
    );
    const next = await nextResponse.json() as typeof first;
    expect(next.data.events.map((entry) => entry.event.event_id)).toEqual(["research-2"]);
    expect(next.data.has_more).toBe(false);

    const invalid = await fetch(`${baseUrl}/api/runs/run-activity/activities?limit=not-a-number`);
    expect(invalid.status).toBe(400);
    const missing = await fetch(`${baseUrl}/api/runs/missing/activities`);
    expect(missing.status).toBe(404);
  });
});

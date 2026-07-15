import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { setupWorkerWebSocket } from "../src/worker/websocket.js";
import { _clearWorkers } from "../src/worker/registry.js";
import { _clearAllDispatches, recordDispatch } from "../src/orchestration/dispatch-tracker.js";
import { _clearDagMessageRouter } from "../src/orchestration/dag-message-router.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
import { listDagActivityEvents } from "../src/persistence/dag-activity-journal.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { appendSessionTranscriptForTest, loadSessionTranscript } from "../src/persistence/dag-session-files.js";
import { _clearAllPersistence, loadRunSnapshot } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  checkpointResumeActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  getCurrentNodeSession,
} from "../src/runtime/active-runs.js";

class CaptureDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  constructor(private readonly targetId = "worker-a") {}

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing actor identity");
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: this.targetId,
    });
    this.dispatched.push({
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    });
    return { status: "dispatched", targetType: "worker", targetId: this.targetId };
  }
}

function simpleDag() {
  return parseDAGYaml(`
name: ws-stale-session
workflow_id: ws-stale-session
agents:
  worker:
    agent_type: deterministic
    system: "HANDOFF port=done content=ok"
nodes:
  work:
    agent: worker
    outputs:
      done:
        to: ""
`);
}

function exactHandoffDag() {
  return parseDAGYaml(`
name: ws-exact-handoff
workflow_id: ws-exact-handoff
agents:
  worker:
    agent_type: deterministic
nodes:
  source:
    agent: worker
    outputs:
      done:
        to: sink.in:payload
  sink:
    agent: worker
    after: [source]
    outputs:
      done:
        to: ""
`);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") throw new Error("server did not bind");
      resolve(addr.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("worker websocket node session filtering", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let server: http.Server | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-session-ws-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearDagMessageRouter();
    _clearWorkers();
    _clearListeners();
  });

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearDagMessageRouter();
    _clearWorkers();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("ignores stale session handoffs and accepts the current session handoff", async () => {
    createActiveRun("run-ws-stale", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-ws-stale", dispatcher)).toBe(1);
    const firstEnvelope = dispatcher.dispatched[0];
    const parentSessionId = firstEnvelope.sessionId!;
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "ws-entry-1", type: "text", runId: "run-ws-stale", nodeId: "work", content: "before resume" },
    ]);
    const resume = checkpointResumeActiveRun("run-ws-stale", "work", {
      instruction: "Resume with marker WS_RESUME_MARKER.",
    });
    expect(resume.status).toBe("scheduled");
    expect(dispatchReadyNodes("run-ws-stale", dispatcher)).toBe(1);
    const currentEnvelope = dispatcher.dispatched[1];
    const currentSessionId = currentEnvelope.sessionId!;
    const activity = currentEnvelope.activity!;

    const staleEvents: unknown[] = [];
    subscribe("dag:stale_session_ignored", (payload) => staleEvents.push(payload));
    let applied = 0;
    server = http.createServer();
    setupWorkerWebSocket(server, {
      registrationTimeoutMs: 500,
      pingIntervalMs: 5_000,
      onHandoffApplied: () => {
        applied += 1;
      },
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-a`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-a" }));
    await delay(20);

    const handoff = (sessionId: string, content: string) => ({
      type: "response",
      session_id: sessionId,
      data: {
        type: "node_handoff",
        runId: "run-ws-stale",
        nodeId: "work",
        from_node: "work",
        from_port: "done",
        port: "done",
        content,
        session_id: sessionId,
        round_id: activity.roundId,
        actor_id: activity.actorId,
        generation: activity.generation,
        lease_generation: activity.leaseGeneration,
      },
    });

    ws.send(JSON.stringify(handoff(parentSessionId, "old content")));
    await delay(20);
    expect(staleEvents).toHaveLength(1);
    expect(applied).toBe(0);

    ws.send(JSON.stringify(handoff(currentSessionId, "new content")));
    await delay(20);
    expect(applied).toBe(1);
    const currentTranscript = loadSessionTranscript(currentSessionId);
    expect(currentTranscript.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(currentTranscript)).toContain("new content");
    expect(JSON.stringify(loadSessionTranscript(parentSessionId))).not.toContain("new content");
    ws.close();
  });

  it("keeps authoritative handoffs exact while redacting evidence copies", async () => {
    createActiveRun("run-ws-exact", exactHandoffDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-ws-exact", dispatcher)).toBe(1);
    const envelope = dispatcher.dispatched[0];
    const sessionId = envelope.sessionId!;
    const activity = envelope.activity!;
    const exact = {
      api_key: "sk-authoritative-secret-123456",
      long: "x".repeat(5000),
      many: Array.from({ length: 120 }, (_, index) => ({ index })),
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: "kept" } } } } } } } } },
    };

    server = http.createServer();
    setupWorkerWebSocket(server, { registrationTimeoutMs: 500, pingIntervalMs: 5_000 });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-a`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-a" }));
    await delay(20);
    ws.send(JSON.stringify({
      type: "response",
      session_id: sessionId,
      data: {
        type: "node_handoff",
        runId: "run-ws-exact",
        nodeId: "source",
        from_node: "source",
        from_port: "done",
        port: "done",
        content: exact,
        session_id: sessionId,
        round_id: activity.roundId,
        actor_id: activity.actorId,
        generation: activity.generation,
        lease_generation: activity.leaseGeneration,
      },
    }));
    await delay(20);

    expect(getActiveRun("run-ws-exact")?.dagRun.mailboxes.get("sink")?.get("payload")).toEqual([exact]);
    const persisted = JSON.stringify({
      chats: loadRunSnapshot("run-ws-exact")?.chats,
      transcript: loadSessionTranscript(sessionId),
    });
    expect(persisted).not.toContain("sk-authoritative-secret-123456");
    expect(persisted).toContain("***REDACTED***");
    expect(persisted).toContain("...");
    expect(persisted).toContain("[truncated]");
    ws.close();
  });

  it("rejects stale-round activity before it reaches the journal or chat evidence", async () => {
    createActiveRun("run-ws-activity", simpleDag());
    const dispatcher = new CaptureDispatcher("worker-activity");
    expect(dispatchReadyNodes("run-ws-activity", dispatcher)).toBe(1);
    const sessionId = dispatcher.dispatched[0].sessionId!;
    const roundId = dispatcher.dispatched[0].activity!.roundId;
    const leaseGeneration = dispatcher.dispatched[0].activity!.leaseGeneration;
    recordDispatch("run-ws-activity", "work", "worker", "worker-activity");

    const staleEvents: unknown[] = [];
    subscribe("dag:stale_session_ignored", (payload) => staleEvents.push(payload));

    server = http.createServer();
    setupWorkerWebSocket(server, { registrationTimeoutMs: 500, pingIntervalMs: 5_000 });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-activity`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-activity" }));
    await delay(20);

    const activity = {
      schema_version: 1,
      event_id: "ws-activity-1",
      run_id: "run-ws-activity",
      round_id: "stale-round",
      node_id: "work",
      actor_id: "work",
      generation: 1,
      lease_generation: leaseGeneration,
      sequence: 1,
      timestamp: Date.now(),
      type: "finding",
      payload: {
        message: "durable finding token=raw-worker-secret",
        api_key: "sk-raw-worker-secret-123456",
      },
    };
    const stream = JSON.stringify({
      type: "stream",
      data: {
        type: "dag_activity",
        event: "dag_activity",
        activity,
        run_id: "run-ws-activity",
        node_id: "work",
        session_id: sessionId,
        round_id: "stale-round",
        actor_id: "work",
        generation: 1,
        lease_generation: leaseGeneration,
      },
    });
    ws.send(stream);
    ws.send(stream);
    await delay(30);

    const page = listDagActivityEvents({ run_id: "run-ws-activity" });
    expect(page.events).toHaveLength(0);
    expect(staleEvents).toHaveLength(0);
    const genericEvidence = JSON.stringify({
      chats: loadRunSnapshot("run-ws-activity")?.chats,
      transcript: loadSessionTranscript(sessionId),
    });
    expect(genericEvidence).not.toContain("durable finding");
    expect(genericEvidence).not.toContain("raw-worker-secret");

    ws.send(JSON.stringify({
      type: "stream",
      data: {
        type: "dag_activity",
        event: "dag_activity",
        activity: {
          ...activity,
          event_id: "ws-activity-current",
          round_id: roundId,
          payload: { message: "current round finding" },
        },
        run_id: "run-ws-activity",
        node_id: "work",
        session_id: sessionId,
        round_id: roundId,
        actor_id: "work",
        generation: 1,
        lease_generation: leaseGeneration,
      },
    }));
    await delay(20);
    expect(listDagActivityEvents({ run_id: "run-ws-activity" }).events)
      .toMatchObject([{ event: { event_id: "ws-activity-current", round_id: roundId } }]);
    ws.close();
  });

  it("rejects activity from a worker that does not own the current dispatch", async () => {
    createActiveRun("run-ws-source-bound", simpleDag());
    const dispatcher = new CaptureDispatcher("worker-owner");
    expect(dispatchReadyNodes("run-ws-source-bound", dispatcher)).toBe(1);
    const sessionId = dispatcher.dispatched[0].sessionId!;
    const roundId = dispatcher.dispatched[0].activity!.roundId;
    const leaseGeneration = dispatcher.dispatched[0].activity!.leaseGeneration;
    recordDispatch("run-ws-source-bound", "work", "worker", "worker-owner");

    server = http.createServer();
    setupWorkerWebSocket(server, { registrationTimeoutMs: 500, pingIntervalMs: 5_000 });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-attacker`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-attacker" }));
    await delay(20);
    ws.send(JSON.stringify({
      type: "stream",
      data: {
        type: "dag_activity",
        event: "dag_activity",
        run_id: "run-ws-source-bound",
        node_id: "work",
        session_id: sessionId,
        round_id: roundId,
        actor_id: "work",
        generation: 1,
        lease_generation: leaseGeneration,
        activity: {
          schema_version: 1,
          event_id: "spoofed-source-activity",
          run_id: "run-ws-source-bound",
          round_id: roundId,
          node_id: "work",
          actor_id: "work",
          generation: 1,
          lease_generation: leaseGeneration,
          sequence: 1,
          timestamp: Date.now(),
          type: "finding",
          payload: { message: "must not persist" },
        },
      },
    }));
    await delay(30);

    expect(listDagActivityEvents({ run_id: "run-ws-source-bound" }).events).toEqual([]);
    ws.close();
  });

  it("rejects legacy first-round activity without a physical lease fence", async () => {
    createActiveRun("run-ws-legacy-activity", simpleDag());
    const dispatcher = new CaptureDispatcher("worker-legacy-activity");
    expect(dispatchReadyNodes("run-ws-legacy-activity", dispatcher)).toBe(1);
    const sessionId = dispatcher.dispatched[0].sessionId!;
    recordDispatch("run-ws-legacy-activity", "work", "worker", "worker-legacy-activity");
    const staleLeaseEvents: unknown[] = [];
    subscribe("dag:stale_lease_ignored", (payload) => staleLeaseEvents.push(payload));

    server = http.createServer();
    setupWorkerWebSocket(server, { registrationTimeoutMs: 500, pingIntervalMs: 5_000 });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-legacy-activity`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-legacy-activity" }));
    await delay(20);

    ws.send(JSON.stringify({
      type: "stream",
      data: {
        type: "dag_activity",
        event: "dag_activity",
        run_id: "run-ws-legacy-activity",
        node_id: "work",
        session_id: sessionId,
        activity: {
          schema_version: 1,
          event_id: "legacy-first-round-activity",
          run_id: "run-ws-legacy-activity",
          round_id: sessionId,
          node_id: "work",
          actor_id: "work",
          generation: 1,
          sequence: 1,
          timestamp: Date.now(),
          type: "finding",
          payload: { message: "legacy accepted" },
        },
      },
    }));
    await delay(20);

    expect(listDagActivityEvents({ run_id: "run-ws-legacy-activity" }).events).toEqual([]);
    expect(staleLeaseEvents).toHaveLength(1);
    ws.close();
  });

  it("ignores stale send_message and receive_message responses", async () => {
    createActiveRun("run-ws-message-stale", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-ws-message-stale", dispatcher)).toBe(1);
    const firstEnvelope = dispatcher.dispatched[0];
    const parentSessionId = firstEnvelope.sessionId!;
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "ws-message-entry-1", type: "text", runId: "run-ws-message-stale", nodeId: "work", content: "before resume" },
    ]);
    const resume = checkpointResumeActiveRun("run-ws-message-stale", "work", {
      instruction: "Resume with marker WS_MESSAGE_RESUME_MARKER.",
    });
    expect(resume.status).toBe("scheduled");
    expect(dispatchReadyNodes("run-ws-message-stale", dispatcher)).toBe(1);
    const currentEnvelope = dispatcher.dispatched[1];
    const currentSessionId = currentEnvelope.sessionId!;
    const activity = currentEnvelope.activity!;

    const staleEvents: unknown[] = [];
    const sentEvents: unknown[] = [];
    const receivedEvents: unknown[] = [];
    subscribe("dag:stale_session_ignored", (payload) => staleEvents.push(payload));
    subscribe("dag:message_sent", (payload) => sentEvents.push(payload));
    subscribe("dag:message_received", (payload) => receivedEvents.push(payload));

    server = http.createServer();
    setupWorkerWebSocket(server, {
      registrationTimeoutMs: 500,
      pingIntervalMs: 5_000,
    });
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/worker-a`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "register", worker_id: "worker-a" }));
    await delay(20);

    const sendMessage = (sessionId: string, content: string) => ({
      type: "response",
      session_id: sessionId,
      data: {
        type: "node_send_message",
        run_id: "run-ws-message-stale",
        from_node: "work",
        to_node: "other",
        content,
        session_id: sessionId,
        round_id: activity.roundId,
        actor_id: activity.actorId,
        generation: activity.generation,
        lease_generation: activity.leaseGeneration,
      },
    });
    const receiveMessage = (sessionId: string) => ({
      type: "response",
      session_id: sessionId,
      data: {
        type: "node_receive_message",
        run_id: "run-ws-message-stale",
        from_node: "work",
        session_id: sessionId,
        round_id: activity.roundId,
        actor_id: activity.actorId,
        generation: activity.generation,
        lease_generation: activity.leaseGeneration,
      },
    });

    ws.send(JSON.stringify(sendMessage(parentSessionId, "old message")));
    ws.send(JSON.stringify(receiveMessage(parentSessionId)));
    await delay(20);
    expect(staleEvents).toHaveLength(2);
    expect(sentEvents).toHaveLength(0);
    expect(receivedEvents).toHaveLength(0);

    ws.send(JSON.stringify(sendMessage(currentSessionId, "new message")));
    ws.send(JSON.stringify(receiveMessage(currentSessionId)));
    await delay(20);
    expect(sentEvents).toHaveLength(1);
    expect(receivedEvents).toHaveLength(1);
    ws.close();
  });
});

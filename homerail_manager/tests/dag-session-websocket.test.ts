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
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { _clearDagMessageRouter } from "../src/orchestration/dag-message-router.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { closeDb } from "../src/persistence/db.js";
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

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
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
    const parentSessionId = dispatcher.dispatched[0].sessionId!;
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "ws-entry-1", type: "text", runId: "run-ws-stale", nodeId: "work", content: "before resume" },
    ]);
    const resume = checkpointResumeActiveRun("run-ws-stale", "work", {
      instruction: "Resume with marker WS_RESUME_MARKER.",
    });
    expect(resume.status).toBe("scheduled");
    const currentSessionId = getCurrentNodeSession("run-ws-stale", "work")!.sessionId;

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
    const sessionId = dispatcher.dispatched[0].sessionId!;
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

  it("ignores stale send_message and receive_message responses", async () => {
    createActiveRun("run-ws-message-stale", simpleDag());
    const dispatcher = new CaptureDispatcher();
    expect(dispatchReadyNodes("run-ws-message-stale", dispatcher)).toBe(1);
    const parentSessionId = dispatcher.dispatched[0].sessionId!;
    appendSessionTranscriptForTest(parentSessionId, [
      { uuid: "ws-message-entry-1", type: "text", runId: "run-ws-message-stale", nodeId: "work", content: "before resume" },
    ]);
    const resume = checkpointResumeActiveRun("run-ws-message-stale", "work", {
      instruction: "Resume with marker WS_MESSAGE_RESUME_MARKER.",
    });
    expect(resume.status).toBe("scheduled");
    const currentSessionId = getCurrentNodeSession("run-ws-message-stale", "work")!.sessionId;

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

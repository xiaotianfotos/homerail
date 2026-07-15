import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAG_TRANSPORT_FENCE_CAPABILITY } from "homerail-protocol";
import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { _clearAllDispatches, recordDispatch } from "../src/orchestration/dispatch-tracker.js";
import { _clearDagMessageRouter } from "../src/orchestration/dag-message-router.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { _clearNodes } from "../src/node/registry.js";
import { setupNodeWebSocket } from "../src/node/websocket.js";
import { listDagActorCommands } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { loadSessionTranscript } from "../src/persistence/dag-session-files.js";
import { _clearAllPersistence, loadNodeUsages } from "../src/persistence/store.js";
import { listDagActivityEvents } from "../src/persistence/dag-activity-journal.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
  resumeWaitingActiveRun,
} from "../src/runtime/active-runs.js";
import { _clearWorkers } from "../src/worker/registry.js";
import { setupWorkerWebSocket } from "../src/worker/websocket.js";

type SourceType = "worker" | "node";

class RepeatableDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(structuredClone(envelope));
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }
}

function multiRoundDag() {
  return parseDAGYaml(`
name: websocket-transport-fence
workflow_id: websocket-transport-fence
agents:
  worker: { agent_type: deterministic }
nodes:
  actor:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
        role: research
        surface_id: surface-research
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command
    after: [actor]
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      command_port: command
`);
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") throw new Error("server did not bind");
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startRoundTwo(runId: string): DispatchEnvelope {
  const dispatcher = new RepeatableDispatcher();
  createActiveRun(runId, multiRoundDag());
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  handoffActiveRun(runId, "actor", "summary", { result: "round one" });
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(getActiveRun(runId)?.status).toBe("waiting");
  resumeWaitingActiveRun(runId, {
    expected_round_id: "round-0001",
    commands: [{ actor_id: "researcher", command_id: `${runId}-command-2`, payload: "continue" }],
  });
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  return dispatcher.dispatched.at(-1)!;
}

async function openTransport(
  sourceType: SourceType,
  runId: string,
  onHandoffApplied: () => void,
): Promise<{ server: http.Server; ws: WebSocket; sourceId: string }> {
  const sourceId = `${sourceType}-${runId}`;
  const server = http.createServer();
  if (sourceType === "worker") {
    setupWorkerWebSocket(server, {
      registrationTimeoutMs: 500,
      pingIntervalMs: 5_000,
      onHandoffApplied,
    });
  } else {
    setupNodeWebSocket(server, {
      registrationTimeoutMs: 500,
      pingIntervalMs: 5_000,
      onHandoffApplied,
    });
  }
  const port = await listen(server);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/projects/default/${sourceType === "worker" ? "workers" : "nodes"}/${sourceId}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(sourceType === "worker"
    ? {
        type: "register",
        worker_id: sourceId,
        capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      }
    : { type: "register", node_id: sourceId }));
  await delay(20);
  return { server, ws, sourceId };
}

describe("round-aware terminal websocket transport", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-transport-fence-ws-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearDagMessageRouter();
    _clearWorkers();
    _clearNodes();
    _clearListeners();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearDagMessageRouter();
    _clearWorkers();
    _clearNodes();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.each(["worker", "node"] as const)(
    "audits and ignores stale or duplicate %s terminal messages",
    async (sourceType) => {
      const runId = `run-${sourceType}-transport-fence`;
      const envelope = startRoundTwo(runId);
      const sessionId = envelope.sessionId!;
      const commandId = `${runId}-command-2`;
      const correctionEvents: unknown[] = [];
      const auditEvents: unknown[] = [];
      subscribe("dag:node_correction_requested", (payload) => correctionEvents.push(payload));
      subscribe("dag:stale_lease_ignored", (payload) => auditEvents.push(payload));
      let applied = 0;
      const { server, ws, sourceId } = await openTransport(sourceType, runId, () => {
        applied += 1;
      });
      const lease = acquireDagActorLease({
        run_id: runId,
        actor_id: "researcher",
        target_type: sourceType,
        target_id: sourceId,
      });

      const response = (roundId: string, content: string) => ({
        type: "response",
        session_id: sessionId,
        data: {
          type: "node_handoff",
          runId,
          nodeId: "actor",
          port: "summary",
          from_node: "actor",
          from_port: "summary",
          session_id: sessionId,
          round_id: roundId,
          actor_id: "researcher",
          generation: 1,
          lease_generation: lease.lease_generation,
          command_id: commandId,
          content,
          summary: content,
        },
      });
      const nodeError = (roundId: string, message: string) => ({
        type: "node_error",
        data: {
          runId,
          nodeId: "actor",
          message,
          session_id: sessionId,
          round_id: roundId,
          actor_id: "researcher",
          generation: 1,
          lease_generation: lease.lease_generation,
          command_id: commandId,
        },
      });

      try {
        ws.send(JSON.stringify(response("round-0001", "late handoff")));
        ws.send(JSON.stringify(nodeError("round-0001", "late error")));
        await delay(30);

        expect(correctionEvents).toEqual([]);
        expect(applied).toBe(0);
        expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
        expect(listDagActorCommands({ run_id: runId })).toContainEqual(expect.objectContaining({
          command_id: commandId,
          status: "delivered",
        }));

        ws.send(JSON.stringify(response("round-0002", "current handoff")));
        await delay(30);
        expect(applied).toBe(1);
        expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("COMPLETED");
        expect(listDagActorCommands({ run_id: runId })).toContainEqual(expect.objectContaining({
          command_id: commandId,
          status: "acknowledged",
        }));

        ws.send(JSON.stringify(response("round-0002", "duplicate handoff")));
        await delay(30);
        expect(correctionEvents).toEqual([]);
        expect(applied).toBe(1);
        expect(auditEvents).toHaveLength(3);
        expect(JSON.stringify(auditEvents)).toContain("DAG_TRANSPORT_ROUND_STALE");
        expect(JSON.stringify(auditEvents)).toContain("DAG_TRANSPORT_COMMAND_DUPLICATE");

        const transcript = JSON.stringify(loadSessionTranscript(sessionId));
        expect(transcript).toContain("stale_lease_response_ignored");
        expect(transcript).toContain("stale_lease_node_error_ignored");
      } finally {
        ws.terminate();
        await closeServer(server);
      }
    },
  );

  it.each(["worker", "node"] as const)("allows current fenced %s errors to request correction", async (sourceType) => {
    const runId = `run-${sourceType}-current-error`;
    const envelope = startRoundTwo(runId);
    const correctionEvents: unknown[] = [];
    subscribe("dag:node_correction_requested", (payload) => correctionEvents.push(payload));
    let applied = 0;
    const { server, ws, sourceId } = await openTransport(sourceType, runId, () => {
      applied += 1;
    });
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: "researcher",
      target_type: sourceType,
      target_id: sourceId,
    });

    try {
      ws.send(JSON.stringify({
        type: "node_error",
        data: {
          runId,
          nodeId: "actor",
          message: "current round failed",
          session_id: envelope.sessionId,
          round_id: "round-0002",
          actor_id: "researcher",
          generation: 1,
          lease_generation: lease.lease_generation,
          command_id: `${runId}-command-2`,
        },
      }));
      await delay(30);

      expect(correctionEvents).toHaveLength(1);
      expect(applied).toBe(1);
      expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("READY");
    } finally {
      ws.terminate();
      await closeServer(server);
    }
  });

  it.each(["worker", "node"] as const)(
    "rejects stale %s activity when only the nested round fence is present",
    async (sourceType) => {
      const runId = `run-${sourceType}-nested-activity-fence`;
      const envelope = startRoundTwo(runId);
      const { server, ws, sourceId } = await openTransport(sourceType, runId, () => undefined);
      recordDispatch(runId, "actor", sourceType, sourceId);
      const lease = acquireDagActorLease({
        run_id: runId,
        actor_id: "researcher",
        target_type: sourceType,
        target_id: sourceId,
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        ws.send(JSON.stringify({
          type: "stream",
          data: {
            type: "dag_activity",
            event: "dag_activity",
            run_id: runId,
            node_id: "actor",
            session_id: envelope.sessionId,
            round_id: "round-0002",
            actor_id: "researcher",
            generation: 1,
            lease_generation: lease.lease_generation,
            command_id: `${runId}-command-2`,
            activity: {
              schema_version: 1,
              event_id: `${runId}-late-activity`,
              run_id: runId,
              round_id: "round-0001",
              node_id: "actor",
              actor_id: "researcher",
              generation: 1,
              sequence: 1,
              timestamp: Date.now(),
              type: "finding",
              payload: { message: "late round-one evidence" },
            },
          },
        }));
        await delay(30);

        expect(listDagActivityEvents({ run_id: runId }).events).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          "DAG activity identity does not match the transport stream context",
        ));
      } finally {
        warn.mockRestore();
        ws.terminate();
        await closeServer(server);
      }
    },
  );

  it.each(["worker", "node"] as const)(
    "isolates stale %s content, stream, activity, response, and error reports",
    async (sourceType) => {
      const runId = `run-${sourceType}-stale-lease-reports`;
      const envelope = startRoundTwo(runId);
      const sessionId = envelope.sessionId!;
      const auditEvents: unknown[] = [];
      const correctionEvents: unknown[] = [];
      let applied = 0;
      subscribe("dag:stale_lease_ignored", (payload) => auditEvents.push(payload));
      subscribe("dag:node_correction_requested", (payload) => correctionEvents.push(payload));
      const { server, ws, sourceId } = await openTransport(sourceType, runId, () => {
        applied += 1;
      });
      const staleLease = acquireDagActorLease({
        run_id: runId,
        actor_id: "researcher",
        target_type: sourceType,
        target_id: sourceId,
      });
      const reboundLease = acquireDagActorLease({
        run_id: runId,
        actor_id: "researcher",
        target_type: sourceType,
        target_id: `${sourceId}-replacement`,
      });
      const fence = {
        round_id: "round-0002",
        actor_id: "researcher",
        generation: 1,
        lease_generation: staleLease.lease_generation,
        command_id: `${runId}-command-2`,
      };
      const chatsBefore = getDb().prepare("SELECT COUNT(*) AS count FROM dag_chats WHERE run_id = ?")
        .get(runId) as { count: number };

      try {
        ws.send(JSON.stringify({
          type: "content",
          data: {
            text: "token=plain-secret-value",
            run_id: runId,
            node_id: "actor",
            session_id: sessionId,
            ...fence,
          },
        }));
        ws.send(JSON.stringify({
          type: "stream",
          data: {
            event: "tool_call",
            run_id: runId,
            node_id: "actor",
            session_id: sessionId,
            ...fence,
          },
        }));
        ws.send(JSON.stringify({
          type: "stream",
          data: {
            event: "dag_activity",
            run_id: runId,
            node_id: "actor",
            session_id: sessionId,
            ...fence,
            activity: {
              schema_version: 1,
              event_id: `${runId}-stale-activity`,
              run_id: runId,
              round_id: "round-0002",
              node_id: "actor",
              actor_id: "researcher",
              generation: 1,
              lease_generation: staleLease.lease_generation,
              sequence: 1,
              type: "started",
              timestamp: Date.now(),
            },
          },
        }));
        ws.send(JSON.stringify({
          type: "response",
          session_id: sessionId,
          data: {
            type: "node_handoff",
            runId,
            nodeId: "actor",
            port: "summary",
            session_id: sessionId,
            ...fence,
            content: "late handoff",
          },
        }));
        ws.send(JSON.stringify({
          type: "node_error",
          data: {
            runId,
            nodeId: "actor",
            message: "late error",
            session_id: sessionId,
            ...fence,
          },
        }));
        // A source that has learned the new generation must still be rejected
        // when it is no longer the leased physical target.
        ws.send(JSON.stringify({
          type: "content",
          data: {
            text: "forged source",
            run_id: runId,
            node_id: "actor",
            session_id: sessionId,
            ...fence,
            lease_generation: reboundLease.lease_generation,
          },
        }));
        await delay(50);

        expect(getDb().prepare("SELECT COUNT(*) AS count FROM dag_chats WHERE run_id = ?").get(runId))
          .toEqual(chatsBefore);
        expect(loadNodeUsages(runId)).toEqual([]);
        expect(listDagActivityEvents({ run_id: runId })).toMatchObject({ events: [] });
        expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
        expect(correctionEvents).toEqual([]);
        expect(applied).toBe(0);
        expect(auditEvents).toHaveLength(6);
        expect(JSON.stringify(auditEvents)).toContain("DAG_TRANSPORT_LEASE_GENERATION_MISMATCH");
        expect(JSON.stringify(auditEvents)).toContain("DAG_TRANSPORT_LEASE_TARGET_MISMATCH");
        const transcript = JSON.stringify(loadSessionTranscript(sessionId));
        expect(transcript).toContain("stale_lease_content_ignored");
        expect(transcript).toContain("stale_lease_stream_ignored");
        expect(transcript).toContain("stale_lease_dag_activity_ignored");
        expect(transcript).toContain("stale_lease_response_ignored");
        expect(transcript).toContain("stale_lease_node_error_ignored");
        expect(transcript).not.toContain("plain-secret-value");
      } finally {
        ws.terminate();
        await closeServer(server);
      }
    },
  );

  it("isolates stale worker usage and session-end reports", async () => {
    const runId = "run-worker-stale-lease-usage-session-end";
    const envelope = startRoundTwo(runId);
    const sessionId = envelope.sessionId!;
    const auditEvents: unknown[] = [];
    subscribe("dag:stale_lease_ignored", (payload) => auditEvents.push(payload));
    const { server, ws, sourceId } = await openTransport("worker", runId, () => undefined);
    const staleLease = acquireDagActorLease({
      run_id: runId,
      actor_id: "researcher",
      target_type: "worker",
      target_id: sourceId,
    });
    acquireDagActorLease({
      run_id: runId,
      actor_id: "researcher",
      target_type: "worker",
      target_id: `${sourceId}-replacement`,
    });
    const fence = {
      round_id: "round-0002",
      actor_id: "researcher",
      generation: 1,
      lease_generation: staleLease.lease_generation,
      command_id: `${runId}-command-2`,
    };

    try {
      ws.send(JSON.stringify({
        type: "stream",
        data: {
          event: "usage",
          run_id: runId,
          node_id: "actor",
          session_id: sessionId,
          usage: { input_tokens: 101, output_tokens: 23 },
          ...fence,
        },
      }));
      ws.send(JSON.stringify({
        type: "SESSION_END",
        data: {
          run_id: runId,
          node_id: "actor",
          session_id: sessionId,
          ...fence,
        },
      }));
      await delay(50);

      expect(loadNodeUsages(runId)).toEqual([]);
      expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
      expect(auditEvents).toHaveLength(2);
      const transcript = JSON.stringify(loadSessionTranscript(sessionId));
      expect(transcript).toContain("stale_lease_usage_ignored");
      expect(transcript).toContain("stale_lease_session_end_ignored");
    } finally {
      ws.terminate();
      await closeServer(server);
    }
  });
});

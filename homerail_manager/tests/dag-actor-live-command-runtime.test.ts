import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAG_ACTOR_LIVE_COMMAND_CAPABILITY,
  DAG_TRANSPORT_FENCE_CAPABILITY,
  type DagActorLiveCommandMessage,
} from "homerail-protocol";
import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import {
  _clearAllDispatches,
  recordDispatch,
} from "../src/orchestration/dispatch-tracker.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { registerNode, _clearNodes } from "../src/node/registry.js";
import { listDagActorLiveCommands } from "../src/persistence/dag-actor-live-commands.js";
import { getDagActor, listDagActorCommands } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease, getDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  dispatchRecoveredRuns,
  getActiveRun,
  handoffActiveRun,
  recoverAllActiveRuns,
} from "../src/runtime/active-runs.js";
import { getDagActorControlState } from "../src/runtime/dag-actor-control-state.js";
import {
  DagActorLiveCommandRuntimeError,
  recoverDagActorLiveCommands,
  sendDagActorLiveCommands,
} from "../src/runtime/dag-actor-live-command-runtime.js";
import { registerWorker, _clearWorkers } from "../src/worker/registry.js";
import { setupWorkerWebSocket } from "../src/worker/websocket.js";

class CapturingDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    this.dispatched.push(structuredClone(envelope));
    return { status: "dispatched", targetType: "worker", targetId: "test-worker" };
  }
}

function workflow(actorCount = 1) {
  const second = actorCount === 2
    ? `
  actor_two:
    agent: worker
    extra:
      agent_runtime:
        actor_id: actor-2
        role: second
        surface_id: surface-2
    outputs:
      summary: { to: suspend.in:second }
`
    : "";
  return parseDAGYaml(`
name: live-command-runtime
workflow_id: live-command-runtime
agents:
  worker: { agent_type: deterministic }
nodes:
  actor_one:
    agent: worker
    extra:
      agent_runtime:
        actor_id: actor-1
        role: first
        surface_id: surface-1
    outputs:
      summary: { to: suspend.in:first }
${second}
  suspend:
    type: await_command
    after: [actor_one${actorCount === 2 ? ", actor_two" : ""}]
    gateway_config:
      primitive_version: 1
      target_actors: [actor_one${actorCount === 2 ? ", actor_two" : ""}]
      command_port: command
`);
}

function fakeSocket(send = vi.fn()) {
  return { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
}

function bindFakeWorker(runId: string, nodeIds: string[], capabilities: string[], send = vi.fn()) {
  const socket = fakeSocket(send);
  registerWorker({
    worker_id: "test-worker",
    project_id: "default",
    socket,
    status: "idle",
    capabilities,
    registered_at: Date.now(),
    last_heartbeat: Date.now(),
  });
  for (const nodeId of nodeIds) {
    const actor = getDagActor(runId, nodeId === "actor_one" ? "actor-1" : "actor-2")!;
    recordDispatch(runId, nodeId, "worker", "test-worker");
    acquireDagActorLease({
      run_id: runId,
      actor_id: actor.actor_id,
      target_type: "worker",
      target_id: "test-worker",
    });
  }
  return { socket, send };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("server did not bind");
    resolve(address.port);
  }));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DAG Actor live-command runtime", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-live-runtime-"));
    process.env.HOMERAIL_HOME = home;
    _clearActiveRuns();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    _clearAllPersistence();
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    _clearAllPersistence();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps socket write queued and advances Worker status through the full persisted fence", async () => {
    const runId = "run-live-websocket";
    const dispatcher = new CapturingDispatcher();
    createActiveRun(runId, workflow());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);

    const server = http.createServer();
    setupWorkerWebSocket(server, { registrationTimeoutMs: 500, pingIntervalMs: 5_000 });
    const port = await listen(server);
    const workerId = "ws-live-worker";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/default/workers/${workerId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({
      type: "register",
      worker_id: workerId,
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY, DAG_ACTOR_LIVE_COMMAND_CAPABILITY],
    }));
    await delay();
    recordDispatch(runId, "actor_one", "worker", workerId);
    acquireDagActorLease({
      run_id: runId,
      actor_id: "actor-1",
      target_type: "worker",
      target_id: workerId,
    });
    const expectedToken = getDagActorControlState(runId, "actor-1").state_token;
    const outbound = new Promise<DagActorLiveCommandMessage>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as DagActorLiveCommandMessage));
    });

    try {
      const submitted = sendDagActorLiveCommands(runId, {
        commands: [{
          actor_id: "actor-1",
          idempotency_key: "manager-turn-1",
          expected_state_token: expectedToken,
          payload: { instruction: "steer now" },
        }],
      });
      expect(submitted).toMatchObject({ delivery_mode: "live", sent: 1, fallback_pending: 0 });
      const message = await outbound;
      expect(message.type).toBe("dag_actor_command");
      expect(listDagActorLiveCommands({ run_id: runId })[0]).toMatchObject({
        status: "queued",
        delivery_attempts: 1,
      });

      const { idempotency_key: _idempotencyKey, payload: _payload, ...statusFence } = message.data;

      const wrongEcho = {
        type: "dag_actor_command_status",
        data: { ...statusFence, expected_state_token: "b".repeat(64), status: "accepted" },
      };
      ws.send(JSON.stringify(wrongEcho));
      await delay();
      expect(listDagActorLiveCommands({ run_id: runId })[0].status).toBe("queued");

      const tokenBeforeStatus = getDagActorControlState(runId, "actor-1").state_token;
      acquireDagActorLease({
        run_id: runId,
        actor_id: "actor-1",
        target_type: "worker",
        target_id: workerId,
      });
      expect(getDagActorControlState(runId, "actor-1").state_token).not.toBe(tokenBeforeStatus);
      for (const status of ["accepted", "applied", "completed"] as const) {
        ws.send(JSON.stringify({
          type: "dag_actor_command_status",
          data: { ...statusFence, status },
        }));
        await delay();
      }
      expect(listDagActorLiveCommands({ run_id: runId })[0]).toMatchObject({
        status: "completed",
        delivered_at: expect.any(Number),
        applied_at: expect.any(Number),
        terminal_at: expect.any(Number),
      });
    } finally {
      ws.terminate();
      await closeServer(server);
    }
  });

  it("rolls back an active batch when one sibling state token is stale", () => {
    const runId = "run-live-atomic";
    const dispatcher = new CapturingDispatcher();
    createActiveRun(runId, workflow(2));
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(2);
    bindFakeWorker(runId, ["actor_one", "actor_two"], [DAG_ACTOR_LIVE_COMMAND_CAPABILITY]);
    const actorOneBefore = getDagActorControlState(runId, "actor-1");
    const actorTwoBefore = getDagActorControlState(runId, "actor-2");

    expect(() => sendDagActorLiveCommands(runId, {
      commands: [
        {
          actor_id: "actor-1",
          idempotency_key: "atomic-1",
          expected_state_token: actorOneBefore.state_token,
          payload: "one",
        },
        {
          actor_id: "actor-2",
          idempotency_key: "atomic-2",
          expected_state_token: "f".repeat(64),
          payload: "two",
        },
      ],
    })).toThrowError(expect.objectContaining<DagActorLiveCommandRuntimeError>({ code: "state_token_conflict" }));
    expect(listDagActorLiveCommands({ run_id: runId })).toEqual([]);
    expect(getDagActorControlState(runId, "actor-1")).toEqual(actorOneBefore);
    expect(getDagActorControlState(runId, "actor-2")).toEqual(actorTwoBefore);
  });

  it("consumes unsupported commands in sequence at round boundaries until completed", () => {
    const runId = "run-live-fallback";
    const dispatcher = new CapturingDispatcher();
    createActiveRun(runId, workflow());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    bindFakeWorker(runId, ["actor_one"], []);
    const token = getDagActorControlState(runId, "actor-1").state_token;
    for (const key of ["fallback-1", "fallback-2"]) {
      expect(sendDagActorLiveCommands(runId, {
        commands: [{ actor_id: "actor-1", idempotency_key: key, expected_state_token: token, payload: key }],
      })).toMatchObject({ sent: 0, fallback_pending: 1 });
    }
    expect(listDagActorLiveCommands({ run_id: runId }).map((command) => command.sequence)).toEqual([1, 2]);

    handoffActiveRun(runId, "actor_one", "summary", { round: 1 });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)).toMatchObject({ status: "active", currentRound: { round_id: "round-0002" } });
    let linked = listDagActorCommands({ run_id: runId, round_id: "round-0002" });
    expect(linked).toHaveLength(1);
    expect(linked[0].command_id).toBe(listDagActorLiveCommands({ run_id: runId })[0].command_id);

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    let lease = getDagActorLease({ run_id: runId, actor_id: "actor-1" })!;
    handoffActiveRun(runId, "actor_one", "summary", { round: 2 }, {
      transport: true,
      roundId: "round-0002",
      actorId: "actor-1",
      generation: 1,
      leaseGeneration: lease.lease_generation,
      commandId: linked[0].command_id,
    });
    expect(listDagActorLiveCommands({ run_id: runId })[0].status).toBe("completed");

    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)?.currentRound.round_id).toBe("round-0003");
    linked = listDagActorCommands({ run_id: runId, round_id: "round-0003" });
    expect(linked).toHaveLength(1);
    expect(linked[0].command_id).toBe(listDagActorLiveCommands({ run_id: runId })[1].command_id);
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    lease = getDagActorLease({ run_id: runId, actor_id: "actor-1" })!;
    handoffActiveRun(runId, "actor_one", "summary", { round: 3 }, {
      transport: true,
      roundId: "round-0003",
      actorId: "actor-1",
      generation: 1,
      leaseGeneration: lease.lease_generation,
      commandId: linked[0].command_id,
    });
    expect(listDagActorLiveCommands({ run_id: runId }).map((command) => command.status))
      .toEqual(["completed", "completed"]);
  });

  it("recovers queued commands after restart and never writes live commands to a direct Node socket", () => {
    const runId = "run-live-recovery";
    const dispatcher = new CapturingDispatcher();
    createActiveRun(runId, workflow());
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    const nodeSend = vi.fn();
    registerNode({
      node_id: "direct-node",
      project_id: "default",
      socket: fakeSocket(nodeSend),
      status: "idle",
      capabilities: [DAG_ACTOR_LIVE_COMMAND_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });
    recordDispatch(runId, "actor_one", "node", "direct-node");
    acquireDagActorLease({
      run_id: runId,
      actor_id: "actor-1",
      target_type: "node",
      target_id: "direct-node",
    });
    const token = getDagActorControlState(runId, "actor-1").state_token;
    expect(sendDagActorLiveCommands(runId, {
      commands: [{ actor_id: "actor-1", idempotency_key: "recover-1", expected_state_token: token, payload: "recover" }],
    })).toMatchObject({ sent: 0, fallback_pending: 1 });
    expect(nodeSend).not.toHaveBeenCalled();

    _clearActiveRuns();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    closeDb();
    expect(recoverAllActiveRuns()).toMatchObject({ recovered: [runId], failed: [] });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor_one")).toBe("READY");

    const workerSend = vi.fn();
    bindFakeWorker(runId, [], [DAG_ACTOR_LIVE_COMMAND_CAPABILITY], workerSend);
    expect(dispatchRecoveredRuns(dispatcher)).toBe(1);
    recordDispatch(runId, "actor_one", "worker", "test-worker");
    acquireDagActorLease({
      run_id: runId,
      actor_id: "actor-1",
      target_type: "worker",
      target_id: "test-worker",
    });
    expect(recoverDagActorLiveCommands().sent).toEqual([listDagActorLiveCommands({ run_id: runId })[0].command_id]);
    expect(workerSend).toHaveBeenCalledTimes(1);
    expect(listDagActorLiveCommands({ run_id: runId })[0]).toMatchObject({ status: "queued", delivery_attempts: 1 });
  });
});

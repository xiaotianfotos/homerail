import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY } from "homerail-protocol";

import type { DAGDispatcher, DispatchEnvelope, DispatchResult } from "../src/orchestration/dag-dispatcher.js";
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { listDagActorCommands } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { _clearAllPersistence, loadRunMetadata } from "../src/persistence/store.js";
import { _clearNodes } from "../src/node/registry.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import { createServer } from "../src/server/http.js";
import { _clearWorkers, getWorker } from "../src/worker/registry.js";

class CapturingDispatcher implements DAGDispatcher {
  readonly dispatched: DispatchEnvelope[] = [];

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    if (!envelope.activity) throw new Error("test dispatch is missing actor identity");
    const lease = acquireDagActorLease({
      run_id: envelope.runId,
      actor_id: envelope.activity.actorId,
      target_type: "worker",
      target_id: "worker-hot",
    });
    this.dispatched.push(structuredClone({
      ...envelope,
      activity: {
        ...envelope.activity,
        leaseGeneration: lease.lease_generation,
      },
    }));
    return { status: "dispatched", targetType: "fake", targetId: "worker-hot" };
  }
}

function multiRoundDag(options: { maxDispatches?: number } = {}) {
  return parseDAGYaml(`
name: multi-round-api
workflow_id: multi-round-api
${options.maxDispatches === undefined ? "" : `limits:\n  max_dispatches: ${options.maxDispatches}\n`}
agents:
  worker: { agent_type: deterministic }
nodes:
  actor:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
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

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function jsonResponse(url: string, init?: RequestInit): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function jsonPost(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Homerail-Dag-Token": token } : {}),
    },
    body: JSON.stringify(body),
  };
}

function moveToWaiting(
  runId: string,
  dispatcher: CapturingDispatcher,
  dag = multiRoundDag(),
): DispatchEnvelope {
  createActiveRun(runId, dag);
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  const firstEnvelope = dispatcher.dispatched.at(-1)!;
  handoffActiveRun(runId, "actor", "summary", { result: "round one" });
  expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
  expect(getActiveRun(runId)?.status).toBe("waiting");
  return firstEnvelope;
}

describe("multi-round DAG HTTP API", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldMutationToken: string | undefined;
  let server: http.Server | undefined;
  let workerSocket: WebSocket | undefined;
  let legacyWorkerSocket: WebSocket | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldMutationToken = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-multiround-api-"));
    process.env.HOMERAIL_HOME = tmpHome;
    delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
  });

  afterEach(async () => {
    workerSocket?.terminate();
    workerSocket = undefined;
    legacyWorkerSocket?.terminate();
    legacyWorkerSocket = undefined;
    await closeServer(server);
    _clearActiveRuns();
    _clearAllPersistence();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldMutationToken === undefined) delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;
    else process.env.HOMERAIL_DAG_MUTATION_TOKEN = oldMutationToken;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("observes, resumes, deduplicates, and explicitly completes a waiting run", async () => {
    const runId = "multi-round-http";
    const dispatcher = new CapturingDispatcher();
    moveToWaiting(runId, dispatcher);
    server = createServer(0, undefined, dispatcher, false, { autoDetectCodex: false });
    const baseUrl = `http://127.0.0.1:${await listen(server)}`;

    const status = await jsonResponse(`${baseUrl}/api/runs/${runId}/status`);
    expect(status).toMatchObject({
      status: 200,
      body: {
        data: {
          status: "waiting",
          terminal: false,
          current_round: { round_id: "round-0001", ordinal: 1, status: "waiting" },
        },
      },
    });
    expect(await jsonResponse(`${baseUrl}/api/runs/${runId}/supervise`)).toMatchObject({
      body: { data: { terminal: false } },
    });
    expect(await jsonResponse(`${baseUrl}/api/dag-status/${runId}`)).toMatchObject({
      body: {
        data: {
          execution: {
            complete: false,
            waiting_nodes: ["suspend"],
            nodes: { suspend: { status: "waiting_for_command" } },
          },
        },
      },
    });
    const rounds = await jsonResponse(`${baseUrl}/api/runs/${runId}/rounds`);
    expect(rounds.body).toMatchObject({
      data: { total: 1, rounds: [{ round_id: "round-0001", status: "waiting" }] },
    });
    const emptyCommands = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`);
    expect(emptyCommands.body).toMatchObject({ data: { total: 0, commands: [] } });

    const stale = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost({
      expected_round_id: "stale-round",
      commands: [{ actor_id: "researcher", payload: "continue" }],
    }));
    expect(stale.status).toBe(409);

    const request = {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "researcher",
        command_id: "command-http-round-2",
        idempotency_key: "http-round-2",
        payload: { task: "continue" },
      }],
    };
    const resumed = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost(request));
    expect(resumed).toMatchObject({
      status: 200,
      body: {
        data: {
          resumed: true,
          previous_round_id: "round-0001",
          round_id: "round-0002",
          command_ids: ["command-http-round-2"],
          actor_ids: ["researcher"],
          dispatched: 1,
        },
      },
    });
    expect(dispatcher.dispatched.at(-1)?.activity).toMatchObject({
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      commandId: "command-http-round-2",
    });

    const retry = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost(request));
    expect(retry).toMatchObject({ status: 200, body: { data: { deduplicated: true, dispatched: 0 } } });
    const commandList = await jsonResponse(
      `${baseUrl}/api/runs/${runId}/commands?round_id=round-0002&status=delivered`,
    );
    expect(commandList.body).toMatchObject({
      data: {
        total: 1,
        commands: [{ command_id: "command-http-round-2", status: "delivered" }],
      },
    });

    const prematureComplete = await jsonResponse(`${baseUrl}/api/runs/${runId}/complete`, jsonPost({
      expected_round_id: "round-0002",
    }));
    expect(prematureComplete.status).toBe(409);

    handoffActiveRun(runId, "actor", "summary", { result: "round two" }, {
      transport: true,
      roundId: "round-0002",
      actorId: "researcher",
      generation: 1,
      leaseGeneration: dispatcher.dispatched.at(-1)!.activity!.leaseGeneration,
      commandId: "command-http-round-2",
    });
    expect(dispatchReadyNodes(runId, dispatcher)).toBe(1);
    expect(getActiveRun(runId)?.status).toBe("waiting");
    const completed = await jsonResponse(`${baseUrl}/api/runs/${runId}/complete`, jsonPost({
      expected_round_id: "round-0002",
    }));
    expect(completed).toMatchObject({ status: 200, body: { data: { completed: true } } });
    expect(getActiveRun(runId)?.status).toBe("completed");
    expect(await jsonResponse(`${baseUrl}/api/runs/${runId}/status`)).toMatchObject({
      body: { data: { status: "completed", terminal: true } },
    });
    expect(await jsonResponse(`${baseUrl}/api/runs/${runId}/supervise`)).toMatchObject({
      body: { data: { terminal: true } },
    });
    expect(await jsonResponse(`${baseUrl}/api/dag-status/${runId}`)).toMatchObject({
      body: { data: { execution: { complete: true } } },
    });
  });

  it("requires the configured DAG mutation token for resume and completion", async () => {
    const runId = "multi-round-http-auth";
    const dispatcher = new CapturingDispatcher();
    moveToWaiting(runId, dispatcher);
    process.env.HOMERAIL_DAG_MUTATION_TOKEN = "dag-test-token";
    server = createServer(0, undefined, dispatcher, false, { autoDetectCodex: false });
    const baseUrl = `http://127.0.0.1:${await listen(server)}`;
    const request = {
      expected_round_id: "round-0001",
      commands: [{ actor_id: "researcher", payload: "continue" }],
    };

    expect((await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost(request))).status).toBe(403);
    expect((await jsonResponse(
      `${baseUrl}/api/runs/${runId}/commands`,
      jsonPost(request, "dag-test-token"),
    )).status).toBe(200);
    expect((await jsonResponse(`${baseUrl}/api/runs/${runId}/complete`, jsonPost({
      expected_round_id: "round-0002",
    }))).status).toBe(403);
  });

  it("keeps an offline resumed command retryable and dispatches it after worker registration", async () => {
    const runId = "multi-round-http-offline-resume";
    moveToWaiting(runId, new CapturingDispatcher(), multiRoundDag({ maxDispatches: 1 }));
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "researcher",
        command_id: "command-offline-round-2",
        idempotency_key: "offline-round-2",
        payload: { task: "continue after reconnect" },
      }],
    };

    const resumed = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost(request));
    expect(resumed).toMatchObject({
      status: 200,
      body: { data: { resumed: true, round_id: "round-0002", dispatched: 0 } },
    });
    expect(getActiveRun(runId)?.status).toBe("active");
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("READY");
    expect(getActiveRun(runId)?.limits.max_dispatches).toBe(1);
    expect(getActiveRun(runId)?.counters.dispatches).toBe(0);
    expect(loadRunMetadata(runId)).toMatchObject({
      status: "active",
      currentRound: { round_id: "round-0002", status: "active" },
      nodeStates: { actor: "READY" },
    });
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: "command-offline-round-2", status: "pending" },
    ]);

    workerSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/p1/workers/reconnected-worker`);
    await new Promise<void>((resolve, reject) => {
      workerSocket!.once("open", resolve);
      workerSocket!.once("error", reject);
    });
    const prompt = new Promise<{ type: string; envelope: DispatchEnvelope }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for resumed prompt")), 2_000);
      workerSocket!.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; envelope?: DispatchEnvelope };
        if (message.type !== "prompt" || !message.envelope) return;
        clearTimeout(timeout);
        resolve({ type: message.type, envelope: message.envelope });
      });
    });
    workerSocket.send(JSON.stringify({
      type: "register",
      worker_id: "reconnected-worker",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
    }));

    await expect(prompt).resolves.toMatchObject({
      type: "prompt",
      envelope: {
        runId,
        nodeId: "actor",
        activity: {
          roundId: "round-0002",
          actorId: "researcher",
          commandId: "command-offline-round-2",
        },
      },
    });
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      counters: { dispatches: 1 },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: "command-offline-round-2", status: "delivered" },
    ]);
  });

  it("keeps round two retryable until a transport-fence-compatible worker registers", async () => {
    const runId = "multi-round-http-incompatible-worker";
    moveToWaiting(runId, new CapturingDispatcher());
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    legacyWorkerSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/p1/workers/legacy-worker`);
    await new Promise<void>((resolve, reject) => {
      legacyWorkerSocket!.once("open", resolve);
      legacyWorkerSocket!.once("error", reject);
    });
    legacyWorkerSocket.send(JSON.stringify({
      type: "register",
      worker_id: "legacy-worker",
      capabilities: [],
    }));
    await vi.waitFor(() => expect(getWorker("legacy-worker")).toBeDefined());

    const request = {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "researcher",
        command_id: "command-compatible-round-2",
        idempotency_key: "compatible-round-2",
        payload: { task: "wait for a compatible worker" },
      }],
    };
    const resumed = await jsonResponse(`${baseUrl}/api/runs/${runId}/commands`, jsonPost(request));
    expect(resumed).toMatchObject({
      status: 200,
      body: { data: { resumed: true, round_id: "round-0002", dispatched: 0 } },
    });
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      currentRound: { round_id: "round-0002", status: "active" },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("READY");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: "command-compatible-round-2", status: "pending" },
    ]);

    workerSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/projects/p1/workers/compatible-worker`);
    await new Promise<void>((resolve, reject) => {
      workerSocket!.once("open", resolve);
      workerSocket!.once("error", reject);
    });
    const prompt = new Promise<{ type: string; envelope: DispatchEnvelope }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for compatible worker prompt")), 3_000);
      workerSocket!.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; envelope?: DispatchEnvelope };
        if (message.type !== "prompt" || !message.envelope) return;
        clearTimeout(timeout);
        resolve({ type: message.type, envelope: message.envelope });
      });
    });
    workerSocket.send(JSON.stringify({
      type: "register",
      worker_id: "compatible-worker",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
    }));

    await expect(prompt).resolves.toMatchObject({
      type: "prompt",
      envelope: {
        runId,
        nodeId: "actor",
        activity: {
          roundId: "round-0002",
          actorId: "researcher",
          commandId: "command-compatible-round-2",
        },
      },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: "command-compatible-round-2", status: "delivered" },
    ]);
  }, 10_000);
});

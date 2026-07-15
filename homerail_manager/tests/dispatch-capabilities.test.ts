import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY } from "homerail-protocol";

import type { DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import {
  _clearAllDispatches,
  excludeCurrentDispatchTarget,
  recordDispatch,
  recordProvisioning,
} from "../src/orchestration/dispatch-tracker.js";
import { normalizeAgentBackend, WsDispatchAdapter } from "../src/orchestration/ws-dispatch-adapter.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners, subscribe } from "../src/events/bus.js";
import { registerNode, _clearNodes } from "../src/node/registry.js";
import { createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { listDagActorCommands } from "../src/persistence/dag-actors.js";
import { appendSessionTranscriptForTest, loadSessionTranscript } from "../src/persistence/dag-session-files.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  acquireDagActorLease,
  getDagActorLease,
  registerDagProvisionedWorker,
  releaseDagActorLease,
  transitionDagProvisionedWorker,
} from "../src/persistence/dag-actor-leases.js";
import {
  _clearActiveRuns,
  checkpointResumeActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  getCurrentNodeSession,
  handoffActiveRun,
  resumeWaitingActiveRun,
} from "../src/runtime/active-runs.js";
import { registerWorker, _clearWorkers } from "../src/worker/registry.js";

function makeSocket() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function makeEnvelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    runId: "run-capabilities",
    nodeId: "diagnose",
    agentId: "deployment_diagnoser",
    agentConfig: { agent_type: "claude-sdk" },
    inputs: {},
    outgoingEdges: [],
    workflowId: "deployment-diagnosis",
    workflowName: "Deployment Diagnosis",
    image: "homerail-worker:latest",
    activity: {
      roundId: "round-0001",
      actorId: "diagnose",
      generation: 1,
      surfaceId: "surface:diagnose",
    },
    ...overrides,
  };
}

function waitForProvisioningCompleted(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe("dag:provisioning_completed", (payload) => {
      if ((payload as { runId?: string }).runId !== runId) return;
      unsubscribe();
      resolve();
    });
  });
}

describe("DAG node capability requirements", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dispatch-capabilities-"));
    process.env.HOMERAIL_HOME = tmpHome;
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    _clearListeners();
    createActiveRun("run-capabilities", parseDAGYaml(`
name: dispatch-capabilities-fixture
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    outputs:
      done: { to: "" }
`));
    // Direct adapter tests exercise transport without keeping an in-memory run,
    // while preserving the durable actor identity required by lease binding.
    _clearActiveRuns();
  });

  it("normalizes public Kimi Code backend aliases", () => {
    expect(normalizeAgentBackend("kimi-code")).toBe("kimi_code");
    expect(normalizeAgentBackend("kimi")).toBe("kimi_code");
    expect(normalizeAgentBackend("kimi_code")).toBe("kimi_code");
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    closeDb();
    _clearAllDispatches();
    _clearWorkers();
    _clearNodes();
    _clearListeners();
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("preserves normalized requires.capabilities from DAG YAML", () => {
    const parsed = parseDAGYaml(`
name: specialized-diagnosis
agents:
  deployment_diagnoser:
    agent_type: claude-sdk
nodes:
  diagnose:
    agent: deployment_diagnoser
    requires:
      capabilities:
        - " browser "
        - docker-cli
        - 42
    outputs:
      done:
        to: ""
`);

    expect(parsed.graph.nodes[0].requires).toEqual({
      capabilities: ["browser", "docker-cli"],
    });
  });

  it("dispatches required-capability nodes only to matching workers", () => {
    const genericSocket = makeSocket();
    const hostSocket = makeSocket();
    registerWorker({
      worker_id: "generic-worker",
      project_id: "p1",
      socket: genericSocket,
      status: "idle",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    registerWorker({
      worker_id: "browser-worker",
      project_id: "p1",
      socket: hostSocket,
      status: "idle",
      capabilities: ["browser", "docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ requiredCapabilities: ["browser"] }),
    );

    expect(result).toMatchObject({
      status: "dispatched",
      targetType: "worker",
      targetId: "browser-worker",
    });
    expect(genericSocket.send).not.toHaveBeenCalled();
    expect(hostSocket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(hostSocket.send.mock.calls[0]?.[0])) as {
      envelope: DispatchEnvelope;
    };
    expect(sent.envelope.activity).toMatchObject({
      actorId: "diagnose",
      leaseGeneration: 1,
    });
  });

  it("does not retry a prompt that was sent before chat persistence failed", () => {
    const socket = makeSocket();
    registerWorker({
      worker_id: "post-send-worker",
      project_id: "p1",
      socket,
      status: "idle",
      capabilities: [],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    getDb().exec(`
      CREATE TRIGGER fail_post_send_chat
      BEFORE INSERT ON dag_chats
      BEGIN
        SELECT RAISE(ABORT, 'forced post-send chat failure');
      END;
    `);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(new WsDispatchAdapter({ provisioner: false }).dispatch(makeEnvelope())).toMatchObject({
        status: "dispatched",
        targetType: "worker",
        targetId: "post-send-worker",
      });
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(getDagActorLease({ run_id: "run-capabilities", actor_id: "diagnose" })).toMatchObject({
        state: "leased",
        target_type: "worker",
        target_id: "post-send-worker",
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("prompt was sent but chat persistence failed"));
    } finally {
      warn.mockRestore();
      getDb().exec("DROP TRIGGER IF EXISTS fail_post_send_chat");
    }
  });

  it("reuses the previous online worker for a hot multi-round actor", () => {
    const otherSocket = makeSocket();
    const hotSocket = makeSocket();
    registerWorker({
      worker_id: "other-worker",
      project_id: "p1",
      socket: otherSocket,
      status: "idle",
      capabilities: ["browser"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    registerWorker({
      worker_id: "hot-worker",
      project_id: "p1",
      socket: hotSocket,
      status: "idle",
      capabilities: ["browser"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    recordDispatch("run-capabilities", "diagnose", "worker", "hot-worker");

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ requiredCapabilities: ["browser"] }),
    );

    expect(result).toMatchObject({
      status: "dispatched",
      targetType: "worker",
      targetId: "hot-worker",
    });
    expect(hotSocket.send).toHaveBeenCalledTimes(1);
    expect(otherSocket.send).not.toHaveBeenCalled();
  });

  it("reassigns an actor without allowing the next dispatch to reuse its previous Worker", () => {
    const replacementSocket = makeSocket();
    const previousSocket = makeSocket();
    registerWorker({
      worker_id: "replacement-worker",
      project_id: "p1",
      socket: replacementSocket,
      status: "idle",
      capabilities: ["browser"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    registerWorker({
      worker_id: "previous-worker",
      project_id: "p1",
      socket: previousSocket,
      status: "idle",
      capabilities: ["browser"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    recordDispatch("run-capabilities", "diagnose", "worker", "previous-worker");
    excludeCurrentDispatchTarget("run-capabilities", "diagnose");

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ requiredCapabilities: ["browser"] }),
    );

    expect(result).toMatchObject({
      status: "dispatched",
      targetType: "worker",
      targetId: "replacement-worker",
    });
    expect(replacementSocket.send).toHaveBeenCalledTimes(1);
    expect(previousSocket.send).not.toHaveBeenCalled();
  });

  it("mirrors dispatched prompts into the manager-side session store", () => {
    const socket = makeSocket();
    registerWorker({
      worker_id: "session-worker",
      project_id: "p1",
      socket,
      status: "idle",
      capabilities: [],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({
        sessionId: "dispatch-session-1",
        inputs: { task: ["inspect this"] },
        agentConfig: {
          agent_type: "claude-sdk",
          llm: { api_key: "pk-should-not-persist", model: "test-model" },
        },
        advisors: [{
          id: "expert",
          agent_id: "advisor",
          agent_type: "claude-sdk",
          model: "advisor-model",
          api_key: "pk-advisor-should-not-persist",
          max_calls: 1,
          timeout_ms: 1000,
          max_tokens: 100,
        }],
      }),
    );

    expect(result.status).toBe("dispatched");
    const transcript = loadSessionTranscript("dispatch-session-1");
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      type: "prompt",
      runId: "run-capabilities",
      nodeId: "diagnose",
      sessionId: "dispatch-session-1",
    });
    expect(JSON.stringify(transcript)).not.toContain("pk-should-not-persist");
    expect(JSON.stringify(transcript)).not.toContain("pk-advisor-should-not-persist");
    expect(transcript[0].content).toMatchObject({
      advisors: [{ id: "expert", api_key: "***REDACTED***" }],
    });
  });

  it("keeps a required-capability node READY instead of falling back to a Node", () => {
    const nodeSocket = makeSocket();
    registerNode({
      node_id: "docker-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["browser", "docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });
    createActiveRun("run-required-capability", parseDAGYaml(`
name: required-capability
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    requires:
      capabilities: [browser]
    outputs: { done: { to: "" } }
`));
    const adapter = new WsDispatchAdapter({ provisioner: false });
    const dispatch = vi.spyOn(adapter, "dispatch");

    expect(dispatchReadyNodes("run-required-capability", adapter)).toBe(0);

    expect(dispatch).toHaveReturnedWith(expect.objectContaining({
      status: "skipped",
    }));
    expect(getActiveRun("run-required-capability")).toMatchObject({
      status: "active",
    });
    expect(getActiveRun("run-required-capability")?.dagRun.nodeStates.get("diagnose")).toBe("READY");
    expect(nodeSocket.send).not.toHaveBeenCalled();
  });

  it("keeps an offline node READY and retries after a compatible worker registers", async () => {
    createActiveRun("run-offline-node-reconnect", parseDAGYaml(`
name: offline-node-reconnect
workflow_id: offline-node-reconnect
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    outputs: { done: { to: "" } }
`));
    const adapter = new WsDispatchAdapter({ provisioner: false });

    expect(dispatchReadyNodes("run-offline-node-reconnect", adapter)).toBe(0);
    expect(getActiveRun("run-offline-node-reconnect")).toMatchObject({ status: "active" });
    expect(getActiveRun("run-offline-node-reconnect")?.dagRun.nodeStates.get("diagnose")).toBe("READY");

    const workerSocket = makeSocket();
    registerWorker({
      worker_id: "late-worker",
      project_id: "p1",
      socket: workerSocket,
      status: "idle",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });

    await vi.waitFor(
      () => expect(workerSocket.send).toHaveBeenCalledTimes(1),
      { timeout: 2_500 },
    );
    expect(getActiveRun("run-offline-node-reconnect")?.dagRun.nodeStates.get("diagnose")).toBe("RUNNING");
    expect(JSON.parse(String(workerSocket.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "prompt",
      envelope: { runId: "run-offline-node-reconnect", nodeId: "diagnose" },
    });
  });

  it("contains an offline retry timer dispatch error and recovers after another target change", async () => {
    const runId = "run-offline-retry-error";
    createActiveRun(runId, parseDAGYaml(`
name: offline-retry-error
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    outputs: { done: { to: "" } }
`));
    const adapter = new WsDispatchAdapter({ provisioner: false });
    const originalDispatch = adapter.dispatch.bind(adapter);
    let throwOnNextDispatch = false;
    const dispatch = vi.spyOn(adapter, "dispatch").mockImplementation((envelope) => {
      if (throwOnNextDispatch) {
        throwOnNextDispatch = false;
        throw new Error("forced offline retry dispatch failure");
      }
      return originalDispatch(envelope);
    });

    expect(dispatchReadyNodes(runId, adapter)).toBe(0);
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("READY");

    throwOnNextDispatch = true;
    const firstWorkerSocket = makeSocket();
    registerWorker({
      worker_id: "offline-retry-worker-1",
      project_id: "p1",
      socket: firstWorkerSocket,
      status: "idle",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    await vi.waitFor(
      () => expect(dispatch).toHaveBeenCalledTimes(2),
      { timeout: 2_500 },
    );
    expect(firstWorkerSocket.send).not.toHaveBeenCalled();
    expect(getActiveRun(runId)).toMatchObject({ status: "active" });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("READY");

    const secondWorkerSocket = makeSocket();
    registerWorker({
      worker_id: "offline-retry-worker-2",
      project_id: "p1",
      socket: secondWorkerSocket,
      status: "idle",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    await vi.waitFor(
      () => expect(firstWorkerSocket.send.mock.calls.length + secondWorkerSocket.send.mock.calls.length).toBe(1),
      { timeout: 3_500 },
    );
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("RUNNING");
  }, 8_000);

  it("keeps socket send errors on the failed dispatch path", () => {
    const workerSocket = makeSocket();
    workerSocket.send.mockImplementation(() => {
      throw new Error("socket write failed");
    });
    registerWorker({
      worker_id: "broken-worker",
      project_id: "p1",
      socket: workerSocket,
      status: "idle",
      capabilities: [],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });

    expect(new WsDispatchAdapter({ provisioner: false }).dispatch(makeEnvelope())).toMatchObject({
      status: "failed",
      reason: "socket write failed",
      retryable: true,
    });
  });

  it("provisions a run-scoped worker instead of reusing generic workers for isolated workspaces", async () => {
    const genericSocket = makeSocket();
    const nodeSocket = makeSocket();
    const created: Array<{
      nodeId: string;
      workspaceId: string;
      image?: string;
      workspace?: Record<string, unknown>;
      workspaceReadOnly?: boolean;
    }> = [];
    registerWorker({
      worker_id: "generic-worker",
      project_id: "p1",
      socket: genericSocket,
      status: "idle",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    registerNode({
      node_id: "docker-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });

    const result = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (nodeId, workspaceId, opts) => {
          created.push({
            nodeId,
            workspaceId,
            image: opts.image,
            workspace: opts.workspace,
            workspaceReadOnly: opts.workspaceReadOnly,
          });
          return { status: "success", resource_data: { id: "container-1" } };
        },
        startFn: async () => ({ status: "success" }),
        runtimeStatusFn: async () => ({
          worker_ids: ["provisioned-run-capabilities-diagnose"],
        }),
      },
    }).dispatch(
      makeEnvelope({
        image: "custom-worker:v2",
        workspace: { mode: "isolated" },
        workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
      }),
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "provisioning_in_progress",
    });
    expect(genericSocket.send).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(created).toEqual([
        {
          nodeId: "docker-node",
          workspaceId: "run-capabilities",
          image: "custom-worker:v2",
          workspace: { mode: "isolated" },
          workspaceReadOnly: true,
        },
      ]);
    });
  });

  it("provisions through a docker-api Node before waiting for a capability-matched Worker", async () => {
    const nodeSocket = makeSocket();
    const created: Array<{ nodeId: string; workspaceId: string }> = [];
    registerNode({
      node_id: "docker-api-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["docker-api"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });

    const result = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (nodeId, workspaceId) => {
          created.push({ nodeId, workspaceId });
          return { status: "success", resource_data: { id: "container-api" } };
        },
        startFn: async () => ({ status: "success" }),
        runtimeStatusFn: async () => ({
          worker_ids: ["provisioned-run-capabilities-diagnose"],
        }),
      },
    }).dispatch(makeEnvelope({ requiredCapabilities: ["browser"] }));

    expect(result).toMatchObject({
      status: "skipped",
      reason: "provisioning_in_progress",
    });
    await vi.waitFor(() => {
      expect(created).toEqual([
        {
          nodeId: "docker-api-node",
          workspaceId: "run-capabilities",
        },
      ]);
    });
  });

  it("keeps a node READY when its provisioned Worker lacks required capabilities", async () => {
    const runId = "run-provisioned-capability-mismatch";
    const nodeSocket = makeSocket();
    registerNode({
      node_id: "provisioning-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["docker-api"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });
    createActiveRun(runId, parseDAGYaml(`
name: provisioned-capability-mismatch
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    requires:
      capabilities: [browser]
    outputs: { done: { to: "" } }
`));

    let provisionedWorkerId: string | undefined;
    const incompatibleSocket = makeSocket();
    const provisioningCompleted = waitForProvisioningCompleted(runId);
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (_nodeId, _workspaceId, opts) => {
          provisionedWorkerId = opts.env?.HOMERAIL_WORKER_ID;
          return { status: "success", resource_data: { id: "container-incompatible" } };
        },
        startFn: async () => {
          if (!provisionedWorkerId) throw new Error("missing provisioned worker id");
          registerWorker({
            worker_id: provisionedWorkerId,
            project_id: "p1",
            socket: incompatibleSocket,
            status: "idle",
            capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
          });
          return { status: "success" };
        },
        runtimeStatusFn: async () => ({ worker_ids: provisionedWorkerId ? [provisionedWorkerId] : [] }),
      },
    });

    expect(dispatchReadyNodes(runId, adapter)).toBe(0);
    await provisioningCompleted;
    expect(incompatibleSocket.send).not.toHaveBeenCalled();
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      counters: { dispatches: 0 },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("READY");

    const compatibleSocket = makeSocket();
    registerWorker({
      worker_id: "compatible-browser-worker",
      project_id: "p1",
      socket: compatibleSocket,
      status: "idle",
      capabilities: ["browser", DAG_TRANSPORT_FENCE_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    await vi.waitFor(
      () => expect(compatibleSocket.send).toHaveBeenCalledTimes(1),
      { timeout: 2_500 },
    );
    expect(incompatibleSocket.send).not.toHaveBeenCalled();
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      counters: { dispatches: 1 },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("RUNNING");
  }, 6_000);

  it("counts a successful provisioning send against max_dispatches", async () => {
    const runId = "run-provisioning-dispatch-budget";
    const nodeSocket = makeSocket();
    registerNode({
      node_id: "budget-provisioning-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["docker-api"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });
    createActiveRun(runId, parseDAGYaml(`
name: provisioning-dispatch-budget
limits:
  max_dispatches: 1
agents:
  worker: { agent_type: deterministic }
nodes:
  diagnose:
    agent: worker
    outputs: { done: { to: "" } }
`));

    let workerId: string | undefined;
    const workerSocket = makeSocket();
    const provisioningCompleted = waitForProvisioningCompleted(runId);
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (_nodeId, _workspaceId, opts) => {
          workerId = opts.env?.HOMERAIL_WORKER_ID;
          return { status: "success", resource_data: { id: "container-budget" } };
        },
        startFn: async () => {
          if (!workerId) throw new Error("missing provisioned worker id");
          registerWorker({
            worker_id: workerId,
            project_id: "p1",
            socket: workerSocket,
            status: "idle",
            capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
          });
          return { status: "success" };
        },
        runtimeStatusFn: async () => ({ worker_ids: workerId ? [workerId] : [] }),
      },
    });

    expect(dispatchReadyNodes(runId, adapter)).toBe(0);
    await provisioningCompleted;
    expect(workerSocket.send).toHaveBeenCalledTimes(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      limits: { max_dispatches: 1 },
      counters: { dispatches: 1 },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("diagnose")).toBe("RUNNING");

    expect(checkpointResumeActiveRun(runId, "diagnose", {
      instruction: "retry after the provisioning send",
    })).toMatchObject({ status: "scheduled" });
    expect(dispatchReadyNodes(runId, adapter)).toBe(0);
    expect(workerSocket.send).toHaveBeenCalledTimes(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "failed",
      counters: { abort_reason: "max_dispatches (1) exceeded" },
    });
  });

  it("marks a round-two actor command delivered after async provisioned dispatch", async () => {
    const runId = "run-provisioned-round-two-delivery";
    const initialDispatcher = {
      dispatch: vi.fn(() => ({ status: "dispatched" as const })),
    };
    createActiveRun(runId, parseDAGYaml(`
name: provisioned-round-two-delivery
workflow_id: provisioned-round-two-delivery
agents:
  worker: { agent_type: deterministic }
nodes:
  actor:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command
    after: [actor]
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      command_port: command
`));
    expect(dispatchReadyNodes(runId, initialDispatcher)).toBe(1);
    handoffActiveRun(runId, "actor", "summary", { result: "round one" });
    expect(dispatchReadyNodes(runId, initialDispatcher)).toBe(1);
    expect(getActiveRun(runId)?.status).toBe("waiting");

    const commandId = "provisioned-round-two-command";
    resumeWaitingActiveRun(runId, {
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "researcher",
        command_id: commandId,
        payload: { task: "continue through provisioning" },
      }],
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("READY");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: commandId, status: "pending" },
    ]);

    const nodeSocket = makeSocket();
    registerNode({
      node_id: "round-two-provisioning-node",
      project_id: "p1",
      socket: nodeSocket,
      status: "connected",
      capabilities: ["docker-api"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });
    let workerId: string | undefined;
    const workerSocket = makeSocket();
    const provisioningCompleted = waitForProvisioningCompleted(runId);
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (_nodeId, _workspaceId, opts) => {
          workerId = opts.env?.HOMERAIL_WORKER_ID;
          return { status: "success", resource_data: { id: "container-round-two" } };
        },
        startFn: async () => {
          if (!workerId) throw new Error("missing provisioned worker id");
          registerWorker({
            worker_id: workerId,
            project_id: "p1",
            socket: workerSocket,
            status: "idle",
            capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
          });
          return { status: "success" };
        },
        runtimeStatusFn: async () => ({ worker_ids: workerId ? [workerId] : [] }),
      },
    });

    expect(dispatchReadyNodes(runId, adapter)).toBe(0);
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: commandId, status: "pending" },
    ]);
    await provisioningCompleted;

    expect(workerSocket.send).toHaveBeenCalledTimes(1);
    expect(getActiveRun(runId)).toMatchObject({
      status: "active",
      currentRound: { round_id: "round-0002", status: "active" },
    });
    expect(getActiveRun(runId)?.dagRun.nodeStates.get("actor")).toBe("RUNNING");
    expect(listDagActorCommands({ run_id: runId, round_id: "round-0002" })).toMatchObject([
      { command_id: commandId, status: "delivered" },
    ]);
  });

  it("does not dispatch a node while its provisioned worker is still being finalized", () => {
    const workerSocket = makeSocket();
    registerWorker({
      worker_id: "provisioned-run-capabilities-diagnose",
      project_id: "p1",
      socket: workerSocket,
      status: "idle",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    recordProvisioning("run-capabilities", "diagnose");

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ nodeId: "diagnose" }),
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "provisioning_in_progress",
    });
    expect(workerSocket.send).not.toHaveBeenCalled();
  });

  it("does not reuse a provisioned Worker after its lease is released for cleanup", () => {
    const workerId = "provisioned-run-capabilities-diagnose-stale";
    const workerSocket = makeSocket();
    registerWorker({
      worker_id: workerId,
      project_id: "p1",
      socket: workerSocket,
      status: "idle",
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });
    const lease = acquireDagActorLease({
      run_id: "run-capabilities",
      actor_id: "diagnose",
      target_type: "worker",
      target_id: workerId,
    });
    const ownership = registerDagProvisionedWorker({
      run_id: "run-capabilities",
      node_id: "diagnose",
      actor_id: "diagnose",
      lease_generation: lease.lease_generation,
      worker_id: workerId,
      container_id: "container-stale",
      docker_node_id: "docker-node",
    });
    recordDispatch("run-capabilities", "diagnose", "worker", workerId);
    releaseDagActorLease({
      run_id: "run-capabilities",
      actor_id: "diagnose",
      lease_generation: lease.lease_generation,
      target_type: "worker",
      target_id: workerId,
      expected_version: lease.version,
    });
    transitionDagProvisionedWorker({
      run_id: "run-capabilities",
      actor_id: "diagnose",
      lease_generation: lease.lease_generation,
      worker_id: workerId,
      expected_status: "active",
      status: "releasing",
      expected_version: ownership.version,
    });

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ workspace: { mode: "isolated" } }),
    );

    expect(result).toMatchObject({ status: "skipped", reason: "no available worker or node" });
    expect(workerSocket.send).not.toHaveBeenCalled();
    expect(getDagActorLease({ run_id: "run-capabilities", actor_id: "diagnose" }))
      .toMatchObject({ state: "dormant", lease_generation: lease.lease_generation });
  });

  it("dispatches the current checkpoint-resume envelope after pending provisioning completes", async () => {
    const parsed = parseDAGYaml(`
name: provisioning-checkpoint-resume
agents:
  planner:
    agent_type: deterministic
nodes:
  diagnose:
    agent: planner
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-provisioning-resume", parsed);
    const dockerNodeSocket = makeSocket();
    registerNode({
      node_id: "docker-node",
      project_id: "p1",
      socket: dockerNodeSocket,
      status: "connected",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
      pending_requests: new Map(),
    });

    const workerSocket = makeSocket();
    let workerId: string | undefined;
    let resolveCreate: ((value: { status: "success"; resource_data: { id: string } }) => void) | undefined;
    const createStarted = vi.fn();
    const createPromise = new Promise<{ status: "success"; resource_data: { id: string } }>((resolve) => {
      resolveCreate = resolve;
    });
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async (_nodeId, _workspaceId, opts) => {
          workerId = opts.env?.HOMERAIL_WORKER_ID;
          createStarted();
          return createPromise;
        },
        startFn: async () => {
          if (!workerId) throw new Error("missing provisioned worker id");
          registerWorker({
            worker_id: workerId,
            project_id: "p1",
            socket: workerSocket,
            status: "idle",
            capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
          });
          return { status: "success" };
        },
        runtimeStatusFn: async () => ({
          worker_ids: workerId ? [workerId] : [],
        }),
      },
    });

    const count = dispatchReadyNodes("run-provisioning-resume", adapter);
    expect(count).toBe(0);
    await vi.waitFor(() => expect(createStarted).toHaveBeenCalledTimes(1));

    const parentSessionId = getCurrentNodeSession("run-provisioning-resume", "diagnose")!.sessionId;
    appendSessionTranscriptForTest(parentSessionId, [
      {
        uuid: "provisioning-resume-entry-1",
        type: "text",
        runId: "run-provisioning-resume",
        nodeId: "diagnose",
        content: "old prompt before provisioning finished",
      },
    ]);
    const resume = checkpointResumeActiveRun("run-provisioning-resume", "diagnose", {
      instruction: "Resume after provisioning with CURRENT_SESSION_MARKER.",
    });
    expect(resume.status).toBe("scheduled");
    const currentSessionId = getCurrentNodeSession("run-provisioning-resume", "diagnose")!.sessionId;
    expect(currentSessionId).not.toBe(parentSessionId);

    resolveCreate?.({ status: "success", resource_data: { id: "container-current" } });
    await vi.waitFor(() => expect(workerSocket.send).toHaveBeenCalledTimes(1));
    const sent = JSON.parse(String(workerSocket.send.mock.calls[0]?.[0])) as { envelope: DispatchEnvelope };

    expect(sent.envelope.sessionId).toBe(currentSessionId);
    expect(sent.envelope.sessionId).not.toBe(parentSessionId);
    expect(sent.envelope.inputs.checkpoint_resume).toEqual([
      "Resume after provisioning with CURRENT_SESSION_MARKER.",
    ]);
    expect(sent.envelope.checkpointResume).toMatchObject({
      parentSessionId,
      instruction: "Resume after provisioning with CURRENT_SESSION_MARKER.",
      attempt: 2,
    });
  });

  it("keeps dispatch retryable when only another node's run-scoped worker exists", () => {
    const otherNodeWorkerSocket = makeSocket();
    registerWorker({
      worker_id: "provisioned-run-capabilities-other-node",
      project_id: "p1",
      socket: otherNodeWorkerSocket,
      status: "idle",
      capabilities: ["docker-cli"],
      registered_at: Date.now(),
      last_heartbeat: Date.now(),
    });

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ nodeId: "diagnose" }),
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "no available worker or node",
    });
    expect(otherNodeWorkerSocket.send).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a declared provider has no active model setting", () => {
    const parsed = parseDAGYaml(`
name: missing-provider-setting
agents:
  planner:
    llm:
      provider: custom-test-provider
      model: custom-test-model
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-missing-setting", parsed);
    const dispatcher = { dispatch: vi.fn() };

    const count = dispatchReadyNodes("run-missing-setting", dispatcher);

    expect(count).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    const run = getActiveRun("run-missing-setting");
    expect(run?.status).toBe("failed");
    expect(run?.dagRun.nodeStates.get("plan")).toBe("FAILED");
  });

  it("aborts a run when max_dispatches is exceeded", () => {
    const parsed = parseDAGYaml(`
name: limited-dispatches
limits:
  max_dispatches: 1
agents:
  planner:
    agent_type: deterministic
nodes:
  first:
    agent: planner
    outputs:
      done:
        to: ""
  second:
    agent: planner
    outputs:
      done:
        to: ""
`);
    const run = createActiveRun("run-max-dispatches", parsed);
    const dispatcher = { dispatch: vi.fn(() => ({ status: "dispatched" as const })) };

    const count = dispatchReadyNodes("run-max-dispatches", dispatcher);

    expect(count).toBe(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("failed");
    expect(run.counters.abort_reason).toBe("max_dispatches (1) exceeded");
    expect(run.dagRun.nodeStates.get("second")).toBe("FAILED");
  });

  it("dispatches Claude SDK agents with the Anthropic endpoint, not the Chat Completions URL", () => {
    upsertProvider({
      id: "dual-url-provider",
      name: "Dual URL Provider",
      default_model: "dual-model",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
    });
    createSetting({
      provider_id: "dual-url-provider",
      model_name: "dual-model",
      api_key: "test-key",
      protocol: "openai_compatible",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
      is_active: true,
      is_default: true,
    });
    const parsed = parseDAGYaml(`
name: claude-sdk-anthropic-endpoint
agents:
  planner:
    agent_type: claude-sdk
    llm:
      provider: dual-url-provider
      model: dual-model
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-claude-sdk-anthropic-endpoint", parsed);
    const dispatcher = { dispatch: vi.fn(() => ({ status: "dispatched" as const })) };

    const count = dispatchReadyNodes("run-claude-sdk-anthropic-endpoint", dispatcher);

    expect(count).toBe(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const envelope = dispatcher.dispatch.mock.calls[0]?.[0] as DispatchEnvelope;
    expect(envelope.agentConfig.llm).toMatchObject({
      provider: "dual-url-provider",
      model: "dual-model",
      base_url: "https://dual.example/anthropic",
      protocol: "anthropic_compatible",
    });
    expect(envelope.agentConfig.llm?.base_url).not.toBe("https://dual.example/v1");
  });

  it("selects the Kimi Code harness for Kimi DAG settings without an explicit agent_type", () => {
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "test-kimi-key",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });
    const parsed = parseDAGYaml(`
name: kimi-provider-default-harness
agents:
  planner:
    system: Plan with the configured default DAG setting.
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    createActiveRun("run-kimi-provider-default-harness", parsed);
    const dispatcher = { dispatch: vi.fn(() => ({ status: "dispatched" as const })) };

    const count = dispatchReadyNodes("run-kimi-provider-default-harness", dispatcher);

    expect(count).toBe(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const envelope = dispatcher.dispatch.mock.calls[0]?.[0] as DispatchEnvelope;
    expect(envelope.agentConfig).toMatchObject({
      agent_type: "kimi_code",
      llm: {
        provider: "kimi_cn",
        model: "kimi-for-coding",
        api_key: "test-kimi-key",
        base_url: "https://api.kimi.com/coding/v1",
        protocol: "openai_compatible",
      },
    });
  });

  it("fails legacy direct-llm agents before dispatch", () => {
    upsertProvider({
      id: "legacy-direct-provider",
      name: "Legacy Direct Provider",
      default_model: "legacy-model",
      base_url: "https://legacy.example/v1",
      chat_completions_base_url: "https://legacy.example/v1",
      anthropic_base_url: "https://legacy.example/anthropic",
    });
    createSetting({
      provider_id: "legacy-direct-provider",
      model_name: "legacy-model",
      api_key: "test-key",
      plan_type: "coding_plan",
      protocol: "openai_compatible",
      base_url: "https://legacy.example/v1",
      chat_completions_base_url: "https://legacy.example/v1",
      anthropic_base_url: "https://legacy.example/anthropic",
      is_active: true,
      is_default: true,
    });
    const parsed = parseDAGYaml(`
name: legacy-direct-llm-coding-plan
agents:
  planner:
    agent_type: direct-llm
    llm:
      provider: legacy-direct-provider
      model: legacy-model
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    const dispatcher = { dispatch: vi.fn(() => ({ status: "dispatched" as const })) };

    const run = createActiveRun("run-legacy-direct-llm-coding-plan", parsed);
    const count = dispatchReadyNodes("run-legacy-direct-llm-coding-plan", dispatcher);

    expect(count).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(run.dagRun.nodeStates.get("plan")).toBe("FAILED");
  });

  it("fails Claude SDK dispatch when only a Chat Completions endpoint is configured", () => {
    upsertProvider({
      id: "chat-only-provider",
      name: "Chat Only Provider",
      default_model: "chat-model",
      base_url: "https://chat-only.example/v1",
      chat_completions_base_url: "https://chat-only.example/v1",
    });
    createSetting({
      provider_id: "chat-only-provider",
      model_name: "chat-model",
      api_key: "test-key",
      protocol: "openai_compatible",
      base_url: "https://chat-only.example/v1",
      chat_completions_base_url: "https://chat-only.example/v1",
      is_active: true,
      is_default: true,
    });
    const parsed = parseDAGYaml(`
name: claude-sdk-chat-only-endpoint
agents:
  planner:
    agent_type: claude-sdk
    llm:
      provider: chat-only-provider
      model: chat-model
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    const run = createActiveRun("run-claude-sdk-chat-only-endpoint", parsed);
    const dispatcher = { dispatch: vi.fn(() => ({ status: "dispatched" as const })) };

    const count = dispatchReadyNodes("run-claude-sdk-chat-only-endpoint", dispatcher);

    expect(count).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(run.dagRun.nodeStates.get("plan")).toBe("FAILED");
  });

  it("fails before dispatch when the active model setting lacks a base URL", () => {
    upsertProvider({
      id: "custom-test-provider",
      name: "Custom Test Provider",
      default_model: "custom-test-model",
      base_url: "",
    });
    createSetting({
      provider_id: "custom-test-provider",
      model_name: "custom-test-model",
      api_key: "test-key",
      is_active: true,
      is_default: true,
    });
    const parsed = parseDAGYaml(`
name: missing-provider-base-url
agents:
  planner:
    llm:
      provider: custom-test-provider
      model: custom-test-model
nodes:
  plan:
    agent: planner
    outputs:
      done:
        to: ""
`);
    const run = createActiveRun("run-missing-base-url", parsed);
    const dispatcher = { dispatch: vi.fn() };

    const count = dispatchReadyNodes("run-missing-base-url", dispatcher);

    expect(count).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(run.dagRun.nodeStates.get("plan")).toBe("FAILED");
  });
});

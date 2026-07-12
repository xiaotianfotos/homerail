import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { _clearAllDispatches, recordProvisioning } from "../src/orchestration/dispatch-tracker.js";
import { normalizeAgentBackend, WsDispatchAdapter } from "../src/orchestration/ws-dispatch-adapter.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { _clearListeners } from "../src/events/bus.js";
import { registerNode, _clearNodes } from "../src/node/registry.js";
import { createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { appendSessionTranscriptForTest, loadSessionTranscript } from "../src/persistence/dag-session-files.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import { closeDb } from "../src/persistence/db.js";
import {
  _clearActiveRuns,
  checkpointResumeActiveRun,
  createActiveRun,
  dispatchReadyNodes,
  getActiveRun,
  getCurrentNodeSession,
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
    ...overrides,
  };
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

  it("does not fall back to a node when required worker capabilities are missing", () => {
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

    const result = new WsDispatchAdapter({ provisioner: false }).dispatch(
      makeEnvelope({ requiredCapabilities: ["browser"] }),
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: "no available worker satisfies required capabilities: browser",
    });
    expect(nodeSocket.send).not.toHaveBeenCalled();
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

  it("provisions through a docker-api capable node", async () => {
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
    }).dispatch(makeEnvelope());

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
    const workerId = "provisioned-run-provisioning-resume-diagnose";
    let resolveCreate: ((value: { status: "success"; resource_data: { id: string } }) => void) | undefined;
    const createStarted = vi.fn();
    const createPromise = new Promise<{ status: "success"; resource_data: { id: string } }>((resolve) => {
      resolveCreate = resolve;
    });
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:19191",
      provisioner: {
        createFn: async () => {
          createStarted();
          return createPromise;
        },
        startFn: async () => {
          registerWorker({
            worker_id: workerId,
            project_id: "p1",
            socket: workerSocket,
            status: "idle",
            capabilities: [],
            registered_at: Date.now(),
            last_heartbeat: Date.now(),
          });
          return { status: "success" };
        },
        runtimeStatusFn: async () => ({
          worker_ids: [workerId],
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

  it("does not dispatch a node to another node's run-scoped worker", () => {
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
      status: "failed",
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

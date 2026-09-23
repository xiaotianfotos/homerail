import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY, NATIVE_CODEX_SUBSCRIPTION_CAPABILITY } from "homerail-protocol";
import { compileWorkflowSource, canonicalWorkflowToV1Document, projectCanonicalWorkflowToParsedDAG } from "../src/orchestration/workflow-spec-v1.js";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { FakeDAGDispatcher, type DispatchEnvelope } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { WsDispatchAdapter } from "../src/orchestration/ws-dispatch-adapter.js";
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { _clearActiveRuns, getActiveRun, handoffActiveRun, requestNodeCorrection, dispatchReadyNodes, bindNativeSubscriptionNode, getNativeSubscriptionBinding, restoreActiveRun } from "../src/runtime/active-runs.js";
import { preflightDagAgentRuntimes } from "../src/runtime/dag-runtime-preflight.js";
import { resolveNativeSubscriptionAgent, usesOnlyNativeSubscriptionWorkers } from "../src/runtime/native-subscription-runtime.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { stageDagRunInputArtifact, resolveDagRunInputBindings, bindDagRunInputs } from "../src/persistence/run-input-artifacts.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunMetadata } from "../src/persistence/store.js";
import { upsertDagWorkflowFromYaml, upsertDagRuntimeProfileFromYaml, applyDagRuntimeProfile } from "../src/persistence/dag-workflows.js";
import { _clearNodes, getNode, registerNode } from "../src/node/registry.js";
import { resolveLifecycleResponse } from "../src/node/lifecycle-request.js";
import { _clearWorkers, registerWorker } from "../src/worker/registry.js";
import { _clearListeners } from "../src/events/bus.js";
import { createServer } from "../src/server/http.js";

const selection = { provider: "codex", model: "gpt-exact-test", reasoning_effort: "low" } as const;
function workflow() {
  return {
    api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "native-proof", name: "Native proof" },
    spec: {
      agents: { inspect: { native_subscription: { ...selection }, system: "Inspect the supplied task and hand off." } },
      nodes: {
        inspect: {
          kind: "agent", agent: "inspect", codex_sandbox: "read-only", builtin_tool_policy: "backend_native",
          workspace_access: { writable_paths: [] as string[] }, outputs: { result: {} },
        },
        done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
      },
      edges: [{ from: "inspect.result", to: "done.result" }],
    },
  };
}

describe("explicit native Codex subscription DAGs", () => {
  let home: string, previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-native-manager-"));
    process.env.HOMERAIL_HOME = home;
    closeDb(); _clearActiveRuns(); _clearAllDispatches(); _clearNodes(); _clearWorkers(); _clearListeners();
  });
  afterEach(() => {
    _clearActiveRuns(); _clearAllDispatches(); _clearNodes(); _clearWorkers(); _clearListeners(); closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips exact selection through public schema, canonical hash and storage without API settings", () => {
    const compiled = compileWorkflowSource(JSON.stringify(workflow()));
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.canonical?.agents.inspect.native_subscription).toEqual(selection);
    const roundTrip = compileWorkflowSource(JSON.stringify(canonicalWorkflowToV1Document(compiled.canonical!)));
    expect(roundTrip.canonical_hash).toBe(compiled.canonical_hash);
    const changed = workflow();
    changed.spec.agents.inspect.native_subscription.model = "gpt-other-test" as typeof selection.model;
    expect(compileWorkflowSource(JSON.stringify(changed)).canonical_hash).not.toBe(compiled.canonical_hash);
    const parsed = projectCanonicalWorkflowToParsedDAG(compiled.canonical!);
    expect(() => preflightDagAgentRuntimes(parsed.graph, parsed.meta.agents)).not.toThrow();

    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const dispatcher = new FakeDAGDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    const request = { workflowId: "native-proof", runId: "native-run", prompt: "Inspect read-only" };
    orchestrator.createAndRun(request);
    expect(dispatcher.dispatched).toHaveLength(1);
    expect(dispatcher.dispatched[0].agentConfig.llm).toEqual({
      provider: "openai", protocol: "codex_subscription", model: selection.model, reasoning_effort: "low",
    });
    expect(dispatcher.dispatched[0].requiredCapabilities).toContain(NATIVE_CODEX_SUBSCRIPTION_CAPABILITY);
    orchestrator.createAndRun(request);
    expect(dispatcher.dispatched).toHaveLength(1);
    expect(loadRunMetadata("native-run")?.creationRequestDigest).toBeTruthy();
    expect(() => orchestrator.createAndRun({ ...request, prompt: "different request" })).toThrow(/conflict/i);
    handoffActiveRun("native-run", "inspect", "result", { summary: "read-only result" });
    expect(getActiveRun("native-run")?.status).toBe("completed");
  });

  it.each([
    { codex_sandbox: "workspace-write" },
    { codex_sandbox: undefined },
    { workspace_access: { writable_paths: ["."] } },
    { workspace_access: undefined },
    { builtin_tool_policy: undefined },
    { allowed_builtin_tools: [] },
    { session_scope: "dispatch" },
    { credentials: [{ credential_ref: "secret", purpose: "test", inject: { mode: "env", mappings: { token: "TOKEN" } } }] },
  ])("rejects unsafe native policy at public workflow validation: %j", (override) => {
    const source = workflow();
    Object.assign(source.spec.nodes.inspect, override);
    const compiled = compileWorkflowSource(JSON.stringify(source));
    expect(compiled.diagnostics.some((item) => item.code === "DAG_SEMANTIC_NATIVE_SUBSCRIPTION_POLICY")).toBe(true);
  });

  it("rejects endpoint/credential selectors and runtime/profile overrides", () => {
    for (const field of ["api_key", "base_url", "service_tier"]) {
      const source = workflow();
      Object.assign(source.spec.agents.inspect.native_subscription, { [field]: "forbidden" });
      expect(compileWorkflowSource(JSON.stringify(source)).diagnostics.some((item) => item.severity === "error")).toBe(true);
    }
    for (const override of [{ llm_setting_id: "api-default" }, { llm: { provider: "openai" } }, { agent_type: "claude-sdk" }, { model: "replacement" }]) {
      expect(() => resolveNativeSubscriptionAgent({ native_subscription: selection, ...override })).toThrow(/cannot be combined/);
    }
    const compiled = compileWorkflowSource(JSON.stringify(workflow()));
    const parsed = projectCanonicalWorkflowToParsedDAG(compiled.canonical!);
    expect(() => applyDagRuntimeProfile(parsed, { default: { agent_type: "deterministic" }, agents: {} } as Parameters<typeof applyDagRuntimeProfile>[1])).toThrow(/cannot override/);
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    expect(() => orchestrator.createRun({ workflowId: "native-proof", llmSettingId: "any-api-setting" })).toThrow(/llmSettingId cannot override/);
    upsertDagRuntimeProfileFromYaml({ workflow_id: "native-proof", yaml_text: "profile_id: override\ndefault: { agent_type: deterministic }" });
    expect(() => orchestrator.createRun({ workflowId: "native-proof", profile: "override" })).toThrow(/cannot override/);
  });

  it.each([false, true])("rejects input artifacts before persisting or dispatching a native run (mixed=%s)", mixed => {
    const source = workflow();
    if (mixed) {
      Object.assign(source.spec.agents, { other: { system: "Another role" } });
      Object.assign(source.spec.nodes, { other: { kind: "agent", agent: "other", inputs: { result: {} }, outputs: { result: {} } } });
      source.spec.edges[0].to = "other.result";
      source.spec.edges.push({ from: "other.result", to: "done.result" });
    }
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(source) });
    const artifact = stageDagRunInputArtifact({ scope_id: "test", name: "task.txt", media_type: "text/plain", content: "input" });
    const dispatcher = new FakeDAGDispatcher();
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(dispatcher));
    expect(() => orchestrator.createAndRun({
      workflowId: "native-proof", runId: "native-input", inputScope: "test",
      inputArtifacts: [{ artifact_id: artifact.artifact_id, logical_name: "task", mount_path: "input/task.txt" }],
    })).toThrow(/native_subscription does not support run input artifact projections/);
    expect(loadRunMetadata("native-input")).toBeUndefined();
    expect(getActiveRun("native-input")).toBeUndefined();
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it("retains a metadata-only dispatch guard for previously persisted native runs with inputs", () => {
    const artifact = stageDagRunInputArtifact({ scope_id: "test", name: "task.txt", media_type: "text/plain", content: "input" });
    const bindings = resolveDagRunInputBindings("test", [{ artifact_id: artifact.artifact_id, logical_name: "task", mount_path: "input/task.txt" }]);
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher())).createRun({ workflowId: "native-proof", runId: "legacy-input" });
    bindDagRunInputs("legacy-input", bindings);
    const read = vi.spyOn(fs, "readFileSync");
    const nativeSend = node("native", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    const adapter = new WsDispatchAdapter({ provisioner: {} });
    const result = adapter.dispatch({
      runId: "legacy-input", nodeId: "inspect", agentId: "inspect", inputs: {}, outgoingEdges: [],
      agentConfig: resolveNativeSubscriptionAgent({ native_subscription: selection }),
      codexSandbox: "read-only", builtinToolPolicy: "backend_native", workspaceAccess: { writable_paths: [] },
    });
    try {
      expect(result).toMatchObject({ status: "failed", retryable: false, reason: expect.stringContaining("projected workspace inputs") });
      expect(read).not.toHaveBeenCalled();
      expect(nativeSend).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it("rejects dynamic appends that replace native agent selection before changing the graph", () => {
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher()));
    orchestrator.createRun({ workflowId: "native-proof", runId: "native-append" });
    expect(() => orchestrator.appendNode("native-append", {
      nodeId: "later", agentId: "inspect", agent: { system: "Remove the subscription selection" }, after: ["inspect"],
    })).toThrow(/cannot override native_subscription/);
    expect(() => orchestrator.appendNode("native-append", {
      nodeId: "unsafe", agentId: "other", agent: { native_subscription: selection }, after: ["inspect"],
    })).toThrow(/requires explicit codex_sandbox/);
    expect(getActiveRun("native-append")?.agents?.inspect.native_subscription).toEqual(selection);
    expect(getActiveRun("native-append")?.dagRun.graph.nodes.map((item) => item.node_id)).toEqual(["inspect"]);
  });

  it("does not classify undeclared legacy worker roles as native-only", () => {
    const parsed = parseDAGYaml(`name: legacy-native-admission\nagents:\n  unused:\n    native_subscription: { provider: codex, model: gpt-exact-test, reasoning_effort: low }\nnodes:\n  inspect:\n    agent: undeclared\n    outputs: { done: { to: '' } }\n`);
    expect(usesOnlyNativeSubscriptionWorkers(parsed.graph, parsed.meta.agents)).toBe(false);
  });

  function node(id: string, capabilities: string[], send = vi.fn()) {
    registerNode({ node_id: id, project_id: "p1", status: "connected", capabilities,
      socket: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      registered_at: Date.now(), last_heartbeat: Date.now(), pending_requests: new Map() });
    return send;
  }

  it("does not fall back to Docker or generic workers when the native Node is unavailable", () => {
    const dockerSend = node("docker", ["docker-cli"]);
    const genericSend = vi.fn();
    registerWorker({ worker_id: "generic", project_id: "p1", status: "idle", capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY],
      socket: { readyState: WebSocket.OPEN, send: genericSend } as unknown as WebSocket,
      registered_at: Date.now(), last_heartbeat: Date.now() });
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const adapter = new WsDispatchAdapter({ provisioner: {} });
    const dispatch = vi.spyOn(adapter, "dispatch");
    new ChangeOrchestrator(new GraphExecutor(adapter)).createAndRun({ workflowId: "native-proof", runId: "native-offline" });
    expect(dispatch.mock.results[0].value).toMatchObject({ status: "skipped", reason: expect.stringContaining("no fallback") });
    expect(dockerSend).not.toHaveBeenCalled();
    expect(genericSend).not.toHaveBeenCalled();
    expect(getActiveRun("native-offline")?.dagRun.nodeStates.get("inspect")).toBe("READY");
  });

  it("persists Node ownership across Manager restore and never migrates to a replacement Node", () => {
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    new ChangeOrchestrator(new GraphExecutor(new FakeDAGDispatcher())).createRun({ workflowId: "native-proof", runId: "native-pinned" });
    bindNativeSubscriptionNode("native-pinned", "inspect", "original-node", true);
    const metadata = loadRunMetadata("native-pinned")!;
    _clearActiveRuns();
    expect(restoreActiveRun(metadata).status).toBe("restored");
    expect(getNativeSubscriptionBinding("native-pinned", "inspect")).toEqual({ nodeId: "original-node", dispatchAttempted: true });
    const replacementSend = node("replacement-node", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    const adapter = new WsDispatchAdapter({ provisioner: {} });
    const dispatch = vi.spyOn(adapter, "dispatch");
    dispatchReadyNodes("native-pinned", adapter);
    expect(dispatch.mock.results[0].value).toMatchObject({ status: "skipped", reason: expect.stringContaining("pinned to unavailable Node original-node") });
    expect(replacementSend).not.toHaveBeenCalled();
    expect(() => bindNativeSubscriptionNode("native-pinned", "inspect", "replacement-node")).toThrow(/automatic migration is forbidden/);
  });

  it("rejects ambiguous matching Nodes instead of selecting an arbitrary account", () => {
    node("native-a", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    node("native-b", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const adapter = new WsDispatchAdapter({ provisioner: {} });
    const dispatch = vi.spyOn(adapter, "dispatch");
    new ChangeOrchestrator(new GraphExecutor(adapter)).createAndRun({ workflowId: "native-proof", runId: "native-ambiguous" });
    expect(dispatch.mock.results[0].value).toMatchObject({ status: "failed", retryable: false, reason: expect.stringContaining("one matching Node") });
  });

  it("fails altered native dispatch identities before any provisioning request", () => {
    const nativeSend = node("native", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    const adapter = new WsDispatchAdapter({ provisioner: {} });
    const envelope: DispatchEnvelope = {
      runId: "tampered-native", nodeId: "inspect", agentId: "inspect", inputs: {}, outgoingEdges: [],
      agentConfig: resolveNativeSubscriptionAgent({ native_subscription: selection }),
      codexSandbox: "read-only", builtinToolPolicy: "backend_native", workspaceAccess: { writable_paths: [] },
    };
    for (const llm of [
      { ...envelope.agentConfig.llm, model: "other-model" },
      { ...envelope.agentConfig.llm, reasoning_effort: "high" },
      { ...envelope.agentConfig.llm, protocol: "responses_compatible" },
      { ...envelope.agentConfig.llm, api_key: "not-allowed" },
    ]) {
      expect(adapter.dispatch({ ...envelope, agentConfig: { ...envelope.agentConfig, llm } })).toMatchObject({
        status: "failed", retryable: false,
      });
    }
    expect(adapter.dispatch({ ...envelope, codexSandbox: "workspace-write" })).toMatchObject({ status: "failed", retryable: false });
    for (const workspace of [{ mode: "git_clone", repo_url: "https://example.com/repo.git" }, { mode: "shared", source_path: "/host/source" }]) {
      expect(adapter.dispatch({ ...envelope, workspace })).toMatchObject({ status: "failed", retryable: false,
        reason: expect.stringContaining("workspace accepts only isolated/shared mode") });
    }
    expect(nativeSend).not.toHaveBeenCalled();
  });

  it.each([undefined, "isolated", "shared"])("preserves workspace mode %s through native provisioning, registration and cancel cleanup", async mode => {
    const requests: Array<{ request_id: string; operation: string; spec: Record<string, any> }> = [];
    const workerSend = vi.fn();
    let workerId = "";
    const nativeSend = vi.fn((raw: string) => {
      const request = JSON.parse(raw);
      requests.push(request);
      if (request.operation === "create") workerId = request.spec.env.HOMERAIL_WORKER_ID;
      resolveLifecycleResponse(getNode("native")!, request.request_id, "success", { id: "native-codex-worker-test" });
    });
    node("docker", ["docker-cli"]);
    const foreignSend = node("foreign-native", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
    getNode("foreign-native")!.project_id = "other-project";
    node("native", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY], nativeSend);
    const source = workflow();
    if (mode) Object.assign(source.spec, { workspace: { mode } });
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(source) });
    const adapter = new WsDispatchAdapter({
      managerBaseUrl: "http://127.0.0.1:1234", managerWorkerWsBaseUrl: "ws://docker-callback.invalid:1234",
      provisioner: { image: "must-not-be-used", workspace: { mode: "local_copy", source_path: "/ambient/must-not-be-used" }, env: { OPENAI_API_KEY: "must-not-be-forwarded" }, runtimeStatusFn: async () => {
        registerWorker({ worker_id: workerId, project_id: "p1", status: "idle",
          capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY, NATIVE_CODEX_SUBSCRIPTION_CAPABILITY],
          socket: { readyState: WebSocket.OPEN, send: workerSend } as unknown as WebSocket,
          registered_at: Date.now(), last_heartbeat: Date.now() });
        return { worker_ids: [workerId] };
      } },
    });
    const orchestrator = new ChangeOrchestrator(new GraphExecutor(adapter));
    orchestrator.createAndRun({ workflowId: "native-proof", runId: "native-lifecycle" });
    await vi.waitFor(() => expect(workerSend).toHaveBeenCalledOnce());
    expect(requests.slice(0, 2).map((request) => request.operation)).toEqual(["create", "start"]);
    expect(requests[0].spec).toEqual({
      execution_mode: "native_codex_subscription", workspace_id: "native-lifecycle", workspace_read_only: true,
      workspace: { mode: mode ?? "isolated" },
      workspace_access: { writable_paths: [], readonly_paths: [] }, env: {
        AGENT_BACKEND: "codex_appserver", HOMERAIL_WORKER_ID: workerId,
        MANAGER_WORKER_WS_URL: `ws://127.0.0.1:1234/ws/projects/p1/workers/${workerId}`,
      },
    });
    const envelope = JSON.parse(workerSend.mock.calls[0][0]).envelope as DispatchEnvelope;
    expect(envelope.activity?.leaseGeneration).toBe(1);
    expect(envelope.agentConfig.llm?.protocol).toBe("codex_subscription");
    expect(envelope.nativeSessionRequired).toBe(false);
    expect(foreignSend).not.toHaveBeenCalled();
    expect(loadRunMetadata("native-lifecycle")?.nativeSubscriptionBindings?.inspect).toEqual({ nodeId: "native", dispatchAttempted: true });
    expect(requestNodeCorrection("native-lifecycle", "inspect", "check the result").status).toBe("scheduled");
    dispatchReadyNodes("native-lifecycle", adapter);
    expect(workerSend).toHaveBeenCalledTimes(2);
    expect(JSON.parse(workerSend.mock.calls[1][0]).envelope.nativeSessionRequired).toBe(true);
    orchestrator.cancelRun("native-lifecycle");
    await vi.waitFor(() => expect(requests.some((request) => request.operation === "remove")).toBe(true));
    expect(requests.slice(2).map((request) => request.operation)).toEqual(["stop", "remove"]);
    expect(requests[2].spec).toEqual({ container_id: "native-codex-worker-test" });
    expect(loadRunMetadata("native-lifecycle")?.status).toBe("cancelled");
  });

  it("admits native-only HTTP runs by native capability while retaining Docker readiness for ordinary/mixed runs", async () => {
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(workflow()) });
    const dispatcher = new FakeDAGDispatcher();
    const server = createServer(0, undefined, dispatcher, false, { autoDetectCodex: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing HTTP test listener");
    const post = (url: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      const request = { workflow_id: "native-proof", runId: "native-http" };
      const unavailable = await post("/api/runs/create-and-run", request);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ data: { code: "native_subscription_node_unavailable" } });
      expect(loadRunMetadata("native-http")).toBeUndefined();
      node("foreign", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
      getNode("foreign")!.project_id = "other-project";
      node("disconnected", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
      Object.assign(getNode("disconnected")!.socket, { readyState: WebSocket.CLOSED });
      expect((await post("/api/runs/create-and-run", request)).status).toBe(503);
      node("native", [NATIVE_CODEX_SUBSCRIPTION_CAPABILITY]);
      const artifact = stageDagRunInputArtifact({ scope_id: "http-test", name: "task.txt", media_type: "text/plain", content: "input" });
      const rejected = await post("/api/runs/create-and-run", {
        ...request, runId: "native-http-input", input_scope: "http-test",
        input_artifacts: [{ artifact_id: artifact.artifact_id, logical_name: "task", mount_path: "input/task.txt" }],
      });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(await rejected.json())).toContain("native_subscription does not support run input artifact projections");
      expect(loadRunMetadata("native-http-input")).toBeUndefined();
      expect(dispatcher.dispatched).toHaveLength(0);
      const created = await post("/api/runs/create-and-run", request);
      expect(created.status).toBe(201);
      expect(dispatcher.dispatched).toHaveLength(1);
      expect((await post("/api/runs/native-http/invoke", {})).status).toBe(200);
      const ordinary = workflow();
      Reflect.deleteProperty(ordinary.spec.agents.inspect, "native_subscription");
      ordinary.metadata.id = "ordinary-proof";
      upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(ordinary) });
      const blocked = await post("/api/runs/create-and-run", { workflow_id: "ordinary-proof" });
      expect(blocked.status).toBe(503);
      expect(await blocked.json()).toMatchObject({ data: { code: "dag_resources_unavailable" } });
      const mixed = workflow();
      mixed.metadata.id = "mixed-proof";
      Object.assign(mixed.spec.agents, { api_worker: { system: "An API role." } });
      upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify(mixed) });
      expect((await post("/api/runs/create-and-run", { workflow_id: "mixed-proof" })).status).toBe(503);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

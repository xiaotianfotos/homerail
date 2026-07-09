import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentBackend } from "../agent/factory.js";
import type { AgentClient, AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";
import { startManagerAgentServer } from "../manager-agent/server.js";

async function listen(server: http.Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function makeManagerApiServer(createAndRunBodies: Record<string, unknown>[] = []): http.Server {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method === "POST" && pathname === "/api/runs/create-and-run") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          createAndRunBodies.push(body ? JSON.parse(body) as Record<string, unknown> : {});
        } catch {
          createAndRunBodies.push({});
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { runId: "run-test-123" } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });
}

function writeOrchestrationFiles(workspace: string): void {
  const dir = path.join(workspace, "assets", "orchestrations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "local-review-template.yaml"), "nodes: []\n", "utf8");
  fs.writeFileSync(path.join(dir, "example-review-template.yaml"), "nodes: []\n", "utf8");
}

class ObjectiveSuccessAgent implements AgentClient {
  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    _context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const tool = tools.find((item) => item.name === "create_and_run");
    if (!tool) throw new Error("create_and_run tool missing");
    const input = { workflow_id: "public-two-node-template", profile: "offline-deterministic" };
    yield { type: "tool_use", id: "tool-1", name: "create_and_run", input };
    const result = await tool.handler(input);
    yield {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: result.content.map((item) => item.text).join(""),
      is_error: result.is_error,
    };
    yield { type: "text", text: "started" };
    yield { type: "done" };
  }
}

class ObjectiveSuccessNoTextAgent implements AgentClient {
  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    _context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const tool = tools.find((item) => item.name === "create_and_run");
    if (!tool) throw new Error("create_and_run tool missing");
    const input = { workflow_id: "public-two-node-template", profile: "offline-deterministic" };
    yield { type: "tool_use", id: "tool-1", name: "create_and_run", input };
    const result = await tool.handler(input);
    yield {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: result.content.map((item) => item.text).join(""),
      is_error: result.is_error,
    };
    yield { type: "done" };
  }
}

class NoToolAgent implements AgentClient {
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "text", text: "I started the DAG." };
    yield { type: "done" };
  }
}

class DeltaTextAgent implements AgentClient {
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "text", text: "你好" };
    yield { type: "text", text: "，" };
    yield { type: "text", text: "我可以帮你启动 DAG。" };
    yield { type: "done" };
  }
}

class ListOrchestrationsAgent implements AgentClient {
  observed = "";

  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    _context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const tool = tools.find((item) => item.name === "list_orchestrations");
    if (!tool) throw new Error("list_orchestrations tool missing");
    yield { type: "tool_use", id: "tool-1", name: "list_orchestrations", input: {} };
    const result = await tool.handler({});
    this.observed = result.content.map((item) => item.text).join("");
    yield {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: this.observed,
      is_error: result.is_error,
    };
    yield { type: "text", text: "listed" };
    yield { type: "done" };
  }
}

class ToolCatalogAgent implements AgentClient {
  toolNames: string[] = [];
  systemPrompt = "";

  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    this.toolNames = tools.map((tool) => tool.name).sort();
    this.systemPrompt = context.systemPrompt ?? "";
    yield { type: "text", text: "catalog captured" };
    yield { type: "done" };
  }
}

class AbortAwareHangingAgent implements AgentClient {
  observedAbort = false;

  async *run(
    _prompt: string,
    _tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    while (!context.abortSignal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    this.observedAbort = true;
    yield { type: "error", message: "aborted by test" };
    yield { type: "done" };
  }
}

class SlowCompletingAgent implements AgentClient {
  observedAbort = false;

  async *run(
    _prompt: string,
    _tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    await new Promise((resolve) => setTimeout(resolve, 35));
    this.observedAbort = context.abortSignal?.aborted === true;
    yield { type: "text", text: "slow turn completed" };
    yield { type: "done" };
  }
}

describe("manager-agent server", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not use regex guards to force objective tools for action-oriented DAG requests", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-no-tool-test", () => new NoToolAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const createAndRunBodies: Record<string, unknown>[] = [];
    const managerApi = makeManagerApiServer(createAndRunBodies);
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个 DAG review",
          agent_config: { agent_type: "manager-agent-no-tool-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { error?: string; data?: Record<string, unknown> };
      expect(response.status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body).toMatchObject({
        text: "I started the DAG.",
        run_ids: [],
        objective: {
          required: false,
          tool_calls: [],
          satisfied: true,
        },
      });
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("does not require objective tools for reply-only or explicitly non-executing turns", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-no-tool-chat-test", () => new NoToolAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "请只用一句中文回复收到，别执行任何操作。",
          agent_config: { agent_type: "manager-agent-no-tool-chat-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { text?: string; objective?: { required?: boolean; satisfied?: boolean } };
      expect(response.status).toBe(200);
      expect(body.text).toBe("I started the DAG.");
      expect(body.objective?.required).toBe(false);
      expect(body.objective?.satisfied).toBe(true);
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("compacts streamed text deltas without inserting line breaks", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-delta-text-test", () => new DeltaTextAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "你都会干什么？",
          agent_config: { agent_type: "manager-agent-delta-text-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { text?: string };
      expect(response.status).toBe(200);
      expect(body.text).toBe("你好，我可以帮你启动 DAG。");
      expect(body.text).not.toContain("\n");
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("returns run ids when create_and_run succeeds through a registered tool", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-objective-success-test", () => new ObjectiveSuccessAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const createAndRunBodies: Record<string, unknown>[] = [];
    const managerApi = makeManagerApiServer(createAndRunBodies);
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个 DAG review",
          required_tool_calls: ["create_and_run"],
          agent_config: { agent_type: "manager-agent-objective-success-test", model: "test-model" },
        }),
      });
      const body = await response.json() as {
        run_id?: string;
        objective?: { required?: boolean; required_tool_calls?: string[]; satisfied?: boolean };
      };
      expect(response.status).toBe(200);
      expect(body.run_id).toBe("run-test-123");
      expect(body.objective?.required).toBe(true);
      expect(body.objective?.required_tool_calls).toEqual(["create_and_run"]);
      expect(body.objective?.satisfied).toBe(true);
      expect(createAndRunBodies).toContainEqual(expect.objectContaining({
        workflow_id: "public-two-node-template",
        profile: "offline-deterministic",
      }));
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("uses a truthful run fallback when the agent only emits a tool call", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-objective-success-no-text-test", () => new ObjectiveSuccessNoTextAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个 DAG review",
          required_tool_calls: ["create_and_run"],
          agent_config: { agent_type: "manager-agent-objective-success-no-text-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { text?: string; run_id?: string };
      expect(response.status).toBe(200);
      expect(body.run_id).toBe("run-test-123");
      expect(body.text).toBe("Started DAG run run-test-123.");
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("returns 424 when explicit required tools are not called", async () => {
    registerAgentBackend("manager-agent-no-tool-required-test", () => new NoToolAgent());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个 DAG review",
          required_tool_calls: ["create_and_run"],
          agent_config: { agent_type: "manager-agent-no-tool-required-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { error?: string; data?: Record<string, unknown> };
      expect(response.status).toBe(424);
      expect(body.error).toContain("required tool calls");
      expect(body.data?.required_tool_calls).toEqual(["create_and_run"]);
      expect(body.data?.missing_tool_calls).toEqual(["create_and_run"]);
      expect(body.data?.observed_tool_calls).toEqual([]);
      expect(body.data?.run_ids).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it("uses release-smoke backend override for container chat without real provider credentials", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);
    vi.stubEnv("HOMERAIL_MANAGER_AGENT_SMOKE", "1");
    vi.stubEnv("AGENT_BACKEND", "manager-agent-smoke");
    vi.stubEnv("HOMERAIL_MANAGER_AGENT_SMOKE_PROFILE", "offline-deterministic");

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动 release smoke DAG",
          agent_config: { agent_type: "claude-sdk", model: "manager-agent-smoke" },
        }),
      });
      const body = await response.json() as {
        text?: string;
        run_id?: string;
        tool_calls?: Array<{ name: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.text).toBe("manager-agent smoke completed");
      expect(body.run_id).toBe("run-test-123");
      expect(body.tool_calls).toContainEqual(expect.objectContaining({ name: "create_and_run" }));
      expect(body.tool_calls).toContainEqual(expect.objectContaining({ name: "finish" }));
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("lists orchestration files without hard-coded recommendations", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    writeOrchestrationFiles(workspace);
    const agent = new ListOrchestrationsAgent();
    registerAgentBackend("manager-agent-list-orchestrations-test", () => agent);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "列出可用 DAG 编排模板",
          agent_config: { agent_type: "manager-agent-list-orchestrations-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { tool_results?: Array<{ content: string }> };
      expect(response.status).toBe(200);
      expect(agent.observed).toContain("local-review-template.yaml");
      expect(agent.observed).toContain("example-review-template.yaml");
      expect(agent.observed).not.toContain("recommended_for");
      expect(body.tool_results?.[0]?.content).not.toContain("recommended_for");
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("exposes Widget File Protocol tools in the container voice catalog", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    const agent = new ToolCatalogAgent();
    registerAgentBackend("manager-agent-tool-catalog-test", () => agent);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "检查工具目录",
          response_mode: "voice",
          voice_system_contract: { source: "system:test", prompt: "VOICE_SYSTEM_CONTRACT_TEST" },
          voice_ui_rules: { sources: ["user:test"], hash: "rules-hash", prompt: "VOICE_RULES_TEST" },
          agent_config: { agent_type: "manager-agent-tool-catalog-test", model: "test" },
        }),
      });
      expect(response.status).toBe(200);
      expect(agent.toolNames).toEqual(expect.arrayContaining([
        "update_voice_memo",
        "validate_widget_file",
        "write_widget_file",
        "read_widget_file",
        "remove_widget_file",
        "show_widget_toml_example",
      ]));
      expect(agent.systemPrompt).toContain("VOICE_SYSTEM_CONTRACT_TEST");
      expect(agent.systemPrompt).toContain("Voice UI rules hash: rules-hash");
      expect(agent.systemPrompt).toContain("VOICE_RULES_TEST");
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("aborts and returns 504 when a harness turn hangs before completing the objective", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    const agent = new AbortAwareHangingAgent();
    registerAgentBackend("manager-agent-hanging-test", () => agent);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);
    vi.stubEnv("MANAGER_AGENT_TURN_TIMEOUT_MS", "25");

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个 DAG review",
          agent_config: { agent_type: "manager-agent-hanging-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { error?: string; data?: Record<string, unknown> };
      expect(response.status).toBe(504);
      expect(body.error).toContain("timed out");
      expect(body.data?.objective_tool_calls).toEqual([]);
      expect(agent.observedAbort).toBe(true);
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("does not apply an absolute Manager Agent turn timeout by default", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    const agent = new SlowCompletingAgent();
    registerAgentBackend("manager-agent-slow-completing-test", () => agent);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const managerApi = makeManagerApiServer();
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "慢一点完成",
          agent_config: { agent_type: "manager-agent-slow-completing-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { text?: string; error?: string };
      expect(response.status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.text).toBe("slow turn completed");
      expect(agent.observedAbort).toBe(false);
    } finally {
      await close(server);
      await close(managerApi);
    }
  });
});

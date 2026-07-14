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

function makePrReviewApiServer(createAndRunBodies: Record<string, unknown>[]): http.Server {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === "/github/repos/xiaotianfotos/homerail/pulls/25") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        title: "WIP: add configurable workspace retention",
        user: { login: "xiaotianfotos" },
        base: {
          sha: "a".repeat(40),
          repo: {
            full_name: "xiaotianfotos/homerail",
            clone_url: "https://github.example/xiaotianfotos/homerail.git",
          },
        },
        head: {
          sha: "b".repeat(40),
          repo: {
            full_name: "contributor/homerail",
            clone_url: "https://github.example/contributor/homerail.git",
          },
        },
      }));
      return;
    }
    if (req.method === "POST" && pathname === "/api/runs/create-and-run") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        createAndRunBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, data: { runId: "run-pr-review-25" } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "not found" }));
  });
}

function passingPrReviewPublication(): Record<string, unknown> {
  return {
    report: {
      repo: "xiaotianfotos/homerail",
      pr: 26,
      base: "a".repeat(40),
      head: "b".repeat(40),
      status: "pass",
      confidence: "high",
      summary: "No actionable findings",
      actionable_count: 0,
      findings: [],
      reviewer_results: ["runtime", "security", "tests", "frontend"].map((reviewer) => ({
        reviewer,
        status: "complete",
        summary: `${reviewer} review complete`,
        findings: [],
      })),
    },
    markdown: "# HomeRail PR Review\n\nNo actionable findings.",
    quorum: { passed: true, successes: 3, total: 3, threshold: 2 },
  };
}

function makePrCloseoutApiServer(createAndRunBodies: Record<string, unknown>[], draft = true): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && pathname === "/github/repos/xiaotianfotos/homerail") {
      send({ default_branch: "main" });
      return;
    }
    if (req.method === "GET" && pathname === "/github/repos/xiaotianfotos/homerail/pulls/26") {
      send({
        draft,
        mergeable: true,
        mergeable_state: "clean",
        base: { sha: "a".repeat(40), ref: "main" },
        head: { sha: "b".repeat(40), ref: "feat/pr-closeout" },
      });
      return;
    }
    if (req.method === "GET" && pathname.endsWith(`/commits/${"b".repeat(40)}/check-runs`)) {
      send({ check_runs: [] });
      return;
    }
    if (req.method === "GET" && pathname.endsWith(`/commits/${"b".repeat(40)}/status`)) {
      send({ statuses: [] });
      return;
    }
    if (req.method === "GET" && pathname.endsWith("/pulls/26/reviews")) {
      send([]);
      return;
    }
    if (req.method === "GET" && pathname.endsWith("/pulls/26/files")) {
      send([{ filename: "src/index.ts" }]);
      return;
    }
    if (req.method === "GET" && pathname === "/api/runs/validation-run-26") {
      send({ success: true, data: { workflowId: "pr-review" } });
      return;
    }
    if (req.method === "GET" && pathname === "/api/runs/validation-run-26/status") {
      send({ success: true, data: { status: "completed" } });
      return;
    }
    if (req.method === "GET" && pathname === "/api/runs/validation-run-26/handoffs") {
      send({ success: true, data: { handoffs: [{
        fromNode: "publish",
        port: "published",
        content: passingPrReviewPublication(),
      }] } });
      return;
    }
    if (req.method === "POST" && pathname === "/api/runs/create-and-run") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        createAndRunBodies.push(JSON.parse(raw) as Record<string, unknown>);
        send({ success: true, data: { runId: "run-pr-closeout-26" } }, 201);
      });
      return;
    }
    send({ success: false, error: "not found" }, 404);
  });
}

function makePatternManagerApiServer(observed: Array<{ method: string; path: string; body?: Record<string, unknown> }>): http.Server {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const finish = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: status < 400, data }));
    };
    if (req.method === "GET") {
      observed.push({ method: "GET", path: pathname });
      if (pathname === "/api/skills") {
        finish(200, { skills: [{ id: "homerail-dag-patterns", description: "Pattern guidance" }], total: 1 });
        return;
      }
      if (pathname === "/api/skills/homerail-dag-patterns") {
        finish(200, { id: "homerail-dag-patterns", content: "# HomeRail DAG Patterns\nUse heartbeat." });
        return;
      }
      if (pathname === "/api/dag/patterns") {
        finish(200, { patterns: [{ id: "heartbeat", summary: "One bounded action" }], total: 1 });
        return;
      }
      if (pathname === "/api/dag/patterns/heartbeat") {
        finish(200, { id: "heartbeat", parameters: { workflow_id: { type: "string" } } });
        return;
      }
      finish(404, { error: "not found" });
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      observed.push({ method: req.method || "POST", path: pathname, body });
      if (pathname === "/api/dag/patterns/heartbeat/instantiate") {
        finish(200, {
          parameters: { workflow_id: "manager-heartbeat" },
          workflow: { workflow_id: "manager-heartbeat", name: "Manager heartbeat" },
          yaml_text: "name: Manager heartbeat\nworkflow_id: manager-heartbeat\nnodes: {}\n",
          validation: { valid: true },
        });
        return;
      }
      if (pathname === "/api/dag/workflows/sync") {
        finish(200, { workflow_id: "manager-heartbeat" });
        return;
      }
      if (pathname === "/api/runs/create-and-run") {
        finish(201, { runId: "run-pattern-skill-123" });
        return;
      }
      finish(404, { error: "not found" });
    });
  });
}

function writeOrchestrationFiles(workspace: string): void {
  const dir = path.join(workspace, "assets", "orchestrations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "local-review-template.yaml"), "nodes: []\n", "utf8");
  fs.writeFileSync(path.join(dir, "example-review-template.yaml"), "nodes: []\n", "utf8");
  fs.writeFileSync(path.join(dir, "pr-closeout.yaml.template"), "api_version: homerail.ai/v1\n", "utf8");
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

class PrReviewToolAgent implements AgentClient {
  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    _context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const tool = tools.find((item) => item.name === "run_pr_review");
    if (!tool) throw new Error("run_pr_review tool missing");
    const input = { repo: "xiaotianfotos/homerail", pr: 25, expected_usage: 0 };
    yield { type: "tool_use", id: "tool-pr-review", name: "run_pr_review", input };
    const result = await tool.handler(input);
    yield {
      type: "tool_result",
      tool_use_id: "tool-pr-review",
      content: result.content.map((item) => item.text).join(""),
      is_error: result.is_error,
    };
    yield { type: "text", text: "PR review started" };
    yield { type: "done" };
  }
}

class PrCloseoutToolAgent implements AgentClient {
  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    _context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const tool = tools.find((item) => item.name === "run_pr_closeout");
    if (!tool) throw new Error("run_pr_closeout tool missing");
    const input = { repo: "xiaotianfotos/homerail", pr: 26, phase: "draft", validation_runs: ["validation-run-26"] };
    yield { type: "tool_use", id: "tool-pr-closeout", name: "run_pr_closeout", input };
    const result = await tool.handler(input);
    yield {
      type: "tool_result",
      tool_use_id: "tool-pr-closeout",
      content: result.content.map((item) => item.text).join(""),
      is_error: result.is_error,
    };
    yield { type: "text", text: "PR closeout started" };
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

class ErrorAgent implements AgentClient {
  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "error", message: "provider rejected the configured credential" };
    yield { type: "done" };
  }
}

class ObjectiveSuccessWithErrorAgent implements AgentClient {
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
    yield { type: "error", message: "harness stream ended after the run was created" };
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
  systemPromptMode: AgentRunContext["systemPromptMode"] = undefined;

  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    this.toolNames = tools.map((tool) => tool.name).sort();
    this.systemPrompt = context.systemPrompt ?? "";
    this.systemPromptMode = context.systemPromptMode;
    yield { type: "text", text: "catalog captured" };
    yield { type: "done" };
  }
}

class PatternSkillAgent implements AgentClient {
  systemPrompt = "";

  async *run(
    _prompt: string,
    tools: DagToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    this.systemPrompt = context.systemPrompt ?? "";
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: "list_skills", input: {} },
      { name: "read_skill", input: { skill_id: "homerail-dag-patterns" } },
      { name: "list_dag_patterns", input: {} },
      { name: "get_dag_pattern", input: { pattern_id: "heartbeat" } },
      {
        name: "instantiate_dag_pattern",
        input: { pattern_id: "heartbeat", parameters: { workflow_id: "manager-heartbeat" }, sync: true },
      },
      {
        name: "create_and_run",
        input: { workflow_id: "manager-heartbeat", prompt: "Inspect one bounded signal" },
      },
    ];
    for (const [index, call] of calls.entries()) {
      const tool = tools.find((item) => item.name === call.name);
      if (!tool) throw new Error(`${call.name} tool missing`);
      const id = `pattern-tool-${index + 1}`;
      yield { type: "tool_use", id, name: call.name, input: call.input };
      const result = await tool.handler(call.input);
      yield {
        type: "tool_result",
        tool_use_id: id,
        content: result.content.map((item) => item.text).join(""),
        is_error: result.is_error,
      };
    }
    yield { type: "text", text: "pattern skill run started" };
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

  it("reports the host process identity used for lifecycle recovery", async () => {
    vi.stubEnv("HOMERAIL_MANAGER_AGENT_FINGERPRINT", "fingerprint-test");
    vi.stubEnv("HOMERAIL_WORKER_ID", "manager-agent-host-project-test");
    vi.stubEnv("PROJECT_ID", "project-test");
    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "running",
        service: "manager-agent",
        fingerprint: "fingerprint-test",
        process_id: process.pid,
        project_id: "project-test",
        worker_id: "manager-agent-host-project-test",
      });
    } finally {
      await close(server);
    }
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
        effective_config: {
          harness: "manager-agent-no-tool-test",
          response_mode: "chat",
          model: "test-model",
          workspace,
          plugin_registry_revision: 0,
          plugin_context_digest: null,
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

  it("returns harness failures as structured errors instead of assistant text", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-error-test", () => new ErrorAgent());
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
          message: "hello",
          agent_config: { agent_type: "manager-agent-error-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { error?: string; data?: Record<string, unknown> };

      expect(response.status).toBe(502);
      expect(body.error).toBe("provider rejected the configured credential");
      expect(body.data).toMatchObject({
        code: "agent_execution_failed",
        errors: ["provider rejected the configured credential"],
        observed_tool_calls: [],
        run_ids: [],
      });
      expect(JSON.stringify(body)).not.toContain("[ERROR]");
    } finally {
      await close(server);
    }
  });

  it("preserves harness errors as non-spoken diagnostics after an objective succeeds", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-partial-error-test", () => new ObjectiveSuccessWithErrorAgent());
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
          message: "start a DAG",
          response_mode: "voice",
          agent_config: { agent_type: "manager-agent-partial-error-test", model: "test-model" },
        }),
      });
      const body = await response.json() as {
        text?: string;
        spoken_text?: string;
        agent_errors?: string[];
        run_ids?: string[];
      };

      expect(response.status).toBe(200);
      expect(body.text).toBe("started");
      expect(body.spoken_text).toBe("started");
      expect(body.run_ids).toEqual(["run-test-123"]);
      expect(body.agent_errors).toEqual(["harness stream ended after the run was created"]);
      expect(JSON.stringify(body)).not.toContain("[ERROR]");
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

  it("resolves immutable PR SHAs in run_pr_review without model field mapping", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-pr-review-tool-test", () => new PrReviewToolAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const createAndRunBodies: Record<string, unknown>[] = [];
    const managerApi = makePrReviewApiServer(createAndRunBodies);
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);
    vi.stubEnv("HOMERAIL_GITHUB_API_BASE_URL", `http://127.0.0.1:${managerPort}/github`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "审查 xiaotianfotos/homerail PR #25",
          required_tool_calls: ["create_and_run"],
          agent_config: { agent_type: "manager-agent-pr-review-tool-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { run_id?: string; objective?: { satisfied?: boolean } };
      expect(response.status).toBe(200);
      expect(body.run_id).toBe("run-pr-review-25");
      expect(body.objective?.satisfied).toBe(true);
      expect(createAndRunBodies).toHaveLength(1);
      expect(createAndRunBodies[0]).toMatchObject({
        yamlPath: "assets/orchestrations/pr-review.yaml.template",
      });
      const envelope = JSON.parse(String(createAndRunBodies[0].prompt)) as { payload: Record<string, unknown> };
      expect(envelope.payload).toMatchObject({
        repo: "xiaotianfotos/homerail",
        pr: 25,
        base: "a".repeat(40),
        head: "b".repeat(40),
        base_clone_url: "https://github.example/xiaotianfotos/homerail.git",
        head_clone_url: "https://github.example/contributor/homerail.git",
        expected_usage: 0,
        budget_key: expect.stringMatching(/^pr-review:xiaotianfotos\/homerail:\d{4}-\d{2}-\d{2}$/),
      });
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("starts deterministic PR closeout from GitHub and persisted run evidence", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-pr-closeout-tool-test", () => new PrCloseoutToolAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const createAndRunBodies: Record<string, unknown>[] = [];
    const managerApi = makePrCloseoutApiServer(createAndRunBodies);
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);
    vi.stubEnv("HOMERAIL_GITHUB_API_BASE_URL", `http://127.0.0.1:${managerPort}/github`);

    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "收口 xiaotianfotos/homerail PR #26",
          required_tool_calls: ["create_and_run"],
          agent_config: { agent_type: "manager-agent-pr-closeout-tool-test", model: "test-model" },
        }),
      });
      const body = await response.json() as { run_id?: string; objective?: { satisfied?: boolean } };
      expect(response.status).toBe(200);
      expect(body.run_id).toBe("run-pr-closeout-26");
      expect(body.objective?.satisfied).toBe(true);
      expect(createAndRunBodies).toHaveLength(1);
      expect(createAndRunBodies[0]).toMatchObject({
        yamlPath: "assets/orchestrations/pr-closeout.yaml.template",
      });
      const envelope = JSON.parse(String(createAndRunBodies[0].prompt)) as { payload: Record<string, unknown> };
      expect(envelope.payload).toMatchObject({
        repo: "xiaotianfotos/homerail",
        pr: 26,
        base: "a".repeat(40),
        head: "b".repeat(40),
        phase: "draft",
        closeout_status: "ready_for_review",
        blockers: [],
      });
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("blocks a draft closeout request after the PR leaves draft", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    registerAgentBackend("manager-agent-pr-closeout-phase-test", () => new PrCloseoutToolAgent());
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const createAndRunBodies: Record<string, unknown>[] = [];
    const managerApi = makePrCloseoutApiServer(createAndRunBodies, false);
    const managerPort = await listen(managerApi);
    vi.stubEnv("MANAGER_REST_URL", `http://127.0.0.1:${managerPort}/api`);
    vi.stubEnv("HOMERAIL_GITHUB_API_BASE_URL", `http://127.0.0.1:${managerPort}/github`);
    const server = startManagerAgentServer(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "收口 xiaotianfotos/homerail PR #26",
          agent_config: { agent_type: "manager-agent-pr-closeout-phase-test", model: "test-model" },
        }),
      });
      expect(response.status).toBe(200);
      const envelope = JSON.parse(String(createAndRunBodies[0].prompt)) as { payload: Record<string, unknown> };
      expect(envelope.payload).toMatchObject({
        phase: "draft",
        closeout_status: "blocked",
        blockers: expect.arrayContaining([expect.objectContaining({ code: "phase_mismatch" })]),
      });
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
      expect(agent.observed).toContain("pr-closeout.yaml.template");
      expect(JSON.parse(agent.observed)).toMatchObject({
        root: path.join(workspace, "assets", "orchestrations"),
      });
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
        "run_pr_closeout",
        "run_pr_review",
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
      expect(agent.systemPromptMode).toBe("append");
    } finally {
      await close(server);
      await close(managerApi);
    }
  });

  it("loads a HomeRail skill, instantiates its DAG pattern, syncs it, and starts a run", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-workspace-"));
    tmpDirs.push(workspace);
    const agent = new PatternSkillAgent();
    registerAgentBackend("manager-agent-pattern-skill-test", () => agent);
    vi.stubEnv("PROJECT_WORKSPACE", workspace);

    const observed: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const managerApi = makePatternManagerApiServer(observed);
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
          message: "用 Skill 启动一个周期检查 DAG",
          required_tool_calls: ["instantiate_dag_pattern", "create_and_run"],
          manager_skills: [{
            id: "homerail-dag-patterns",
            description: "Select reusable DAG patterns",
            source: "home",
          }],
          agent_config: { agent_type: "manager-agent-pattern-skill-test", model: "test" },
        }),
      });
      const body = await response.json() as {
        run_id?: string;
        objective?: { satisfied?: boolean };
        tool_calls?: Array<{ name: string }>;
      };

      expect(response.status).toBe(200);
      expect(body.run_id).toBe("run-pattern-skill-123");
      expect(body.objective?.satisfied).toBe(true);
      expect(body.tool_calls?.map((call) => call.name)).toEqual([
        "list_skills",
        "read_skill",
        "list_dag_patterns",
        "get_dag_pattern",
        "instantiate_dag_pattern",
        "create_and_run",
      ]);
      expect(agent.systemPrompt).toContain("homerail-dag-patterns: Select reusable DAG patterns [home]");
      expect(observed).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/dag/workflows/sync",
        body: expect.objectContaining({ source_path: "builtin:heartbeat" }),
      }));
      expect(observed).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/runs/create-and-run",
        body: expect.objectContaining({ workflow_id: "manager-heartbeat" }),
      }));
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

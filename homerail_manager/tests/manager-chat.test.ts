import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearActiveRuns } from "../src/runtime/active-runs.js";
import { createServer } from "../src/server/http.js";
import { _clearAllSessions, createSession as createAgentSession } from "../src/persistence/agent-sessions.js";
import { closeDb } from "../src/persistence/db.js";
import { createSetting, upsertProvider, _clearAllSettings as clearLlmSettings } from "../src/persistence/llm-settings.js";
import { createProject } from "../src/persistence/projects-changes.js";
import { ensureDefaultWorkspacePath } from "../src/config/env.js";
import { _clearNodes } from "../src/node/registry.js";
import { managerAgentRuntimePlacementForHarness } from "homerail-protocol";
import { ensureManagerAgentContainer, resolveManagerAgentConfig } from "../src/server/manager-agent-container.js";
import {
  _compactDeltasForTest,
  _hostCodexVoiceToolCatalogForTest,
  _invokeHostCodexVoiceToolForTest,
  _loadVoiceSystemContractForTest,
  _loadVoiceUiRulesForTest,
  _managerRestUrlForTest,
  _renderVoiceMemoForTest,
  _setHostCodexManagerAgentRunnerForTest,
  _systemPromptForTest,
  _voiceMemoPathForTest,
  _workspaceFromConfigForTest,
} from "../src/server/host-codex-manager-agent.js";
import {
  findAvailableManagerAgentPort,
  managerAgentHostPort,
  registerFakeDockerNode,
} from "./helpers/fake-manager-agent-node.js";
import type { CodexModelCatalog } from "../src/server/codex-models.js";

const TEST_CODEX_MODEL_CATALOG: CodexModelCatalog = {
  binary: "codex",
  models: [{
    id: "gpt-5.5",
    model: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "",
    is_default: true,
    default_reasoning_effort: "medium",
    supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
    service_tiers: [],
  }],
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("/api/manager/chat", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldLocalNodeAutostart: string | undefined;
  let oldManagerRuntime: string | undefined;
  let oldManagerAgentPort: string | undefined;
  let oldHostEntry: string | undefined;
  let oldHostShell: string | undefined;

  beforeEach(async () => {
    oldHome = process.env.HOMERAIL_HOME;
    oldLocalNodeAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    oldManagerRuntime = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    oldManagerAgentPort = process.env.HOMERAIL_MANAGER_AGENT_PORT;
    oldHostEntry = process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    oldHostShell = process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-chat-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "container";
    process.env.HOMERAIL_MANAGER_AGENT_PORT = String(await findAvailableManagerAgentPort());
    _clearActiveRuns();
    _clearAllSessions();
    _clearNodes();
    clearLlmSettings();
    server = createServer(0, undefined, undefined, false, {
      loadCodexModels: async () => TEST_CODEX_MODEL_CATALOG,
    });
  });

  afterEach(async () => {
    _clearActiveRuns();
    _clearAllSessions();
    _clearNodes();
    clearLlmSettings();
    _setHostCodexManagerAgentRunnerForTest();
    await close(server);
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldLocalNodeAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = oldLocalNodeAutostart;
    if (oldManagerRuntime === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    else process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = oldManagerRuntime;
    if (oldManagerAgentPort === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_PORT;
    else process.env.HOMERAIL_MANAGER_AGENT_PORT = oldManagerAgentPort;
    if (oldHostEntry === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    else process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = oldHostEntry;
    if (oldHostShell === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    else process.env.HOMERAIL_MANAGER_AGENT_SHELL = oldHostShell;
    closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("fails explicitly when no docker-capable node can host Manager Agent", async () => {
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/manager/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "create a task",
        manager_provider_name: "kimi",
        manager_model_name: "kimi-k2.7-code",
      }),
    });

    const body = await response.json() as {
      success: boolean;
      error?: string;
    };

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/container options|No connected docker-capable node/);

    const list = await fetch(`http://127.0.0.1:${port}/api/manager/sessions?project_id=&limit=10`);
    const listBody = await list.json() as { success: boolean; data: { sessions: unknown[] } };
    expect(list.status).toBe(200);
    expect(listBody.data.sessions).toHaveLength(1);
  });

  it("forwards non-Codex Manager Agent chat through the long-lived container path", async () => {
    await close(server);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-project-workspace-"));
    const project = createProject({ name: "Manager Container Project", workspace_path: workspaceDir });
    const projectId = project.id;
    const observedChatBodies: Record<string, unknown>[] = [];
    const fakeNode = registerFakeDockerNode(projectId, (body) => {
      observedChatBodies.push(body);
      return {
        text: "container manager handled",
        session_id: body.session_id,
        run_id: "run-container-123",
        run_ids: ["run-container-123"],
        objective: { required: false, satisfied: true, tool_calls: [{ name: "create_and_run", success: true }] },
        tool_calls: [{ id: "tool-1", name: "create_and_run", input: { yamlPath: "assets/orchestrations/test.yaml" } }],
        tool_results: [{ tool_use_id: "tool-1", content: "ok" }],
      };
    });
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/manager/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "启动一个非 Codex Manager Agent 验证",
          project_id: projectId,
        }),
      });
      const body = await response.json() as {
        success: boolean;
        data: {
          text: string;
          run_id: string;
          run_ids: string[];
          worker_id: string;
          container_name: string;
          tool_calls: Array<{ name: string }>;
          manager_agent_config: { agent_type: string; provider_name: string; model: string; base_url: string };
        };
      };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.text).toBe("container manager handled");
      expect(body.data.run_id).toBe("run-container-123");
      expect(body.data.run_ids).toEqual(["run-container-123"]);
      expect(body.data.worker_id).toBe("manager-agent-container-test");
      expect(body.data.container_name).toBe(`homerail-manager-agent-${projectId}`);
      expect(body.data.tool_calls).toContainEqual(expect.objectContaining({ name: "create_and_run" }));
      expect(body.data.manager_agent_config).toMatchObject({
        agent_type: "claude-sdk",
        provider_name: "qwen36",
        model: "qwen3.6",
        base_url: "http://127.0.0.1:5000",
      });
      expect(observedChatBodies).toHaveLength(1);
      expect(observedChatBodies[0]).toMatchObject({
        message: "启动一个非 Codex Manager Agent 验证",
        project_id: projectId,
        agent_config: {
          agent_type: "claude-sdk",
          provider_name: "qwen36",
          model: "qwen3.6",
          base_url: "http://127.0.0.1:5000",
        },
        manager_skills: expect.arrayContaining([
          expect.objectContaining({ id: "homerail-dag-patterns", source: "home" }),
        ]),
      });
      expect(fakeNode.requests.map((item) => `${item.resource_type}:${item.operation}`)).toEqual([
        "container:list",
        "container:create",
        "container:start",
      ]);
      const createRequest = fakeNode.requests.find((item) => item.operation === "create");
      expect(createRequest?.spec).toMatchObject({
        image: "homerail-worker:latest",
        name: `homerail-manager-agent-${projectId}`,
        env: {
          MANAGER_AGENT_MODE: "1",
          MANAGER_AGENT_PORT: "9001",
          PROJECT_ID: projectId,
          PROJECT_WORKSPACE: "/workspace/project",
          HOMERAIL_WORKER_ID: `manager-agent-${projectId}`,
        },
        ports: [{
          hostIp: "127.0.0.1",
          hostPort: managerAgentHostPort(projectId),
          containerPort: 9001,
          protocol: "tcp",
        }],
        workdir: "/workspace",
        mount_policy: { allowed_host_roots: [workspaceDir] },
      });
      expect((createRequest?.spec.mounts as Array<{ container?: string; mode?: string }>)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ container: "/workspace", mode: "rw" }),
          expect.objectContaining({ host: workspaceDir, container: "/workspace/project", mode: "rw" }),
        ]),
      );
    } finally {
      await fakeNode.close();
    }
  });

  it("routes non-Codex Manager Agent chat through a host-shell worker when configured", async () => {
    await close(server);
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "host-shell";
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    const hostEntry = path.join(tmpHome, "host-shell-worker.js");
    fs.writeFileSync(hostEntry, `
      const http = require('node:http');
      const port = Number(process.env.MANAGER_AGENT_PORT || '0');
      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'running',
            service: 'manager-agent',
            fingerprint: process.env.HOMERAIL_MANAGER_AGENT_FINGERPRINT,
            worker_id: process.env.HOMERAIL_WORKER_ID,
          }));
          return;
        }
        if (req.method === 'POST' && req.url === '/chat') {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            const body = raw ? JSON.parse(raw) : {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              text: 'host shell handled via ' + process.env.MANAGER_REST_URL,
              session_id: body.session_id || 'host-shell-session',
              run_id: null,
              run_ids: [],
              objective: { required: false, satisfied: true, tool_calls: [] },
              tool_calls: [],
              tool_results: [],
              effective_config: body.agent_config,
            }));
            setTimeout(() => server.close(() => process.exit(0)), 25);
          });
          return;
        }
        res.writeHead(404).end();
      });
      server.listen(port, '127.0.0.1');
    `, "utf-8");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = hostEntry;
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "host shell route", project_id: "p-host-shell" }),
    });
    const body = await response.json() as {
      data: {
        text: string;
        worker_id: string;
        container_name: string;
        runtime_placement: string;
        manager_agent_config: { runtime_placement: string; agent_type: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.text).toBe(`host shell handled via ${baseUrl}/api`);
    expect(body.data.worker_id).toBe("manager-agent-host-p-host-shell");
    expect(body.data.container_name).toBe("homerail-manager-agent-host-p-host-shell");
    expect(body.data.runtime_placement).toBe("host_shell");
    expect(body.data.manager_agent_config).toMatchObject({
      runtime_placement: "host_shell",
      agent_type: "claude-sdk",
    });
  });

  it("mounts the HomeRail default workspace when no project is selected", async () => {
    await close(server);
    const observedChatBodies: Record<string, unknown>[] = [];
    const fakeNode = registerFakeDockerNode("", (body) => {
      observedChatBodies.push(body);
      return {
        text: "default workspace handled",
        session_id: body.session_id,
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
      };
    });
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/manager/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "没有项目时使用默认工作区" }),
      });
      expect(response.status).toBe(200);

      const defaultWorkspace = ensureDefaultWorkspacePath();
      expect(fs.existsSync(defaultWorkspace)).toBe(true);
      expect(observedChatBodies[0]).toMatchObject({
        message: "没有项目时使用默认工作区",
      });
      const createRequest = fakeNode.requests.find((item) => item.operation === "create");
      expect(createRequest?.spec).toMatchObject({
        name: "homerail-manager-agent-__default__",
        env: {
          PROJECT_ID: "",
          PROJECT_WORKSPACE: "/workspace/project",
          HOMERAIL_WORKER_ID: "manager-agent-__default__",
        },
        mount_policy: { allowed_host_roots: [defaultWorkspace] },
      });
      expect((createRequest?.spec.mounts as Array<{ host?: string; container?: string; mode?: string }>)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ container: "/workspace", mode: "rw" }),
          expect.objectContaining({ host: defaultWorkspace, container: "/workspace/project", mode: "rw" }),
        ]),
      );
    } finally {
      await fakeNode.close();
    }
  });

  it("does not mount the manager process cwd for unknown project ids", async () => {
    await close(server);
    const projectId = `unknown-project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fakeNode = registerFakeDockerNode(projectId, () => ({
      text: "container manager handled",
      session_id: "unknown-project-session",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
    }));
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/manager/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "只回复收到", project_id: projectId }),
      });
      expect(response.status).toBe(200);

      const createRequest = fakeNode.requests.find((item) => item.operation === "create");
      expect(createRequest?.spec).toMatchObject({
        env: {
          PROJECT_ID: projectId,
          PROJECT_WORKSPACE: "",
        },
      });
      expect(createRequest?.spec.mounts).toEqual([
        expect.objectContaining({ container: "/workspace", mode: "rw" }),
      ]);
    } finally {
      await fakeNode.close();
    }
  });

  it("recreates an existing Manager Agent container when its runtime fingerprint is stale", async () => {
    const projectId = "stale-fingerprint-project";
    const fakeNode = registerFakeDockerNode(
      projectId,
      () => ({ text: "unused" }),
      {
        existingContainer: {
          id: "stale-manager-agent-container",
          name: `homerail-manager-agent-${projectId}`,
          status: "running",
          labels: {
            "homerail.resource_type": "manager-agent",
            "homerail.project_id": projectId,
            "homerail.config_fingerprint": "stale",
          },
        },
      },
    );

    try {
      const result = await ensureManagerAgentContainer(projectId, {
        managerRestUrl: "http://127.0.0.1:19191/api",
        image: "homerail-worker:latest",
      });

      expect(result.containerId).toBe("manager-agent-container-test");
      expect(fakeNode.requests.map((item) => `${item.resource_type}:${item.operation}`)).toEqual([
        "container:list",
        "container:inspect",
        "container:stop",
        "container:remove",
        "container:create",
        "container:start",
      ]);
      const createRequest = fakeNode.requests.find((item) => item.operation === "create");
      expect(createRequest?.spec).toMatchObject({
        name: `homerail-manager-agent-${projectId}`,
        env: {
          MANAGER_REST_URL: "http://127.0.0.1:19191/api",
          PROJECT_ID: projectId,
        },
        labels: {
          "homerail.resource_type": "manager-agent",
          "homerail.project_id": projectId,
        },
      });
      const labels = createRequest?.spec.labels as Record<string, string>;
      expect(labels["homerail.config_fingerprint"]).toMatch(/^[a-f0-9]{16}$/);
      expect(labels["homerail.config_fingerprint"]).not.toBe("stale");
    } finally {
      await fakeNode.close();
    }
  });

  it("selects the Kimi Code CLI harness for Kimi Manager Agent settings", () => {
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_api",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      protocol: "openai_compatible",
      is_active: true,
      is_default: true,
    });

    const config = resolveManagerAgentConfig(undefined, "kimi", "kimi-k2.7-code");

    expect(config.agent_type).toBe("kimi_code");
    expect(config.runtime_placement).toBe("container");
    expect(config.base_url).toBe("https://api.moonshot.ai/v1");
  });

  it("selects the Kimi Code CLI harness for Kimi Coding Plan", () => {
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    const config = resolveManagerAgentConfig(undefined, "kimi", "kimi-k2.7-code");

    expect(config.agent_type).toBe("kimi_code");
    expect(config.runtime_placement).toBe("container");
    expect(config.base_url).toBe("https://api.kimi.com/coding/v1");
  });

  it("resolves explicit kimi_code harness against the active Kimi setting", () => {
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    const config = resolveManagerAgentConfig(undefined, undefined, undefined, undefined, "kimi_code");

    expect(config).toMatchObject({
      provider_name: "kimi",
      model: "kimi-k2.7-code",
      agent_type: "kimi_code",
      runtime_placement: "container",
      base_url: "https://api.kimi.com/coding/v1",
    });
  });

  it("keeps runtime placement as the only harness boundary", () => {
    expect(managerAgentRuntimePlacementForHarness("codex_appserver")).toBe("host");
    expect(managerAgentRuntimePlacementForHarness("kimi_code")).toBe("container");
    expect(managerAgentRuntimePlacementForHarness("claude_agent_sdk")).toBe("container");
  });

  it("selects claude-sdk only with an Anthropic-compatible Manager Agent endpoint", () => {
    upsertProvider({
      id: "qwen36",
      name: "Qwen 3.6",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });

    const config = resolveManagerAgentConfig(undefined, "qwen36", "qwen3.6");

    expect(config.agent_type).toBe("claude-sdk");
    expect(config.runtime_placement).toBe("container");
    expect(config.base_url).toBe("http://127.0.0.1:5000");
  });

  it("resolves Manager Agent config by llm_setting_id even when provider display name is stored", () => {
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });

    const config = resolveManagerAgentConfig(undefined, "Qwen3.6 Local", "qwen3.6", setting.id);

    expect(config.provider_name).toBe("qwen36");
    expect(config.model).toBe("qwen3.6");
    expect(config.agent_type).toBe("claude-sdk");
    expect(config.base_url).toBe("http://127.0.0.1:5000");
  });

  it("uses persisted Manager Agent config when chat request has no runtime override", async () => {
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "只回复收到", project_id: "p1" }),
    });
    expect(response.status).toBe(503);

    const list = await fetch(`${baseUrl}/api/manager/sessions?project_id=p1&limit=10`);
    const listBody = await list.json() as {
      data: {
        sessions: Array<{
          metadata: {
            manager_llm_setting_id?: string | null;
            manager_provider_name?: string | null;
            manager_model_name?: string | null;
          };
        }>;
      };
    };
    expect(listBody.data.sessions[0]?.metadata).toMatchObject({
      manager_llm_setting_id: setting.id,
      manager_provider_name: "qwen36",
      manager_model_name: "qwen3.6",
    });
  });

  it("falls back to the current Manager Agent config when a continued session references a deleted setting", async () => {
    await close(server);
    const observedChatBodies: Record<string, unknown>[] = [];
    const fakeNode = registerFakeDockerNode("", (body) => {
      observedChatBodies.push(body);
      return {
        text: "fallback setting handled",
        session_id: body.session_id,
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
      };
    });
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    createAgentSession("legacy-manager-session", {
      source: "manager-chat",
      manager_llm_setting_id: "deleted-setting-id",
      manager_provider_name: "old-provider",
      manager_model_name: "old-model",
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/manager/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "沿用旧会话但使用当前配置",
          session_id: "legacy-manager-session",
        }),
      });
      const body = await response.json() as {
        data: {
          session_id: string;
          manager_agent_config: { provider_name: string; model: string };
        };
      };

      expect(response.status).toBe(200);
      expect(body.data.session_id).not.toBe("legacy-manager-session");
      expect(body.data.manager_agent_config).toMatchObject({
        provider_name: "qwen36",
        model: "qwen3.6",
      });
      expect(observedChatBodies[0]?.agent_config).toMatchObject({
        provider_name: "qwen36",
        model: "qwen3.6",
      });
    } finally {
      await fakeNode.close();
    }
  });

  it("resolves codex_appserver as a Manager Agent harness without an LLM setting", () => {
    const config = resolveManagerAgentConfig(
      undefined,
      undefined,
      "gpt-5.6-sol",
      undefined,
      "codex_appserver",
      "ultra",
      "priority",
    );

    expect(config).toMatchObject({
      provider_name: "",
      model: "gpt-5.6-sol",
      agent_type: "codex_appserver",
      runtime_placement: "host",
      api_key: "",
      base_url: "",
      reasoning_effort: "ultra",
      service_tier: "priority",
    });
  });

  it("uses the HomeRail default workspace for host Codex when no project workspace is configured", () => {
    const workspace = _workspaceFromConfigForTest({
      provider_name: "",
      model: "gpt-5.5",
      api_key: "",
      base_url: "",
      agent_type: "codex_appserver",
      runtime_placement: "host",
    });

    expect(workspace).toBe(path.join(tmpHome, "workspace", "default"));
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it("does not pass HomeRail LLM setting providers into host Codex app-server", async () => {
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const resolved = resolveManagerAgentConfig(undefined, "qwen36", "qwen3.6", setting.id, "codex_appserver");
    expect(resolved).toMatchObject({
      provider_name: "",
      model: "gpt-5.5",
      agent_type: "codex_appserver",
      runtime_placement: "host",
      api_key: "",
      base_url: "",
    });

    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", llm_setting_id: setting.id, provider_name: "qwen36", model_name: "qwen3.6" }),
    });
    const body = await saved.json() as {
      data: { harness: string; llm_setting_id: string | null; provider_name: string | null; model_name: string | null };
    };
    expect(saved.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "codex_appserver",
      llm_setting_id: null,
      provider_name: null,
      model_name: "gpt-5.5",
    });
  });

  it("persists kimi_code Manager Agent config with a Kimi setting", async () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "kimi_code", llm_setting_id: setting.id }),
    });
    const body = await saved.json() as {
      data: { harness: string; llm_setting_id: string | null; provider_name: string | null; model_name: string | null };
    };

    expect(saved.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "kimi_code",
      llm_setting_id: setting.id,
      provider_name: "kimi",
      model_name: "kimi-k2.7-code",
    });
  });

  it("preserves explicit Claude SDK harness configs with Kimi settings", async () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-manager-chat",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "claude_agent_sdk", llm_setting_id: setting.id }),
    });
    const body = await saved.json() as {
      data: { harness: string; provider_name: string | null };
    };

    expect(saved.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "claude_agent_sdk",
      provider_name: "kimi",
    });
  });

  it("routes codex_appserver Manager Agent chat through host Codex without a container", async () => {
    let seenMessage = "";
    let seenAgentType = "";
    let seenSkills: Array<{ id: string; source?: string }> = [];
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      seenMessage = input.message;
      seenAgentType = input.agent_config.agent_type;
      seenSkills = input.manager_skills ?? [];
      return {
        text: "host codex handled",
        session_id: input.session_id,
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        worker_id: "host-codex",
        container_name: null,
      };
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5" }),
    });
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "启动一个 DAG", project_id: "p-host-codex" }),
    });
    const body = await response.json() as {
      success: boolean;
      data: {
        text: string;
        worker_id: string;
        container_name: string | null;
        runtime_placement: string;
        manager_agent_config: { agent_type: string; runtime_placement: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.text).toBe("host codex handled");
    expect(body.data.worker_id).toBe("host-codex");
    expect(body.data.container_name).toBeNull();
    expect(body.data.runtime_placement).toBe("host");
    expect(body.data.manager_agent_config.agent_type).toBe("codex_appserver");
    expect(body.data.manager_agent_config.runtime_placement).toBe("host");
    expect(seenMessage).toBe("启动一个 DAG");
    expect(seenAgentType).toBe("codex_appserver");
    expect(seenSkills).toContainEqual(expect.objectContaining({
      id: "homerail-dag-patterns",
      source: "home",
    }));
  });

  it("normalizes container-only manager URLs for host Codex tools", () => {
    expect(_managerRestUrlForTest("http://host.docker.internal:19191")).toBe("http://127.0.0.1:19191/api");
    expect(_managerRestUrlForTest("http://host.docker.internal:19191/api")).toBe("http://127.0.0.1:19191/api");
    expect(_managerRestUrlForTest("http://127.0.0.1:19192")).toBe("http://127.0.0.1:19192/api");
  });

  it("compacts host Codex streamed text deltas without inserting line breaks", () => {
    expect(_compactDeltasForTest(["你好", "，", "我可以帮你启动 DAG。"])).toBe("你好，我可以帮你启动 DAG。");
  });

  it("loads baseline, generative UI skill, and user voice UI rules for host Codex", () => {
    const userRuleDir = path.join(tmpHome, "asset", "voice-agent");
    fs.mkdirSync(userRuleDir, { recursive: true });
    fs.writeFileSync(
      path.join(userRuleDir, "ui-rules.md"),
      [
        "# User Voice Rules",
        "默认使用 voice-memo 记录用户连续表达的需求。",
        "任务没确认前不要启动执行态势卡。",
      ].join("\n"),
      "utf8",
    );

    const rules = _loadVoiceUiRulesForTest();

    expect(rules.sources.some((source) => source.startsWith("baseline:"))).toBe(true);
    expect(rules.sources.some((source) => source.startsWith("skill:"))).toBe(true);
    expect(rules.sources.some((source) => source.startsWith("user:"))).toBe(true);
    expect(rules.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(rules.prompt).toContain("Voice Agent UI Principles");
    expect(rules.prompt).toContain("Memo Widget");
    expect(rules.prompt).toContain("Widget Tool Catalog");
    expect(rules.prompt).toContain("Memo update contract");
    expect(rules.prompt).toContain("voice-memo");
    expect(rules.prompt).toContain("show_dynamic_widget");
    expect(rules.prompt).toContain("update_voice_memo");
    expect(rules.prompt).toContain("默认使用 voice-memo");
  });

  it("loads the voice system contract asset into the host Codex voice prompt", () => {
    const contract = _loadVoiceSystemContractForTest();
    expect(contract.source).toBe("system:builtin");
    expect(contract.prompt).toContain("Voice Surface Contract");
    expect(contract.prompt).toContain("same Main Agent");
    expect(contract.prompt).toContain("Generated UI must come from voice tools");

    const prompt = _systemPromptForTest({
      agent_type: "codex_appserver",
      provider_name: "codex",
      model: "gpt-5.5",
      reasoning_effort: "low",
    }, "voice");

    expect(prompt).toContain("Voice system source:");
    expect(prompt).toContain("system:builtin");
    expect(prompt).toContain("Voice Surface Contract");
    expect(prompt).toContain("same Main Agent");
    expect(prompt).toContain("Generated UI must come from voice tools");
    expect(prompt).toContain("Voice UI rules sources:");
  });

  it("renders a file-backed voice memo into a stable widget contract", () => {
    const rendered = _renderVoiceMemoForTest({
      title: "任务记录",
      status: "clarifying",
      summary: "用户想调查过去 24 小时的 AI 新闻。",
      known_facts: ["时间范围是过去 24 小时"],
      open_questions: ["交付形式是口头摘要还是文档"],
      todos: [
        { text: "确认范围", done: true },
        { text: "确认交付形式", done: false },
      ],
      next_action: "询问交付形式",
      ready_to_execute: false,
    }, "/tmp/voice-memo.toml");

    expect(rendered.toml).toContain('title = "任务记录"');
    expect(rendered.toml).toContain('status = "clarifying"');
    expect(rendered.toml).toContain("[[todo]]");
    expect(rendered.widget).toMatchObject({
      id: "voice-memo",
      type: "note",
      title: "任务记录",
      status: "clarifying",
      data: {
        ui_state: "visible",
        memo_status: "clarifying",
        ready_to_execute: false,
        memo_path: "/tmp/voice-memo.toml",
      },
    });
    expect(rendered.widget.items).toContain("TODO 确认交付形式");
    expect(rendered.widget.items).toContain("DONE 确认范围");
  });

  it("stores voice memos under a stable voice session path", () => {
    const memoPath = _voiceMemoPathForTest("Project Alpha", "voice-session-123");
    expect(memoPath).toBe(path.join(
      tmpHome,
      "manager",
      "voice-agent-projects",
      "project-alpha",
      "assets",
      "widgets",
      "voice-session-123",
      "voice-memo.toml",
    ));
  });

  it("exposes Widget File Protocol as Manager-internal voice tools", () => {
    const tools = _hostCodexVoiceToolCatalogForTest();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "list_skills",
      "read_skill",
      "list_dag_patterns",
      "get_dag_pattern",
      "instantiate_dag_pattern",
      "get_dag_schema",
      "validate_dag_workflow",
      "sync_dag_workflow",
      "update_voice_memo",
      "validate_widget_file",
      "write_widget_file",
      "read_widget_file",
      "remove_widget_file",
      "show_widget_toml_example",
    ]));
    for (const name of ["validate_widget_file", "write_widget_file", "read_widget_file", "remove_widget_file"]) {
      const tool = tools.find((item) => item.name === name);
      expect(tool?.description).toContain("Manager-internal");
    }
  });

  it("exposes skill and DAG pattern operations through host Codex tools", async () => {
    const port = await listen(server);
    const managerRestUrl = `http://127.0.0.1:${port}/api`;

    const listedSkills = await _invokeHostCodexVoiceToolForTest(
      "list_skills",
      {},
      { managerRestUrl },
    );
    expect(listedSkills.result.content[0].text).toContain("homerail-dag-patterns");

    const skill = await _invokeHostCodexVoiceToolForTest(
      "read_skill",
      { skill_id: "homerail-dag-patterns" },
      { managerRestUrl },
    );
    expect(skill.result.content[0].text).toContain("Manager Agent Native Path");

    const patterns = await _invokeHostCodexVoiceToolForTest(
      "list_dag_patterns",
      {},
      { managerRestUrl },
    );
    expect(patterns.result.content[0].text).toContain("heartbeat");

    const pattern = await _invokeHostCodexVoiceToolForTest(
      "get_dag_pattern",
      { pattern_id: "heartbeat" },
      { managerRestUrl },
    );
    expect(pattern.result.content[0].text).toContain("condition_gateway");

    const instantiated = await _invokeHostCodexVoiceToolForTest(
      "instantiate_dag_pattern",
      {
        pattern_id: "heartbeat",
        parameters: { workflow_id: "host-skill-heartbeat", name: "Host Skill Heartbeat" },
        sync: true,
      },
      { managerRestUrl },
    );
    expect(instantiated.result.is_error).toBeFalsy();
    expect(instantiated.result.content[0].text).toContain('"synced":true');

    const schema = await _invokeHostCodexVoiceToolForTest(
      "get_dag_schema",
      {},
      { managerRestUrl },
    );
    expect(schema.result.content[0].text).toContain("homerail.ai/v1");

    const validation = await _invokeHostCodexVoiceToolForTest(
      "validate_dag_workflow",
      { source: "api_version: homerail.ai/v1\nkind: Workflow\n" },
      { managerRestUrl },
    );
    expect(validation.result.content[0].text).toContain("DAG_SCHEMA_REQUIRED_FIELD");

    const workflow = await fetch(`http://127.0.0.1:${port}/api/dag/workflows/host-skill-heartbeat`);
    expect(workflow.status).toBe(200);
  });

  it("writes voice widgets only after TOML validation succeeds", async () => {
    const memo = await _invokeHostCodexVoiceToolForTest("update_voice_memo", {
      title: "任务记录",
      status: "clarifying",
      summary: "确认需求",
    }, { projectId: "p-widget", sessionId: "s-widget" });
    expect(memo.result.is_error).toBeFalsy();
    expect(memo.voiceSurface.widgets).toContainEqual(expect.objectContaining({
      id: "voice-memo",
      title: "任务记录",
    }));

    const validation = await _invokeHostCodexVoiceToolForTest("validate_widget_file", {
      widget_type: "checklist",
      toml: [
        'widget_id = "review-checklist"',
        'widget_type = "checklist"',
        "schema_version = 1",
        'title = "PR 审查清单"',
        'summary = "用于跟踪当前审查任务的关键步骤。"',
        "",
        "[[item]]",
        'text = "读取 diff"',
      ].join("\n"),
    }, { projectId: "p-widget", sessionId: "s-widget" });
    expect(validation.result.is_error).toBeFalsy();

    const example = await _invokeHostCodexVoiceToolForTest("show_widget_toml_example", {
      widget_type: "checklist",
    }, { projectId: "p-widget", sessionId: "s-widget" });
    expect(example.result.content[0]?.text).toContain("widget_type");

    const invalid = await _invokeHostCodexVoiceToolForTest("write_widget_file", {
      widget_type: "memo",
      widget_id: "voice-memo",
      toml: [
        'widget_id = "voice-memo"',
        'widget_type = "memo"',
        "schema_version = 1",
        'title = "任务记录"',
        'status = "bad"',
      ].join("\n"),
    }, { projectId: "p-widget", sessionId: "s-widget" });

    expect(invalid.result.is_error).toBe(true);
    expect(invalid.voiceSurface.widgets).toHaveLength(0);

    const valid = await _invokeHostCodexVoiceToolForTest("write_widget_file", {
      widget_type: "checklist",
      toml: [
        'widget_id = "review-checklist"',
        'widget_type = "checklist"',
        "schema_version = 1",
        'title = "PR 审查清单"',
        'summary = "用于跟踪当前审查任务的关键步骤。"',
        "",
        "[[item]]",
        'text = "读取 diff"',
        "done = true",
      ].join("\n"),
    }, { projectId: "p-widget", sessionId: "s-widget" });

    expect(valid.result.is_error).toBeFalsy();
    expect(valid.voiceSurface.widgets).toContainEqual(expect.objectContaining({
      id: "review-checklist",
      type: "list",
      title: "PR 审查清单",
    }));

    const read = await _invokeHostCodexVoiceToolForTest("read_widget_file", {
      widget_type: "checklist",
      widget_id: "review-checklist",
    }, { projectId: "p-widget", sessionId: "s-widget" });
    expect(read.result.is_error).toBeFalsy();
    expect(read.result.content[0]?.text).toContain("review-checklist");

    const removed = await _invokeHostCodexVoiceToolForTest("remove_widget_file", {
      widget_id: "review-checklist",
    }, { projectId: "p-widget", sessionId: "s-widget" });
    expect(removed.result.is_error).toBeFalsy();
    expect(removed.voiceSurface.removeWidgetIds).toContain("review-checklist");
  });

  it("rejects voice-only settings as Manager Agent runtimes", async () => {
    const ttsSetting = createSetting({
      provider_id: "xiaomi",
      endpoint_id: "xiaomi_mimo_api",
      model_name: "mimo-v2.5-tts",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "https://api.xiaomimimo.com/anthropic",
      anthropic_base_url: "https://api.xiaomimimo.com/anthropic",
      supports_llm: false,
      supports_tts: true,
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_setting_id: ttsSetting.id }),
    });
    const body = await response.json() as { success: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Manager Agent setting must support LLM runtime");
    expect(() => resolveManagerAgentConfig(undefined, undefined, undefined, ttsSetting.id)).toThrow(
      /Manager Agent setting must support LLM runtime/,
    );
    expect(() => resolveManagerAgentConfig(undefined)).toThrow(/No active Manager LLM setting found/);
  });

  it("rejects voice service settings even when legacy data marks them as LLM-capable", async () => {
    const ttsSetting = createSetting({
      provider_id: "xiaomi",
      endpoint_id: "xiaomi_mimo_api",
      model_name: "mimo-v2.5-tts",
      api_key: "pk-test-manager-chat",
      protocol: "anthropic_compatible",
      base_url: "https://api.xiaomimimo.com/anthropic",
      anthropic_base_url: "https://api.xiaomimimo.com/anthropic",
      supports_llm: true,
      supports_tts: true,
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_setting_id: ttsSetting.id }),
    });
    const body = await response.json() as { success: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Manager Agent setting must be a dedicated LLM runtime");
    expect(() => resolveManagerAgentConfig(undefined, undefined, undefined, ttsSetting.id)).toThrow(
      /Manager Agent setting must be a dedicated LLM runtime/,
    );
    expect(() => resolveManagerAgentConfig(undefined)).toThrow(/No active Manager LLM setting found/);
  });
});

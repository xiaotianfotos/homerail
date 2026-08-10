import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/http.js";
import { _clearAllSettings, createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import {
  clearManagerAgentConfig,
  DEFAULT_MANAGER_AGENT_CONFIG,
} from "../src/persistence/manager-agent-config.js";
import { _clearNodes } from "../src/node/registry.js";
import { registerFakeDockerNode } from "./helpers/fake-docker-node.js";
import { managerAgentReadiness } from "../src/server/manager-agent-readiness.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
      if (attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function writeDagResourceStatus(
  home: string,
  status: "unknown" | "building" | "ready" | "error",
  compatibility?: "current" | "stale" | "incompatible" | "unknown",
): void {
  const dir = path.join(home, "runtime");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dag-resources.json"), JSON.stringify({
    revision: 42,
    updated_at: Date.now(),
    platform: "linux",
    docker: {
      status: "ready",
      message: "Docker is ready",
    },
    source: {
      available: true,
      repo_root: "/repo",
      protocol_version: "0.1.0",
    },
    worker_image: {
      status,
      image: "homerail-worker:latest",
      message: status === "building" ? "Building test worker image" : "Worker image test status",
      updated_at: Date.now(),
      error: status === "error" ? "test build failed" : undefined,
      compatibility,
      reason: compatibility === "stale" ? "stale" : undefined,
      reason_code: compatibility === "stale" ? "worker_image_stale" : undefined,
    },
    images: [],
    workers: [],
  }));
}

describe("/api/manager-agent/readiness", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldLocalNodeAutostart: string | undefined;
  let oldHostEntry: string | undefined;
  let oldHostShell: string | undefined;
  let oldRepoRoot: string | undefined;
  let oldAnthropicKey: string | undefined;
  let oldCodexHome: string | undefined;
  let oldCodexBin: string | undefined;
  let oldOpenAiKey: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldLocalNodeAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    oldHostEntry = process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    oldHostShell = process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    oldRepoRoot = process.env.HOMERAIL_REPO_ROOT;
    oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
    oldCodexHome = process.env.CODEX_HOME;
    oldCodexBin = process.env.HOMERAIL_CODEX_BIN;
    oldOpenAiKey = process.env.OPENAI_API_KEY;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-readiness-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    delete process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    delete process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CODEX_HOME;
    delete process.env.HOMERAIL_CODEX_BIN;
    delete process.env.OPENAI_API_KEY;
    clearManagerAgentConfig();
    _clearAllSettings();
    _clearNodes();
  });

  afterEach(async () => {
    if (server?.listening) await close(server);
    clearManagerAgentConfig();
    _clearAllSettings();
    _clearNodes();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldLocalNodeAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = oldLocalNodeAutostart;
    if (oldHostEntry === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    else process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = oldHostEntry;
    if (oldHostShell === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    else process.env.HOMERAIL_MANAGER_AGENT_SHELL = oldHostShell;
    if (oldRepoRoot === undefined) delete process.env.HOMERAIL_REPO_ROOT;
    else process.env.HOMERAIL_REPO_ROOT = oldRepoRoot;
    if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldCodexBin === undefined) delete process.env.HOMERAIL_CODEX_BIN;
    else process.env.HOMERAIL_CODEX_BIN = oldCodexBin;
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAiKey;
    await removeTempDir(tmpHome);
  });

  it("reports config blockers instead of raw Codex or LLM presence", async () => {
    server = createServer(0);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/manager-agent/readiness`);
    const body = await response.json() as {
      success: boolean;
      data: { ready: boolean; blockers: Array<{ code: string; message: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.ready).toBe(false);
    expect(body.data.blockers).toContainEqual(expect.objectContaining({
      code: "manager_config_invalid",
    }));
  });

  it("reports missing Codex binary and authentication as independent blockers", () => {
    process.env.HOMERAIL_CODEX_BIN = path.join(tmpHome, "missing-codex");
    process.env.CODEX_HOME = path.join(tmpHome, "missing-codex-home");

    const readiness = managerAgentReadiness({
      ...DEFAULT_MANAGER_AGENT_CONFIG,
      harness: "codex_appserver",
      model_name: "gpt-5.5",
    });

    expect(readiness.blockers.map((item) => item.code)).toEqual([
      "codex_binary_not_found",
      "codex_auth_missing",
    ]);
  });

  it("does not require a ChatGPT login for provider-backed Codex", () => {
    process.env.HOMERAIL_CODEX_BIN = path.join(tmpHome, "missing-codex");
    process.env.CODEX_HOME = path.join(tmpHome, "missing-codex-home");
    upsertProvider({
      id: "local-responses",
      default_model: "local-coder",
      responses_base_url: "http://127.0.0.1:8000/v1",
    });
    const setting = createSetting({
      provider_id: "local-responses",
      endpoint_id: "local-responses_custom",
      model_name: "local-coder",
      api_key: "local-no-key",
      protocol: "custom",
      responses_base_url: "http://127.0.0.1:8000/v1",
      is_active: true,
      is_default: true,
    });

    const readiness = managerAgentReadiness({
      ...DEFAULT_MANAGER_AGENT_CONFIG,
      harness: "codex_appserver",
      llm_setting_id: setting.id,
      provider_name: setting.provider_id,
      model_name: setting.model_name,
    });

    expect(readiness.blockers.map((item) => item.code)).toEqual(["codex_binary_not_found"]);
  });

  it("does not report provider-backed Codex Live Voice as effective", () => {
    process.env.HOMERAIL_CODEX_BIN = path.join(tmpHome, "missing-codex");
    process.env.CODEX_HOME = path.join(tmpHome, "missing-codex-home");
    upsertProvider({
      id: "local-responses",
      default_model: "local-coder",
      responses_base_url: "http://127.0.0.1:8000/v1",
    });
    const setting = createSetting({
      provider_id: "local-responses",
      endpoint_id: "local-responses_custom",
      model_name: "local-coder",
      api_key: "local-no-key",
      protocol: "custom",
      responses_base_url: "http://127.0.0.1:8000/v1",
      is_active: true,
      is_default: true,
    });

    const readiness = managerAgentReadiness({
      ...DEFAULT_MANAGER_AGENT_CONFIG,
      harness: "codex_appserver",
      llm_setting_id: setting.id,
      provider_name: setting.provider_id,
      model_name: setting.model_name,
      live_voice_enabled: true,
    });

    expect(readiness.live_voice_effective).toBe(false);
    expect(readiness.blockers.map((item) => item.code)).toEqual([
      "codex_provider_live_voice_unsupported",
      "codex_binary_not_found",
    ]);
  });

  it("reports Gemini Live as the effective Manager voice backend", () => {
    const workerEntry = path.join(tmpHome, "worker-entry.js");
    fs.writeFileSync(workerEntry, "console.log('worker entry')\n", "utf-8");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = workerEntry;
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    const setting = createSetting({
      provider_id: "gemini",
      endpoint_id: "gemini_ai_studio",
      model_name: "gemini-3.6-flash",
      api_key: "google-ai-studio-test-key",
      is_active: true,
      is_default: true,
    });

    const readiness = managerAgentReadiness({
      ...DEFAULT_MANAGER_AGENT_CONFIG,
      harness: "kimi_code",
      llm_setting_id: setting.id,
      provider_name: setting.provider_id,
      model_name: setting.model_name,
      live_voice_enabled: true,
    });

    expect(readiness).toMatchObject({
      ready: true,
      live_voice_backend: "gemini",
      live_voice_supported: true,
      live_voice_effective: true,
      checks: {
        gemini_live: {
          supported: true,
          transport: "websocket_pcm",
          model: "gemini-3.1-flash-live-preview",
          input_sample_rate: 16000,
          output_sample_rate: 24000,
        },
      },
    });
  });

  it("reports missing host prerequisites without requiring a Docker node", async () => {
    process.env.HOMERAIL_REPO_ROOT = tmpHome;
    server = createServer(0, undefined, undefined, false);
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-readiness",
      base_url: "https://api.moonshot.cn",
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
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager-agent/readiness`);
    const body = await response.json() as {
      data: {
        ready: boolean;
        runtime_placement: string;
        blockers: Array<{ code: string }>;
        checks: {
          docker_node?: unknown;
          host_shell?: { required: boolean; available: boolean };
        };
      };
    };

    expect(body.data.ready).toBe(false);
    expect(body.data.runtime_placement).toBe("host_shell");
    expect(body.data.checks.docker_node).toBeUndefined();
    expect(body.data.checks.host_shell).toEqual({ required: true, available: false });
    expect(body.data.blockers.map((item) => item.code)).toEqual(["host_shell_unavailable"]);
  });

  it("reports a host-shell harness ready without a Docker node", async () => {
    const workerEntry = path.join(tmpHome, "worker-entry.js");
    fs.writeFileSync(workerEntry, "console.log('worker entry')\n", "utf-8");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = workerEntry;
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    // 专用 setting 自带端点与 Key，无需宿主机 Claude 凭证即可就绪
    // （无 ANTHROPIC_API_KEY 也无 ~/.claude 登录态，刻意验证这一点）。
    server = createServer(0, undefined, undefined, false);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "https://qwen.example/anthropic",
      anthropic_base_url: "https://qwen.example/anthropic",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_coding",
      model_name: "qwen3.6",
      api_key: "pk-test-readiness",
      protocol: "anthropic_compatible",
      base_url: "https://qwen.example/anthropic",
      anthropic_base_url: "https://qwen.example/anthropic",
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
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager-agent/readiness`);
    const body = await response.json() as {
      data: {
        ready: boolean;
        runtime_placement: string;
        agent_type: string;
        blockers: unknown[];
        checks: {
          docker_node?: unknown;
          host_shell?: { required: boolean; available: boolean; worker_entry?: string };
          docker_workspace?: { required: boolean; host_path: string; probe_endpoint: string };
        };
      };
    };

    expect(body.data).toMatchObject({
      ready: true,
      runtime_placement: "host_shell",
      agent_type: "claude-sdk",
      blockers: [],
    });
    expect(body.data.checks.docker_node).toBeUndefined();
    expect(body.data.checks.host_shell).toMatchObject({
      required: true,
      available: true,
      worker_entry: workerEntry,
    });
    expect(body.data.checks.docker_workspace).toEqual({
      required: false,
      host_path: path.join(tmpHome, "workspace"),
      probe_endpoint: "/api/dag/docker-workspace-probe",
    });
  });

  it("does not report the agent step ready on a fresh home with no LLM settings", async () => {
    const workerEntry = path.join(tmpHome, "worker-entry.js");
    fs.writeFileSync(workerEntry, "console.log('worker entry')\n", "utf-8");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = workerEntry;
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    server = createServer(0, undefined, undefined, false);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 无任何 LLM setting：即使 host shell 可用，readiness 也必须阻塞，
    // 否则新手向导会错误地跳过主模型配置（偶发"自动完成"的根因）。
    const response = await fetch(`${baseUrl}/api/manager-agent/readiness`);
    const body = await response.json() as {
      data: { ready: boolean; blockers: Array<{ code: string }> };
    };
    expect(body.data.ready).toBe(false);
    expect(body.data.blockers.map((item) => item.code)).toEqual(["manager_config_invalid"]);
  });

  it("probes Docker workspace bind mount on demand", async () => {
    const fakeNode = registerFakeDockerNode();
    server = createServer(0);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/dag/docker-workspace-probe`, {
      method: "POST",
    });
    const body = await response.json() as {
      success: boolean;
      data: {
        available: boolean;
        host_path: string;
        probe_path: string;
        node_id: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.available).toBe(true);
    expect(body.data.node_id).toBe(fakeNode.node.node_id);
    expect(body.data.host_path).toBe(path.join(tmpHome, "workspace"));
    expect(body.data.probe_path).toBe(path.join(tmpHome, "workspace"));
    expect(fakeNode.requests.map((request) => `${request.resource_type}:${request.operation}`)).toEqual([
      "container:create",
      "container:remove",
    ]);
    expect(fakeNode.requests[0]?.spec.mounts).toEqual([{
      host: path.join(tmpHome, "workspace"),
      container: "/workspace",
      mode: "rw",
    }]);
    await fakeNode.close();
  });

  it("checks host prerequisites for Claude SDK", async () => {
    const workerEntry = path.join(tmpHome, "worker-entry.js");
    fs.writeFileSync(workerEntry, "console.log('worker entry')\n", "utf-8");
    process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY = workerEntry;
    process.env.HOMERAIL_MANAGER_AGENT_SHELL = process.platform === "win32" ? process.execPath : "/bin/sh";
    // host_shell 就绪还需要 Claude 凭证（见 claude_auth_missing 门禁）
    process.env.ANTHROPIC_API_KEY = "sk-ant-readiness-test";

    server = createServer(0, undefined, undefined, false);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "https://qwen.example/anthropic",
      anthropic_base_url: "https://qwen.example/anthropic",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_coding",
      model_name: "qwen3.6",
      api_key: "pk-test-readiness",
      protocol: "anthropic_compatible",
      base_url: "https://qwen.example/anthropic",
      anthropic_base_url: "https://qwen.example/anthropic",
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
    expect(saved.status).toBe(200);

    const response = await fetch(`${baseUrl}/api/manager-agent/readiness`);
    const body = await response.json() as {
      data: {
        ready: boolean;
        runtime_placement: string;
        blockers: unknown[];
        checks: {
          docker_node?: unknown;
          host_shell?: { required: boolean; available: boolean; worker_entry?: string };
        };
      };
    };

    expect(body.data.ready).toBe(true);
    expect(body.data.runtime_placement).toBe("host_shell");
    expect(body.data.blockers).toEqual([]);
    expect(body.data.checks.docker_node).toBeUndefined();
    expect(body.data.checks.host_shell).toMatchObject({
      required: true,
      available: true,
      worker_entry: workerEntry,
    });
  });

  it("reports DAG resource preparation status in readiness", async () => {
    writeDagResourceStatus(tmpHome, "building");
    server = createServer(0, undefined, undefined, false);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/manager-agent/readiness`);
    const body = await response.json() as {
      data: {
        checks: {
          dag_resources?: {
            revision?: number;
            docker?: { status: string };
            images?: unknown[];
            workers?: unknown[];
            worker_image: { status: string; image: string; message: string };
          };
        };
      };
    };

    expect(body.data.checks.dag_resources).toMatchObject({
      revision: 42,
      docker: { status: "ready" },
      images: [],
      workers: [],
    });
    expect(body.data.checks.dag_resources?.worker_image).toMatchObject({
      status: "building",
      image: "homerail-worker:latest",
      message: "Building test worker image",
    });
  });

  it("returns a temporary-unavailable hint when DAG resources are still preparing", async () => {
    writeDagResourceStatus(tmpHome, "building");
    server = createServer(0, undefined, undefined, false);
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/runs/create-and-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yamlPath: "assets/orchestrations/simple-demo.yaml" }),
    });
    const body = await response.json() as { message: string; data?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.message).toContain("DAG 资源正在准备");
    expect(body.data?.code).toBe("dag_resources_preparing");
  });

  it("does not silently run with unknown or stale DAG resources", async () => {
    writeDagResourceStatus(tmpHome, "unknown");
    server = createServer(0, undefined, undefined, false);
    const port = await listen(server);

    const unknownResponse = await fetch(`http://127.0.0.1:${port}/api/runs/create-and-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yamlPath: "assets/orchestrations/simple-demo.yaml" }),
    });
    const unknownBody = await unknownResponse.json() as {
      message: string;
      data?: {
        code?: string;
        dag_resources?: { worker_image?: { status?: string } };
      };
    };

    expect(unknownResponse.status).toBe(503);
    expect(unknownBody.message).toContain("尚未确认 DAG 资源是否就绪");
    expect(unknownBody.data?.code).toBe("dag_resources_unavailable");
    expect(unknownBody.data?.dag_resources?.worker_image?.status).toBe("unknown");

    writeDagResourceStatus(tmpHome, "ready", "stale");
    const staleResponse = await fetch(`http://127.0.0.1:${port}/api/runs/create-and-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yamlPath: "assets/orchestrations/simple-demo.yaml" }),
    });
    const staleBody = await staleResponse.json() as {
      data?: {
        code?: string;
        dag_resources?: {
          worker_image?: {
            status?: string;
            reason_code?: string;
            compatibility?: string;
          };
        };
      };
    };

    expect(staleResponse.status).toBe(503);
    expect(staleBody.data?.code).toBe("dag_resources_unavailable");
    expect(staleBody.data?.dag_resources?.worker_image).toMatchObject({
      status: "ready",
      reason_code: "worker_image_stale",
      compatibility: "stale",
    });
  });
});

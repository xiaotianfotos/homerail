import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/server/http.js";
import { _clearAllSettings, createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { clearManagerAgentConfig } from "../src/persistence/manager-agent-config.js";
import { _clearNodes } from "../src/node/registry.js";
import { registerFakeDockerNode } from "./helpers/fake-docker-node.js";

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

function writeDagResourceStatus(home: string, status: "building" | "ready" | "error"): void {
  const dir = path.join(home, "runtime");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dag-resources.json"), JSON.stringify({
    worker_image: {
      status,
      image: "homerail-worker:latest",
      message: status === "building" ? "Building test worker image" : "Worker image test status",
      updated_at: Date.now(),
      error: status === "error" ? "test build failed" : undefined,
    },
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

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldLocalNodeAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    oldHostEntry = process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    oldHostShell = process.env.HOMERAIL_MANAGER_AGENT_SHELL;
    oldRepoRoot = process.env.HOMERAIL_REPO_ROOT;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-agent-readiness-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    delete process.env.HOMERAIL_MANAGER_AGENT_HOST_ENTRY;
    delete process.env.HOMERAIL_MANAGER_AGENT_SHELL;
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
      required: true,
      host_path: path.join(tmpHome, "workspace"),
      probe_endpoint: "/api/dag/docker-workspace-probe",
    });
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
          dag_resources?: { worker_image: { status: string; image: string; message: string } };
        };
      };
    };

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
});

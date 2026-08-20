import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { listCodexModels, type CodexModelCatalog } from "../src/server/codex-models.js";
import { MANAGER_RUNTIME_VERSION } from "../src/runtime-version.js";
import { managerAgentConfigRoutesHandler } from "../src/server/manager-agent-config.js";
import {
  clearManagerAgentConfig,
  saveManagerAgentConfig,
} from "../src/persistence/manager-agent-config.js";
import {
  _clearAllSettings,
  createSetting,
} from "../src/persistence/llm-settings.js";

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  clearManagerAgentConfig();
  _clearAllSettings();
});

describe("Codex model catalog", () => {
  it("loads visible models through app-server without showing a Windows console", async () => {
    const child = new FakeChildProcess();
    const requests: Array<Record<string, unknown>> = [];
    let spawnOptions: Record<string, unknown> | undefined;
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      requests.push(request);
      if (request.id === 1) {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
      } else if (request.id === 2) {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            data: [
              {
                id: "gpt-5.6-sol",
                model: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                description: "Latest Codex model",
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium", description: "Balanced reasoning" },
                  { reasoningEffort: "high", description: "Deeper reasoning" },
                ],
                serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
              },
              {
                id: "gpt-5.6-sol-duplicate",
                model: "gpt-5.6-sol",
                displayName: "Duplicate Sol",
              },
              { id: "hidden-model", model: "hidden-model", hidden: true },
            ],
            nextCursor: "page-2",
          },
        })}\n`);
      } else if (request.id === 3) {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            data: [{
              id: "gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              hidden: false,
            }],
          },
        })}\n`);
      }
    });

    const catalog = await listCodexModels({
      resolution: {
        command: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
        requested: "codex",
        needsShell: false,
      },
      spawnImpl: ((_command, _args, options) => {
        spawnOptions = options as Record<string, unknown>;
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as typeof spawn,
      timeoutMs: 1_000,
    });

    expect(requests.map((request) => request.method)).toEqual(["initialize", "model/list", "model/list"]);
    expect(requests[0]).toMatchObject({
      params: {
        clientInfo: {
          version: MANAGER_RUNTIME_VERSION,
        },
      },
    });
    expect(requests[1]).toMatchObject({
      params: { limit: 100, includeHidden: false },
    });
    expect(requests[2]).toMatchObject({
      params: { limit: 100, includeHidden: false, cursor: "page-2" },
    });
    expect(spawnOptions).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(catalog).toEqual({
      binary: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
      models: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          description: "Latest Codex model",
          is_default: true,
          default_reasoning_effort: "medium",
          supported_reasoning_efforts: ["medium", "high"],
          reasoning_effort_options: [
            { reasoning_effort: "medium", description: "Balanced reasoning" },
            { reasoning_effort: "high", description: "Deeper reasoning" },
          ],
          service_tiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
        },
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "",
          is_default: false,
          default_reasoning_effort: "",
          supported_reasoning_efforts: [],
          reasoning_effort_options: [],
          service_tiers: [],
        },
      ],
    });
  });

  it("enriches a GUI-style minimal PATH before loading models from a Node-backed shim", async () => {
    const child = new FakeChildProcess();
    const command = "/Users/Alice Smith/.nvm/versions/node/v22/bin/codex";
    let spawnOptions: Record<string, unknown> | undefined;
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
      if (request.id === 1) {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
      } else if (request.id === 2) {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { data: [] },
        })}\n`);
      }
    });

    await expect(listCodexModels({
      resolution: {
        command,
        requested: "codex",
        needsShell: false,
      },
      env: { PATH: "/usr/bin:/bin" },
      spawnImpl: ((_command, _args, options) => {
        spawnOptions = options as Record<string, unknown>;
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as typeof spawn,
      timeoutMs: 1_000,
    })).resolves.toEqual({
      binary: command,
      models: [],
    });

    expect(spawnOptions).toMatchObject({
      env: expect.objectContaining({
        PATH: Array.from(new Set([
          path.dirname(command),
          path.dirname(process.execPath),
          ..."/usr/bin:/bin".split(path.delimiter),
        ])).join(path.delimiter),
      }),
    });
  });

  it("reports a successful app-server exit without a model catalog clearly", async () => {
    const child = new FakeChildProcess();
    child.stdin.on("data", () => child.emit("exit", 0, null));

    await expect(listCodexModels({
      resolution: {
        command: "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
        requested: "codex",
        needsShell: false,
      },
      spawnImpl: (() => child as unknown as ChildProcessWithoutNullStreams) as typeof spawn,
      timeoutMs: 1_000,
    })).rejects.toThrow("Codex app-server exited without returning a model catalog");
  });

  it("contains an app-server stdin EPIPE instead of crashing the Manager", async () => {
    const child = new FakeChildProcess();
    child.stdin.on("data", () => {
      child.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    await expect(listCodexModels({
      resolution: {
        command: "/home/test/.nvm/versions/node/v24/bin/codex",
        requested: "codex",
        needsShell: false,
      },
      spawnImpl: (() => child as unknown as ChildProcessWithoutNullStreams) as typeof spawn,
      timeoutMs: 1_000,
    })).rejects.toThrow("write EPIPE");
  });

  it("serves the model catalog from the Manager Agent API", async () => {
    const catalog: CodexModelCatalog = {
      binary: "C:\\Codex\\codex.exe",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        description: "Latest Codex model",
        is_default: true,
        default_reasoning_effort: "medium",
        supported_reasoning_efforts: ["medium"],
        service_tiers: [],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/codex-models`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: catalog });
  });

  it("rejects unsupported Codex reasoning efforts before saving Manager Agent config", async () => {
    const catalog: CodexModelCatalog = {
      binary: "C:\\Codex\\codex.exe",
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
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "minimal" }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Codex model 'gpt-5.5' does not support reasoning effort 'minimal'. Supported values: low, medium, high, xhigh.",
    });
  });

  it("rejects a reasoning effort that the selected Codex model does not advertise", async () => {
    const catalog: CodexModelCatalog = {
      binary: "C:\\Codex\\codex.exe",
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
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "max" }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Codex model 'gpt-5.5' does not support reasoning effort 'max'. Supported values: low, medium, high, xhigh.",
    });
  });

  it("accepts Sol ultra reasoning and OpenAI's priority service tier", async () => {
    const catalog: CodexModelCatalog = {
      binary: "C:\\Codex\\codex.exe",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "low",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "ultra",
        service_tier: "priority",
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        model_name: "gpt-5.6-sol",
        reasoning_effort: "ultra",
        service_tier: "priority",
      },
    });
  });

  it.each([null, ""])(
    "treats an explicit %j Codex reasoning effort as absent",
    async (reasoningEffort) => {
      const catalog: CodexModelCatalog = {
        binary: "/opt/homebrew/bin/codex",
        models: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          description: "",
          is_default: true,
          default_reasoning_effort: "low",
          supported_reasoning_efforts: ["low", "high"],
          service_tiers: [],
        }],
      };
      server = http.createServer((req, res) => {
        managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const configured = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          harness: "codex_appserver",
          model_name: "gpt-5.6-sol",
          reasoning_effort: "high",
        }),
      });
      expect(configured.status).toBe(200);

      const response = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoning_effort: reasoningEffort }),
      });
      const body = await response.json() as { data?: { reasoning_effort?: string } };

      expect(response.status).toBe(200);
      expect(body.data?.reasoning_effort).toBe("high");
    },
  );

  it("rejects an unknown provider setting instead of replacing an active subscription Codex model", async () => {
    const catalog: CodexModelCatalog = {
      binary: "/opt/homebrew/bin/codex",
      models: [{
        id: "gpt-5.6-terra",
        model: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        description: "",
        is_default: true,
        default_reasoning_effort: "medium",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        service_tiers: [],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const configured = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-terra",
        reasoning_effort: "high",
        service_tier: null,
      }),
    });
    expect(configured.status).toBe(200);

    const stalePatch = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm_setting_id: "local-default",
        provider_name: "kimi",
        model_name: "kimi-k2.7-code",
      }),
    });
    const body = await stalePatch.json() as { error?: string };

    expect(stalePatch.status).toBe(400);
    expect(body.error).toContain("Active Manager LLM setting not found");
  });

  it("honors an explicit subscription model when switching from a provider-backed harness", async () => {
    const setting = createSetting({
      provider_id: "deepseek",
      endpoint_id: "deepseek_api",
      model_name: "deepseek-v4-flash",
      api_key: "sk-test-deepseek",
      is_active: true,
      is_default: true,
    });
    saveManagerAgentConfig({
      harness: "claude_agent_sdk",
      llm_setting_id: setting.id,
      provider_name: "deepseek",
      model_name: "deepseek-v4-flash",
    });
    const catalog: CodexModelCatalog = {
      binary: "/opt/homebrew/bin/codex",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "high",
        supported_reasoning_efforts: ["low", "high", "max"],
        service_tiers: [],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "high",
      }),
    });
    const body = await response.json() as { data?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "codex_appserver",
      llm_setting_id: null,
      provider_name: null,
      model_name: "gpt-5.6-sol",
      reasoning_effort: "high",
    });
  });

  it("uses the provider profile reasoning default when switching with an explicit setting", async () => {
    const setting = createSetting({
      provider_id: "deepseek",
      endpoint_id: "deepseek_api",
      model_name: "deepseek-v4-flash",
      api_key: "sk-test-deepseek",
      is_active: true,
      is_default: true,
    });
    saveManagerAgentConfig({
      harness: "claude_agent_sdk",
      llm_setting_id: setting.id,
      provider_name: "deepseek",
      model_name: "deepseek-v4-flash",
      reasoning_effort: "low",
    });
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        llm_setting_id: setting.id,
        provider_name: "deepseek",
        model_name: "deepseek-v4-flash",
      }),
    });
    const body = await response.json() as { data?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      llm_setting_id: setting.id,
      provider_name: "deepseek",
      model_name: "deepseek-v4-flash",
      reasoning_effort: "high",
    });
  });

  it("rejects service tiers not advertised by the selected model", async () => {
    const catalog: CodexModelCatalog = {
      binary: "C:\\Codex\\codex.exe",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "low",
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, { loadCodexModels: async () => catalog });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "low",
        service_tier: "flex",
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Codex model 'gpt-5.6-sol' does not support service tier 'flex'. Supported values: standard, priority.",
    });
  });

  it("persists the Live Voice preference only when Codex capability is supported", async () => {
    const catalog: CodexModelCatalog = {
      binary: "/opt/homebrew/bin/codex",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "low",
        supported_reasoning_efforts: ["low"],
        service_tiers: [],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, {
        loadCodexModels: async () => catalog,
        loadCodexLiveVoiceCapability: () => ({
          supported: true,
          minimum_version: "0.145.0",
          protocol: "v3",
          transport: "webrtc",
          feature: "realtime_conversation",
          stage: "under development",
        }),
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        live_voice_enabled: true,
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        harness: "codex_appserver",
        live_voice_enabled: true,
      },
    });
  });

  it("rejects Live Voice for provider-backed Codex Responses runtimes", async () => {
    const setting = createSetting({
      provider_id: "deepseek",
      endpoint_id: "deepseek_api",
      model_name: "deepseek-v4-flash",
      api_key: "sk-test-deepseek",
      is_active: true,
      is_default: true,
    });
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, {
        loadCodexLiveVoiceCapability: () => ({
          supported: true,
          minimum_version: "0.145.0",
          protocol: "v3",
          transport: "webrtc",
          feature: "realtime_conversation",
          stage: "under development",
        }),
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        llm_setting_id: setting.id,
        provider_name: setting.provider_id,
        model_name: setting.model_name,
        live_voice_enabled: true,
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Live Voice is not supported for provider-backed Codex Responses runtimes. Disable Live Voice or use subscription Codex.",
    });
  });

  it("can enable Live Voice while logged out once the Codex model selection is already saved", async () => {
    const catalog: CodexModelCatalog = {
      binary: "/opt/homebrew/bin/codex",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "low",
        supported_reasoning_efforts: ["low"],
        service_tiers: [],
      }],
    };
    let catalogAvailable = true;
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, {
        loadCodexModels: async () => {
          if (!catalogAvailable) throw new Error("Codex account is logged out");
          return catalog;
        },
        loadCodexLiveVoiceCapability: () => ({
          supported: true,
          minimum_version: "0.145.0",
          protocol: "v3",
          transport: "webrtc",
          feature: "realtime_conversation",
          stage: "under development",
        }),
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const configured = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "low",
      }),
    });
    expect(configured.status).toBe(200);

    catalogAvailable = false;
    const response = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live_voice_enabled: true }),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        harness: "codex_appserver",
        live_voice_enabled: true,
      },
    });
  });

  it("rejects enabling Live Voice on an unsupported Codex without overwriting the preference", async () => {
    const catalog: CodexModelCatalog = {
      binary: "/opt/homebrew/bin/codex",
      models: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        description: "",
        is_default: true,
        default_reasoning_effort: "low",
        supported_reasoning_efforts: ["low"],
        service_tiers: [],
      }],
    };
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res, {
        loadCodexModels: async () => catalog,
        loadCodexLiveVoiceCapability: () => ({
          supported: false,
          minimum_version: "0.145.0",
          protocol: "v3",
          transport: "webrtc",
          feature: "realtime_conversation",
          reason: "too_old",
        }),
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.6-sol",
        live_voice_enabled: true,
      }),
    });
    expect(response.status).toBe(400);

    const saved = await fetch(`${baseUrl}/api/manager-agent/config`);
    const body = await saved.json() as { data: { live_voice_enabled: boolean } };
    expect(body.data.live_voice_enabled).toBe(false);
  });

  it("rejects Live Voice for a non-Codex Manager harness", async () => {
    server = http.createServer((req, res) => {
      managerAgentConfigRoutesHandler(req, res);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "claude_agent_sdk",
        live_voice_enabled: true,
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Live Voice requires the Codex app-server Manager runtime.",
    });
  });
});

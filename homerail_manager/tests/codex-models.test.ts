import { EventEmitter } from "node:events";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { listCodexModels, type CodexModelCatalog } from "../src/server/codex-models.js";
import { managerAgentConfigRoutesHandler } from "../src/server/manager-agent-config.js";

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
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
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

  it("does not let a stale provider-model patch replace an active Codex model", async () => {
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
    const body = await stalePatch.json() as { data: Record<string, unknown> };

    expect(stalePatch.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "codex_appserver",
      llm_setting_id: null,
      provider_name: null,
      model_name: "gpt-5.6-terra",
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
});

/**
 * Tests for agent factory and adapter internals.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES } from "homerail-protocol";
import {
  createAgentClient,
  registerAgentBackend,
  workerProductionAgentBackendNamesForTest,
} from "../agent/factory.js";
import { resolveWorkerAgentBackend } from "../agent/backend-selection.js";
import { ClaudeSdkAdapter } from "../agent/claude-sdk.js";
import { KimiCodeAdapter } from "../agent/kimi-code.js";
import { CodexAppServerAdapter } from "../agent/codex-appserver.js";
import { DeepSeekHarnessAdapter } from "../agent/deepseek-harness.js";
import { DeterministicClient } from "../agent/deterministic.js";
import { ManagerAgentSmokeClient } from "../agent/manager-agent-smoke.js";
import type { AgentClient, AgentEvent, DagToolDefinition } from "../agent/types.js";

describe("agent factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates claude-sdk by default", () => {
    const client = createAgentClient();
    expect(client).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it("does not expose direct-llm as a public backend", () => {
    expect(() => createAgentClient("direct-llm")).toThrow("Unknown agent backend");
    expect(() => createAgentClient("direct_llm")).toThrow("Unknown agent backend");
  });

  it("creates claude-sdk backend", () => {
    const client = createAgentClient("claude-sdk");
    expect(client).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it("creates claude-sdk backend from claude aliases", () => {
    expect(createAgentClient("claude")).toBeInstanceOf(ClaudeSdkAdapter);
    expect(createAgentClient("claude-agent-sdk")).toBeInstanceOf(ClaudeSdkAdapter);
  });

  it("honors AGENT_BACKEND deterministic override for harnesses", () => {
    vi.stubEnv("AGENT_BACKEND", "deterministic");
    const client = createAgentClient();
    expect(client).toBeInstanceOf(DeterministicClient);
  });

  it("creates codex backend", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createAgentClient("codex");
    expect(client).toBeInstanceOf(CodexAppServerAdapter);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("codex backend is deprecated"),
    );
    warnSpy.mockRestore();
  });

  it("creates codex_appserver backend", () => {
    const client = createAgentClient("codex_appserver");
    expect(client).toBeInstanceOf(CodexAppServerAdapter);
  });

  it("codex_appserver appears in available backends error", () => {
    expect(() => createAgentClient("unknown")).toThrow(/codex_appserver/);
  });

  it("creates kimi_code backend", () => {
    const client = createAgentClient("kimi_code");
    expect(client).toBeInstanceOf(KimiCodeAdapter);
  });

  it("creates DeepSeek Harness backend from public aliases", () => {
    expect(createAgentClient("deepseek_harness")).toBeInstanceOf(DeepSeekHarnessAdapter);
    expect(createAgentClient("deepseek-harness")).toBeInstanceOf(DeepSeekHarnessAdapter);
    expect(createAgentClient("dsh")).toBeInstanceOf(DeepSeekHarnessAdapter);
  });

  it("creates Kimi Code backend from public aliases", () => {
    expect(createAgentClient("kimi-code")).toBeInstanceOf(KimiCodeAdapter);
    expect(createAgentClient("kimi")).toBeInstanceOf(KimiCodeAdapter);
  });

  it("keeps manager-agent smoke backend disabled unless explicitly enabled", () => {
    expect(() => createAgentClient("manager-agent-smoke")).toThrow("Unknown agent backend");
  });

  it("creates manager-agent smoke backend only for release smoke", () => {
    vi.stubEnv("HOMERAIL_MANAGER_AGENT_SMOKE", "1");
    expect(createAgentClient("manager-agent-smoke")).toBeInstanceOf(ManagerAgentSmokeClient);
  });

  it("throws on unknown backend", () => {
    expect(() => createAgentClient("unknown")).toThrow("Unknown agent backend");
  });

  it("keeps worker production backends synced with protocol production agent types", () => {
    expect(new Set(workerProductionAgentBackendNamesForTest())).toEqual(
      new Set(MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES),
    );
    expect(workerProductionAgentBackendNamesForTest()).not.toContain("deterministic");
    expect(workerProductionAgentBackendNamesForTest()).not.toContain("manager-agent-smoke");
  });

  it("supports custom registration", () => {
    const mock: AgentClient = {
      run() {
        return (async function* () {
          yield { type: "done" } as AgentEvent;
        })();
      },
    };
    registerAgentBackend("test-backend", () => mock);
    const client = createAgentClient("test-backend");
    expect(client).toBe(mock);
  });
});

describe("worker backend selection", () => {
  it("uses Manager envelope agent_type instead of AGENT_BACKEND", () => {
    expect(resolveWorkerAgentBackend({
      agentType: "kimi-code",
      envBackend: "claude-sdk",
      hasManagerEnvelope: true,
    })).toBe("kimi_code");
  });

  it("keeps AGENT_BACKEND as a legacy fallback without a Manager envelope", () => {
    expect(resolveWorkerAgentBackend({
      agentType: undefined,
      envBackend: "deterministic",
      hasManagerEnvelope: false,
    })).toBe("deterministic");
  });
});

describe("DeterministicClient", () => {
  it("parses HANDOFF directives from systemPrompt when task input is wrapped", async () => {
    const client = new DeterministicClient();
    const calls: unknown[] = [];
    const handoffTool: DagToolDefinition = {
      name: "handoff",
      description: "handoff",
      input_schema: { type: "object" },
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const events: AgentEvent[] = [];
    for await (const event of client.run(
      "Initial user task wrapper",
      [handoffTool],
      {
        model: "deterministic",
        apiKey: "",
        baseUrl: "",
        systemPrompt: "  HANDOFF port=done content=Source Issue: #847\n\nArtifact: ok",
      },
    )) {
      events.push(event);
    }

    expect(calls).toEqual([
      { port: "done", content: "Source Issue: #847\n\nArtifact: ok" },
    ]);
    expect(events.some((event) => event.type === "tool_use")).toBe(true);
  });

  it("ignores legacy MANAGER_COMMAND directives and only runs HANDOFF", async () => {
    const client = new DeterministicClient();
    const calls: string[] = [];
    const managerTool: DagToolDefinition = {
      name: "manager_command",
      description: "manager command",
      input_schema: { type: "object" },
      handler: async () => {
        calls.push("manager");
        return { content: [{ type: "text", text: "manager ok" }] };
      },
    };
    const handoffTool: DagToolDefinition = {
      name: "handoff",
      description: "handoff",
      input_schema: { type: "object" },
      handler: async (args) => {
        calls.push(`handoff:${args.port}`);
        return { content: [{ type: "text", text: "handoff ok" }] };
      },
    };

    const events: AgentEvent[] = [];
    for await (const event of client.run(
      "Initial task",
      [managerTool, handoffTool],
      {
        provider: "xiaomi",
        model: "deterministic",
        apiKey: "",
        baseUrl: "",
        systemPrompt: [
          "MANAGER_COMMAND append_node node=dynamic_observer after=producer content=Source Issue: #863 Artifact: observer.",
          "HANDOFF port=done content=Source Issue: #863\n\nArtifact: producer.",
        ].join("\n"),
      },
    )) {
      events.push(event);
    }

    expect(calls).toEqual(["handoff:done"]);
    expect(events.filter((event) => event.type === "tool_use").map((event) => (event as any).name)).toEqual([
      "handoff",
    ]);
  });
});

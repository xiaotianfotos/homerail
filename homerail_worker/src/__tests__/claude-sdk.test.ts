/**
 * Tests for Claude SDK adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";
import {
  jsonSchemaObjectToZodRawShape,
  normalizeJsonObjectStringsBySchema,
} from "../agent/json-schema-zod.js";

type TestZodParser = { parse: (value: unknown) => unknown };

// Build a fake SDK module matching the adapter's SdkModule interface
function makeFakeSdk(events: Array<Record<string, unknown>> = []) {
  return {
    async *query(_params: { prompt: unknown; options?: Record<string, unknown> }) {
      for (const ev of events) yield ev;
    },
    createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
      return { type: "sdk", name: _opts.name };
    },
    tool(
      name: string,
      description: string,
      _inputSchema: Record<string, unknown>,
      _handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
    ) {
      return { name, description, inputSchema: _inputSchema, handler: _handler };
    },
  };
}

describe("ClaudeSdkAdapter", () => {
  const ctx: AgentRunContext = {
    model: "claude-sonnet-4-20250514",
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
    maxIterations: 3,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("emits thinking, text, tool_use, tool_result from assistant message", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () =>
      makeFakeSdk([
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "Let me reason..." },
              { type: "text", text: "I will use echo." },
              { type: "tool_use", id: "call-1", name: "echo", input: { msg: "hi" } },
              { type: "tool_result", id: "call-1", text: "echo: hi" },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false },
      ]),
    );

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("thinking");
    expect(types).toContain("text");
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types.at(-1)).toBe("done");
    expect(events.filter((e) => e.type === "debug").map((e) => e.message)).toEqual([
      "mcp_server_not_registered",
      "query_start",
      "sdk_message",
      "sdk_message",
      "query_done",
    ]);
  });

  it("maps MCP tool results carried by SDK user messages", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () =>
      makeFakeSdk([
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-2",
                content: [{ type: "text", text: "invalid view" }],
                is_error: true,
              },
            ],
          },
        },
        { type: "result", subtype: "success", is_error: false },
      ]),
    );

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("test", [], ctx)) events.push(event);

    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-2",
      content: JSON.stringify([{ type: "text", text: "invalid view" }]),
      is_error: true,
    });
  });

  it("handles SDK not installed gracefully", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      throw new Error("Cannot find module");
    });

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("not available");
    expect(events[events.length - 1].type).toBe("done");
  });

  it("rejects non-Anthropic protocols before using the Claude SDK", async () => {
    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], { ...ctx, protocol: "openai_compatible" })) {
      events.push(e);
    }

    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Anthropic-compatible endpoint"),
    });
    expect(events[events.length - 1].type).toBe("done");
  });

  it("maps SDK error during query execution", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query(params: { options?: { stderr?: (data: string) => void } }) {
        params.options?.stderr?.("stderr before failure\n");
        throw new Error("429 rate limit exceeded");
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    expect((error as { message: string }).message).toContain("Rate limited");
    const queryError = events.find((e) => e.type === "debug" && e.message === "query_error");
    expect(queryError).toBeTruthy();
    expect(queryError).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ stderr_tail: expect.stringContaining("stderr before failure") }),
    });
    expect(events[events.length - 1].type).toBe("done");
  });

  it("maps Claude SDK transport EPIPE into an agent error", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query() {
        const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        err.stack = "Error: write EPIPE\n    at ProcessTransport.write (node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:1:1)";
        setTimeout(() => {
          process.emit("uncaughtException", err);
        }, 0);
        await new Promise(() => {});
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      type: "error",
      message: expect.stringContaining("Claude SDK transport error"),
    });
    expect(events[events.length - 1].type).toBe("done");
  });

  it("maps non-success SDK result subtypes to agent errors", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () =>
      makeFakeSdk([
        { type: "result", subtype: "error_max_turns", is_error: false, num_turns: 20 },
      ]),
    );

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({
      type: "error",
      message: expect.stringContaining("error_max_turns"),
    });
    expect(events[events.length - 1].type).toBe("done");
  });

  it("emits Claude Code stderr telemetry between SDK messages", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: { stderr?: (data: string) => void } }) {
        params.options?.stderr?.("mcp warning: failed to list tools\n");
        yield { type: "system", subtype: "init" };
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    const stderr = events.find((event) => event.type === "debug" && event.message === "claude_code_stderr");
    expect(stderr).toBeTruthy();
    expect(stderr).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ tail: expect.stringContaining("mcp warning") }),
    });
  });

  it("handles stream_event with content blocks", async () => {
    vi.doMock("@anthropic-ai/claude-agent-sdk", () =>
      makeFakeSdk([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            content_block: { type: "text", text: "streaming text" },
          },
        },
        {
          type: "stream_event",
          event: { type: "content_block_stop" },
        },
        { type: "result", subtype: "success", is_error: false },
      ]),
    );

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    expect(events.map((e) => e.type)).toEqual([
      "debug",
      "debug",
      "debug",
      "text",
      "debug",
      "turn_complete",
      "debug",
      "debug",
      "done",
    ]);
  });

  it("does not pass maxTurns to Claude SDK unless explicitly configured", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    expect((adapter as unknown as { maxTurns: number | null }).maxTurns).toBeNull();
    expect(captured[0]).not.toHaveProperty("maxTurns");
    const queryStart = events.find((event) => event.type === "debug" && event.message === "query_start");
    expect(queryStart).toMatchObject({
      type: "debug",
      data: expect.objectContaining({
        max_turns: null,
        max_turns_source: "unset",
      }),
    });
  });

  it("supports explicit custom prompt replacement and isolates Claude SDK settings", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("test", [], {
      ...ctx,
      systemPrompt: "HomeRail DAG contract",
      systemPromptMode: "replace",
    })) {
      events.push(event);
    }

    expect(captured[0].systemPrompt).toBe("HomeRail DAG contract");
    expect(captured[0].settingSources).toEqual([]);
    expect(captured[0].strictMcpConfig).toBe(true);
    expect(events.find((event) => event.type === "debug" && event.message === "query_start")).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ system_prompt_mode: "replace" }),
    });
  });

  it("appends HomeRail instructions to the Claude Code system prompt preset by default", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("test", [], {
      ...ctx,
      systemPrompt: "HomeRail Manager contract",
    })) {
      events.push(event);
    }

    expect(captured[0].systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "HomeRail Manager contract",
    });
    expect(events.find((event) => event.type === "debug" && event.message === "query_start")).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ system_prompt_mode: "append" }),
    });
  });

  it("respects env vars", async () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-opus-4-20250514");
    vi.stubEnv("CLAUDE_THINKING_BUDGET", "32000");
    vi.stubEnv("CLAUDE_MAX_TURNS", "10");
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    expect((adapter as unknown as { model: string }).model).toBe("claude-opus-4-20250514");
    expect((adapter as unknown as { thinkingBudget: number }).thinkingBudget).toBe(32000);
    expect((adapter as unknown as { maxTurns: number }).maxTurns).toBe(10);
    expect(captured[0].maxTurns).toBe(10);
    const queryStart = events.find((event) => event.type === "debug" && event.message === "query_start");
    expect(queryStart).toMatchObject({
      type: "debug",
      data: expect.objectContaining({
        max_turns: 10,
        max_turns_source: "env",
      }),
    });
  });

  it("exposes optional query timeout env without enabling it by default", async () => {
    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    expect((new ClaudeSdkAdapter() as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(0);

    vi.stubEnv("CLAUDE_SDK_QUERY_TIMEOUT_MS", "1500");
    const adapter = new ClaudeSdkAdapter();
    expect((adapter as unknown as { queryTimeoutMs: number }).queryTimeoutMs).toBe(1500);
  });

  it("passes an external abort controller to the Claude SDK query", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const controller = new AbortController();
    controller.abort();
    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], { ...ctx, abortSignal: controller.signal })) {
      events.push(e);
    }

    const abortController = captured[0].abortController as AbortController;
    expect(abortController).toBeDefined();
    expect(abortController.signal.aborted).toBe(true);
    const queryStart = events.find((event) => event.type === "debug" && event.message === "query_start");
    expect(queryStart).toMatchObject({
      type: "debug",
      data: expect.objectContaining({
        external_abort_signal: true,
      }),
    });
  });

  it("passes Anthropic auth through SDK env without exposing the secret in telemetry", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], {
      ...ctx,
      apiKey: "anthropic-secret-value",
      environmentVariables: { SERVICE_TEST_TOKEN: "turn-scoped-value" },
    })) {
      events.push(e);
    }

    expect((captured[0].env as Record<string, string>).ANTHROPIC_API_KEY).toBe("anthropic-secret-value");
    expect((captured[0].env as Record<string, string>).SERVICE_TEST_TOKEN).toBe("turn-scoped-value");
    expect((captured[0].env as Record<string, string>).ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect((captured[0].env as Record<string, string>).LLM_BASE_URL).toBe("https://api.anthropic.com");
    // Claude Code internal/background model + telemetry are pinned so gateway
    // providers don't receive claude-haiku-* requests or event_logging pings.
    const capturedEnv = captured[0].env as Record<string, string>;
    expect(capturedEnv.ANTHROPIC_MODEL).toBe(ctx.model);
    expect(capturedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(ctx.model);
    expect(capturedEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe(ctx.model);
    expect(capturedEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(capturedEnv.DISABLE_TELEMETRY).toBe("1");
    expect(capturedEnv.DISABLE_ERROR_REPORTING).toBe("1");
    const queryStart = events.find((event) => event.type === "debug" && event.message === "query_start");
    expect(queryStart).toMatchObject({
      type: "debug",
      data: expect.objectContaining({
        auth_env: true,
        auth_source: "context.apiKey",
        base_url_env: true,
        base_url_source: "context.baseUrl",
      }),
    });
    expect(JSON.stringify(queryStart)).not.toContain("anthropic-secret-value");
  });

  it("pins Claude Code background model and disables telemetry for gateway providers", async () => {
    // Regression for #1148: a non-Anthropic gateway model (e.g. qwen3.6) must
    // override Claude Code's internal haiku/background model, otherwise the
    // gateway 404s on claude-haiku-* requests.
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const gatewayCtx: AgentRunContext = {
      ...ctx,
      model: "qwen3.6",
      baseUrl: "http://127.0.0.1:8080",
    };
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], gatewayCtx)) {
      events.push(e);
    }

    const env = captured[0].env as Record<string, string>;
    expect(env.ANTHROPIC_MODEL).toBe("qwen3.6");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen3.6");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("qwen3.6");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DISABLE_ERROR_REPORTING).toBe("1");
    // The query itself also uses the gateway model, not the adapter default.
    expect(captured[0].model).toBe("qwen3.6");
  });

  it("explicitly enables built-in shell and file tools for selfdev workers", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [], ctx)) {
      events.push(e);
    }

    expect(captured[0].tools).toEqual(["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"]);
    expect(captured[0].allowedTools).toEqual(["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"]);
    const queryStart = events.find((event) => event.type === "debug" && event.message === "query_start");
    expect(queryStart).toMatchObject({
      type: "debug",
      data: expect.objectContaining({
        builtin_tools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"],
      }),
    });
  });

  it("enforces a declared built-in tool allowlist", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("write once", [], {
      ...ctx,
      allowedBuiltinTools: ["Write"],
    })) {
      events.push(event);
    }

    expect(captured[0].tools).toEqual(["Write"]);
    expect(captured[0].allowedTools).toEqual(["Write"]);
    expect(events.find((event) => event.type === "debug" && event.message === "query_start")).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ builtin_tools: ["Write"], handoff_only: false }),
    });
  });

  it("disables all built-in tools during handoff-only correction turns", async () => {
    const captured: Record<string, unknown>[] = [];
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        captured.push(params.options ?? {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(name: string) {
        return { name };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("correct", [], {
      ...ctx,
      handoffOnly: true,
      allowedBuiltinTools: ["Write"],
    })) {
      events.push(event);
    }

    expect(captured[0].tools).toEqual([]);
    expect(captured[0].allowedTools).toEqual([]);
    expect(captured[0].maxThinkingTokens).toBe(2048);
    expect(events.find((event) => event.type === "debug" && event.message === "query_start")).toMatchObject({
      type: "debug",
      data: expect.objectContaining({ builtin_tools: [], handoff_only: true, thinking_budget: 2048 }),
    });
  });

  it("fails explicitly when transcript resume is requested", async () => {
    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    await expect(adapter.resume!("session-1")).rejects.toThrow("transcript resume is not implemented");
  });

  it("registers DAG tools as MCP server", async () => {
    const toolDef: DagToolDefinition = {
      name: "handoff",
      description: "handoff tool",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
      const fake = makeFakeSdk([
        { type: "result", subtype: "success", is_error: false },
      ]);
      // Spy on createSdkMcpServer
      return {
        ...fake,
        createSdkMcpServer: vi.fn(fake.createSdkMcpServer),
        tool: vi.fn(fake.tool),
      };
    });

    const sdkMod = await import("@anthropic-ai/claude-agent-sdk");
    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();

    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [toolDef], ctx)) {
      events.push(e);
    }

    expect(vi.mocked(sdkMod.createSdkMcpServer)).toHaveBeenCalled();
    expect(vi.mocked(sdkMod.tool)).toHaveBeenCalled();
    expect(events.some((e) => e.type === "debug" && e.message === "mcp_server_registered")).toBe(true);
  });

  it("stops a provider stream after a successful terminal handoff", async () => {
    let capturedAbortController: AbortController | undefined;
    const toolDef: DagToolDefinition = {
      name: "handoff",
      description: "handoff tool",
      input_schema: { type: "object", properties: {} },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: Record<string, unknown> }) {
        const server = (params.options?.mcpServers as Record<string, {
          tools: Array<{ handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }>;
        }>)["dag-tools"];
        await server.tools[0].handler({}, {});
        capturedAbortController = params.options?.abortController as AbortController;
        await new Promise(() => {});
      },
      createSdkMcpServer(opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: opts.name, tools: opts.tools ?? [] };
      },
      tool(
        name: string,
        description: string,
        inputSchema: Record<string, unknown>,
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
      ) {
        return { name, description, inputSchema, handler };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const event of adapter.run("test", [toolDef], ctx)) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: "debug",
      message: "query_stopped_after_handoff",
    }));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    expect(capturedAbortController?.signal.aborted).toBe(true);
  });

  it("converts DAG JSON schema to Claude SDK Zod raw shape", () => {
    const shape = jsonSchemaObjectToZodRawShape({
      type: "object",
      properties: {
        port: { type: "string", description: "output port" },
        content: { description: "any JSON payload" },
        summary: { type: "string" },
      },
      required: ["port", "content"],
    });

    const typed = shape as { port: TestZodParser; content: TestZodParser; summary: TestZodParser };
    expect(typed.port.parse("done")).toBe("done");
    expect(typed.content.parse({ ok: true })).toEqual({ ok: true });
    expect(typed.summary.parse(undefined)).toBeUndefined();
    expect(() => typed.port.parse(undefined)).toThrow();
  });

  it("resolves local object refs and decodes JSON-object strings at the SDK boundary", () => {
    const shape = jsonSchemaObjectToZodRawShape({
      type: "object",
      properties: {
        content: { $ref: "#/definitions/content" },
        a2ui: {
          type: "object",
          properties: {
            version: { type: "string" },
            catalogId: { type: "string" },
            components: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  component: { type: "string" },
                  text: { type: "string" },
                },
                required: ["id", "component"],
              },
            },
          },
          required: ["version", "catalogId", "components"],
        },
      },
      required: ["content", "a2ui"],
      definitions: {
        content: {
          type: "object",
          properties: { data: { type: "object" } },
          required: ["data"],
        },
      },
    }) as { content: TestZodParser; a2ui: TestZodParser };

    const surface = {
      version: "v1.0",
      catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
      components: [{ id: "root", component: "Text", text: "Ready" }],
    };
    expect(shape.content.parse('{"data":{"ok":true}}')).toEqual({ data: { ok: true } });
    expect(shape.a2ui.parse(JSON.stringify(surface))).toEqual(surface);
    expect(shape.a2ui.parse(JSON.stringify(JSON.stringify(surface)))).toEqual(surface);
    expect(shape.content.parse("[]")).toBe("[]");
    expect(shape.a2ui.parse("not-json")).toBe("not-json");
  });

  it("keeps exact pinned data object-only in the provider-facing schema", () => {
    const shape = jsonSchemaObjectToZodRawShape({
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            count: { type: "integer" },
            label: { type: "string" },
          },
          required: ["count"],
          additionalProperties: false,
          "x-homerail-sdk-object-only": true,
        },
      },
      required: ["data"],
    }) as { data: TestZodParser };

    expect(shape.data.parse({ count: 1, label: "Ready" })).toEqual({ count: 1, label: "Ready" });
    expect(() => shape.data.parse('{"count":1,"label":"Ready"}')).toThrow();
  });

  it("normalizes JSON-encoded nested tool objects before the DAG handler", () => {
    const schema = {
      type: "object",
      properties: {
        patch_id: { type: "string" },
        body: {
          type: "object",
          properties: {
            data: { type: "object", additionalProperties: true },
            fallback: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
          required: ["data", "fallback"],
        },
      },
      required: ["patch_id", "body"],
    };

    expect(normalizeJsonObjectStringsBySchema({
      patch_id: "p-1",
      body: JSON.stringify({
        data: { ready: true },
        fallback: JSON.stringify({ title: "Ready" }),
      }),
    }, schema)).toEqual({
      patch_id: "p-1",
      body: {
        data: { ready: true },
        fallback: { title: "Ready" },
      },
    });

    const pinnedSchema = {
      type: "object",
      properties: {
        phase: { type: "string" },
        view_id: { type: "string" },
        data: { type: "object", additionalProperties: true },
        fallback: { anyOf: [{ type: "object" }, { type: "string" }] },
        presentation_hint: { type: "object", additionalProperties: true },
      },
    };
    expect(normalizeJsonObjectStringsBySchema({
      phase: "started",
      view_id: "summary",
      data: '{"title":"Ready"},"fallback":"Ready summary"}',
      presentation_hint: { canvas_size: "1x1" },
    }, pinnedSchema)).toEqual({
      phase: "started",
      view_id: "summary",
      data: { title: "Ready" },
      fallback: "Ready summary",
      presentation_hint: { canvas_size: "1x1" },
    });

    expect(normalizeJsonObjectStringsBySchema({
      data: {
        title: "Ready",
        phase: "started",
        view_id: "summary",
        fallback: { title: "Ready summary" },
        presentation_hint: { canvas_size: "1x1" },
      },
    }, {
      ...pinnedSchema,
      required: ["phase", "view_id", "data"],
    })).toEqual({
      phase: "started",
      view_id: "summary",
      data: { title: "Ready" },
      fallback: { title: "Ready summary" },
      presentation_hint: { canvas_size: "1x1" },
    });

    expect(normalizeJsonObjectStringsBySchema({
      data: JSON.stringify({
        title: "Route ready",
        steps: [{ from: "alpha", to: "beta" }],
        phase: "final",
        view_id: "route",
        fallback: { title: "Verified route" },
      }),
      presentation_hint: { canvas_size: "1x2" },
    }, {
      ...pinnedSchema,
      required: ["phase", "view_id", "data"],
    })).toEqual({
      phase: "final",
      view_id: "route",
      data: {
        title: "Route ready",
        steps: [{ from: "alpha", to: "beta" }],
      },
      fallback: { title: "Verified route" },
      presentation_hint: { canvas_size: "1x2" },
    });
  });

  it("passes Zod tool shapes to the Claude SDK instead of raw JSON Schema", async () => {
    const capturedSchemas: Record<string, unknown>[] = [];
    const toolDef: DagToolDefinition = {
      name: "handoff",
      description: "handoff tool",
      input_schema: {
        type: "object",
        properties: {
          port: { type: "string" },
          content: { description: "payload" },
        },
        required: ["port", "content"],
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query() {
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(_opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return { type: "sdk", name: _opts.name };
      },
      tool(
        name: string,
        description: string,
        inputSchema: Record<string, unknown>,
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
      ) {
        capturedSchemas.push(inputSchema);
        return { name, description, inputSchema, handler };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("test", [toolDef], ctx)) {
      events.push(e);
    }

    expect(capturedSchemas).toHaveLength(1);
    const schema = capturedSchemas[0] as { port: TestZodParser; content: TestZodParser };
    expect(schema.port.parse("done")).toBe("done");
    expect(schema.content.parse("artifact")).toBe("artifact");
    expect(schema).not.toHaveProperty("properties");
    expect(events.some((e) => e.type === "debug" && e.message === "mcp_server_registered")).toBe(true);
  });

  it("decodes SDK-preserved and sibling-packed JSON object strings before invoking a DAG tool", async () => {
    let observedArgs: Record<string, unknown> | undefined;
    const toolDef: DagToolDefinition = {
      name: "surface_probe",
      description: "surface probe",
      input_schema: {
        type: "object",
        properties: {
          patch_id: { type: "string" },
          body: {
            type: "object",
            properties: {
              data: { type: "object", additionalProperties: true },
              fallback: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
            required: ["data", "fallback"],
          },
          fallback: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
        required: ["patch_id", "body"],
      },
      handler: async (args) => {
        observedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      async *query(params: { options?: { mcpServers?: Record<string, { tools?: Array<{ handler: Function }> }> } }) {
        const server = params.options?.mcpServers?.["dag-tools"];
        await server?.tools?.[0]?.handler({
          patch_id: "p-1",
          body: '{"data":{"ready":true},"fallback":{"title":"Nested"}},"fallback":{"title":"Ready"}}',
        }, {});
        yield { type: "result", subtype: "success", is_error: false };
      },
      createSdkMcpServer(opts: { name: string; tools?: Array<Record<string, unknown>> }) {
        return opts;
      },
      tool(
        name: string,
        description: string,
        inputSchema: Record<string, unknown>,
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
      ) {
        return { name, description, inputSchema, handler };
      },
    }));

    const { ClaudeSdkAdapter } = await import("../agent/claude-sdk.js");
    const adapter = new ClaudeSdkAdapter();
    for await (const _event of adapter.run("test", [toolDef], ctx)) {
      // Exhaust the adapter so the fake SDK invokes the registered tool.
    }

    expect(observedArgs).toEqual({
      patch_id: "p-1",
      body: {
        data: { ready: true },
        fallback: { title: "Nested" },
      },
      fallback: { title: "Ready" },
    });
  });
});

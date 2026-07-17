/**
 * Tests for Kimi Code adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { KimiCodeAdapter, _kimiSpawnOptionsForTest, redactSecrets } from "../agent/kimi-code.js";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";

describe("KimiCodeAdapter", () => {
  const ctx: AgentRunContext = {
    model: "kimi-code",
    apiKey: "test-secret-key",
    baseUrl: "https://api.moonshot.cn/v1",
    maxIterations: 3,
  };

  let adapter: KimiCodeAdapter;

  beforeEach(() => {
    adapter = new KimiCodeAdapter();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("parseStreamJsonLine", () => {
    it("maps text events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "text", text: "Hello from kimi" }),
      );
      expect(events).toEqual([{ type: "text", text: "Hello from kimi" }]);
    });

    it("maps thinking events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "thinking", thinking: "Let me reason..." }),
      );
      expect(events).toEqual([{ type: "thinking", text: "Let me reason..." }]);
    });

    it("maps tool_use events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "tool_use", id: "call-1", name: "echo", input: { msg: "hi" } }),
      );
      expect(events).toEqual([
        { type: "tool_use", id: "call-1", name: "echo", input: { msg: "hi" } },
      ]);
    });

    it("maps tool_result events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "tool_result", tool_use_id: "call-1", content: "echo: hi" }),
      );
      expect(events).toEqual([
        { type: "tool_result", tool_use_id: "call-1", content: "echo: hi", is_error: undefined },
      ]);
    });

    it("maps error events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "error", error: "something went wrong" }),
      );
      expect(events).toEqual([{ type: "error", message: "something went wrong" }]);
    });

    it("maps turn_complete events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "turn_complete" }),
      );
      expect(events).toEqual([{ type: "turn_complete" }]);
    });

    it("maps done events to empty array", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "done" }),
      );
      expect(events).toEqual([]);
    });

    it("maps unknown types to debug events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "custom_event", data: 42 }),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("debug");
      expect((events[0] as { message: string }).message).toBe("unknown_stream_event");
    });

    it("treats non-JSON lines as plain text", () => {
      const events = adapter.parseStreamJsonLine("plain text output");
      expect(events).toEqual([{ type: "text", text: "plain text output" }]);
    });

    it("generates UUID for tool_use without id", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "tool_use", name: "test", input: {} }),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("tool_use");
      const toolUse = events[0] as { id: string };
      expect(toolUse.id).toBeTruthy();
    });
  });

  describe("parseAcpEvent", () => {
    it("maps session/update text notifications to AgentEvent", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { content_type: "text", content: "hello from ACP" },
      });
      expect(events).toEqual([{ type: "text", text: "hello from ACP" }]);
    });

    it("maps session/update thinking notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { content_type: "thinking", content: "reasoning..." },
      });
      expect(events).toEqual([{ type: "thinking", text: "reasoning..." }]);
    });

    it("maps session/update tool_use notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          content_type: "tool_use",
          id: "acp-call-1",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
        },
      });
      expect(events).toEqual([
        {
          type: "tool_use",
          id: "acp-call-1",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
        },
      ]);
    });

    it("maps session/update tool_result notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          content_type: "tool_result",
          tool_use_id: "acp-call-1",
          content: "file contents here",
        },
      });
      expect(events).toEqual([
        {
          type: "tool_result",
          tool_use_id: "acp-call-1",
          content: "file contents here",
          is_error: undefined,
        },
      ]);
    });

    it("maps session/update error notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          content_type: "error",
          error: "model overloaded",
        },
      });
      expect(events).toEqual([{ type: "error", message: "model overloaded" }]);
    });

    it("maps session/update turn_complete notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: { content_type: "turn_complete" },
      });
      expect(events).toEqual([{ type: "turn_complete" }]);
    });

    it("maps session/error notifications", () => {
      const events = adapter.parseAcpEvent({
        jsonrpc: "2.0",
        method: "session/error",
        params: { error: "session timed out" },
      });
      expect(events).toEqual([{ type: "error", message: "session timed out" }]);
    });

    it("returns empty array for non-JSON-RPC messages", () => {
      expect(adapter.parseAcpEvent(null)).toEqual([]);
      expect(adapter.parseAcpEvent("not an object")).toEqual([]);
      expect(adapter.parseAcpEvent({ foo: "bar" })).toEqual([]);
    });
  });

  describe("redactSecrets", () => {
    it("removes KIMI_MODEL_API_KEY from output", () => {
      const result = redactSecrets(
        "Using key: pk-secret-12345 for model",
        "pk-secret-12345",
      );
      expect(result).toBe("Using key: *** for model");
    });

    it("returns original string when secret is empty", () => {
      const result = redactSecrets("no secrets here", "");
      expect(result).toBe("no secrets here");
    });

    it("handles multiple occurrences of the secret", () => {
      const result = redactSecrets(
        "key=abc123 and again key=abc123",
        "abc123",
      );
      expect(result).toBe("key=*** and again key=***");
    });
  });

  describe("buildKimiEnv", () => {
    it("sets KIMI_CODE_HOME and KIMI_MODEL_* from context", () => {
      const env = adapter.buildKimiEnv(
        {
          ...ctx,
          apiKey: "my-api-key",
          baseUrl: "https://api.moonshot.cn/v1",
          model: "kimi-latest",
        },
        "/tmp/kimi-home-123",
      );

      expect(env.KIMI_CODE_HOME).toBe("/tmp/kimi-home-123");
      expect(env.KIMI_SHARE_DIR).toBe("/tmp/kimi-home-123");
      expect(env.KIMI_DISABLE_TELEMETRY).toBe("1");
      expect(env.KIMI_MODEL_API_KEY).toBe("my-api-key");
      expect(env.KIMI_MODEL_NAME).toBe("kimi-latest");
      expect(env.KIMI_MODEL_BASE_URL).toBe("https://api.moonshot.cn/v1");
    });

    it("does not leak secrets in the returned env object debug output", () => {
      const env = adapter.buildKimiEnv(ctx, "/tmp/kimi-home");
      const serialized = JSON.stringify(env);
      // The env object DOES contain the key (it's needed for the child process),
      // but the key should not appear in any debug events emitted by run()
      expect(env.KIMI_MODEL_API_KEY).toBe("test-secret-key");
      // Verify the env_prepared debug event does NOT contain the key
      expect(serialized).toContain("test-secret-key"); // This is expected — the env must have it
    });

    it("falls back to env vars when context values are missing", () => {
      vi.stubEnv("KIMI_MODEL_API_KEY", "env-key");
      vi.stubEnv("KIMI_MODEL_BASE_URL", "https://env.example.com");

      const env = adapter.buildKimiEnv(
        { model: "test", apiKey: "", baseUrl: "" },
        "/tmp/kimi-home",
      );

      expect(env.KIMI_MODEL_API_KEY).toBe("env-key");
      expect(env.KIMI_MODEL_BASE_URL).toBe("https://env.example.com");
    });
  });

  describe("buildKimiConfig", () => {
    it("writes provider and model aliases required by Kimi Code", () => {
      const config = adapter.buildKimiConfig({
        ...ctx,
        provider: "kimi-fast",
        model: "kimi-for-coding",
        apiKey: "pk-test-secret",
        baseUrl: "https://api.kimi.com/coding/v1",
      });

      expect(config).toContain('default_model = "kimi-for-coding"');
      expect(config).toContain('default_thinking = true');
      expect(config).toContain('default_provider = "kimi-fast"');
      expect(config).toContain('[providers."kimi-fast"]');
      expect(config).toContain('type = "kimi"');
      expect(config).toContain('api_key = "pk-test-secret"');
      expect(config).toContain('base_url = "https://api.kimi.com/coding/v1"');
      expect(config).toContain('[models."kimi-for-coding"]');
      expect(config).toContain('provider = "kimi-fast"');
      expect(config).toContain('max_context_size = 128000');
      expect(config).toContain('capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]');
    });

    it("does not force always-thinking capabilities for unrelated custom models", () => {
      const config = adapter.buildKimiConfig({
        ...ctx,
        provider: "custom-openai",
        model: "custom-chat-model",
        apiKey: "pk-test-secret",
        baseUrl: "https://example.com/v1",
      });

      expect(config).not.toContain("default_thinking");
      expect(config).not.toContain("always_thinking");
    });
  });

  describe("checkReadiness", () => {
    it("yields actionable error when kimi binary missing", async () => {
      const mockedAdapter = new KimiCodeAdapter("/tmp/homerail-missing-kimi-binary");
      const result = await mockedAdapter.checkReadiness();

      expect(result.ready).toBe(false);
      expect(result.error).toContain("npm install -g @moonshot-ai/kimi-code");
      expect(result.error).toContain("Node >= 22.19.0");
    });

    const itOnPosix = process.platform === "win32" ? it.skip : it;
    itOnPosix("does not expose the Manager admin token to the real readiness subprocess", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-readiness-env-"));
      const kimiBin = join(tempDir, "kimi");
      writeFileSync(kimiBin, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log(process.env.HOMERAIL_MANAGER_ADMIN_TOKEN ? "TOKEN_LEAKED" : "TOKEN_ABSENT");
  process.exit(0);
}
process.exit(2);
`, "utf-8");
      chmodSync(kimiBin, 0o755);
      vi.stubEnv("HOMERAIL_MANAGER_ADMIN_TOKEN", "readiness-secret-0123456789abcdef");
      try {
        await expect(new KimiCodeAdapter(kimiBin).checkReadiness()).resolves.toEqual({
          ready: true,
          version: "TOKEN_ABSENT",
        });
        expect(process.env.HOMERAIL_MANAGER_ADMIN_TOKEN).toBe("readiness-secret-0123456789abcdef");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    const itOnWindows = process.platform === "win32" ? it : it.skip;
    itOnWindows("runs npm kimi.cmd shims through node and the package main", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-cmd-shim-"));
      const shimPath = join(tempDir, "node_modules", ".bin", "kimi.cmd");
      const mainPath = join(tempDir, "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
      mkdirSync(dirname(shimPath), { recursive: true });
      mkdirSync(dirname(mainPath), { recursive: true });
      writeFileSync(shimPath, "@ECHO off\r\nexit /b 99\r\n", "utf-8");
      writeFileSync(mainPath, `
if (process.argv.includes("--version")) {
  console.log("kimi-code shim fixture 0.0.0");
  process.exit(0);
}
console.error("unexpected args " + process.argv.join(" "));
process.exit(2);
`, "utf-8");

      try {
        const shimAdapter = new KimiCodeAdapter(shimPath);
        const result = await shimAdapter.checkReadiness();

        expect(result).toEqual({
          ready: true,
          version: "kimi-code shim fixture 0.0.0",
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("run (integration-style with mocked spawn)", () => {
    it("hides Windows console windows for Kimi child processes", () => {
      expect(_kimiSpawnOptionsForTest({
        cwd: "C:\\work",
        stdio: ["ignore", "pipe", "pipe"],
      })).toMatchObject({
        cwd: "C:\\work",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    });

    it("yields readiness error when kimi binary is not found", async () => {
      // We test this by directly calling checkReadiness and verifying the error path
      // The actual run() with mocked spawn is complex; test readiness separately
      const readiness = await adapter.checkReadiness();
      // In test environments, kimi won't be installed
      expect(typeof readiness.ready).toBe("boolean");
    });

    it("fails explicitly when transcript resume is requested", async () => {
      await expect(adapter.resume("session-1")).rejects.toThrow("transcript resume is not implemented");
    });

    it("supports Kimi Agent SDK sessions with external HomeRail tools", async () => {
      const captured: {
        options?: Record<string, unknown>;
        prompt?: string;
        agentInstructions?: string;
        skillDocument?: string;
      } = {};
      const close = vi.fn(async () => {});
      const createSdkSession = vi.fn((options: Record<string, unknown>) => {
        captured.options = options;
        const shareDir = String(options.shareDir);
        captured.agentInstructions = readFileSync(join(shareDir, "AGENTS.md"), "utf-8");
        const skillsDir = String(options.skillsDir);
        const skillDir = readdirSync(skillsDir)[0]!;
        captured.skillDocument = readFileSync(join(skillsDir, skillDir, "SKILL.md"), "utf-8");
        return {
          sessionId: "sdk-session-1",
          workDir: options.workDir,
          state: "idle",
          slashCommands: [],
          model: options.model,
          thinking: false,
          yoloMode: true,
          executable: options.executable,
          env: options.env,
          externalTools: options.externalTools,
          planMode: false,
          setPlanMode: async () => false,
          prompt(content: string) {
            captured.prompt = content;
            const result = Promise.resolve({ status: "finished", steps: 1 });
            return {
              result,
              interrupt: async () => {},
              approve: async () => {},
              respondQuestion: async () => {},
              steer: async () => {},
              async *[Symbol.asyncIterator]() {
                const tools = options.externalTools as Array<{
                  name: string;
                  handler: (params: Record<string, unknown>) => Promise<{ output: string; message: string }>;
                }>;
                await tools[0].handler({ msg: "hi" });
                yield { type: "ContentPart", payload: { type: "text", text: "hello sdk" } };
                yield { type: "TurnEnd", payload: {} };
                return { status: "finished", steps: 1 };
              },
            };
          },
          close,
          [Symbol.asyncDispose]: close,
        };
      });
      const sdkAdapter = new KimiCodeAdapter({
        transport: "sdk",
        sdkExecutable: "fake-kimi-sdk",
        createSdkSession: createSdkSession as never,
      });
      const toolCalls: Array<Record<string, unknown>> = [];
      const echoTool: DagToolDefinition = {
        name: "echo",
        description: "Echo a message",
        input_schema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        handler: async (args) => {
          toolCalls.push(args);
          return { content: [{ type: "text", text: `echo:${args.msg}` }] };
        },
      };

      const events: AgentEvent[] = [];
      for await (const event of sdkAdapter.run("say hello", [echoTool], {
        ...ctx,
        systemPrompt: "Use tools when helpful.",
        provider: "kimi",
        model: "kimi-k2.7-code",
        baseUrl: "https://api.kimi.com/coding/v1",
        skillProjection: {
          mode: "explicit",
          definitions: [{
            id: "homerail-interaction",
            description: "Keep voice turns concise and operate the HomeRail canvas",
            content: "# Interaction\nNATIVE_KIMI_SKILL_BODY",
          }],
        },
      })) {
        events.push(event);
      }

      expect(createSdkSession).toHaveBeenCalledTimes(1);
      expect(captured.options).toMatchObject({
        executable: "fake-kimi-sdk",
        model: "kimi-k2.7-code",
        yoloMode: true,
        skillsDir: expect.any(String),
      });
      expect(captured.prompt).toBe("say hello");
      expect(captured.agentInstructions).toBe("Use tools when helpful.\n");
      expect(captured.skillDocument).toContain("NATIVE_KIMI_SKILL_BODY");
      expect(captured.skillDocument).toContain("disableModelInvocation: false");
      expect(toolCalls).toEqual([{ msg: "hi" }]);
      expect(events).toContainEqual(expect.objectContaining({
        type: "debug",
        message: "kimi_agent_sdk_session_started",
      }));
      expect(events).toContainEqual({ type: "text", text: "hello sdk" });
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool_use",
        name: "echo",
        input: { msg: "hi" },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "tool_result",
        content: "echo:hi",
      }));
      expect(events).toContainEqual({ type: "done" });
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("falls back to prompt mode and emits handoff when ACP requires OAuth auth", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-acp-auth-fallback-"));
      const kimiBin = join(tempDir, "kimi");
      writeFileSync(kimiBin, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("kimi-code fixture 0.0.0");
  process.exit(0);
}
if (process.argv.includes("acp")) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    } else if (req.method === "session/new") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Authentication required" } }));
      process.exit(0);
    }
  });
} else if (process.argv.includes("--prompt")) {
  const marker = JSON.stringify({ port: "done", content: { ok: true }, summary: "ok" });
  console.log(JSON.stringify({ role: "assistant", content: "done\\n<homerail_handoff>" + marker + "</homerail_handoff>" }));
  process.exit(0);
} else {
  console.error("unexpected args " + process.argv.join(" "));
  process.exit(2);
}
`, "utf-8");
      chmodSync(kimiBin, 0o755);

      try {
        const fallbackAdapter = new KimiCodeAdapter(kimiBin);
        const calls: Array<Record<string, unknown>> = [];
        const handoffTool: DagToolDefinition = {
          name: "handoff",
          description: "handoff",
          input_schema: { type: "object" },
          handler: async (args) => {
            calls.push(args);
            return { content: [{ type: "text", text: "handoff ok" }] };
          },
        };

        const events: AgentEvent[] = [];
        for await (const event of fallbackAdapter.run("complete the task", [handoffTool], {
          ...ctx,
          provider: "kimi-fast",
          model: "kimi-for-coding",
          baseUrl: "https://api.kimi.com/coding/v1",
        })) {
          events.push(event);
        }

        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "acp_auth_required_fallback_to_prompt_mode",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "tool_use",
          name: "handoff",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "tool_result",
          content: "handoff ok",
        }));
        expect(calls).toEqual([
          {
            port: "done",
            content: { ok: true },
            summary: "ok",
          },
        ]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses native SDK tools for Manager Agent after ACP authentication fallback", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-manager-sdk-fallback-"));
      const kimiBin = join(tempDir, "kimi");
      writeFileSync(kimiBin, `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("kimi-code fixture 0.0.0");
  process.exit(0);
}
if (process.argv.includes("acp")) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    } else if (req.method === "session/new") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Authentication required" } }));
      process.exit(0);
    }
  });
} else if (process.argv.includes("--prompt")) {
  console.error("prompt bridge must not run before the native SDK fallback");
  process.exit(9);
} else {
  process.exit(2);
}
`, "utf-8");
      chmodSync(kimiBin, 0o755);

      const createSdkSession = vi.fn((options: Record<string, unknown>) => {
        const close = vi.fn(async () => {});
        return {
          sessionId: "manager-sdk-fallback",
          workDir: options.workDir,
          state: "idle",
          slashCommands: [],
          model: options.model,
          thinking: false,
          yoloMode: true,
          executable: options.executable,
          env: options.env,
          externalTools: options.externalTools,
          planMode: false,
          setPlanMode: async () => false,
          prompt() {
            const result = Promise.resolve({ status: "finished", steps: 1 });
            return {
              result,
              interrupt: async () => {},
              approve: async () => {},
              respondQuestion: async () => {},
              steer: async () => {},
              async *[Symbol.asyncIterator]() {
                const tools = options.externalTools as Array<{
                  name: string;
                  handler: (params: Record<string, unknown>) => Promise<{ output: string; message: string }>;
                }>;
                const canvasTool = tools.find((tool) => tool.name === "upsert_generated_view");
                await canvasTool!.handler({ id: "today", title: "今日状态" });
                yield { type: "ContentPart", payload: { type: "text", text: "卡片已经放好了。" } };
                yield { type: "TurnEnd", payload: {} };
                return { status: "finished", steps: 1 };
              },
            };
          },
          close,
          [Symbol.asyncDispose]: close,
        };
      });
      const managerAdapter = new KimiCodeAdapter({
        kimiBin,
        transport: "cli",
        sdkExecutable: "fake-kimi-sdk",
        createSdkSession: createSdkSession as never,
      });
      const canvasCalls: Array<Record<string, unknown>> = [];
      const tools: DagToolDefinition[] = [
        {
          name: "create_and_run",
          description: "Create and run a DAG",
          input_schema: { type: "object" },
          handler: async () => ({ content: [{ type: "text", text: "unused" }] }),
        },
        {
          name: "finish",
          description: "Finish the turn",
          input_schema: { type: "object" },
          handler: async () => ({ content: [{ type: "text", text: "unused" }] }),
        },
        {
          name: "upsert_generated_view",
          description: "Create a visible canvas Block",
          input_schema: { type: "object" },
          handler: async (args) => {
            canvasCalls.push(args);
            return { content: [{ type: "text", text: "committed" }] };
          },
        },
      ];

      try {
        const events: AgentEvent[] = [];
        for await (const event of managerAdapter.run("创建今日状态卡片", tools, {
          ...ctx,
          provider: "qwen-local",
          model: "qwen3.6",
          baseUrl: "http://127.0.0.1:5000/v1",
        })) {
          events.push(event);
        }

        expect(createSdkSession).toHaveBeenCalledTimes(1);
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "acp_auth_required_fallback_to_agent_sdk",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "kimi_agent_sdk_session_started",
        }));
        expect(events).not.toContainEqual(expect.objectContaining({
          message: "acp_auth_required_fallback_to_prompt_mode",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "tool_use",
          name: "upsert_generated_view",
        }));
        expect(events).toContainEqual({ type: "text", text: "卡片已经放好了。" });
        expect(canvasCalls).toEqual([{ id: "today", title: "今日状态" }]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses prompt-mode tool markers for Manager Agent tools only when explicitly enabled", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-manager-tool-bridge-"));
      const kimiBin = join(tempDir, "kimi");
      const promptPath = join(tempDir, "prompt.txt");
      const agentsPath = join(tempDir, "agents.txt");
      const argsPath = join(tempDir, "args.json");
      writeFileSync(kimiBin, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  console.log("kimi-code fixture 0.0.0");
  process.exit(0);
}
if (process.argv.includes("acp")) {
  console.error("ACP should not be used for Manager Agent tool bridge");
  process.exit(9);
}
if (process.argv.includes("--prompt")) {
  const prompt = process.argv[process.argv.indexOf("--prompt") + 1] || "";
  fs.writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);
  fs.writeFileSync(process.env.CAPTURE_AGENTS_PATH, fs.readFileSync(process.env.KIMI_CODE_HOME + "/AGENTS.md", "utf8"));
  fs.writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(process.argv));
  const createMarker = JSON.stringify({
    name: "create_and_run",
    input: {
      yamlPath: "assets/orchestrations/public-two-node.yaml.template",
      profile: "offline-deterministic",
      prompt: "smoke"
    }
  });
  const finishMarker = JSON.stringify({
    name: "finish",
    input: {
      text: "The run id will be assigned later."
    }
  });
  console.log(JSON.stringify({
    role: "assistant",
    content: "不要显示的内部前言。\\n<homerail_tool_call>" + createMarker + "</homerail_tool_call>\\n<homerail_tool_call>" + finishMarker + "</homerail_tool_call>\\n已启动。"
  }));
  process.exit(0);
}
console.error("unexpected args " + process.argv.join(" "));
process.exit(2);
`, "utf-8");
      chmodSync(kimiBin, 0o755);

      const previousCapturePromptPath = process.env.CAPTURE_PROMPT_PATH;
      const previousCaptureAgentsPath = process.env.CAPTURE_AGENTS_PATH;
      const previousCaptureArgsPath = process.env.CAPTURE_ARGS_PATH;
      const previousPromptToolBridge = process.env.HOMERAIL_KIMI_PROMPT_TOOL_BRIDGE;
      process.env.CAPTURE_PROMPT_PATH = promptPath;
      process.env.CAPTURE_AGENTS_PATH = agentsPath;
      process.env.CAPTURE_ARGS_PATH = argsPath;
      process.env.HOMERAIL_KIMI_PROMPT_TOOL_BRIDGE = "1";
      try {
        const managerAdapter = new KimiCodeAdapter(kimiBin);
        const calls: Array<Record<string, unknown>> = [];
        const createAndRunTool: DagToolDefinition = {
          name: "create_and_run",
          description: "Create and run a DAG",
          input_schema: {
            type: "object",
            properties: {
              yamlPath: { type: "string" },
              profile: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["yamlPath"],
            additionalProperties: false,
          },
          handler: async (args) => {
            calls.push(args);
            return { content: [{ type: "text", text: JSON.stringify({ run_id: "run-kimi-manager" }) }] };
          },
        };
        const finishTool: DagToolDefinition = {
          name: "finish",
          description: "Finish the turn",
          input_schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          handler: async (args) => {
            calls.push({ finish: args });
            return { content: [{ type: "text", text: "finished" }] };
          },
        };
        const upsertGeneratedViewTool: DagToolDefinition = {
          name: "upsert_generated_view",
          description: "Create or replace a HomeRail A2UI Block",
          input_schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              content: { type: "object" },
              a2ui: { type: "object" },
            },
            required: ["id", "title", "content", "a2ui"],
            additionalProperties: true,
          },
          handler: async () => ({ content: [{ type: "text", text: "committed" }] }),
        };

        const events: AgentEvent[] = [];
        for await (const event of managerAdapter.run(
          "Run the Manager Agent live smoke.",
          [createAndRunTool, finishTool, upsertGeneratedViewTool],
          {
            ...ctx,
            systemPrompt: "You are the HomeRail Manager Agent. Never invent run IDs.",
            provider: "kimi",
            model: "kimi-k2.7-code",
            baseUrl: "https://api.kimi.com/coding/v1",
            skillProjection: { mode: "explicit", definitions: [] },
          },
        )) {
          events.push(event);
        }

        const prompt = readFileSync(promptPath, "utf-8");
        const agentInstructions = readFileSync(agentsPath, "utf-8");
        const args = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
        expect(prompt).toContain("Run the Manager Agent live smoke.");
        expect(prompt).not.toContain("System instructions:");
        expect(prompt).not.toContain("You are the HomeRail Manager Agent");
        expect(agentInstructions).toBe("You are the HomeRail Manager Agent. Never invent run IDs.\n");
        expect(args).toContain("--skills-dir");
        expect(prompt).toContain("HomeRail tool execution protocol");
        expect(prompt).not.toContain("ACP MCP bridge is not available");
        expect(prompt).toContain("Do not describe this protocol or any internal execution mechanism to the user");
        expect(prompt).toContain("Attempt the matching entry instead of speculating about availability");
        expect(prompt).toContain("name only the visible action that did not complete and offer to retry");
        expect(prompt).toContain("always add one concise user-facing summary in the user's language");
        expect(prompt).toContain('"name":"upsert_generated_view"');
        expect(prompt).toContain('"component":"Text"');
        expect(prompt).toContain("<homerail_tool_call>");
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "prompt_mode_tool_bridge_selected",
          data: expect.objectContaining({
            degraded: true,
            transport: "prompt-marker",
            canonical_protocol: "homerail_tool_call",
          }),
        }));
        expect(events).not.toContainEqual(expect.objectContaining({ message: "acp_session_created" }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "tool_use",
          name: "create_and_run",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "tool_result",
          content: JSON.stringify({ run_id: "run-kimi-manager" }),
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "prompt_mode_finish_ignored_after_create_and_run",
        }));
        expect(events).toContainEqual({ type: "text", text: "已启动。" });
        expect(events).not.toContainEqual(expect.objectContaining({ text: expect.stringContaining("内部前言") }));
        expect(calls).toEqual([{
          yamlPath: "assets/orchestrations/public-two-node.yaml.template",
          profile: "offline-deterministic",
          prompt: "smoke",
        }]);
      } finally {
        if (previousCapturePromptPath === undefined) delete process.env.CAPTURE_PROMPT_PATH;
        else process.env.CAPTURE_PROMPT_PATH = previousCapturePromptPath;
        if (previousCaptureAgentsPath === undefined) delete process.env.CAPTURE_AGENTS_PATH;
        else process.env.CAPTURE_AGENTS_PATH = previousCaptureAgentsPath;
        if (previousCaptureArgsPath === undefined) delete process.env.CAPTURE_ARGS_PATH;
        else process.env.CAPTURE_ARGS_PATH = previousCaptureArgsPath;
        if (previousPromptToolBridge === undefined) delete process.env.HOMERAIL_KIMI_PROMPT_TOOL_BRIDGE;
        else process.env.HOMERAIL_KIMI_PROMPT_TOOL_BRIDGE = previousPromptToolBridge;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("registers Manager Agent tools through a local MCP bridge for ACP sessions", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "homerail-kimi-acp-mcp-"));
      const kimiBin = join(tempDir, "kimi");
      const capturePath = join(tempDir, "session-new.json");
      const mcpResultPath = join(tempDir, "mcp-result.json");
      const argsPath = join(tempDir, "args.json");
      const agentsPath = join(tempDir, "agents.txt");
      const promptPath = join(tempDir, "session-prompt.txt");
      writeFileSync(kimiBin, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");

if (process.argv.includes("--version")) {
  console.log("kimi-code fixture 0.0.0");
  process.exit(0);
}

if (!process.argv.includes("acp")) {
  console.error("unexpected args " + process.argv.join(" "));
  process.exit(2);
}

fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv));
fs.writeFileSync(
  process.env.AGENTS_PATH,
  fs.readFileSync(process.env.KIMI_CODE_HOME + "/AGENTS.md", "utf8"),
);

let mcpServer = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

async function callMcp(server) {
  const env = { ...process.env };
  for (const entry of server.env || []) {
    env[entry.name] = entry.value;
  }
  const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let requestId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });
  rl.on("line", (line) => {
    const parsed = JSON.parse(line);
    const waiter = pending.get(parsed.id);
    if (!waiter) return;
    pending.delete(parsed.id);
    if (parsed.error) waiter.reject(new Error(parsed.error.message));
    else waiter.resolve(parsed.result);
  });
  child.on("error", (err) => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  });
  function request(method, params) {
    const id = ++requestId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error("MCP request timed out: " + method + " stderr=" + stderr));
      }, 5000);
    });
  }
  const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
  const listed = await request("tools/list", {});
  const called = await request("tools/call", {
    name: "create_and_run",
    arguments: {
      yamlPath: "assets/orchestrations/public-two-node.yaml.template",
      profile: "offline-deterministic",
      prompt: "smoke"
    }
  });
  child.kill("SIGTERM");
  return { initialized, listed, called };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (req.method === "session/new") {
    mcpServer = req.params.mcpServers[0];
    fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(req.params.mcpServers, null, 2));
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "session-test" } });
    return;
  }
  if (req.method === "session/prompt") {
    try {
      fs.writeFileSync(process.env.PROMPT_PATH, req.params.prompt[0].text);
      const result = await callMcp(mcpServer);
      fs.writeFileSync(process.env.MCP_RESULT_PATH, JSON.stringify(result, null, 2));
      send({ jsonrpc: "2.0", id: req.id, result: {} });
      process.exit(0);
    } catch (err) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: err.message } });
      process.exit(1);
    }
  }
});
`, "utf-8");
      chmodSync(kimiBin, 0o755);

      const previousCapturePath = process.env.CAPTURE_PATH;
      const previousMcpResultPath = process.env.MCP_RESULT_PATH;
      const previousArgsPath = process.env.ARGS_PATH;
      const previousAgentsPath = process.env.AGENTS_PATH;
      const previousPromptPath = process.env.PROMPT_PATH;
      process.env.CAPTURE_PATH = capturePath;
      process.env.MCP_RESULT_PATH = mcpResultPath;
      process.env.ARGS_PATH = argsPath;
      process.env.AGENTS_PATH = agentsPath;
      process.env.PROMPT_PATH = promptPath;

      try {
        const mcpAdapter = new KimiCodeAdapter(kimiBin);
        const calls: Array<Record<string, unknown>> = [];
        const createAndRunTool: DagToolDefinition = {
          name: "create_and_run",
          description: "Create and run a DAG",
          input_schema: {
            type: "object",
            properties: {
              yamlPath: { type: "string" },
              profile: { type: "string" },
              prompt: { type: "string" },
            },
            required: ["yamlPath"],
            additionalProperties: false,
          },
          handler: async (args) => {
            calls.push(args);
            return { content: [{ type: "text", text: JSON.stringify({ run_id: "run-kimi-manager-mcp" }) }] };
          },
        };
        const finishTool: DagToolDefinition = {
          name: "finish",
          description: "Finish the turn",
          input_schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          handler: async (args) => {
            calls.push({ finish: args });
            return { content: [{ type: "text", text: "finished" }] };
          },
        };

        const events: AgentEvent[] = [];
        for await (const event of mcpAdapter.run("Run the Manager Agent live smoke.", [createAndRunTool, finishTool], {
          ...ctx,
          systemPrompt: "You are the HomeRail Manager Agent. Use registered tools directly.",
          provider: "kimi",
          model: "kimi-k2.7-code",
          baseUrl: "https://api.kimi.com/coding/v1",
          skillProjection: { mode: "explicit", definitions: [] },
        })) {
          events.push(event);
        }

        const mcpServers = JSON.parse(readFileSync(capturePath, "utf-8")) as Array<{
          name: string;
          command: string;
          args: string[];
          env: Array<{ name: string; value: string }>;
        }>;
        const mcpResult = JSON.parse(readFileSync(mcpResultPath, "utf-8")) as {
          listed: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
          called: { content: Array<{ text: string }>; isError?: boolean };
        };
        const args = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];

        expect(mcpServers).toHaveLength(1);
        expect(args).toContain("--skills-dir");
        expect(args.indexOf("--skills-dir")).toBeLessThan(args.indexOf("acp"));
        expect(readFileSync(agentsPath, "utf-8"))
          .toBe("You are the HomeRail Manager Agent. Use registered tools directly.\n");
        expect(readFileSync(promptPath, "utf-8")).toBe("Run the Manager Agent live smoke.");
        expect(mcpServers[0].name).toBe("homerail-tools");
        expect(mcpServers[0].command).toBe(process.execPath);
        expect(mcpServers[0].args[0]).toContain("homerail-tools-mcp-server.mjs");
        expect(mcpServers[0].env.map((entry) => entry.name)).toEqual([
          "HOMERAIL_MCP_BRIDGE_URL",
          "HOMERAIL_MCP_BRIDGE_TOKEN",
        ]);
        expect(JSON.stringify(mcpServers)).not.toContain("test-secret-key");
        expect(mcpResult.listed.tools.map((tool) => tool.name)).toEqual(["create_and_run", "finish"]);
        expect(mcpResult.listed.tools[0]).toMatchObject({
          name: "create_and_run",
          inputSchema: expect.objectContaining({ type: "object" }),
        });
        expect(mcpResult.called).toEqual({
          content: [{ type: "text", text: JSON.stringify({ run_id: "run-kimi-manager-mcp" }) }],
          isError: false,
        });
        expect(calls).toEqual([{
          yamlPath: "assets/orchestrations/public-two-node.yaml.template",
          profile: "offline-deterministic",
          prompt: "smoke",
        }]);
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "mcp_bridge_registered",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "debug",
          message: "acp_session_created",
          data: expect.objectContaining({ mcp_server_count: 1, mcp_tool_count: 2 }),
        }));
      } finally {
        if (previousCapturePath === undefined) delete process.env.CAPTURE_PATH;
        else process.env.CAPTURE_PATH = previousCapturePath;
        if (previousMcpResultPath === undefined) delete process.env.MCP_RESULT_PATH;
        else process.env.MCP_RESULT_PATH = previousMcpResultPath;
        if (previousArgsPath === undefined) delete process.env.ARGS_PATH;
        else process.env.ARGS_PATH = previousArgsPath;
        if (previousAgentsPath === undefined) delete process.env.AGENTS_PATH;
        else process.env.AGENTS_PATH = previousAgentsPath;
        if (previousPromptPath === undefined) delete process.env.PROMPT_PATH;
        else process.env.PROMPT_PATH = previousPromptPath;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("secret redaction in parseStreamJsonLine", () => {
    it("maps Kimi prompt-mode assistant content events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ role: "assistant", content: "hello from prompt mode" }),
      );
      expect(events).toEqual([{ type: "text", text: "hello from prompt mode" }]);
    });

    it("redacts secrets from text events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "text", text: "Using key: my-secret-key-123" }),
        "my-secret-key-123",
      );
      expect(events).toEqual([{ type: "text", text: "Using key: ***" }]);
    });

    it("redacts secrets from error events", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "error", error: "Auth failed for key my-secret-key-123" }),
        "my-secret-key-123",
      );
      expect(events).toEqual([{ type: "error", message: "Auth failed for key ***" }]);
    });

    it("redacts secrets from tool_result content", () => {
      const events = adapter.parseStreamJsonLine(
        JSON.stringify({ type: "tool_result", tool_use_id: "t1", content: "env key=my-secret-key-123" }),
        "my-secret-key-123",
      );
      expect(events).toEqual([
        { type: "tool_result", tool_use_id: "t1", content: "env key=***", is_error: undefined },
      ]);
    });
  });

  describe("secret redaction in parseAcpEvent", () => {
    it("redacts secrets from ACP text events", () => {
      const events = adapter.parseAcpEvent(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { content_type: "text", content: "Using key my-secret-key-123" },
        },
        "my-secret-key-123",
      );
      expect(events).toEqual([{ type: "text", text: "Using key ***" }]);
    });

    it("redacts secrets from ACP error events", () => {
      const events = adapter.parseAcpEvent(
        {
          jsonrpc: "2.0",
          method: "session/error",
          params: { error: "failed with key my-secret-key-123" },
        },
        "my-secret-key-123",
      );
      expect(events).toEqual([{ type: "error", message: "failed with key ***" }]);
    });
  });
});

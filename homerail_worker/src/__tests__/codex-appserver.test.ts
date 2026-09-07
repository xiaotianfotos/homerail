/**
 * Tests for Codex App-Server adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";
import { WORKER_RUNTIME_VERSION } from "../runtime-version.js";

// --- Helpers to mock child_process.spawn ---

interface MockProcess {
  stdinCapture: CapturedWritable;
  stdout: PassThrough;
  stderr: PassThrough;
  events: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

/** A writable that captures all written data. */
class CapturedWritable extends Writable {
  public chunks: Buffer[] = [];

  _write(chunk: Buffer, _encoding: string, cb: () => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }

  getFullText(): string {
    return Buffer.concat(this.chunks).toString();
  }

  getJsonLines(): Array<Record<string, unknown>> {
    const text = this.getFullText();
    const lines = text.split("\n").filter((l) => l.trim());
    const results: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line.trim()));
      } catch {
        // skip non-JSON lines
      }
    }
    return results;
  }
}

function createMockProcess(): MockProcess {
  const stdinCapture = new CapturedWritable();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const kill = vi.fn();

  return { stdinCapture, stdout, stderr, events, kill };
}

function setupMocksWithFs(mockProc: MockProcess) {
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      mkdtempSync: vi.fn().mockReturnValue("/tmp/test-codex"),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    };
  });

  vi.doMock("node:child_process", () => ({
    spawn: vi.fn().mockReturnValue({
      stdin: mockProc.stdinCapture,
      stdout: mockProc.stdout,
      stderr: mockProc.stderr,
      on: mockProc.events.on.bind(mockProc.events),
      kill: mockProc.kill,
    }),
    spawnSync: vi.fn(),
  }));
}

/** Write a JSON-RPC response to stdout (readable by adapter's readline). */
function writeResponse(mockProc: MockProcess, id: number, result: Record<string, unknown>) {
  mockProc.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

/** Write a JSON-RPC notification to stdout. */
function writeNotification(mockProc: MockProcess, method: string, params: Record<string, unknown>) {
  mockProc.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

/** Helper: find JSON-RPC requests written to stdin by the adapter. */
function waitForStdinRequests(mockProc: MockProcess, count: number, timeoutMs = 5000): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      const found = mockProc.stdinCapture.getJsonLines().filter((j) => "method" in j);
      reject(new Error(`Timeout waiting for ${count} stdin requests, found ${found.length}`));
    }, timeoutMs);

    const check = () => {
      const requests = mockProc.stdinCapture.getJsonLines().filter((j) => "method" in j);
      if (requests.length >= count) {
        clearTimeout(deadline);
        resolve(requests.slice(0, count));
      }
    };

    // Check periodically
    const interval = setInterval(check, 5);
    check();

    // Clean up interval when promise resolves
    const origResolve = resolve;
    resolve = (val) => {
      clearInterval(interval);
      origResolve(val);
    };
  });
}

/** Drain stdin requests until we see a specific method. */
async function waitForMethod(mockProc: MockProcess, method: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = mockProc.stdinCapture.getJsonLines().filter((j) => "method" in j);
    const found = requests.find((j) => j.method === method);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout waiting for method "${method}" in stdin`);
}

/** Get the first request with a given method from stdin. */
function findRequest(mockProc: MockProcess, method: string): Record<string, unknown> | undefined {
  return mockProc.stdinCapture.getJsonLines().find((j) => "method" in j && j.method === method);
}

// --- Tests ---

describe("CodexAppServerAdapter", () => {
  const ctx: AgentRunContext = {
    model: "gpt-4.1",
    apiKey: "pk-test-secret-key-1234567890",
    baseUrl: "https://api.example.com/v1",
    maxIterations: 3,
    workspace: "/test/workspace",
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports CodexAppServerAdapter class", async () => {
    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    expect(CodexAppServerAdapter).toBeDefined();
    expect(typeof CodexAppServerAdapter).toBe("function");
  });

  it("implements AgentClient interface with run and resume", async () => {
    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();
    expect(typeof adapter.run).toBe("function");
    expect(typeof adapter.resume).toBe("function");
    await expect(adapter.resume("s1")).rejects.toThrow("transcript resume is not implemented");
  });

  it("uses a shell only for Windows command shims", async () => {
    const { _codexWindowsCommandNeedsShellForTest } = await import("../agent/codex-appserver.js");

    expect(_codexWindowsCommandNeedsShellForTest("C:\\Tools\\codex.cmd", "win32")).toBe(true);
    expect(_codexWindowsCommandNeedsShellForTest("C:\\Tools\\codex.bat", "win32")).toBe(true);
    expect(_codexWindowsCommandNeedsShellForTest("C:\\Tools\\codex.exe", "win32")).toBe(false);
    expect(_codexWindowsCommandNeedsShellForTest("/usr/bin/codex.cmd", "linux")).toBe(false);
  });

  it("keeps the provider key in a loopback relay and gives Codex only a dispatch-scoped key", async () => {
    let receivedAuthorization = "";
    let receivedPath = "";
    const upstream = createServer((request, response) => {
      receivedAuthorization = String(request.headers.authorization ?? "");
      receivedPath = String(request.url ?? "");
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;
    const providerKey = "provider-key-never-given-to-codex";
    const { _startCodexProviderRelayForTest } = await import("../agent/codex-appserver.js");
    const relay = await _startCodexProviderRelayForTest(
      `http://127.0.0.1:${address.port}/v1/responses`,
      providerKey,
    );
    try {
      expect(relay.apiKey).not.toBe(providerKey);
      expect(relay.apiKey).toMatch(/^homerail-dispatch-[0-9a-f]{64}$/);
      const denied = await fetch(`${relay.baseUrl}/responses`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(403);

      const forwarded = await fetch(`${relay.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${relay.apiKey}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(forwarded.status).toBe(200);
      expect(await forwarded.json()).toEqual({ ok: true });
      expect(receivedAuthorization).toBe(`Bearer ${providerKey}`);
      expect(receivedPath).toBe("/v1/responses");
    } finally {
      relay.server.closeAllConnections();
      relay.server.close();
      upstream.closeAllConnections();
      upstream.close();
    }
  });

  it("spawns Responses Codex with the relay URL and scoped key instead of the provider key", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);
    const previousGuard = process.env.HOMERAIL_CODEX_PROC_GUARD;
    process.env.HOMERAIL_CODEX_PROC_GUARD = "/test/proc-guard.so";
    try {
      const childProcess = await import("node:child_process");
      const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
      const adapter = new CodexAppServerAdapter();
      const providerKey = "provider-key-must-stay-in-worker";
      const responseContext: AgentRunContext = {
        ...ctx,
        provider: "test-provider",
        protocol: "responses_compatible",
        apiKey: providerKey,
      };
      const consumePromise = (async () => {
        for await (const _event of adapter.run("hi", [], responseContext)) {
          // Drain the adapter while the test supplies app-server responses.
        }
      })();

      const requests = await waitForStdinRequests(mockProc, 1);
      const spawnCall = vi.mocked(childProcess.spawn).mock.calls[0]!;
      const spawnArgs = spawnCall[1] as string[];
      const spawnEnv = (spawnCall[2] as { env?: Record<string, string> }).env ?? {};
      expect(spawnArgs.join(" ")).toMatch(/base_url="http:\/\/127\.0\.0\.1:\d+\/v1"/);
      expect(spawnEnv.HOMERAIL_CODEX_API_KEY).toMatch(/^homerail-dispatch-[0-9a-f]{64}$/);
      expect(spawnEnv.HOMERAIL_CODEX_API_KEY).not.toBe(providerKey);

      writeResponse(mockProc, requests[0].id as number, {});
      const threadRequests = await waitForStdinRequests(mockProc, 2);
      writeResponse(mockProc, threadRequests[1].id as number, { thread_id: "relay-thread" });
      const turnRequests = await waitForStdinRequests(mockProc, 3);
      writeResponse(mockProc, turnRequests[2].id as number, { turn_id: "relay-turn" });
      writeNotification(mockProc, "turn/completed", {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      const closeRequest = findRequest(mockProc, "thread/unsubscribe");
      if (closeRequest) writeResponse(mockProc, closeRequest.id as number, {});
      await consumePromise;
    } finally {
      if (previousGuard === undefined) delete process.env.HOMERAIL_CODEX_PROC_GUARD;
      else process.env.HOMERAIL_CODEX_PROC_GUARD = previousGuard;
    }
  }, 15000);

  it("preloads the configured non-dumpable guard into provider-backed Linux Codex", async () => {
    const guard = "/usr/local/lib/homerail-codex-secret-guard.so";
    const existsSync = vi.fn((candidate: unknown) => String(candidate) === guard);
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync };
    });
    const { _guardedCodexSpawnCommandForTest } = await import("../agent/codex-appserver.js");
    expect(_guardedCodexSpawnCommandForTest(
      "/app/codex",
      ["app-server"],
      { HOMERAIL_CODEX_API_KEY: "provider-secret" },
      guard,
      "linux",
    )).toEqual({
      bin: "/app/codex",
      args: ["app-server"],
      env: {
        HOMERAIL_CODEX_API_KEY: "provider-secret",
        LD_PRELOAD: "/usr/local/lib/homerail-codex-secret-guard.so",
      },
    });
    expect(existsSync).toHaveBeenCalledTimes(1);
    expect(existsSync).toHaveBeenCalledWith(guard);
    expect(_guardedCodexSpawnCommandForTest(
      "/app/codex",
      ["app-server"],
      {},
      guard,
      "linux",
    )).toEqual({ bin: "/app/codex", args: ["app-server"], env: {} });
  });

  it("fails closed when a Linux provider secret has no configured guard", async () => {
    const { _guardedCodexSpawnCommandForTest } = await import("../agent/codex-appserver.js");
    expect(() => _guardedCodexSpawnCommandForTest(
      "/app/codex",
      ["app-server"],
      { HOMERAIL_CODEX_API_KEY: "provider-secret" },
      "",
      "linux",
    )).toThrow("Codex provider secret guard is required on Linux");
  });

  it("fails closed when a configured provider secret guard is missing", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });
    const { _guardedCodexSpawnCommandForTest } = await import("../agent/codex-appserver.js");
    expect(() => _guardedCodexSpawnCommandForTest(
      "/app/codex",
      ["app-server"],
      { HOMERAIL_CODEX_API_KEY: "provider-secret" },
      "/missing/guard",
      "linux",
    )).toThrow("Configured Codex secret guard not found");
  });

  it("emits error when codex binary not found", async () => {
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
    });

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();
    const events: AgentEvent[] = [];
    for await (const e of adapter.run("hi", [], ctx)) events.push(e);

    expect(events[0].type).toBe("error");
    expect((events[0] as { message: string }).message).toContain("not found");
    expect(events[events.length - 1].type).toBe("done");
  });

  it("emits text and done from agentMessage/delta notifications", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    // Respond to JSON-RPC handshake
    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    // Send notifications
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/agentMessage/delta", { delta: "Hello " });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/agentMessage/delta", { delta: "world" });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    // Wait for thread/unsubscribe request, respond to it
    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { text: string }).text).toBe("Hello world");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
  }, 15000);

  it("keeps a silent turn alive with content-free reasoning heartbeats", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter(undefined, 20);
    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const event of adapter.run("hi", [], ctx)) events.push(event);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((resolve) => setTimeout(resolve, 75));
    writeNotification(mockProc, "turn/completed", {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});
    await consumePromise;

    const heartbeats = events.filter((event) => event.type === "thinking");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.every((event) => event.type === "thinking" && event.text === "")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  }, 15000);

  it("emits only native commentary-phase agent messages as commentary", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();
    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const event of adapter.run("hi", [], ctx)) events.push(event);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((resolve) => setTimeout(resolve, 30));
    writeNotification(mockProc, "item/started", {
      item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary" },
    });
    writeNotification(mockProc, "item/agentMessage/delta", {
      itemId: "commentary-1",
      delta: "正在核对真实状态。",
    });
    writeNotification(mockProc, "item/completed", {
      item: { type: "agentMessage", id: "commentary-1", text: "正在核对真实状态。", phase: "commentary" },
    });
    writeNotification(mockProc, "item/reasoning/summaryTextDelta", {
      itemId: "reasoning-1",
      delta: "private reasoning",
    });
    writeNotification(mockProc, "item/started", {
      item: { type: "agentMessage", id: "final-1", text: "", phase: "final_answer" },
    });
    writeNotification(mockProc, "item/agentMessage/delta", {
      itemId: "final-1",
      delta: "已经完成。",
    });
    writeNotification(mockProc, "item/completed", {
      item: { type: "agentMessage", id: "final-1", text: "已经完成。", phase: "final_answer" },
    });
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((resolve) => setTimeout(resolve, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});
    await consumePromise;

    expect(events.filter((event) => event.type === "commentary")).toEqual([
      { type: "commentary", text: "正在核对真实状态。" },
    ]);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "已经完成。" },
    ]);
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", text: "private reasoning" },
    ]);
  }, 15000);

  it("emits thinking from reasoning/textDelta notifications", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/reasoning/textDelta", { delta: "Thinking step 1" });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/reasoning/summaryTextDelta", { text: "Summary" });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const thinkingEvents = events.filter((e) => e.type === "thinking");
    expect(thinkingEvents).toHaveLength(2);
    expect((thinkingEvents[0] as { text: string }).text).toBe("Thinking step 1");
    expect((thinkingEvents[1] as { text: string }).text).toBe("Summary");
  }, 15000);

  it("maps commandExecution started/completed to tool_use/tool_result", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/started", {
      item: { root: { type: "commandExecution", id: "cmd-1", command: "ls -la" } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/completed", {
      item: { root: { type: "commandExecution", id: "cmd-1", aggregated_output: "file1\nfile2", exit_code: 0 } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const toolUse = events.filter((e) => e.type === "tool_use");
    const toolResult = events.filter((e) => e.type === "tool_result");

    expect(toolUse).toHaveLength(1);
    expect((toolUse[0] as { name: string }).name).toBe("bash");
    expect((toolUse[0] as { input: Record<string, unknown> }).input.command).toBe("ls -la");

    expect(toolResult).toHaveLength(1);
    expect((toolResult[0] as { tool_use_id: string }).tool_use_id).toBe("cmd-1");
    expect((toolResult[0] as { content: string }).content).toBe("file1\nfile2");
    expect((toolResult[0] as { is_error: boolean }).is_error).toBe(false);
  }, 15000);

  it("maps mcpToolCall started/completed to tool_use/tool_result", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/started", {
      item: { root: { type: "mcpToolCall", id: "mcp-1", tool: "dag_handoff", arguments: { port: "done" } } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/completed", {
      item: { root: { type: "mcpToolCall", id: "mcp-1", tool: "dag_handoff", result: { content: [{ text: "ok" }] }, error: null } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const toolUse = events.filter((e) => e.type === "tool_use");
    const toolResult = events.filter((e) => e.type === "tool_result");

    expect(toolUse).toHaveLength(1);
    expect((toolUse[0] as { name: string }).name).toBe("dag_handoff");
    expect((toolUse[0] as { id: string }).id).toBe("mcp-1");

    expect(toolResult).toHaveLength(1);
    expect((toolResult[0] as { tool_use_id: string }).tool_use_id).toBe("mcp-1");
    expect((toolResult[0] as { content: string }).content).toBe("ok");
  }, 15000);

  it("maps error notification to error event", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "error", { message: "Something went wrong" });

    // Adapter exits after error, wait for it
    await new Promise((r) => setTimeout(r, 200));

    await consumePromise;

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect((errorEvents[0] as { message: string }).message).toContain("Something went wrong");
  }, 15000);

  it("emits turn_complete event", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/agentMessage/delta", { delta: "done" });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const turnComplete = events.filter((e) => e.type === "turn_complete");
    expect(turnComplete).toHaveLength(1);
  }, 15000);

  it("executes DAG tool handler for MCP tool_use and sends result to stdin", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const toolDef: DagToolDefinition = {
      name: "dag_handoff",
      description: "Handoff tool",
      input_schema: { type: "object", properties: { port: { type: "string" } } },
      handler: async (args) => ({
        content: [{ type: "text" as const, text: `Handed off to ${args.port}` }],
      }),
    };

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [toolDef], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    // Send MCP tool call notification
    writeNotification(mockProc, "item/started", {
      item: { root: { type: "mcpToolCall", id: "mcp-1", tool: "dag_handoff", arguments: { port: "done" } } },
    });

    // Wait for the adapter to process the tool call and send result
    await new Promise((r) => setTimeout(r, 200));

    // Now end the turn
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    // Verify tool_use emitted
    const toolUse = events.filter((e) => e.type === "tool_use");
    expect(toolUse).toHaveLength(1);
    expect((toolUse[0] as { name: string }).name).toBe("dag_handoff");

    // Verify tool_result emitted with handler's output
    const toolResult = events.filter((e) => e.type === "tool_result");
    expect(toolResult).toHaveLength(1);
    expect((toolResult[0] as { content: string }).content).toBe("Handed off to done");

    // Verify tool_result notification was sent to stdin
    const stdinLines = mockProc.stdinCapture.getJsonLines();
    const toolResultNotif = stdinLines.find(
      (j) => !("id" in j) && j.method === "tool_result",
    );
    expect(toolResultNotif).toBeDefined();
    expect(toolResultNotif!.params).toMatchObject({
      turn_id: "tr1",
      tool_use_id: "mcp-1",
      is_error: false,
    });
  }, 15000);

  it("handles tool handler errors gracefully", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const toolDef: DagToolDefinition = {
      name: "failing_tool",
      description: "A tool that throws",
      input_schema: { type: "object" },
      handler: async () => {
        throw new Error("tool exploded");
      },
    };

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [toolDef], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/started", {
      item: { root: { type: "mcpToolCall", id: "mcp-1", tool: "failing_tool", arguments: {} } },
    });
    await new Promise((r) => setTimeout(r, 200));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const toolResult = events.filter((e) => e.type === "tool_result");
    expect(toolResult).toHaveLength(1);
    expect((toolResult[0] as { is_error: boolean }).is_error).toBe(true);
    expect((toolResult[0] as { content: string }).content).toContain("tool exploded");
  }, 15000);

  it("does not leak API key in debug events", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const secretCtx: AgentRunContext = {
      model: "gpt-4.1",
      apiKey: "pk-supersecretkey1234567890abcdef",
      baseUrl: "https://api.example.com/v1",
      maxIterations: 1,
    };

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], secretCtx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("pk-supersecretkey1234567890abcdef");
    // Verify the key does not appear in any event, debug or otherwise
    for (const event of events) {
      const eventStr = JSON.stringify(event);
      expect(eventStr).not.toContain("pk-supersecretkey1234567890abcdef");
    }
  }, 15000);

  it("respects maxIterations by completing within limit", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    // With maxIterations=1, the adapter should complete in at most 1 turn
    const shortCtx = { ...ctx, maxIterations: 1 };

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], shortCtx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/agentMessage/delta", { delta: "response" });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    // Verify the adapter completed within the iteration limit
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect(events.some((e) => e.type === "done")).toBe(true);
  }, 15000);

  it("handles JSON-RPC error response", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    // Respond to initialize with an error
    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {}); // init succeeds
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    // Fail the thread/start request
    mockProc.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: reqs2[1].id, error: { code: -1, message: "Thread creation failed" } }) + "\n",
    );

    await new Promise((r) => setTimeout(r, 200));
    await consumePromise;

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const hasThreadError = errorEvents.some(
      (e) => (e as { message: string }).message.includes("Thread creation failed") ||
             (e as { message: string }).message.includes("Codex app-server error"),
    );
    expect(hasThreadError).toBe(true);
  }, 15000);

  it("handles command execution with non-zero exit code as error", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const events: AgentEvent[] = [];
    const consumePromise = (async () => {
      for await (const e of adapter.run("hi", [], ctx)) events.push(e);
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/started", {
      item: { root: { type: "commandExecution", id: "cmd-1", command: "exit 1" } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "item/completed", {
      item: { root: { type: "commandExecution", id: "cmd-1", aggregated_output: "error output", exit_code: 1 } },
    });
    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;

    const toolResult = events.filter((e) => e.type === "tool_result");
    expect(toolResult).toHaveLength(1);
    expect((toolResult[0] as { is_error: boolean }).is_error).toBe(true);
    expect((toolResult[0] as { content: string }).content).toBe("error output");
  }, 15000);

  it("sends correct initialize parameters", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const consumePromise = (async () => {
      for await (const _e of adapter.run("hi", [], ctx)) { /* drain */ }
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    expect(reqs[0].method).toBe("initialize");
    expect(reqs[0].params).toMatchObject({
      clientInfo: {
        name: "homerail_codex_appserver",
        title: "HomeRail Codex AppServer Adapter",
        version: WORKER_RUNTIME_VERSION,
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    });

    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;
  }, 15000);

  it("sends correct thread/start parameters", async () => {
    const mockProc = createMockProcess();
    setupMocksWithFs(mockProc);

    const { CodexAppServerAdapter } = await import("../agent/codex-appserver.js");
    const adapter = new CodexAppServerAdapter();

    const ctxWithPrompt: AgentRunContext = {
      ...ctx,
      systemPrompt: "You are a helpful assistant.",
      reasoningEffort: "max",
      serviceTier: null,
    };

    const consumePromise = (async () => {
      for await (const _e of adapter.run("hi", [], ctxWithPrompt)) { /* drain */ }
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    expect(reqs2[1].method).toBe("thread/start");
    expect(reqs2[1].params).toMatchObject({
      baseInstructions: null,
      developerInstructions: "You are a helpful assistant.",
      cwd: path.resolve("/test/workspace"),
      model: "gpt-4.1",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
      dynamicTools: [],
      serviceTier: null,
      config: { model_reasoning_effort: "max" },
    });

    writeResponse(mockProc, reqs2[1].id as number, { thread_id: "t1" });
    const reqs3 = await waitForStdinRequests(mockProc, 3);
    expect(reqs3[2].params).toMatchObject({
      effort: "max",
      serviceTier: null,
    });
    writeResponse(mockProc, reqs3[2].id as number, { turn_id: "tr1" });

    await new Promise((r) => setTimeout(r, 30));
    writeNotification(mockProc, "turn/completed", {});

    await new Promise((r) => setTimeout(r, 50));
    const closeReq = findRequest(mockProc, "thread/unsubscribe");
    if (closeReq) writeResponse(mockProc, closeReq.id as number, {});

    await consumePromise;
  }, 15000);
});

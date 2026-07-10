/**
 * Tests for Codex App-Server adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";

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
    expect(textEvents).toHaveLength(2);
    expect((textEvents[0] as { text: string }).text).toBe("Hello ");
    expect((textEvents[1] as { text: string }).text).toBe("world");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
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
    };

    const consumePromise = (async () => {
      for await (const _e of adapter.run("hi", [], ctxWithPrompt)) { /* drain */ }
    })();

    const reqs = await waitForStdinRequests(mockProc, 1);
    writeResponse(mockProc, reqs[0].id as number, {});
    const reqs2 = await waitForStdinRequests(mockProc, 2);
    expect(reqs2[1].method).toBe("thread/start");
    expect(reqs2[1].params).toMatchObject({
      baseInstructions: "You are a helpful assistant.",
      cwd: "/test/workspace",
      model: "gpt-4.1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      dynamicTools: [],
    });

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
});

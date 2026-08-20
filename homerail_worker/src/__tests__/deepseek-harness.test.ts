import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import {
  DeepSeekHarnessAdapter,
  _deepSeekHarnessForkCommitForTest,
  _readDeepSeekHarnessToolJsonForTest,
} from "../agent/deepseek-harness.js";
import { AgentTurnController } from "../agent/turn-controller.js";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";

const fakeRuntime = fileURLToPath(new URL("./fixtures/fake-dsh-runtime.mjs", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "homerail-dsh-test-"));
  tempRoots.push(root);
  return root;
}

function context(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    provider: "deepseek",
    protocol: "openai_compatible",
    model: "test-model",
    apiKey: "test-secret",
    baseUrl: "https://example.invalid/v1/chat/completions/",
    workspace: process.cwd(),
    sessionId: "session-under-test",
    ...overrides,
  };
}

async function collect(
  adapter: DeepSeekHarnessAdapter,
  runContext: AgentRunContext,
  tools: DagToolDefinition[] = [],
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run("do the work", tools, runContext)) events.push(event);
  return events;
}

describe("DeepSeekHarnessAdapter", () => {
  it("pins the compatible fork revision and uses the capability-aware pi-ai adapter", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const composition = readFileSync(new URL("../../dsh/homerail.cordis.yml", import.meta.url), "utf8");
    const dockerCommit = /^ARG HOMERAIL_DSH_FORK_COMMIT=([a-f0-9]{40})$/m.exec(dockerfile)?.[1];

    expect(dockerCommit).toBe(_deepSeekHarnessForkCommitForTest);
    expect(composition).toContain("@deepseek-ai/dsh-llm-pi-ai");
    expect(composition).toContain("HOMERAIL_DSH_PROVIDERS_JSON");
    expect(composition).not.toContain("@deepseek-ai/dsh-llm-deepseek");
  });

  it("maps DSH streaming, tool, usage, and completion events without leaking the Manager token", async () => {
    const root = tempRoot();
    const recordFile = join(root, "runtime.jsonl");
    const customConfig = join(root, "fork-homerail.cordis.yml");
    vi.stubEnv("HOMERAIL_WORKER_TOKEN", "manager-secret");
    vi.stubEnv("HOMERAIL_DSH_CORDIS_CONFIG", customConfig);
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      environmentVariables: {
        DSH_FAKE_RECORD_FILE: recordFile,
        HOMERAIL_WORKER_TOKEN: "context-manager-secret",
      },
    }));

    expect(events).toContainEqual({ type: "thinking", text: "checking" });
    expect(events).toContainEqual({ type: "text", text: "finished" });
    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "handoff",
      input: { port: "done", content: "ok" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      content: "accepted",
      is_error: false,
    });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "completed" });
    expect(_deepSeekHarnessForkCommitForTest).toMatch(/^[a-f0-9]{40}$/);

    const recorded = JSON.parse(readFileSync(recordFile, "utf8").trim()) as Record<string, unknown>;
    expect(recorded.managerToken).toBeUndefined();
    expect(recorded.baseUrl).toBe("https://example.invalid/v1");
    expect(recorded.cordisConfig).toBe(customConfig);
    expect(recorded.reasoningEffort).toBeUndefined();
    expect(recorded.reasoningEfforts).toBeUndefined();
    expect(recorded.apiKeyPresent).toBe(true);
    expect(recorded.params).toMatchObject({ maxTokens: 32_768 });
  });

  it("runs the generated MCP proxy through the authenticated loopback tool bridge", async () => {
    const root = tempRoot();
    const recordFile = join(root, "runtime.jsonl");
    const calls: Array<{ args: Record<string, unknown>; toolCallId?: string }> = [];
    const handoffTool: DagToolDefinition = {
      name: "handoff",
      description: "Submit a `handoff` without evaluating ${process.exit(99)}",
      input_schema: { type: "object" },
      handler: async (args, metadata) => {
        calls.push({ args, toolCallId: metadata?.tool_call_id });
        return { content: [{ type: "text", text: "accepted:done" }] };
      },
    };
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      environmentVariables: {
        DSH_FAKE_RECORD_FILE: recordFile,
        DSH_FAKE_EXERCISE_MCP: "1",
      },
    }), [handoffTool]);

    const records = readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const exercised = records.find((record) => record.mcp) as {
      mcp: {
        initialized: { serverInfo: { name: string } };
        listed: { tools: Array<{ name: string; description: string }> };
        called: { content: Array<{ text: string }>; isError: boolean };
        unknown: { content: Array<{ text: string }>; isError: boolean };
        composite: { content: Array<{ text: string }>; isError: boolean };
        unauthorized: { status: number; body: { error: string } };
      };
    };

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(exercised.mcp.initialized.serverInfo.name).toBe("homerail-tools");
    expect(exercised.mcp.listed.tools.map((tool) => tool.name)).toEqual(["handoff"]);
    expect(exercised.mcp.listed.tools[0]?.description).toBe(
      "Submit a `handoff` without evaluating ${process.exit(99)}",
    );
    expect(exercised.mcp.called).toEqual({
      content: [{ type: "text", text: "accepted:done" }],
      isError: false,
    });
    expect(exercised.mcp.unknown).toEqual({
      content: [{ type: "text", text: "Unknown tool: missing" }],
      isError: true,
    });
    expect(exercised.mcp.composite).toEqual({
      content: [{ type: "text", text: "Unknown tool: mcp__homerail__handoff" }],
      isError: true,
    });
    expect(exercised.mcp.unauthorized).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
    expect(calls).toEqual([{
      args: { port: "done", content: { ok: true } },
      toolCallId: "3",
    }]);
  });

  it("preserves split UTF-8 tool arguments and enforces the bridge limit in bytes", async () => {
    const body = Buffer.from(JSON.stringify({
      name: "handoff",
      args: { content: "中文证据" },
    }));
    const multibyteStart = body.indexOf(Buffer.from("中"));
    expect(multibyteStart).toBeGreaterThan(0);

    const request = new PassThrough();
    const parsed = _readDeepSeekHarnessToolJsonForTest(
      request as unknown as Parameters<typeof _readDeepSeekHarnessToolJsonForTest>[0],
    );
    request.write(body.subarray(0, multibyteStart + 1));
    request.end(body.subarray(multibyteStart + 1));
    await expect(parsed).resolves.toEqual({
      name: "handoff",
      args: { content: "中文证据" },
    });

    const oversizedRequest = new PassThrough();
    const oversized = _readDeepSeekHarnessToolJsonForTest(
      oversizedRequest as unknown as Parameters<typeof _readDeepSeekHarnessToolJsonForTest>[0],
      body.length - 1,
    );
    oversizedRequest.end(body);
    await expect(oversized).rejects.toThrow("request body too large");
  });

  it("passes a model-declared reasoning selector and wire mapping to DSH", async () => {
    const root = tempRoot();
    const recordFile = join(root, "runtime.jsonl");
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    await collect(adapter, context({
      reasoningEffort: "medium",
      reasoningEffortMap: { off: null, medium: "balanced", high: "deep" },
      environmentVariables: { DSH_FAKE_RECORD_FILE: recordFile },
    }));

    const recorded = JSON.parse(readFileSync(recordFile, "utf8").trim()) as Record<string, unknown>;
    expect(recorded.reasoningEffort).toBe("medium");
    expect(recorded.reasoningEfforts).toEqual({ off: null, medium: "balanced", high: "deep" });
  });

  it("rejects a reasoning selector the selected model did not declare", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });

    const events = await collect(adapter, context({
      reasoningEffort: "ultra",
      reasoningEffortMap: { off: null, medium: "balanced" },
    }));
    expect(events).toContainEqual({
      type: "error",
      message: "DeepSeek Harness failed: DeepSeek Harness model does not declare reasoning effort 'ultra'",
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("allows an explicit bounded per-request output token limit", async () => {
    const root = tempRoot();
    const recordFile = join(root, "runtime.jsonl");
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
      maxTokens: 16_384,
    });
    await collect(adapter, context({
      environmentVariables: { DSH_FAKE_RECORD_FILE: recordFile },
    }));

    const recorded = JSON.parse(readFileSync(recordFile, "utf8").trim()) as Record<string, unknown>;
    expect(recorded.params).toMatchObject({ maxTokens: 16_384 });
  });

  it("routes queued live steering through the fork session/steer method", async () => {
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const eventsPromise = collect(adapter, context({
      turnController: controller,
      environmentVariables: { DSH_FAKE_WAIT_FOR: "steer" },
    }));
    const receipt = controller.steer({ commandId: "redirect", content: "change direction" });
    expect(receipt.status).toBe("accepted");
    if (receipt.status !== "accepted") throw new Error("steer was not accepted");

    await expect(receipt.accepted).resolves.toEqual({ status: "accepted" });
    await expect(receipt.applied).resolves.toEqual({ status: "applied" });
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("done");
    await controller.close({ outcome: "completed" });
  });

  it("projects only the explicitly allowed HomeRail-managed read tools into DSH MCP", async () => {
    const workspace = tempRoot();
    mkdirSync(join(workspace, "repository"));
    writeFileSync(join(workspace, "repository", "README.md"), "fixture\n");
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      workspace,
      allowedBuiltinTools: ["Read", "Grep", "Glob", "LS"],
      workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
      maxBuiltinToolCalls: 12,
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "debug",
      source: "deepseek-harness",
      message: "runtime_prepared",
      data: expect.objectContaining({
        tool_count: 4,
        builtin_tools: ["Read", "Grep", "Glob", "LS"],
        max_builtin_tool_calls: 12,
      }),
    }));
  });

  it("does not impose a built-in read budget unless the workflow requests one", async () => {
    const workspace = tempRoot();
    mkdirSync(join(workspace, "repository"));
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      workspace,
      allowedBuiltinTools: ["Read"],
      workspaceAccess: { writable_paths: [], readonly_paths: ["repository"] },
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "debug",
      source: "deepseek-harness",
      data: expect.objectContaining({ max_builtin_tool_calls: null }),
    }));
  });

  it("surfaces structured DSH turn failures as actionable agent errors", async () => {
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const events = await collect(adapter, context({
      environmentVariables: { DSH_FAKE_TURN_ERROR: "provider connection refused" },
    }));

    expect(events).toContainEqual({
      type: "error",
      message: "DeepSeek Harness turn failed [UPSTREAM_REJECTED] (HTTP 502): provider connection refused",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "error" });
  });

  it("uses cooperative session cancellation for an active DSH turn", async () => {
    const root = tempRoot();
    const readyFile = join(root, "ready");
    const controller = new AgentTurnController({ capabilities: { liveSteer: true } });
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const eventsPromise = collect(adapter, context({
      turnController: controller,
      environmentVariables: {
        DSH_FAKE_WAIT_FOR: "cancel",
        DSH_FAKE_READY_FILE: readyFile,
      },
    }));
    await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));
    const bindingProbe = controller.steer({
      commandId: "cancel-binding-probe",
      content: "remain active until cancelled",
    });
    expect(bindingProbe.status).toBe("accepted");
    if (bindingProbe.status !== "accepted") throw new Error("binding probe was not accepted");
    await expect(bindingProbe.applied).resolves.toEqual({ status: "applied" });

    await expect(controller.interrupt("stop now")).resolves.toEqual({ status: "interrupted" });
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "cancelled" });
    await controller.close({ outcome: "failed", reason: "cancelled" });
  });

  it("does not leak a close rejection when abort cancellation fails", async () => {
    const root = tempRoot();
    const readyFile = join(root, "ready");
    const abortController = new AbortController();
    const adapter = new DeepSeekHarnessAdapter({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
    });
    const originalClose = DeepSeekHarness.prototype.close;
    const closeSpy = vi.spyOn(DeepSeekHarness.prototype, "close")
      .mockImplementationOnce(async () => {
        throw new Error("simulated close failure");
      })
      .mockImplementation(function (this: DeepSeekHarness) {
        return originalClose.call(this);
      });
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", captureUnhandled);

    try {
      const eventsPromise = collect(adapter, context({
        abortSignal: abortController.signal,
        environmentVariables: {
          DSH_FAKE_WAIT_FOR: "cancel",
          DSH_FAKE_CANCEL_ERROR: "cancel transport failed",
          DSH_FAKE_READY_FILE: readyFile,
        },
      }));
      await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));
      abortController.abort();

      const events = await eventsPromise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.at(-1)).toMatchObject({ type: "done", finish_reason: "cancelled" });
      expect(closeSpy).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
      closeSpy.mockRestore();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexLiveVoiceRuntime,
  type CodexLiveVoiceRuntimeEvent,
} from "../src/server/codex-live-voice-runtime.js";
import type {
  CodexAppServerClient,
  CodexAppServerMessage,
} from "../src/server/codex-appserver-client.js";
import { _clearCodexThreadLeasesForTest } from "../src/server/codex-thread-lease.js";

class FakeCodexClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly responses: Array<{ id: string | number; result: Record<string, unknown> }> = [];
  listener?: (message: CodexAppServerMessage) => void;
  closed = false;

  onMessage(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async start(): Promise<void> {}

  async initialize(): Promise<Record<string, unknown>> {
    return {};
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.requests.push({ method, params });
    if (method === "thread/list") return { data: [] };
    if (method === "thread/start") return { thread: { id: "thread-live-1" } };
    if (method === "thread/realtime/start") {
      this.listener?.({
        jsonrpc: "2.0",
        method: "thread/realtime/sdp",
        params: { threadId: "thread-live-1", sdp: "answer-sdp" },
      });
    }
    return {};
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.responses.push({ id, result });
  }

  respondError(): void {}

  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  _clearCodexThreadLeasesForTest();
});

describe("CodexLiveVoiceRuntime", () => {
  it("starts a persistent v3 WebRTC session with the fixed handoff contract", async () => {
    const fake = new FakeCodexClient();
    const events: CodexLiveVoiceRuntimeEvent[] = [];
    const runtime = new CodexLiveVoiceRuntime({
      sessionId: "voice-session-1",
      cwd: "/workspace",
      model: "gpt-5.6",
      voice: "juniper",
      systemPrompt: "trusted instructions",
      tools: [],
      initialItems: [{ role: "user", text: "recent context" }],
      clientFactory: () => fake as unknown as CodexAppServerClient,
      onEvent: event => events.push(event),
    });

    await expect(runtime.start("offer-sdp")).resolves.toBe("answer-sdp");

    const realtime = fake.requests.find(request => request.method === "thread/realtime/start");
    expect(realtime?.params).toMatchObject({
      threadId: "thread-live-1",
      version: "v3",
      outputModality: "audio",
      transport: { type: "webrtc", sdp: "offer-sdp" },
      includeStartupContext: true,
      flushTranscriptTailOnSessionEnd: false,
      clientManagedHandoffs: false,
      codexResponseHandoffMode: "bemTags",
      voice: "juniper",
      initialItems: [{ role: "user", text: "recent context" }],
    });

    await runtime.appendText("hello from the composer");
    expect(fake.requests).toContainEqual({
      method: "thread/realtime/appendText",
      params: {
        threadId: "thread-live-1",
        role: "user",
        text: "hello from the composer",
      },
    });
    await runtime.stop();
    expect(fake.closed).toBe(true);
  });

  it("executes dynamic HomeRail tools only through the background Codex thread", async () => {
    const fake = new FakeCodexClient();
    const handler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "tool result" }],
    }));
    const runtime = new CodexLiveVoiceRuntime({
      sessionId: "voice-session-tool",
      cwd: "/workspace",
      model: "gpt-5.6",
      systemPrompt: "trusted instructions",
      tools: [{
        name: "inspect_workspace",
        description: "Inspect the current workspace",
        input_schema: { type: "object" },
        handler,
      }],
      clientFactory: () => fake as unknown as CodexAppServerClient,
      onEvent: () => undefined,
    });
    await runtime.start("offer-sdp");

    fake.listener?.({
      jsonrpc: "2.0",
      id: 41,
      method: "item/tool/call",
      params: {
        tool: "inspect_workspace",
        callId: "call-1",
        arguments: { scope: "current" },
      },
    });
    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));

    expect(handler).toHaveBeenCalledWith(
      { scope: "current" },
      { tool_call_id: "call-1" },
    );
    expect(fake.responses[0]).toEqual({
      id: 41,
      result: {
        contentItems: [{ type: "inputText", text: "tool result" }],
        success: true,
      },
    });
    await runtime.stop();
  });

  it("rejects a second Live owner for the same HomeRail session", async () => {
    const firstClient = new FakeCodexClient();
    const secondClient = new FakeCodexClient();
    const createRuntime = (client: FakeCodexClient) => new CodexLiveVoiceRuntime({
      sessionId: "voice-session-exclusive",
      cwd: "/workspace",
      model: "gpt-5.6",
      systemPrompt: "trusted instructions",
      tools: [],
      clientFactory: () => client as unknown as CodexAppServerClient,
      onEvent: () => undefined,
    });
    const first = createRuntime(firstClient);
    const second = createRuntime(secondClient);

    await first.start("offer-sdp");
    await expect(second.start("second-offer")).rejects.toThrow(/already has an active Codex turn/i);
    expect(secondClient.requests).toHaveLength(0);
    await first.stop();
  });

  it("surfaces realtime startup errors instead of waiting for the SDP timeout", async () => {
    const fake = new FakeCodexClient();
    fake.request = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      fake.requests.push({ method, params });
      if (method === "thread/list") return { data: [] };
      if (method === "thread/start") return { thread: { id: "thread-live-error" } };
      if (method === "thread/realtime/start") {
        fake.listener?.({
          jsonrpc: "2.0",
          method: "thread/realtime/error",
          params: {
            threadId: "thread-live-error",
            message: "Realtime is unavailable for this account",
          },
        });
      }
      return {};
    };
    const events: CodexLiveVoiceRuntimeEvent[] = [];
    const runtime = new CodexLiveVoiceRuntime({
      sessionId: "voice-session-startup-error",
      cwd: "/workspace",
      model: "gpt-5.6",
      systemPrompt: "trusted instructions",
      tools: [],
      clientFactory: () => fake as unknown as CodexAppServerClient,
      onEvent: event => events.push(event),
    });

    await expect(runtime.start("offer-sdp")).rejects.toThrow(
      "Realtime is unavailable for this account",
    );
    expect(events).toContainEqual({
      type: "session.error",
      message: "Realtime is unavailable for this account",
    });
    expect(fake.closed).toBe(true);
  });

  it("closes the runtime before a new handoff can use changed tool permissions", async () => {
    const fake = new FakeCodexClient();
    const events: CodexLiveVoiceRuntimeEvent[] = [];
    const runtime = new CodexLiveVoiceRuntime({
      sessionId: "voice-session-schema-change",
      cwd: "/workspace",
      model: "gpt-5.6",
      systemPrompt: "trusted instructions",
      tools: [],
      clientFactory: () => fake as unknown as CodexAppServerClient,
      isToolSchemaCurrent: () => false,
      onEvent: event => events.push(event),
    });
    await runtime.start("offer-sdp");

    fake.listener?.({
      jsonrpc: "2.0",
      method: "thread/realtime/itemAdded",
      params: {
        threadId: "thread-live-1",
        item: { type: "handoff_request" },
      },
    });
    await vi.waitFor(() => expect(fake.closed).toBe(true));

    expect(events).toContainEqual({
      type: "session.error",
      message: "HomeRail Manager tools or permissions changed. Reconnect Live Voice to continue.",
    });
    expect(events.some(event => event.type === "handoff")).toBe(false);
  });

  it("turns tool-schema inspection failures into a session error and closes safely", async () => {
    const fake = new FakeCodexClient();
    const events: CodexLiveVoiceRuntimeEvent[] = [];
    const runtime = new CodexLiveVoiceRuntime({
      sessionId: "voice-session-schema-error",
      cwd: "/workspace",
      model: "gpt-5.6",
      systemPrompt: "trusted instructions",
      tools: [],
      clientFactory: () => fake as unknown as CodexAppServerClient,
      isToolSchemaCurrent: async () => {
        throw new Error("tool permission snapshot is unavailable");
      },
      onEvent: event => events.push(event),
    });
    await runtime.start("offer-sdp");

    fake.listener?.({
      jsonrpc: "2.0",
      method: "thread/realtime/itemAdded",
      params: {
        threadId: "thread-live-1",
        item: { type: "delegation_request" },
      },
    });
    await vi.waitFor(() => expect(fake.closed).toBe(true));

    expect(events).toContainEqual({
      type: "session.error",
      message: "tool permission snapshot is unavailable",
    });
    expect(events.some(event => event.type === "handoff")).toBe(false);
  });
});

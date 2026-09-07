import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const liveMocks = vi.hoisted(() => {
  const state = {
    bindingSignal: undefined as AbortSignal | undefined,
    abortObservedByStop: false,
    runtimeStart: vi.fn(async () => undefined),
    runtimeStop: vi.fn(async () => undefined),
  };
  state.runtimeStop = vi.fn(async () => {
    state.abortObservedByStop = state.bindingSignal?.aborted === true;
  });
  return state;
});

vi.mock("../src/server/voice-agent-bootstrap.js", () => ({
  createCodexLiveVoiceBinding: vi.fn(async (input: { abortSignal?: AbortSignal }) => {
    liveMocks.bindingSignal = input.abortSignal;
    const workspace = () => ({ session_id: "live-abort-test" });
    return {
      session_id: "live-abort-test",
      cwd: "/tmp",
      model: "test-model",
      voice: "test-voice",
      system_prompt: "test",
      tools: [],
      skill_roots: [],
      initial_items: [],
      environment: {},
      workspace,
      record_transcript: workspace,
      record_manager_started: workspace,
      record_manager_progress: workspace,
      record_manager_completed: workspace,
      record_error: workspace,
      flush_tool_state: workspace,
      is_tool_schema_current: () => true,
    };
  }),
}));

vi.mock("../src/server/codex-live-voice-runtime.js", () => ({
  CodexLiveVoiceRuntime: class {
    start = liveMocks.runtimeStart;
    stop = liveMocks.runtimeStop;
  },
}));

import {
  _clearCodexLiveVoiceServerStateForTest,
  codexLiveVoiceTicketRoutesHandler,
  setupCodexLiveVoiceWebSocket,
} from "../src/server/codex-live-voice-server.js";
import { createPluginHttpTrustPolicy } from "../src/server/plugin-http-trust.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

describe("Codex Live Voice browser-tool cancellation", () => {
  let server: http.Server | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.close();
    if (server) await closeServer(server);
    _clearCodexLiveVoiceServerStateForTest();
    liveMocks.bindingSignal = undefined;
    liveMocks.abortObservedByStop = false;
    liveMocks.runtimeStart.mockClear();
    liveMocks.runtimeStop.mockClear();
  });

  it("aborts the binding signal before stopping runtime when its browser disconnects", async () => {
    server = http.createServer((req, res) => {
      if (!codexLiveVoiceTicketRoutesHandler(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    setupCodexLiveVoiceWebSocket(server, {
      trustPolicy: createPluginHttpTrustPolicy({
        bindHost: "127.0.0.1",
        allowedOrigins: "http://allowed.test",
      }),
    });
    const port = await listen(server);
    const ticketResponse = await fetch(
      `http://127.0.0.1:${port}/api/voice-agent/sessions/live-abort-test/live-ticket`,
      { method: "POST" },
    );
    const ticketBody = await ticketResponse.json() as { data: { ticket: string } };

    socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice-agent/sessions/live-abort-test/live`,
      { origin: "http://allowed.test" },
    );
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    let response = nextMessage(socket);
    socket.send(JSON.stringify({ type: "authenticate", ticket: ticketBody.data.ticket }));
    await expect(response).resolves.toMatchObject({ type: "ready" });

    socket.send(JSON.stringify({
      type: "start",
      sdp: "test-offer",
      browser_tools_transport: "none",
    }));
    await vi.waitFor(() => expect(liveMocks.runtimeStart).toHaveBeenCalledOnce());
    expect(liveMocks.bindingSignal?.aborted).toBe(false);

    const closed = new Promise<void>((resolve) => socket!.once("close", () => resolve()));
    socket.close(1000, "test disconnect");
    await closed;
    await vi.waitFor(() => expect(liveMocks.runtimeStop).toHaveBeenCalled());

    expect(liveMocks.bindingSignal?.aborted).toBe(true);
    expect(liveMocks.abortObservedByStop).toBe(true);
    expect(liveMocks.runtimeStop).toHaveBeenCalledOnce();
  });
});

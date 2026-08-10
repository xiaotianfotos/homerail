import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const liveMocks = vi.hoisted(() => ({
  appendAudio: vi.fn(),
  appendText: vi.fn(async () => undefined),
  endAudio: vi.fn(),
  stop: vi.fn(async () => undefined),
  runtimeOptions: undefined as Record<string, any> | undefined,
}));

vi.mock("../src/persistence/manager-agent-config.js", () => ({
  readManagerAgentConfig: () => ({
    harness: "kimi_code",
    provider_name: "gemini",
    llm_setting_id: "gemini-setting",
  }),
}));

vi.mock("../src/server/voice-agent-bootstrap.js", () => ({
  createCodexLiveVoiceBinding: vi.fn(async () => {
    const workspace = () => ({ session_id: "gemini-live-server" });
    return {
      backend: "gemini",
      session_id: "gemini-live-server",
      cwd: "/tmp",
      model: "gemini-live-model",
      voice: "Aoede",
      api_key: "test-key",
      provider: "gemini",
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

vi.mock("../src/server/gemini-live-voice-runtime.js", () => ({
  GeminiLiveVoiceRuntime: class {
    constructor(options: Record<string, any>) {
      liveMocks.runtimeOptions = options;
    }
    appendAudio = liveMocks.appendAudio;
    appendText = liveMocks.appendText;
    endAudio = liveMocks.endAudio;
    stop = liveMocks.stop;
    async start() {
      liveMocks.runtimeOptions?.onEvent({
        type: "session.started",
        thread_id: "gemini-live-server",
        version: "test",
      });
    }
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

async function nextMessage(socket: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => resolve({ data: Buffer.from(data as Buffer), binary }));
    socket.once("error", reject);
  });
}

describe("Gemini Live browser relay", () => {
  let server: http.Server | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.close();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    _clearCodexLiveVoiceServerStateForTest();
    liveMocks.appendAudio.mockClear();
    liveMocks.appendText.mockClear();
    liveMocks.endAudio.mockClear();
    liveMocks.stop.mockClear();
    liveMocks.runtimeOptions = undefined;
  });

  it("routes binary browser PCM to Gemini and binary output back to the browser", async () => {
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
      `http://127.0.0.1:${port}/api/voice-agent/sessions/gemini-live-server/live-ticket`,
      { method: "POST" },
    );
    const ticket = (await ticketResponse.json() as { data: { ticket: string } }).data.ticket;

    socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice-agent/sessions/gemini-live-server/live`,
      { origin: "http://allowed.test" },
    );
    await new Promise<void>((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });
    let response = nextMessage(socket);
    socket.send(JSON.stringify({ type: "authenticate", ticket }));
    const ready = await response;
    expect(JSON.parse(ready.data.toString())).toMatchObject({ type: "ready", backend: "gemini" });

    response = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "start",
      transport: "pcm_s16le",
      browser_tools_transport: "none",
    }));
    const started = await response;
    expect(JSON.parse(started.data.toString())).toMatchObject({ type: "session.started" });

    const input = Buffer.from([1, 2, 3, 4]);
    socket.send(input);
    await vi.waitFor(() => expect(liveMocks.appendAudio).toHaveBeenCalledWith(input));

    const output = Buffer.from([5, 6, 7, 8]);
    response = nextMessage(socket);
    liveMocks.runtimeOptions?.onAudio(output);
    const relayed = await response;
    expect(relayed.binary).toBe(true);
    expect(relayed.data).toEqual(output);

    response = nextMessage(socket);
    socket.send(JSON.stringify({ type: "mute", muted: true }));
    const muted = await response;
    expect(JSON.parse(muted.data.toString())).toEqual({ type: "session.muted", muted: true });
    expect(liveMocks.endAudio).toHaveBeenCalledOnce();
  });
});

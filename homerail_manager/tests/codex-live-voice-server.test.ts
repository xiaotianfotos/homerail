import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", raw => {
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

describe("Codex Live Voice ticket and Origin boundary", () => {
  let server: http.Server | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    if (server) await close(server);
    server = undefined;
    sockets.length = 0;
    _clearCodexLiveVoiceServerStateForTest();
  });

  it("accepts one trusted-origin owner and rejects ticket reuse", async () => {
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
    const response = await fetch(
      `http://127.0.0.1:${port}/api/voice-agent/sessions/voice-ticket-test/live-ticket`,
      { method: "POST" },
    );
    const body = await response.json() as { data: { ticket: string } };

    const first = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice-agent/sessions/voice-ticket-test/live`,
      { origin: "http://allowed.test" },
    );
    sockets.push(first);
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    const readyPromise = nextMessage(first);
    first.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));
    await expect(readyPromise).resolves.toMatchObject({ type: "ready" });

    const reused = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice-agent/sessions/voice-ticket-test/live`,
      { origin: "http://allowed.test" },
    );
    sockets.push(reused);
    await new Promise<void>((resolve, reject) => {
      reused.once("open", resolve);
      reused.once("error", reject);
    });
    const closed = new Promise<number>(resolve => reused.once("close", code => resolve(code)));
    reused.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));
    await expect(closed).resolves.toBe(4401);
  });

  it("rejects a WebSocket from an untrusted Origin before authentication", async () => {
    server = http.createServer();
    setupCodexLiveVoiceWebSocket(server, {
      trustPolicy: createPluginHttpTrustPolicy({
        bindHost: "127.0.0.1",
        allowedOrigins: "http://allowed.test",
      }),
    });
    const port = await listen(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/voice-agent/sessions/voice-origin-test/live`,
      { origin: "http://evil.test" },
    );
    sockets.push(socket);

    const rejected = new Promise<boolean>(resolve => {
      socket.once("unexpected-response", () => resolve(true));
      socket.once("error", () => resolve(true));
      socket.once("close", () => resolve(true));
    });
    await expect(rejected).resolves.toBe(true);
  });
});

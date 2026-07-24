import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function issueTicket(port: number, sessionId: string): Promise<Response> {
  return await fetch(
    `http://127.0.0.1:${port}/api/voice-agent/sessions/${sessionId}/live-ticket`,
    { method: "POST" },
  );
}

async function openTrustedSocket(port: number, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/voice-agent/sessions/${sessionId}/live`,
    { origin: "http://allowed.test" },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function ticketServer(authTimeoutMs?: number): http.Server {
  const server = http.createServer((req, res) => {
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
    authTimeoutMs,
  });
  return server;
}

describe("Codex Live Voice ticket and Origin boundary", () => {
  let server: http.Server | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    if (server) await close(server);
    server = undefined;
    sockets.length = 0;
    vi.useRealTimers();
    _clearCodexLiveVoiceServerStateForTest();
  });

  it("accepts one trusted-origin owner and rejects ticket reuse", async () => {
    server = ticketServer();
    const port = await listen(server);
    const response = await issueTicket(port, "voice-ticket-test");
    const body = await response.json() as { data: { ticket: string } };

    const first = await openTrustedSocket(port, "voice-ticket-test");
    sockets.push(first);
    const readyPromise = nextMessage(first);
    first.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));
    await expect(readyPromise).resolves.toMatchObject({ type: "ready" });

    const reused = await openTrustedSocket(port, "voice-ticket-test");
    sockets.push(reused);
    const closed = new Promise<number>(resolve => reused.once("close", code => resolve(code)));
    reused.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));
    await expect(closed).resolves.toBe(4401);
  });

  it("rejects a ticket issued for a different session", async () => {
    server = ticketServer();
    const port = await listen(server);
    const response = await issueTicket(port, "voice-session-a");
    const body = await response.json() as { data: { ticket: string } };
    const socket = await openTrustedSocket(port, "voice-session-b");
    sockets.push(socket);

    const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    socket.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));

    await expect(closed).resolves.toBe(4401);
  });

  it("rejects an expired ticket", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
    server = ticketServer();
    const port = await listen(server);
    const response = await issueTicket(port, "voice-expired-ticket");
    const body = await response.json() as { data: { ticket: string } };
    vi.setSystemTime(new Date("2026-07-24T00:01:01Z"));
    const socket = await openTrustedSocket(port, "voice-expired-ticket");
    sockets.push(socket);

    const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
    socket.send(JSON.stringify({ type: "authenticate", ticket: body.data.ticket }));

    await expect(closed).resolves.toBe(4401);
  });

  it("bounds outstanding tickets per session", async () => {
    server = ticketServer();
    const port = await listen(server);
    for (let index = 0; index < 8; index += 1) {
      await expect(issueTicket(port, "voice-ticket-cap")).resolves.toMatchObject({ status: 200 });
    }

    await expect(issueTicket(port, "voice-ticket-cap")).resolves.toMatchObject({ status: 429 });
  });

  it("rejects pre-authentication messages and closes idle authentication attempts", async () => {
    server = ticketServer(20);
    const port = await listen(server);

    const premature = await openTrustedSocket(port, "voice-premature-message");
    sockets.push(premature);
    const prematureClosed = new Promise<number>(
      resolve => premature.once("close", code => resolve(code)),
    );
    premature.send(JSON.stringify({ type: "start", sdp: "offer" }));
    await expect(prematureClosed).resolves.toBe(4401);

    const idle = await openTrustedSocket(port, "voice-auth-timeout");
    sockets.push(idle);
    const idleClosed = new Promise<number>(resolve => idle.once("close", code => resolve(code)));
    await expect(idleClosed).resolves.toBe(4401);
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

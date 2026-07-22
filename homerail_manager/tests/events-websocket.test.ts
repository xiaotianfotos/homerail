import * as http from "node:http";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { _clearListeners, emit } from "../src/events/bus.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 5000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.once("error", reject);
  });
}

function sendInvalidUnmaskedWebSocketFrame(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let upgraded = false;
    let finished = false;
    let response = "";
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write([
        "GET /ws/events HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    const done = (err?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => done(new Error("invalid websocket frame test timed out")), 5000);
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!upgraded && response.includes("\r\n\r\n")) {
        if (!response.includes(" 101 ")) {
          done(new Error(`websocket upgrade failed: ${response}`));
          return;
        }
        upgraded = true;
        socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
      }
    });
    socket.on("close", () => done());
    socket.on("error", (err) => {
      if (upgraded) done();
      else done(err);
    });
  });
}

describe("/ws/events", () => {
  let server: http.Server;

  beforeEach(() => {
    _clearListeners();
    server = createServer(0, undefined, undefined, false);
  });

  afterEach(async () => {
    _clearListeners();
    await close(server);
  });

  it("streams typed DAG events to browser clients", async () => {
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);

    const hello = await nextMessage(ws);
    expect(hello.type).toBe("manager:events_connected");

    const eventPromise = nextMessage(ws);
    emit("dag:run_created", { runId: "run-public-agent-ui", workflowId: "public-agent-ui", nodeCount: 2 });
    const event = await eventPromise;

    expect(event.type).toBe("dag:run_created");
    expect(event.event).toBe("dag:run_created");
    expect(event.payload).toMatchObject({
      runId: "run-public-agent-ui",
      workflowId: "public-agent-ui",
      nodeCount: 2,
    });

    ws.close();
  });

  it("streams ephemeral node chat invalidations to browser clients", async () => {
    const port = await listen(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);

    await nextMessage(ws);
    const eventPromise = nextMessage(ws);
    emit("dag:node_chat_updated", {
      runId: "run-live-chat",
      nodeId: "review",
      timestamp: new Date().toISOString(),
    });
    const event = await eventPromise;

    expect(event.type).toBe("dag:node_chat_updated");
    expect(event.payload).toMatchObject({
      runId: "run-live-chat",
      nodeId: "review",
    });

    ws.close();
  });

  it("closes malformed browser event sockets without crashing the manager", async () => {
    const port = await listen(server);

    await sendInvalidUnmaskedWebSocketFrame(port);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  });
});

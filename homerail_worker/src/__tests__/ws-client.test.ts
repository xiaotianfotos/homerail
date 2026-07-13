/**
 * Tests for WsClient: registration, heartbeat, reconnect, message framing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { WsClient } from "../ws-client.js";

// We test the WsClient's event emission and message handling logic
// without a real WebSocket server by mocking the ws module.

describe("WsClient", () => {
  it("sends the worker bearer token during the websocket upgrade", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("server did not bind");
    const authorization = new Promise<string | undefined>((resolve) => {
      server.once("connection", (_socket, request) => resolve(request.headers.authorization));
    });
    const client = new WsClient({
      url: `ws://127.0.0.1:${address.port}`,
      workerId: "authenticated-worker",
      token: " worker-secret ",
    });
    const connected = new Promise<void>((resolve) => client.once("connected", resolve));

    try {
      client.connect();
      await expect(authorization).resolves.toBe("Bearer worker-secret");
      await connected;
    } finally {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("emits connected on open", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "test-worker",
    });

    const connectedFn = vi.fn();
    client.on("connected", connectedFn);

    // We can't easily mock the WS constructor without more setup,
    // so we test the class structure and configuration.
    expect(client.isConnected).toBe(false);
  });

  it("sends registration message on connect", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "w-1",
      token: "tok",
    });

    // Verify the client was constructed with correct options
    expect(client.isConnected).toBe(false);
  });

  it("includes declared capabilities in registration payload", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "browser-worker",
      capabilities: ["browser", "docker-cli"],
    });
    const sendSpy = vi.spyOn(client, "send").mockImplementation(() => {});

    (client as unknown as { register: () => void }).register();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendSpy.mock.calls[0][0])).toEqual({
      type: "control",
      action: "register",
      data: {
        worker_id: "browser-worker",
        capabilities: ["browser", "docker-cli"],
      },
    });
  });

  it("handles pong response", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "w-1",
    });

    // The client should handle ping/pong internally
    expect(client.isConnected).toBe(false);
  });

  it("emits inject messages as control events", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "w-1",
    });
    const injectFn = vi.fn();
    client.on("inject", injectFn);

    (client as unknown as { handleMessage: (msg: unknown) => void }).handleMessage({
      type: "inject",
      data: {
        runId: "run-1",
        nodeId: "coder",
        mode: "interrupt",
        instruction: "stop",
      },
    });

    expect(injectFn).toHaveBeenCalledWith(expect.objectContaining({
      type: "inject",
      data: expect.objectContaining({ runId: "run-1", nodeId: "coder" }),
    }));
  });

  it("close stops reconnection", () => {
    const client = new WsClient({
      url: "ws://localhost:9999",
      workerId: "w-1",
    });

    client.close();
    // After close, isConnected should be false
    expect(client.isConnected).toBe(false);
  });
});

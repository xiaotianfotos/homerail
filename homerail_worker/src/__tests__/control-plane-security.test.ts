import { describe, expect, it } from "vitest";

import { assertSecureControlPlaneUrl } from "../control-plane-security.js";

describe("worker control-plane transport policy", () => {
  it("allows encrypted remote and local development websocket URLs", () => {
    expect(() => assertSecureControlPlaneUrl("wss://manager.example.test/ws")).not.toThrow();
    expect(() => assertSecureControlPlaneUrl("ws://127.0.0.1:19191/ws")).not.toThrow();
    expect(() => assertSecureControlPlaneUrl("ws://host.docker.internal:19191/ws")).not.toThrow();
  });

  it("rejects insecure remote websocket URLs unless explicitly allowed", () => {
    expect(() => assertSecureControlPlaneUrl("ws://192.0.2.20:19191/ws"))
      .toThrow("Remote Manager WebSocket connections require wss://");
    expect(() => assertSecureControlPlaneUrl("ws://192.0.2.20:19191/ws", true)).not.toThrow();
    expect(() => assertSecureControlPlaneUrl("https://manager.example.test/ws"))
      .toThrow("must use ws:// or wss://");
  });
});

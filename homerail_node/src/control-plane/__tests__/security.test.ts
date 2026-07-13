import { describe, expect, it } from "vitest";

import { assertSecureControlPlaneUrl } from "../security.js";

describe("node control-plane transport policy", () => {
  it("allows wss and local websocket URLs", () => {
    expect(() => assertSecureControlPlaneUrl("wss://manager.example.test/ws")).not.toThrow();
    expect(() => assertSecureControlPlaneUrl("ws://localhost:19191/ws")).not.toThrow();
    expect(() => assertSecureControlPlaneUrl("ws://[::1]:19191/ws")).not.toThrow();
  });

  it("fails closed for remote plaintext websocket URLs", () => {
    expect(() => assertSecureControlPlaneUrl("ws://manager.example.test/ws"))
      .toThrow("Remote Manager WebSocket connections require wss://");
    expect(() => assertSecureControlPlaneUrl("ws://manager.example.test/ws", true)).not.toThrow();
  });
});

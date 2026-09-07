import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  BROWSER_RENDERER_TOOLS_TICKET_TTL_MS,
  BROWSER_TOOLS_CAPABILITIES,
  BROWSER_TOOLS_MAX_MESSAGE_BYTES,
  BROWSER_TOOLS_MAX_RESULT_BYTES,
  BROWSER_TOOLS_PROTOCOL_VERSION,
  HOMERAIL_UI_TOOL_CONTRACTS,
  uiToolContractDigest,
  type BrowserRendererConnectionRefV1,
  type BrowserRendererTargetV1,
} from "homerail-protocol";

import { BrowserRendererToolsBroker } from "../src/server/browser-renderer-tools-websocket.js";
import { createPluginHttpTrustPolicy } from "../src/server/plugin-http-trust.js";

interface Harness {
  server: Server;
  broker: BrowserRendererToolsBroker;
  port: number;
  origin: string;
  requestAuthority: string;
  wsUrl: string;
}

const sockets = new Set<WebSocket>();
let harness: Harness | null = null;

function target(
  tabId = "tab-a",
  navigationId = "navigation-a",
): BrowserRendererTargetV1 {
  return {
    ui_session_id: "ui-session-a",
    tab_id: tabId,
    navigation_id: navigationId,
  };
}

function contractBindings(): Array<{ name: string; contract_digest: string }> {
  return HOMERAIL_UI_TOOL_CONTRACTS.map((contract) => ({
    name: contract.name,
    contract_digest: uiToolContractDigest(contract),
  }));
}

function authMessage(
  ticket: string,
  pageTarget: BrowserRendererTargetV1,
  contracts: unknown = contractBindings(),
): Record<string, unknown> {
  return {
    type: "auth.ticket",
    version: BROWSER_TOOLS_PROTOCOL_VERSION,
    ticket,
    ...pageTarget,
    contracts,
  };
}

async function startHarness(options: {
  allowedOrigins?: string;
  heartbeatIntervalMs?: number;
} = {}): Promise<Harness> {
  const server = createServer();
  const broker = new BrowserRendererToolsBroker();
  broker.attach(server, createPluginHttpTrustPolicy({
    bindHost: "127.0.0.1",
    allowedOrigins: options.allowedOrigins,
  }), options.heartbeatIntervalMs);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing renderer test server address");
  const origin = `http://127.0.0.1:${address.port}`;
  harness = {
    server,
    broker,
    port: address.port,
    origin,
    requestAuthority: `direct:${origin}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws/browser-tools/renderer`,
  };
  return harness;
}

function trackSocket(socket: WebSocket): WebSocket {
  sockets.add(socket);
  // Expected authentication and upgrade failures must not become unhandled
  // EventEmitter errors while a test is awaiting close/response events.
  socket.on("error", () => undefined);
  return socket;
}

async function openSocket(
  activeHarness: Harness,
  options: {
    url?: string;
    origin?: string;
    headers?: Record<string, string>;
    autoPong?: boolean;
  } = {},
): Promise<WebSocket> {
  const socket = trackSocket(new WebSocket(options.url ?? activeHarness.wsUrl, {
    ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    headers: {
      Origin: options.origin ?? activeHarness.origin,
      ...options.headers,
    },
  }));
  await once(socket, "open");
  return socket;
}

function nextJson(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("timed out waiting for renderer message")), timeoutMs);
    timer.unref?.();
    const onMessage = (raw: Buffer): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (predicate(message)) finish(undefined, message);
    };
    const onClose = (code: number): void => finish(new Error(`renderer socket closed while waiting (${code})`));
    const finish = (error?: Error, message?: Record<string, unknown>): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(message!);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function closeInfo(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function authenticate(
  activeHarness: Harness,
  pageTarget: BrowserRendererTargetV1,
  options: {
    ticket?: string;
    origin?: string;
    headers?: Record<string, string>;
    contracts?: unknown;
  } = {},
): Promise<{ socket: WebSocket; ready: Record<string, unknown>; ref: BrowserRendererConnectionRefV1 }> {
  const ticket = options.ticket
    ?? activeHarness.broker.issueTicket(
      pageTarget,
      options.origin ?? activeHarness.origin,
      activeHarness.requestAuthority,
    ).ticket;
  const socket = await openSocket(activeHarness, options);
  const readyPromise = nextJson(socket, (message) => message.type === "auth.ready");
  socket.send(JSON.stringify(authMessage(ticket, pageTarget, options.contracts)));
  const ready = await readyPromise;
  return {
    socket,
    ready,
    ref: {
      connection_id: String(ready.connection_id),
      ...pageTarget,
    },
  };
}

async function authClose(
  activeHarness: Harness,
  ticket: string,
  pageTarget: BrowserRendererTargetV1,
  options: { origin?: string; headers?: Record<string, string>; contracts?: unknown } = {},
): Promise<{ code: number; reason: string }> {
  const socket = await openSocket(activeHarness, options);
  const closed = closeInfo(socket);
  socket.send(JSON.stringify(authMessage(ticket, pageTarget, options.contracts)));
  return closed;
}

async function rejectedUpgradeStatus(
  url: string,
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = trackSocket(new WebSocket(url, {
      headers: {
        ...(options.origin ? { Origin: options.origin } : {}),
        ...options.headers,
      },
    }));
    const timer = setTimeout(() => reject(new Error("timed out waiting for rejected renderer upgrade")), 2_000);
    timer.unref?.();
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      clearTimeout(timer);
      reject(new Error("renderer upgrade unexpectedly succeeded"));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for renderer condition");
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) {
    try {
      socket.terminate();
    } catch {
      // Already closed.
    }
  }
  sockets.clear();
  if (harness?.server.listening) {
    await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
  }
  harness = null;
});

describe("Browser renderer tools WebSocket", () => {
  it("consumes a one-use ticket before rejecting a bad contract catalog", async () => {
    const activeHarness = await startHarness();
    const pageTarget = target();
    const ticket = activeHarness.broker.issueTicket(
      pageTarget,
      activeHarness.origin,
      activeHarness.requestAuthority,
    ).ticket;

    const badCatalog = contractBindings().slice(0, -1);
    await expect(authClose(activeHarness, ticket, pageTarget, { contracts: badCatalog }))
      .resolves.toMatchObject({ code: 4401, reason: "Browser renderer authentication failed" });

    await expect(authClose(activeHarness, ticket, pageTarget))
      .resolves.toMatchObject({ code: 4401, reason: "Browser renderer authentication failed" });
    expect(activeHarness.broker.connected()).toBe(false);
  });

  it("rejects an expired ticket and cannot replay it", async () => {
    const activeHarness = await startHarness();
    const pageTarget = target();
    const ticket = activeHarness.broker.issueTicket(
      pageTarget,
      activeHarness.origin,
      activeHarness.requestAuthority,
      Date.now() - BROWSER_RENDERER_TOOLS_TICKET_TTL_MS - 1,
    ).ticket;

    await expect(authClose(activeHarness, ticket, pageTarget))
      .resolves.toMatchObject({ code: 4401 });
    await expect(authClose(activeHarness, ticket, pageTarget))
      .resolves.toMatchObject({ code: 4401 });
  });

  it("binds upgrades and tickets to exact Origin, Host, and request authority", async () => {
    const activeHarness = await startHarness();

    await expect(rejectedUpgradeStatus(activeHarness.wsUrl, {
      origin: `http://localhost:${activeHarness.port}`,
    })).resolves.toBe(403);
    await expect(rejectedUpgradeStatus(activeHarness.wsUrl, {
      origin: activeHarness.origin,
      headers: { "X-Forwarded-Host": "attacker.example" },
    })).resolves.toBe(403);

    const originBoundTarget = target("tab-origin");
    const originBoundTicket = activeHarness.broker.issueTicket(
      originBoundTarget,
      `http://localhost:${activeHarness.port}`,
      activeHarness.requestAuthority,
    ).ticket;
    await expect(authClose(activeHarness, originBoundTicket, originBoundTarget))
      .resolves.toMatchObject({ code: 4401 });

    const authorityBoundTarget = target("tab-authority");
    const authorityBoundTicket = activeHarness.broker.issueTicket(
      authorityBoundTarget,
      activeHarness.origin,
      `direct:http://localhost:${activeHarness.port}`,
    ).ticket;
    await expect(authClose(activeHarness, authorityBoundTicket, authorityBoundTarget))
      .resolves.toMatchObject({ code: 4401 });

    const hostBoundTarget = target("tab-host");
    const hostOrigin = `http://localhost:${activeHarness.port}`;
    const hostBoundTicket = activeHarness.broker.issueTicket(
      hostBoundTarget,
      hostOrigin,
      `direct:${hostOrigin}`,
    ).ticket;
    const hostSocket = await openSocket(activeHarness, {
      origin: hostOrigin,
      headers: { Host: `localhost:${activeHarness.port}` },
    });
    const readyPromise = nextJson(hostSocket, (message) => message.type === "auth.ready");
    hostSocket.send(JSON.stringify(authMessage(hostBoundTicket, hostBoundTarget)));
    await expect(readyPromise).resolves.toMatchObject({
      ui_session_id: hostBoundTarget.ui_session_id,
      tab_id: hostBoundTarget.tab_id,
      navigation_id: hostBoundTarget.navigation_id,
    });
  });

  it("authenticates only the complete frozen six-contract catalog and returns bounded capabilities", async () => {
    const activeHarness = await startHarness();
    const pageTarget = target();
    const { ready, ref } = await authenticate(activeHarness, pageTarget);

    expect(HOMERAIL_UI_TOOL_CONTRACTS).toHaveLength(6);
    expect(Object.keys(ready).sort()).toEqual([
      "capabilities",
      "connection_id",
      "max_concurrent_calls",
      "max_message_bytes",
      "max_result_bytes",
      "navigation_id",
      "tab_id",
      "type",
      "ui_session_id",
      "version",
    ]);
    expect(ready).toEqual({
      type: "auth.ready",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      ...ref,
      capabilities: [...BROWSER_TOOLS_CAPABILITIES],
      max_message_bytes: BROWSER_TOOLS_MAX_MESSAGE_BYTES,
      max_result_bytes: BROWSER_TOOLS_MAX_RESULT_BYTES,
      max_concurrent_calls: 16,
    });
    expect(activeHarness.broker.requireConnection(ref)).toEqual(ref);
  });

  it("routes invocations to the exact connection when two tabs are active", async () => {
    const activeHarness = await startHarness();
    const tabA = await authenticate(activeHarness, target("tab-a", "navigation-a"));
    const tabB = await authenticate(activeHarness, target("tab-b", "navigation-b"));
    const tabBInvocations: Record<string, unknown>[] = [];
    tabB.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "tool.invoke") tabBInvocations.push(message);
    });

    const tabAInvoke = nextJson(tabA.socket, (message) => message.type === "tool.invoke");
    const tabAResult = activeHarness.broker.invoke(tabA.ref, "ui_open_surface", {
      surface: "dag_status",
      entity_id: "run-a",
    });
    const tabAMessage = await tabAInvoke;
    expect(tabAMessage).toMatchObject({
      connection_id: tabA.ref.connection_id,
      navigation_id: "navigation-a",
      tool_name: "ui_open_surface",
      input: { surface: "dag_status", entity_id: "run-a" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tabBInvocations).toHaveLength(0);
    tabA.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: tabAMessage.call_id,
      connection_id: tabA.ref.connection_id,
      navigation_id: tabA.ref.navigation_id,
      ok: true,
      terminal_state: "completed",
      output: { opened: "run-a" },
    }));
    await expect(tabAResult).resolves.toEqual({ opened: "run-a" });

    const tabBInvoke = nextJson(tabB.socket, (message) => message.type === "tool.invoke");
    const tabBResult = activeHarness.broker.invoke(tabB.ref, "ui_get_state", {});
    const tabBMessage = await tabBInvoke;
    expect(tabBMessage).toMatchObject({
      connection_id: tabB.ref.connection_id,
      navigation_id: "navigation-b",
      tool_name: "ui_get_state",
    });
    tabB.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: tabBMessage.call_id,
      connection_id: tabB.ref.connection_id,
      navigation_id: tabB.ref.navigation_id,
      ok: true,
      terminal_state: "completed",
      output: { active_tab: "tab-b" },
    }));
    await expect(tabBResult).resolves.toEqual({ active_tab: "tab-b" });
  });

  it("fails closed for a stale navigation and never falls back to another page", async () => {
    const activeHarness = await startHarness();
    const oldPage = await authenticate(activeHarness, target("tab-stale", "navigation-old"));
    let invocationCount = 0;
    oldPage.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "tool.invoke") invocationCount += 1;
    });

    await expect(activeHarness.broker.invoke({
      ...oldPage.ref,
      navigation_id: "navigation-forged",
    }, "ui_get_state", {})).rejects.toThrow("stale or unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invocationCount).toBe(0);

    const oldClosed = closeInfo(oldPage.socket);
    oldPage.socket.send(JSON.stringify({
      type: "page.invalidated",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      connection_id: oldPage.ref.connection_id,
      navigation_id: oldPage.ref.navigation_id,
      reason: "navigation",
    }));
    await expect(oldClosed).resolves.toMatchObject({ code: 4409 });

    const newPage = await authenticate(activeHarness, target("tab-stale", "navigation-new"));
    await expect(activeHarness.broker.invoke(oldPage.ref, "ui_get_state", {}))
      .rejects.toThrow("stale or unavailable");

    const newInvoke = nextJson(newPage.socket, (message) => message.type === "tool.invoke");
    const newResult = activeHarness.broker.invoke(newPage.ref, "ui_get_state", {});
    const newMessage = await newInvoke;
    newPage.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: newMessage.call_id,
      connection_id: newPage.ref.connection_id,
      navigation_id: newPage.ref.navigation_id,
      ok: true,
      terminal_state: "completed",
      output: { navigation: "new" },
    }));
    await expect(newResult).resolves.toEqual({ navigation: "new" });
  });

  it("honors every valid terminal state without conflating cancellation with uncertainty", async () => {
    const activeHarness = await startHarness();
    const page = await authenticate(activeHarness, target());

    const run = async (result: Record<string, unknown>): Promise<unknown> => {
      const invokeMessage = nextJson(page.socket, (message) => message.type === "tool.invoke");
      const invocation = activeHarness.broker.invoke(page.ref, "ui_get_state", {});
      const request = await invokeMessage;
      page.socket.send(JSON.stringify({
        type: "tool.result",
        version: BROWSER_TOOLS_PROTOCOL_VERSION,
        call_id: request.call_id,
        connection_id: page.ref.connection_id,
        navigation_id: page.ref.navigation_id,
        ...result,
      }));
      return invocation;
    };

    await expect(run({ ok: true, terminal_state: "completed", output: { ready: true } }))
      .resolves.toEqual({ ready: true });
    await expect(run({ ok: false, terminal_state: "failed", error: "renderer failed" }))
      .rejects.toThrow("renderer failed");
    await expect(run({ ok: false, terminal_state: "cancelled", error: "renderer stopped" }))
      .rejects.toThrow("HomeRail UI tool was cancelled: renderer stopped");
    await expect(run({ ok: false, terminal_state: "indeterminate", error: "side effect uncertain" }))
      .rejects.toThrow("HomeRail UI tool outcome is indeterminate: side effect uncertain");
    expect(page.socket.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    [{ ok: true, terminal_state: "failed", output: null }, "success paired with failed"],
    [{ ok: false, terminal_state: "completed", error: "impossible" }, "failure paired with completed"],
    [{ ok: false, terminal_state: "failed", output: { forbidden: true } }, "failed result carrying output"],
  ])("closes on an invalid terminal-state combination: %s (%s)", async (result) => {
    const activeHarness = await startHarness();
    const page = await authenticate(activeHarness, target());
    const invokeMessage = nextJson(page.socket, (message) => message.type === "tool.invoke");
    const invocation = activeHarness.broker.invoke(page.ref, "ui_get_state", {});
    const outcome = expect(invocation).rejects.toThrow("outcome is indeterminate");
    const request = await invokeMessage;
    const closed = closeInfo(page.socket);
    page.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: request.call_id,
      connection_id: page.ref.connection_id,
      navigation_id: page.ref.navigation_id,
      ...result,
    }));

    await expect(closed).resolves.toMatchObject({ code: 4400 });
    await outcome;
  });

  it("sends an exact cancel and accepts a renderer cancelled terminal result", async () => {
    const activeHarness = await startHarness();
    const page = await authenticate(activeHarness, target());
    vi.useFakeTimers();
    const controller = new AbortController();
    const invokeMessage = nextJson(page.socket, (message) => message.type === "tool.invoke");
    const invocation = activeHarness.broker.invoke(page.ref, "ui_get_state", {}, 5_000, controller.signal);
    const request = await invokeMessage;
    const cancelMessage = nextJson(page.socket, (message) => message.type === "tool.cancel");
    controller.abort();
    const cancel = await cancelMessage;
    expect(cancel).toEqual({
      type: "tool.cancel",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: request.call_id,
      connection_id: page.ref.connection_id,
      navigation_id: page.ref.navigation_id,
      reason: "cancelled",
    });
    page.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: request.call_id,
      connection_id: page.ref.connection_id,
      navigation_id: page.ref.navigation_id,
      ok: false,
      terminal_state: "cancelled",
      error: "aborted before commit",
    }));
    await expect(invocation).rejects.toThrow("HomeRail UI tool was cancelled: aborted before commit");
  });

  it("reports an indeterminate outcome when renderer cancellation has no terminal acknowledgement", async () => {
    const activeHarness = await startHarness();
    const page = await authenticate(activeHarness, target());
    vi.useFakeTimers();
    const controller = new AbortController();
    const invokeMessage = nextJson(page.socket, (message) => message.type === "tool.invoke");
    const invocation = activeHarness.broker.invoke(page.ref, "ui_get_state", {}, 5_000, controller.signal);
    await invokeMessage;
    const cancelMessage = nextJson(page.socket, (message) => message.type === "tool.cancel");
    controller.abort();
    await expect(cancelMessage).resolves.toMatchObject({ reason: "cancelled" });
    const outcome = expect(invocation).rejects.toThrow("outcome is indeterminate");
    await vi.advanceTimersByTimeAsync(751);
    await outcome;
    expect(page.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects over-deep JSON without leaking pending capacity or closing the valid socket", async () => {
    const activeHarness = await startHarness();
    const page = await authenticate(activeHarness, target());
    const firstInvoke = nextJson(page.socket, (message) => message.type === "tool.invoke");
    const firstResult = activeHarness.broker.invoke(page.ref, "ui_get_state", {});
    const firstRequest = await firstInvoke;
    let tooDeep: unknown = "leaf";
    for (let depth = 0; depth < 34; depth += 1) tooDeep = { child: tooDeep };
    page.socket.send(JSON.stringify({
      type: "tool.result",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: firstRequest.call_id,
      connection_id: page.ref.connection_id,
      navigation_id: page.ref.navigation_id,
      ok: true,
      terminal_state: "completed",
      output: tooDeep,
    }));
    await expect(firstResult).rejects.toThrow("too complex");
    expect(page.socket.readyState).toBe(WebSocket.OPEN);

    const requests: Record<string, unknown>[] = [];
    page.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "tool.invoke") requests.push(message);
    });
    const invocations = Array.from({ length: 16 }, () => {
      const invocation = activeHarness.broker.invoke(page.ref, "ui_get_state", {}, 5_000);
      void invocation.catch(() => undefined);
      return invocation;
    });
    await waitFor(() => requests.length === 16);
    for (const request of requests) {
      page.socket.send(JSON.stringify({
        type: "tool.result",
        version: BROWSER_TOOLS_PROTOCOL_VERSION,
        call_id: request.call_id,
        connection_id: page.ref.connection_id,
        navigation_id: page.ref.navigation_id,
        ok: true,
        terminal_state: "completed",
        output: null,
      }));
    }
    await expect(Promise.all(invocations)).resolves.toEqual(Array(16).fill(null));
    expect(page.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects query parameters on the exact renderer authentication path", async () => {
    const activeHarness = await startHarness();
    await expect(rejectedUpgradeStatus(`${activeHarness.wsUrl}?ticket=forbidden`, {
      origin: activeHarness.origin,
    })).resolves.toBe(400);
    expect(activeHarness.broker.connected()).toBe(false);
  });

  it("evicts a half-open renderer that does not answer heartbeat pings", async () => {
    const activeHarness = await startHarness({ heartbeatIntervalMs: 20 });
    const pageTarget = target();
    const ticket = activeHarness.broker.issueTicket(
      pageTarget,
      activeHarness.origin,
      activeHarness.requestAuthority,
    ).ticket;
    const socket = await openSocket(activeHarness, { autoPong: false });
    const ready = nextJson(socket, (message) => message.type === "auth.ready");
    socket.send(JSON.stringify(authMessage(ticket, pageTarget)));
    const connectionId = String((await ready).connection_id);
    const closed = closeInfo(socket);

    await expect(closed).resolves.toMatchObject({
      code: 4409,
      reason: "Browser renderer heartbeat timed out",
    });
    expect(activeHarness.broker.connection(connectionId)).toBeNull();
  });

  it("keeps a renderer that automatically answers heartbeat pings", async () => {
    const activeHarness = await startHarness({ heartbeatIntervalMs: 20 });
    const page = await authenticate(activeHarness, target());

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(activeHarness.broker.connection(page.ref.connection_id)).toEqual(page.ref);
    expect(page.socket.readyState).toBe(WebSocket.OPEN);
  });
});

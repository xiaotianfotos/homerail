import { createHash, randomBytes, randomUUID } from "node:crypto";
import type * as http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  BROWSER_RENDERER_TOOLS_TICKET_PATH,
  BROWSER_RENDERER_TOOLS_TICKET_TTL_MS,
  BROWSER_RENDERER_TOOLS_WS_PATH,
  BROWSER_TOOLS_CAPABILITIES,
  BROWSER_TOOLS_DEFAULT_TIMEOUT_MS,
  BROWSER_TOOLS_MAX_MESSAGE_BYTES,
  BROWSER_TOOLS_MAX_RESULT_BYTES,
  BROWSER_TOOLS_PROTOCOL_VERSION,
  HOMERAIL_UI_TOOL_CONTRACTS,
  uiToolContractDigest,
  validateBrowserRendererConnectionRef,
  validateBrowserRendererTarget,
  validateHomeRailUiToolInput,
  type BrowserRendererAuthTicketMessageV1,
  type BrowserRendererCancelMessageV1,
  type BrowserRendererConnectionRefV1,
  type BrowserRendererInvokeMessageV1,
  type BrowserRendererManagerMessageV1,
  type BrowserRendererTargetV1,
  type BrowserRendererTicketResponseV1,
  type HomeRailUiToolName,
} from "homerail-protocol";
import { isLoopbackHost, type PluginHttpTrustPolicy } from "./plugin-http-trust.js";
import { rejectWebSocketUpgrade } from "./control-plane-auth.js";

const AUTH_TIMEOUT_MS = 5_000;
const CANCEL_ACK_GRACE_MS = 750;
const MAX_TICKETS = 1_024;
const MAX_TICKETS_PER_TARGET = 8;
const MAX_CONNECTIONS = 256;
const MAX_PENDING_AUTHENTICATIONS = 64;
const MAX_PENDING_CALLS = 128;
const MAX_PENDING_CALLS_PER_CONNECTION = 16;
const MAX_TICKET_REQUEST_BYTES = 16 * 1024;
const MAX_BUFFERED_SEND_BYTES = BROWSER_TOOLS_MAX_MESSAGE_BYTES * 4;
const HEARTBEAT_INTERVAL_MS = 15_000;
const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"] as const;

class BrowserRendererCapacityError extends Error {}

interface TicketRecord extends BrowserRendererTargetV1 {
  origin: string;
  requestAuthority: string;
  expiresAt: number;
}

interface RendererClient extends BrowserRendererConnectionRefV1 {
  socket: WebSocket;
  origin: string;
  requestAuthority: string;
  awaitingPong: boolean;
}

interface PendingCall {
  connectionId: string;
  navigationId: string;
  toolName: HomeRailUiToolName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  invocationSent: boolean;
  cancelRequested?: BrowserRendererCancelMessageV1["reason"];
}

function rawDataBytes(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
    : raw.byteLength;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value && !/[\r\n]/.test(value) ? value : undefined;
}

function exactOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function exactTicket(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value ? value : undefined;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

function boundedJsonBytes(value: unknown): number {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) throw new Error("HomeRail UI tool result is too complex");
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    for (const item of Object.values(current as Record<string, unknown>)) visit(item, depth + 1);
  };
  visit(value, 0);
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? null);
  } catch {
    throw new Error("HomeRail UI tool result is not valid JSON");
  }
  return Buffer.byteLength(encoded, "utf8");
}

function hasForwardingHeaders(req: http.IncomingMessage): boolean {
  return FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined);
}

/**
 * Browser renderer requests must arrive either directly from their exact Host,
 * from an explicitly allowlisted Origin, or through the same-origin UI proxy.
 * The UI proxy validates the browser-facing Host before replacing it with the
 * Manager Host and restores the same-origin marker over its loopback hop.
 */
export function trustedBrowserRendererRequest(
  req: http.IncomingMessage,
  policy: PluginHttpTrustPolicy,
): { trusted: true; origin: string; requestAuthority: string } | { trusted: false } {
  if (hasForwardingHeaders(req)) return { trusted: false };
  const origin = exactOrigin(singleHeader(req.headers.origin));
  const host = singleHeader(req.headers.host);
  if (!origin || !host) return { trusted: false };
  let selfUrl: URL;
  try {
    const encrypted = Boolean((req.socket as http.IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
    selfUrl = new URL(`${encrypted ? "https" : "http"}://${host}`);
  } catch {
    return { trusted: false };
  }
  const remoteIsLoopback = Boolean(req.socket.remoteAddress && isLoopbackHost(req.socket.remoteAddress));
  const originUrl = new URL(origin);
  if (
    policy.allowedOrigins.includes(origin)
    && originUrl.hostname.toLowerCase() === selfUrl.hostname.toLowerCase()
  ) {
    return { trusted: true, origin, requestAuthority: `direct:${selfUrl.origin}` };
  }
  if (
    origin === selfUrl.origin
    && isLoopbackHost(selfUrl.hostname)
    && remoteIsLoopback
  ) return { trusted: true, origin, requestAuthority: `direct:${selfUrl.origin}` };
  if (
    remoteIsLoopback
    && isLoopbackHost(selfUrl.hostname)
    && singleHeader(req.headers["sec-fetch-site"])?.toLowerCase() === "same-origin"
  ) return { trusted: true, origin, requestAuthority: `ui-proxy:${selfUrl.origin}` };
  return { trusted: false };
}

function safeId(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must contain 1-${max} printable characters`);
  }
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function targetKey(target: BrowserRendererTargetV1): string {
  return JSON.stringify([target.ui_session_id, target.tab_id, target.navigation_id]);
}

function ticketDigest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function expectedContracts(): Map<HomeRailUiToolName, string> {
  return new Map(HOMERAIL_UI_TOOL_CONTRACTS.map((contract) => [
    contract.name,
    uiToolContractDigest(contract),
  ]));
}

function validateContracts(value: unknown): void {
  if (!Array.isArray(value) || value.length !== HOMERAIL_UI_TOOL_CONTRACTS.length) {
    throw new Error("Renderer contract catalog must contain the exact HomeRail UI tool set");
  }
  const expected = expectedContracts();
  const seen = new Set<string>();
  for (const raw of value) {
    const binding = record(raw, "Renderer contract binding");
    if (!exactKeys(binding, ["name", "contract_digest"])) {
      throw new Error("Renderer contract binding must be an exact object");
    }
    const name = safeId(binding.name, "contract.name", 128) as HomeRailUiToolName;
    const digest = safeId(binding.contract_digest, "contract.contract_digest", 128);
    if (seen.has(name) || expected.get(name) !== digest) {
      throw new Error(`Renderer contract catalog does not match trusted contract: ${name}`);
    }
    seen.add(name);
  }
  if (seen.size !== expected.size) {
    throw new Error("Renderer contract catalog is incomplete");
  }
}

export class BrowserRendererToolsBroker {
  readonly #tickets = new Map<string, TicketRecord>();
  readonly #clients = new Map<string, RendererClient>();
  readonly #targetConnections = new Map<string, string>();
  readonly #pending = new Map<string, PendingCall>();
  #pendingAuthentications = 0;

  issueTicket(
    rawTarget: BrowserRendererTargetV1,
    origin: string,
    requestAuthority: string,
    now = Date.now(),
  ): BrowserRendererTicketResponseV1 {
    this.#pruneTickets(now);
    if (exactOrigin(origin) !== origin || !/^(?:direct|ui-proxy):https?:\/\//.test(requestAuthority)) {
      throw new Error("Browser renderer ticket trust context is invalid");
    }
    if (this.#tickets.size >= MAX_TICKETS) {
      throw new BrowserRendererCapacityError("Browser renderer ticket capacity reached; try again shortly");
    }
    const target = this.#validatedTarget(rawTarget);
    const key = targetKey(target);
    let targetTickets = 0;
    for (const ticket of this.#tickets.values()) {
      if (targetKey(ticket) === key) targetTickets += 1;
    }
    if (targetTickets >= MAX_TICKETS_PER_TARGET) {
      throw new BrowserRendererCapacityError("Too many active browser renderer tickets for this page");
    }
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticketDigest(ticket), {
      ...target,
      origin,
      requestAuthority,
      expiresAt: now + BROWSER_RENDERER_TOOLS_TICKET_TTL_MS,
    });
    return { ticket, expires_in_ms: BROWSER_RENDERER_TOOLS_TICKET_TTL_MS };
  }

  connected(connectionId?: string): boolean {
    if (connectionId) return this.#clients.get(connectionId)?.socket.readyState === WebSocket.OPEN;
    return [...this.#clients.values()].some((client) => client.socket.readyState === WebSocket.OPEN);
  }

  connection(connectionId: string): BrowserRendererConnectionRefV1 | null {
    const client = this.#clients.get(connectionId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return null;
    return {
      connection_id: client.connection_id,
      ui_session_id: client.ui_session_id,
      tab_id: client.tab_id,
      navigation_id: client.navigation_id,
    };
  }

  requireConnection(rawTarget: BrowserRendererConnectionRefV1): BrowserRendererConnectionRefV1 {
    const validated = validateBrowserRendererConnectionRef(rawTarget);
    const connectionId = validated.connection_id;
    const target = this.#validatedTarget(validated);
    const current = this.connection(connectionId);
    if (!current || targetKey(current) !== targetKey(target)) {
      throw new Error("The requested HomeRail browser renderer target is stale or unavailable");
    }
    return current;
  }

  connections(): BrowserRendererConnectionRefV1[] {
    return [...this.#clients.values()]
      .filter((client) => client.socket.readyState === WebSocket.OPEN)
      .map((client) => ({
        connection_id: client.connection_id,
        ui_session_id: client.ui_session_id,
        tab_id: client.tab_id,
        navigation_id: client.navigation_id,
      }))
      .sort((left, right) => left.connection_id.localeCompare(right.connection_id));
  }

  attach(
    server: http.Server,
    policy: PluginHttpTrustPolicy,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  ): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: BROWSER_TOOLS_MAX_MESSAGE_BYTES });
    const heartbeat = setInterval(() => this.#heartbeat(), Math.max(10, heartbeatIntervalMs));
    heartbeat.unref?.();
    server.on("upgrade", (req, socket, head) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      const pathname = requestUrl.pathname;
      if (pathname !== BROWSER_RENDERER_TOOLS_WS_PATH) return;
      if (requestUrl.search) {
        rejectWebSocketUpgrade(socket, 400, "Browser renderer WebSocket query parameters are forbidden");
        return;
      }
      const trust = trustedBrowserRendererRequest(req, policy);
      if (!trust.trusted) {
        rejectWebSocketUpgrade(socket, 403, "Forbidden");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        if (this.#pendingAuthentications >= MAX_PENDING_AUTHENTICATIONS) {
          ws.close(4429, "Browser renderer authentication capacity reached");
          return;
        }
        this.#authenticate(ws, trust.origin, trust.requestAuthority);
      });
    });
    server.once("close", () => {
      clearInterval(heartbeat);
      for (const connectionId of [...this.#clients.keys()]) {
        this.#disconnect(connectionId, "Manager stopped");
      }
      this.#tickets.clear();
      wss.close();
    });
    return wss;
  }

  async invoke(
    rawTarget: BrowserRendererConnectionRefV1,
    toolName: HomeRailUiToolName,
    rawInput: unknown,
    timeoutMs = BROWSER_TOOLS_DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.requireConnection(rawTarget);
    const connectionId = target.connection_id;
    const client = this.#clients.get(connectionId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The requested HomeRail browser renderer connection is unavailable");
    }
    if (signal?.aborted) throw new Error(`HomeRail UI tool was cancelled: ${toolName}`);
    if (this.#pending.size >= MAX_PENDING_CALLS || this.#pendingCount(connectionId) >= MAX_PENDING_CALLS_PER_CONNECTION) {
      throw new Error("HomeRail browser renderer has too many pending calls");
    }
    const input = validateHomeRailUiToolInput(toolName, rawInput);
    const contract = HOMERAIL_UI_TOOL_CONTRACTS.find((candidate) => candidate.name === toolName)!;
    const requestedTimeout = Number.isFinite(timeoutMs) && Number.isSafeInteger(timeoutMs)
      ? timeoutMs
      : BROWSER_TOOLS_DEFAULT_TIMEOUT_MS;
    const boundedTimeout = Math.min(30_000, Math.max(250, requestedTimeout));
    const callId = randomUUID();
    const message: BrowserRendererInvokeMessageV1 = {
      type: "tool.invoke",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: callId,
      connection_id: client.connection_id,
      navigation_id: client.navigation_id,
      tool_name: toolName,
      input,
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + boundedTimeout,
    };

    return new Promise((resolve, reject) => {
      const requestCancellation = (
        reason: string,
        cancelReason: BrowserRendererCancelMessageV1["reason"],
      ): void => {
        const pending = this.#pending.get(callId);
        if (!pending) return;
        if (!pending.invocationSent) {
          const finished = this.#takePending(callId);
          finished?.reject(new Error(`HomeRail UI tool was cancelled before execution: ${reason}`));
          return;
        }
        if (pending.cancelRequested) return;
        pending.cancelRequested = cancelReason;
        clearTimeout(pending.timer);
        this.#sendCancel(client, callId, cancelReason);
        pending.timer = setTimeout(() => {
          const finished = this.#takePending(callId);
          finished?.reject(new Error(
            `HomeRail UI tool outcome is indeterminate: renderer did not acknowledge ${reason}`,
          ));
        }, CANCEL_ACK_GRACE_MS);
        pending.timer.unref?.();
      };
      const timer = setTimeout(() => {
        requestCancellation(`timeout for ${toolName}`, "timeout");
      }, boundedTimeout);
      timer.unref?.();
      const abortHandler = signal
        ? () => requestCancellation(`cancellation of ${toolName}`, "cancelled")
        : undefined;
      this.#pending.set(callId, {
        connectionId,
        navigationId: client.navigation_id,
        toolName,
        resolve,
        reject,
        timer,
        abortSignal: signal,
        abortHandler,
        invocationSent: false,
      });
      signal?.addEventListener("abort", abortHandler!, { once: true });
      if (signal?.aborted) {
        requestCancellation(`cancellation of ${toolName}`, "cancelled");
        return;
      }
      try {
        this.#send(client.socket, message);
        const pending = this.#pending.get(callId);
        if (pending) pending.invocationSent = true;
      } catch (error) {
        const pending = this.#takePending(callId);
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #authenticate(socket: WebSocket, origin: string, requestAuthority: string): void {
    this.#pendingAuthentications += 1;
    let authenticationPending = true;
    const finishAuthentication = (): void => {
      if (!authenticationPending) return;
      authenticationPending = false;
      this.#pendingAuthentications -= 1;
    };
    let connectionId = "";
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(4401, "Browser renderer authentication timed out"), AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    socket.on("message", (raw, isBinary) => {
      if (isBinary || rawDataBytes(raw) > BROWSER_TOOLS_MAX_MESSAGE_BYTES) {
        socket.close(4400, "Invalid browser renderer message");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(raw.toString()), "Browser renderer message");
      } catch {
        socket.close(4400, "Invalid browser renderer JSON");
        return;
      }

      if (!authenticated) {
        try {
          const client = this.#acceptTicketMessage(socket, origin, requestAuthority, message);
          authenticated = true;
          finishAuthentication();
          connectionId = client.connection_id;
          clearTimeout(authTimer);
          this.#clients.set(connectionId, client);
          this.#targetConnections.set(targetKey(client), connectionId);
          socket.on("pong", () => {
            const current = this.#clients.get(connectionId);
            if (current?.socket === socket) current.awaitingPong = false;
          });
          this.#send(socket, {
            type: "auth.ready",
            version: BROWSER_TOOLS_PROTOCOL_VERSION,
            connection_id: connectionId,
            ui_session_id: client.ui_session_id,
            tab_id: client.tab_id,
            navigation_id: client.navigation_id,
            capabilities: [...BROWSER_TOOLS_CAPABILITIES],
            max_message_bytes: BROWSER_TOOLS_MAX_MESSAGE_BYTES,
            max_result_bytes: BROWSER_TOOLS_MAX_RESULT_BYTES,
            max_concurrent_calls: MAX_PENDING_CALLS_PER_CONNECTION,
          });
        } catch {
          finishAuthentication();
          socket.close(4401, "Browser renderer authentication failed");
        }
        return;
      }

      const client = this.#clients.get(connectionId);
      if (!client || client.socket !== socket) {
        socket.close(4409, "Browser renderer connection is no longer active");
        return;
      }
      try {
        this.#handleClientMessage(client, message);
      } catch (error) {
        socket.close(4400, error instanceof Error ? error.message.slice(0, 120) : "Invalid browser renderer message");
      }
    });

    const cleanup = (): void => {
      clearTimeout(authTimer);
      finishAuthentication();
      if (connectionId) this.#disconnect(connectionId, "Browser renderer disconnected", false);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }

  #acceptTicketMessage(
    socket: WebSocket,
    origin: string,
    requestAuthority: string,
    message: Record<string, unknown>,
  ): RendererClient {
    const ticket = exactTicket(message.ticket);
    if (!ticket) throw new Error("Invalid browser renderer ticket");
    const digest = ticketDigest(ticket);
    const ticketRecord = this.#tickets.get(digest);
    // Consume before comparing so a failed binding cannot replay the ticket.
    this.#tickets.delete(digest);
    if (
      message.type !== "auth.ticket"
      || message.version !== BROWSER_TOOLS_PROTOCOL_VERSION
      || !exactKeys(message, [
        "type", "version", "ticket", "ui_session_id", "tab_id", "navigation_id", "contracts",
      ])
    ) throw new Error("Expected browser renderer ticket authentication");
    if (this.#clients.size >= MAX_CONNECTIONS) throw new Error("Browser renderer connection capacity reached");
    const auth = message as unknown as BrowserRendererAuthTicketMessageV1;
    const target = this.#validatedTarget(auth);
    validateContracts(auth.contracts);
    if (
      !ticketRecord
      || ticketRecord.expiresAt <= Date.now()
      || ticketRecord.origin !== origin
      || ticketRecord.requestAuthority !== requestAuthority
      || targetKey(ticketRecord) !== targetKey(target)
    ) throw new Error("Browser renderer ticket is invalid or expired");
    if (this.#targetConnections.has(targetKey(target))) {
      throw new Error("This browser renderer page already has an active connection");
    }
    return {
      ...target,
      connection_id: randomUUID(),
      socket,
      origin,
      requestAuthority,
      awaitingPong: false,
    };
  }

  #handleClientMessage(client: RendererClient, message: Record<string, unknown>): void {
    if (message.version !== BROWSER_TOOLS_PROTOCOL_VERSION) {
      throw new Error("Unsupported browser renderer protocol version");
    }
    if (message.type === "page.invalidated") {
      if (!exactKeys(message, ["type", "version", "connection_id", "navigation_id", "reason"])) {
        throw new Error("Browser renderer invalidation must be an exact message");
      }
      if (!["navigation", "reload", "feature_disabled", "window_closed"].includes(String(message.reason))) {
        throw new Error("Browser renderer invalidation reason is invalid");
      }
      if (
        safeId(message.connection_id, "connection_id") !== client.connection_id
        || safeId(message.navigation_id, "navigation_id") !== client.navigation_id
      ) throw new Error("Browser renderer invalidation target mismatch");
      this.#disconnect(client.connection_id, "Browser renderer navigation invalidated pending calls");
      return;
    }
    if (message.type !== "tool.result") throw new Error("Unsupported browser renderer client message");
    if (!exactKeys(
      message,
      ["type", "version", "call_id", "connection_id", "navigation_id", "ok", "terminal_state"],
      ["output", "error"],
    )) throw new Error("Browser renderer result must be an exact message");
    if (typeof message.ok !== "boolean") throw new Error("Browser renderer result ok must be boolean");
    const callId = safeId(message.call_id, "call_id");
    const connectionId = safeId(message.connection_id, "connection_id");
    const navigationId = safeId(message.navigation_id, "navigation_id");
    if (connectionId !== client.connection_id || navigationId !== client.navigation_id) {
      throw new Error("Browser renderer result target mismatch");
    }
    const pending = this.#pending.get(callId);
    if (!pending) return;
    if (pending.connectionId !== connectionId || pending.navigationId !== navigationId) {
      throw new Error("Browser renderer result does not match the pending call");
    }
    const terminalState = String(message.terminal_state ?? "");
    if (!["completed", "failed", "cancelled", "indeterminate"].includes(terminalState)) {
      throw new Error("Browser renderer result terminal state is invalid");
    }
    if (message.ok === true) {
      if (terminalState !== "completed" || message.error !== undefined) {
        throw new Error("Successful browser renderer result must be completed without an error");
      }
      let bytes: number;
      try {
        bytes = boundedJsonBytes(message.output ?? null);
      } catch (error) {
        const finished = this.#takePending(callId)!;
        finished.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const finished = this.#takePending(callId)!;
      if (bytes > BROWSER_TOOLS_MAX_RESULT_BYTES) {
        finished.reject(new Error("HomeRail UI tool result exceeded the allowed size"));
      } else {
        finished.resolve(message.output ?? null);
      }
      return;
    }
    if (terminalState === "completed") {
      throw new Error("Failed browser renderer result cannot be completed");
    }
    if (message.output !== undefined) {
      throw new Error("Failed browser renderer result cannot include output");
    }
    if (message.error !== undefined && typeof message.error !== "string") {
      throw new Error("Browser renderer result error must be a string");
    }
    const finished = this.#takePending(callId)!;
    const error = typeof message.error === "string"
      ? message.error.slice(0, 2_000)
      : "HomeRail UI tool failed";
    finished.reject(new Error(
      terminalState === "indeterminate"
        ? `HomeRail UI tool outcome is indeterminate: ${error}`
        : terminalState === "cancelled"
          ? `HomeRail UI tool was cancelled: ${error}`
          : error,
    ));
  }

  #sendCancel(
    client: RendererClient,
    callId: string,
    reason: BrowserRendererCancelMessageV1["reason"],
  ): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.#send(client.socket, {
        type: "tool.cancel",
        version: BROWSER_TOOLS_PROTOCOL_VERSION,
        call_id: callId,
        connection_id: client.connection_id,
        navigation_id: client.navigation_id,
        reason,
      });
    } catch {
      // Cancellation is best effort; the local pending call still terminates.
    }
  }

  #takePending(callId: string): PendingCall | undefined {
    const pending = this.#pending.get(callId);
    if (!pending) return undefined;
    this.#pending.delete(callId);
    clearTimeout(pending.timer);
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
    }
    return pending;
  }

  #pendingCount(connectionId: string): number {
    let count = 0;
    for (const pending of this.#pending.values()) {
      if (pending.connectionId === connectionId) count += 1;
    }
    return count;
  }

  #heartbeat(): void {
    for (const [connectionId, client] of [...this.#clients]) {
      if (client.socket.readyState !== WebSocket.OPEN || client.awaitingPong) {
        this.#disconnect(connectionId, "Browser renderer heartbeat timed out");
        continue;
      }
      client.awaitingPong = true;
      try {
        client.socket.ping();
      } catch {
        this.#disconnect(connectionId, "Browser renderer heartbeat failed");
      }
    }
  }

  #rejectPending(connectionId: string, reason: string): void {
    for (const [callId, pending] of [...this.#pending]) {
      if (pending.connectionId !== connectionId) continue;
      const finished = this.#takePending(callId);
      finished?.reject(new Error(`HomeRail UI tool outcome is indeterminate: ${reason}`));
    }
  }

  #disconnect(connectionId: string, reason: string, close = true): void {
    const client = this.#clients.get(connectionId);
    if (!client) return;
    this.#clients.delete(connectionId);
    if (this.#targetConnections.get(targetKey(client)) === connectionId) {
      this.#targetConnections.delete(targetKey(client));
    }
    this.#rejectPending(connectionId, reason);
    if (close && client.socket.readyState === WebSocket.OPEN) {
      client.socket.close(4409, reason.slice(0, 120));
    }
  }

  #validatedTarget(raw: BrowserRendererTargetV1): BrowserRendererTargetV1 {
    return {
      ui_session_id: safeId(raw.ui_session_id, "ui_session_id"),
      tab_id: safeId(raw.tab_id, "tab_id"),
      navigation_id: safeId(raw.navigation_id, "navigation_id"),
    };
  }

  #pruneTickets(now: number): void {
    for (const [digest, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) this.#tickets.delete(digest);
    }
  }

  #send(socket: WebSocket, message: BrowserRendererManagerMessageV1): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Browser renderer socket is not open");
    if (socket.bufferedAmount > MAX_BUFFERED_SEND_BYTES) {
      throw new Error("Browser renderer socket backpressure limit exceeded");
    }
    socket.send(JSON.stringify(message));
  }
}

async function readTicketRequest(req: http.IncomingMessage): Promise<BrowserRendererTargetV1> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_TICKET_REQUEST_BYTES) throw new Error("Browser renderer ticket request is too large");
    chunks.push(value);
  }
  return validateBrowserRendererTarget(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

let rendererBroker: BrowserRendererToolsBroker | null = null;
let rendererTrustPolicy: PluginHttpTrustPolicy | null = null;

export function setupBrowserRendererToolsWebSocket(
  server: http.Server,
  options: { trustPolicy: PluginHttpTrustPolicy; heartbeatIntervalMs?: number },
): BrowserRendererToolsBroker {
  const broker = new BrowserRendererToolsBroker();
  rendererBroker = broker;
  rendererTrustPolicy = options.trustPolicy;
  broker.attach(server, options.trustPolicy, options.heartbeatIntervalMs);
  server.once("close", () => {
    if (rendererBroker === broker) {
      rendererBroker = null;
      rendererTrustPolicy = null;
    }
  });
  return broker;
}

export function getBrowserRendererToolsBroker(): BrowserRendererToolsBroker | null {
  return rendererBroker;
}

export function browserRendererTicketRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;
  if (pathname !== BROWSER_RENDERER_TOOLS_TICKET_PATH) return false;
  if (requestUrl.search) {
    req.resume();
    res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ success: false, error: "Browser renderer ticket query parameters are forbidden" }));
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ success: false, error: "method not allowed" }));
    return true;
  }
  const broker = rendererBroker;
  const policy = rendererTrustPolicy;
  const trust = policy ? trustedBrowserRendererRequest(req, policy) : { trusted: false as const };
  if (!broker || !trust.trusted) {
    req.resume();
    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ success: false, error: "Trusted same-origin browser renderer request required" }));
    return true;
  }
  void readTicketRequest(req)
    .then((target) => {
      const ticket = broker.issueTicket(target, trust.origin, trust.requestAuthority);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ success: true, data: ticket }));
    })
    .catch((error) => {
      if (res.headersSent) return;
      const capacity = error instanceof BrowserRendererCapacityError;
      res.writeHead(capacity ? 429 : 400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...(capacity ? { "Retry-After": "1" } : {}),
      });
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message.slice(0, 2_000) : "Browser renderer ticket failed",
      }));
    });
  return true;
}

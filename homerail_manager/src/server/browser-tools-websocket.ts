import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  BROWSER_TOOLS_DEFAULT_TIMEOUT_MS,
  BROWSER_TOOLS_CAPABILITIES,
  BROWSER_TOOLS_MAX_MESSAGE_BYTES,
  BROWSER_TOOLS_MAX_RESULT_BYTES,
  BROWSER_TOOLS_PROTOCOL_VERSION,
  HOMERAIL_UI_TOOL_NAMES,
  browserPageToolDescriptorDigest,
  homeRailUiToolContract,
  stableStringify,
  uiToolContractDigest,
  validateHomeRailUiToolInput,
  type BrowserToolsCatalogEntry,
  type BrowserToolsCancelMessage,
  type BrowserToolsInvokeMessage,
  type BrowserToolsManagerMessage,
  type HomeRailUiToolName,
} from "homerail-protocol";
import { isLoopbackRemoteAddress, rejectWebSocketUpgrade } from "./control-plane-auth.js";

const BROWSER_TOOLS_PATH = "/ws/browser-tools";
const AUTH_TIMEOUT_MS = 5_000;
const CANCEL_ACK_GRACE_MS = 750;
const MAX_CATALOG_TOOLS = 32;
const MAX_PENDING_CALLS = 64;

interface AuthenticatedClient {
  socket: WebSocket;
  connectionId: string;
  desktopInstanceId: string;
  pageId: string | null;
  tools: Map<HomeRailUiToolName, BrowserToolsCatalogEntry>;
}

interface PendingCall {
  connectionId: string;
  pageId: string;
  navigationId: string;
  toolName: HomeRailUiToolName;
  pageDescriptorDigest: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  invocationSent: boolean;
  cancelRequested?: BrowserToolsCancelMessage["reason"];
}

function messageBytes(raw: RawData): number {
  return Array.isArray(raw)
    ? raw.reduce((total, part) => total + part.byteLength, 0)
    : raw.byteLength;
}

function hmac(token: string, value: string): string {
  return createHmac("sha256", token).update(value).digest("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeString(value: unknown, label: string, max = 256): string {
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

function isTrustedHomeRailOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password
      && isLoopbackRemoteAddress(hostname);
  } catch {
    return false;
  }
}

function hasForwardingHeaders(req: http.IncomingMessage): boolean {
  return ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]
    .some((name) => req.headers[name] !== undefined);
}

export class BrowserToolsBroker {
  private client: AuthenticatedClient | null = null;
  private readonly pending = new Map<string, PendingCall>();

  constructor(private readonly authToken: string) {
    if (!authToken.trim()) throw new Error("Browser Tools auth token must not be empty");
  }

  connected(): boolean {
    return Boolean(this.client?.socket.readyState === WebSocket.OPEN);
  }

  /** All six frozen contracts are projected atomically for Agent use. */
  ready(): boolean {
    const client = this.client;
    return Boolean(
      client
      && client.socket.readyState === WebSocket.OPEN
      && client.pageId
      && client.tools.size === HOMERAIL_UI_TOOL_NAMES.length
      && HOMERAIL_UI_TOOL_NAMES.every((name) => client.tools.has(name)),
    );
  }

  status(): Record<string, unknown> {
    return {
      connected: this.connected(),
      ready: this.ready(),
      connection_id: this.client?.connectionId ?? null,
      desktop_instance_id: this.client?.desktopInstanceId ?? null,
      page_id: this.client?.pageId ?? null,
      tools: this.client ? [...this.client.tools.keys()].sort() : [],
    };
  }

  attach(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: BROWSER_TOOLS_MAX_MESSAGE_BYTES });
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname !== BROWSER_TOOLS_PATH) return;
      if (
        !isLoopbackRemoteAddress(req.socket.remoteAddress)
        || hasForwardingHeaders(req)
        || req.headers.origin !== undefined
      ) {
        rejectWebSocketUpgrade(socket, 403, "Forbidden");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    wss.on("connection", (socket) => this.authenticate(socket));
    server.once("close", () => {
      this.disconnectClient("Manager stopped");
      wss.close();
    });
    return wss;
  }

  async invoke(
    toolName: HomeRailUiToolName,
    rawInput: unknown,
    timeoutMs = BROWSER_TOOLS_DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.client;
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("HomeRail Browser Tools is disabled or Desktop is not connected");
    }
    if (signal?.aborted) throw new Error(`HomeRail UI tool was cancelled: ${toolName}`);
    if (this.pending.size >= MAX_PENDING_CALLS) {
      throw new Error("HomeRail Browser Tools has too many pending calls");
    }
    const catalog = client.tools.get(toolName);
    if (!catalog || !client.pageId) {
      throw new Error(`HomeRail UI tool is unavailable in the current page: ${toolName}`);
    }
    const input = validateHomeRailUiToolInput(toolName, rawInput);
    const boundedTimeout = Math.min(30_000, Math.max(250, Math.floor(timeoutMs)));
    const callId = randomUUID();
    const contract = homeRailUiToolContract(toolName)!;
    const message: BrowserToolsInvokeMessage = {
      type: "tool.invoke",
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      call_id: callId,
      page_id: client.pageId,
      navigation_id: catalog.navigation_id,
      tool_name: toolName,
      input,
      page_descriptor_digest: catalog.page_descriptor_digest,
      contract_digest: uiToolContractDigest(contract),
      deadline_ms: Date.now() + boundedTimeout,
    };

    return new Promise((resolve, reject) => {
      const requestCancellation = (
        reason: string,
        cancelReason: BrowserToolsCancelMessage["reason"],
      ): void => {
        const pending = this.pending.get(callId);
        if (!pending) return;
        if (!pending.invocationSent) {
          const finished = this.takePending(callId);
          finished?.reject(new Error(`HomeRail UI tool was cancelled before execution: ${reason}`));
          return;
        }
        if (pending.cancelRequested) return;
        pending.cancelRequested = cancelReason;
        clearTimeout(pending.timer);
        this.sendCancel(client, callId, cancelReason);
        pending.timer = setTimeout(() => {
          const finished = this.takePending(callId);
          finished?.reject(new Error(
            `HomeRail UI tool outcome is indeterminate: Desktop did not acknowledge ${reason}`,
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
      this.pending.set(callId, {
        connectionId: client.connectionId,
        pageId: client.pageId!,
        navigationId: catalog.navigation_id,
        toolName,
        pageDescriptorDigest: catalog.page_descriptor_digest,
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
        this.send(client.socket, message);
        const pending = this.pending.get(callId);
        if (pending) pending.invocationSent = true;
      } catch (error) {
        const pending = this.takePending(callId);
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private authenticate(socket: WebSocket): void {
    const serverNonce = randomBytes(32).toString("base64url");
    const challenge = {
      type: "auth.challenge" as const,
      version: BROWSER_TOOLS_PROTOCOL_VERSION,
      server_nonce: serverNonce,
      server_proof: hmac(this.authToken, `server:${serverNonce}`),
    };
    let authenticated = false;
    let connectionId = "";
    const authTimer = setTimeout(() => socket.close(4401, "Browser Tools authentication timed out"), AUTH_TIMEOUT_MS);
    authTimer.unref?.();
    this.send(socket, challenge);

    socket.on("message", (raw, isBinary) => {
      if (isBinary || messageBytes(raw) > BROWSER_TOOLS_MAX_MESSAGE_BYTES) {
        socket.close(4400, "Invalid Browser Tools message");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(raw.toString()), "Browser Tools message");
      } catch {
        socket.close(4400, "Invalid Browser Tools JSON");
        return;
      }
      if (!authenticated) {
        try {
          if (message.type !== "auth.response" || message.version !== BROWSER_TOOLS_PROTOCOL_VERSION) {
            throw new Error("Expected Browser Tools authentication response");
          }
          const clientNonce = safeString(message.client_nonce, "client_nonce", 128);
          const desktopInstanceId = safeString(message.desktop_instance_id, "desktop_instance_id", 128);
          const capabilities = message.capabilities;
          if (
            !Array.isArray(capabilities)
            || capabilities.length !== BROWSER_TOOLS_CAPABILITIES.length
            || !BROWSER_TOOLS_CAPABILITIES.every((capability) => capabilities.includes(capability))
          ) throw new Error("Invalid Browser Tools capability request");
          const clientProof = safeString(message.client_proof, "client_proof", 128);
          const expected = hmac(
            this.authToken,
            `client:${serverNonce}:${clientNonce}:${desktopInstanceId}:${BROWSER_TOOLS_CAPABILITIES.join(",")}`,
          );
          if (!constantTimeEqual(clientProof, expected)) throw new Error("Invalid Browser Tools proof");
          authenticated = true;
          clearTimeout(authTimer);
          connectionId = randomUUID();
          this.disconnectClient("A newer Desktop Browser Tools connection replaced this connection");
          this.client = { socket, connectionId, desktopInstanceId, pageId: null, tools: new Map() };
          this.send(socket, {
            type: "auth.ready",
            version: BROWSER_TOOLS_PROTOCOL_VERSION,
            connection_id: connectionId,
            capabilities: [...BROWSER_TOOLS_CAPABILITIES],
          });
        } catch {
          socket.close(4401, "Browser Tools authentication failed");
        }
        return;
      }
      if (this.client?.connectionId !== connectionId) {
        socket.close(4409, "Browser Tools connection is no longer active");
        return;
      }
      try {
        this.handleAuthenticatedMessage(message, this.client);
      } catch (error) {
        socket.close(4400, error instanceof Error ? error.message.slice(0, 120) : "Invalid Browser Tools message");
      }
    });

    const cleanup = (): void => {
      clearTimeout(authTimer);
      if (connectionId && this.client?.connectionId === connectionId) {
        this.disconnectClient("Desktop Browser Tools disconnected", false);
      }
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }

  private handleAuthenticatedMessage(
    message: Record<string, unknown>,
    client: AuthenticatedClient,
  ): void {
    if (message.version !== BROWSER_TOOLS_PROTOCOL_VERSION) throw new Error("Unsupported Browser Tools version");
    if (message.type === "page.catalog") {
      const pageId = safeString(message.page_id, "page_id");
      if (!Array.isArray(message.tools) || message.tools.length > MAX_CATALOG_TOOLS) {
        throw new Error(`page.catalog tools must contain at most ${MAX_CATALOG_TOOLS} entries`);
      }
      const accepted = new Map<HomeRailUiToolName, BrowserToolsCatalogEntry>();
      for (const raw of message.tools) {
        const tool = record(raw, "page.catalog tool");
        const name = safeString(tool.name, "tool.name");
        if (!HOMERAIL_UI_TOOL_NAMES.includes(name as HomeRailUiToolName)) continue;
        const contract = homeRailUiToolContract(name)!;
        const description = safeString(tool.description, "tool.description", 2_000);
        const inputSchema = record(tool.input_schema, "tool.input_schema");
        const frameId = safeString(tool.frame_id, "tool.frame_id");
        const origin = safeString(tool.origin, "tool.origin", 2_048);
        const navigationId = safeString(tool.navigation_id, "tool.navigation_id");
        const readOnly = tool.read_only === true;
        const untrustedContent = tool.untrusted_content === true;
        const descriptorDigest = safeString(tool.page_descriptor_digest, "tool.page_descriptor_digest", 128);
        if (!isTrustedHomeRailOrigin(origin)) continue;
        if (description !== contract.description || stableStringify(inputSchema) !== stableStringify(contract.input_schema)) continue;
        if (readOnly !== (contract.effect === "read") || !untrustedContent) continue;
        const expectedDescriptorDigest = browserPageToolDescriptorDigest({
          name,
          description,
          input_schema: inputSchema,
          frame_id: frameId,
          origin,
          navigation_id: navigationId,
          read_only: readOnly,
          untrusted_content: untrustedContent,
        });
        if (descriptorDigest !== expectedDescriptorDigest) continue;
        if (accepted.has(name as HomeRailUiToolName)) continue;
        accepted.set(name as HomeRailUiToolName, {
          name,
          description,
          input_schema: inputSchema,
          frame_id: frameId,
          origin,
          navigation_id: navigationId,
          read_only: readOnly,
          untrusted_content: untrustedContent,
          page_descriptor_digest: descriptorDigest,
          contract_digest: uiToolContractDigest(contract),
        });
      }
      client.pageId = pageId;
      client.tools = accepted;
      for (const [callId, pending] of this.pending) {
        if (pending.connectionId !== client.connectionId) continue;
        const current = accepted.get(pending.toolName);
        if (
          pending.pageId === pageId
          && current?.navigation_id === pending.navigationId
          && current.page_descriptor_digest === pending.pageDescriptorDigest
        ) continue;
        const finished = this.takePending(callId);
        finished?.reject(new Error("HomeRail page catalog changed during the UI tool call"));
      }
      return;
    }

    if (message.type === "page.invalidated") {
      const pageId = safeString(message.page_id, "page_id");
      if (pageId === client.pageId) {
        client.pageId = null;
        client.tools.clear();
        this.rejectPending(client.connectionId, "HomeRail page navigation invalidated the UI tool call");
      }
      return;
    }

    if (message.type === "tool.result") {
      const callId = safeString(message.call_id, "call_id");
      const pending = this.pending.get(callId);
      if (!pending || pending.connectionId !== client.connectionId) return;
      if (typeof message.ok !== "boolean") throw new Error("Browser Tools result ok must be boolean");
      const terminalState = String(message.terminal_state ?? "");
      if (!["completed", "failed", "cancelled", "indeterminate"].includes(terminalState)) {
        throw new Error("Browser Tools result terminal state is invalid");
      }
      if (message.ok === true) {
        if (terminalState !== "completed" || message.error !== undefined) {
          throw new Error("Successful Browser Tools result must be completed without an error");
        }
        const outputBytes = Buffer.byteLength(JSON.stringify(message.output ?? null), "utf8");
        const finished = this.takePending(callId)!;
        if (outputBytes > BROWSER_TOOLS_MAX_RESULT_BYTES) {
          finished.reject(new Error("HomeRail UI tool result exceeded the allowed size"));
        } else {
          finished.resolve(message.output ?? null);
        }
      } else {
        if (terminalState === "completed") {
          throw new Error("Failed Browser Tools result cannot be completed");
        }
        if (message.output !== undefined) {
          throw new Error("Failed Browser Tools result cannot include output");
        }
        if (message.error !== undefined && typeof message.error !== "string") {
          throw new Error("Browser Tools result error must be a string");
        }
        const error = typeof message.error === "string" ? message.error.slice(0, 2_000) : "HomeRail UI tool failed";
        const finished = this.takePending(callId)!;
        finished.reject(new Error(
          terminalState === "indeterminate"
            ? `HomeRail UI tool outcome is indeterminate: ${error}`
            : terminalState === "cancelled"
              ? `HomeRail UI tool was cancelled: ${error}`
              : error,
        ));
      }
      return;
    }

    throw new Error("Unsupported Browser Tools client message");
  }

  private send(socket: WebSocket, message: BrowserToolsManagerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Browser Tools socket is not open");
    socket.send(JSON.stringify(message));
  }

  private sendCancel(
    client: AuthenticatedClient,
    callId: string,
    reason: BrowserToolsCancelMessage["reason"],
  ): void {
    if (client.socket.readyState !== WebSocket.OPEN || !client.pageId) return;
    const pending = this.pending.get(callId);
    if (!pending) return;
    try {
      this.send(client.socket, {
        type: "tool.cancel",
        version: BROWSER_TOOLS_PROTOCOL_VERSION,
        call_id: callId,
        page_id: pending.pageId,
        navigation_id: pending.navigationId,
        reason,
      });
    } catch {
      // Cancellation is best effort; the acknowledgement timer remains authoritative.
    }
  }

  private takePending(callId: string): PendingCall | undefined {
    const pending = this.pending.get(callId);
    if (!pending) return undefined;
    this.pending.delete(callId);
    clearTimeout(pending.timer);
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
    }
    return pending;
  }

  private rejectPending(connectionId: string, reason: string): void {
    for (const [callId, pending] of this.pending) {
      if (pending.connectionId !== connectionId) continue;
      const finished = this.takePending(callId);
      finished?.reject(new Error(reason));
    }
  }

  private disconnectClient(reason: string, close = true): void {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.rejectPending(client.connectionId, reason);
    if (close && client.socket.readyState === WebSocket.OPEN) client.socket.close(4409, reason.slice(0, 120));
  }
}

let browserToolsBroker: BrowserToolsBroker | null = null;

export function setupBrowserToolsWebSocket(
  server: http.Server,
  options: { authToken: string },
): BrowserToolsBroker {
  const broker = new BrowserToolsBroker(options.authToken);
  browserToolsBroker = broker;
  broker.attach(server);
  server.once("close", () => {
    if (browserToolsBroker === broker) browserToolsBroker = null;
  });
  return broker;
}

export function getBrowserToolsBroker(): BrowserToolsBroker | null {
  return browserToolsBroker;
}

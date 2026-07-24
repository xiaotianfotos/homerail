import { createHash, randomBytes } from "node:crypto";
import type * as http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HostShellManagerAgentOptions } from "./host-shell-manager-agent.js";
import type { ManagerAgentConfigRoutesOptions } from "./manager-agent-config.js";
import {
  createCodexLiveVoiceBinding,
  type CodexLiveVoiceBinding,
} from "./voice-agent-bootstrap.js";
import {
  CodexLiveVoiceRuntime,
  type CodexLiveVoiceRuntimeEvent,
} from "./codex-live-voice-runtime.js";
import {
  isLoopbackHost,
  type PluginHttpTrustPolicy,
} from "./plugin-http-trust.js";

const TICKET_TTL_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_SDP_BYTES = 192 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_ACTIVE_TICKETS = 1_024;
const MAX_ACTIVE_TICKETS_PER_SESSION = 8;

interface TicketRecord {
  sessionId: string;
  expiresAt: number;
}

interface ActiveLiveVoiceSession {
  socket: WebSocket;
  runtime: CodexLiveVoiceRuntime;
}

// Process-local by design: HomeRail Manager currently owns Live Voice from one
// server process. A horizontally scaled deployment must replace these Maps
// with shared ticket/session ownership and sticky routing.
const tickets = new Map<string, TicketRecord>();
const activeSessions = new Map<string, ActiveLiveVoiceSession>();
const pendingSessions = new Map<string, WebSocket>();

class TicketCapacityError extends Error {}

function safeSessionId(raw: string): string {
  const decoded = decodeURIComponent(raw).trim();
  if (!decoded || decoded.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(decoded)) {
    throw new Error("Invalid Live Voice session id");
  }
  return decoded;
}

function ticketDigest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function pruneTickets(): void {
  const now = Date.now();
  for (const [digest, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(digest);
  }
}

function issueTicket(sessionId: string): string {
  pruneTickets();
  if (tickets.size >= MAX_ACTIVE_TICKETS) {
    throw new TicketCapacityError("Live Voice ticket capacity reached; try again shortly");
  }
  let sessionTicketCount = 0;
  for (const record of tickets.values()) {
    if (record.sessionId === sessionId) sessionTicketCount += 1;
  }
  if (sessionTicketCount >= MAX_ACTIVE_TICKETS_PER_SESSION) {
    throw new TicketCapacityError("Too many active Live Voice tickets for this session");
  }
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticketDigest(ticket), {
    sessionId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

function consumeTicket(sessionId: string, ticket: string): boolean {
  pruneTickets();
  const digest = ticketDigest(ticket);
  const record = tickets.get(digest);
  tickets.delete(digest);
  return Boolean(record && record.sessionId === sessionId && record.expiresAt > Date.now());
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function codexLiveVoiceTicketRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const match = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/live-ticket$/);
  if (!match) return false;
  if (req.method !== "POST") {
    json(res, 405, { success: false, message: "Method not allowed" });
    return true;
  }
  try {
    const sessionId = safeSessionId(match[1]);
    json(res, 200, {
      success: true,
      message: "Live Voice ticket issued",
      data: {
        ticket: issueTicket(sessionId),
        expires_in_ms: TICKET_TTL_MS,
      },
    });
  } catch (error) {
    json(res, error instanceof TicketCapacityError ? 429 : 400, {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value && !/[\r\n]/.test(value) ? value : undefined;
}

function trustedWebSocketOrigin(
  req: http.IncomingMessage,
  policy: PluginHttpTrustPolicy,
): boolean {
  const origin = singleHeader(req.headers.origin);
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.origin !== origin
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) return false;
  if (policy.allowedOrigins.includes(origin)) return true;
  return Boolean(
    req.socket.remoteAddress
    && isLoopbackHost(req.socket.remoteAddress)
    && singleHeader(req.headers["sec-fetch-site"])?.toLowerCase() === "same-origin",
  );
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendSessionError(
  socket: WebSocket,
  message: string,
  recoverable = false,
): void {
  send(socket, { type: "session.error", message, recoverable });
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

function workspaceForEvent(
  binding: CodexLiveVoiceBinding,
  event: CodexLiveVoiceRuntimeEvent,
): Record<string, unknown> | undefined {
  switch (event.type) {
    case "transcript.done":
      return binding.record_transcript(event.role, event.text);
    case "manager.turn.started":
      return binding.record_manager_started();
    case "manager.progress":
      return binding.record_manager_progress(event.text);
    case "manager.turn.completed":
      return binding.record_manager_completed(event.status);
    case "session.error":
      return binding.record_error(event.message);
    default:
      return undefined;
  }
}

function publicEvent(event: CodexLiveVoiceRuntimeEvent): Record<string, unknown> {
  // SDP is forwarded but never logged. Other events contain only public
  // transcript/progress metadata and intentionally exclude tool inputs/results.
  return { ...event };
}

export function setupCodexLiveVoiceWebSocket(
  server: http.Server,
  options: {
    trustPolicy: PluginHttpTrustPolicy;
    managerAgentOptions?: HostShellManagerAgentOptions;
    managerAgentConfigOptions?: ManagerAgentConfigRoutesOptions;
    authTimeoutMs?: number;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const match = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/live$/);
    if (!match) return;
    if (!trustedWebSocketOrigin(req, options.trustPolicy)) {
      socket.destroy();
      return;
    }
    try {
      safeSessionId(match[1]);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket: WebSocket, request: http.IncomingMessage) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const match = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/live$/);
    const sessionId = safeSessionId(match?.[1] ?? "");
    let authenticated = false;
    let binding: CodexLiveVoiceBinding | undefined;
    let runtime: CodexLiveVoiceRuntime | undefined;
    let handling = Promise.resolve();
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, "Live Voice authentication timed out");
    }, options.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    const cleanup = async (): Promise<void> => {
      clearTimeout(authTimer);
      if (pendingSessions.get(sessionId) === socket) pendingSessions.delete(sessionId);
      if (activeSessions.get(sessionId)?.socket === socket) activeSessions.delete(sessionId);
      await runtime?.stop();
      runtime = undefined;
    };

    socket.on("message", (raw, isBinary) => {
      handling = handling.then(async () => {
        if (isBinary || rawDataByteLength(raw) > MAX_MESSAGE_BYTES) {
          socket.close(4400, "Invalid Live Voice message");
          return;
        }
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw.toString());
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          message = parsed as Record<string, unknown>;
        } catch {
          sendSessionError(socket, "Invalid Live Voice message", true);
          return;
        }
        const type = String(message.type ?? "");
        if (!authenticated) {
          const ticket = type === "authenticate" && typeof message.ticket === "string"
            ? message.ticket
            : "";
          if (!ticket || !consumeTicket(sessionId, ticket)) {
            socket.close(4401, "Live Voice authentication failed");
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          send(socket, { type: "ready", session_id: sessionId });
          return;
        }

        if (type === "start") {
          if (runtime) {
            sendSessionError(socket, "Live Voice is already started", true);
            return;
          }
          if (activeSessions.has(sessionId) || pendingSessions.has(sessionId)) {
            sendSessionError(socket, "Another browser already owns this Live Voice session");
            return;
          }
          const sdp = typeof message.sdp === "string" ? message.sdp : "";
          if (!sdp || Buffer.byteLength(sdp, "utf8") > MAX_SDP_BYTES) {
            sendSessionError(socket, "Invalid WebRTC SDP offer");
            return;
          }
          const projectId = typeof message.project_id === "string" ? message.project_id : null;
          const selectedNodeId = typeof message.selected_node_id === "string"
            ? message.selected_node_id.trim()
            : undefined;
          if (
            selectedNodeId
            && (
              selectedNodeId.length > 256
              || /[\u0000-\u001f\u007f]/.test(selectedNodeId)
            )
          ) {
            sendSessionError(socket, "Invalid selected canvas node id");
            return;
          }
          pendingSessions.set(sessionId, socket);
          try {
            binding = await createCodexLiveVoiceBinding({
              sessionId,
              projectId,
              selectedNodeId,
              managerAgentOptions: options.managerAgentOptions,
              managerAgentConfigOptions: options.managerAgentConfigOptions,
            });
            if (
              pendingSessions.get(sessionId) !== socket
              || socket.readyState !== WebSocket.OPEN
            ) {
              throw new Error("Live Voice connection closed while the session was starting");
            }
            runtime = new CodexLiveVoiceRuntime({
              sessionId,
              cwd: binding.cwd,
              model: binding.model,
              voice: binding.voice,
              provider: binding.provider,
              serviceTier: binding.service_tier,
              reasoningEffort: binding.reasoning_effort,
              systemPrompt: binding.system_prompt,
              tools: binding.tools,
              skillRoots: binding.skill_roots,
              initialItems: binding.initial_items,
              env: binding.environment,
              onToolStateChanged: () => {
                const workspace = binding!.flush_tool_state();
                send(socket, { type: "workspace", workspace });
              },
              isToolSchemaCurrent: () => binding!.is_tool_schema_current(),
              onEvent: (event) => {
                const workspace = workspaceForEvent(binding!, event);
                send(socket, {
                  ...publicEvent(event),
                  ...(workspace ? { workspace } : {}),
                });
              },
            });
            activeSessions.set(sessionId, { socket, runtime });
            pendingSessions.delete(sessionId);
            await runtime.start(sdp);
          } catch (error) {
            if (pendingSessions.get(sessionId) === socket) pendingSessions.delete(sessionId);
            if (activeSessions.get(sessionId)?.socket === socket) activeSessions.delete(sessionId);
            await runtime?.stop();
            runtime = undefined;
            const messageText = error instanceof Error ? error.message : String(error);
            binding?.record_error(messageText);
            sendSessionError(socket, messageText);
          }
          return;
        }

        if (type === "text") {
          if (!runtime || !binding) {
            sendSessionError(socket, "Live Voice is not started");
            return;
          }
          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
            sendSessionError(socket, "Invalid Live Voice text input", true);
            return;
          }
          const workspace = binding.record_transcript("user", text);
          send(socket, { type: "workspace", workspace });
          await runtime.appendText(text);
          return;
        }

        if (type === "mute") {
          // The browser owns muting by toggling its local MediaStream track.
          // Acknowledge pre-mute during negotiation; no server audio state changes.
          send(socket, { type: "session.muted", muted: message.muted === true });
          return;
        }

        if (type === "stop") {
          await cleanup();
          send(socket, { type: "session.closed", reason: "requested" });
          socket.close(1000, "Live Voice stopped");
          return;
        }

        sendSessionError(socket, `Unsupported Live Voice message: ${type}`, true);
      }).catch((error) => {
        sendSessionError(
          socket,
          error instanceof Error ? error.message : String(error),
        );
      });
    });
    socket.once("close", () => {
      void cleanup();
    });
    socket.once("error", () => {
      void cleanup();
    });
  });

  server.once("close", () => {
    for (const active of activeSessions.values()) void active.runtime.stop();
    pendingSessions.clear();
    activeSessions.clear();
    tickets.clear();
    wss.close();
  });
  return wss;
}

export function _clearCodexLiveVoiceServerStateForTest(): void {
  tickets.clear();
  pendingSessions.clear();
  activeSessions.clear();
}

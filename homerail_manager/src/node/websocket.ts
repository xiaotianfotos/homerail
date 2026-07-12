import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  parseIncomingNodeMessage,
  type IncomingNodeMessage,
} from "./types.js";
import {
  registerNode,
  unregisterNode,
  updateHeartbeat,
  updateCapabilities,
  getNode,
  getAllNodes,
  type NodeState,
} from "./registry.js";
import { resolveLifecycleResponse, rejectAllPendingRequests } from "./lifecycle-request.js";
import { applyResponseHandoff } from "../orchestration/response-bridge.js";
import { handleDagMessageResponse } from "../orchestration/dag-message-router.js";
import { clearByTargetId } from "../orchestration/dispatch-tracker.js";
import { emit } from "../events/bus.js";
import { appendChatEntry } from "../persistence/store.js";
import { appendSessionTranscriptEntry } from "../persistence/dag-session-files.js";
import {
  autoHandoffAfterCorrectionExhausted,
  failActiveRun,
  getCurrentNodeSession,
  recordAdvisorCall,
  requestNodeCorrection,
} from "../runtime/active-runs.js";

const WS_URL_PATTERN = /^\/ws\/projects\/([^\/]+)\/nodes\/([^\/]+)$/;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

export function isLoopbackNodeRemoteAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1" || normalized === "localhost") return true;
  if (normalized.startsWith("127.")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackNodeRemoteAddress(normalized.slice("::ffff:".length));
  }
  return normalized === "0:0:0:0:0:ffff:7f00:1";
}

function rejectUpgrade(
  socket: { write(chunk: string): unknown; destroy(): void },
  statusCode: number,
  reason: string,
): void {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function hasRegisteredNode(): boolean {
  return getAllNodes().some((node) => node.socket.readyState === WebSocket.OPEN);
}

function streamRunId(data: Record<string, unknown>): string | undefined {
  return typeof data.runId === "string"
    ? data.runId
    : typeof data.run_id === "string"
      ? data.run_id
      : undefined;
}

function streamNodeId(data: Record<string, unknown>): string | undefined {
  return typeof data.nodeId === "string"
    ? data.nodeId
    : typeof data.node_id === "string"
      ? data.node_id
      : typeof data.fromNode === "string"
        ? data.fromNode
        : typeof data.from_node === "string"
          ? data.from_node
          : undefined;
}

function dataSessionId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const raw = data as Record<string, unknown>;
  return typeof raw.session_id === "string"
    ? raw.session_id
    : typeof raw.sessionId === "string"
      ? raw.sessionId
      : undefined;
}

function objectData(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function shouldIgnoreStaleSession(
  sourceId: string,
  messageType: string,
  data: Record<string, unknown>,
  explicitSessionId?: string,
): boolean {
  const runId = streamRunId(data);
  const nodeId = streamNodeId(data);
  const sessionId = explicitSessionId ?? dataSessionId(data);
  if (!runId || !nodeId || !sessionId) return false;
  const current = getCurrentNodeSession(runId, nodeId);
  if (!current || current.sessionId === sessionId) return false;
  emit("dag:stale_session_ignored", {
    runId,
    nodeId,
    sessionId,
    currentSessionId: current.sessionId,
    source: "node",
    sourceId,
    messageType,
  });
  return true;
}

function mirrorSessionTranscript(
  sourceId: string,
  type: string,
  runId: string | undefined,
  nodeId: string | undefined,
  sessionId: string | undefined,
  content: unknown,
): void {
  if (!runId || !nodeId || !sessionId) return;
  try {
    appendSessionTranscriptEntry({
      type,
      runId,
      nodeId,
      sessionId,
      content,
      metadata: { source: "node", sourceId },
    });
  } catch {
    // Best-effort mirror; websocket handling and DB chat remain authoritative.
  }
}

export interface NodeWebSocketOptions {
  registrationTimeoutMs?: number;
  pingIntervalMs?: number;
  onHandoffApplied?: (runId: string) => void;
}

export function setupNodeWebSocket(
  server: http.Server,
  options: NodeWebSocketOptions = {},
): WebSocketServer {
  const registrationTimeoutMs =
    options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? WS_URL_PATTERN.exec(req.url) : null;
    if (!match) {
      return;
    }

    const project_id = match[1];
    const node_id = match[2];

    if (!isLoopbackNodeRemoteAddress(req.socket.remoteAddress)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, project_id, node_id);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: http.IncomingMessage, project_id: string, node_id: string) => {
      let registered = false;
      let pingInterval: ReturnType<typeof setInterval> | null = null;

      const tryCorrectNode = (runId: string, dagNodeId: string, reason: string): boolean => {
        const correction = requestNodeCorrection(runId, dagNodeId, reason);
        if (correction.status === "scheduled") {
          options.onHandoffApplied?.(runId);
          return true;
        }
        if (correction.status === "exhausted") {
          const run = autoHandoffAfterCorrectionExhausted(runId, dagNodeId, reason);
          if (run) {
            options.onHandoffApplied?.(runId);
            return true;
          }
        }
        return false;
      };

      const registrationTimeout = setTimeout(() => {
        if (!registered) {
          ws.close(4000, "registration timeout");
        }
      }, registrationTimeoutMs);

      const cleanup = (reason: string): void => {
        clearTimeout(registrationTimeout);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (registered) {
          clearByTargetId(node_id);
          const node = getNode(node_id);
          if (node) {
            rejectAllPendingRequests(node, reason);
          }
          unregisterNode(node_id);
        }
      };

      ws.on("close", () => {
        cleanup(`node ${node_id} disconnected`);
      });

      ws.on("error", () => {
        cleanup(`node ${node_id} connection error`);
      });

      ws.on("message", (raw: Buffer) => {
        let msg: IncomingNodeMessage | null;
        try {
          const parsed = JSON.parse(raw.toString());
          msg = parseIncomingNodeMessage(parsed);
        } catch {
          msg = null;
        }

        if (!msg) return;

        if (msg.type === "register" || msg.type === "control") {
          const registeredNodeId = msg.type === "register" ? msg.node_id : msg.data.node_id;
          if (registeredNodeId !== node_id) {
            ws.close(4001, "node_id mismatch");
            clearTimeout(registrationTimeout);
            return;
          }

          if (!registered) {
            if (hasRegisteredNode()) {
              ws.close(4003, "only one local node is supported");
              clearTimeout(registrationTimeout);
              return;
            }
            registered = true;
            clearTimeout(registrationTimeout);
            const state: NodeState = {
              node_id,
              project_id,
              socket: ws,
              status: "idle",
              capabilities: [],
              registered_at: Date.now(),
              last_heartbeat: Date.now(),
              pending_requests: new Map(),
            };
            registerNode(state);
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                try {
                  ws.send(JSON.stringify({ type: "ping" }));
                } catch {
                  if (pingInterval) {
                    clearInterval(pingInterval);
                    pingInterval = null;
                  }
                }
              } else if (pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
              }
            }, pingIntervalMs);
          }
          return;
        }

        if (!registered) return;

        updateHeartbeat(node_id);

        if (msg.type === "pong" || msg.type === "heartbeat") {
          return;
        }

        if (msg.type === "content") {
          if (shouldIgnoreStaleSession(node_id, "content", msg.data)) return;
          const runId = streamRunId(msg.data);
          const nodeId = streamNodeId(msg.data);
          if (runId && nodeId) {
            appendChatEntry(runId, nodeId, {
              role: "node",
              type: "response",
              targetId: node_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(node_id, "text", runId, nodeId, msg.data.session_id, msg.data.text);
          }
          return;
        }

        if (msg.type === "response") {
          const responseData = objectData(msg.data);
          if (responseData && shouldIgnoreStaleSession(node_id, "response", responseData, msg.session_id)) return;
          const responseSessionId = msg.session_id ?? dataSessionId(responseData);

          const dagMessage = handleDagMessageResponse("node", node_id, msg.data);
          if (dagMessage.status !== "not_dag_message") {
            if (dagMessage.status === "malformed_payload") {
              emit("dag:response_handoff_failed", {
                runId: dagMessage.runId,
                nodeId: dagMessage.nodeId,
                reason: dagMessage.reason,
                source: "node",
                sourceId: node_id,
              });
            } else {
              appendChatEntry(dagMessage.runId, dagMessage.nodeId, {
                role: "node",
                type: "response",
                targetId: node_id,
                content: msg.data,
                timestamp: Date.now(),
              });
              mirrorSessionTranscript(
                node_id,
                "response",
                dagMessage.runId,
                dagMessage.nodeId,
                responseSessionId,
                msg.data,
              );
            }
            return;
          }

          const result = applyResponseHandoff(msg.data);
          if (result.status === "handoff_applied") {
            appendChatEntry(result.runId, result.nodeId, {
              role: "node",
              type: "response",
              targetId: node_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(
              node_id,
              "response",
              result.runId,
              result.nodeId,
              responseSessionId,
              msg.data,
            );
            emit("dag:response_handoff_applied", {
              runId: result.runId,
              nodeId: result.nodeId,
              port: result.port,
              source: "node",
              sourceId: node_id,
            });
            options.onHandoffApplied?.(result.runId);
          } else {
            emit("dag:response_handoff_failed", {
              runId: "runId" in result ? (result.runId as string) : undefined,
              nodeId: result.status === "handoff_failed" ? result.nodeId : undefined,
              reason:
                result.status === "malformed_payload"
                  ? result.reason
                  : result.status === "unknown_run"
                    ? `unknown run ${result.runId}`
                    : result.reason,
              source: "node",
              sourceId: node_id,
            });
            if (result.status === "handoff_failed") {
              tryCorrectNode(result.runId, result.nodeId, result.reason);
            }
          }
          return;
        }

        if (msg.type === "stream") {
          if (shouldIgnoreStaleSession(node_id, "stream", msg.data)) return;
          const runId = streamRunId(msg.data);
          const nodeId = streamNodeId(msg.data);
          if (runId && nodeId) {
            if (msg.data.event === "advisor_call_started" && typeof msg.data.advisor_id === "string") {
              recordAdvisorCall(runId, nodeId, msg.data.advisor_id);
            }
            const sessionId = dataSessionId(msg.data);
            appendChatEntry(runId, nodeId, {
              role: "node",
              type: "response",
              targetId: node_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(
              node_id,
              typeof msg.data.event === "string" ? `stream:${msg.data.event}` : "stream",
              runId,
              nodeId,
              sessionId,
              msg.data,
            );
          }
          return;
        }

        if (msg.type === "node_error") {
          if (shouldIgnoreStaleSession(node_id, "node_error", {
            runId: msg.data.runId,
            nodeId: msg.data.nodeId,
            session_id: msg.data.session_id,
          })) return;
          appendChatEntry(msg.data.runId, msg.data.nodeId, {
            role: "node",
            type: "response",
            targetId: node_id,
            content: msg.data,
            timestamp: Date.now(),
          });
          mirrorSessionTranscript(
            node_id,
            "node_error",
            msg.data.runId,
            msg.data.nodeId,
            msg.data.session_id,
            msg.data,
          );
          if (tryCorrectNode(msg.data.runId, msg.data.nodeId, msg.data.message)) {
            return;
          }
          const run = failActiveRun(msg.data.runId, msg.data.nodeId, msg.data.message);
          if (run?.status === "active") {
            options.onHandoffApplied?.(msg.data.runId);
          }
          return;
        }

        if (msg.type === "lifecycle_response") {
          const node = getNode(node_id);
          if (node) {
            resolveLifecycleResponse(
              node,
              msg.request_id,
              msg.status,
              msg.resource_data,
              msg.error,
            );
          }
          return;
        }

        if (msg.type === "status") {
          const node = getNode(node_id);
          if (node) {
            node.status = msg.data.status;
          }
          return;
        }

        if (msg.type === "capabilities") {
          updateCapabilities(node_id, msg.capabilities);
          return;
        }
      });
    }
  );

  return wss;
}

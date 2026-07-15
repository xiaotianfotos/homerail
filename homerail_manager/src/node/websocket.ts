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
import {
  applyResponseHandoff,
  assessDagTransportFence,
} from "../orchestration/response-bridge.js";
import { handleDagMessageResponse } from "../orchestration/dag-message-router.js";
import { clearByTargetId, isCurrentDispatchTarget } from "../orchestration/dispatch-tracker.js";
import { emit } from "../events/bus.js";
import { appendChatEntry } from "../persistence/store.js";
import { appendSessionTranscriptEntry } from "../persistence/dag-session-files.js";
import {
  autoHandoffAfterCorrectionExhausted,
  failActiveRun,
  getActiveRun,
  getCurrentNodeSession,
  recordAdvisorCall,
  requestNodeCorrection,
} from "../runtime/active-runs.js";
import {
  isControlPlaneUpgradeAuthorized,
  isLoopbackRemoteAddress,
  rejectWebSocketUpgrade,
} from "../server/control-plane-auth.js";
import { ingestDagActivityStream } from "../runtime/dag-activity-stream.js";

const WS_URL_PATTERN = /^\/ws\/projects\/([^\/]+)\/nodes\/([^\/]+)$/;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

export const isLoopbackNodeRemoteAddress = isLoopbackRemoteAddress;

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

function transportPayload(data: Record<string, unknown>): Record<string, unknown> {
  const runId = streamRunId(data);
  const nodeId = streamNodeId(data);
  return {
    ...data,
    ...(runId === undefined ? {} : { runId }),
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function dagActivityRoundContext(data: Record<string, unknown>, runId: string): string {
  const run = getActiveRun(runId);
  if (!run) throw new Error(`DAG activity run ${runId} is not active`);
  const currentRoundId = run.currentRound.round_id;
  if (data.round_id !== undefined) {
    if (typeof data.round_id !== "string" || !data.round_id.trim()) {
      throw new Error("DAG activity transport round is invalid");
    }
    if (data.round_id !== currentRoundId) {
      throw new Error(`DAG activity transport round ${data.round_id} is not current (${currentRoundId})`);
    }
    return currentRoundId;
  }

  const activityRoundId = objectData(data.activity)?.round_id;
  const sessionId = dataSessionId(data);
  if (run.currentRound.ordinal === 1 && typeof activityRoundId === "string" && activityRoundId === sessionId) {
    return activityRoundId;
  }
  return currentRoundId;
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

function isCurrentDagTransport(
  sourceId: string,
  messageType: string,
  data: Record<string, unknown>,
  explicitSessionId?: string,
): boolean {
  const payload = transportPayload(data);
  const assessment = assessDagTransportFence(payload, {
    targetType: "node",
    targetId: sourceId,
  });
  if (assessment.status === "current") return true;

  const runId = assessment.status === "malformed_payload" ? streamRunId(data) : assessment.runId;
  const nodeId = assessment.status === "malformed_payload" ? streamNodeId(data) : assessment.nodeId;
  const disposition = assessment.status === "ignored" ? assessment.disposition : assessment.status;
  const reason = assessment.status === "unknown_run"
    ? `unknown run ${assessment.runId}`
    : assessment.reason;
  const sessionId = explicitSessionId ?? dataSessionId(data);
  emit("dag:stale_lease_ignored", {
    runId,
    nodeId,
    source: "node",
    sourceId,
    messageType,
    disposition,
    reason,
  });
  mirrorSessionTranscript(
    sourceId,
    `stale_lease_${messageType}_ignored`,
    runId,
    nodeId,
    sessionId,
    {
      disposition,
      reason,
      lease_generation: typeof data.lease_generation === "number" ? data.lease_generation : undefined,
    },
  );
  return false;
}

export interface NodeWebSocketOptions {
  registrationTimeoutMs?: number;
  pingIntervalMs?: number;
  authToken?: string;
  allowLoopbackWithoutToken?: boolean;
  onHandoffApplied?: (runId: string) => void;
}

export function setupNodeWebSocket(
  server: http.Server,
  options: NodeWebSocketOptions = {},
): WebSocketServer {
  const registrationTimeoutMs =
    options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const authToken = options.authToken
    ?? process.env.HOMERAIL_NODE_TOKEN
    ?? process.env.HOMERAIL_CONTROL_PLANE_TOKEN;
  const allowLoopbackWithoutToken = options.allowLoopbackWithoutToken
    ?? !authToken?.trim();

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? WS_URL_PATTERN.exec(req.url) : null;
    if (!match) {
      return;
    }

    const project_id = match[1];
    const node_id = match[2];

    if (!isControlPlaneUpgradeAuthorized({
      remoteAddress: req.socket.remoteAddress,
      authorization: req.headers.authorization,
      configuredToken: authToken,
      allowLoopbackWithoutToken,
    })) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized");
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
        let rawMessage: unknown;
        try {
          rawMessage = JSON.parse(raw.toString());
          msg = parseIncomingNodeMessage(rawMessage);
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
          if (!isCurrentDagTransport(node_id, "content", msg.data)) return;
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
          if (responseData && !isCurrentDagTransport(node_id, "response", responseData, msg.session_id)) return;
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

          const result = applyResponseHandoff(msg.data, { targetType: "node", targetId: node_id });
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
            if (
              result.status === "handoff_ignored"
              && result.reason.startsWith("DAG_TRANSPORT_LEASE_")
            ) {
              emit("dag:stale_lease_ignored", {
                runId: result.runId,
                nodeId: result.nodeId,
                source: "node",
                sourceId: node_id,
                messageType: "response",
                disposition: result.disposition,
                reason: result.reason,
              });
              mirrorSessionTranscript(
                node_id,
                "stale_lease_response_ignored",
                result.runId,
                result.nodeId,
                responseSessionId,
                { disposition: result.disposition, reason: result.reason },
              );
              return;
            }
            const reason = result.status === "malformed_payload"
              ? result.reason
              : result.status === "unknown_run"
                ? `unknown run ${result.runId}`
                : result.reason;
            emit("dag:response_handoff_failed", {
              runId: "runId" in result ? (result.runId as string) : undefined,
              nodeId: result.status === "handoff_failed" || result.status === "handoff_ignored"
                ? result.nodeId
                : undefined,
              reason,
              source: "node",
              sourceId: node_id,
            });
            if (result.status === "handoff_ignored") {
              mirrorSessionTranscript(
                node_id,
                `handoff_${result.disposition}_ignored`,
                result.runId,
                result.nodeId,
                responseSessionId,
                { disposition: result.disposition, reason, payload: msg.data },
              );
            }
            if (result.status === "handoff_failed") {
              tryCorrectNode(result.runId, result.nodeId, result.reason);
            }
          }
          return;
        }

        if (msg.type === "stream") {
          const runId = streamRunId(msg.data);
          const nodeId = streamNodeId(msg.data);
          const messageType = msg.data.event === "dag_activity"
            ? "dag_activity"
            : msg.data.event === "usage"
              ? "usage"
              : "stream";
          if (!isCurrentDagTransport(node_id, messageType, msg.data)) {
            return;
          }
          if (msg.data.event === "dag_activity") {
            try {
              if (!runId || !nodeId) throw new Error("DAG activity transport identity is missing");
              const sessionId = dataSessionId(msg.data);
              if (!sessionId) throw new Error("DAG activity transport session is missing");
              if (!isCurrentDispatchTarget(runId, nodeId, "node", node_id)) {
                throw new Error("DAG activity source does not match the current dispatch target");
              }
              if (shouldIgnoreStaleSession(node_id, "dag_activity", msg.data)) return;
              const roundId = dagActivityRoundContext(msg.data, runId);
              ingestDagActivityStream(msg.data, {
                runId,
                nodeId,
                roundId,
              });
            } catch (error) {
              console.warn(
                `[homerail_manager] rejected DAG activity from node ${node_id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return;
          }
          if (shouldIgnoreStaleSession(node_id, "stream", msg.data)) return;
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
          const rawData = objectData(objectData(rawMessage)?.data) ?? msg.data;
          if (!isCurrentDagTransport(node_id, "node_error", rawData, msg.data.session_id)) return;
          if (shouldIgnoreStaleSession(node_id, "node_error", {
            runId: msg.data.runId,
            nodeId: msg.data.nodeId,
            session_id: msg.data.session_id,
          })) return;
          appendChatEntry(msg.data.runId, msg.data.nodeId, {
            role: "node",
            type: "response",
            targetId: node_id,
            content: rawData,
            timestamp: Date.now(),
          });
          mirrorSessionTranscript(
            node_id,
            "node_error",
            msg.data.runId,
            msg.data.nodeId,
            msg.data.session_id,
            rawData,
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

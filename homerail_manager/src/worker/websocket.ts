import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  parseIncomingMessage,
  type IncomingWorkerMessage,
} from "./types.js";
import {
  registerWorker,
  unregisterWorker,
  updateHeartbeat,
  getWorker,
  type WorkerState,
} from "./registry.js";
import { applyResponseHandoff } from "../orchestration/response-bridge.js";
import { handleDagMessageResponse } from "../orchestration/dag-message-router.js";
import { clearByTargetId } from "../orchestration/dispatch-tracker.js";
import { emit } from "../events/bus.js";
import { appendChatEntry, appendNodeUsage } from "../persistence/store.js";
import { appendSessionTranscriptEntry } from "../persistence/dag-session-files.js";
import {
  autoHandoffAfterCorrectionExhausted,
  failActiveRun,
  getCurrentNodeSession,
  recordAdvisorCall,
  requestNodeCorrection,
} from "../runtime/active-runs.js";
import {
  isControlPlaneUpgradeAuthorized,
  rejectWebSocketUpgrade,
} from "../server/control-plane-auth.js";

const WS_URL_PATTERN = /^\/ws\/projects\/([^\/]+)\/workers\/([^\/]+)$/;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

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
    source: "worker",
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
      metadata: { source: "worker", sourceId },
    });
  } catch {
    // Best-effort mirror; websocket handling and DB chat remain authoritative.
  }
}

export interface WorkerWebSocketOptions {
  registrationTimeoutMs?: number;
  pingIntervalMs?: number;
  authToken?: string;
  allowLoopbackWithoutToken?: boolean;
  onHandoffApplied?: (runId: string) => void;
  onManagerCommand?: (
    workerId: string,
    data: Record<string, unknown>,
  ) => { ok: boolean; result?: unknown; error?: string };
  /** Fired once, after the first worker successfully registers. Used by the
   * cold-recovery boot path to re-dispatch READY nodes of recovered runs now
   * that a dispatch target exists. */
  onFirstWorkerRegistered?: () => void;
}

export function setupWorkerWebSocket(
  server: http.Server,
  options: WorkerWebSocketOptions = {},
): WebSocketServer {
  const registrationTimeoutMs =
    options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const authToken = options.authToken
    ?? process.env.HOMERAIL_WORKER_TOKEN
    ?? process.env.HOMERAIL_CONTROL_PLANE_TOKEN;
  const allowLoopbackWithoutToken = options.allowLoopbackWithoutToken
    ?? !authToken?.trim();

  let firstWorkerFired = false;

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? WS_URL_PATTERN.exec(req.url) : null;
    if (!match) {
      return;
    }

    const project_id = match[1];
    const worker_id = match[2];

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
      wss.emit("connection", ws, req, project_id, worker_id);
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: http.IncomingMessage, project_id: string, worker_id: string) => {
      let registered = false;
      let pingInterval: ReturnType<typeof setInterval> | null = null;

      const tryCorrectNode = (runId: string, nodeId: string, reason: string): boolean => {
        const correction = requestNodeCorrection(runId, nodeId, reason);
        if (correction.status === "scheduled") {
          options.onHandoffApplied?.(runId);
          return true;
        }
        if (correction.status === "exhausted") {
          const run = autoHandoffAfterCorrectionExhausted(runId, nodeId, reason);
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

      const cleanup = (): void => {
        clearTimeout(registrationTimeout);
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        if (registered) {
          clearByTargetId(worker_id);
          unregisterWorker(worker_id);
        }
      };

      ws.on("close", cleanup);
      ws.on("error", cleanup);

      ws.on("message", (raw: Buffer) => {
        let msg: IncomingWorkerMessage | null;
        try {
          const parsed = JSON.parse(raw.toString());
          msg = parseIncomingMessage(parsed);
        } catch {
          msg = null;
        }

        if (!msg) return;

        if (msg.type === "register" || msg.type === "control") {
          const registeredWorkerId = msg.type === "register" ? msg.worker_id : msg.data.worker_id;
          const capabilities = msg.type === "register" ? msg.capabilities : msg.data.capabilities;
          if (registeredWorkerId !== worker_id) {
            ws.close(4001, "worker_id mismatch");
            clearTimeout(registrationTimeout);
            return;
          }

          if (!registered) {
            registered = true;
            clearTimeout(registrationTimeout);
            const state: WorkerState = {
              worker_id,
              project_id,
              socket: ws,
              status: "idle",
              capabilities: capabilities ?? [],
              registered_at: Date.now(),
              last_heartbeat: Date.now(),
            };
            registerWorker(state);
            if (!firstWorkerFired) {
              // Process-local hook: only the first successfully registered
              // worker should trigger cold-recovery re-dispatch for this
              // Manager process.
              firstWorkerFired = true;
              try {
                options.onFirstWorkerRegistered?.();
              } catch (err) {
                // Recovery re-dispatch is best-effort; never let a hook error
                // break worker registration.
                console.error(
                  `[homerail_manager] first worker recovery hook failed for worker ${worker_id}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
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

        updateHeartbeat(worker_id);

        if (msg.type === "pong" || msg.type === "heartbeat") {
          return;
        }

        if (msg.type === "content") {
          if (shouldIgnoreStaleSession(worker_id, "content", msg.data)) return;
          const runId = streamRunId(msg.data);
          const nodeId = streamNodeId(msg.data);
          if (runId && nodeId) {
            appendChatEntry(runId, nodeId, {
              role: "worker",
              type: "response",
              targetId: worker_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(worker_id, "text", runId, nodeId, msg.data.session_id, msg.data.text);
          }
          return;
        }

        if (msg.type === "response") {
          const responseData = objectData(msg.data);
          if (responseData && shouldIgnoreStaleSession(worker_id, "response", responseData, msg.session_id)) return;
          const responseSessionId = msg.session_id ?? dataSessionId(responseData);

          const dagMessage = handleDagMessageResponse("worker", worker_id, msg.data);
          if (dagMessage.status !== "not_dag_message") {
            if (dagMessage.status === "malformed_payload") {
              emit("dag:response_handoff_failed", {
                runId: dagMessage.runId,
                nodeId: dagMessage.nodeId,
                reason: dagMessage.reason,
                source: "worker",
                sourceId: worker_id,
              });
            } else {
              appendChatEntry(dagMessage.runId, dagMessage.nodeId, {
                role: "worker",
                type: "response",
                targetId: worker_id,
                content: msg.data,
                timestamp: Date.now(),
              });
              mirrorSessionTranscript(
                worker_id,
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
              role: "worker",
              type: "response",
              targetId: worker_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(
              worker_id,
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
              source: "worker",
              sourceId: worker_id,
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
              source: "worker",
              sourceId: worker_id,
            });
            if (result.status === "handoff_failed") {
              tryCorrectNode(result.runId, result.nodeId, result.reason);
            }
          }
          return;
        }

        if (msg.type === "stream") {
          if (shouldIgnoreStaleSession(worker_id, "stream", msg.data)) return;
          const runId = streamRunId(msg.data);
          const nodeId = streamNodeId(msg.data);
          if (runId && nodeId) {
            if (msg.data.event === "advisor_call_started" && typeof msg.data.advisor_id === "string") {
              recordAdvisorCall(runId, nodeId, msg.data.advisor_id);
            }
            const sessionId = dataSessionId(msg.data);
            appendChatEntry(runId, nodeId, {
              role: "worker",
              type: "response",
              targetId: worker_id,
              content: msg.data,
              timestamp: Date.now(),
            });
            mirrorSessionTranscript(
              worker_id,
              typeof msg.data.event === "string" ? `stream:${msg.data.event}` : "stream",
              runId,
              nodeId,
              sessionId,
              msg.data,
            );
            // Persist per-node token usage when the worker reports a
            // "usage" stream event. The worker emits cumulative totals,
            // so we append a record; the metrics endpoint treats the last
            // record per node as authoritative.
            if (msg.data.event === "usage") {
              const rawUsage = msg.data.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
              if (rawUsage) {
                appendNodeUsage({
                  runId,
                  nodeId,
                  usage: {
                    input_tokens: Number(rawUsage.input_tokens ?? 0),
                    output_tokens: Number(rawUsage.output_tokens ?? 0),
                    cache_read_input_tokens: Number(rawUsage.cache_read_input_tokens ?? 0),
                    cache_creation_input_tokens: Number(rawUsage.cache_creation_input_tokens ?? 0),
                  },
                  duration_ms: typeof msg.data.duration_ms === "number" ? msg.data.duration_ms : undefined,
                  num_turns: typeof msg.data.num_turns === "number" ? msg.data.num_turns : undefined,
                  timestamp: Date.now(),
                });
              }
            }
          }
          return;
        }

        if (msg.type === "node_error") {
          if (shouldIgnoreStaleSession(worker_id, "node_error", {
            runId: msg.data.runId,
            nodeId: msg.data.nodeId,
            session_id: msg.data.session_id,
          })) return;
          appendChatEntry(msg.data.runId, msg.data.nodeId, {
            role: "worker",
            type: "response",
            targetId: worker_id,
            content: msg.data,
            timestamp: Date.now(),
          });
          mirrorSessionTranscript(
            worker_id,
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

        if (msg.type === "manager_command") {
          const result = options.onManagerCommand?.(worker_id, msg.data) ?? {
            ok: false,
            error: "manager command handler unavailable",
          };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "manager_command_result",
              data: result,
            }));
          }
          return;
        }

        if (msg.type === "status") {
          const worker = getWorker(worker_id);
          if (worker) {
            worker.status = msg.data.status;
          }
          return;
        }
      });
    }
  );

  return wss;
}

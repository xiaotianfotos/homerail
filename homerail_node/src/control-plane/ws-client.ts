import WebSocket from "ws";
import type { ExecutionProvider } from "../providers/types.js";
import { handleLifecycleRequest, type LifecycleRequest, type LifecycleResponse } from "./lifecycle-handler.js";
import type { PluginRuntimeService } from "../runtime/plugin-runtime-service.js";
import { assertSecureControlPlaneUrl } from "./security.js";
import { createWorkspaceArtifactUploader } from "../storage/workspace-artifact-uploader.js";

export interface NodeClientOptions {
  managerUrl: string;
  projectId: string;
  nodeId: string;
  provider: ExecutionProvider;
  capabilities?: string[];
  token?: string;
  allowInsecureRemote?: boolean;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  pluginRuntime?: PluginRuntimeService;
}

export interface NodeClient {
  connect(): Promise<void>;
  close(): void;
  readonly connected: boolean;
}

export function createNodeClient(options: NodeClientOptions): NodeClient {
  const { managerUrl, projectId, nodeId, provider } = options;
  let ws: WebSocket | null = null;
  let registered = false;
  let closed = false;
  let connectPromise: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const url = `${managerUrl}/ws/projects/${projectId}/nodes/${nodeId}`;
  assertSecureControlPlaneUrl(url, options.allowInsecureRemote ?? false);
  const token = options.token?.trim();
  const initialDelay = Math.max(50, options.reconnectInitialDelayMs ?? 1_000);
  const maxDelay = Math.max(initialDelay, options.reconnectMaxDelayMs ?? 30_000);
  const workspaceArtifactUploader = createWorkspaceArtifactUploader(managerUrl);

  function sendRegistration(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: "register", node_id: nodeId }));
    if (options.capabilities?.length) {
      socket.send(JSON.stringify({
        type: "capabilities",
        capabilities: options.capabilities,
      }));
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = Math.min(maxDelay, initialDelay * (2 ** reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket(false).catch(() => {
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  function openSocket(initial: boolean): Promise<void> {
    if (ws?.readyState === WebSocket.OPEN && registered) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const headers = token
        ? { Authorization: `Bearer ${token}` }
        : undefined;
      const socket = new WebSocket(url, { headers });
      let settled = false;

      const settleError = (err: Error) => {
        if (settled) return;
        settled = true;
        if (initial) reject(err);
        else {
          reject(err);
          scheduleReconnect();
        }
      };

      socket.once("open", () => {
        ws = socket;
        registered = true;
        reconnectAttempt = 0;
        sendRegistration(socket);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.on("error", (err) => {
        settleError(err instanceof Error ? err : new Error(String(err)));
      });

      socket.on("message", (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!msg || typeof msg !== "object") return;
        const obj = msg as Record<string, unknown>;

        if (obj.type === "ping") {
          try {
            socket.send(JSON.stringify({ type: "pong" }));
          } catch { /* ignore */ }
          return;
        }

        if (obj.type === "lifecycle_request") {
          const request = obj as unknown as LifecycleRequest;
          const send = (resp: LifecycleResponse) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(resp));
            }
          };
          handleLifecycleRequest(request, provider, send, {
            workspaceArtifactUploader,
            pluginRuntime: options.pluginRuntime,
          }).catch(() => {
            // Handler already sends error response
          });
        }
      });

      socket.on("close", () => {
        if (ws === socket) ws = null;
        registered = false;
        if (!settled) {
          settled = true;
          const err = new Error("WebSocket closed before registration completed");
          if (initial) reject(err);
        }
        scheduleReconnect();
      });
    });
  }

  return {
    get connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN && registered;
    },

    connect(): Promise<void> {
      closed = false;
      if (!connectPromise) {
        connectPromise = openSocket(true).finally(() => {
          connectPromise = null;
        });
      }
      return connectPromise;
    },

    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
        registered = false;
      }
    },
  };
}

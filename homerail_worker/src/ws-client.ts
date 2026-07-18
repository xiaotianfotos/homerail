/**
 * WebSocket client — connects to Manager worker endpoint with
 * registration, heartbeat, reconnect, and message framing.
 * @version 0.1.0
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { assertSecureControlPlaneUrl } from "./control-plane-security.js";

export interface WsClientOptions {
  url: string;
  workerId: string;
  capabilities?: string[];
  token?: string;
  allowInsecureRemote?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface WsMessage {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly opts: Required<WsClientOptions>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private closed = false;
  private connected = false;

  constructor(opts: WsClientOptions) {
    super();
    this.opts = {
      url: opts.url,
      workerId: opts.workerId,
      capabilities: opts.capabilities ?? [],
      token: opts.token?.trim() ?? "",
      allowInsecureRemote: opts.allowInsecureRemote ?? false,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30_000,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 10_000,
      reconnectBaseMs: opts.reconnectBaseMs ?? 1_000,
      reconnectMaxMs: opts.reconnectMaxMs ?? 60_000,
    };
    assertSecureControlPlaneUrl(this.opts.url, this.opts.allowInsecureRemote);
    this.reconnectDelay = this.opts.reconnectBaseMs;
  }

  connect(): void {
    if (this.closed) return;

    const headers: Record<string, string> = {};
    if (this.opts.token) {
      headers.Authorization = `Bearer ${this.opts.token}`;
    }

    this.ws = new WebSocket(this.opts.url, { headers });

    this.ws.on("open", () => {
      this.connected = true;
      this.reconnectDelay = this.opts.reconnectBaseMs;
      this.register();
      this.startHeartbeat();
      this.emit("connected");
    });

    this.ws.on("message", (data) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        this.emit("error", new Error(`Invalid JSON: ${data}`));
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.stopHeartbeat();
      this.emit("disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private register(): void {
    this.send(
      JSON.stringify({
        type: "control",
        action: "register",
        data: {
          worker_id: this.opts.workerId,
          capabilities: this.opts.capabilities,
        },
      }),
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Send pong in response to ping — Manager sends ping, we just need to
      // verify the connection is alive. If no ping arrives within timeout,
      // the connection is stale.
      this.send(JSON.stringify({ type: "pong" }));
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleMessage(msg: WsMessage): void {
    switch (msg.type) {
      case "ping":
        this.send(JSON.stringify({ type: "pong" }));
        break;
      case "task":
      case "prompt":
        this.emit("task", msg);
        break;
      case "dag_inbox":
        this.emit("dag_inbox", msg);
        break;
      case "dag_actor_command":
        this.emit("dag_actor_command", msg);
        break;
      case "credential_broker_result":
        this.emit("credential_broker_result", msg);
        break;
      case "inject":
        this.emit("inject", msg);
        break;
      default:
        this.emit("message", msg);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.opts.reconnectMaxMs,
    );
  }
}

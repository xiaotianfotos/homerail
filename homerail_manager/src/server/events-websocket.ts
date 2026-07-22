import * as http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  DAG_EVENT_TYPES,
  subscribe,
  type DAGEventPayload,
  type DAGEventType,
} from "../events/bus.js";

const WS_EVENTS_URL_PATTERN = /^\/ws\/events(?:\?.*)?$/;
const EPHEMERAL_BROWSER_EVENT_TYPES: DAGEventType[] = ["dag:node_chat_updated"];

interface EventWebSocketMessage {
  type: string;
  event: string;
  payload?: DAGEventPayload;
  timestamp: string;
}

function sendJson(ws: WebSocket, message: EventWebSocketMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

export function setupEventWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const match = req.url ? WS_EVENTS_URL_PATTERN.exec(req.url) : null;
    if (!match) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const unsubscribe = [...DAG_EVENT_TYPES, ...EPHEMERAL_BROWSER_EVENT_TYPES].map((type: DAGEventType) =>
      subscribe(type, (payload) => {
        sendJson(ws, {
          type,
          event: type,
          payload,
          timestamp: new Date().toISOString(),
        });
      }),
    );

    const cleanup = (): void => {
      for (const unsub of unsubscribe) unsub();
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    sendJson(ws, {
      type: "manager:events_connected",
      event: "manager:events_connected",
      timestamp: new Date().toISOString(),
    });
  });

  return wss;
}

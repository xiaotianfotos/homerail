import type { PersistedEvent, PersistedRunMetadata } from "../persistence/types.js";

const TERMINAL_DAG_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const TERMINAL_DAG_RUN_EVENTS = new Set([
  "dag:run_completed",
  "dag:run_failed",
  "dag:run_cancelled",
  "dag:run_expired",
]);

export function isTerminalDagRunStatus(status: string): boolean {
  return TERMINAL_DAG_RUN_STATUSES.has(status);
}

export function isTerminalDagRunEvent(eventType: string): boolean {
  return TERMINAL_DAG_RUN_EVENTS.has(eventType);
}

export interface SuperviseTickData {
  run_id: string;
  cursor: number;
  next_cursor: number;
  changed: boolean;
  terminal: boolean;
  severity: "info" | "warning" | "error";
  summary: string;
  events: Array<{
    type: string;
    timestamp: number;
    event_type: string;
    node_id: string;
    details: unknown;
  }>;
}

function normalizeEvent(event: PersistedEvent) {
  const payload = event.payload as unknown as Record<string, unknown>;
  const rawType = event.type;
  const eventType = rawType.startsWith("dag:") ? rawType.slice(4) : rawType;
  const nodeId =
    (typeof payload.fromNode === "string" && payload.fromNode) ||
    (typeof payload.from_node === "string" && payload.from_node) ||
    (typeof payload.nodeId === "string" && payload.nodeId) ||
    (typeof payload.node_id === "string" && payload.node_id) ||
    (typeof payload.runId === "string" && payload.runId) ||
    "";
  return {
    type: rawType,
    timestamp: event.timestamp,
    event_type: eventType,
    node_id: nodeId,
    details: payload,
  };
}

export function computeSuperviseTick(
  runId: string,
  metadata: PersistedRunMetadata,
  events: PersistedEvent[],
  cursor: number,
): SuperviseTickData {
  const newEvents = events.filter((e) => e.timestamp > cursor);
  const changed = newEvents.length > 0;
  const terminal = isTerminalDagRunStatus(metadata.status);

  const completedNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "COMPLETED")
    .map(([id]) => id);
  const totalNodes = Object.keys(metadata.nodeStates).length;

  let severity: "info" | "warning" | "error";
  if (terminal && metadata.status === "completed") {
    severity = "info";
  } else if (!terminal && changed) {
    severity = "warning";
  } else if (terminal && metadata.status !== "completed") {
    severity = "error";
  } else {
    severity = "warning";
  }

  const summary = `Run ${runId} has ${events.length} events, ${completedNodes.length}/${totalNodes} nodes completed, status: ${metadata.status}`;

  const nextCursor =
    newEvents.length > 0
      ? Math.max(...newEvents.map((e) => e.timestamp)) + 1
      : cursor;

  return {
    run_id: runId,
    cursor,
    next_cursor: nextCursor,
    changed,
    terminal,
    severity,
    summary,
    events: newEvents.map(normalizeEvent),
  };
}

import { clearTables, encodeJson, getDb, parseJsonRow } from "./db.js";
import type {
  PersistedRunMetadata,
  PersistedEvent,
  HandoffRecord,
  ChatEntry,
  PersistedRunSnapshot,
  PersistedGraphData,
  NodeUsageRecord,
} from "./types.js";
import type { DAGGraphData, DAGPatternInstanceMeta, ScorecardPolicyConfig } from "../orchestration/graph.js";
import { DAG_EVENT_TYPES, subscribe, type DAGEventPayload } from "../events/bus.js";
import type { DAGRunCounters, DAGRunLimits } from "../runtime/active-runs.js";
import { assertStatus, type DagRunStatus } from "./status.js";
import { assertEpochMs, nowEpochMs } from "./time.js";

// Contract marker for regression: "dag:instruction_terminal_no_active_target"
// is persisted through DAG_EVENT_TYPES.
interface SerializableRun {
  runId: string;
  workflowId?: string;
  workflowName?: string;
  nodeCount?: number;
  agents?: Record<string, { agent_type?: string; model?: string; system?: string; description?: string; skills?: string[]; extra?: Record<string, unknown> }>;
  workspace?: Record<string, unknown>;
  scorecard?: ScorecardPolicyConfig;
  pattern?: DAGPatternInstanceMeta;
  createdAt: number;
  status: DagRunStatus;
  completedAt?: number;
  limits?: DAGRunLimits;
  counters?: DAGRunCounters;
  dagRun: {
    nodeStates: Map<string, string>;
    handoffedNodes: Set<string>;
    graph: DAGGraphData;
  };
}

function _safeId(value: string, label: string): string {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty relative identifier`);
  }
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`${label} contains an unsafe path segment`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(part)) {
      throw new Error(`${label} contains unsupported characters`);
    }
  }
  return value;
}

function _safeRunId(runId: string): string {
  return _safeId(runId, "runId");
}

function _safeNodeId(nodeId: string): string {
  return _safeId(nodeId, "nodeId");
}

function _minimalMetadata(runId: string): PersistedRunMetadata {
  const now = nowEpochMs();
  return {
    runId,
    createdAt: now,
    status: "active",
    nodeStates: {},
    handoffedNodes: [],
  };
}

function _ensureRunExists(runId: string): void {
  _safeRunId(runId);
  const existing = getDb()
    .prepare("SELECT run_id FROM dag_runs WHERE run_id = ?")
    .get(runId) as { run_id: string } | undefined;
  if (existing) return;
  const metadata = _minimalMetadata(runId);
  getDb()
    .prepare(`
      INSERT INTO dag_runs(
        run_id, status, created_at, updated_at, workflow_id, workflow_name,
        completed_at, graph, node_states, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      runId,
      metadata.status,
      metadata.createdAt,
      metadata.createdAt,
      null,
      null,
      null,
      null,
      encodeJson(metadata.nodeStates),
      encodeJson(metadata),
    );
}

export function ensureRunDir(runId: string): void {
  _ensureRunExists(runId);
}

export function writeRunMetadata(runId: string, metadata: PersistedRunMetadata): void {
  _safeRunId(runId);
  assertStatus("dag_run", metadata.status);
  const createdAt = assertEpochMs(metadata.createdAt, "dag_runs.created_at");
  const updatedAt = metadata.completedAt === undefined
    ? nowEpochMs()
    : assertEpochMs(metadata.completedAt, "dag_runs.updated_at");
  const completedAt = metadata.completedAt === undefined
    ? null
    : assertEpochMs(metadata.completedAt, "dag_runs.completed_at");
  getDb()
    .prepare(`
      INSERT INTO dag_runs(
        run_id, status, created_at, updated_at, workflow_id, workflow_name,
        completed_at, graph, node_states, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        workflow_id = excluded.workflow_id,
        workflow_name = excluded.workflow_name,
        completed_at = excluded.completed_at,
        graph = excluded.graph,
        node_states = excluded.node_states,
        metadata = excluded.metadata
    `)
    .run(
      runId,
      metadata.status,
      createdAt,
      updatedAt,
      metadata.workflowId ?? null,
      metadata.workflowName ?? null,
      completedAt,
      metadata.graph ? encodeJson(metadata.graph) : null,
      encodeJson(metadata.nodeStates),
      encodeJson(metadata),
    );
}

function _serializeGraph(graph: DAGGraphData): PersistedGraphData {
  return {
    nodes: graph.nodes.map((n) => ({
      node_id: n.node_id,
      name: n.name,
      description: n.description,
      node_type: n.node_type,
      agent: n.agent,
      after: n.after,
      outputs: n.outputs,
      image: n.image,
      container_group: n.container_group,
      requires: n.requires,
      gateway_config: n.gateway_config,
      extra: n.extra,
    })),
    edges: graph.edges.map((e) => ({
      from_node: e.from_node,
      from_port: e.from_port,
      to_node: e.to_node,
      to_port: e.to_port,
      condition: e.condition,
      label: e.label,
      retry_policy: e.retry_policy,
    })),
  };
}

export function serializeRunMetadata(run: SerializableRun): PersistedRunMetadata {
  const nodeStates: Record<string, string> = {};
  for (const [nodeId, state] of run.dagRun.nodeStates) {
    nodeStates[nodeId] = state;
  }
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    nodeCount: run.nodeCount,
    agents: run.agents,
    workspace: run.workspace,
    scorecard: run.scorecard,
    pattern: run.pattern,
    createdAt: run.createdAt,
    status: run.status,
    completedAt: run.completedAt,
    limits: run.limits,
    counters: run.counters,
    nodeStates,
    handoffedNodes: Array.from(run.dagRun.handoffedNodes),
    graph: _serializeGraph(run.dagRun.graph),
  };
}

export function appendEvent(runId: string, event: PersistedEvent): void {
  _ensureRunExists(runId);
  getDb()
    .prepare("INSERT INTO dag_events(run_id, event_type, timestamp, data) VALUES (?, ?, ?, ?)")
    .run(runId, event.type, assertEpochMs(event.timestamp, "dag_events.timestamp"), encodeJson(event));
}

export function appendHandoff(runId: string, record: HandoffRecord): void {
  _ensureRunExists(runId);
  getDb()
    .prepare("INSERT INTO dag_handoffs(run_id, timestamp, data) VALUES (?, ?, ?)")
    .run(runId, assertEpochMs(record.timestamp, "dag_handoffs.timestamp"), encodeJson(record));
}

export function appendChatEntry(runId: string, nodeId: string, entry: ChatEntry): void {
  _ensureRunExists(runId);
  _safeNodeId(nodeId);
  getDb()
    .prepare("INSERT INTO dag_chats(run_id, node_id, timestamp, data) VALUES (?, ?, ?, ?)")
    .run(runId, nodeId, entry.timestamp === undefined ? null : assertEpochMs(entry.timestamp, "dag_chats.timestamp"), encodeJson(entry));
}

export function appendNodeUsage(record: NodeUsageRecord): void {
  _ensureRunExists(record.runId);
  _safeNodeId(record.nodeId);
  getDb()
    .prepare("INSERT INTO dag_metrics(run_id, node_id, timestamp, data) VALUES (?, ?, ?, ?)")
    .run(record.runId, record.nodeId, record.timestamp === undefined ? null : assertEpochMs(record.timestamp, "dag_metrics.timestamp"), encodeJson(record));
}

export function loadNodeUsages(runId: string): NodeUsageRecord[] {
  _safeRunId(runId);
  return (getDb()
    .prepare("SELECT data FROM dag_metrics WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ data: string }>)
    .map((row) => parseJsonRow<NodeUsageRecord>(row.data));
}

export function loadRunSnapshot(runId: string): PersistedRunSnapshot | undefined {
  const metadata = loadRunMetadata(runId);
  if (!metadata) return undefined;

  const events = (getDb()
    .prepare("SELECT data FROM dag_events WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ data: string }>)
    .map((row) => parseJsonRow<PersistedEvent>(row.data));
  const handoffs = (getDb()
    .prepare("SELECT data FROM dag_handoffs WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ data: string }>)
    .map((row) => parseJsonRow<HandoffRecord>(row.data));

  const chats: Record<string, ChatEntry[]> = {};
  const chatRows = getDb()
    .prepare("SELECT node_id, data FROM dag_chats WHERE run_id = ? ORDER BY seq")
    .all(runId) as Array<{ node_id: string; data: string }>;
  for (const row of chatRows) {
    chats[row.node_id] ??= [];
    chats[row.node_id].push(parseJsonRow<ChatEntry>(row.data));
  }

  const usages = loadNodeUsages(runId);

  return { metadata, events, handoffs, chats, usages };
}

export function loadRunMetadata(runId: string): PersistedRunMetadata | undefined {
  _safeRunId(runId);
  const row = getDb()
    .prepare("SELECT metadata FROM dag_runs WHERE run_id = ?")
    .get(runId) as { metadata: string } | undefined;
  return row ? parseJsonRow<PersistedRunMetadata>(row.metadata) : undefined;
}

export function listPersistedRunIds(): string[] {
  return (getDb()
    .prepare("SELECT run_id FROM dag_runs ORDER BY updated_at DESC, run_id")
    .all() as Array<{ run_id: string }>)
    .map((row) => row.run_id);
}

export function _clearAllPersistence(): void {
  clearTables(["dag_metrics", "dag_chats", "dag_handoffs", "dag_events", "dag_runs"]);
}

export function initEventLogging(): void {
  for (const eventType of DAG_EVENT_TYPES) {
    subscribe(eventType, (payload: DAGEventPayload) => {
      // Extract runId from payload if available for per-run DB routing.
      const p = payload as unknown as Record<string, unknown>;
      const runId = typeof p.runId === "string" ? p.runId : undefined;
      if (!runId) return;
      appendEvent(runId, {
        type: eventType,
        payload,
        timestamp: nowEpochMs(),
      });
    });
  }
}

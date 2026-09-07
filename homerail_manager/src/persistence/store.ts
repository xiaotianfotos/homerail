import { clearTables, encodeJson, getDb, parseJsonRow } from "./db.js";
import type {
  PersistedRunMetadata,
  PersistedEvent,
  HandoffRecord,
  ChatEntry,
  PersistedRunSnapshot,
  PersistedGraphData,
  NodeUsageRecord,
  RunWorkspaceRetention,
  PersistedCurrentDagRunRound,
  PersistedDagRuntimeState,
} from "./types.js";
import type { DAGArtifactDeclaration, DAGGraphData, DAGPatternInstanceMeta, ScorecardPolicyConfig } from "../orchestration/graph.js";
import { DAG_EVENT_TYPES, emit, subscribe, type DAGEventPayload } from "../events/bus.js";
import type { DAGRunCounters, DAGRunLimits } from "../runtime/active-runs.js";
import { assertStatus, type DagRunStatus } from "./status.js";
import { assertEpochMs, nowEpochMs } from "./time.js";
import { redactTelemetry, type DagRunInputBinding } from "homerail-protocol";

// Contract marker for regression: "dag:instruction_terminal_no_active_target"
// is persisted through DAG_EVENT_TYPES.
export interface SerializableRun {
  runId: string;
  workflowId?: string;
  workflowName?: string;
  workflowRevision?: number;
  canonicalHash?: string;
  compilerVersion?: string;
  sourceApiVersion?: string;
  contracts?: Record<string, unknown>;
  artifacts?: DAGArtifactDeclaration[];
  runInputTargets?: Array<{ node: string; port: string; contract?: string }>;
  inputArtifacts?: DagRunInputBinding[];
  brokerState?: Record<string, unknown>;
  initialPrompt?: string;
  nodeCount?: number;
  agents?: Record<string, { agent_type?: string; model?: string; system?: string; description?: string; skills?: string[]; allowed_surface_views?: string[]; extra?: Record<string, unknown> }>;
  workspace?: Record<string, unknown>;
  workspaceRetention?: RunWorkspaceRetention;
  scorecard?: ScorecardPolicyConfig;
  pattern?: DAGPatternInstanceMeta;
  createdAt: number;
  status: DagRunStatus;
  currentRound?: PersistedCurrentDagRunRound;
  completedAt?: number;
  limits?: DAGRunLimits;
  counters?: DAGRunCounters;
  dagRun: {
    nodeStates: Map<string, string>;
    handoffedNodes: Set<string>;
    graph: DAGGraphData;
    afterSatisfied?: ReadonlyMap<string, ReadonlySet<string>>;
    inputSatisfied?: ReadonlyMap<string, ReadonlySet<string>>;
    mailboxes?: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>;
    loopSources?: ReadonlySet<string>;
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
      terminal_outcome: e.terminal_outcome,
      label: e.label,
      retry_policy: e.retry_policy,
    })),
  };
}

function _serializeSetMap(
  values: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of Array.from(values.keys()).sort()) {
    result[key] = Array.from(values.get(key) ?? []).sort();
  }
  return result;
}

function _serializeMailboxes(
  mailboxes: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
): Record<string, Record<string, unknown[]>> {
  const result: Record<string, Record<string, unknown[]>> = {};
  for (const nodeId of Array.from(mailboxes.keys()).sort()) {
    const ports: Record<string, unknown[]> = {};
    const mailbox = mailboxes.get(nodeId);
    if (mailbox) {
      for (const port of Array.from(mailbox.keys()).sort()) {
        ports[port] = Array.from(mailbox.get(port) ?? []);
      }
    }
    result[nodeId] = ports;
  }
  return result;
}

function _serializeDagRuntimeState(run: SerializableRun): PersistedDagRuntimeState | undefined {
  const { afterSatisfied, inputSatisfied, mailboxes, loopSources } = run.dagRun;
  if (!afterSatisfied || !inputSatisfied || !mailboxes || !loopSources) return undefined;
  return {
    after_satisfied: _serializeSetMap(afterSatisfied),
    input_satisfied: _serializeSetMap(inputSatisfied),
    mailboxes: _serializeMailboxes(mailboxes),
    loop_sources: Array.from(loopSources).sort(),
  };
}

function _serializeCurrentRound(
  round: SerializableRun["currentRound"],
): PersistedCurrentDagRunRound | undefined {
  if (!round) return undefined;
  return {
    round_id: round.round_id,
    ordinal: round.ordinal,
    status: round.status,
    target_actor_ids: Array.from(new Set(round.target_actor_ids)).sort(),
    ...(round.await_node_id === undefined ? {} : { await_node_id: round.await_node_id }),
    opened_at: round.opened_at,
    ...(round.closed_at === undefined ? {} : { closed_at: round.closed_at }),
    ...(round.expires_at === undefined ? {} : { expires_at: round.expires_at }),
  };
}

export function serializeRunMetadata(run: SerializableRun): PersistedRunMetadata {
  const nodeStates: Record<string, string> = {};
  for (const nodeId of Array.from(run.dagRun.nodeStates.keys()).sort()) {
    nodeStates[nodeId] = run.dagRun.nodeStates.get(nodeId)!;
  }
  const currentRound = _serializeCurrentRound(run.currentRound);
  const dagRuntimeState = _serializeDagRuntimeState(run);
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workflowRevision: run.workflowRevision,
    canonicalHash: run.canonicalHash,
    compilerVersion: run.compilerVersion,
    sourceApiVersion: run.sourceApiVersion,
    contracts: run.contracts,
    artifacts: run.artifacts,
    runInputTargets: run.runInputTargets,
    inputArtifacts: run.inputArtifacts ? structuredClone(run.inputArtifacts) : undefined,
    brokerState: run.brokerState ? structuredClone(run.brokerState) : undefined,
    initialPrompt: run.initialPrompt,
    nodeCount: run.nodeCount,
    agents: run.agents,
    workspace: run.workspace,
    workspaceRetention: run.workspaceRetention,
    scorecard: run.scorecard,
    pattern: run.pattern,
    createdAt: run.createdAt,
    status: run.status,
    ...(currentRound ? { currentRound } : {}),
    ...(dagRuntimeState ? { dagRuntimeState } : {}),
    completedAt: run.completedAt,
    limits: run.limits,
    counters: run.counters,
    nodeStates,
    handoffedNodes: Array.from(run.dagRun.handoffedNodes).sort(),
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
    .run(
      runId,
      nodeId,
      entry.timestamp === undefined ? null : assertEpochMs(entry.timestamp, "dag_chats.timestamp"),
      encodeJson(redactTelemetry(entry)),
    );
  emit("dag:node_chat_updated", {
    runId,
    nodeId,
    timestamp: new Date().toISOString(),
  });
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

export interface PersistedRunControlState {
  status: DagRunStatus;
  nodeStates: Record<string, string>;
}

export interface PersistedRunSummary {
  runId: string;
  workflowId?: string;
  workflowName?: string;
  nodeCount?: number;
  status: DagRunStatus;
  currentRound?: PersistedCurrentDagRunRound;
  createdAt: number;
  completedAt?: number;
}

interface PersistedRunSummaryRow {
  run_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  status: DagRunStatus;
  created_at: number;
  completed_at: number | null;
  graph: string | null;
  node_states: string | null;
  round_id: string | null;
  ordinal: number | null;
  round_status: PersistedCurrentDagRunRound["status"] | null;
  target_actor_ids_json: string | null;
  await_node_id: string | null;
  opened_at: number | null;
  closed_at: number | null;
  expires_at: number | null;
}

function _nodeCountFromExpandedColumns(row: PersistedRunSummaryRow): number | undefined {
  if (row.graph) {
    const graph = parseJsonRow<unknown>(row.graph);
    if (
      graph
      && typeof graph === "object"
      && !Array.isArray(graph)
      && Array.isArray((graph as { nodes?: unknown }).nodes)
    ) {
      return (graph as { nodes: unknown[] }).nodes.length;
    }
  }
  if (row.node_states) {
    const nodeStates = parseJsonRow<unknown>(row.node_states);
    if (nodeStates && typeof nodeStates === "object" && !Array.isArray(nodeStates)) {
      return Object.keys(nodeStates).length;
    }
  }
  return undefined;
}

function _currentRoundFromSummaryRow(
  row: PersistedRunSummaryRow,
): PersistedCurrentDagRunRound | undefined {
  if (
    row.round_id === null
    || row.ordinal === null
    || row.round_status === null
    || row.target_actor_ids_json === null
    || row.opened_at === null
  ) {
    return undefined;
  }
  const targetActorIds = parseJsonRow<unknown>(row.target_actor_ids_json);
  if (!Array.isArray(targetActorIds) || targetActorIds.some((value) => typeof value !== "string")) {
    throw new Error(`DAG run round ${row.run_id}/${row.round_id} has invalid target_actor_ids_json`);
  }
  return {
    round_id: row.round_id,
    ordinal: row.ordinal,
    status: row.round_status,
    target_actor_ids: [...targetActorIds],
    ...(row.await_node_id === null ? {} : { await_node_id: row.await_node_id }),
    opened_at: row.opened_at,
    ...(row.closed_at === null ? {} : { closed_at: row.closed_at }),
    ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
  };
}

export function listPersistedRunSummaries(): PersistedRunSummary[] {
  const rows = getDb().prepare(`
    SELECT
      run.run_id,
      run.workflow_id,
      run.workflow_name,
      run.status,
      run.created_at,
      run.completed_at,
      run.graph,
      run.node_states,
      round.round_id,
      round.ordinal,
      round.status AS round_status,
      round.target_actor_ids_json,
      round.await_node_id,
      round.opened_at,
      round.closed_at,
      round.expires_at
    FROM dag_runs run
    LEFT JOIN dag_run_rounds round
      ON round.run_id = run.run_id
      AND round.ordinal = (
        SELECT MAX(latest.ordinal)
        FROM dag_run_rounds latest
        WHERE latest.run_id = run.run_id
      )
    ORDER BY run.updated_at DESC, run.run_id
  `).all() as PersistedRunSummaryRow[];

  return rows.map((row) => {
    assertStatus("dag_run", row.status);
    const currentRound = _currentRoundFromSummaryRow(row);
    const nodeCount = _nodeCountFromExpandedColumns(row);
    return {
      runId: row.run_id,
      ...(row.workflow_id === null ? {} : { workflowId: row.workflow_id }),
      ...(row.workflow_name === null ? {} : { workflowName: row.workflow_name }),
      ...(nodeCount === undefined ? {} : { nodeCount }),
      status: row.status,
      ...(currentRound ? { currentRound } : {}),
      createdAt: row.created_at,
      ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    };
  });
}

export function loadPersistedRunControlState(runId: string): PersistedRunControlState | undefined {
  _safeRunId(runId);
  const row = getDb()
    .prepare("SELECT status, node_states FROM dag_runs WHERE run_id = ?")
    .get(runId) as { status: DagRunStatus; node_states: string | null } | undefined;
  if (!row) return undefined;
  assertStatus("dag_run", row.status);
  if (row.node_states !== null) {
    const nodeStates = parseJsonRow<unknown>(row.node_states);
    if (nodeStates && typeof nodeStates === "object" && !Array.isArray(nodeStates)) {
      return { status: row.status, nodeStates: nodeStates as Record<string, string> };
    }
  }
  const legacy = loadRunMetadata(runId);
  return legacy ? { status: legacy.status, nodeStates: legacy.nodeStates } : undefined;
}

export function getPersistedRunStatus(runId: string): DagRunStatus | undefined {
  _safeRunId(runId);
  const row = getDb()
    .prepare("SELECT status FROM dag_runs WHERE run_id = ?")
    .get(runId) as { status: DagRunStatus } | undefined;
  if (!row) return undefined;
  assertStatus("dag_run", row.status);
  return row.status;
}

export function listPersistedRunIdsByStatus(statuses: readonly DagRunStatus[]): string[] {
  if (statuses.length === 0) return [];
  for (const status of statuses) assertStatus("dag_run", status);
  const placeholders = statuses.map(() => "?").join(", ");
  return (getDb()
    .prepare(`
      SELECT run_id FROM dag_runs
      WHERE status IN (${placeholders})
      ORDER BY updated_at DESC, run_id
    `)
    .all(...statuses) as Array<{ run_id: string }>)
    .map((row) => row.run_id);
}

export function listPersistedRunIds(): string[] {
  return (getDb()
    .prepare("SELECT run_id FROM dag_runs ORDER BY updated_at DESC, run_id")
    .all() as Array<{ run_id: string }>)
    .map((row) => row.run_id);
}

export function _clearAllPersistence(): void {
  clearTables(["dag_metrics", "dag_chats", "dag_handoffs", "dag_artifacts", "dag_events", "dag_run_admissions", "dag_runs"]);
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

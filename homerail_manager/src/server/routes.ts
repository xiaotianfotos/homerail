import * as http from "node:http";
import {
  loadRunMetadata,
  loadRunSnapshot,
  listPersistedRunSummaries,
  loadNodeUsages,
} from "../persistence/store.js";
import type { PersistedEvent, PersistedRunMetadata, PersistedRunSnapshot, NodeUsageRecord } from "../persistence/types.js";
import {
  DAG_NODE_USAGE_AGGREGATION,
  dagNodeTokenTotal,
  normalizeDagNodeExecutionIdentity,
  type DagNodeExecutionIdentity,
} from "homerail-protocol";
import { DAG_EVENT_TYPES, subscribe, type DAGEventPayload } from "../events/bus.js";
import { getDiagnostics } from "../config/diagnostics.js";
import { runtimeStatusHandler } from "../runtime/status.js";
import { computeScorecard, renderScorecardJson } from "./scorecard.js";
import { buildEvalReport, renderEvalJson } from "./eval.js";
import {
  computeSuperviseTick,
  isTerminalDagRunEvent,
  isTerminalDagRunStatus,
} from "./supervise.js";
import { buildReplayReport } from "./replay.js";
import { ingestRunExperience } from "./experience.js";
import {
  getExperienceIngestJobByRunId,
  markExperienceIngestJob,
} from "../persistence/experience-ingest-jobs.js";
import { listActiveRuns } from "../runtime/active-runs.js";
import { getDagState, listPendingApprovals } from "../persistence/dag-runtime-primitives.js";
import { listDagTriggers } from "../persistence/dag-triggers.js";
import { listDagActivityEvents } from "../persistence/dag-activity-journal.js";
import { listDagActorCommands, type DagActorCommandStatus } from "../persistence/dag-actors.js";
import {
  DAG_ACTOR_LIVE_COMMAND_STATUSES,
  listDagActorLiveCommands,
  type DagActorLiveCommandStatus,
} from "../persistence/dag-actor-live-commands.js";
import {
  getDagActorIntervention,
  listDagActorInterventions,
  type DagActorInterventionRecord,
} from "../persistence/dag-actor-interventions.js";
import { listDagRunRounds } from "../persistence/dag-run-rounds.js";
import {
  getDagLiveSurfaceDocument,
  isDagLiveSurfaceProjectionNode,
  listDagLiveSurfaceGenerationHistory,
  listDagLiveSurfaceProjections,
} from "../generative-ui/dag-live-surface-projector.js";
import {
  listDagSupervisorActors,
} from "../runtime/dag-manager-supervisor.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
  remaining_gap?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _publicIntervention(intervention: DagActorInterventionRecord) {
  return {
    intervention_id: intervention.intervention_id,
    run_id: intervention.run_id,
    actor_id: intervention.actor_id,
    operation: intervention.operation,
    status: intervention.status,
    ...(intervention.instruction === undefined ? {} : { instruction: intervention.instruction }),
    created_at: intervention.created_at,
    ...(intervention.started_at === undefined ? {} : { started_at: intervention.started_at }),
    ...(intervention.completed_at === undefined ? {} : { completed_at: intervention.completed_at }),
    ...(intervention.failure === undefined ? {} : { failure: intervention.failure }),
  };
}

function _sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 10000\n\n");
}

function _parseRunId(pathname: string, prefix: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (!decoded.startsWith(prefix)) return undefined;
  return decoded.slice(prefix.length);
}

function _parseNodeId(pathname: string, prefix: string): string | undefined {
  const decoded = decodeURIComponent(pathname);
  if (!decoded.startsWith(prefix)) return undefined;
  return decoded.slice(prefix.length);
}

function _buildExecutionStatus(metadata: ReturnType<typeof loadRunMetadata>) {
  if (!metadata) return undefined;
  const nodes: Record<
    string,
    { status: string; retry_count: number; started_at: string | null; completed_at: string | null }
  > = {};
  for (const [nodeId, state] of Object.entries(metadata.nodeStates)) {
    nodes[nodeId] = {
      status: state.toLowerCase(),
      retry_count: 0,
      started_at: null,
      completed_at: _isTerminalNodeStatus(state) ? new Date(metadata.completedAt || Date.now()).toISOString() : null,
    };
  }
  const completedNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "COMPLETED" || state === "SKIPPED")
    .map(([id]) => id);
  const readyNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "READY")
    .map(([id]) => id);
  const activeNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "RUNNING")
    .map(([id]) => id);
  const waitingNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "WAITING_FOR_COMMAND")
    .map(([id]) => id);
  const failedNodes = Object.entries(metadata.nodeStates)
    .filter(([, state]) => state === "FAILED")
    .map(([id]) => id);
  return {
    status: metadata.status,
    complete: isTerminalDagRunStatus(metadata.status),
    active_nodes: activeNodes,
    completed_nodes: completedNodes,
    failed_nodes: failedNodes,
    ready_nodes: readyNodes,
    waiting_nodes: waitingNodes,
    node_count: metadata.nodeCount || Object.keys(metadata.nodeStates).length,
    nodes,
  };
}

function _nodeStatus(metadata: PersistedRunMetadata, nodeId: string): string {
  return (metadata.nodeStates[nodeId] || "PENDING").toLowerCase();
}

const TERMINAL_NODE_STATUSES = new Set(["completed", "failed", "cancelled", "skipped"]);

function _isTerminalNodeStatus(status: string): boolean {
  return TERMINAL_NODE_STATUSES.has(status.toLowerCase());
}

function _buildNodeDetail(metadata: PersistedRunMetadata, nodeId: string) {
  const node = metadata.graph?.nodes.find((n) => n.node_id === nodeId);
  if (!node && !(nodeId in metadata.nodeStates)) return undefined;
  const status = _nodeStatus(metadata, nodeId);
  return {
    node_id: nodeId,
    node_name: node?.name || nodeId,
    status,
    agent_id: node?.agent || "",
    agent_name: node?.agent || node?.name || nodeId,
    started_at: null,
    completed_at: _isTerminalNodeStatus(status) ? new Date(metadata.completedAt || Date.now()).toISOString() : null,
  };
}

/**
 * Result kinds mirror the runtime node_type so the UI can pick a default
 * human-readable renderer per kind instead of inspecting free-form payloads.
 */
function _nodeResultKind(nodeType: string): string {
  if (nodeType.endsWith("_gateway")) return nodeType.slice(0, -"_gateway".length);
  return "worker";
}

function _buildNodeResult(snapshot: PersistedRunSnapshot, nodeId: string) {
  const metadata = snapshot.metadata;
  const node = metadata.graph?.nodes.find((n) => n.node_id === nodeId);
  if (!node && !(nodeId in metadata.nodeStates)) return undefined;
  const nodeType = node?.node_type || "agent";
  const resultKind = _nodeResultKind(nodeType);
  const handoffs = snapshot.handoffs
    .filter((record) => record.fromNode === nodeId)
    .map((record) => ({
      port: record.port,
      content: record.content ?? null,
      timestamp: new Date(record.timestamp).toISOString(),
      ...(record.roundId === undefined ? {} : { round_id: record.roundId }),
    }));
  const latest = handoffs[handoffs.length - 1] ?? null;
  // Command nodes may hand off only the parsed value (result_payload: "value").
  // The redacted full envelope is always available on the telemetry event.
  // 从尾部线性扫描：不复制整个事件数组，长跑 run（上万事件）下每次请求零额外分配
  let telemetry: Record<string, unknown> | undefined;
  if (resultKind === "command") {
    for (let i = snapshot.events.length - 1; i >= 0; i -= 1) {
      const entry = snapshot.events[i];
      if (entry.type !== "dag:deterministic_command") continue;
      if ((entry.payload as Record<string, unknown>).nodeId !== nodeId) continue;
      const { runId: _runId, nodeId: _nodeId, ...rest } = entry.payload as Record<string, unknown>;
      telemetry = rest;
      break;
    }
  }
  return {
    node_id: nodeId,
    node_name: node?.name || nodeId,
    node_type: nodeType,
    result_kind: resultKind,
    status: _nodeStatus(metadata, nodeId),
    latest,
    handoffs,
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

function _normalizeEvent(event: PersistedEvent) {
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
    ...event,
    timestamp: new Date(event.timestamp).toISOString(),
    event_type: eventType,
    node_id: nodeId,
    details: payload,
  };
}

function _eventsResponse(events: PersistedEvent[]) {
  const normalized = events.map(_normalizeEvent);
  return {
    events: normalized,
    raw_events: events,
    total: events.length,
  };
}

function _sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function _payloadRunId(payload: DAGEventPayload): string | undefined {
  const p = payload as unknown as Record<string, unknown>;
  return typeof p.runId === "string" ? p.runId : undefined;
}

function _streamDagEvents(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  metadata: PersistedRunMetadata,
  snapshot: PersistedRunSnapshot,
): void {
  _sseHeaders(res);
  let closed = false;
  const cleanup: Array<() => void> = [];
  const close = () => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of cleanup.splice(0)) {
      unsubscribe();
    }
    res.end();
  };
  res.on("close", () => {
    if (closed) return;
    closed = true;
    for (const unsubscribe of cleanup.splice(0)) {
      unsubscribe();
    }
  });

  for (const eventType of DAG_EVENT_TYPES) {
    cleanup.push(subscribe(eventType, (payload) => {
      if (closed || _payloadRunId(payload) !== runId) return;
      res.write(_sseEvent(eventType, payload));
      if (isTerminalDagRunEvent(eventType)) close();
    }));
  }

  res.write(_sseEvent("dag_status_update", _buildExecutionStatus(metadata)));
  for (const event of snapshot.events) {
    res.write(_sseEvent(event.type, event.payload));
  }
  if (isTerminalDagRunStatus(metadata.status)) {
    close();
  }
}

function _messageCounts(chats: PersistedRunSnapshot["chats"], nodeId: string): Record<string, number> {
  const counts: Record<string, number> = { text: 0, thinking: 0, tool_use: 0, tool_result: 0 };
  for (const entry of chats[nodeId] || []) {
    const content = entry.content as unknown;
    const type =
      typeof content === "object" && content && "type" in content && typeof (content as { type?: unknown }).type === "string"
        ? (content as { type: string }).type
        : entry.type === "prompt"
          ? "text"
          : "text";
    if (type in counts) {
      counts[type] += 1;
    } else {
      counts.text += 1;
    }
  }
  return counts;
}

function _buildAuditSummary(snapshot: PersistedRunSnapshot) {
  const metadata = snapshot.metadata;
  const nodeIds = metadata.graph?.nodes.map((node) => node.node_id) ?? Object.keys(metadata.nodeStates);
  const agents = nodeIds.map((nodeId) => {
    const graphNode = metadata.graph?.nodes.find((node) => node.node_id === nodeId);
    const message_counts = _messageCounts(snapshot.chats, nodeId);
    return {
      agent_id: nodeId,
      agent_name: graphNode?.name || nodeId,
      duration_ms: null,
      token_usage: null,
      usage_available: false,
      usage_source: null,
      cost_usd: null,
      message_counts,
      thinking_chars: 0,
      is_error: metadata.nodeStates[nodeId] === "FAILED",
    };
  });
  return {
    run_id: metadata.runId,
    is_dag_mode: true,
    total_cost_usd: null,
    usage_available: false,
    usage_note: "Worker token usage is not persisted for this run",
    total_agents: agents.length,
    agents,
  };
}

interface NodeMetrics {
  node_id: string;
  node_name: string;
  agent_name: string;
  status: string;
  tool_calls: number;
  tool_failures: number;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    total: number;
  } | null;
  execution: DagNodeExecutionIdentity | null;
  usage_scope: typeof DAG_NODE_USAGE_AGGREGATION;
  usage_available: boolean;
  duration_ms: number | null;
  num_turns: number | null;
  started_at: string | null;
  completed_at: string | null;
}

function _usageScopeKey(record: NodeUsageRecord): string {
  const scope = record.scope;
  if (!scope || Object.keys(scope).length === 0) return "legacy";
  return JSON.stringify([
    scope.session_id ?? "",
    scope.round_id ?? "",
    scope.generation ?? null,
    scope.command_id ?? "",
    scope.execution_id ?? "",
  ]);
}

function _nonNegativeToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function _nodeExecutionIdentity(
  chats: PersistedRunSnapshot["chats"],
  nodeId: string,
): DagNodeExecutionIdentity | null {
  const entries = chats[nodeId] ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== "manager" || entry.type !== "prompt") continue;
    const content = entry.content && typeof entry.content === "object" && !Array.isArray(entry.content)
      ? entry.content as Record<string, unknown>
      : undefined;
    const agentConfig = content?.agentConfig
      && typeof content.agentConfig === "object"
      && !Array.isArray(content.agentConfig)
      ? content.agentConfig as Record<string, unknown>
      : undefined;
    if (!agentConfig) continue;
    const llm = agentConfig.llm
      && typeof agentConfig.llm === "object"
      && !Array.isArray(agentConfig.llm)
      ? agentConfig.llm as Record<string, unknown>
      : {};
    return normalizeDagNodeExecutionIdentity({
      provider_id: llm.provider,
      provider_display_name: llm.provider_display_name,
      model_name: llm.model ?? agentConfig.model,
      model_display_name: llm.model_display_name,
      agent_backend: agentConfig.agent_type,
      protocol: llm.protocol,
      context_limit: llm.context_limit,
      context_usage_pct: llm.context_usage_pct,
    }) ?? null;
  }
  return null;
}

/** Aggregate per-node tool-call counts and token usage for the runtime
 * overlay. Tool calls are counted from persisted chat entries (each
 * tool_use / tool_result stream event is one entry); tool failures are
 * tool_result entries flagged is_error. Token usage comes from persisted
 * Worker snapshots: the last snapshot in each turn scope wins and scopes are
 * summed into an authoritative cumulative node total. */
function _buildMetricsSummary(snapshot: PersistedRunSnapshot) {
  const metadata = snapshot.metadata;
  const nodeIds = metadata.graph?.nodes.map((node) => node.node_id) ?? Object.keys(metadata.nodeStates);

  const usageByNodeAndScope = new Map<string, Map<string, NodeUsageRecord>>();
  for (const record of snapshot.usages ?? loadNodeUsages(metadata.runId)) {
    const scopes = usageByNodeAndScope.get(record.nodeId) ?? new Map<string, NodeUsageRecord>();
    scopes.set(_usageScopeKey(record), record);
    usageByNodeAndScope.set(record.nodeId, scopes);
  }

  const nodes: Record<string, NodeMetrics> = {};
  const totals = {
    tool_calls: 0,
    tool_failures: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    usage_available: false,
  };

  for (const nodeId of nodeIds) {
    const graphNode = metadata.graph?.nodes.find((node) => node.node_id === nodeId);
    let toolCalls = 0;
    let toolFailures = 0;
    for (const entry of snapshot.chats[nodeId] ?? []) {
      const content = entry.content as { type?: string; is_error?: boolean } | null;
      if (!content || typeof content !== "object") continue;
      if (content.type === "tool_use") toolCalls += 1;
      if (content.type === "tool_result") {
        if (content.is_error === true) toolFailures += 1;
      }
    }

    const usageScopes = Array.from(usageByNodeAndScope.get(nodeId)?.values() ?? []);
    const usage = usageScopes.length > 0
      ? usageScopes.reduce((summary, record) => {
          summary.input += _nonNegativeToken(record.usage.input_tokens);
          summary.output += _nonNegativeToken(record.usage.output_tokens);
          summary.cache_read += _nonNegativeToken(record.usage.cache_read_input_tokens);
          summary.cache_creation += _nonNegativeToken(record.usage.cache_creation_input_tokens);
          if (typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms) && record.duration_ms >= 0) {
            summary.duration_ms += record.duration_ms;
            summary.has_duration = true;
          }
          if (typeof record.num_turns === "number" && Number.isFinite(record.num_turns) && record.num_turns >= 0) {
            summary.num_turns += record.num_turns;
            summary.has_num_turns = true;
          }
          return summary;
        }, {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_creation: 0,
          duration_ms: 0,
          num_turns: 0,
          has_duration: false,
          has_num_turns: false,
        })
      : undefined;
    const status = (metadata.nodeStates[nodeId] || "PENDING").toLowerCase();
    const tokens = usage
      ? {
          input: usage.input,
          output: usage.output,
          cache_read: usage.cache_read,
          cache_creation: usage.cache_creation,
          total: dagNodeTokenTotal({
            input_tokens: usage.input,
            output_tokens: usage.output,
            cache_read_input_tokens: usage.cache_read,
            cache_creation_input_tokens: usage.cache_creation,
          }),
        }
      : null;

    nodes[nodeId] = {
      node_id: nodeId,
      node_name: graphNode?.name || nodeId,
      agent_name: graphNode?.agent || graphNode?.name || nodeId,
      status,
      tool_calls: toolCalls,
      tool_failures: toolFailures,
      tokens,
      execution: _nodeExecutionIdentity(snapshot.chats, nodeId),
      usage_scope: DAG_NODE_USAGE_AGGREGATION,
      usage_available: usage !== undefined,
      duration_ms: usage?.has_duration ? usage.duration_ms : null,
      num_turns: usage?.has_num_turns ? usage.num_turns : null,
      started_at: null,
      completed_at: _isTerminalNodeStatus(status)
        ? (metadata.completedAt ? new Date(metadata.completedAt).toISOString() : null)
        : null,
    };

    totals.tool_calls += toolCalls;
    totals.tool_failures += toolFailures;
    if (tokens) {
      totals.tokens.input += tokens.input;
      totals.tokens.output += tokens.output;
      totals.tokens.cache_read += tokens.cache_read;
      totals.tokens.cache_creation += tokens.cache_creation;
      totals.tokens.total += tokens.total;
      totals.usage_available = true;
    }
  }

  return {
    run_id: metadata.runId,
    status: metadata.status,
    nodes,
    totals: {
      ...totals,
      cost_usd: null,
    },
  };
}

export function inspectionRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  // GET /api/runs
  if (pathname === "/api/runs" && req.method === "GET") {
    const runs = listPersistedRunSummaries();
    _ok(res, `Found ${runs.length} runs`, { runs, total: runs.length });
    return true;
  }

  if (pathname === "/api/dag/approvals" && req.method === "GET") {
    const approvals = listPendingApprovals();
    _ok(res, `Found ${approvals.length} pending approval(s)`, { approvals, total: approvals.length });
    return true;
  }

  if (pathname === "/api/dag/triggers" && req.method === "GET") {
    const triggers = listDagTriggers();
    _ok(res, `Found ${triggers.length} DAG trigger(s)`, { triggers, total: triggers.length });
    return true;
  }

  const stateMatch = pathname.match(/^\/api\/dag\/state\/([^/]+)\/([^/]+)$/);
  if (stateMatch && req.method === "GET") {
    const namespace = decodeURIComponent(stateMatch[1]);
    const key = decodeURIComponent(stateMatch[2]);
    const record = getDagState(namespace, key);
    if (!record) _notFound(res, `DAG state not found: ${namespace}/${key}`);
    else _ok(res, "DAG state retrieved", { record });
    return true;
  }

  // GET /api/runs/active/list
  if (pathname === "/api/runs/active/list" && req.method === "GET") {
    const runs = listActiveRuns()
      .filter((run) => run.status === "active" || run.status === "waiting")
      .map((run) => ({
        runId: run.runId,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        nodeCount: run.nodeCount,
        status: run.status,
        currentRound: run.currentRound,
        createdAt: run.createdAt,
      }));
    _ok(res, "Active runs retrieved", { runs, total: runs.length });
    return true;
  }

  // GET /api/runs/active/dashboard
  if (pathname === "/api/runs/active/dashboard" && req.method === "GET") {
    const runs = listActiveRuns()
      .filter((run) => run.status === "active" || run.status === "waiting")
      .map((run) => ({
        runId: run.runId,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        nodeCount: run.nodeCount,
        status: run.status,
        currentRound: run.currentRound,
        createdAt: run.createdAt,
      }));
    _ok(res, "Active dashboard runs retrieved", { runs, total: runs.length });
    return true;
  }

  // GET /api/settings/workspace — workspace settings backed by TS Manager state
  if (pathname === "/api/settings/workspace" && req.method === "GET") {
    const runtime = runtimeStatusHandler();
    const activeRunsList = listActiveRuns();
    _ok(res, "Workspace settings retrieved", {
      workspace_path: process.cwd(),
      homerail_home: process.env.HOMERAIL_HOME || null,
      active_runs: runtime.active_runs,
      active_run_ids: activeRunsList.filter((r) => r.status === "active").map((r) => r.runId),
      waiting_run_ids: activeRunsList.filter((r) => r.status === "waiting").map((r) => r.runId),
      connected_nodes: runtime.connected_nodes,
      connected_workers: runtime.connected_workers,
      directory_import: {
        supported: false,
        status: "unsupported",
        reason: "Workspace directory import is not implemented in TS Manager",
      },
    });
    return true;
  }

  // GET /api/settings/nodes — nodes settings backed by TS Manager runtime state
  if (pathname === "/api/settings/nodes" && req.method === "GET") {
    const runtime = runtimeStatusHandler();
    const nodesCount = runtime.connected_nodes;
    const workersCount = runtime.connected_workers;
    let runtime_status: "healthy" | "degraded" | "unavailable";
    if (nodesCount > 0 && workersCount > 0) {
      runtime_status = "healthy";
    } else if (nodesCount > 0) {
      runtime_status = "degraded";
    } else {
      runtime_status = "unavailable";
    }
    _ok(res, "Nodes settings retrieved", {
      connected_nodes: runtime.connected_nodes,
      connected_workers: runtime.connected_workers,
      active_runs: runtime.active_runs,
      node_ids: runtime.node_ids,
      node_capabilities: runtime.node_capabilities,
      worker_ids: runtime.worker_ids,
      worker_capabilities: runtime.worker_capabilities,
      runtime_status,
    });
    return true;
  }

  // GET /api/runtime/status
  if (pathname === "/api/runtime/status" && req.method === "GET") {
    _ok(res, "Runtime status retrieved", runtimeStatusHandler());
    return true;
  }

  // GET /api/config/diagnostics
  if (pathname === "/api/config/diagnostics" && req.method === "GET") {
    _ok(res, "Runtime diagnostics retrieved", getDiagnostics(0));
    return true;
  }

  // GET /api/runs/:run_id/status
  if (pathname.match(/^\/api\/runs\/[^/]+\/status$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    if (!metadata) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    _ok(res, "Run status retrieved", {
      run_id: metadata.runId,
      runId: metadata.runId,
      status: metadata.status,
      terminal: isTerminalDagRunStatus(metadata.status),
      current_phase: metadata.status,
      current_round: metadata.currentRound,
      created_at: new Date(metadata.createdAt).toISOString(),
      completed_at: metadata.completedAt ? new Date(metadata.completedAt).toISOString() : null,
      node_states: metadata.nodeStates,
      counters: metadata.counters,
    });
    return true;
  }

  // GET /api/runs/:run_id/replay
  if (pathname.match(/^\/api\/runs\/[^/]+\/replay$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) { _notFound(res, "Invalid run ID"); return true; }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) { _notFound(res, `Run not found: ${runId}`); return true; }
    const report = buildReplayReport(snapshot);
    _ok(res, `Replay report generated (verdict: ${report.verdict})`, report);
    return true;
  }

  // GET /api/runs/:run_id/activities?actor_id=&after_seq=&limit=
  if (pathname.match(/^\/api\/runs\/[^/]+\/activities$/) && req.method === "GET") {
    let runId = "";
    try {
      runId = decodeURIComponent(pathname.split("/")[3] ?? "");
    } catch {
      json(res, 400, { success: false, message: "Invalid encoded run ID", error: "Invalid encoded run ID" });
      return true;
    }
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const parseInteger = (name: "after_seq" | "limit"): number | undefined => {
      const raw = url.searchParams.get(name);
      if (raw === null) return undefined;
      if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
      return value;
    };
    try {
      const page = listDagActivityEvents({
        run_id: runId,
        actor_id: url.searchParams.get("actor_id") ?? undefined,
        after_seq: parseInteger("after_seq"),
        limit: parseInteger("limit"),
      });
      _ok(res, `Activity history retrieved (${page.events.length} events)`, page);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 400, { success: false, message, error: message });
    }
    return true;
  }

  const actorsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/actors$/);
  if (actorsMatch && req.method === "GET") {
    try {
      const runId = decodeURIComponent(actorsMatch[1]);
      _ok(res, "Logical DAG actors retrieved", listDagSupervisorActors(runId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) _notFound(res, message);
      else json(res, 400, { success: false, message, error: message });
    }
    return true;
  }

  const roundsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/rounds$/);
  if (roundsMatch && req.method === "GET") {
    const runId = decodeURIComponent(roundsMatch[1]);
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const rounds = listDagRunRounds(runId);
    _ok(res, `Found ${rounds.length} round(s)`, { rounds, total: rounds.length });
    return true;
  }

  const commandsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/commands$/);
  if (commandsMatch && req.method === "GET") {
    const runId = decodeURIComponent(commandsMatch[1]);
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const status = url.searchParams.get("status") || undefined;
    try {
      const plane = url.searchParams.get("plane") || "all";
      if (plane !== "all" && plane !== "round_resume" && plane !== "live") {
        throw new Error("plane must be all, round_resume, or live");
      }
      const actorId = url.searchParams.get("actor_id") || undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const roundStatuses = new Set<DagActorCommandStatus>([
        "pending", "delivered", "claimed", "acknowledged", "failed", "cancelled",
      ]);
      const liveStatuses = new Set<string>(DAG_ACTOR_LIVE_COMMAND_STATUSES);
      const roundCommands = plane === "live" || (status && !roundStatuses.has(status as DagActorCommandStatus))
        ? []
        : listDagActorCommands({
            run_id: runId,
            actor_id: actorId,
            round_id: url.searchParams.get("round_id") || undefined,
            status: status as DagActorCommandStatus | undefined,
            limit,
          });
      const liveCommands = plane === "round_resume" || (status && !liveStatuses.has(status))
        ? []
        : listDagActorLiveCommands({
            run_id: runId,
            actor_id: actorId,
            status: status as DagActorLiveCommandStatus | undefined,
            limit,
          });
      if (status && roundCommands.length === 0 && liveCommands.length === 0
        && !roundStatuses.has(status as DagActorCommandStatus) && !liveStatuses.has(status)) {
        throw new Error(`Invalid command status: ${status}`);
      }
      _ok(res, `Found ${roundCommands.length + liveCommands.length} command(s)`, {
        commands: roundCommands,
        round_commands: roundCommands,
        live_commands: liveCommands,
        totals: { round_resume: roundCommands.length, live: liveCommands.length },
        total: roundCommands.length + liveCommands.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 400, { success: false, message, error: message });
    }
    return true;
  }

  const actorInterventionDetailMatch = pathname.match(
    /^\/api\/runs\/([^/]+)\/actors\/([^/]+)\/interventions\/([^/]+)$/,
  );
  if (actorInterventionDetailMatch && req.method === "GET") {
    const runId = decodeURIComponent(actorInterventionDetailMatch[1]);
    const actorId = decodeURIComponent(actorInterventionDetailMatch[2]);
    const interventionId = decodeURIComponent(actorInterventionDetailMatch[3]);
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const intervention = getDagActorIntervention(interventionId);
    if (!intervention || intervention.run_id !== runId || intervention.actor_id !== actorId) {
      _notFound(res, `DAG Actor intervention not found: ${interventionId}`);
      return true;
    }
    _ok(res, "DAG Actor intervention retrieved", _publicIntervention(intervention));
    return true;
  }

  const actorInterventionsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/actors\/([^/]+)\/interventions$/);
  if (actorInterventionsMatch && req.method === "GET") {
    const runId = decodeURIComponent(actorInterventionsMatch[1]);
    const actorId = decodeURIComponent(actorInterventionsMatch[2]);
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const interventions = listDagActorInterventions({
        run_id: runId,
        actor_id: actorId,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      }).map(_publicIntervention);
      _ok(res, `Found ${interventions.length} intervention(s)`, {
        run_id: runId,
        actor_id: actorId,
        interventions,
        total: interventions.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 400, { success: false, message, error: message });
    }
    return true;
  }

  const actorSurfaceHistoryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/actors\/([^/]+)\/surface-history$/);
  if (actorSurfaceHistoryMatch && req.method === "GET") {
    const runId = decodeURIComponent(actorSurfaceHistoryMatch[1]);
    const actorId = decodeURIComponent(actorSurfaceHistoryMatch[2]);
    if (!loadRunMetadata(runId)) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const history = listDagLiveSurfaceGenerationHistory({
        run_id: runId,
        actor_id: actorId,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
      });
      _ok(res, `Found ${history.length} superseded surface generation(s)`, {
        run_id: runId,
        actor_id: actorId,
        generation_state: "superseded",
        history,
        total: history.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 400, { success: false, message, error: message });
    }
    return true;
  }

  // GET /api/runs/:run_id/live-surfaces
  if (pathname.match(/^\/api\/runs\/[^/]+\/live-surfaces$/) && req.method === "GET") {
    let runId = "";
    try {
      runId = decodeURIComponent(pathname.split("/")[3] ?? "");
    } catch {
      json(res, 400, { success: false, message: "Invalid encoded run ID", error: "Invalid encoded run ID" });
      return true;
    }
    const metadata = runId ? loadRunMetadata(runId) : null;
    if (!runId || !metadata) {
      _notFound(res, runId ? `Run not found: ${runId}` : "Invalid run ID");
      return true;
    }
    const runStatus = typeof metadata.status === "string" ? metadata.status : "";
    // Once a run reaches a terminal state other than `completed`, its live
    // surface is no longer the active canvas owner. Return an empty surface so
    // the frontend's `available` flag flips false and the canonical view can
    // mount after a committed block. `completed` keeps the surface so the last
    // DAG result stays visible.
    if (isTerminalDagRunStatus(runStatus) && runStatus !== "completed") {
      _ok(res, `Live surfaces released (run ${runStatus})`, {
        run_id: runId,
        run_status: runStatus,
        projections: [],
        surface_states: [],
        document: null,
      });
      return true;
    }
    const projections = listDagLiveSurfaceProjections(runId);
    const projectionBySurface = new Map(projections.map((projection) => [projection.surface_id, projection]));
    const document = getDagLiveSurfaceDocument(runId);
    const surfaceStates = projections.map((projection) => {
      const latestIntervention = listDagActorInterventions({
        run_id: runId,
        actor_id: projection.actor_id,
        limit: 1,
      })[0];
      const supersededCount = listDagLiveSurfaceGenerationHistory({
        run_id: runId,
        actor_id: projection.actor_id,
        limit: 100,
      }).length;
      return {
        actor_id: projection.actor_id,
        surface_id: projection.surface_id,
        generation_state: "current" as const,
        superseded_count: supersededCount,
        ...(latestIntervention ? { latest_intervention: _publicIntervention(latestIntervention) } : {}),
      };
    });
    _ok(res, `Live surfaces retrieved (${projections.length} actors)`, {
      run_id: runId,
      run_status: runStatus || null,
      projections,
      surface_states: surfaceStates,
      document: document
        ? {
            ...document,
            nodes: document.nodes.filter((node) => {
              const projection = projectionBySurface.get(node.id);
              return projection !== undefined && isDagLiveSurfaceProjectionNode(node, projection);
            }),
          }
        : null,
    });
    return true;
  }

  // GET /api/runs/:run_id
  if (pathname.startsWith("/api/runs/") && !pathname.includes("/activities") && !pathname.includes("/events") && !pathname.includes("/handoffs") && !pathname.includes("/chats") && !pathname.includes("/scorecard") && !pathname.includes("/eval-run") && !pathname.includes("/supervise") && !pathname.includes("/inject") && !pathname.includes("/experience") && !pathname.includes("/status") && !pathname.includes("/audit") && !pathname.includes("/rounds") && !pathname.includes("/commands") && !pathname.includes("/complete") && !pathname.includes("/live-surfaces") && req.method === "GET") {
    const runId = _parseRunId(pathname, "/api/runs/");
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    if (!metadata) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    _ok(res, "Run metadata retrieved", {
      runId: metadata.runId,
      workflowId: metadata.workflowId,
      workflowName: metadata.workflowName,
      nodeCount: metadata.nodeCount,
      agents: metadata.agents,
      createdAt: metadata.createdAt,
      status: metadata.status,
      currentRound: metadata.currentRound,
      completedAt: metadata.completedAt,
      nodeStates: metadata.nodeStates,
      handoffedNodes: metadata.handoffedNodes,
    });
    return true;
  }

  // GET /api/runs/:run_id/events
  if (pathname.match(/^\/api\/runs\/[^/]+\/events$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    _ok(res, `Event history retrieved (${snapshot.events.length} events)`, _eventsResponse(snapshot.events));
    return true;
  }

  // GET /api/runs/:run_id/audit/summary
  if (pathname.match(/^\/api\/runs\/[^/]+\/audit\/summary$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const summary = _buildAuditSummary(snapshot);
    _ok(res, `Run audit summary: ${summary.total_agents} agents`, summary);
    return true;
  }

  // GET /api/runs/:run_id/handoffs
  if (pathname.match(/^\/api\/runs\/[^/]+\/handoffs$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    _ok(res, `Handoff records retrieved (${snapshot.handoffs.length} handoffs)`, {
      handoffs: snapshot.handoffs,
      total: snapshot.handoffs.length,
    });
    return true;
  }

  // GET /api/runs/:run_id/chats
  if (pathname.match(/^\/api\/runs\/[^/]+\/chats$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const nodes = Object.keys(snapshot.chats).map((nodeId) => ({
      nodeId,
      messageCount: snapshot.chats[nodeId].length,
    }));
    _ok(res, `Chat nodes retrieved (${nodes.length} nodes)`, { nodes, total: nodes.length });
    return true;
  }

  // GET /api/runs/:run_id/chats/:node_id
  if (pathname.match(/^\/api\/runs\/[^/]+\/chats\/[^/]+$/) && req.method === "GET") {
    const parts = pathname.split("/");
    const runId = parts[3];
    const nodeId = decodeURIComponent(parts[5]);
    if (!runId || !nodeId) {
      _notFound(res, "Invalid run or node ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const entries = snapshot.chats[nodeId] || [];
    _ok(res, `Chat transcript retrieved (${entries.length} entries)`, {
      runId,
      nodeId,
      entries,
      total: entries.length,
    });
    return true;
  }

  // GET /api/dag-status/:run_id
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/experience-ingest$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const job = getExperienceIngestJobByRunId(runId);
    if (job) {
      _ok(res, "Experience ingest status retrieved", {
        run_id: runId,
        status: job.status,
        runtime: "typescript",
        job,
      });
      return true;
    }
    _ok(res, "Experience ingest status retrieved", {
      run_id: runId,
      status: "not_started",
      runtime: "typescript",
    });
    return true;
  }

  // GET /api/dag-status/:run_id/metrics
  // Per-node tool-call counts, tool failures, and token usage for the
  // DAG runtime overlay. Aggregated from persisted chat entries and the
  // SQLite usage records emitted by workers.
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/metrics$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const metrics = _buildMetricsSummary(snapshot);
    _ok(res, "Run metrics retrieved", metrics);
    return true;
  }

  // POST /api/dag-status/:run_id/experience-ingest/retry
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/experience-ingest\/retry$/) && req.method === "POST") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }

    const existing = getExperienceIngestJobByRunId(runId);
    const startedAt = new Date().toISOString();
    markExperienceIngestJob(runId, "running", {
      trigger_event: "manual_retry",
      terminal_status: snapshot.metadata.status,
      mode: "hybrid",
      attempts: (existing?.attempts ?? 0) + 1,
      exit_code: null,
      error_message: null,
      output: null,
      started_at: startedAt,
      completed_at: null,
    });

    try {
      const summary = ingestRunExperience(runId);
      const completedAt = new Date().toISOString();
      const job = markExperienceIngestJob(runId, "completed", {
        terminal_status: snapshot.metadata.status,
        exit_code: 0,
        error_message: null,
        output: JSON.stringify(summary),
        completed_at: completedAt,
      });
      _ok(res, "Experience ingest retry completed", {
        run_id: runId,
        status: job.status,
        runtime: "typescript",
        job,
        summary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const job = markExperienceIngestJob(runId, "failed", {
        terminal_status: snapshot.metadata.status,
        exit_code: 1,
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      json(res, 500, {
        success: false,
        message: "Experience ingest retry failed",
        error: message,
        data: {
          run_id: runId,
          status: job.status,
          runtime: "typescript",
          job,
        },
      });
    }
    return true;
  }

  // GET /api/dag-status/:run_id
  if (
    pathname.startsWith("/api/dag-status/") &&
    !pathname.includes("/events") &&
    !pathname.includes("/node/") &&
    !pathname.includes("/manager/") &&
    req.method === "GET"
  ) {
    const runId = _parseRunId(pathname, "/api/dag-status/");
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    if (!metadata) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const execution = _buildExecutionStatus(metadata);
    _ok(res, "DAG status retrieved", {
      instance_id: runId,
      graph: metadata.graph || { nodes: [], edges: [] },
      execution,
    });
    return true;
  }

  // GET /api/dag-status/:run_id/events/history
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/events\/history$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    _ok(res, `Event history retrieved (${snapshot.events.length} events)`, _eventsResponse(snapshot.events));
    return true;
  }

  // GET /api/dag-status/:run_id/events
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/events$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    const snapshot = loadRunSnapshot(runId);
    if (!metadata || !snapshot) {
      _sseHeaders(res);
      res.write(_sseEvent("error", {
        success: false,
        message: `Run not found: ${runId}`,
        run_id: runId,
      }));
      res.end();
      return true;
    }
    _streamDagEvents(req, res, runId, metadata, snapshot);
    return true;
  }

  // GET /api/dag-status/:run_id/node/:node_id
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/node\/[^/]+$/) && req.method === "GET") {
    const parts = pathname.split("/");
    const runId = parts[3];
    const nodeId = decodeURIComponent(parts[5]);
    if (!runId || !nodeId) {
      _notFound(res, "Invalid run or node ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    if (!metadata) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const detail = _buildNodeDetail(metadata, nodeId);
    if (!detail) {
      _notFound(res, `Node not found: ${nodeId}`);
      return true;
    }
    _ok(res, "Node detail retrieved", detail);
    return true;
  }

  // GET /api/dag-status/:run_id/node/:node_id/chat
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/node\/[^/]+\/chat$/) && req.method === "GET") {
    const parts = pathname.split("/");
    const runId = parts[3];
    const nodeId = decodeURIComponent(parts[5]);
    if (!runId || !nodeId) {
      _notFound(res, "Invalid run or node ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const messages = snapshot.chats[nodeId] || [];
    _ok(res, `Chat history retrieved (${messages.length} messages)`, {
      instance_id: runId,
      node_id: nodeId,
      messages,
      total: messages.length,
    });
    return true;
  }

  // GET /api/dag-status/:run_id/node/:node_id/result
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/node\/[^/]+\/result$/) && req.method === "GET") {
    const parts = pathname.split("/");
    let runId: string;
    let nodeId: string;
    try {
      // 路径正则只按 / 分段，畸形 percent-encoding（如 %ZZ）会让 decodeURIComponent
      // 抛 URIError；统一按 404 处理而不是冒泡成 500
      runId = decodeURIComponent(parts[3]);
      nodeId = decodeURIComponent(parts[5]);
    } catch {
      _notFound(res, "Invalid run or node ID");
      return true;
    }
    if (!runId || !nodeId) {
      _notFound(res, "Invalid run or node ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const result = _buildNodeResult(snapshot, nodeId);
    if (!result) {
      _notFound(res, `Node not found: ${nodeId}`);
      return true;
    }
    _ok(res, `Node result retrieved (${result.handoffs.length} handoffs)`, result);
    return true;
  }

  // GET /api/dag-status/:run_id/manager/chat
  if (pathname.match(/^\/api\/dag-status\/[^/]+\/manager\/chat$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const messages = Object.values(snapshot.chats)
      .flat()
      .filter((entry) => entry.role === "manager");
    _ok(res, `Manager chat retrieved (${messages.length} messages)`, {
      instance_id: runId,
      messages,
      total: messages.length,
    });
    return true;
  }

  // GET /api/runs/:run_id/scorecard
  if (pathname.match(/^\/api\/runs\/[^/]+\/scorecard$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const result = computeScorecard(snapshot);
    _ok(res, `Scorecard computed (${result.score}/${result.total})`, JSON.parse(renderScorecardJson(result)));
    return true;
  }

  // GET /api/runs/:run_id/eval-run
  if (pathname.match(/^\/api\/runs\/[^/]+\/eval-run$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const scorecard = computeScorecard(snapshot);
    const report = buildEvalReport(snapshot, scorecard);
    _ok(res, `Eval report generated (verdict: ${report.verdict})`, JSON.parse(renderEvalJson(report)));
    return true;
  }

  // GET /api/runs/:run_id/supervise
  if (pathname.match(/^\/api\/runs\/[^/]+\/supervise$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const metadata = loadRunMetadata(runId);
    const snapshot = loadRunSnapshot(runId);
    if (!metadata || !snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const cursor = Number(url.searchParams.get("cursor") || "0");
    const tick = computeSuperviseTick(runId, metadata, snapshot.events, cursor);
    _ok(res, `Supervise tick (changed=${tick.changed}, terminal=${tick.terminal})`, tick);
    return true;
  }

  // GET /api/runs/:run_id/experience
  if (pathname.match(/^\/api\/runs\/[^/]+\/experience$/) && req.method === "GET") {
    const runId = pathname.split("/")[3];
    if (!runId) {
      _notFound(res, "Invalid run ID");
      return true;
    }
    const snapshot = loadRunSnapshot(runId);
    if (!snapshot) {
      _notFound(res, `Run not found: ${runId}`);
      return true;
    }
    try {
      const summary = ingestRunExperience(runId);
      _ok(res, "Experience ingested", {
        run_id: runId,
        delta_summary: summary.delta_summary,
        graph_path: summary.graph_path,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { success: false, message: `Experience ingestion failed: ${message}`, error: message });
    }
    return true;
  }

  return false;
}

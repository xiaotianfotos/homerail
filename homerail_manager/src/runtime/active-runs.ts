import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { emit } from "../events/bus.js";
import type { DAGDispatcher, DispatchEnvelope } from "../orchestration/dag-dispatcher.js";
import type { DAGRun, NodeState } from "../orchestration/dag-engine.js";
import {
  createDAGRun,
  edgeMatchesHandoff,
  failNode,
  reconcileFailedDependencies,
  getNodeState,
  getReadyNodes,
  handoff,
  isFailurePort,
  isRunTerminal,
  resetSkippedSuccessDescendants,
  startNode,
} from "../orchestration/dag-engine.js";
import type { DAGAgentConfig, DAGEdge, DAGGatewayConfig, DAGGraphNode, DAGOutputRoute, DAGPatternInstanceMeta, ParsedDAG, ScorecardPolicyConfig } from "../orchestration/graph.js";
import { _normalizeOutputsToEdges } from "../orchestration/yaml-loader.js";
import { assertGraphValid } from "../orchestration/graph-validator.js";
import { findDispatchTarget } from "../orchestration/dispatch-tracker.js";
import { deprovisionProvisionedForRun } from "../orchestration/provisioned-cleanup.js";
import { getWorker } from "../worker/registry.js";
import { getNode } from "../node/registry.js";
import {
  isDisabledDirectLlmAgentType,
  normalizeManagerAgentRuntimeAgentType,
  redactTelemetry,
  type DagAdvisorConfig,
  type DagWorkspaceAccess,
} from "homerail-protocol";
import { resolveAgentRuntimeConfig } from "./agent-runtime-resolver.js";
import {
  writeRunMetadata,
  appendHandoff,
  serializeRunMetadata,
  loadRunMetadata,
  loadRunSnapshot,
  listPersistedRunIds,
} from "../persistence/store.js";
import type {
  PersistedGraphData,
  PersistedRunMetadata,
} from "../persistence/types.js";
import {
  getDagSessionIndex,
  upsertDagSessionIndex,
  listDagSessionIndex,
  type DagSessionIndexEntry,
} from "../persistence/dag-session-index.js";
import { checkpointForkSession } from "../persistence/dag-session-files.js";
import WebSocket from "ws";
import { validateJsonContract } from "../orchestration/json-contract.js";
import {
  createPendingApproval,
  decideApproval,
  expirePendingApprovals,
  getApproval,
  getDagState,
  mutateDagState,
  reserveDagBudget,
  updateDagState,
  type DagApprovalRecord,
} from "../persistence/dag-runtime-primitives.js";
import type { RunWorkspaceRetention } from "../persistence/types.js";

export interface InjectResult {
  runId: string;
  nodeId: string;
  instruction: string;
  mode: string;
  timestamp: number;
  delivered: boolean;
  deliveryTargetType?: "worker" | "node";
  deliveryTargetId?: string;
  deliveryGap?: string;
}

export interface ActiveRun {
  runId: string;
  workflowId?: string;
  workflowName?: string;
  workflowRevision?: number;
  canonicalHash?: string;
  compilerVersion?: string;
  sourceApiVersion?: string;
  contracts?: Record<string, unknown>;
  runInputTargets?: Array<{ node: string; port: string; contract?: string }>;
  initialPrompt?: string;
  nodeCount?: number;
  agents?: Record<string, DAGAgentConfig>;
  workspace?: Record<string, unknown>;
  workspaceRetention?: RunWorkspaceRetention;
  scorecard?: ScorecardPolicyConfig;
  pattern?: DAGPatternInstanceMeta;
  dagRun: DAGRun;
  createdAt: number;
  status: "active" | "completed" | "failed" | "cancelled";
  completedAt?: number;
  limits: DAGRunLimits;
  counters: DAGRunCounters;
  nodeIndex: Map<string, number>;
  nodeSessions: Map<string, NodeSessionState>;
}

export interface NodeSessionState {
  sessionId: string;
  attempt: number;
  parentSessionId?: string;
  forkedFromEntryUuid?: string;
  resumeInstruction?: string;
  status: string;
}

export interface CheckpointResumeRequest {
  entryUuid?: string;
  last?: number;
  instruction: string;
  sessionId?: string;
}

export type CheckpointResumeResult =
  | {
      status: "scheduled";
      runId: string;
      nodeId: string;
      sessionId: string;
      parentSessionId?: string;
      attempt: number;
      entryUuid?: string;
      keptEntries: number;
      totalEntries: number;
      instruction: string;
    }
  | { status: "unavailable"; reason: string };

export interface DAGRunLimits {
  max_nodes: number;
  max_dispatches: number;
  max_handoffs: number;
  max_corrections_per_node: number;
  max_edge_traversals: number;
  max_tool_calls_per_node: number;
}

export interface DAGRunCounters {
  dispatches: number;
  handoffs: number;
  edge_traversals: Record<string, number>;
  corrections: Record<string, number>;
  advisor_calls: Record<string, Record<string, number>>;
  dispatch_retries: Record<string, number>;
  gateway_iterations: Record<string, number>;
  gateway_results: Record<string, unknown[]>;
  abort_reason?: string;
}

export interface AppendRunNodeRequest {
  node: DAGGraphNode;
  agentConfig?: DAGAgentConfig;
}

export interface AppendRunNodeResult {
  runId: string;
  nodeId: string;
  ready: boolean;
  dispatched: boolean;
  nodeCount: number;
}

export interface CreateActiveRunOptions {
  initialPrompt?: string;
}

const store = new Map<string, ActiveRun>();

const DEFAULT_LIMITS: DAGRunLimits = {
  max_nodes: 1000,
  max_dispatches: 30,
  max_handoffs: 50,
  max_corrections_per_node: 2,
  max_edge_traversals: 3,
  max_tool_calls_per_node: 0,
};
const MAX_DISPATCH_RETRIES_PER_NODE = 1;
const RECOVERABLE_NODE_STATES: ReadonlySet<string> = new Set([
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
]);

function _limitValue(raw: Record<string, unknown> | undefined, key: keyof DAGRunLimits, fallback: number): number {
  const value = raw?.[key];
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function _resolveLimits(raw: unknown): DAGRunLimits {
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
  return {
    max_nodes: _limitValue(value, "max_nodes", DEFAULT_LIMITS.max_nodes),
    max_dispatches: _limitValue(value, "max_dispatches", DEFAULT_LIMITS.max_dispatches),
    max_handoffs: _limitValue(value, "max_handoffs", DEFAULT_LIMITS.max_handoffs),
    max_corrections_per_node: _limitValue(value, "max_corrections_per_node", DEFAULT_LIMITS.max_corrections_per_node),
    max_edge_traversals: _limitValue(value, "max_edge_traversals", DEFAULT_LIMITS.max_edge_traversals),
    max_tool_calls_per_node: _limitValue(value, "max_tool_calls_per_node", DEFAULT_LIMITS.max_tool_calls_per_node),
  };
}

function _initialCounters(): DAGRunCounters {
  return {
    dispatches: 0,
    handoffs: 0,
    edge_traversals: {},
    corrections: {},
    advisor_calls: {},
    dispatch_retries: {},
    gateway_iterations: {},
    gateway_results: {},
  };
}

function _restoreCounters(counters: DAGRunCounters | undefined): DAGRunCounters {
  const defaults = _initialCounters();
  if (!counters) return defaults;
  return {
    ...defaults,
    ...counters,
    edge_traversals: { ...(counters.edge_traversals ?? {}) },
    corrections: { ...(counters.corrections ?? {}) },
    advisor_calls: Object.fromEntries(
      Object.entries(counters.advisor_calls ?? {}).map(([nodeId, calls]) => [nodeId, { ...calls }]),
    ),
    dispatch_retries: { ...(counters.dispatch_retries ?? {}) },
    gateway_iterations: { ...(counters.gateway_iterations ?? {}) },
    gateway_results: { ...(counters.gateway_results ?? {}) },
  };
}

function _buildNodeIndex(nodes: DAGGraphNode[]): Map<string, number> {
  return new Map(nodes.map((node, index) => [node.node_id, index]));
}

function _safeIndexSegment(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function _projectKey(run: ActiveRun): string {
  const workspace = run.workspace ?? {};
  return _safeIndexSegment(
    workspace.project_key ?? workspace.projectKey ?? workspace.project_id ?? workspace.projectId,
    "default",
  );
}

function _newSessionId(runId: string, nodeId: string): string {
  return _safeIndexSegment(`dag-${runId}-${nodeId}-${randomUUID()}`, `dag-${randomUUID()}`);
}

function _nodeConfiguredSessionId(node: DAGGraphNode | undefined): string | undefined {
  const extra = node?.extra ?? {};
  const raw = extra.session_id ?? extra.sessionId;
  return typeof raw === "string" && raw.trim() ? _safeIndexSegment(raw, raw.trim()) : undefined;
}

function _entryToNodeSession(entry: DagSessionIndexEntry): NodeSessionState {
  return {
    sessionId: entry.session_id,
    attempt: Number.isFinite(entry.attempt) && entry.attempt > 0 ? entry.attempt : 1,
    parentSessionId: entry.parent_session_id ?? undefined,
    forkedFromEntryUuid: entry.forked_from_entry_uuid ?? undefined,
    resumeInstruction: entry.resume_instruction ?? undefined,
    status: entry.status || "active",
  };
}

function _persistNodeSession(run: ActiveRun, nodeId: string, state: NodeSessionState): NodeSessionState {
  const entry = upsertDagSessionIndex({
    run_id: run.runId,
    node_id: nodeId,
    project_key: _projectKey(run),
    session_id: state.sessionId,
    attempt: state.attempt,
    parent_session_id: state.parentSessionId ?? null,
    forked_from_entry_uuid: state.forkedFromEntryUuid ?? null,
    resume_instruction: state.resumeInstruction ?? null,
    status: state.status,
  });
  const persisted = _entryToNodeSession(entry);
  run.nodeSessions.set(nodeId, persisted);
  return persisted;
}

function _ensureNodeSession(run: ActiveRun, nodeId: string): NodeSessionState {
  const current = run.nodeSessions.get(nodeId);
  if (current) return current;

  const persisted = getDagSessionIndex(run.runId, nodeId);
  if (persisted) {
    const state = _entryToNodeSession(persisted);
    run.nodeSessions.set(nodeId, state);
    return state;
  }

  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const state: NodeSessionState = {
    sessionId: _nodeConfiguredSessionId(node) ?? _newSessionId(run.runId, nodeId),
    attempt: 1,
    status: "active",
  };
  return _persistNodeSession(run, nodeId, state);
}

function _markNodeSessionStatus(run: ActiveRun, nodeId: string, status: string): void {
  const current = run.nodeSessions.get(nodeId);
  if (!current) return;
  _persistNodeSession(run, nodeId, { ...current, status });
}

function _instructionPreview(instruction: string): string {
  return instruction.replace(/\s+/g, " ").trim().slice(0, 240);
}

function _snapshotNodeStates(run: ActiveRun): Map<string, string> {
  return new Map(run.dagRun.nodeStates);
}

function _nodeName(run: ActiveRun, nodeId: string): string {
  return run.dagRun.graph.nodes.find((node) => node.node_id === nodeId)?.name ?? nodeId;
}

function _uiNodeStatus(status: string): string {
  return status.toLowerCase();
}

function _uiRunStatus(run: ActiveRun): string {
  return run.status === "active" ? "running" : run.status;
}

function _emitStatusUpdate(run: ActiveRun): void {
  emit("dag:status_update", {
    runId: run.runId,
    run_id: run.runId,
    dag_run_id: run.runId,
    status: _uiRunStatus(run),
    nodes: Array.from(run.dagRun.nodeStates.entries()).map(([nodeId, status]) => ({
      id: nodeId,
      name: _nodeName(run, nodeId),
      status: _uiNodeStatus(status),
    })),
    timestamp: new Date().toISOString(),
  });
}

function _emitNodeStateChanges(run: ActiveRun, before: Map<string, string>): void {
  const timestamp = new Date().toISOString();
  for (const [nodeId, state] of run.dagRun.nodeStates.entries()) {
    const previous = before.get(nodeId);
    if (previous === state) continue;
    emit("dag:node_state_changed", {
      runId: run.runId,
      run_id: run.runId,
      dag_run_id: run.runId,
      nodeId,
      node_id: nodeId,
      node_name: _nodeName(run, nodeId),
      status: _uiNodeStatus(state),
      previousStatus: previous ? _uiNodeStatus(previous) : undefined,
      previous_status: previous ? _uiNodeStatus(previous) : undefined,
      timestamp,
    });
  }
  _emitStatusUpdate(run);
}

export function _clearActiveRuns(): void {
  store.clear();
}

export function createActiveRun(
  runId: string,
  parsedDAG: ParsedDAG,
  options: CreateActiveRunOptions = {},
): ActiveRun {
  const dagRun = createDAGRun(parsedDAG, runId);
  seedInitialPrompt(
    dagRun,
    options.initialPrompt,
    parsedDAG.meta.run_input_targets,
    parsedDAG.meta.contracts,
  );
  const run: ActiveRun = {
    runId,
    workflowId: parsedDAG.meta.workflow_id,
    workflowName: parsedDAG.meta.name,
    workflowRevision: parsedDAG.meta.workflow_revision,
    canonicalHash: parsedDAG.meta.canonical_hash,
    compilerVersion: parsedDAG.meta.compiler_version,
    sourceApiVersion: parsedDAG.meta.source_api_version,
    contracts: parsedDAG.meta.contracts ? { ...parsedDAG.meta.contracts } : undefined,
    runInputTargets: parsedDAG.meta.run_input_targets
      ? parsedDAG.meta.run_input_targets.map((target) => ({ ...target }))
      : undefined,
    initialPrompt: options.initialPrompt,
    nodeCount: parsedDAG.graph.nodes.length,
    agents: parsedDAG.meta.agents
      ? { ...parsedDAG.meta.agents }
      : undefined,
    workspace: parsedDAG.meta.workspace
      ? { ...parsedDAG.meta.workspace }
      : undefined,
    scorecard: parsedDAG.meta.scorecard
      ? { ...parsedDAG.meta.scorecard }
      : undefined,
    pattern: parsedDAG.meta.pattern
      ? { ...parsedDAG.meta.pattern, parameters: { ...(parsedDAG.meta.pattern.parameters ?? {}) } }
      : undefined,
    dagRun,
    createdAt: Date.now(),
    status: "active",
    limits: _resolveLimits(parsedDAG.meta.limits),
    counters: _initialCounters(),
    nodeIndex: _buildNodeIndex(parsedDAG.graph.nodes),
    nodeSessions: new Map(),
  };
  store.set(runId, run);
  writeRunMetadata(runId, serializeRunMetadata(run));
  emit("dag:run_created", {
    runId,
    workflowId: run.workflowId,
    nodeCount: run.nodeCount,
  });
  emit("dag:engine_started", {
    runId,
    workflowId: run.workflowId,
    limits: { ...run.limits },
  });
  for (const nodeId of getReadyNodes(dagRun)) {
    emit("dag:node_ready", { runId, nodeId });
  }
  _emitStatusUpdate(run);
  return run;
}

export function seedInitialPrompt(
  dagRun: DAGRun,
  prompt: string | undefined,
  targets?: Array<{ node: string; port: string; contract?: string }>,
  contracts?: Record<string, unknown>,
): void {
  if (prompt === undefined || prompt.trim().length === 0) return;
  if (targets && targets.length > 0) {
    const payload = _structuredGatewayValue(prompt);
    for (const target of targets) {
      if (target.contract) {
        const schema = contracts?.[target.contract];
        const validation = validateJsonContract(schema, payload);
        if (!validation.valid) {
          throw new Error(`DAG_RUN_INPUT_CONTRACT_VIOLATION ${target.node}.${target.port}: ${validation.details}`);
        }
      }
      const mailbox = dagRun.mailboxes.get(target.node);
      if (!mailbox) throw new Error(`DAG run input targets unknown node: ${target.node}`);
      const values = mailbox.get(target.port) ?? [];
      values.push(payload);
      mailbox.set(target.port, values);
    }
    return;
  }
  for (const nodeId of getReadyNodes(dagRun)) {
    const mailbox = dagRun.mailboxes.get(nodeId);
    if (!mailbox) continue;
    const values = mailbox.get("prompt") ?? [];
    values.push(prompt);
    mailbox.set("prompt", values);
  }
}

// ---------------------------------------------------------------------------
//  Cold recovery — rebuild an ActiveRun from persisted state after a restart.
//
//  The persisted RunMetadata covers nearly every ActiveRun field, but four
//  DAGRun Maps are process-local and NOT serialized (mailboxes, afterSatisfied,
//  inputSatisfied, loopSources). Rather than hand-writing reconstruction and
//  risking loop-gateway wake-ups or dependency-satisfaction edge cases, we
//  rebuild a minimal DAGRun (all nodes PENDING, empty Maps) and replay the
//  persisted dag_handoffs through the engine's own `handoff()` — which drives
//  mailbox pushes, inputSatisfied marking, afterDep satisfaction, tryPromote
//  and loop wake-ups exactly as it did the first time. The authoritative
//  nodeStates snapshot from metadata is then layered on top so transient
//  states (RUNNING) are preserved long enough to be demoted.
// ---------------------------------------------------------------------------

/** Rebuilds a DAGRun's non-persisted Maps by replaying handoff history.
 * Caller must have set every node to a fresh state (we use PENDING) and
 * supplied empty afterSatisfied/inputSatisfied/mailboxes. */
function _replayHandoffsInto(
  dagRun: DAGRun,
  handoffs: Array<{ fromNode: string; port: string; content?: unknown }>,
): void {
  for (const record of handoffs) {
    if (!dagRun.nodeStates.has(record.fromNode)) continue;
    handoff(dagRun, record.fromNode, record.port, record.content);
  }
}

function _graphFromPersisted(data: PersistedGraphData): {
  nodes: DAGGraphNode[];
  edges: DAGEdge[];
  loopSources: Set<string>;
} {
  const nodes = data.nodes.map((node): DAGGraphNode => ({ ...node }));
  const edges = data.edges.map((edge): DAGEdge => ({ ...edge }));
  const loopSources = new Set(
    nodes
      .filter((n) => n.node_type === "loop_gateway" || n.node_type === "while_gateway")
      .map((n) => n.node_id),
  );
  return { nodes, edges, loopSources };
}

function _isRecoverableNodeState(value: string): value is NodeState {
  return RECOVERABLE_NODE_STATES.has(value);
}

function _rebuildDagRunFromPersisted(metadata: PersistedRunMetadata, graphData: PersistedGraphData): {
  dagRun: DAGRun;
  nodes: DAGGraphNode[];
} {
  const { nodes, edges, loopSources } = _graphFromPersisted(graphData);
  const graph = { nodes, edges };

  // Build a DAGRun in a neutral state, then replay history through the engine.
  const nodeStates = new Map<string, NodeState>();
  const afterSatisfied = new Map<string, Set<string>>();
  const inputSatisfied = new Map<string, Set<string>>();
  const mailboxes = new Map<string, Map<string, unknown[]>>();
  for (const node of nodes) {
    nodeStates.set(node.node_id, "PENDING");
    afterSatisfied.set(node.node_id, new Set());
    inputSatisfied.set(node.node_id, new Set());
    mailboxes.set(node.node_id, new Map());
  }
  const dagRun: DAGRun = {
    runId: metadata.runId,
    graph,
    loopSources,
    nodeStates,
    handoffedNodes: new Set(metadata.handoffedNodes),
    afterSatisfied,
    inputSatisfied,
    mailboxes,
  };

  const snapshot = loadRunSnapshot(metadata.runId);
  if (snapshot && snapshot.handoffs.length > 0) {
    _replayHandoffsInto(dagRun, snapshot.handoffs);
  }

  // Layer the authoritative node-state snapshot on top of the replay. The replay
  // only knows COMPLETED/terminal transitions; transient READY/RUNNING state is
  // taken from disk and orphaned RUNNING nodes are demoted in a separate step.
  for (const [nodeId, persistedState] of Object.entries(metadata.nodeStates)) {
    if (!nodeStates.has(nodeId)) continue;
    if (_isRecoverableNodeState(persistedState)) nodeStates.set(nodeId, persistedState);
  }

  return { dagRun, nodes };
}

function _applyOrphanedNodeDemotion(run: ActiveRun): string[] {
  const demotedFromRunning = Array.from(run.dagRun.nodeStates.entries())
    .filter(([, state]) => state === "RUNNING")
    .map(([nodeId]) => nodeId);

  // Apply RUNNING→FAILED demotion: mark sessions and emit the standard
  // node-failed signal so downstream edges/on_failure are routed.
  for (const nodeId of demotedFromRunning) {
    const current = run.nodeSessions.get(nodeId);
    if (current) {
      _persistNodeSession(run, nodeId, { ...current, status: "failed" });
    }
    failNode(run.dagRun, nodeId, { error: "node lost: manager process restarted" });
    emit("dag:node_failed", {
      runId: run.runId,
      nodeId,
      reason: "node lost: manager process restarted",
    });
  }

  const skippedBlockedNodes = reconcileFailedDependencies(run.dagRun);
  for (const nodeId of skippedBlockedNodes) {
    _markNodeSessionStatus(run, nodeId, "cancelled");
  }

  // A failed prerequisite can leave downstream nodes permanently PENDING. If
  // recovery has no READY/RUNNING work left, those nodes cannot make progress.
  const hasFailedNodes = Array.from(run.dagRun.nodeStates.values()).some((state) => state === "FAILED");
  const hasRunnableWork = Array.from(run.dagRun.nodeStates.values())
    .some((state) => state === "READY" || state === "RUNNING");
  if (hasFailedNodes && !hasRunnableWork) {
    for (const [nodeId, state] of run.dagRun.nodeStates.entries()) {
      if (state === "PENDING") {
        run.dagRun.nodeStates.set(nodeId, "SKIPPED");
        _markNodeSessionStatus(run, nodeId, "cancelled");
      }
    }
  }

  // If demoting orphaned nodes made the run terminal, mark it failed.
  if (hasFailedNodes && isRunTerminal(run.dagRun)) {
    run.status = "failed";
    run.completedAt = Date.now();
    emit("dag:run_failed", {
      runId: run.runId,
      nodeId: demotedFromRunning[0],
      reason: demotedFromRunning.length > 0
        ? "run failed during cold recovery (orphaned running nodes)"
        : "run failed during cold recovery (blocked by failed dependency)",
    });
    deprovisionProvisionedForRun(run.runId);
  }

  return demotedFromRunning;
}

export type RestoreActiveRunResult =
  | { status: "restored"; run: ActiveRun; demotedFromRunning: string[] }
  | { status: "skipped"; reason: string };

/** Reconstruct a single ActiveRun from persisted metadata and replay it into
 * the in-memory store. Only `status: "active"` runs are recoverable. */
export function restoreActiveRun(
  metadata: PersistedRunMetadata,
): RestoreActiveRunResult {
  if (metadata.status !== "active") {
    return { status: "skipped", reason: `run is ${metadata.status}` };
  }
  if (!metadata.graph) {
    return { status: "skipped", reason: "missing persisted graph" };
  }
  if (store.has(metadata.runId)) {
    return { status: "skipped", reason: "run already active in this process" };
  }

  const { dagRun, nodes } = _rebuildDagRunFromPersisted(metadata, metadata.graph);
  seedInitialPrompt(dagRun, metadata.initialPrompt, metadata.runInputTargets, metadata.contracts);
  const run: ActiveRun = {
    runId: metadata.runId,
    workflowId: metadata.workflowId,
    workflowName: metadata.workflowName,
    workflowRevision: metadata.workflowRevision,
    canonicalHash: metadata.canonicalHash,
    compilerVersion: metadata.compilerVersion,
    sourceApiVersion: metadata.sourceApiVersion,
    contracts: metadata.contracts ? { ...metadata.contracts } : undefined,
    runInputTargets: metadata.runInputTargets
      ? metadata.runInputTargets.map((target) => ({ ...target }))
      : undefined,
    initialPrompt: metadata.initialPrompt,
    nodeCount: metadata.nodeCount,
    agents: metadata.agents
      ? { ...metadata.agents }
      : undefined,
    workspace: metadata.workspace ? { ...metadata.workspace } : undefined,
    workspaceRetention: metadata.workspaceRetention ? { ...metadata.workspaceRetention } : undefined,
    scorecard: metadata.scorecard ? { ...metadata.scorecard } : undefined,
    pattern: metadata.pattern
      ? { ...metadata.pattern, parameters: { ...(metadata.pattern.parameters ?? {}) } }
      : undefined,
    dagRun,
    createdAt: metadata.createdAt,
    status: "active",
    limits: metadata.limits ?? { ...DEFAULT_LIMITS },
    counters: _restoreCounters(metadata.counters),
    nodeIndex: _buildNodeIndex(nodes),
    nodeSessions: new Map(),
  };

  // Restore per-node sessions from dag_session_index.
  for (const entry of listDagSessionIndex(metadata.runId)) {
    run.nodeSessions.set(entry.node_id, _entryToNodeSession(entry));
  }

  store.set(metadata.runId, run);

  const demotedFromRunning = _applyOrphanedNodeDemotion(run);
  writeRunMetadata(metadata.runId, serializeRunMetadata(run));

  emit("dag:run_recovered", {
    runId: metadata.runId,
    recoveredAt: Date.now(),
    demotedFromRunning,
    reason: demotedFromRunning.length
      ? "orphaned running nodes demoted to failed"
      : undefined,
  });
  _emitStatusUpdate(run);

  return { status: "restored", run, demotedFromRunning };
}

export interface ColdRecoverySummary {
  recovered: string[];
  failed: string[];
  skipped: string[];
}

/** Scan all persisted runs and restore every still-active one into the
 * in-memory store. Safe to call at startup. Idempotent. */
export function recoverAllActiveRuns(): ColdRecoverySummary {
  const summary: ColdRecoverySummary = { recovered: [], failed: [], skipped: [] };
  for (const runId of listPersistedRunIds()) {
    try {
      const metadata = loadRunMetadata(runId);
      if (!metadata) {
        summary.skipped.push(runId);
        continue;
      }
      const result = restoreActiveRun(metadata);
      if (result.status === "restored") {
        if (result.run.status === "failed") {
          summary.failed.push(runId);
        } else {
          summary.recovered.push(runId);
        }
      } else {
        summary.skipped.push(runId);
      }
    } catch (err) {
      // A single corrupt run must not block recovery of the rest.
      console.error(
        `[homerail_manager] cold recovery skipped run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      summary.skipped.push(runId);
    }
  }
  return summary;
}

/** Re-dispatch READY nodes of every recovered active run. Intended to be
 * called once, after the first worker/node reconnects, so dispatch actually
 * finds a target instead of immediately failing. */
export function dispatchRecoveredRuns(dispatcher: DAGDispatcher): number {
  let dispatched = 0;
  for (const run of store.values()) {
    if (run.status !== "active") continue;
    dispatched += dispatchReadyNodes(run.runId, dispatcher);
  }
  return dispatched;
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return store.get(runId);
}

export function getCurrentNodeSession(runId: string, nodeId: string): NodeSessionState | undefined {
  const run = store.get(runId);
  if (!run || !run.dagRun.nodeStates.has(nodeId)) return undefined;
  return _ensureNodeSession(run, nodeId);
}

export function isCurrentNodeSession(runId: string, nodeId: string, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  const current = getCurrentNodeSession(runId, nodeId);
  return !current || current.sessionId === sessionId;
}

export function listActiveRuns(): ActiveRun[] {
  return Array.from(store.values());
}

export function completeActiveRun(runId: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  const before = _snapshotNodeStates(run);
  run.status = "completed";
  run.completedAt = Date.now();
  for (const nodeId of run.nodeSessions.keys()) {
    _markNodeSessionStatus(run, nodeId, "completed");
  }
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:run_completed", { runId });
  emit("dag:engine_completed", { runId });
  deprovisionProvisionedForRun(runId);
  return run;
}

export function cancelActiveRun(runId: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") return run;
  const before = _snapshotNodeStates(run);
  for (const [nodeId, state] of run.dagRun.nodeStates.entries()) {
    if (state === "RUNNING" || state === "READY") {
      run.dagRun.nodeStates.set(nodeId, "CANCELLED");
      _markNodeSessionStatus(run, nodeId, "cancelled");
    } else if (state === "PENDING") {
      run.dagRun.nodeStates.set(nodeId, "SKIPPED");
    }
  }
  run.status = "cancelled";
  run.completedAt = Date.now();
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:run_cancelled", { runId });
  deprovisionProvisionedForRun(runId);
  return run;
}

export function abortActiveRun(runId: string, reason: string, nodeId?: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") return run;
  const before = _snapshotNodeStates(run);
  if (nodeId && run.dagRun.nodeStates.has(nodeId)) {
    run.dagRun.nodeStates.set(nodeId, "FAILED");
    _markNodeSessionStatus(run, nodeId, "failed");
  }
  for (const [id, state] of run.dagRun.nodeStates.entries()) {
    if (id === nodeId) continue;
    if (state === "READY" || state === "RUNNING") {
      run.dagRun.nodeStates.set(id, "CANCELLED");
      _markNodeSessionStatus(run, id, "cancelled");
    } else if (state === "PENDING") {
      run.dagRun.nodeStates.set(id, "SKIPPED");
    }
  }
  run.status = "failed";
  run.completedAt = Date.now();
  run.counters.abort_reason = reason;
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:engine_aborted", { runId, nodeId, reason });
  emit("dag:run_failed", { runId, nodeId: nodeId ?? "", reason });
  deprovisionProvisionedForRun(runId);
  return run;
}

export function failActiveRun(runId: string, nodeId: string, reason: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") return run;
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const before = _snapshotNodeStates(run);
  const readyBefore = new Set(getReadyNodes(run.dagRun));
  failNode(run.dagRun, nodeId, { error: reason });
  _markNodeSessionStatus(run, nodeId, "failed");
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:node_failed", { runId, nodeId, reason });
  if (node) {
    _recordFanoutChild(run, node, "failed", {
      status: "failed",
      evidence: { reason },
    });
  }
  if (run.status !== "active") return run;

  for (const readyNodeId of getReadyNodes(run.dagRun)) {
    if (!readyBefore.has(readyNodeId)) {
      emit("dag:node_ready", { runId, nodeId: readyNodeId });
    }
  }

  if (isRunTerminal(run.dagRun)) {
    run.status = "failed";
    run.completedAt = Date.now();
    writeRunMetadata(runId, serializeRunMetadata(run));
    _emitStatusUpdate(run);
    emit("dag:run_failed", { runId, nodeId, reason });
    deprovisionProvisionedForRun(runId);
  }
  return run;
}

export type NodeCorrectionResult =
  | { status: "scheduled"; run: ActiveRun; attempt: number; maxAttempts: number }
  | { status: "exhausted"; run: ActiveRun; attempts: number; maxAttempts: number }
  | { status: "unavailable"; reason: string };

function _correctionPrompt(
  nodeId: string,
  reason: string,
  attempt: number,
  maxAttempts: number,
  outputPorts: string[],
): string {
  const declaredPorts = outputPorts.length > 0 ? outputPorts.join(", ") : "done";
  return [
    `Correction attempt ${attempt}/${maxAttempts} for DAG node ${nodeId}.`,
    `Previous attempt ended without a valid DAG handoff: ${reason}`,
    `Declared output ports for this node: ${declaredPorts}.`,
    "Treat that error as authoritative. Preserve required field names and JSON array/object/number types exactly.",
    "If the work already completed, do not repeat it. Do not answer with text.",
    "Your next and only action must call the handoff tool with exactly one declared output port and contract-valid content derived from the original inputs and completed work.",
  ].join("\n");
}

export function requestNodeCorrection(
  runId: string,
  nodeId: string,
  reason: string,
): NodeCorrectionResult {
  const run = store.get(runId);
  if (!run) return { status: "unavailable", reason: `Unknown run: ${runId}` };
  if (run.status !== "active") return { status: "unavailable", reason: `Run is not active: ${run.status}` };
  if (!run.dagRun.nodeStates.has(nodeId)) return { status: "unavailable", reason: `Unknown node: ${nodeId}` };

  const maxAttempts = run.limits.max_corrections_per_node;
  const previousAttempts = run.counters.corrections[nodeId] ?? 0;
  if (previousAttempts >= maxAttempts) {
    return { status: "exhausted", run, attempts: previousAttempts, maxAttempts };
  }

  const before = _snapshotNodeStates(run);
  const attempt = previousAttempts + 1;
  const outputPorts = Array.from(new Set(
    run.dagRun.graph.edges
      .filter((edge) => edge.from_node === nodeId && edge.label !== "after_dep")
      .map((edge) => edge.from_port),
  )).sort();
  run.counters.corrections[nodeId] = attempt;
  const mailbox = run.dagRun.mailboxes.get(nodeId);
  if (mailbox) {
    const values = mailbox.get("correction") ?? [];
    values.push(_correctionPrompt(nodeId, reason, attempt, maxAttempts, outputPorts));
    mailbox.set("correction", values);
  }
  resetSkippedSuccessDescendants(run.dagRun, nodeId);
  run.dagRun.nodeStates.set(nodeId, "READY");
  run.dagRun.handoffedNodes.delete(nodeId);
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:node_correction_requested", { runId, nodeId, reason, attempt, maxAttempts });
  emit("dag:node_ready", { runId, nodeId });
  return { status: "scheduled", run, attempt, maxAttempts };
}

export function recordAdvisorCall(runId: string, nodeId: string, advisorId: string): number | undefined {
  const run = store.get(runId);
  if (!run || run.status !== "active" || !run.dagRun.nodeStates.has(nodeId) || !advisorId) return undefined;
  const nodeCalls = run.counters.advisor_calls[nodeId] ?? {};
  const next = (nodeCalls[advisorId] ?? 0) + 1;
  nodeCalls[advisorId] = next;
  run.counters.advisor_calls[nodeId] = nodeCalls;
  writeRunMetadata(runId, serializeRunMetadata(run));
  return next;
}

function _defaultSuccessPort(run: ActiveRun, nodeId: string): string {
  const edge = run.dagRun.graph.edges.find((candidate) =>
    candidate.from_node === nodeId &&
    candidate.label !== "after_dep" &&
    candidate.condition !== "on_failure" &&
    !isFailurePort(candidate.from_port)
  );
  return edge?.from_port || "done";
}

export function autoHandoffAfterCorrectionExhausted(
  runId: string,
  nodeId: string,
  reason: string,
): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run || run.status !== "active" || !run.dagRun.nodeStates.has(nodeId)) return undefined;
  const port = _defaultSuccessPort(run, nodeId);
  let next: ActiveRun | undefined;
  try {
    next = handoffActiveRun(runId, nodeId, port, {
      auto_handoff: true,
      reason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failActiveRun(runId, nodeId, `auto handoff failed after correction exhaustion: ${message}`);
  }
  if (next) {
    emit("dag:node_auto_handoff", { runId, nodeId, port, reason });
  }
  return next;
}

export function recordNodeDispatchRetry(runId: string, nodeId: string, reason: string): boolean {
  const run = store.get(runId);
  if (!run || run.status !== "active" || !run.dagRun.nodeStates.has(nodeId)) return false;
  const previousAttempts = run.counters.dispatch_retries[nodeId] ?? 0;
  if (previousAttempts >= MAX_DISPATCH_RETRIES_PER_NODE) return false;
  const attempt = previousAttempts + 1;
  run.counters.dispatch_retries[nodeId] = attempt;
  writeRunMetadata(runId, serializeRunMetadata(run));
  emit("dag:node_dispatch_retry", {
    runId,
    nodeId,
    reason,
    attempt,
    maxAttempts: MAX_DISPATCH_RETRIES_PER_NODE,
  });
  return true;
}

export function checkpointResumeActiveRun(
  runId: string,
  nodeId: string,
  request: CheckpointResumeRequest,
): CheckpointResumeResult {
  const run = store.get(runId);
  if (!run) return { status: "unavailable", reason: `Run is not active in this Manager process: ${runId}` };
  if (run.status !== "active") return { status: "unavailable", reason: `Run is terminal: ${runId}` };
  if (!run.dagRun.nodeStates.has(nodeId)) return { status: "unavailable", reason: `Unknown node: ${nodeId}` };
  const instruction = typeof request.instruction === "string" ? request.instruction.trim() : "";
  if (!instruction) return { status: "unavailable", reason: "Missing required field: instruction" };

  const before = _snapshotNodeStates(run);
  const parent = _ensureNodeSession(run, nodeId);
  const requestedSessionId = typeof request.sessionId === "string" && request.sessionId.trim()
    ? _safeIndexSegment(request.sessionId, request.sessionId.trim())
    : undefined;
  if (requestedSessionId && requestedSessionId === parent.sessionId) {
    return {
      status: "unavailable",
      reason: "checkpoint resume requires a new forked session id; refusing to reuse the parent session",
    };
  }
  let fork;
  const nextSession: NodeSessionState = {
    sessionId: requestedSessionId ?? _newSessionId(runId, nodeId),
    attempt: parent.attempt + 1,
    parentSessionId: parent.sessionId,
    forkedFromEntryUuid: undefined,
    resumeInstruction: instruction,
    status: "active",
  };
  try {
    fork = checkpointForkSession({
      runId,
      nodeId,
      parentSessionId: parent.sessionId,
      newSessionId: nextSession.sessionId,
      entryUuid: typeof request.entryUuid === "string" && request.entryUuid.trim()
        ? request.entryUuid.trim()
        : undefined,
      last: request.last,
    });
    nextSession.forkedFromEntryUuid = fork.entryUuid;
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  _persistNodeSession(run, nodeId, nextSession);

  const mailbox = run.dagRun.mailboxes.get(nodeId);
  if (mailbox) {
    mailbox.set("checkpoint_resume", [instruction]);
  }
  run.dagRun.nodeStates.set(nodeId, "READY");
  run.dagRun.handoffedNodes.delete(nodeId);

  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:checkpoint_resume", {
    runId,
    nodeId,
    sessionId: nextSession.sessionId,
    parentSessionId: nextSession.parentSessionId,
    attempt: nextSession.attempt,
    entryUuid: fork.entryUuid,
    instructionPreview: _instructionPreview(instruction),
  });
  emit("dag:node_ready", { runId, nodeId });

  return {
    status: "scheduled",
    runId,
    nodeId,
    sessionId: nextSession.sessionId,
    parentSessionId: nextSession.parentSessionId,
    attempt: nextSession.attempt,
    entryUuid: fork.entryUuid,
    keptEntries: fork.keptEntries,
    totalEntries: fork.totalEntries,
    instruction,
  };
}

export function handoffActiveRun(
  runId: string,
  fromNode: string,
  port: string,
  content: unknown,
): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") throw new Error(`Run ${runId} is not active`);
  const sourceState = getNodeState(run.dagRun, fromNode);
  if (sourceState === "COMPLETED" || sourceState === "FAILED" || sourceState === "CANCELLED" || sourceState === "SKIPPED") {
    throw new Error(`Node ${fromNode} cannot hand off from terminal state ${sourceState}`);
  }
  _assertHandoffPreconditions(run, fromNode, port, content, true);
  const before = _snapshotNodeStates(run);
  const readyBefore = new Set(getReadyNodes(run.dagRun));
  run.counters.handoffs++;

  for (const edge of run.dagRun.graph.edges) {
    if (edge.from_node !== fromNode || edge.to_node === "" || edge.label === "after_dep") continue;
    if (!edgeMatchesHandoff(edge, port)) continue;
    if (!_isBackwardEdge(run, edge)) continue;
    const key = `${edge.from_node}/${edge.from_port}->${edge.to_node}/${edge.to_port}`;
    const nextCount = (run.counters.edge_traversals[key] ?? 0) + 1;
    run.counters.edge_traversals[key] = nextCount;
    const edgeLimit = edge.retry_policy?.max_retries ?? run.limits.max_edge_traversals;
    if (nextCount > edgeLimit) {
      abortActiveRun(runId, `edge retry limit (${edgeLimit}) exceeded for ${key}`, fromNode);
      throw new Error(`edge retry limit (${edgeLimit}) exceeded for ${key}`);
    }
  }

  const transition = handoff(run.dagRun, fromNode, port, content);
  _markNodeSessionStatus(
    run,
    fromNode,
    transition.terminalOutcome === "cancelled"
      ? "cancelled"
      : transition.terminalFailure
        ? "failed"
        : "completed",
  );
  appendHandoff(runId, { runId, fromNode, port, content, timestamp: Date.now() });
  const handedOffNode = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
  if (handedOffNode) _recordFanoutChild(run, handedOffNode, port, content);
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:handoff", { runId, fromNode, port });
  if (transition.terminalFailure) {
    emit("dag:terminal_failure_handoff", { runId, fromNode, port });
    abortActiveRun(runId, `terminal failure handoff on port ${port}`, fromNode);
    return run;
  }

  for (const nodeId of getReadyNodes(run.dagRun)) {
    if (!readyBefore.has(nodeId)) {
      emit("dag:node_ready", { runId, nodeId });
    }
  }

  if (run.status === "active" && isRunTerminal(run.dagRun)) {
    if (transition.terminalOutcome === "cancelled") {
      run.status = "cancelled";
      run.completedAt = Date.now();
      writeRunMetadata(runId, serializeRunMetadata(run));
      _emitStatusUpdate(run);
      emit("dag:run_cancelled", { runId, nodeId: fromNode, reason: `terminal cancelled handoff on port ${port}` });
      deprovisionProvisionedForRun(runId);
    } else {
      completeActiveRun(runId);
    }
  }

  return run;
}

function _assertHandoffPreconditions(
  run: ActiveRun,
  fromNode: string,
  port: string,
  content: unknown,
  abortOnLimit = false,
): void {
  const contractViolation = _handoffContractViolation(run, fromNode, port, content);
  if (contractViolation) throw new Error(contractViolation);
  if (run.counters.handoffs >= run.limits.max_handoffs) {
    if (abortOnLimit) abortActiveRun(run.runId, `max_handoffs (${run.limits.max_handoffs}) exceeded`, fromNode);
    throw new Error(`max_handoffs (${run.limits.max_handoffs}) exceeded`);
  }
  for (const edge of run.dagRun.graph.edges) {
    if (edge.from_node !== fromNode || edge.to_node === "" || edge.label === "after_dep") continue;
    if (!edgeMatchesHandoff(edge, port) || !_isBackwardEdge(run, edge)) continue;
    const key = `${edge.from_node}/${edge.from_port}->${edge.to_node}/${edge.to_port}`;
    const nextCount = (run.counters.edge_traversals[key] ?? 0) + 1;
    const edgeLimit = edge.retry_policy?.max_retries ?? run.limits.max_edge_traversals;
    if (nextCount > edgeLimit) {
      if (abortOnLimit) abortActiveRun(run.runId, `edge retry limit (${edgeLimit}) exceeded for ${key}`, fromNode);
      throw new Error(`edge retry limit (${edgeLimit}) exceeded for ${key}`);
    }
  }
}

export function decideActiveRunApproval(input: {
  runId: string;
  nodeId: string;
  decision: "approved" | "rejected";
  actor: string;
  proposalHash: string;
}): DagApprovalRecord {
  const run = store.get(input.runId);
  if (!run) throw new Error(`Run not found: ${input.runId}`);
  if (run.status !== "active") throw new Error(`Run ${input.runId} is not active`);
  if (getNodeState(run.dagRun, input.nodeId) !== "WAITING_FOR_APPROVAL") {
    throw new Error(`Node ${input.nodeId} is not waiting for approval`);
  }
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === input.nodeId);
  if (!node || node.node_type !== "approval_gateway") throw new Error(`Approval node not found: ${input.nodeId}`);
  const port = input.decision === "approved"
    ? node.gateway_config?.approved_port || "approved"
    : node.gateway_config?.rejected_port || "rejected";
  const pending = getApproval(input.runId, input.nodeId);
  if (!pending) throw new Error("approval not found");
  _assertHandoffPreconditions(run, input.nodeId, port, {
    approval_id: pending.approval_id,
    proposal_hash: pending.proposal_hash,
    decision: input.decision,
    actor: input.actor,
    decided_at: Date.now(),
    proposal: pending.proposal,
  });
  const record = decideApproval(input);
  handoffActiveRun(input.runId, input.nodeId, port, {
    approval_id: record.approval_id,
    proposal_hash: record.proposal_hash,
    decision: input.decision,
    actor: input.actor,
    decided_at: record.updated_at,
    proposal: record.proposal,
  });
  emit("dag:approval_decided", {
    runId: input.runId,
    nodeId: input.nodeId,
    approvalId: record.approval_id,
    proposalHash: record.proposal_hash,
    decision: input.decision,
    actor: input.actor,
    port,
  });
  return record;
}

export function expireActiveRunApprovals(now = Date.now()): DagApprovalRecord[] {
  const expired = expirePendingApprovals(now);
  for (const record of expired) {
    const run = store.get(record.run_id);
    if (!run || run.status !== "active") continue;
    if (getNodeState(run.dagRun, record.node_id) !== "WAITING_FOR_APPROVAL") continue;
    const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === record.node_id);
    if (!node || node.node_type !== "approval_gateway") continue;
    const port = node.gateway_config?.rejected_port || "rejected";
    try {
      handoffActiveRun(record.run_id, record.node_id, port, {
        approval_id: record.approval_id,
        proposal_hash: record.proposal_hash,
        decision: "rejected",
        actor: "system:expiry",
        expired_at: now,
        proposal: record.proposal,
      });
      emit("dag:approval_expired", {
        runId: record.run_id,
        nodeId: record.node_id,
        approvalId: record.approval_id,
        proposalHash: record.proposal_hash,
        port,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (run.status === "active") failActiveRun(record.run_id, record.node_id, reason);
      emit("dag:approval_expired", {
        runId: record.run_id,
        nodeId: record.node_id,
        approvalId: record.approval_id,
        proposalHash: record.proposal_hash,
        port,
        error: reason,
      });
    }
  }
  return expired;
}

function _handoffContractViolation(
  run: ActiveRun,
  fromNode: string,
  port: string,
  content: unknown,
): string | undefined {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
  const workflowSpec = node?.extra?.workflow_spec_v1;
  if (!workflowSpec || typeof workflowSpec !== "object" || Array.isArray(workflowSpec)) return undefined;
  const outputContracts = (workflowSpec as Record<string, unknown>).output_contracts;
  if (!outputContracts || typeof outputContracts !== "object" || Array.isArray(outputContracts)) return undefined;
  const contractName = (outputContracts as Record<string, unknown>)[port];
  if (typeof contractName !== "string" || !contractName) return undefined;
  const schema = run.contracts?.[contractName];
  if (!schema) return `DAG_HANDOFF_CONTRACT_VIOLATION ${fromNode}.${port}: contract '${contractName}' is missing`;
  const validation = validateJsonContract(schema, content);
  if (validation.valid) return undefined;
  return `DAG_HANDOFF_CONTRACT_VIOLATION ${fromNode}.${port} (${contractName}): ${validation.details}`;
}

export function getActiveRunCount(): number {
  let count = 0;
  for (const run of store.values()) {
    if (run.status === "active") count++;
  }
  return count;
}

function _afterDepEdges(node: DAGGraphNode): DAGEdge[] {
  return node.after.map((fromNode) => ({
    from_node: fromNode,
    from_port: "done",
    to_node: node.node_id,
    to_port: "task",
    condition: "on_success",
    label: "after_dep",
  }));
}

function _isBackwardEdge(run: ActiveRun, edge: DAGEdge): boolean {
  const target = run.dagRun.graph.nodes.find((node) => node.node_id === edge.to_node);
  if (target?.node_type === "loop_gateway" || target?.node_type === "while_gateway") {
    const source = run.dagRun.graph.nodes.find((node) => node.node_id === edge.from_node);
    return source?.after.includes(target.node_id) ?? false;
  }
  const fromIndex = run.nodeIndex.get(edge.from_node);
  const toIndex = run.nodeIndex.get(edge.to_node);
  return fromIndex !== undefined && toIndex !== undefined && fromIndex > toIndex;
}

export function appendRunNode(
  runId: string,
  request: AppendRunNodeRequest,
): AppendRunNodeResult | undefined {
  const run = store.get(runId);
  if (!run || run.status !== "active") return undefined;
  const node = request.node;
  const before = _snapshotNodeStates(run);
  if (run.dagRun.nodeStates.has(node.node_id)) {
    throw new Error(`Node already exists in run graph: ${node.node_id}`);
  }
  if (run.dagRun.graph.nodes.length >= run.limits.max_nodes) {
    throw new Error(`max_nodes (${run.limits.max_nodes}) exceeded`);
  }
  for (const dep of node.after) {
    if (!run.dagRun.nodeStates.has(dep)) {
      throw new Error(`Unknown after dependency: ${dep}`);
    }
  }

  const afterEdges = _afterDepEdges(node);
  const outputEdges = _normalizeOutputsToEdges(node.outputs as Record<string, DAGOutputRoute>, node.node_id);
  const nextGraph = {
    nodes: [...run.dagRun.graph.nodes, node],
    edges: [...run.dagRun.graph.edges, ...afterEdges, ...outputEdges],
  };
  assertGraphValid(nextGraph);

  run.dagRun.graph.nodes.push(node);
  run.dagRun.graph.edges.push(...afterEdges, ...outputEdges);
  run.nodeIndex.set(node.node_id, run.dagRun.graph.nodes.length - 1);
  run.dagRun.afterSatisfied.set(
    node.node_id,
    new Set(node.after.filter((dep) => run.dagRun.handoffedNodes.has(dep))),
  );
  run.dagRun.inputSatisfied.set(node.node_id, new Set<string>());
  run.dagRun.mailboxes.set(node.node_id, new Map<string, unknown[]>());
  const depsSatisfied = node.after.every((dep) => run.dagRun.handoffedNodes.has(dep));
  run.dagRun.nodeStates.set(node.node_id, depsSatisfied ? "READY" : "PENDING");
  run.nodeCount = run.dagRun.graph.nodes.length;
  if (request.agentConfig) {
    run.agents = { ...(run.agents ?? {}), [node.agent]: request.agentConfig };
  }

  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  emit("dag:node_added", { runId, nodeId: node.node_id, after: node.after });
  if (depsSatisfied) emit("dag:node_ready", { runId, nodeId: node.node_id });

  return {
    runId,
    nodeId: node.node_id,
    ready: depsSatisfied,
    dispatched: false,
    nodeCount: run.nodeCount,
  };
}

export interface CancelAllResult {
  cancelled: string[];
  activeBefore: number;
  activeAfter: number;
}

export function cancelAllActiveRuns(): CancelAllResult {
  const activeBefore = getActiveRunCount();
  const cancelled: string[] = [];
  for (const run of store.values()) {
    if (run.status === "active") {
      cancelActiveRun(run.runId);
      cancelled.push(run.runId);
    }
  }
  return { cancelled, activeBefore, activeAfter: getActiveRunCount() };
}

export function injectActiveRun(
  runId: string,
  nodeId: string,
  instruction: string,
  mode: string,
): InjectResult | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") return undefined;
  const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
  if (!node) return undefined;

  const result: InjectResult = {
    runId,
    nodeId,
    instruction,
    mode,
    timestamp: Date.now(),
    delivered: false,
  };

  writeRunMetadata(runId, serializeRunMetadata(run));
  emit("dag:instruction_injected", {
    runId,
    nodeId,
    instruction,
    mode,
  });

  const target = findDispatchTarget(runId, nodeId);
  if (target && target.targetType && target.targetId) {
    const registryEntry =
      target.targetType === "worker"
        ? getWorker(target.targetId)
        : getNode(target.targetId);
    const socket = registryEntry?.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "inject",
          data: { runId, nodeId, instruction, mode },
        }),
      );
      result.delivered = true;
      result.deliveryTargetType = target.targetType;
      result.deliveryTargetId = target.targetId;
      emit("dag:instruction_delivered", {
        runId,
        nodeId,
        instruction,
        mode,
        targetType: target.targetType,
        targetId: target.targetId,
      });
    } else {
      result.deliveryGap = "target socket not open";
      emit("dag:instruction_delivery_failed", {
        runId,
        nodeId,
        instruction,
        mode,
        reason: result.deliveryGap,
      });
    }
  } else {
    result.deliveryGap = "no dispatch target found for node";
    emit("dag:instruction_delivery_failed", {
      runId,
      nodeId,
      instruction,
      mode,
      reason: result.deliveryGap,
    });
  }

  return result;
}

function _nodeInputs(
  run: DAGRun,
  nodeId: string,
): Record<string, unknown[]> {
  const inputs: Record<string, unknown[]> = {};
  const mailbox = run.mailboxes.get(nodeId);
  if (!mailbox) return inputs;
  for (const [port, values] of mailbox.entries()) {
    if (values.length > 0) inputs[port] = [...values];
  }
  return inputs;
}

function _isGatewayNode(node: DAGGraphNode): boolean {
  return node.node_type === "loop_gateway" ||
    node.node_type === "condition_gateway" ||
    node.node_type === "join_gateway" ||
    node.node_type === "while_gateway" ||
    node.node_type === "command_gateway" ||
    node.node_type === "approval_gateway" ||
    node.node_type === "state_gateway" ||
    node.node_type === "fanout_gateway";
}

function _firstInputValue(inputs: Record<string, unknown[]>): unknown {
  for (const values of Object.values(inputs)) {
    if (values.length > 0) return values[values.length - 1];
  }
  return undefined;
}

function _structuredGatewayValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function _fieldValue(value: unknown, field: string | undefined): unknown {
  let current = _structuredGatewayValue(value);
  if (!field) return current;
  if (field === "$") return current;
  for (const part of field.split(".").map((item) => item.trim()).filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function _conditionGatewayPort(config: DAGGatewayConfig | undefined, input: unknown): string {
  const selected = _fieldValue(input, config?.field);
  const routes = config?.routes ?? config?.cases ?? {};
  const key = selected === undefined || selected === null ? "" : String(selected);
  if (key && typeof routes[key] === "string" && routes[key]) return routes[key];
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>;
    if (typeof raw.port === "string" && raw.port) return raw.port;
    if (typeof raw.route === "string" && raw.route) return raw.route;
  }
  return config?.default_port || "default";
}

function _loopGatewayItems(config: DAGGatewayConfig | undefined, inputs: Record<string, unknown[]>): unknown[] {
  if (Array.isArray(config?.items)) return config.items;
  const inputPort = config?.input || "items";
  const fromItemsPort = inputs[inputPort]
    ?.map(_structuredGatewayValue)
    .map((value) => _fieldValue(value, config?.field))
    .find((value) => Array.isArray(value));
  if (Array.isArray(fromItemsPort)) return fromItemsPort;
  const first = _structuredGatewayValue(_firstInputValue(inputs));
  return Array.isArray(first) ? first : [];
}

function _gatewayComparison(actual: unknown, operator: string | undefined, expected: unknown): boolean {
  switch (operator ?? "eq") {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "truthy":
      return Boolean(actual);
    case "falsy":
      return !actual;
    default:
      return false;
  }
}

function _joinGatewayResult(config: DAGGatewayConfig | undefined, inputs: Record<string, unknown[]>): {
  port: string;
  payload: Record<string, unknown>;
} {
  const values = Object.values(inputs).flat();
  const successValues = config?.success_values ?? [true, "pass", "passed", "success", "approved", "yes", "act", "actionable"];
  const votes = values.map((value) => {
    const selected = _fieldValue(value, config?.field);
    return successValues.some((candidate) => selected === candidate);
  });
  const successes = votes.filter(Boolean).length;
  const mode = config?.mode === "any" || config?.mode === "n_of_m" ? config.mode : "all";
  const threshold = mode === "any"
    ? 1
    : mode === "n_of_m"
      ? Math.max(1, Math.floor(config?.threshold ?? Math.ceil(values.length / 2)))
      : values.length;
  const passed = values.length > 0 && successes >= threshold;
  return {
    port: passed ? config?.passed_port || "passed" : config?.failed_port || "failed",
    payload: {
      mode,
      total: values.length,
      successes,
      failures: values.length - successes,
      threshold,
      passed,
      values,
    },
  };
}

function _terminateLoopSource(run: ActiveRun, nodeId: string): void {
  // loopSources is run-local execution state; removal makes this gateway terminal for the rest of this run.
  run.dagRun.loopSources.delete(nodeId);
}

function _whileGatewayResult(
  run: ActiveRun,
  node: DAGGraphNode,
  input: unknown,
): { port: string; payload: Record<string, unknown> } {
  const config = node.gateway_config;
  const selected = _fieldValue(input, config?.field);
  const matched = _gatewayComparison(selected, config?.operator, config?.value);
  const iteration = run.counters.gateway_iterations[node.node_id] ?? 0;
  const maxIterations = Math.max(1, Math.floor(config?.max_iterations ?? 3));
  if (matched) {
    _terminateLoopSource(run, node.node_id);
    return {
      port: config?.done_port || "done",
      payload: { input, iteration, max_iterations: maxIterations, matched: true },
    };
  }
  if (iteration >= maxIterations) {
    _terminateLoopSource(run, node.node_id);
    return {
      port: config?.exhausted_port || "exhausted",
      payload: { input, iteration, max_iterations: maxIterations, matched: false, exhausted: true },
    };
  }
  run.counters.gateway_iterations[node.node_id] = iteration + 1;
  return {
    port: config?.continue_port || "continue",
    payload: { input, iteration: iteration + 1, max_iterations: maxIterations, matched: false },
  };
}

function _commandAllowlist(): Set<string> {
  const configured = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST ?? "";
  return new Set(configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function _commandGatewayResult(run: ActiveRun, node: DAGGraphNode): { port: string; payload: Record<string, unknown> } {
  const config = node.gateway_config;
  const inputs = _nodeInputs(run.dagRun, node.node_id);
  const selectedInputs = config?.input ? inputs[config.input] : undefined;
  const input = selectedInputs && selectedInputs.length > 0
    ? selectedInputs[selectedInputs.length - 1]
    : _firstInputValue(inputs);
  const fromInput = config?.command_field ? _fieldValue(input, config.command_field) : undefined;
  const command = Array.isArray(fromInput) ? fromInput : config?.command;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    return { port: config?.failure_port || "failed", payload: { ok: false, error: "invalid command configuration" } };
  }
  if (config?.command_field && process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS !== "true") {
    return {
      port: config?.failure_port || "failed",
      payload: { ok: false, error: "dynamic command_field requires HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS=true" },
    };
  }
  const configuredExecutable = command[0].toLowerCase();
  const executable = path.basename(configuredExecutable).replace(/\.exe$/, "");
  const allowlist = _commandAllowlist();
  const hasPathSeparator = command[0].includes("/") || command[0].includes("\\");
  const allowed = hasPathSeparator ? allowlist.has(configuredExecutable) : allowlist.has(executable);
  if (!allowed) {
    return {
      port: config?.failure_port || "failed",
      payload: { ok: false, error: `executable '${command[0]}' is not in HOMERAIL_DAG_COMMAND_ALLOWLIST` },
    };
  }
  const root = process.cwd();
  const cwd = path.resolve(root, config?.cwd ?? ".");
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
    return { port: config?.failure_port || "failed", payload: { ok: false, error: "command cwd escapes Manager workspace" } };
  }
  const captureLimit = Math.max(1, Math.floor(config?.capture_limit ?? 64_000));
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: Math.max(100, Math.floor(config?.timeout_ms ?? 30_000)),
    maxBuffer: captureLimit * 2,
    shell: false,
    env: process.env,
    ...(config?.stdin_field ? { input: JSON.stringify(_fieldValue(input, config.stdin_field)) } : {}),
  });
  const exitCode = typeof result.status === "number" ? result.status : null;
  const successCodes = config?.success_exit_codes ?? [0];
  const ok = exitCode !== null && successCodes.includes(exitCode) && !result.error;
  const stdout = String(result.stdout ?? "").slice(0, captureLimit);
  let value: unknown = stdout;
  if (config?.parse_stdout === "number") value = Number(stdout.trim());
  if (config?.parse_stdout === "json") {
    try {
      value = JSON.parse(stdout) as unknown;
    } catch {
      value = undefined;
    }
  }
  const parseFailed = (config?.parse_stdout === "number" && !Number.isFinite(value)) || (config?.parse_stdout === "json" && value === undefined);
  const payload = {
    ok: ok && !parseFailed,
    command: command[0],
    args: command.slice(1),
    cwd: path.relative(root, cwd) || ".",
    exit_code: exitCode,
    signal: result.signal ?? null,
    stdout,
    stderr: String(result.stderr ?? "").slice(0, captureLimit),
    duration_ms: Date.now() - startedAt,
    timed_out: result.error && "code" in result.error && result.error.code === "ETIMEDOUT",
    error: result.error?.message,
    value,
    parse_failed: parseFailed,
    input,
  };
  const telemetry = redactTelemetry(payload) as Record<string, unknown>;
  emit("dag:deterministic_command", { runId: run.runId, nodeId: node.node_id, ...telemetry });
  return { port: payload.ok ? config?.success_port || "passed" : config?.failure_port || "failed", payload };
}

function _stateInputValue(run: ActiveRun, node: DAGGraphNode): unknown {
  const input = _firstInputValue(_nodeInputs(run.dagRun, node.node_id));
  return _fieldValue(input, node.gateway_config?.value_field);
}

function _stateGatewayResult(run: ActiveRun, node: DAGGraphNode): { port: string; payload: Record<string, unknown> } {
  const config = node.gateway_config;
  const namespace = config?.namespace || "default";
  const stateInput = _firstInputValue(_nodeInputs(run.dagRun, node.node_id));
  const dynamicKey = config?.key_field ? _fieldValue(stateInput, config.key_field) : undefined;
  const key = typeof dynamicKey === "string" && dynamicKey ? dynamicKey : config?.key || node.node_id;
  const operation = config?.operation || "get";
  const current = getDagState(namespace, key);
  if (operation === "get") {
    return { port: config?.success_port || "done", payload: { updated: false, record: current ?? null } };
  }
  let value = config?.value_field ? _stateInputValue(run, node) : config?.value;
  if (operation === "increment") {
    const amount = typeof value === "number" ? value : 1;
    const updated = mutateDagState({ namespace, key, runId: run.runId, nodeId: node.node_id }, (record) =>
      (typeof record?.value === "number" ? record.value : 0) + amount);
    emit("dag:state_updated", { runId: run.runId, nodeId: node.node_id, namespace, key, operation, updated: true, version: updated.record.version });
    return {
      port: config?.success_port || "done",
      payload: { updated: true, operation, record: updated.record, previous: updated.previous ?? null },
    };
  }
  if (operation === "trust_update") {
    const input = _firstInputValue(_nodeInputs(run.dagRun, node.node_id));
    const selected = _fieldValue(input, config?.pass_field);
    const passed = selected === true || ["pass", "passed", "success"].includes(String(selected).toLowerCase());
    const autoMinRuns = config?.auto_min_runs ?? 20;
    const autoMinRate = config?.auto_min_rate ?? 0.95;
    const watchMinRate = config?.watch_min_rate ?? 0.9;
    const updated = mutateDagState({ namespace, key, runId: run.runId, nodeId: node.node_id }, (record) => {
      const existing = record?.value && typeof record.value === "object" && !Array.isArray(record.value)
        ? record.value as Record<string, unknown>
        : {};
      const runs = Number(existing.runs ?? 0) + 1;
      const passes = Number(existing.passes ?? 0) + (passed ? 1 : 0);
      const rate = passes / runs;
      const tier = runs >= autoMinRuns && rate >= autoMinRate
        ? "auto"
        : runs < 10 || rate < watchMinRate
          ? "watch"
          : "queue";
      return { runs, passes, rate, tier, last_result: passed ? "pass" : "fail" };
    });
    emit("dag:state_updated", { runId: run.runId, nodeId: node.node_id, namespace, key, operation, updated: true, version: updated.record.version });
    return {
      port: config?.success_port || "done",
      payload: { updated: true, operation, record: updated.record, previous: updated.previous ?? null },
    };
  }
  if (operation === "budget_admit") {
    const requested = typeof value === "number" ? value : Number.NaN;
    const limit = config?.budget_limit ?? 0;
    const reservation = reserveDagBudget({
      namespace,
      key,
      amount: requested,
      limit,
      usageField: config?.usage_field,
      runId: run.runId,
      nodeId: node.node_id,
    });
    if (reservation.admitted && reservation.record) {
      emit("dag:state_updated", {
        runId: run.runId,
        nodeId: node.node_id,
        namespace,
        key,
        operation,
        updated: true,
        version: reservation.record.version,
      });
    }
    return {
      port: reservation.admitted ? config?.success_port || "admitted" : config?.conflict_port || "blocked",
      payload: { ...reservation, limit, record: reservation.record ?? null, input: stateInput },
    };
  }
  const expectedVersion = operation === "compare_and_set" ? config?.expected_version : undefined;
  const updated = updateDagState({
    namespace,
    key,
    value,
    expectedVersion,
    runId: run.runId,
    nodeId: node.node_id,
  });
  const port = updated.updated ? config?.success_port || "done" : config?.conflict_port || "conflict";
  emit("dag:state_updated", { runId: run.runId, nodeId: node.node_id, namespace, key, operation, updated: updated.updated, version: updated.record.version });
  return { port, payload: { updated: updated.updated, operation, record: updated.record, previous: current ?? null } };
}

function _startApproval(run: ActiveRun, node: DAGGraphNode): DagApprovalRecord {
  const config = node.gateway_config;
  const input = _firstInputValue(_nodeInputs(run.dagRun, node.node_id));
  const proposal = config?.proposal_field ? _fieldValue(input, config.proposal_field) : input;
  const approval = createPendingApproval({
    runId: run.runId,
    nodeId: node.node_id,
    approvalId: config?.approval_id || node.node_id,
    proposal,
    proposerActor: config?.proposer_actor || node.node_id,
    authorizedActors: config?.authorized_actors ?? [],
    expiresAfterMs: config?.expires_after_ms,
  });
  run.dagRun.nodeStates.set(node.node_id, "WAITING_FOR_APPROVAL");
  writeRunMetadata(run.runId, serializeRunMetadata(run));
  emit("dag:approval_requested", {
    runId: run.runId,
    nodeId: node.node_id,
    approvalId: approval.approval_id,
    proposalHash: approval.proposal_hash,
    expiresAt: approval.expires_at,
  });
  return approval;
}

interface FanoutRuntimeState {
  items: unknown[];
  context?: unknown;
  next_index: number;
  active: string[];
  results: Array<{ index: number; node_id: string; port: string; content: unknown; success: boolean }>;
}

function _fanoutState(node: DAGGraphNode): FanoutRuntimeState | undefined {
  const raw = node.extra?.fanout_runtime;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as unknown as FanoutRuntimeState;
}

function _spawnFanoutChildren(run: ActiveRun, node: DAGGraphNode, state: FanoutRuntimeState): void {
  const config = node.gateway_config;
  const maxParallelism = Math.max(1, Math.floor(config?.max_parallelism ?? 1));
  while (state.active.length < maxParallelism && state.next_index < state.items.length) {
    const index = state.next_index++;
    const childId = `${node.node_id}__item_${String(index + 1).padStart(4, "0")}`;
    const child: DAGGraphNode = {
      node_id: childId,
      name: `${node.name} item ${index + 1}`,
      description: `Dynamic fan-out child ${index + 1} of ${state.items.length}`,
      node_type: "agent",
      agent: config?.worker_agent || "",
      after: [],
      outputs: {
        result: { to: "" },
        failed: { to: "", condition: "on_failure" },
      },
      extra: {
        dynamic_fanout: { parent_node: node.node_id, index },
        ...(config?.result_contract ? {
          workflow_spec_v1: {
            input_contracts: {},
            output_contracts: { result: config.result_contract },
          },
        } : {}),
      },
    };
    const appended = appendRunNode(run.runId, { node: child });
    if (!appended) throw new Error(`failed to append fanout child ${childId}`);
    run.dagRun.mailboxes.get(childId)?.set("item", [{
      item: state.items[index],
      index,
      total: state.items.length,
      ...(state.context === undefined ? {} : { context: state.context }),
    }]);
    state.active.push(childId);
  }
  writeRunMetadata(run.runId, serializeRunMetadata(run));
}

function _startFanout(run: ActiveRun, node: DAGGraphNode): boolean {
  const config = node.gateway_config;
  const inputs = _nodeInputs(run.dagRun, node.node_id);
  const raw = inputs[config?.input || "items"]?.at(-1) ?? _firstInputValue(inputs);
  const selected = _fieldValue(raw, config?.item_field);
  const context = config?.context_field ? _fieldValue(raw, config.context_field) : undefined;
  const items = Array.isArray(selected) ? selected : Array.isArray(_structuredGatewayValue(raw)) ? _structuredGatewayValue(raw) as unknown[] : [];
  const maxItems = Math.max(1, Math.floor(config?.max_items ?? 1));
  if (items.length > maxItems) {
    abortActiveRun(run.runId, `fanout max_items (${maxItems}) exceeded`, node.node_id);
    return false;
  }
  if (items.length === 0) {
    return Boolean(handoffActiveRun(run.runId, node.node_id, config?.result_port || "done", {
      total: 0,
      successes: 0,
      failures: 0,
      results: [],
      completed: true,
      ...(context === undefined ? {} : { context }),
    }));
  }
  const state: FanoutRuntimeState = { items, context, next_index: 0, active: [], results: [] };
  node.extra = { ...(node.extra ?? {}), fanout_runtime: state as unknown as Record<string, unknown> };
  run.dagRun.nodeStates.set(node.node_id, "RUNNING");
  _spawnFanoutChildren(run, node, state);
  emit("dag:fanout_started", { runId: run.runId, nodeId: node.node_id, total: items.length, maxParallelism: config?.max_parallelism ?? 1 });
  return true;
}

function _interruptDynamicNode(run: ActiveRun, nodeId: string): void {
  const state = run.dagRun.nodeStates.get(nodeId);
  if (state === "COMPLETED" || state === "FAILED" || state === "CANCELLED" || state === "SKIPPED") return;
  run.dagRun.nodeStates.set(nodeId, "CANCELLED");
  const target = findDispatchTarget(run.runId, nodeId);
  const registry = target?.targetType === "worker"
    ? getWorker(target.targetId ?? "")
    : target?.targetType === "node"
      ? getNode(target.targetId ?? "")
      : undefined;
  if (registry?.socket.readyState === WebSocket.OPEN) {
    registry.socket.send(JSON.stringify({ type: "inject", data: { runId: run.runId, nodeId, mode: "interrupt", instruction: "fanout decision reached" } }));
  }
}

function _recordFanoutChild(run: ActiveRun, child: DAGGraphNode, port: string, content: unknown): void {
  const dynamic = child.extra?.dynamic_fanout;
  if (!dynamic || typeof dynamic !== "object" || Array.isArray(dynamic)) return;
  const info = dynamic as Record<string, unknown>;
  const parentId = typeof info.parent_node === "string" ? info.parent_node : "";
  const index = typeof info.index === "number" ? info.index : -1;
  const parent = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === parentId);
  const state = parent ? _fanoutState(parent) : undefined;
  if (!parent || !state || index < 0 || state.results.some((result) => result.node_id === child.node_id)) return;
  state.active = state.active.filter((id) => id !== child.node_id);
  const config = parent.gateway_config;
  const selected = _fieldValue(content, config?.success_field);
  const successValues = config?.success_values ?? [true, "pass", "passed", "success", "approved", "yes", "act"];
  const success = port !== "failed" && (!config?.success_field || successValues.some((value) => value === selected));
  state.results.push({ index, node_id: child.node_id, port, content, success });
  state.results.sort((left, right) => left.index - right.index);
  const successes = state.results.filter((result) => result.success).length;
  const completed = state.results.length;
  const total = state.items.length;
  const completion = config?.completion ?? "all";
  const threshold = completion === "any" ? 1 : completion === "n_of_m" ? Math.max(1, config?.threshold ?? 1) : total;
  const passed = successes >= threshold;
  const impossible = successes + (total - completed) < threshold;
  const finished = completion === "all" ? completed === total : passed || impossible || completed === total;
  if (!finished) {
    _spawnFanoutChildren(run, parent, state);
    return;
  }
  if (config?.cancel_remaining) {
    for (const activeId of state.active) _interruptDynamicNode(run, activeId);
    state.active = [];
  }
  const payload = {
    total,
    completed,
    successes,
    failures: completed - successes,
    threshold,
    passed,
    early_completion: completed < total,
    results: state.results,
    ...(state.context === undefined ? {} : { context: state.context }),
  };
  emit("dag:fanout_completed", { runId: run.runId, nodeId: parentId, ...payload });
  handoffActiveRun(run.runId, parentId, passed ? config?.result_port || "done" : config?.failed_port || "failed", payload);
}

function _executeGatewayNode(runId: string, run: ActiveRun, node: DAGGraphNode): boolean {
  if (node.node_type === "command_gateway") {
    const result = _commandGatewayResult(run, node);
    return Boolean(handoffActiveRun(runId, node.node_id, result.port, result.payload));
  }

  if (node.node_type === "state_gateway") {
    const result = _stateGatewayResult(run, node);
    return Boolean(handoffActiveRun(runId, node.node_id, result.port, result.payload));
  }

  if (node.node_type === "approval_gateway") {
    _startApproval(run, node);
    return true;
  }

  if (node.node_type === "fanout_gateway") return _startFanout(run, node);
  if (node.node_type === "condition_gateway") {
    const inputs = _nodeInputs(run.dagRun, node.node_id);
    const payload = _firstInputValue(inputs);
    const port = _conditionGatewayPort(node.gateway_config, payload);
    const next = handoffActiveRun(runId, node.node_id, port, payload);
    if (!next) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port,
    });
    return true;
  }

  if (node.node_type === "loop_gateway") {
    const inputs = _nodeInputs(run.dagRun, node.node_id);
    const items = _loopGatewayItems(node.gateway_config, inputs);
    const maxItems = Math.max(1, Math.floor(node.gateway_config?.max_items ?? 10_000));
    if (items.length > maxItems) {
      abortActiveRun(runId, `foreach max_items (${maxItems}) exceeded`, node.node_id);
      return false;
    }
    const index = run.counters.gateway_iterations[node.node_id] ?? 0;
    const itemPort = node.gateway_config?.item_port || "next_item";
    const resultPort = node.gateway_config?.result_port || "result";
    const donePort = node.gateway_config?.done_port || "done";
    const results = run.counters.gateway_results[node.node_id] ?? [];
    const resultValues = inputs[resultPort];
    if (index > 0 && resultValues && resultValues.length > 0) {
      results.push(_structuredGatewayValue(resultValues[resultValues.length - 1]));
      run.counters.gateway_results[node.node_id] = results;
    }
    const port = index < items.length ? itemPort : donePort;
    const payload = index < items.length
      ? { item: items[index], index, total: items.length, completed_results: [...results] }
      : { total: items.length, completed: true, results: [...results] };
    if (index < items.length) {
      run.counters.gateway_iterations[node.node_id] = index + 1;
    } else {
      _terminateLoopSource(run, node.node_id);
    }
    const next = handoffActiveRun(runId, node.node_id, port, payload);
    if (!next) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port,
    });
    return true;
  }

  if (node.node_type === "join_gateway") {
    const result = _joinGatewayResult(node.gateway_config, _nodeInputs(run.dagRun, node.node_id));
    const next = handoffActiveRun(runId, node.node_id, result.port, result.payload);
    if (!next) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port: result.port,
    });
    return true;
  }

  if (node.node_type === "while_gateway") {
    const inputs = _nodeInputs(run.dagRun, node.node_id);
    const result = _whileGatewayResult(run, node, _firstInputValue(inputs));
    const next = handoffActiveRun(runId, node.node_id, result.port, result.payload);
    if (!next) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port: result.port,
    });
    return true;
  }

  return false;
}

type DispatchCredentialResolution =
  | { ok: true; agentConfig: DAGAgentConfig }
  | { ok: false; reason: string };

type DispatchEnvelopeBuildResult =
  | { ok: true; envelope: DispatchEnvelope }
  | { ok: false; reason: string };

function _isDisabledDirectLlmAgent(agentConfig: DAGAgentConfig): boolean {
  return isDisabledDirectLlmAgentType(agentConfig.agent_type);
}

function _isDeterministicDagAgent(agentConfig: DAGAgentConfig): boolean {
  return normalizeManagerAgentRuntimeAgentType(agentConfig.agent_type) === "deterministic";
}

function _withDispatchCredentials(agentConfig: DAGAgentConfig): DispatchCredentialResolution {
  if (_isDisabledDirectLlmAgent(agentConfig)) {
    return {
      ok: false,
      reason: "direct-llm is disabled for DAG execution. Configure a supported harness-backed agent_type for this runtime.",
    };
  }
  if (_isDeterministicDagAgent(agentConfig)) {
    return { ok: true, agentConfig: { ...agentConfig, agent_type: "deterministic" } };
  }
  const provider = agentConfig.llm?.provider;
  const model = agentConfig.llm?.model ?? agentConfig.model;
  try {
    const resolved = resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: agentConfig.llm_setting_id,
      providerName: provider,
      modelName: model,
      agentType: agentConfig.agent_type,
    });
    return {
      ok: true,
      agentConfig: {
        ...agentConfig,
        agent_type: resolved.agent_type,
        llm: {
          ...agentConfig.llm,
          provider: resolved.provider_name,
          model: resolved.model,
          api_key: resolved.api_key,
          base_url: resolved.base_url,
          protocol: resolved.protocol,
        },
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function _agentRuntimeConfig(node: DAGGraphNode): Record<string, unknown> {
  const value = node.extra?.agent_runtime;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function _advisorConfigs(run: ActiveRun, node: DAGGraphNode): DispatchCredentialResolution & { advisors?: DagAdvisorConfig[] } {
  const raw = _agentRuntimeConfig(node).advisors;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: true, agentConfig: {}, advisors: [] };
  const advisors: DagAdvisorConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `invalid advisor binding on node ${node.node_id}` };
    }
    const binding = entry as Record<string, unknown>;
    const id = typeof binding.id === "string" ? binding.id : "";
    const agentId = typeof binding.agent === "string" ? binding.agent : "";
    const advisorAgent = run.agents?.[agentId];
    if (!id || !agentId || !advisorAgent) {
      return { ok: false, reason: `advisor binding '${id || "<unknown>"}' references unavailable agent '${agentId}'` };
    }
    const resolved = _withDispatchCredentials(advisorAgent);
    if (!resolved.ok) return resolved;
    const config = resolved.agentConfig;
    advisors.push({
      id,
      agent_id: agentId,
      agent_type: config.agent_type ?? "",
      provider: config.llm?.provider,
      protocol: config.llm?.protocol,
      model: config.llm?.model ?? config.model ?? "",
      api_key: config.llm?.api_key,
      base_url: config.llm?.base_url,
      system_prompt: config.system,
      max_calls: Number(binding.max_calls),
      calls_used: run.counters.advisor_calls[node.node_id]?.[id] ?? 0,
      timeout_ms: Number(binding.timeout_ms),
      max_tokens: Number(binding.max_tokens),
    });
  }
  return { ok: true, agentConfig: {}, advisors };
}

function _workspaceAccess(node: DAGGraphNode): DagWorkspaceAccess | undefined {
  const raw = _agentRuntimeConfig(node).workspace_access;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const writable = Array.isArray(value.writable_paths)
    ? value.writable_paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const readonly = Array.isArray(value.readonly_paths)
    ? value.readonly_paths.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    writable_paths: writable,
    ...(readonly ? { readonly_paths: readonly } : {}),
    ...(typeof value.max_snapshot_files === "number" ? { max_snapshot_files: value.max_snapshot_files } : {}),
  };
}

function _buildDispatchEnvelope(run: ActiveRun, nodeId: string): DispatchEnvelopeBuildResult {
  if (run.status !== "active") return { ok: false, reason: `run ${run.runId} is not active` };
  if (getNodeState(run.dagRun, nodeId) !== "READY") {
    return { ok: false, reason: `node ${nodeId} is not READY` };
  }
  const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
  if (!node) return { ok: false, reason: `unknown node ${nodeId}` };
  if (_isGatewayNode(node)) {
    return { ok: false, reason: `gateway node ${nodeId} is not worker-dispatchable` };
  }

  const agentId = node.agent;
  const agentConfig = run.agents?.[agentId] ?? {};
  const credentials = _withDispatchCredentials(agentConfig);
  if (!credentials.ok) return credentials;
  const advisorResolution = _advisorConfigs(run, node);
  if (!advisorResolution.ok) return advisorResolution;

  const inputs = _nodeInputs(run.dagRun, nodeId);
  const nodeSession = _ensureNodeSession(run, nodeId);
  const dispatchInputs = nodeSession.resumeInstruction
    ? { ...inputs, checkpoint_resume: [nodeSession.resumeInstruction] }
    : inputs;
  const outgoingEdges = run.dagRun.graph.edges.filter(
    (e) => e.from_node === nodeId && e.label !== "after_dep",
  );

  return {
    ok: true,
    envelope: {
      runId: run.runId,
      nodeId,
      sessionId: nodeSession.sessionId,
      agentId,
      agentConfig: credentials.agentConfig,
      inputs: dispatchInputs,
      outgoingEdges,
      checkpointResume: nodeSession.resumeInstruction
        ? {
            parentSessionId: nodeSession.parentSessionId,
            entryUuid: nodeSession.forkedFromEntryUuid,
            instruction: nodeSession.resumeInstruction,
            attempt: nodeSession.attempt,
          }
        : undefined,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workspace: run.workspace,
      image: node.image,
      container_group: node.container_group,
      requiredCapabilities: node.requires?.capabilities,
      advisors: advisorResolution.advisors,
      workspaceAccess: _workspaceAccess(node),
    },
  };
}

export function buildCurrentDispatchEnvelope(
  runId: string,
  nodeId: string,
): DispatchEnvelopeBuildResult {
  const run = store.get(runId);
  if (!run) return { ok: false, reason: `unknown run ${runId}` };
  return _buildDispatchEnvelope(run, nodeId);
}

export function dispatchReadyNodes(
  runId: string,
  dispatcher: DAGDispatcher,
): number {
  const run = store.get(runId);
  if (!run) return 0;

  let count = 0;
  const before = _snapshotNodeStates(run);
  const ready = getReadyNodes(run.dagRun);
  for (const nodeId of ready) {
    const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
    if (!node) continue;
    if (_isGatewayNode(node)) {
      if (_executeGatewayNode(runId, run, node)) count++;
      continue;
    }

    const built = _buildDispatchEnvelope(run, nodeId);
    if (!built.ok) {
      failActiveRun(runId, nodeId, built.reason);
      continue;
    }
    if (run.counters.dispatches >= run.limits.max_dispatches) {
      abortActiveRun(runId, `max_dispatches (${run.limits.max_dispatches}) exceeded`, nodeId);
      break;
    }
    run.counters.dispatches++;

    const envelope = built.envelope;

    let result = dispatcher.dispatch(envelope);
    if (result.status === "failed") {
      const retryable = result.retryable !== false;
      if (retryable && recordNodeDispatchRetry(runId, nodeId, result.reason)) {
        if (run.counters.dispatches >= run.limits.max_dispatches) {
          abortActiveRun(runId, `max_dispatches (${run.limits.max_dispatches}) exceeded`, nodeId);
          break;
        }
        run.counters.dispatches++;
        result = dispatcher.dispatch({
          ...envelope,
          inputs: {
            ...envelope.inputs,
            dispatch_retry: [
              `Retrying DAG node ${nodeId} after transient dispatch failure: ${result.reason}`,
            ],
          },
        });
      }
      if (result.status === "failed") {
        failActiveRun(runId, nodeId, result.reason);
        continue;
      }
    }
    if (result.status !== "dispatched") continue;
    startNode(run.dagRun, nodeId);
    _markNodeSessionStatus(run, nodeId, "running");
    emit("dag:node_dispatched", { runId, nodeId, agentId: envelope.agentId, sessionId: envelope.sessionId });
    count++;
  }
  if (count > 0) {
    writeRunMetadata(runId, serializeRunMetadata(run));
    _emitNodeStateChanges(run, before);
  }
  return count;
}

export function markNodeDispatched(
  runId: string,
  nodeId: string,
): boolean {
  const run = store.get(runId);
  if (!run || run.status !== "active") return false;

  if (getNodeState(run.dagRun, nodeId) !== "READY") return false;
  const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
  if (!node) return false;

  const before = _snapshotNodeStates(run);
  startNode(run.dagRun, nodeId);
  const nodeSession = _ensureNodeSession(run, nodeId);
  _markNodeSessionStatus(run, nodeId, "running");
  emit("dag:node_dispatched", { runId, nodeId, agentId: node.agent, sessionId: nodeSession.sessionId });
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  return true;
}

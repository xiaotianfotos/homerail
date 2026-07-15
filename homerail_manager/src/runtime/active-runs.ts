import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getHomerailHome } from "../config/env.js";
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
  resetNodesForRound,
  resetSkippedSuccessDescendants,
  startNode,
} from "../orchestration/dag-engine.js";
import type { DAGAgentConfig, DAGArtifactDeclaration, DAGEdge, DAGGatewayConfig, DAGGraphNode, DAGOutputRoute, DAGPatternInstanceMeta, ParsedDAG, ScorecardPolicyConfig } from "../orchestration/graph.js";
import { _normalizeOutputsToEdges } from "../orchestration/yaml-loader.js";
import { assertGraphValid } from "../orchestration/graph-validator.js";
import { findDispatchTarget } from "../orchestration/dispatch-tracker.js";
import { deprovisionProvisionedForRun } from "../orchestration/provisioned-cleanup.js";
import { getWorker } from "../worker/registry.js";
import { getNode } from "../node/registry.js";
import {
  AGENT_BUILTIN_TOOL_NAMES,
  DAG_AGENT_TOOL_NAMES,
  DAG_TRANSPORT_FENCE_CAPABILITY,
  isDisabledDirectLlmAgentType,
  normalizeManagerAgentRuntimeAgentType,
  redactTelemetry,
  type AgentBuiltinToolName,
  type DagAdvisorConfig,
  type DagAgentToolName,
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
import { dbTransaction } from "../persistence/db.js";
import type { DagRunStatus } from "../persistence/status.js";
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
import { getDagActivitySequenceCursor } from "../persistence/dag-activity-journal.js";
import { getDb } from "../persistence/db.js";
import {
  createInitialDagRunRound,
  getCurrentDagRunRound,
  listDagRunRounds,
  openNextDagRunRound,
  terminalizeCurrentDagRunRound,
  transitionDagRunRoundToWaiting,
} from "../persistence/dag-run-rounds.js";
import {
  acknowledgeDagActorCommand,
  advanceDagActorGeneration,
  cancelUnclaimedDagActorCommands,
  claimDagActorCommand,
  createDagActorCommand,
  DagActorConflictError,
  getDagActorCommand,
  getDagActorByNode,
  listDagActors,
  listDagActorCommands,
  markDagActorCommandDelivered,
  registerDagActor,
  updateDagActorBinding,
  type DagActorRecord,
} from "../persistence/dag-actors.js";
import {
  acquireDagActorLease,
  ensureDagActorLease,
  getDagActorLease,
  getLatestDagActorCheckpoint,
  retireDagActorLease,
  writeDagActorCheckpoint,
} from "../persistence/dag-actor-leases.js";
import { buildRunActorCheckpoints } from "./dag-actor-checkpoint-builder.js";

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
  artifacts?: DAGArtifactDeclaration[];
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
  status: DagRunStatus;
  currentRound: ActiveRunRound;
  completedAt?: number;
  limits: DAGRunLimits;
  counters: DAGRunCounters;
  nodeIndex: Map<string, number>;
  nodeSessions: Map<string, NodeSessionState>;
}

export interface ActiveRunRound {
  round_id: string;
  ordinal: number;
  status: "active" | "waiting" | "completed" | "cancelled" | "failed";
  target_actor_ids: string[];
  await_node_id?: string;
  opened_at: number;
  closed_at?: number;
  expires_at?: number;
}

export interface HandoffTransportFence {
  transport?: boolean;
  roundId?: string;
  actorId?: string;
  generation?: number;
  leaseGeneration?: number;
  commandId?: string;
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

export interface WaitingRunCommandInput {
  actor_id: string;
  payload: unknown;
  command_id?: string;
  idempotency_key?: string;
}

export interface ResumeWaitingRunRequest {
  expected_round_id: string;
  commands: WaitingRunCommandInput[];
}

export interface ResumeWaitingRunResult {
  runId: string;
  previousRoundId: string;
  roundId: string;
  ordinal: number;
  actorIds: string[];
  nodeIds: string[];
  commandIds: string[];
  readyNodeIds: string[];
  deduplicated?: boolean;
}

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
  "WAITING_FOR_COMMAND",
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

function _runtimeString(node: DAGGraphNode, key: string): string | undefined {
  const value = _agentRuntimeConfig(node)[key] ?? node.extra?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _logicalActorId(node: DAGGraphNode): string {
  return _runtimeString(node, "actor_id") ?? node.node_id;
}

function _logicalActorRole(node: DAGGraphNode): string {
  return _runtimeString(node, "role") ?? node.agent ?? node.name ?? node.node_id;
}

function _logicalActorSurface(node: DAGGraphNode, actorId: string): string {
  const configured = _activitySurfaceId(node);
  if (configured) return configured;
  const candidate = `actor:${actorId}`;
  return candidate.length <= 256
    ? candidate
    : `actor:${createHash("sha256").update(actorId).digest("hex")}`;
}

function _logicalActorModelProfile(run: ActiveRun, node: DAGGraphNode): Record<string, unknown> {
  const agent = run.agents?.[node.agent] ?? {};
  const model = agent.llm?.model ?? agent.model;
  return {
    agent_id: node.agent,
    ...(agent.agent_type ? { agent_type: agent.agent_type } : {}),
    ...(agent.llm_setting_id ? { llm_setting_id: agent.llm_setting_id } : {}),
    ...(agent.llm?.provider ? { provider: agent.llm.provider } : {}),
    ...(model ? { model } : {}),
    ...(agent.llm?.protocol ? { protocol: agent.llm.protocol } : {}),
  };
}

function _assertLogicalActorIdentities(nodes: readonly DAGGraphNode[]): void {
  const actorOwners = new Map<string, string>();
  const surfaceOwners = new Map<string, string>();
  for (const node of nodes) {
    if (_isGatewayNode(node)) continue;
    const actorId = _logicalActorId(node);
    const actorOwner = actorOwners.get(actorId);
    if (actorOwner) {
      throw new DagActorConflictError(
        "actor_identity_conflict",
        `DAG actor ${actorId} is configured for both nodes ${actorOwner} and ${node.node_id}`,
      );
    }
    actorOwners.set(actorId, node.node_id);

    const surfaceId = _logicalActorSurface(node, actorId);
    const surfaceOwner = surfaceOwners.get(surfaceId);
    if (surfaceOwner) {
      throw new DagActorConflictError(
        "actor_identity_conflict",
        `DAG surface ${surfaceId} is configured for both nodes ${surfaceOwner} and ${node.node_id}`,
      );
    }
    surfaceOwners.set(surfaceId, node.node_id);
  }
}

function _ensureLogicalActor(run: ActiveRun, node: DAGGraphNode): DagActorRecord {
  const existing = getDagActorByNode(run.runId, node.node_id);
  if (existing) return existing;
  const actorId = _logicalActorId(node);
  return registerDagActor({
    run_id: run.runId,
    actor_id: actorId,
    node_id: node.node_id,
    role: _logicalActorRole(node),
    model_profile: _logicalActorModelProfile(run, node),
    surface_id: _logicalActorSurface(node, actorId),
    workspace_ref: _projectKey(run),
  }).actor;
}

function _registerLogicalActors(run: ActiveRun): void {
  _assertLogicalActorIdentities(run.dagRun.graph.nodes);
  for (const node of run.dagRun.graph.nodes) {
    if (!_isGatewayNode(node)) _ensureLogicalActor(run, node);
  }
}

function _bindLogicalActorSession(
  run: ActiveRun,
  nodeId: string,
  sessionId: string,
  attempt: number,
): DagActorRecord | undefined {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node || _isGatewayNode(node)) return undefined;
  let actor = _ensureLogicalActor(run, node);
  if (actor.session_id === sessionId && actor.attempt === attempt) return actor;
  try {
    return updateDagActorBinding({
      run_id: run.runId,
      actor_id: actor.actor_id,
      expected_version: actor.version,
      session_id: sessionId,
      attempt,
    });
  } catch (error) {
    if (!(error instanceof DagActorConflictError) || error.code !== "actor_version_conflict") throw error;
    actor = getDagActorByNode(run.runId, nodeId) ?? _ensureLogicalActor(run, node);
    if (actor.session_id === sessionId && actor.attempt === attempt) return actor;
    return updateDagActorBinding({
      run_id: run.runId,
      actor_id: actor.actor_id,
      expected_version: actor.version,
      session_id: sessionId,
      attempt,
    });
  }
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
  _bindLogicalActorSession(run, nodeId, persisted.sessionId, persisted.attempt);
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

interface MutableRunSnapshot {
  dagRun: DAGRun;
  status: DagRunStatus;
  currentRound: ActiveRunRound;
  completedAt?: number;
  counters: DAGRunCounters;
  nodeSessions: Map<string, NodeSessionState>;
}

function _snapshotMutableRun(run: ActiveRun): MutableRunSnapshot {
  return {
    dagRun: structuredClone(run.dagRun),
    status: run.status,
    currentRound: structuredClone(run.currentRound),
    completedAt: run.completedAt,
    counters: structuredClone(run.counters),
    nodeSessions: structuredClone(run.nodeSessions),
  };
}

function _restoreMutableRun(run: ActiveRun, snapshot: MutableRunSnapshot): void {
  run.dagRun = snapshot.dagRun;
  run.status = snapshot.status;
  run.currentRound = snapshot.currentRound;
  run.completedAt = snapshot.completedAt;
  run.counters = snapshot.counters;
  run.nodeSessions = snapshot.nodeSessions;
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

function _roundId(ordinal: number): string {
  return `round-${String(ordinal).padStart(4, "0")}`;
}

function _initialRound(parsedDAG: ParsedDAG, openedAt: number): ActiveRunRound {
  return {
    round_id: _roundId(1),
    ordinal: 1,
    status: "active",
    target_actor_ids: parsedDAG.graph.nodes
      .filter((node) => !_isGatewayNode(node))
      .map(_logicalActorId)
      .sort(),
    opened_at: openedAt,
  };
}

export function createActiveRun(
  runId: string,
  parsedDAG: ParsedDAG,
  options: CreateActiveRunOptions = {},
): ActiveRun {
  const dagRun = createDAGRun(parsedDAG, runId);
  const createdAt = Date.now();
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
    artifacts: parsedDAG.meta.artifacts
      ? structuredClone(parsedDAG.meta.artifacts)
      : undefined,
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
    createdAt,
    status: "active",
    currentRound: _initialRound(parsedDAG, createdAt),
    limits: _resolveLimits(parsedDAG.meta.limits),
    counters: _initialCounters(),
    nodeIndex: _buildNodeIndex(parsedDAG.graph.nodes),
    nodeSessions: new Map(),
  };
  _assertLogicalActorIdentities(run.dagRun.graph.nodes);
  dbTransaction(() => {
    writeRunMetadata(runId, serializeRunMetadata(run));
    createInitialDagRunRound({
      run_id: runId,
      round_id: run.currentRound.round_id,
      target_actor_ids: run.currentRound.target_actor_ids,
      opened_at: run.currentRound.opened_at,
    });
    _registerLogicalActors(run);
  });
  store.set(runId, run);
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

  const runtimeState = metadata.dagRuntimeState;
  if (runtimeState) {
    dagRun.loopSources = new Set(runtimeState.loop_sources);
    for (const node of nodes) {
      dagRun.afterSatisfied.set(node.node_id, new Set(runtimeState.after_satisfied[node.node_id] ?? []));
      dagRun.inputSatisfied.set(node.node_id, new Set(runtimeState.input_satisfied[node.node_id] ?? []));
      dagRun.mailboxes.set(node.node_id, new Map(
        Object.entries(runtimeState.mailboxes[node.node_id] ?? {}).map(([port, values]) => [port, structuredClone(values)]),
      ));
    }
  } else {
    const snapshot = loadRunSnapshot(metadata.runId);
    if (snapshot && snapshot.handoffs.length > 0) {
      _replayHandoffsInto(dagRun, snapshot.handoffs);
    }
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

  _skipPendingNodesWhenFailureStalls(run);

  const hasFailedNodes = Array.from(run.dagRun.nodeStates.values()).some((state) => state === "FAILED");

  // If demoting orphaned nodes made the run terminal, mark it failed.
  if (hasFailedNodes && isRunTerminal(run.dagRun)) {
    run.status = "failed";
    run.completedAt = Date.now();
    _persistTerminalRun(run, "failed");
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

function _skipPendingNodesWhenFailureStalls(run: ActiveRun): string[] {
  const states = Array.from(run.dagRun.nodeStates.values());
  if (!states.some((state) => state === "FAILED")) return [];
  if (states.some((state) =>
    state === "READY" || state === "RUNNING" || state === "WAITING_FOR_APPROVAL" || state === "WAITING_FOR_COMMAND"
  )) return [];

  const skipped: string[] = [];
  for (const [nodeId, state] of run.dagRun.nodeStates.entries()) {
    if (state !== "PENDING") continue;
    run.dagRun.nodeStates.set(nodeId, "SKIPPED");
    _markNodeSessionStatus(run, nodeId, "cancelled");
    skipped.push(nodeId);
  }
  return skipped.sort();
}

export type RestoreActiveRunResult =
  | { status: "restored"; run: ActiveRun; demotedFromRunning: string[] }
  | { status: "skipped"; reason: string };

/** Reconstruct a single nonterminal run from persisted metadata. */
export function restoreActiveRun(
  metadata: PersistedRunMetadata,
): RestoreActiveRunResult {
  if (metadata.status !== "active" && metadata.status !== "waiting") {
    return { status: "skipped", reason: `run is ${metadata.status}` };
  }
  if (!metadata.graph) {
    return { status: "skipped", reason: "missing persisted graph" };
  }
  if (store.has(metadata.runId)) {
    return { status: "skipped", reason: "run already active in this process" };
  }

  const { dagRun, nodes } = _rebuildDagRunFromPersisted(metadata, metadata.graph);
  if (!metadata.dagRuntimeState) {
    seedInitialPrompt(dagRun, metadata.initialPrompt, metadata.runInputTargets, metadata.contracts);
  }
  const persistedRound = getCurrentDagRunRound(metadata.runId);
  const currentRound = persistedRound ? {
    round_id: persistedRound.round_id,
    ordinal: persistedRound.ordinal,
    status: persistedRound.status,
    target_actor_ids: persistedRound.target_actor_ids,
    ...(persistedRound.await_node_id ? { await_node_id: persistedRound.await_node_id } : {}),
    opened_at: persistedRound.opened_at,
    ...(persistedRound.closed_at === undefined ? {} : { closed_at: persistedRound.closed_at }),
    ...(persistedRound.expires_at === undefined ? {} : { expires_at: persistedRound.expires_at }),
  } : metadata.currentRound ?? {
    round_id: _roundId(1),
    ordinal: 1,
    status: metadata.status,
    target_actor_ids: nodes.filter((node) => !_isGatewayNode(node)).map(_logicalActorId).sort(),
    opened_at: metadata.createdAt,
  };
  if (!persistedRound) {
    createInitialDagRunRound({
      run_id: metadata.runId,
      round_id: currentRound.round_id,
      target_actor_ids: currentRound.target_actor_ids,
      opened_at: currentRound.opened_at,
      status: currentRound.status,
      await_node_id: currentRound.await_node_id,
      closed_at: currentRound.closed_at,
      expires_at: currentRound.expires_at,
    });
  }
  const run: ActiveRun = {
    runId: metadata.runId,
    workflowId: metadata.workflowId,
    workflowName: metadata.workflowName,
    workflowRevision: metadata.workflowRevision,
    canonicalHash: metadata.canonicalHash,
    compilerVersion: metadata.compilerVersion,
    sourceApiVersion: metadata.sourceApiVersion,
    contracts: metadata.contracts ? { ...metadata.contracts } : undefined,
    artifacts: metadata.artifacts ? structuredClone(metadata.artifacts) : undefined,
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
    status: metadata.status,
    currentRound,
    limits: metadata.limits ?? { ...DEFAULT_LIMITS },
    counters: _restoreCounters(metadata.counters),
    nodeIndex: _buildNodeIndex(nodes),
    nodeSessions: new Map(),
  };

  _registerLogicalActors(run);
  // Restore per-node sessions from dag_session_index.
  for (const entry of listDagSessionIndex(metadata.runId)) {
    const state = _entryToNodeSession(entry);
    run.nodeSessions.set(entry.node_id, state);
    _bindLogicalActorSession(run, entry.node_id, state.sessionId, state.attempt);
  }

  store.set(metadata.runId, run);

  const demotedFromRunning = run.status === "active" ? _applyOrphanedNodeDemotion(run) : [];
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

function _deduplicatedResumeResult(
  run: ActiveRun,
  request: ResumeWaitingRunRequest,
  expectedRoundId: string,
): ResumeWaitingRunResult | undefined {
  if ((run.status !== "active" && run.status !== "waiting") || run.currentRound.ordinal <= 1) return undefined;
  const previous = listDagRunRounds(run.runId).find(
    (round) => round.round_id === expectedRoundId && round.ordinal === run.currentRound.ordinal - 1,
  );
  if (!previous || previous.status !== "completed") return undefined;
  const commands = listDagActorCommands({
    run_id: run.runId,
    round_id: run.currentRound.round_id,
    // Fetch one extra row so a strict subset cannot masquerade as a retry of
    // the complete command set accepted for this round.
    limit: request.commands.length + 1,
  });
  if (commands.length !== request.commands.length) return undefined;
  const actorsById = new Map(listDagActors(run.runId).map((actor) => [actor.actor_id, actor]));
  const commandsByActor = new Map(commands.map((command) => [command.actor_id, command]));
  if (commandsByActor.size !== commands.length) return undefined;
  const matched = request.commands.map((requested) => {
    const actorId = requested.actor_id.trim();
    const command = commandsByActor.get(actorId);
    if (!command) return undefined;
    const expectedKey = requested.idempotency_key?.trim() || `${run.currentRound.round_id}:${actorId}`;
    if (requested.command_id?.trim() && requested.command_id.trim() !== command.command_id) return undefined;
    if (expectedKey !== command.idempotency_key || !isDeepStrictEqual(requested.payload, command.payload)) return undefined;
    return { command, actor: actorsById.get(actorId) };
  });
  if (matched.some((entry) => !entry?.actor)) return undefined;
  const entries = matched as Array<{
    command: NonNullable<ReturnType<typeof getDagActorCommand>>;
    actor: DagActorRecord;
  }>;
  return {
    runId: run.runId,
    previousRoundId: expectedRoundId,
    roundId: run.currentRound.round_id,
    ordinal: run.currentRound.ordinal,
    actorIds: entries.map((entry) => entry.actor.actor_id),
    nodeIds: entries.map((entry) => entry.actor.node_id),
    commandIds: entries.map((entry) => entry.command.command_id),
    readyNodeIds: entries
      .map((entry) => entry.actor.node_id)
      .filter((nodeId) => run.dagRun.nodeStates.get(nodeId) === "READY"),
    deduplicated: true,
  };
}

function _validateResumeRequest(request: ResumeWaitingRunRequest): void {
  if (!Array.isArray(request.commands) || request.commands.length < 1 || request.commands.length > 128) {
    throw new Error("commands must contain between 1 and 128 entries");
  }
  const actorIds = request.commands.map((command) => {
    if (!command || typeof command.actor_id !== "string") throw new Error("actor_id is required");
    const actorId = command.actor_id.trim();
    if (!actorId) throw new Error("actor_id is required");
    return actorId;
  });
  if (new Set(actorIds).size !== actorIds.length) {
    throw new Error("Each actor may receive at most one command per round");
  }
}

export function deduplicateWaitingActiveRunResume(
  runId: string,
  request: ResumeWaitingRunRequest,
): ResumeWaitingRunResult | undefined {
  _validateResumeRequest(request);
  const run = store.get(runId);
  if (!run) return undefined;
  const expectedRoundId = request.expected_round_id.trim();
  if (!expectedRoundId) throw new Error("expected_round_id is required");
  return _deduplicatedResumeResult(run, request, expectedRoundId);
}

export function resumeWaitingActiveRun(
  runId: string,
  request: ResumeWaitingRunRequest,
): ResumeWaitingRunResult {
  const run = store.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  _validateResumeRequest(request);
  const expectedRoundId = request.expected_round_id.trim();
  if (!expectedRoundId) throw new Error("expected_round_id is required");
  const deduplicated = _deduplicatedResumeResult(run, request, expectedRoundId);
  if (deduplicated) return deduplicated;
  if (run.status !== "waiting" || run.currentRound.status !== "waiting") {
    throw new Error(`Run ${runId} is not waiting`);
  }
  if (expectedRoundId !== run.currentRound.round_id) {
    throw new Error(`Waiting round conflict: current round is ${run.currentRound.round_id}`);
  }
  const persistedRound = getCurrentDagRunRound(runId);
  if (!persistedRound || persistedRound.round_id !== expectedRoundId || persistedRound.status !== "waiting") {
    throw new Error(`Persisted waiting round conflict for ${runId}/${expectedRoundId}`);
  }
  const awaitNodeId = run.currentRound.await_node_id;
  const awaitNode = awaitNodeId
    ? run.dagRun.graph.nodes.find((node) => node.node_id === awaitNodeId)
    : undefined;
  if (!awaitNode || awaitNode.node_type !== "await_command_gateway") {
    throw new Error(`Run ${runId} has no active await_command node`);
  }

  const actorsById = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
  const requestedActorIds = request.commands.map((command) => command.actor_id.trim());
  const actors = requestedActorIds.map((actorId) => {
    const actor = actorsById.get(actorId);
    if (!actor) throw new Error(`Unknown DAG actor: ${runId}/${actorId}`);
    return actor;
  });
  const configuredTargets = awaitNode.gateway_config?.target_actors;
  if (configuredTargets && configuredTargets.length > 0) {
    const allowed = new Set(configuredTargets);
    for (const actor of actors) {
      if (!allowed.has(actor.actor_id) && !allowed.has(actor.node_id)) {
        throw new Error(`Actor ${actor.actor_id} is not allowed by await_command ${awaitNode.node_id}`);
      }
    }
  }

  const selectedNodeIds = new Set(actors.map((actor) => actor.node_id));
  const resetNodeIds = _roundResetNodeIds(run, selectedNodeIds, awaitNode.node_id);
  const nextOrdinal = run.currentRound.ordinal + 1;
  const nextRoundId = _roundId(nextOrdinal);
  const openedAt = Date.now();
  const commandPort = awaitNode.gateway_config?.command_port || "command";
  const commandRows = request.commands.map((command, index) => {
    const actor = actors[index];
    const commandId = command.command_id?.trim() || `command-${randomUUID()}`;
    const idempotencyKey = command.idempotency_key?.trim() || `${nextRoundId}:${actor.actor_id}`;
    return {
      command_id: commandId,
      run_id: runId,
      actor_id: actor.actor_id,
      round_id: nextRoundId,
      idempotency_key: idempotencyKey,
      target_generation: actor.generation,
      payload: command.payload,
      node_id: actor.node_id,
    };
  });
  const commandInputs = new Map(commandRows.map((command) => [command.node_id, {
    port: commandPort,
    value: {
      command_id: command.command_id,
      round_id: command.round_id,
      actor_id: command.actor_id,
      payload: command.payload,
    },
  }]));

  const previousDagRun = structuredClone(run.dagRun);
  const previousRound = structuredClone(run.currentRound);
  const previousCounters = structuredClone(run.counters);
  const before = _snapshotNodeStates(run);
  const resetNodeSet = new Set(resetNodeIds);
  const reset = resetNodesForRound(run.dagRun, {
    resetNodeIds,
    commandInputs,
    carryoverInputs: _roundCarryoverInputs(run, resetNodeSet),
  });
  run.status = "active";
  run.completedAt = undefined;
  run.currentRound = {
    round_id: nextRoundId,
    ordinal: nextOrdinal,
    status: "active",
    target_actor_ids: requestedActorIds.slice().sort(),
    opened_at: openedAt,
  };
  run.counters = _initialCounters();

  try {
    getDb().transaction(() => {
      openNextDagRunRound({
        run_id: runId,
        expected_round_id: expectedRoundId,
        round_id: nextRoundId,
        target_actor_ids: run.currentRound.target_actor_ids,
        opened_at: openedAt,
      });
      for (const command of commandRows) createDagActorCommand(command);
      writeRunMetadata(runId, serializeRunMetadata(run));
    }).immediate();
  } catch (error) {
    run.dagRun = previousDagRun;
    run.currentRound = previousRound;
    run.counters = previousCounters;
    run.status = "waiting";
    throw error;
  }

  _emitNodeStateChanges(run, before);
  for (const nodeId of reset.readyNodes) emit("dag:node_ready", { runId, nodeId });
  emit("dag:round_started", {
    runId,
    roundId: nextRoundId,
    ordinal: nextOrdinal,
    actorIds: requestedActorIds,
  });
  for (const command of commandRows) {
    emit("dag:command_queued", {
      runId,
      roundId: nextRoundId,
      commandId: command.command_id,
      actorId: command.actor_id,
      nodeId: command.node_id,
    });
  }
  emit("dag:run_resumed", {
    runId,
    previousRoundId: expectedRoundId,
    roundId: nextRoundId,
    actorIds: requestedActorIds,
  });
  return {
    runId,
    previousRoundId: expectedRoundId,
    roundId: nextRoundId,
    ordinal: nextOrdinal,
    actorIds: requestedActorIds,
    nodeIds: actors.map((actor) => actor.node_id),
    commandIds: commandRows.map((command) => command.command_id),
    readyNodeIds: reset.readyNodes,
  };
}

function _persistTerminalRun(
  run: ActiveRun,
  status: "completed" | "cancelled" | "failed",
): void {
  const closedAt = run.completedAt ?? Date.now();
  run.currentRound = {
    ...run.currentRound,
    status,
    closed_at: run.currentRound.closed_at ?? closedAt,
  };
  getDb().transaction(() => {
    terminalizeCurrentDagRunRound({
      run_id: run.runId,
      round_id: run.currentRound.round_id,
      status,
      closed_at: closedAt,
    });
    cancelUnclaimedDagActorCommands({
      run_id: run.runId,
      reason: { status, message: `run ${status}` },
    });
    const leaseRetiredAt = Date.now();
    for (const actor of listDagActors(run.runId)) {
      const current = getDagActorLease({ run_id: run.runId, actor_id: actor.actor_id })
        ?? ensureDagActorLease({
          run_id: run.runId,
          actor_id: actor.actor_id,
          now: leaseRetiredAt,
        });
      if (current.state === "retired") continue;
      retireDagActorLease({
        run_id: run.runId,
        actor_id: actor.actor_id,
        expected_version: current.version,
        ...(current.state === "leased"
          ? {
              lease_generation: current.lease_generation,
              target_type: current.target_type!,
              target_id: current.target_id!,
            }
          : {}),
        now: leaseRetiredAt,
      });
    }
    writeRunMetadata(run.runId, serializeRunMetadata(run));
  }).immediate();
}

export function completeActiveRun(runId: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
  const mutableBefore = _snapshotMutableRun(run);
  const before = _snapshotNodeStates(run);
  try {
    getDb().transaction(() => {
      if (run.currentRound.await_node_id && run.dagRun.nodeStates.get(run.currentRound.await_node_id) === "WAITING_FOR_COMMAND") {
        run.dagRun.nodeStates.set(run.currentRound.await_node_id, "COMPLETED");
      }
      run.status = "completed";
      run.completedAt = Date.now();
      for (const nodeId of run.nodeSessions.keys()) {
        _markNodeSessionStatus(run, nodeId, "completed");
      }
      _persistTerminalRun(run, "completed");
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
  _emitNodeStateChanges(run, before);
  emit("dag:run_completed", { runId });
  emit("dag:engine_completed", { runId });
  deprovisionProvisionedForRun(runId);
  return run;
}

export function cancelActiveRun(runId: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active" && run.status !== "waiting") return run;
  const mutableBefore = _snapshotMutableRun(run);
  const before = _snapshotNodeStates(run);
  try {
    getDb().transaction(() => {
      for (const [nodeId, state] of run.dagRun.nodeStates.entries()) {
        if (state === "RUNNING" || state === "READY" || state === "WAITING_FOR_COMMAND" || state === "WAITING_FOR_APPROVAL") {
          run.dagRun.nodeStates.set(nodeId, "CANCELLED");
          _markNodeSessionStatus(run, nodeId, "cancelled");
        } else if (state === "PENDING") {
          run.dagRun.nodeStates.set(nodeId, "SKIPPED");
        }
      }
      run.status = "cancelled";
      run.completedAt = Date.now();
      _persistTerminalRun(run, "cancelled");
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
  _emitNodeStateChanges(run, before);
  emit("dag:run_cancelled", { runId });
  deprovisionProvisionedForRun(runId);
  return run;
}

export function abortActiveRun(runId: string, reason: string, nodeId?: string): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") return run;
  const mutableBefore = _snapshotMutableRun(run);
  const before = _snapshotNodeStates(run);
  try {
    getDb().transaction(() => {
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
      _persistTerminalRun(run, "failed");
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
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
  _skipPendingNodesWhenFailureStalls(run);
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
    _persistTerminalRun(run, "failed");
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
    "Reuse completed evidence when it is available in the original inputs or current workspace.",
    "Correction mode permits only the handoff tool. Do not repeat investigation, file changes, or other side effects.",
    "Never print a pseudo-tool call as prose, XML, or JSON. Invoke the SDK tool itself.",
    "Finish by calling the handoff tool exactly once with one declared output port and contract-valid content. Do not end with prose.",
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
  try {
    const actorNode = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!actorNode || _isGatewayNode(actorNode)) throw new Error(`Node ${nodeId} has no logical actor`);
    const actor = _ensureLogicalActor(run, actorNode);
    advanceDagActorGeneration({
      run_id: runId,
      actor_id: actor.actor_id,
      expected_generation: actor.generation,
      expected_version: actor.version,
      session_id: nextSession.sessionId,
      attempt: nextSession.attempt,
      checkpoint_ref: fork.entryUuid,
    });
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

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
  fence?: HandoffTransportFence,
): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") throw new Error(`Run ${runId} is not active`);
  const fencedCommand = _validateHandoffTransportFence(run, fromNode, fence);
  const sourceState = getNodeState(run.dagRun, fromNode);
  if (sourceState === "COMPLETED" || sourceState === "FAILED" || sourceState === "CANCELLED" || sourceState === "SKIPPED") {
    throw new Error(`Node ${fromNode} cannot hand off from terminal state ${sourceState}`);
  }
  _assertHandoffPreconditions(run, fromNode, port, content, true);
  const mutableBefore = _snapshotMutableRun(run);
  const before = _snapshotNodeStates(run);
  const readyBefore = new Set(getReadyNodes(run.dagRun));
  let transition!: ReturnType<typeof handoff>;
  try {
    getDb().transaction(() => {
      run.counters.handoffs++;

      for (const edge of run.dagRun.graph.edges) {
        if (edge.from_node !== fromNode || edge.to_node === "" || edge.label === "after_dep") continue;
        if (!edgeMatchesHandoff(edge, port) || !_isBackwardEdge(run, edge)) continue;
        const key = `${edge.from_node}/${edge.from_port}->${edge.to_node}/${edge.to_port}`;
        run.counters.edge_traversals[key] = (run.counters.edge_traversals[key] ?? 0) + 1;
      }

      if (fencedCommand) {
        claimDagActorCommand({
          command_id: fencedCommand.command_id,
          run_id: runId,
          actor_id: fencedCommand.actor_id,
          generation: fencedCommand.target_generation,
        });
      }
      transition = handoff(run.dagRun, fromNode, port, content);
      _markNodeSessionStatus(
        run,
        fromNode,
        transition.terminalOutcome === "cancelled"
          ? "cancelled"
          : transition.terminalFailure
            ? "failed"
            : "completed",
      );
      appendHandoff(runId, {
        runId,
        roundId: run.currentRound.round_id,
        fromNode,
        port,
        content,
        timestamp: Date.now(),
      });
      if (fencedCommand) {
        acknowledgeDagActorCommand({
          command_id: fencedCommand.command_id,
          generation: fencedCommand.target_generation,
        });
      }
      const handedOffNode = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
      if (handedOffNode) _recordFanoutChild(run, handedOffNode, port, content);
      writeRunMetadata(runId, serializeRunMetadata(run));
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
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
      cancelActiveRun(runId);
    } else {
      completeActiveRun(runId);
    }
  }

  return run;
}

function _validateHandoffTransportFence(
  run: ActiveRun,
  fromNode: string,
  fence: HandoffTransportFence | undefined,
): ReturnType<typeof getDagActorCommand> {
  if (fence?.transport !== true) return undefined;
  const actor = getDagActorByNode(run.runId, fromNode);
  if (!actor) throw new Error(`DAG_HANDOFF_ACTOR_FENCE_MISSING ${run.runId}/${fromNode}`);
  const requiresDurableFence = run.currentRound.ordinal > 1;
  if (!fence.roundId) {
    throw new Error(`DAG_HANDOFF_ROUND_FENCE_MISSING ${run.runId}/${fromNode}`);
  }
  if (fence.roundId !== run.currentRound.round_id) {
    throw new Error(
      `DAG_HANDOFF_ROUND_CONFLICT ${run.runId}/${fromNode}: received ${fence.roundId}, current ${run.currentRound.round_id}`,
    );
  }
  if (!fence.actorId) {
    throw new Error(`DAG_HANDOFF_ACTOR_FENCE_MISSING ${run.runId}/${fromNode}`);
  }
  if (fence.actorId !== actor.actor_id) {
    throw new Error(`DAG_HANDOFF_ACTOR_CONFLICT ${run.runId}/${fromNode}`);
  }
  if (fence.generation === undefined) {
    throw new Error(`DAG_HANDOFF_GENERATION_FENCE_MISSING ${run.runId}/${fromNode}`);
  }
  if (fence.generation !== actor.generation) {
    throw new Error(
      `DAG_HANDOFF_GENERATION_CONFLICT ${run.runId}/${fromNode}: received ${String(fence.generation)}, current ${actor.generation}`,
    );
  }
  if (fence.leaseGeneration === undefined) {
    throw new Error(`DAG_HANDOFF_LEASE_FENCE_MISSING ${run.runId}/${fromNode}`);
  }
  const lease = getDagActorLease({ run_id: run.runId, actor_id: actor.actor_id });
  if (
    !lease
    || lease.state !== "leased"
    || lease.lease_generation !== fence.leaseGeneration
  ) {
    throw new Error(
      `DAG_HANDOFF_LEASE_CONFLICT ${run.runId}/${fromNode}: received ${String(fence.leaseGeneration)}, current ${lease?.state === "leased" ? lease.lease_generation : "none"}`,
    );
  }
  if (requiresDurableFence && !fence.commandId) {
    throw new Error(`DAG_HANDOFF_COMMAND_FENCE_MISSING ${run.runId}/${fromNode}`);
  }
  if (!fence.commandId) return undefined;
  const command = getDagActorCommand(fence.commandId);
  if (!command
    || command.run_id !== run.runId
    || command.actor_id !== actor.actor_id
    || command.round_id !== run.currentRound.round_id) {
    throw new Error(`DAG_HANDOFF_COMMAND_CONFLICT ${run.runId}/${fromNode}`);
  }
  if (command.target_generation !== actor.generation) {
    throw new Error(`DAG_HANDOFF_COMMAND_GENERATION_CONFLICT ${run.runId}/${fromNode}`);
  }
  return command;
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

export function expireWaitingActiveRuns(now = Date.now()): string[] {
  const expired: string[] = [];
  for (const run of store.values()) {
    if (run.status !== "waiting") continue;
    if (run.currentRound.expires_at === undefined || run.currentRound.expires_at > now) continue;
    const mutableBefore = _snapshotMutableRun(run);
    const before = _snapshotNodeStates(run);
    const awaitNodeId = run.currentRound.await_node_id;
    try {
      getDb().transaction(() => {
        if (awaitNodeId && run.dagRun.nodeStates.get(awaitNodeId) === "WAITING_FOR_COMMAND") {
          run.dagRun.nodeStates.set(awaitNodeId, "FAILED");
        }
        run.status = "failed";
        run.completedAt = now;
        run.counters.abort_reason = `await_command expired at ${run.currentRound.expires_at}`;
        _persistTerminalRun(run, "failed");
      }).immediate();
    } catch (error) {
      _restoreMutableRun(run, mutableBefore);
      console.error(
        `[homerail_manager] failed to expire waiting run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    _emitNodeStateChanges(run, before);
    emit("dag:run_expired", {
      runId: run.runId,
      roundId: run.currentRound.round_id,
      awaitNodeId,
      expiredAt: now,
    });
    emit("dag:run_failed", {
      runId: run.runId,
      nodeId: awaitNodeId ?? "",
      reason: "await_command expired",
    });
    deprovisionProvisionedForRun(run.runId);
    expired.push(run.runId);
  }
  return expired.sort();
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

export function getWaitingRunCount(): number {
  let count = 0;
  for (const run of store.values()) {
    if (run.status === "waiting") count++;
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
  _assertLogicalActorIdentities(nextGraph.nodes);

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
  if (!_isGatewayNode(node)) _ensureLogicalActor(run, node);
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
  const activeBefore = Array.from(store.values())
    .filter((run) => run.status === "active" || run.status === "waiting").length;
  const cancelled: string[] = [];
  for (const run of store.values()) {
    if (run.status === "active" || run.status === "waiting") {
      cancelActiveRun(run.runId);
      cancelled.push(run.runId);
    }
  }
  const activeAfter = Array.from(store.values())
    .filter((run) => run.status === "active" || run.status === "waiting").length;
  return { cancelled, activeBefore, activeAfter };
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
    node.node_type === "fanout_gateway" ||
    node.node_type === "await_command_gateway";
}

function _roundResetNodeIds(
  run: ActiveRun,
  selectedNodeIds: ReadonlySet<string>,
  awaitNodeId: string,
): string[] {
  const reset = new Set(selectedNodeIds);
  const reachedAwait = new Set<string>();
  for (const selectedNodeId of selectedNodeIds) {
    const queue = [selectedNodeId];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of run.dagRun.graph.edges) {
        if (edge.from_node !== current || !edge.to_node) continue;
        if (edge.to_node === awaitNodeId) {
          reset.add(awaitNodeId);
          reachedAwait.add(selectedNodeId);
          continue;
        }
        const target = run.dagRun.graph.nodes.find((node) => node.node_id === edge.to_node);
        if (!target || !_isGatewayNode(target)) continue;
        reset.add(target.node_id);
        queue.push(target.node_id);
      }
    }
  }
  const missing = Array.from(selectedNodeIds).filter((nodeId) => !reachedAwait.has(nodeId));
  if (missing.length > 0) {
    throw new Error(`Selected actors have no gateway-only path to await_command ${awaitNodeId}: ${missing.join(", ")}`);
  }
  return Array.from(reset).sort();
}

function _roundCarryoverInputs(
  run: ActiveRun,
  resetNodeIds: ReadonlySet<string>,
): Map<string, Array<{ fromNode: string; port: string; value: unknown }>> {
  const handoffs = loadRunSnapshot(run.runId)?.handoffs ?? [];
  const carryover = new Map<string, Array<{ fromNode: string; port: string; value: unknown }>>();
  for (const edge of run.dagRun.graph.edges) {
    if (!edge.to_node || edge.label === "after_dep" || !resetNodeIds.has(edge.to_node) || resetNodeIds.has(edge.from_node)) {
      continue;
    }
    let previous: (typeof handoffs)[number] | undefined;
    for (let index = handoffs.length - 1; index >= 0; index -= 1) {
      const record = handoffs[index];
      if (record.fromNode === edge.from_node && edgeMatchesHandoff(edge, record.port)) {
        previous = record;
        break;
      }
    }
    if (!previous) continue;
    const inputs = carryover.get(edge.to_node) ?? [];
    inputs.push({ fromNode: edge.from_node, port: edge.to_port, value: previous.content });
    carryover.set(edge.to_node, inputs);
  }
  return carryover;
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

const RUN_WORKSPACE_CWD = "$run_workspace";

function _pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function _commandGatewayCwd(
  run: ActiveRun,
  configured: string | undefined,
): { cwd: string; label: string } | { error: string } {
  const managerRoot = path.resolve(process.cwd());
  const raw = configured ?? ".";
  const usesRunWorkspace = raw === RUN_WORKSPACE_CWD ||
    raw.startsWith(`${RUN_WORKSPACE_CWD}/`) ||
    raw.startsWith(`${RUN_WORKSPACE_CWD}\\`);
  if (!usesRunWorkspace) {
    const cwd = path.resolve(managerRoot, raw);
    if (!_pathIsWithin(managerRoot, cwd)) return { error: "command cwd escapes Manager workspace" };
    return { cwd, label: path.relative(managerRoot, cwd) || "." };
  }

  const workspaceRoot = path.resolve(getHomerailHome(), "workspace");
  const runWorkspace = path.resolve(workspaceRoot, ...run.runId.split("/"));
  if (runWorkspace === workspaceRoot || !_pathIsWithin(workspaceRoot, runWorkspace)) {
    return { error: "command run workspace path is unsafe" };
  }
  const suffix = raw.slice(RUN_WORKSPACE_CWD.length).replace(/^[/\\]+/, "");
  const candidate = path.resolve(runWorkspace, suffix || ".");
  if (!_pathIsWithin(runWorkspace, candidate)) return { error: "command cwd escapes run workspace" };
  try {
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(runWorkspace, { recursive: true, mode: 0o700 });
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    const realWorkspace = realpathSync(runWorkspace);
    if (realWorkspace === realWorkspaceRoot || !_pathIsWithin(realWorkspaceRoot, realWorkspace)) {
      return { error: "command run workspace resolves outside workspace root" };
    }
    const realCandidate = realpathSync(candidate);
    if (!_pathIsWithin(realWorkspace, realCandidate)) {
      return { error: "command cwd resolves outside run workspace" };
    }
    return {
      cwd: realCandidate,
      label: suffix ? `${RUN_WORKSPACE_CWD}/${suffix.replace(/\\/g, "/")}` : RUN_WORKSPACE_CWD,
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable";
    return { error: `command run workspace cwd is unavailable (${code})` };
  }
}

function _commandGatewayResult(run: ActiveRun, node: DAGGraphNode): { port: string; payload: unknown } {
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
  const resolvedCwd = _commandGatewayCwd(run, config?.cwd);
  if ("error" in resolvedCwd) {
    return { port: config?.failure_port || "failed", payload: { ok: false, error: resolvedCwd.error } };
  }
  const { cwd, label: cwdLabel } = resolvedCwd;
  const stdinValue = config?.stdin_field === "$inputs"
    ? inputs
    : config?.stdin_field
      ? _fieldValue(input, config.stdin_field)
      : undefined;
  const captureLimit = Math.max(1, Math.floor(config?.capture_limit ?? 64_000));
  const startedAt = Date.now();
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: Math.max(100, Math.floor(config?.timeout_ms ?? 30_000)),
    maxBuffer: captureLimit * 2,
    shell: false,
    env: process.env,
    ...(config?.stdin_field ? { input: JSON.stringify(stdinValue) } : {}),
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
    cwd: cwdLabel,
    exit_code: exitCode,
    signal: result.signal ?? null,
    stdout,
    stderr: String(result.stderr ?? "").slice(0, captureLimit),
    duration_ms: Date.now() - startedAt,
    timed_out: result.error && "code" in result.error && result.error.code === "ETIMEDOUT",
    error: result.error?.message,
    value,
    parse_failed: parseFailed,
    input: config?.stdin_field === "$inputs" ? inputs : input,
  };
  const telemetry = redactTelemetry(payload) as Record<string, unknown>;
  emit("dag:deterministic_command", { runId: run.runId, nodeId: node.node_id, ...telemetry });
  const handoffPayload = payload.ok && config?.result_payload === "value" ? value : payload;
  return {
    port: payload.ok ? config?.success_port || "passed" : config?.failure_port || "failed",
    payload: handoffPayload,
  };
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

function _startAwaitCommand(run: ActiveRun, node: DAGGraphNode): boolean {
  const config = node.gateway_config;
  if (config?.primitive_version !== 1) {
    throw new Error(`await_command ${node.node_id} requires primitive_version 1`);
  }
  if (run.status !== "active" || run.currentRound.status !== "active") {
    throw new Error(`Run ${run.runId} cannot enter await_command from ${run.status}/${run.currentRound.status}`);
  }
  const nonQuiescent = Array.from(run.dagRun.nodeStates.entries())
    .filter(([nodeId, state]) => nodeId !== node.node_id &&
      state !== "COMPLETED" && state !== "FAILED" && state !== "CANCELLED" && state !== "SKIPPED")
    .map(([nodeId, state]) => `${nodeId}:${state}`)
    .sort();
  if (nonQuiescent.length > 0) {
    return false;
  }
  const before = _snapshotNodeStates(run);
  const previousRound = structuredClone(run.currentRound);
  const now = Date.now();
  const actorCheckpoints = buildRunActorCheckpoints({
    runId: run.runId,
    roundId: previousRound.round_id,
    capturedAt: now,
  });
  const expiresAt = config.expires_after_ms === undefined
    ? undefined
    : now + Math.max(1_000, Math.floor(config.expires_after_ms));
  run.dagRun.nodeStates.set(node.node_id, "WAITING_FOR_COMMAND");
  run.status = "waiting";
  run.currentRound = {
    ...run.currentRound,
    status: "waiting",
    await_node_id: node.node_id,
    closed_at: now,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
  try {
    getDb().transaction(() => {
      transitionDagRunRoundToWaiting({
        run_id: run.runId,
        round_id: previousRound.round_id,
        await_node_id: node.node_id,
        closed_at: now,
        expires_at: expiresAt,
      });
      for (const { actor, checkpoint } of actorCheckpoints) {
        writeDagActorCheckpoint({
          run_id: run.runId,
          actor_id: actor.actor_id,
          checkpoint,
          now,
        });
        const lease = getDagActorLease({
          run_id: run.runId,
          actor_id: actor.actor_id,
        }) ?? ensureDagActorLease({
          run_id: run.runId,
          actor_id: actor.actor_id,
          now,
        });
        if (lease.state === "leased") {
          acquireDagActorLease({
            run_id: run.runId,
            actor_id: actor.actor_id,
            target_type: lease.target_type!,
            target_id: lease.target_id!,
            expected_version: lease.version,
            now,
          });
        }
      }
      writeRunMetadata(run.runId, serializeRunMetadata(run));
    }).immediate();
  } catch (error) {
    run.status = "active";
    run.currentRound = previousRound;
    run.dagRun.nodeStates.set(node.node_id, before.get(node.node_id) as NodeState);
    throw error;
  }
  _emitNodeStateChanges(run, before);
  emit("dag:round_closed", {
    runId: run.runId,
    roundId: run.currentRound.round_id,
    ordinal: run.currentRound.ordinal,
    awaitNodeId: node.node_id,
  });
  emit("dag:run_waiting", {
    runId: run.runId,
    roundId: run.currentRound.round_id,
    awaitNodeId: node.node_id,
    expiresAt,
  });
  for (const { actor } of actorCheckpoints) {
    const checkpoint = getLatestDagActorCheckpoint({
      run_id: run.runId,
      actor_id: actor.actor_id,
    });
    if (!checkpoint) continue;
    emit("dag:actor_checkpoint_saved", {
      runId: run.runId,
      actorId: actor.actor_id,
      checkpointVersion: checkpoint.checkpoint_version,
      checkpointSha256: checkpoint.checkpoint_sha256,
    });
  }
  return true;
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
  if (node.node_type === "await_command_gateway") {
    if (!_startAwaitCommand(run, node)) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port: "waiting",
    });
    return true;
  }

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

function _allowedBuiltinTools(node: DAGGraphNode): AgentBuiltinToolName[] | undefined {
  const raw = _agentRuntimeConfig(node).allowed_builtin_tools;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(AGENT_BUILTIN_TOOL_NAMES);
  return raw.filter((entry): entry is AgentBuiltinToolName => (
    typeof entry === "string" && allowed.has(entry)
  ));
}

function _allowedDagTools(node: DAGGraphNode): DagAgentToolName[] | undefined {
  const raw = _agentRuntimeConfig(node).allowed_dag_tools;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(DAG_AGENT_TOOL_NAMES);
  return raw.filter((entry): entry is DagAgentToolName => (
    typeof entry === "string" && allowed.has(entry)
  ));
}

function _requiredDispatchCapabilities(
  run: ActiveRun,
  node: DAGGraphNode,
): string[] | undefined {
  const required = new Set<string>();
  for (const capability of node.requires?.capabilities ?? []) {
    if (typeof capability !== "string") continue;
    const normalized = capability.trim();
    if (normalized) required.add(normalized);
  }
  required.add(DAG_TRANSPORT_FENCE_CAPABILITY);
  return required.size > 0 ? Array.from(required) : undefined;
}

function _activitySurfaceId(node: DAGGraphNode): string | undefined {
  const value = _agentRuntimeConfig(node).surface_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const actor = _ensureLogicalActor(run, node);
  const actorId = actor.actor_id;
  const generation = actor.generation;
  const surfaceId = actor.surface_id;
  const actorCheckpoint = getLatestDagActorCheckpoint({
    run_id: run.runId,
    actor_id: actorId,
  })?.checkpoint;
  const roundCommand = listDagActorCommands({
    run_id: run.runId,
    actor_id: actorId,
    round_id: run.currentRound.round_id,
  }).find((command) => command.status !== "cancelled" && command.status !== "failed");
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
      ...(actorCheckpoint ? { actorCheckpoint } : {}),
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workspace: run.workspace,
      image: node.image,
      container_group: node.container_group,
      requiredCapabilities: _requiredDispatchCapabilities(run, node),
      advisors: advisorResolution.advisors,
      workspaceAccess: _workspaceAccess(node),
      allowedBuiltinTools: _allowedBuiltinTools(node),
      allowedDagTools: _allowedDagTools(node),
      activity: {
        roundId: run.currentRound.round_id,
        actorId,
        generation,
        ...(roundCommand ? { commandId: roundCommand.command_id } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        sequenceStart: getDagActivitySequenceCursor(run.runId, actorId, generation),
      },
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

function _markRoundCommandsDelivered(run: ActiveRun, nodeId: string): void {
  const actor = getDagActorByNode(run.runId, nodeId);
  if (!actor) return;
  const commands = listDagActorCommands({
    run_id: run.runId,
    actor_id: actor.actor_id,
    round_id: run.currentRound.round_id,
    status: "pending",
  });
  for (const command of commands) markDagActorCommandDelivered(command.command_id);
}

export function dispatchReadyNodes(
  runId: string,
  dispatcher: DAGDispatcher,
): number {
  const run = store.get(runId);
  if (!run || run.status !== "active") return 0;

  let count = 0;
  let dispatchCounterChanged = false;
  const before = _snapshotNodeStates(run);
  const ready = getReadyNodes(run.dagRun);
  for (const nodeId of ready) {
    const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
    if (!node) continue;
    if (_isGatewayNode(node)) {
      try {
        if (_executeGatewayNode(runId, run, node)) count++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failActiveRun(runId, nodeId, `gateway execution failed: ${message}`);
      }
      if (run.status !== "active") break;
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
    const envelope = built.envelope;

    let result = dispatcher.dispatch(envelope);
    if (result.status !== "skipped") {
      run.counters.dispatches++;
      dispatchCounterChanged = true;
    }
    if (result.status === "failed") {
      const retryable = result.retryable !== false;
      if (retryable && recordNodeDispatchRetry(runId, nodeId, result.reason)) {
        if (run.counters.dispatches >= run.limits.max_dispatches) {
          abortActiveRun(runId, `max_dispatches (${run.limits.max_dispatches}) exceeded`, nodeId);
          break;
        }
        result = dispatcher.dispatch({
          ...envelope,
          inputs: {
            ...envelope.inputs,
            dispatch_retry: [
              `Retrying DAG node ${nodeId} after transient dispatch failure: ${result.reason}`,
            ],
          },
        });
        if (result.status !== "skipped") {
          run.counters.dispatches++;
          dispatchCounterChanged = true;
        }
      }
      if (result.status === "failed") {
        failActiveRun(runId, nodeId, result.reason);
        continue;
      }
    }
    if (result.status !== "dispatched") continue;
    startNode(run.dagRun, nodeId);
    _markNodeSessionStatus(run, nodeId, "running");
    _markRoundCommandsDelivered(run, nodeId);
    emit("dag:node_dispatched", { runId, nodeId, agentId: envelope.agentId, sessionId: envelope.sessionId });
    count++;
  }
  if (count > 0 || dispatchCounterChanged) {
    writeRunMetadata(runId, serializeRunMetadata(run));
  }
  if (count > 0) {
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
  _markRoundCommandsDelivered(run, nodeId);
  emit("dag:node_dispatched", { runId, nodeId, agentId: node.agent, sessionId: nodeSession.sessionId });
  writeRunMetadata(runId, serializeRunMetadata(run));
  _emitNodeStateChanges(run, before);
  return true;
}

export function recordProvisionedNodeDispatchAttempt(
  runId: string,
  nodeId: string,
): boolean {
  const run = store.get(runId);
  if (!run || run.status !== "active" || getNodeState(run.dagRun, nodeId) !== "READY") return false;
  if (run.counters.dispatches >= run.limits.max_dispatches) {
    abortActiveRun(runId, `max_dispatches (${run.limits.max_dispatches}) exceeded`, nodeId);
    return false;
  }
  const mutableBefore = _snapshotMutableRun(run);
  try {
    run.counters.dispatches++;
    writeRunMetadata(runId, serializeRunMetadata(run));
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
  return true;
}

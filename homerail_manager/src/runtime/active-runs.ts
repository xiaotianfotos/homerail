import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
  reconcileSettledPendingNodes,
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
import {
  clearDispatchTarget,
  excludeCurrentDispatchTarget,
  findDispatchTarget,
  restoreDispatchExclusion,
  type DispatchTarget,
} from "../orchestration/dispatch-tracker.js";
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
  sanitizeAttemptDiagnostic,
  extractReviewEvidence,
  type AgentBuiltinToolPolicy,
  type AgentBuiltinToolName,
  type DagAdvisorConfig,
  type DagAgentToolName,
  type DagWorkspaceAccess,
  type DagCredentialProjection,
  type DagCredentialBrokerCallRequest,
  type DagRunInputBinding,
} from "homerail-protocol";
import { resolveAgentRuntimeConfig } from "./agent-runtime-resolver.js";
import { spawnManagerGitSync } from "./manager-git.js";
import {
  writeRunMetadata,
  appendHandoff,
  serializeRunMetadata,
  loadRunMetadata,
  loadRunSnapshot,
  listPersistedRunIdsByStatus,
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
import { getDagActorSurfaceView } from "../persistence/dag-actor-surface-patches.js";
import { getDb } from "../persistence/db.js";
import { getCredential, materializeCredential } from "../persistence/credentials.js";
import {
  bindDagRunInputs,
  dagRunInputPath,
  materializeDagRunInputs,
  verifyDagRunInputs,
} from "../persistence/run-input-artifacts.js";
import {
  getRunArtifactBlobPath,
  listRunArtifacts,
  publishWorkspaceEvidenceArtifact,
  type RunArtifactRecord,
} from "../persistence/run-artifacts.js";
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
  getDagActor,
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
  getDagActorLiveCommand,
  listOutstandingDagActorLiveCommands,
  markDagActorLiveCommandFallback,
  terminateDagActorLiveCommands,
  transitionDagActorLiveCommand,
  type DagActorLiveCommandRecord,
} from "../persistence/dag-actor-live-commands.js";
import {
  acquireDagActorLease,
  ensureDagActorLease,
  getDagActorCheckpoint,
  getDagActorLease,
  getLatestDagActorCheckpoint,
  releaseDagActorLease,
  retireDagActorLease,
  writeDagActorCheckpoint,
} from "../persistence/dag-actor-leases.js";
import {
  buildReviewEvidenceProjectionFor,
  recordAttemptDiagnostic,
  recordReviewHandoffEvidence,
  reviewEvidenceProjectionWorkspacePath,
  writeReviewEvidenceProjectionFile,
  type ReviewEvidenceIdentity,
  type ReviewHandoffEvidenceInput,
} from "../persistence/dag-review-evidence.js";
import {
  createDagActorIntervention,
  DagActorInterventionConflictError,
  failDagActorIntervention,
  findDagActorInterventionByKey,
  getDagActorIntervention,
  listDagActorInterventions,
  markDagActorInterventionApplying,
  completeDagActorIntervention,
  clearDagActorDispatchExclusion,
  listDagActorDispatchExclusions,
  upsertDagActorDispatchExclusion,
  type DagActorInterventionOperation,
  type DagActorInterventionRecord,
} from "../persistence/dag-actor-interventions.js";
import {
  initializeDagLiveSurfaceRoster,
  resetDagLiveSurfaceActorBody,
  supersedeDagLiveSurfaceForIntervention,
} from "../generative-ui/dag-live-surface-projector.js";
import { buildDagActorCheckpoint, buildRunActorCheckpoints } from "./dag-actor-checkpoint-builder.js";
import { getDagActorControlState, type DagActorControlStateName } from "./dag-actor-control-state.js";
import {
  getDagRunSkillContext,
  pinDagRunSkillContext,
  pinDagRunSkillContexts,
} from "../persistence/dag-run-skill-contexts.js";
import {
  assertDagWorkerSurfaceViewAllowlist,
  resolveDagWorkerSkillContext,
  resolveDeclaredDagWorkerSkillContexts,
} from "./dag-worker-skill-context.js";

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

export interface InterveneDagActorRequest {
  actor_id: string;
  operation: DagActorInterventionOperation;
  expected_state_token: string;
  idempotency_key: string;
  instruction?: string;
  checkpoint_version?: number;
}

export interface InterveneDagActorResult {
  intervention_id: string;
  run_id: string;
  actor_id: string;
  operation: DagActorInterventionOperation;
  status: DagActorInterventionRecord["status"];
  actor_state: DagActorControlStateName;
  state_token: string;
  deduplicated: boolean;
  created_at: number;
  updated_at: number;
}

export class DagActorInterventionRuntimeError extends Error {
  constructor(
    public readonly code:
      | "run_not_active"
      | "actor_not_found"
      | "actor_retired"
      | "state_token_conflict"
      | "command_fence_missing"
      | "intervention_recovery_failed",
    message: string,
  ) {
    super(message);
    this.name = "DagActorInterventionRuntimeError";
  }
}

export interface DagActorInterventionRecoverySummary {
  applied: string[];
  failed: string[];
  skipped: string[];
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
  inputArtifacts?: DagRunInputBinding[];
  brokerState: Record<string, unknown>;
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

export interface ReviewEvidenceWriteInput extends ReviewHandoffEvidenceInput {}

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
  fanout_invocations: Record<string, number>;
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
  inputArtifacts?: DagRunInputBinding[];
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
const MAX_LIVE_FALLBACK_ACTORS_PER_ROUND = 128;
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
    fanout_invocations: {},
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
    fanout_invocations: { ...(counters.fanout_invocations ?? {}) },
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
  return _runtimeString(node, "role")
    ?? (typeof node.description === "string" && node.description.trim() ? node.description.trim() : undefined)
    ?? node.agent
    ?? node.name
    ?? node.node_id;
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
  const actorsByNode = new Map<string, DagActorRecord>();
  for (const node of run.dagRun.graph.nodes) {
    if (!_isGatewayNode(node)) actorsByNode.set(node.node_id, _ensureLogicalActor(run, node));
  }
  const roster: DagActorRecord[] = [];
  const rosterIds = new Set<string>();
  for (const target of run.runInputTargets ?? []) {
    const actor = actorsByNode.get(target.node);
    if (!actor || rosterIds.has(actor.actor_id)) continue;
    rosterIds.add(actor.actor_id);
    roster.push(actor);
  }
  if (roster.length > 1) initializeDagLiveSurfaceRoster(roster, run.createdAt);
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

function _nodeSessionScope(node: DAGGraphNode | undefined): "node" | "dispatch" {
  return _agentRuntimeConfig(node ?? {} as DAGGraphNode).session_scope === "dispatch" ? "dispatch" : "node";
}

function _prepareNodeSessionForDispatch(run: ActiveRun, node: DAGGraphNode): NodeSessionState {
  const current = _ensureNodeSession(run, node.node_id);
  if (_nodeSessionScope(node) !== "dispatch") return current;
  if (!new Set(["completed", "failed", "cancelled"]).has(current.status)) return current;
  const fresh = _persistNodeSession(run, node.node_id, {
    sessionId: _newSessionId(run.runId, node.node_id),
    attempt: current.attempt + 1,
    status: "active",
  });
  emit("dag:node_session_reset", {
    runId: run.runId,
    nodeId: node.node_id,
    previousSessionId: current.sessionId,
    sessionId: fresh.sessionId,
    attempt: fresh.attempt,
  });
  return fresh;
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
  const skillContexts = resolveDeclaredDagWorkerSkillContexts({
    agents: parsedDAG.meta.agents ?? {},
  });
  const dagRun = createDAGRun(parsedDAG, runId);
  const createdAt = Date.now();
  const inputArtifacts = options.inputArtifacts?.map((binding) => ({
    ...structuredClone(binding),
    run_id: runId,
    bound_at: createdAt,
  }));
  if (inputArtifacts && inputArtifacts.length > 0) {
    materializeDagRunInputs(runId, inputArtifacts);
  }
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
    inputArtifacts,
    brokerState: {},
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
    if (inputArtifacts && inputArtifacts.length > 0) bindDagRunInputs(runId, inputArtifacts);
    pinDagRunSkillContexts({
      run_id: runId,
      contexts: skillContexts,
      created_at: createdAt,
    });
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
  const interventionProtectedNodeIds = new Set(
    listDagActorInterventions({ run_id: run.runId, limit: 500 })
      .filter((intervention) => intervention.status === "queued" || intervention.status === "applying")
      .map((intervention) => getDagActor(run.runId, intervention.actor_id)?.node_id)
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  );
  const liveCommandProtectedNodeIds = new Set(
    listOutstandingDagActorLiveCommands(run.runId)
      .filter((command) => command.status === "queued" || command.status === "delivered" || command.status === "applied")
      .map((command) => {
        const actor = getDagActor(run.runId, command.actor_id);
        return actor?.generation === command.target_generation ? actor.node_id : undefined;
      })
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  );
  for (const nodeId of liveCommandProtectedNodeIds) {
    if (run.dagRun.nodeStates.get(nodeId) !== "RUNNING") continue;
    run.dagRun.nodeStates.set(nodeId, "READY");
    const current = run.nodeSessions.get(nodeId);
    if (current) _persistNodeSession(run, nodeId, { ...current, status: "pending" });
    emit("dag:node_ready", { runId: run.runId, nodeId });
  }
  const demotedFromRunning = Array.from(run.dagRun.nodeStates.entries())
    .filter(([nodeId, state]) => (
      state === "RUNNING"
      && !run.dagRun.loopSources.has(nodeId)
      && !interventionProtectedNodeIds.has(nodeId)
    ))
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

  const skippedBlockedNodes = new Set(reconcileFailedDependencies(run.dagRun));

  // A loop gateway is deliberately left RUNNING while it waits for feedback,
  // so it is not an orphan merely because the Manager restarted. It does become
  // stranded when every path that could still produce feedback was settled by
  // the orphan demotion above. Fail that dormant gateway as well; otherwise its
  // untaken terminal branches stay PENDING and the recovered run can never
  // become terminal.
  const strandedLoopSources = Array.from(run.dagRun.loopSources)
    .filter((nodeId) => (
      run.dagRun.nodeStates.get(nodeId) === "RUNNING"
      && !_loopSourceHasLiveFeedbackPath(run, nodeId, new Set([nodeId]))
    ));
  for (const nodeId of strandedLoopSources) {
    const reason = "loop feedback path lost: manager process restarted";
    const current = run.nodeSessions.get(nodeId);
    if (current) {
      _persistNodeSession(run, nodeId, { ...current, status: "failed" });
    }
    failNode(run.dagRun, nodeId, { error: reason });
    demotedFromRunning.push(nodeId);
    emit("dag:node_failed", { runId: run.runId, nodeId, reason });
  }

  for (const nodeId of reconcileFailedDependencies(run.dagRun)) {
    skippedBlockedNodes.add(nodeId);
  }
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

function _loopSourceHasLiveFeedbackPath(
  run: ActiveRun,
  nodeId: string,
  visiting: Set<string>,
): boolean {
  const mailbox = run.dagRun.mailboxes.get(nodeId);
  if (mailbox && Array.from(mailbox.values()).some((values) => values.length > 0)) return true;

  const feedbackSources = run.dagRun.graph.edges
    .filter((edge) => edge.to_node === nodeId && edge.label !== "after_dep" && edge.from_node)
    .map((edge) => edge.from_node);
  return feedbackSources.some((sourceId) => _nodeHasLivePath(run, sourceId, visiting));
}

function _nodeHasLivePath(run: ActiveRun, nodeId: string, visiting: Set<string>): boolean {
  if (visiting.has(nodeId)) return false;
  const state = run.dagRun.nodeStates.get(nodeId);
  if (state === "READY" || state === "WAITING_FOR_APPROVAL" || state === "WAITING_FOR_COMMAND") return true;
  if (state === "RUNNING" && !run.dagRun.loopSources.has(nodeId)) return true;
  if (state !== "PENDING" && state !== "RUNNING") return false;

  const nextVisiting = new Set(visiting).add(nodeId);
  if (state === "RUNNING") {
    return _loopSourceHasLiveFeedbackPath(run, nodeId, nextVisiting);
  }
  return run.dagRun.graph.edges
    .filter((edge) => edge.to_node === nodeId && edge.from_node)
    .some((edge) => _nodeHasLivePath(run, edge.from_node, nextVisiting));
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

  const verifiedInputArtifacts = verifyDagRunInputs(metadata.runId);
  if ((metadata.inputArtifacts?.length ?? 0) !== verifiedInputArtifacts.length) {
    throw new Error(`persisted run input provenance does not match bound inputs for ${metadata.runId}`);
  }
  if (metadata.inputArtifacts && !isDeepStrictEqual(
    metadata.inputArtifacts.map((entry) => ({ ...entry })).sort((left, right) => left.logical_name.localeCompare(right.logical_name)),
    verifiedInputArtifacts.map((entry) => ({ ...entry })).sort((left, right) => left.logical_name.localeCompare(right.logical_name)),
  )) {
    throw new Error(`persisted run input provenance changed for ${metadata.runId}`);
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
    inputArtifacts: verifiedInputArtifacts.length > 0 ? verifiedInputArtifacts : undefined,
    brokerState: metadata.brokerState ? structuredClone(metadata.brokerState) : {},
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
  const settledPendingNodes = run.status === "active"
    ? Array.from(reconcileSettledPendingNodes(run.dagRun)).sort()
    : [];
  for (const nodeId of settledPendingNodes) _markNodeSessionStatus(run, nodeId, "cancelled");
  if (run.status === "active" && isRunTerminal(run.dagRun)) {
    completeActiveRun(run.runId);
  } else {
    writeRunMetadata(metadata.runId, serializeRunMetadata(run));
  }

  emit("dag:run_recovered", {
    runId: metadata.runId,
    recoveredAt: Date.now(),
    demotedFromRunning,
    settledPendingNodes,
    reason: demotedFromRunning.length
      ? "orphaned running nodes demoted to failed"
      : undefined,
  });
  _emitStatusUpdate(run);

  return { status: "restored", run, demotedFromRunning };
}

export interface ColdRecoveryFailure {
  runId: string;
  reason: string;
  demotedNodes: string[];
}

export interface ColdRecoverySummary {
  recovered: string[];
  failed: ColdRecoveryFailure[];
  skipped: string[];
}

/** Scan all persisted runs and restore every still-active one into the
 * in-memory store. Safe to call at startup. Idempotent. */
export function recoverAllActiveRuns(): ColdRecoverySummary {
  const summary: ColdRecoverySummary = { recovered: [], failed: [], skipped: [] };
  for (const runId of listPersistedRunIdsByStatus(["active", "waiting"])) {
    try {
      const metadata = loadRunMetadata(runId);
      if (!metadata) {
        summary.skipped.push(runId);
        continue;
      }
      const result = restoreActiveRun(metadata);
      if (result.status === "restored") {
        if (result.run.status === "failed") {
          summary.failed.push({
            runId,
            reason: result.demotedFromRunning.length > 0
              ? `orphaned running nodes demoted to failed: ${result.demotedFromRunning.join(", ")}`
              : "run terminal after recovery (blocked by failed dependency)",
            demotedNodes: result.demotedFromRunning,
          });
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
    dispatched += dispatchReadyNodesUntilStable(run.runId, dispatcher);
  }
  return dispatched;
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return store.get(runId);
}

interface BrokerActionRequirement {
  credential_ref: string;
  broker: string;
  action: string;
  when?: {
    field: string;
    equals: unknown;
  };
  result_binding?: {
    result_field: string;
    content_field: string;
  };
  result_digest_binding?: {
    result_field: string;
    content_field: string;
  };
}

interface WorkspaceFileRequirement {
  path_field: string;
  sha256_field: string;
  contract: string;
  max_bytes?: number;
  bindings?: Array<{ file_field: string; content_field: string }>;
}

interface BrokerActionReceipt {
  credential_ref: string;
  broker: string;
  action: string;
  node_id: string;
  session_id: string;
  recorded_at: number;
  bound_results?: Record<string, string | number | boolean | null>;
  /** Manager-produced, contract-ready content that can recover a rejected model handoff. */
  canonical_handoff?: unknown;
}

const BROKER_ACTION_RECEIPTS_KEY = "broker_action_receipts";
const BROKER_ACTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BROKER_ACTION_FIELD = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

function _dottedField(value: unknown, field: string): unknown {
  let selected = value;
  for (const segment of field.split(".")) {
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) return undefined;
    selected = (selected as Record<string, unknown>)[segment];
  }
  return selected;
}

function _deepSortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(_deepSortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, _deepSortValue(entry)]),
  );
}

function _boundedBrokerResult(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 1_024);
}

function _boundedCanonicalHandoff(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1024) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

function _outputBrokerActionRequirements(
  run: ActiveRun,
  nodeId: string,
  port?: string,
  content?: unknown,
  evaluateConditions = false,
): BrokerActionRequirement[] {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const workflowSpec = node?.extra?.workflow_spec_v1;
  if (!workflowSpec || typeof workflowSpec !== "object" || Array.isArray(workflowSpec)) return [];
  const rawByPort = (workflowSpec as Record<string, unknown>).output_broker_requirements;
  if (!rawByPort || typeof rawByPort !== "object" || Array.isArray(rawByPort)) return [];
  const selected = port === undefined
    ? Object.values(rawByPort as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
    : (rawByPort as Record<string, unknown>)[port];
  if (!Array.isArray(selected)) return [];
  return selected.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if (![entry.credential_ref, entry.broker, entry.action].every((field) => (
      typeof field === "string" && BROKER_ACTION_NAME.test(field)
    ))) return [];
    let when: BrokerActionRequirement["when"];
    if (entry.when !== undefined) {
      if (!entry.when || typeof entry.when !== "object" || Array.isArray(entry.when)) return [];
      const rawWhen = entry.when as Record<string, unknown>;
      if (typeof rawWhen.field !== "string"
        || !BROKER_ACTION_FIELD.test(rawWhen.field)
        || !("equals" in rawWhen)) return [];
      when = { field: rawWhen.field, equals: rawWhen.equals };
    }
    let resultBinding: BrokerActionRequirement["result_binding"];
    if (entry.result_binding !== undefined) {
      if (!entry.result_binding || typeof entry.result_binding !== "object" || Array.isArray(entry.result_binding)) return [];
      const rawBinding = entry.result_binding as Record<string, unknown>;
      if (typeof rawBinding.result_field !== "string" || !BROKER_ACTION_FIELD.test(rawBinding.result_field)
        || typeof rawBinding.content_field !== "string" || !BROKER_ACTION_FIELD.test(rawBinding.content_field)) return [];
      resultBinding = {
        result_field: rawBinding.result_field,
        content_field: rawBinding.content_field,
      };
    }
    let resultDigestBinding: BrokerActionRequirement["result_digest_binding"];
    if (entry.result_digest_binding !== undefined) {
      if (!entry.result_digest_binding || typeof entry.result_digest_binding !== "object" || Array.isArray(entry.result_digest_binding)) return [];
      const rawBinding = entry.result_digest_binding as Record<string, unknown>;
      if (typeof rawBinding.result_field !== "string" || !BROKER_ACTION_FIELD.test(rawBinding.result_field)
        || typeof rawBinding.content_field !== "string" || !BROKER_ACTION_FIELD.test(rawBinding.content_field)) return [];
      resultDigestBinding = {
        result_field: rawBinding.result_field,
        content_field: rawBinding.content_field,
      };
    }
    if (evaluateConditions && when) {
      const actual = _dottedField(content, when.field);
      if (!isDeepStrictEqual(actual, when.equals)) return [];
    }
    return [{
      credential_ref: String(entry.credential_ref),
      broker: String(entry.broker),
      action: String(entry.action),
      ...(when ? { when } : {}),
      ...(resultBinding ? { result_binding: resultBinding } : {}),
      ...(resultDigestBinding ? { result_digest_binding: resultDigestBinding } : {}),
    }];
  });
}

function _outputWorkspaceFileRequirements(
  run: ActiveRun,
  nodeId: string,
  port: string,
): WorkspaceFileRequirement[] {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const workflowSpec = node?.extra?.workflow_spec_v1;
  if (!workflowSpec || typeof workflowSpec !== "object" || Array.isArray(workflowSpec)) return [];
  const rawByPort = (workflowSpec as Record<string, unknown>).output_workspace_file_requirements;
  if (!rawByPort || typeof rawByPort !== "object" || Array.isArray(rawByPort)) return [];
  const selected = (rawByPort as Record<string, unknown>)[port];
  if (!Array.isArray(selected)) return [];
  return selected.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if (typeof entry.path_field !== "string" || !BROKER_ACTION_FIELD.test(entry.path_field)
      || typeof entry.sha256_field !== "string" || !BROKER_ACTION_FIELD.test(entry.sha256_field)
      || typeof entry.contract !== "string" || !BROKER_ACTION_NAME.test(entry.contract)) return [];
    const rawBindings = entry.bindings;
    if (rawBindings !== undefined && !Array.isArray(rawBindings)) return [];
    const bindings = (rawBindings as unknown[] | undefined)?.flatMap((binding) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) return [];
      const raw = binding as Record<string, unknown>;
      if (typeof raw.file_field !== "string" || !BROKER_ACTION_FIELD.test(raw.file_field)
        || typeof raw.content_field !== "string" || !BROKER_ACTION_FIELD.test(raw.content_field)) return [];
      return [{ file_field: raw.file_field, content_field: raw.content_field }];
    });
    return [{
      path_field: entry.path_field,
      sha256_field: entry.sha256_field,
      contract: entry.contract,
      ...(typeof entry.max_bytes === "number" ? { max_bytes: entry.max_bytes } : {}),
      ...(bindings?.length ? { bindings } : {}),
    }];
  });
}

function _brokerActionReceipts(run: ActiveRun): BrokerActionReceipt[] {
  const raw = run.brokerState[BROKER_ACTION_RECEIPTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if (![entry.credential_ref, entry.broker, entry.action, entry.node_id, entry.session_id].every((field) => (
      typeof field === "string" && BROKER_ACTION_NAME.test(field)
    )) || typeof entry.recorded_at !== "number" || !Number.isFinite(entry.recorded_at)) return [];
    let boundResults: BrokerActionReceipt["bound_results"];
    if (entry.bound_results !== undefined) {
      if (!entry.bound_results || typeof entry.bound_results !== "object" || Array.isArray(entry.bound_results)) return [];
      const entries = Object.entries(entry.bound_results as Record<string, unknown>);
      if (entries.length > 8 || entries.some(([field, result]) => !BROKER_ACTION_FIELD.test(field) || !_boundedBrokerResult(result))) return [];
      boundResults = Object.fromEntries(entries) as BrokerActionReceipt["bound_results"];
    }
    const canonicalHandoff = _boundedCanonicalHandoff(entry.canonical_handoff);
    if (entry.canonical_handoff !== undefined && canonicalHandoff === undefined) return [];
    return [{
      credential_ref: String(entry.credential_ref),
      broker: String(entry.broker),
      action: String(entry.action),
      node_id: String(entry.node_id),
      session_id: String(entry.session_id),
      recorded_at: entry.recorded_at,
      ...(boundResults ? { bound_results: boundResults } : {}),
      ...(canonicalHandoff !== undefined ? { canonical_handoff: canonicalHandoff } : {}),
    }];
  });
}

export function recordActiveRunBrokerActionSuccess(input: {
  run_id: string;
  node_id: string;
  session_id: string;
  credential_ref: string;
  broker: string;
  action: string;
  result?: unknown;
}): void {
  const run = store.get(input.run_id);
  if (!run || run.status !== "active") throw new Error("Broker action receipt run is not active");
  const requirements = _outputBrokerActionRequirements(run, input.node_id).filter((requirement) => (
    requirement.credential_ref === input.credential_ref
    && requirement.broker === input.broker
    && requirement.action === input.action
  ));
  if (requirements.length === 0) return;
  const session = run.nodeSessions.get(input.node_id);
  if (!session || session.sessionId !== input.session_id) {
    throw new Error("Broker action receipt session is stale");
  }
  const receipt: BrokerActionReceipt = {
    credential_ref: input.credential_ref,
    broker: input.broker,
    action: input.action,
    node_id: input.node_id,
    session_id: input.session_id,
    recorded_at: Date.now(),
    ...(() => {
      const boundResults = Object.fromEntries(requirements.flatMap((requirement) => {
        const field = requirement.result_binding?.result_field ?? requirement.result_digest_binding?.result_field;
        if (!field) return [];
        const value = _dottedField(input.result, field);
        return _boundedBrokerResult(value) ? [[field, value] as const] : [];
      }));
      return Object.keys(boundResults).length > 0 ? { bound_results: boundResults } : {};
    })(),
    ...(() => {
      const canonicalHandoff = _boundedCanonicalHandoff(_dottedField(input.result, "review_decision"));
      return canonicalHandoff === undefined ? {} : { canonical_handoff: canonicalHandoff };
    })(),
  };
  const receipts = _brokerActionReceipts(run).filter((entry) => !(
    entry.node_id === receipt.node_id
    && entry.session_id === receipt.session_id
    && entry.credential_ref === receipt.credential_ref
    && entry.broker === receipt.broker
    && entry.action === receipt.action
  ));
  run.brokerState[BROKER_ACTION_RECEIPTS_KEY] = [...receipts, receipt].slice(-64);
  writeRunMetadata(input.run_id, serializeRunMetadata(run));
}

export function getActiveRunBrokerState(runId: string, key: string): unknown {
  const run = store.get(runId);
  if (!run || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) return undefined;
  return run.brokerState[key] === undefined ? undefined : structuredClone(run.brokerState[key]);
}

export function setActiveRunBrokerState(runId: string, key: string, value: unknown): void {
  const run = store.get(runId);
  if (!run || run.status !== "active") throw new Error("Broker state run is not active");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new Error("Broker state key is invalid");
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > 64 * 1024) {
    throw new Error("Broker state exceeds 64 KiB");
  }
  run.brokerState[key] = structuredClone(value);
  writeRunMetadata(runId, serializeRunMetadata(run));
}

export function getCurrentNodeSession(runId: string, nodeId: string): NodeSessionState | undefined {
  const run = store.get(runId);
  if (!run || !run.dagRun.nodeStates.has(nodeId)) return undefined;
  return _ensureNodeSession(run, nodeId);
}

function _reviewEvidenceEnabled(run: ActiveRun, nodeId: string): boolean {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const workflowSpec = node?.extra?.workflow_spec_v1;
  if (workflowSpec && typeof workflowSpec === "object" && !Array.isArray(workflowSpec)) {
    const spec = workflowSpec as Record<string, unknown>;
    if (spec.review_evidence === true) return true;
    const capabilities = spec.capabilities;
    if (Array.isArray(capabilities) && capabilities.includes("runtime_evidence")) return true;
  }
  return Boolean(run.contracts?.review_evidence === true);
}

/** True when this node is declared to own durable review evidence. */
export function isReviewEvidenceNode(runId: string, nodeId: string): boolean {
  const run = store.get(runId);
  return run ? _reviewEvidenceEnabled(run, nodeId) : false;
}

function _reviewEvidenceContext(
  run: ActiveRun,
  nodeId: string,
  attempt?: number,
): ReviewEvidenceIdentity | undefined {
  if (!_reviewEvidenceEnabled(run, nodeId)) return undefined;
  const actor = getDagActorByNode(run.runId, nodeId);
  const session = run.nodeSessions.get(nodeId);
  if (!actor || !session) return undefined;
  return {
    runId: run.runId,
    reviewer: actor.actor_id,
    nodeId,
    sessionId: session.sessionId,
    roundId: run.currentRound.round_id,
    generation: actor.generation,
    attempt: attempt ?? (run.counters.corrections[nodeId] ?? 0) + 1,
  };
}

function _refreshReviewEvidenceProjection(
  run: ActiveRun,
  nodeId: string,
  evidenceContext: ReviewEvidenceIdentity,
): void {
  try {
    // Select only the authoritative node/session/round/generation fence.
    // Aggregating run/reviewer rows would leak stale dispatch evidence into
    // correction and downstream ReviewEvidenceState mailboxes.
    const projection = buildReviewEvidenceProjectionFor(evidenceContext);
    if (!projection) return;
    run.dagRun.mailboxes.get(nodeId)?.set("review_evidence", [projection]);
    writeReviewEvidenceProjectionFile(evidenceContext);
    if (projection.projection_truncated) {
      emit("dag:review_evidence_projection_truncated", {
        runId: run.runId,
        nodeId,
        omittedFindings: projection.omitted_findings,
        omittedDiagnostics: projection.omitted_diagnostics,
      });
    }
    // Deliver the same bounded projection to downstream command nodes whose
    // ReviewEvidenceState inputs normalize persisted accepted evidence. This
    // must happen before correction-exhaustion returns so the final failed
    // attempt remains visible to the review gate.
    for (const edge of run.dagRun.graph.edges) {
      if (edge.from_node !== nodeId || !edge.to_node || edge.label === "after_dep") continue;
      const target = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === edge.to_node);
      const targetSpec = target?.extra?.workflow_spec_v1;
      if (!targetSpec || typeof targetSpec !== "object" || Array.isArray(targetSpec)) continue;
      const inputContracts = (targetSpec as Record<string, unknown>).input_contracts;
      if (!inputContracts || typeof inputContracts !== "object" || Array.isArray(inputContracts)) continue;
      for (const [portName, contract] of Object.entries(inputContracts as Record<string, unknown>)) {
        if (contract !== "ReviewEvidenceState") continue;
        run.dagRun.mailboxes.get(edge.to_node)?.set(portName, [projection]);
      }
    }
  } catch {
    // Evidence projection is best-effort and never blocks correction.
  }
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

export interface DagActorLiveFallbackConsumption {
  run_id: string;
  previous_round_id: string;
  round_id: string;
  command_ids: string[];
  actor_ids: string[];
}

function _liveFallbackIdempotencyKey(command: DagActorLiveCommandRecord): string {
  return `live-fallback-${createHash("sha256").update(command.command_id).digest("hex")}`;
}

/**
 * Consume at most the earliest unresolved command for each Actor. The command
 * remains queued in the live table until the linked round command actually
 * hands off, which makes crash recovery and the applied/completed lifecycle
 * observable without treating prompt socket writes as delivery.
 */
export function consumeDagActorLiveCommandFallbacksAtBoundary(
  runId: string,
): DagActorLiveFallbackConsumption | undefined {
  const run = store.get(runId);
  if (!run || run.status !== "waiting" || run.currentRound.status !== "waiting") return undefined;
  const actorsById = new Map(listDagActors(runId).map((actor) => [actor.actor_id, actor]));
  const awaitNode = run.currentRound.await_node_id
    ? run.dagRun.graph.nodes.find((node) => node.node_id === run.currentRound.await_node_id)
    : undefined;
  if (!awaitNode || awaitNode.node_type !== "await_command_gateway") return undefined;
  const configuredTargets = awaitNode.gateway_config?.target_actors;
  const allowedTargets = configuredTargets && configuredTargets.length > 0
    ? new Set(configuredTargets)
    : undefined;
  const terminal = new Set(["completed", "rejected", "failed", "superseded", "cancelled"]);
  const selectedActors = new Set<string>();
  const candidates: DagActorLiveCommandRecord[] = [];

  for (const command of listOutstandingDagActorLiveCommands(runId)) {
    if (terminal.has(command.status) || selectedActors.has(command.actor_id)) continue;
    const actor = actorsById.get(command.actor_id);
    if (!actor) {
      transitionDagActorLiveCommand({
        command_id: command.command_id,
        status: "superseded",
        reason: "logical Actor no longer exists at fallback boundary",
      });
      continue;
    }
    if (actor.generation !== command.target_generation) {
      transitionDagActorLiveCommand({
        command_id: command.command_id,
        status: "superseded",
        reason: `Actor generation advanced to ${actor.generation} before fallback consumption`,
      });
      continue;
    }

    // delivered/applied commands block later sequence numbers until their
    // terminal status arrives; only queued commands can enter round fallback.
    selectedActors.add(command.actor_id);
    if (command.status !== "queued") continue;
    if (
      allowedTargets
      && !allowedTargets.has(actor.actor_id)
      && !allowedTargets.has(actor.node_id)
    ) {
      markDagActorLiveCommandFallback({
        command_id: command.command_id,
        reason: `await_command ${awaitNode.node_id} does not target this Actor`,
      });
      continue;
    }
    if (candidates.length < MAX_LIVE_FALLBACK_ACTORS_PER_ROUND) candidates.push(command);
  }
  if (candidates.length === 0) return undefined;

  const previousRoundId = run.currentRound.round_id;
  const resumed = resumeWaitingActiveRun(runId, {
    expected_round_id: previousRoundId,
    commands: candidates.map((command) => ({
      actor_id: command.actor_id,
      command_id: command.command_id,
      idempotency_key: _liveFallbackIdempotencyKey(command),
      payload: command.payload,
    })),
  });
  for (const command of candidates) {
    const current = getDagActorLiveCommand(command.command_id);
    if (current?.status !== "queued") continue;
    markDagActorLiveCommandFallback({
      command_id: command.command_id,
      reason: `consumed by durable round ${resumed.roundId}`,
    });
  }
  return {
    run_id: runId,
    previous_round_id: previousRoundId,
    round_id: resumed.roundId,
    command_ids: candidates.map((command) => command.command_id),
    actor_ids: candidates.map((command) => command.actor_id),
  };
}

export function consumeRecoveredDagActorLiveCommandFallbacks(): DagActorLiveFallbackConsumption[] {
  const consumed: DagActorLiveFallbackConsumption[] = [];
  for (const run of store.values()) {
    if (run.status !== "waiting") continue;
    const result = consumeDagActorLiveCommandFallbacksAtBoundary(run.runId);
    if (result) consumed.push(result);
  }
  return consumed;
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
    terminateDagActorLiveCommands({
      run_id: run.runId,
      status: "cancelled",
      reason: `run ${status} before live command completion`,
      transitioned_at: closedAt,
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
  const isDynamicFanoutChild = node?.extra?.dynamic_fanout !== undefined;
  const terminalFailureRoute = !isDynamicFanoutChild && run.dagRun.graph.edges.some((edge) =>
    edge.from_node === nodeId &&
    edge.to_node === "" &&
    (edge.terminal_outcome === "failure" ||
      (edge.terminal_outcome === undefined && isFailurePort(edge.from_port)))
  );
  if (terminalFailureRoute) {
    return abortActiveRun(runId, reason);
  }
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

function _isRejectedHandoff(value: unknown): value is { port: string; content: unknown } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).port === "string"
    && Object.prototype.hasOwnProperty.call(value, "content"),
  );
}

function _correctionPrompt(
  nodeId: string,
  reason: string,
  attempt: number,
  maxAttempts: number,
  outputPorts: string[],
  successPorts: string[],
  failurePorts: string[],
  outputContracts: Record<string, { contract: string; schema: unknown }>,
  workspaceFileContracts: Record<string, Array<WorkspaceFileRequirement & { schema: unknown }>>,
  brokerRequirements: BrokerActionRequirement[],
  brokerReceipts: BrokerActionReceipt[],
  rejectedHandoff?: { port: string; content: unknown },
): string {
  const declaredPorts = outputPorts.length > 0 ? outputPorts.join(", ") : "done";
  const contractGuidance = Object.keys(outputContracts).length > 0
    ? [
        "The handoff tool call shape is {\"port\":\"<declared port>\",\"content\":<value matching that port schema>}. Put contract fields only inside content.",
        `Exact output contracts by port (JSON Schema): ${JSON.stringify(outputContracts)}`,
      ]
    : [];
  const workspaceEvidenceGuidance = Object.keys(workspaceFileContracts).length > 0
    ? [
        `Exact workspace evidence requirements by port: ${JSON.stringify(workspaceFileContracts)}`,
        "If the previous error is a DAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT, inspect and repair only the declared evidence JSON file under .homerail; do not edit source files, rerun completed tests, or repeat external side effects. Recompute the file SHA-256 after the repair.",
      ]
    : [];
  const brokerActions = Array.from(new Set(brokerRequirements.map(
    (requirement) => `${requirement.credential_ref}/${requirement.broker}/${requirement.action}`,
  )));
  const existingReceipts = brokerReceipts.map((receipt) => ({
    credential_ref: receipt.credential_ref,
    broker: receipt.broker,
    action: receipt.action,
    ...(receipt.bound_results ? { bound_results: receipt.bound_results } : {}),
    ...(receipt.canonical_handoff !== undefined
      ? { canonical_handoff: redactTelemetry(receipt.canonical_handoff) }
      : {}),
  }));
  const brokerGuidance = brokerActions.length > 0
    ? [
        "Correction mode permits only declared credential_broker_call verification actions and the final handoff tool call. Do not use any built-in tools or other DAG tools.",
        `Broker verification actions available when required by the corrected output: ${brokerActions.join(", ")}.`,
        ...(existingReceipts.length > 0 ? [
          `Valid durable broker receipts already exist for this exact node session: ${JSON.stringify(existingReceipts)}.`,
          "Reuse the receipt bound_results verbatim in the corrected handoff. Do not repeat an already successful side-effecting broker action.",
        ] : []),
        "If a read-only verification action returns a complete handoff object such as review_decision, use that object verbatim as handoff content.",
        "A digest-bound content field must stay value-identical to the array/object submitted to the successful broker action; do not discard non-actionable entries. Repeat a read-only verification action when necessary to obtain a final canonical result.",
        "If the corrected output triggers one of those requirements and no valid receipt exists, call that declared broker action before the handoff. Otherwise call handoff directly.",
      ]
    : ["Correction mode permits only the handoff tool. Do not repeat investigation, file changes, or other side effects."];
  const rejectedHandoffGuidance = rejectedHandoff === undefined
    ? []
    : (() => {
        let encoded: string;
        try {
          encoded = JSON.stringify(redactTelemetry(rejectedHandoff));
        } catch {
          encoded = JSON.stringify({ port: rejectedHandoff.port, content: "[unserializable]" });
        }
        const bounded = encoded.length <= 24_000
          ? encoded
          : `${encoded.slice(0, 24_000)}...[truncated]`;
        return [
          `Previous rejected handoff (redacted; repair this value instead of reconstructing it from memory): ${bounded}`,
          "Preserve valid evidence and findings from the rejected content unless the authoritative error specifically requires changing them.",
        ];
      })();
  return [
    `Correction attempt ${attempt}/${maxAttempts} for DAG node ${nodeId}.`,
    `Previous attempt ended without a valid DAG handoff: ${reason}`,
    `Declared output ports for this node: ${declaredPorts}.`,
    `Preferred success ports: ${successPorts.length > 0 ? successPorts.join(", ") : "none declared"}.`,
    `Failure ports: ${failurePorts.length > 0 ? failurePorts.join(", ") : "none declared"}.`,
    ...contractGuidance,
    ...workspaceEvidenceGuidance,
    ...rejectedHandoffGuidance,
    "A contract or transport error from the previous attempt is not a failure of the original task. Retry a preferred success port when the original work is complete.",
    "Use a failure port only when the original task itself cannot complete; never use it merely to report this correction error.",
    "Treat that error as authoritative. Preserve required field names and JSON array/object/number types exactly.",
    "Reuse completed evidence when it is available in the original inputs or current workspace.",
    ...brokerGuidance,
    "Never print a pseudo-tool call as prose, XML, or JSON. Invoke the SDK tool itself.",
    "Finish by calling the handoff tool exactly once with one declared output port and contract-valid content. Do not end with prose.",
  ].join("\n");
}

export function requestNodeCorrection(
  runId: string,
  nodeId: string,
  reason: string,
  diagnosticsOrRejectedHandoff?: unknown,
  explicitRejectedHandoff?: { port: string; content: unknown },
): NodeCorrectionResult {
  const legacyRejectedHandoff = explicitRejectedHandoff === undefined
    && _isRejectedHandoff(diagnosticsOrRejectedHandoff)
    ? diagnosticsOrRejectedHandoff
    : undefined;
  const rejectedHandoff = explicitRejectedHandoff ?? legacyRejectedHandoff;
  const diagnostics = legacyRejectedHandoff === undefined
    ? diagnosticsOrRejectedHandoff
    : undefined;
  const run = store.get(runId);
  if (!run) return { status: "unavailable", reason: `Unknown run: ${runId}` };
  if (run.status !== "active") return { status: "unavailable", reason: `Run is not active: ${run.status}` };
  if (!run.dagRun.nodeStates.has(nodeId)) return { status: "unavailable", reason: `Unknown node: ${nodeId}` };

  const maxAttempts = run.limits.max_corrections_per_node;
  const previousAttempts = run.counters.corrections[nodeId] ?? 0;
  const failedAttempt = previousAttempts + 1;
  const evidenceContext = _reviewEvidenceContext(run, nodeId, failedAttempt);
  if (evidenceContext) {
    try {
      recordAttemptDiagnostic({
        identity: evidenceContext,
        diagnostic: sanitizeAttemptDiagnostic(diagnostics, {
          attempt: evidenceContext.attempt,
          failure_reason: reason,
        }),
      });
    } catch {
      // Evidence persistence is best-effort and never blocks correction.
    }
    _refreshReviewEvidenceProjection(run, nodeId, evidenceContext);
  }
  if (previousAttempts >= maxAttempts) {
    return { status: "exhausted", run, attempts: previousAttempts, maxAttempts };
  }

  const before = _snapshotNodeStates(run);
  const attempt = previousAttempts + 1;
  const outputEdges = run.dagRun.graph.edges
    .filter((edge) => edge.from_node === nodeId && edge.label !== "after_dep");
  const outputPorts = Array.from(new Set(outputEdges.map((edge) => edge.from_port))).sort();
  const successPorts = Array.from(new Set(outputEdges
    .filter((edge) => edge.condition !== "on_failure" && !isFailurePort(edge.from_port))
    .map((edge) => edge.from_port))).sort();
  const failurePorts = Array.from(new Set(outputEdges
    .filter((edge) => edge.condition === "on_failure" || isFailurePort(edge.from_port))
    .map((edge) => edge.from_port))).sort();
  const outputContracts = Object.fromEntries(outputPorts.flatMap((port) => {
    const contract = _outputContract(run, nodeId, port);
    return contract?.schema !== undefined
      ? [[port, { contract: contract.contract, schema: contract.schema }] as const]
      : [];
  }));
  const workspaceFileContracts = Object.fromEntries(outputPorts.flatMap((port) => {
    const requirements = _outputWorkspaceFileRequirements(run, nodeId, port).flatMap((requirement) => {
      const schema = run.contracts?.[requirement.contract];
      return schema === undefined ? [] : [{ ...requirement, schema }];
    });
    return requirements.length > 0 ? [[port, requirements] as const] : [];
  }));
  const brokerRequirements = _outputBrokerActionRequirements(run, nodeId);
  const sessionId = run.nodeSessions.get(nodeId)?.sessionId;
  const brokerActionKeys = new Set(brokerRequirements.map(
    (requirement) => `${requirement.credential_ref}\u0000${requirement.broker}\u0000${requirement.action}`,
  ));
  const brokerReceipts = sessionId === undefined
    ? []
    : _brokerActionReceipts(run).filter((receipt) => (
        receipt.node_id === nodeId
        && receipt.session_id === sessionId
        && brokerActionKeys.has(`${receipt.credential_ref}\u0000${receipt.broker}\u0000${receipt.action}`)
      ));
  run.counters.corrections[nodeId] = attempt;
  const mailbox = run.dagRun.mailboxes.get(nodeId);
  if (mailbox) {
    const values = mailbox.get("correction") ?? [];
    values.push(_correctionPrompt(
      nodeId,
      reason,
      attempt,
      maxAttempts,
      outputPorts,
      successPorts,
      failurePorts,
      outputContracts,
      workspaceFileContracts,
      brokerRequirements,
      brokerReceipts,
      rejectedHandoff,
    ));
    mailbox.set("correction", values);
  }
  resetSkippedSuccessDescendants(run.dagRun, nodeId);
  run.dagRun.nodeStates.set(nodeId, "READY");
  run.dagRun.handoffedNodes.delete(nodeId);
  // A correction retries the same logical dispatch after a rejected handoff; it
  // is not a new review round. Keep the provider session (and any broker action
  // receipts fenced to it) active. A successful handoff still marks the session
  // completed, so the next real re-entry of a dispatch-scoped node gets a fresh
  // context through _prepareNodeSessionForDispatch.
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
  const sessionId = run.nodeSessions.get(nodeId)?.sessionId;
  const canonicalReceipt = sessionId === undefined
    ? undefined
    : [..._brokerActionReceipts(run)].reverse().find((receipt) => (
        receipt.node_id === nodeId
        && receipt.session_id === sessionId
        && receipt.canonical_handoff !== undefined
      ));
  if (canonicalReceipt?.canonical_handoff !== undefined) {
    try {
      const next = handoffActiveRun(runId, nodeId, port, canonicalReceipt.canonical_handoff);
      if (next) {
        emit("dag:node_auto_handoff", {
          runId,
          nodeId,
          port,
          reason,
          source: "canonical_broker_result",
        });
      }
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return abortActiveRun(
        runId,
        `canonical broker handoff failed after correction exhaustion: ${message}`,
        nodeId,
      );
    }
  }
  if (
    _outputContract(run, nodeId, port)
    || _outputBrokerActionRequirements(run, nodeId, port).length > 0
    || _outputWorkspaceFileRequirements(run, nodeId, port).length > 0
  ) {
    return failActiveRun(runId, nodeId, `handoff failed after correction exhaustion: ${reason}`);
  }
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
    const advancedActor = advanceDagActorGeneration({
      run_id: runId,
      actor_id: actor.actor_id,
      expected_generation: actor.generation,
      expected_version: actor.version,
      session_id: nextSession.sessionId,
      attempt: nextSession.attempt,
      checkpoint_ref: fork.entryUuid,
    });
    terminateDagActorLiveCommands({
      run_id: runId,
      actor_id: advancedActor.actor_id,
      status: "superseded",
      reason: `Actor generation advanced to ${advancedActor.generation} for checkpoint resume`,
    });
    resetDagLiveSurfaceActorBody({
      run_id: advancedActor.run_id,
      actor_id: advancedActor.actor_id,
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
  evidence?: ReviewEvidenceWriteInput,
): ActiveRun | undefined {
  const run = store.get(runId);
  if (!run) return undefined;
  if (run.status !== "active") throw new Error(`Run ${runId} is not active`);
  const fencedCommand = _validateHandoffTransportFence(run, fromNode, fence);
  const sourceState = getNodeState(run.dagRun, fromNode);
  if (sourceState === "COMPLETED" || sourceState === "FAILED" || sourceState === "CANCELLED" || sourceState === "SKIPPED") {
    throw new Error(`Node ${fromNode} cannot hand off from terminal state ${sourceState}`);
  }
  // Persist bounded accepted findings/coverage before final contract
  // validation so a later incomplete or contract-invalid handoff cannot erase
  // evidence that was already accepted. The success path below re-persists
  // with the authoritative transport diagnostic; both writes are idempotent.
  const submission = evidence?.submission ?? extractReviewEvidence(content);
  if (submission) {
    try {
      const evidenceContext = _reviewEvidenceContext(run, fromNode);
      if (evidenceContext) {
        recordReviewHandoffEvidence(evidenceContext, { submission });
        writeReviewEvidenceProjectionFile(evidenceContext);
      }
    } catch {
      // Evidence persistence is best-effort and never blocks handoff processing.
    }
  }
  _assertHandoffPreconditions(run, fromNode, port, content, true);
  const handedOffNode = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
  const effectiveContent = handedOffNode
    ? _materializeManagerOwnedFanoutCommit(run, handedOffNode, port, content)
    : content;
  if (effectiveContent !== content) {
    _assertHandoffPreconditions(run, fromNode, port, effectiveContent, true);
  }
  const workspaceEvidence = _validatedWorkspaceFiles(run, fromNode, port, effectiveContent);
  const evidenceSessionId = workspaceEvidence.length > 0
    ? run.nodeSessions.get(fromNode)?.sessionId
    : undefined;
  if (workspaceEvidence.length > 0 && !evidenceSessionId) {
    throw new Error(`DAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT ${fromNode}.${port}: producer has no active session`);
  }
  const mutableBefore = _snapshotMutableRun(run);
  const before = _snapshotNodeStates(run);
  const readyBefore = new Set(getReadyNodes(run.dagRun));
  let transition!: ReturnType<typeof handoff>;
  const evidenceArtifacts: RunArtifactRecord[] = [];
  try {
    getDb().transaction(() => {
      run.counters.handoffs++;

      for (const evidence of workspaceEvidence) {
        evidenceArtifacts.push(publishWorkspaceEvidenceArtifact({
          run_id: runId,
          node_id: fromNode,
          session_id: evidenceSessionId!,
          port,
          declared_path: evidence.declared_path,
          workspace_path: evidence.path,
          contract: evidence.contract,
          sha256: evidence.sha256,
          bytes: evidence.bytes,
        }));
      }

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
        const liveCommand = getDagActorLiveCommand(fencedCommand.command_id);
        if (
          liveCommand
          && liveCommand.run_id === runId
          && liveCommand.actor_id === fencedCommand.actor_id
          && liveCommand.target_generation === fencedCommand.target_generation
          && (liveCommand.status === "queued" || liveCommand.status === "delivered")
        ) {
          transitionDagActorLiveCommand({
            command_id: liveCommand.command_id,
            status: "applied",
          });
        }
      }
      transition = handoff(run.dagRun, fromNode, port, effectiveContent);
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
        content: effectiveContent,
        timestamp: Date.now(),
      });
      if (fencedCommand) {
        acknowledgeDagActorCommand({
          command_id: fencedCommand.command_id,
          generation: fencedCommand.target_generation,
        });
        const liveCommand = getDagActorLiveCommand(fencedCommand.command_id);
        if (
          liveCommand
          && liveCommand.run_id === runId
          && liveCommand.actor_id === fencedCommand.actor_id
          && liveCommand.target_generation === fencedCommand.target_generation
          && (liveCommand.status === "queued" || liveCommand.status === "delivered" || liveCommand.status === "applied")
        ) {
          transitionDagActorLiveCommand({
            command_id: liveCommand.command_id,
            status: "completed",
          });
        }
      }
      if (handedOffNode) _recordFanoutChild(run, handedOffNode, port, effectiveContent);
      if (evidence) {
        const evidenceContext = _reviewEvidenceContext(run, fromNode);
        if (evidenceContext) {
          recordReviewHandoffEvidence(evidenceContext, evidence);
          writeReviewEvidenceProjectionFile(evidenceContext);
        }
      }
      writeRunMetadata(runId, serializeRunMetadata(run));
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, mutableBefore);
    throw error;
  }
  _emitNodeStateChanges(run, before);
  for (const artifact of evidenceArtifacts) {
    emit("dag:artifact_ready", {
      runId,
      artifactId: artifact.artifact_id,
      name: artifact.name,
      status: artifact.status,
      sizeBytes: artifact.size_bytes,
      sha256: artifact.sha256,
    });
  }
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
  const surfaceViolation = _requiredSurfaceFinalViolation(run, fromNode, port);
  if (surfaceViolation) throw new Error(surfaceViolation);
  const contractViolation = _handoffContractViolation(run, fromNode, port, content);
  if (contractViolation) throw new Error(contractViolation);
  const brokerRequirementViolation = _handoffBrokerRequirementViolation(run, fromNode, port, content);
  if (brokerRequirementViolation) throw new Error(brokerRequirementViolation);
  const workspaceFileViolation = _handoffWorkspaceFileRequirementViolation(run, fromNode, port, content);
  if (workspaceFileViolation) throw new Error(workspaceFileViolation);
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

export interface ValidatedWorkspaceFile {
  path: string;
  sha256: string;
  contract: string;
  value: unknown;
  artifact_name?: string;
}

interface ValidatedWorkspaceFileBytes extends ValidatedWorkspaceFile {
  declared_path: string;
  bytes: Buffer;
}

function _singleWritableWorkspace(run: ActiveRun, nodeId: string): { relative: string; absolute: string } {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  const runtime = node?.extra?.agent_runtime;
  const access = runtime && typeof runtime === "object" && !Array.isArray(runtime)
    ? (runtime as Record<string, unknown>).workspace_access
    : undefined;
  const writable = access && typeof access === "object" && !Array.isArray(access)
    ? (access as Record<string, unknown>).writable_paths
    : undefined;
  if (!Array.isArray(writable) || writable.length !== 1 || typeof writable[0] !== "string") {
    throw new Error("producer must have exactly one writable workspace path");
  }
  const relative = _fanoutSafeRelativePath(writable[0], "workspace");
  const runRoot = realpathSync(path.resolve(getHomerailHome(), "workspace", ...run.runId.split("/")));
  const absolute = realpathSync(path.resolve(runRoot, ...relative.split("/")));
  if (!_pathIsWithin(runRoot, absolute)) throw new Error("producer workspace escaped the run workspace");
  return { relative, absolute };
}

function _workspaceFilePath(base: string, raw: unknown): { relative: string; absolute: string } {
  const relative = _fanoutSafeRelativePath(raw, "evidence.json");
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error("workspace evidence path does not exist");
    }
    if (stat.isSymbolicLink()) throw new Error("workspace evidence path contains a symbolic link");
  }
  let absolute: string;
  try {
    absolute = realpathSync(current);
  } catch {
    throw new Error("workspace evidence path is unavailable");
  }
  if (!_pathIsWithin(base, absolute)) throw new Error("workspace evidence path escaped the producer workspace");
  if (!lstatSync(absolute).isFile()) throw new Error("workspace evidence is not a regular file");
  return { relative, absolute };
}

function _validatedWorkspaceFiles(
  run: ActiveRun,
  nodeId: string,
  port: string,
  content: unknown,
): ValidatedWorkspaceFileBytes[] {
  const requirements = _outputWorkspaceFileRequirements(run, nodeId, port);
  if (requirements.length === 0) return [];
  const workspace = _singleWritableWorkspace(run, nodeId);
  return requirements.map((requirement) => {
    const declaredPath = _dottedField(content, requirement.path_field);
    const declaredSha256 = _dottedField(content, requirement.sha256_field);
    if (typeof declaredPath !== "string" || typeof declaredSha256 !== "string" || !/^[0-9a-f]{64}$/.test(declaredSha256)) {
      throw new Error(`${requirement.path_field} and ${requirement.sha256_field} must identify a SHA-256-bound file`);
    }
    const evidencePath = _workspaceFilePath(workspace.absolute, declaredPath);
    const bytes = readFileSync(evidencePath.absolute);
    const maxBytes = Math.max(1, Math.floor(requirement.max_bytes ?? 256 * 1024));
    if (bytes.byteLength > maxBytes) throw new Error(`workspace evidence exceeds ${maxBytes} bytes`);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== declaredSha256) throw new Error(`${requirement.sha256_field} does not match workspace evidence bytes`);
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) {
      throw new Error("workspace evidence must be canonical UTF-8 JSON");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("workspace evidence is not valid JSON");
    }
    const schema = run.contracts?.[requirement.contract];
    if (schema === undefined) throw new Error(`workspace evidence contract '${requirement.contract}' is missing`);
    const validation = validateJsonContract(schema, value);
    if (!validation.valid) throw new Error(`workspace evidence contract '${requirement.contract}' failed: ${validation.details}`);
    for (const binding of requirement.bindings ?? []) {
      if (!isDeepStrictEqual(_dottedField(value, binding.file_field), _dottedField(content, binding.content_field))) {
        throw new Error(`workspace evidence ${binding.file_field} must equal handoff ${binding.content_field}`);
      }
    }
    return {
      declared_path: declaredPath,
      path: `${workspace.relative}/${evidencePath.relative}`,
      sha256: actualSha256,
      contract: requirement.contract,
      value,
      bytes,
    };
  });
}

function _handoffWorkspaceFileRequirementViolation(
  run: ActiveRun,
  nodeId: string,
  port: string,
  content: unknown,
): string | undefined {
  try {
    _validatedWorkspaceFiles(run, nodeId, port, content);
    return undefined;
  } catch (error) {
    return `DAG_HANDOFF_WORKSPACE_FILE_REQUIREMENT ${nodeId}.${port}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function getVerifiedRunWorkspaceEvidence(
  runId: string,
  headSha: string,
  contract: string,
): ValidatedWorkspaceFile | undefined {
  const run = store.get(runId);
  if (!run || run.status !== "active") return undefined;
  const snapshot = loadRunSnapshot(runId);
  const artifacts = listRunArtifacts(runId);
  const handoffs = [...(snapshot?.handoffs ?? [])].reverse();
  for (const handoff of handoffs) {
    if (_dottedField(handoff.content, "head_sha") !== headSha) continue;
    const requirements = _outputWorkspaceFileRequirements(run, handoff.fromNode, handoff.port)
      .filter((requirement) => requirement.contract === contract);
    for (const requirement of requirements) {
      const declaredPath = _dottedField(handoff.content, requirement.path_field);
      const declaredSha256 = _dottedField(handoff.content, requirement.sha256_field);
      if (typeof declaredPath !== "string" || typeof declaredSha256 !== "string") continue;
      const artifact = artifacts.find((candidate) => (
        candidate.status === "ready"
        && candidate.sha256 === declaredSha256
        && candidate.source.type === "workspace_evidence"
        && candidate.source.node_id === handoff.fromNode
        && candidate.source.port === handoff.port
        && candidate.source.declared_path === declaredPath
        && candidate.source.contract === contract
        && candidate.source.sha256 === declaredSha256
      ));
      const blobPath = artifact ? getRunArtifactBlobPath(runId, artifact.name) : undefined;
      if (!artifact || !blobPath) continue;
      if (artifact.source.type !== "workspace_evidence") continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(blobPath);
      } catch {
        continue;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== declaredSha256) continue;
      const text = bytes.toString("utf8");
      if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) continue;
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      const schema = run.contracts?.[contract];
      if (schema === undefined || !validateJsonContract(schema, value).valid) continue;
      if (!(requirement.bindings ?? []).every((binding) => isDeepStrictEqual(
        _dottedField(value, binding.file_field),
        _dottedField(handoff.content, binding.content_field),
      ))) continue;
      return {
        path: artifact.source.workspace_path,
        sha256: declaredSha256,
        contract,
        value,
        artifact_name: artifact.name,
      };
    }
    // Compatibility for runs accepted before workspace evidence became durable.
    try {
      const workspaceEvidence = _validatedWorkspaceFiles(run, handoff.fromNode, handoff.port, handoff.content)
        .find((entry) => entry.contract === contract);
      if (workspaceEvidence) return workspaceEvidence;
    } catch {
      // A pre-upgrade workspace may already be gone; try older handoffs.
    }
  }
  return undefined;
}

function _handoffBrokerRequirementViolation(
  run: ActiveRun,
  fromNode: string,
  port: string,
  content: unknown,
): string | undefined {
  const requirements = _outputBrokerActionRequirements(run, fromNode, port, content, true);
  if (requirements.length === 0) return undefined;
  const sessionId = run.nodeSessions.get(fromNode)?.sessionId;
  if (!sessionId) return `DAG_HANDOFF_BROKER_REQUIREMENT_MISSING ${fromNode}.${port}: node has no active session`;
  const receipts = _brokerActionReceipts(run);
  const receiptFor = (requirement: BrokerActionRequirement) => receipts.find((receipt) => (
    receipt.node_id === fromNode
    && receipt.session_id === sessionId
    && receipt.credential_ref === requirement.credential_ref
    && receipt.broker === requirement.broker
    && receipt.action === requirement.action
  ));
  for (const requirement of requirements) {
    const receipt = receiptFor(requirement);
    const actionName = `${requirement.credential_ref}/${requirement.broker}/${requirement.action}`;
    if (!receipt) {
      return `DAG_HANDOFF_BROKER_REQUIREMENT_MISSING ${fromNode}.${port}: ${actionName}`;
    }
    const binding = requirement.result_binding;
    const digestBinding = requirement.result_digest_binding;
    if (!binding && !digestBinding) continue;
    const resultField = binding?.result_field ?? digestBinding!.result_field;
    if (!receipt.bound_results
      || !Object.prototype.hasOwnProperty.call(receipt.bound_results, resultField)) {
      return `DAG_HANDOFF_BROKER_RESULT_MISSING ${fromNode}.${port}: ${actionName} did not return ${resultField}`;
    }
    const expected = binding
      ? _dottedField(content, binding.content_field)
      : createHash("sha256").update(JSON.stringify(_deepSortValue(_dottedField(content, digestBinding!.content_field)))).digest("hex");
    if (!isDeepStrictEqual(
      receipt.bound_results[resultField],
      expected,
    )) {
      const contentField = binding?.content_field ?? digestBinding!.content_field;
      return `DAG_HANDOFF_BROKER_RESULT_MISMATCH ${fromNode}.${port}: ${actionName} ${resultField} must bind ${contentField}`;
    }
  }
  return undefined;
}

function _requiredSurfaceFinalViolation(
  run: ActiveRun,
  fromNode: string,
  port: string,
): string | undefined {
  const matchingEdges = run.dagRun.graph.edges.filter((edge) => (
    edge.from_node === fromNode
    && edge.from_port === port
    && edge.label !== "after_dep"
  ));
  if (isFailurePort(port) || matchingEdges.some((edge) => edge.condition === "on_failure")) {
    return undefined;
  }
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
  if (!node || !_allowedDagTools(node)?.includes("report_surface_state")) return undefined;
  const allowedViewIds = run.agents?.[node.agent]?.allowed_surface_views;
  if (!Array.isArray(allowedViewIds) || allowedViewIds.length !== 1) return undefined;
  const context = getDagRunSkillContext(run.runId, node.agent)?.context;
  if (!context) return undefined;

  const localCounts = new Map<string, number>();
  for (const skill of context.skills) {
    for (const view of skill.visual_profile?.views ?? []) {
      localCounts.set(view.id, (localCounts.get(view.id) ?? 0) + 1);
    }
  }
  const allowedViewId = allowedViewIds[0]!;
  const matches = context.skills.flatMap((skill) => (
    (skill.visual_profile?.views ?? []).filter((view) => (
      allowedViewId === `${skill.id}:${view.id}`
      || (allowedViewId === view.id && localCounts.get(view.id) === 1)
    ))
  ));
  if (matches.length !== 1 || !matches[0]!.data_contract?.required_phases?.length) return undefined;

  const actor = getDagActorByNode(run.runId, fromNode);
  const view = actor ? getDagActorSurfaceView(run.runId, actor.actor_id) : undefined;
  if (actor
    && view?.generation === actor.generation
    && view.round_id === run.currentRound.round_id
    && view.phase === "final") {
    return undefined;
  }
  return `DAG_HANDOFF_SURFACE_INCOMPLETE ${run.runId}/${fromNode}: pinned view '${allowedViewId}' requires an applied final Surface patch in round ${run.currentRound.round_id}`;
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

function _outputContract(
  run: ActiveRun,
  fromNode: string,
  port: string,
): { contract: string; schema?: unknown } | undefined {
  const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === fromNode);
  const workflowSpec = node?.extra?.workflow_spec_v1;
  if (!workflowSpec || typeof workflowSpec !== "object" || Array.isArray(workflowSpec)) return undefined;
  const outputContracts = (workflowSpec as Record<string, unknown>).output_contracts;
  if (!outputContracts || typeof outputContracts !== "object" || Array.isArray(outputContracts)) return undefined;
  const contractName = (outputContracts as Record<string, unknown>)[port];
  if (typeof contractName !== "string" || !contractName) return undefined;
  const schema = run.contracts?.[contractName];
  return { contract: contractName, ...(schema !== undefined ? { schema } : {}) };
}

function _handoffContractViolation(
  run: ActiveRun,
  fromNode: string,
  port: string,
  content: unknown,
): string | undefined {
  const outputContract = _outputContract(run, fromNode, port);
  if (!outputContract) return undefined;
  const { contract: contractName, schema } = outputContract;
  if (schema === undefined) {
    return `DAG_HANDOFF_CONTRACT_VIOLATION ${fromNode}.${port}: contract '${contractName}' is missing`;
  }
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
  if (edge.label === "feedback") return true;
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

  const existingAgentConfig = run.agents?.[node.agent];
  const nextAgentConfig = request.agentConfig
    ? {
        ...request.agentConfig,
        ...(request.agentConfig.skills === undefined && existingAgentConfig?.skills
          ? { skills: [...existingAgentConfig.skills] }
          : {}),
        ...(request.agentConfig.allowed_surface_views === undefined
          && existingAgentConfig?.allowed_surface_views
          ? { allowed_surface_views: [...existingAgentConfig.allowed_surface_views] }
          : {}),
      }
    : undefined;
  const existingSkillContext = getDagRunSkillContext(runId, node.agent);
  if (existingAgentConfig && !existingSkillContext) {
    throw new Error(`DAG run ${runId} agent ${node.agent} is missing its pinned Skill Context`);
  }
  if (request.agentConfig && (request.agentConfig.skills !== undefined || !existingSkillContext)) {
    const resolvedSkillContext = resolveDagWorkerSkillContext({
      agent_id: node.agent,
      skills: nextAgentConfig?.skills ?? [],
    });
    assertDagWorkerSurfaceViewAllowlist({
      agent_id: node.agent,
      context: resolvedSkillContext,
      allowed_surface_views: nextAgentConfig?.allowed_surface_views,
    });
    pinDagRunSkillContext({
      run_id: runId,
      agent_id: node.agent,
      context: resolvedSkillContext,
    });
  } else if (request.agentConfig?.allowed_surface_views !== undefined && existingSkillContext) {
    assertDagWorkerSurfaceViewAllowlist({
      agent_id: node.agent,
      context: existingSkillContext.context,
      allowed_surface_views: nextAgentConfig?.allowed_surface_views,
    });
  }

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
  if (nextAgentConfig) {
    run.agents = { ...(run.agents ?? {}), [node.agent]: nextAgentConfig };
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

function _interventionId(runId: string, actorId: string, idempotencyKey: string): string {
  return `intervention-${createHash("sha256")
    .update(`${runId}\0${actorId}\0${idempotencyKey}`)
    .digest("hex")}`;
}

function _interventionInstruction(intervention: DagActorInterventionRecord): string {
  if (intervention.instruction) return intervention.instruction;
  switch (intervention.operation) {
    case "retry": return "Retry the same objective from the durable actor checkpoint.";
    case "reassign": return "Continue the same objective from the durable actor checkpoint on another available executor.";
    case "checkpoint_fork": return "Continue the same objective from the selected durable actor checkpoint.";
    case "interrupt": return "Stop the current attempt and retain its durable evidence.";
    case "cancel": return "Cancel this actor branch and retain its durable evidence.";
  }
}

function _interventionCommandIdentity(
  intervention: DagActorInterventionRecord,
  generation: number,
): { command_id: string; idempotency_key: string } {
  const digest = createHash("sha256")
    .update(`${intervention.intervention_id}\0${generation}`)
    .digest("hex");
  return {
    command_id: `command-${digest}`,
    idempotency_key: `intervention-${digest}`,
  };
}

function _interventionResult(
  intervention: DagActorInterventionRecord,
  deduplicated: boolean,
): InterveneDagActorResult {
  const control = getDagActorControlState(intervention.run_id, intervention.actor_id);
  return {
    intervention_id: intervention.intervention_id,
    run_id: intervention.run_id,
    actor_id: intervention.actor_id,
    operation: intervention.operation,
    status: intervention.status,
    actor_state: control.actor_state,
    state_token: control.state_token,
    deduplicated,
    created_at: intervention.created_at,
    updated_at: intervention.completed_at ?? intervention.started_at ?? intervention.created_at,
  };
}

function _sendInterventionInterrupt(
  target: DispatchTarget | undefined,
  runId: string,
  nodeId: string,
  intervention: DagActorInterventionRecord,
): void {
  if (target?.state !== "dispatched" || !target.targetType || !target.targetId) return;
  const registryEntry = target.targetType === "worker"
    ? getWorker(target.targetId)
    : getNode(target.targetId);
  const socket = registryEntry?.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({
      type: "inject",
      data: {
        runId,
        nodeId,
        mode: "interrupt",
        instruction: _interventionInstruction(intervention),
      },
    }));
  } catch (error) {
    console.warn(
      `[homerail_manager] failed to interrupt previous DAG actor attempt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function _releaseActorLeaseForIntervention(
  actor: DagActorRecord,
  operation: DagActorInterventionOperation,
  now: number,
): void {
  const lease = getDagActorLease({ run_id: actor.run_id, actor_id: actor.actor_id });
  if (!lease) return;
  let current = lease;
  if (current.state === "leased") {
    current = releaseDagActorLease({
      run_id: current.run_id,
      actor_id: current.actor_id,
      lease_generation: current.lease_generation,
      target_type: current.target_type!,
      target_id: current.target_id!,
      expected_version: current.version,
      now,
    });
  }
  if (operation === "cancel" && current.state !== "retired") {
    retireDagActorLease({
      run_id: current.run_id,
      actor_id: current.actor_id,
      expected_version: current.version,
      now,
    });
  }
}

function _applyPersistedDagActorIntervention(
  requested: DagActorInterventionRecord,
): DagActorInterventionRecord {
  if (requested.status === "applied" || requested.status === "failed") return requested;
  const run = store.get(requested.run_id);
  if (!run || run.status !== "active") {
    throw new DagActorInterventionRuntimeError(
      "run_not_active",
      `DAG run ${requested.run_id} is not active for actor intervention`,
    );
  }
  const actor = getDagActor(requested.run_id, requested.actor_id);
  if (!actor) {
    throw new DagActorInterventionRuntimeError(
      "actor_not_found",
      `Unknown DAG actor: ${requested.run_id}/${requested.actor_id}`,
    );
  }
  if (
    actor.generation !== requested.expected_actor_generation
    || actor.version !== requested.expected_actor_version
  ) {
    throw new DagActorInterventionConflictError(
      actor.generation !== requested.expected_actor_generation
        ? "actor_generation_conflict"
        : "actor_version_conflict",
      `DAG actor ${requested.run_id}/${requested.actor_id} changed before the queued intervention could apply`,
    );
  }

  const applying = requested.status === "queued"
    ? markDagActorInterventionApplying({
        intervention_id: requested.intervention_id,
        from_generation: actor.generation,
      }).intervention
    : requested;
  const before = _snapshotMutableRun(run);
  const beforeStates = _snapshotNodeStates(run);
  const oldTarget = findDispatchTarget(run.runId, actor.node_id);
  const now = Math.max(Date.now(), applying.created_at, actor.updated_at);
  let terminalizedRun = false;

  let completed: DagActorInterventionRecord;
  try {
    completed = getDb().transaction(() => {
      const current = getDagActor(applying.run_id, applying.actor_id);
      if (!current) throw new Error(`Unknown DAG actor: ${applying.run_id}/${applying.actor_id}`);
      if (
        current.generation !== applying.expected_actor_generation
        || current.version !== applying.expected_actor_version
      ) {
        throw new DagActorInterventionConflictError(
          current.generation !== applying.expected_actor_generation
            ? "actor_generation_conflict"
            : "actor_version_conflict",
          `DAG actor ${applying.run_id}/${applying.actor_id} changed while applying intervention`,
        );
      }

      const checkpoint = applying.operation === "checkpoint_fork"
        ? getDagActorCheckpoint({
            run_id: current.run_id,
            actor_id: current.actor_id,
            checkpoint_version: applying.checkpoint_version!,
          })
        : writeDagActorCheckpoint({
            run_id: current.run_id,
            actor_id: current.actor_id,
            checkpoint: buildDagActorCheckpoint({
              runId: run.runId,
              actor: current,
              roundId: run.currentRound.round_id,
              capturedAt: now,
            }),
            expected_checkpoint_version: getLatestDagActorCheckpoint({
              run_id: current.run_id,
              actor_id: current.actor_id,
            })?.checkpoint_version ?? 0,
            now,
          });
      if (!checkpoint) {
        throw new Error(
          `Portable checkpoint ${applying.checkpoint_version} is unavailable for actor ${applying.actor_id}`,
        );
      }

      const sourceCommand = listDagActorCommands({
        run_id: current.run_id,
        actor_id: current.actor_id,
        round_id: run.currentRound.round_id,
      }).find((command) => (
        command.target_generation === current.generation
        && command.status !== "cancelled"
        && command.status !== "failed"
      ));
      const resumesActor = applying.operation === "retry"
        || applying.operation === "reassign"
        || applying.operation === "checkpoint_fork";
      if (resumesActor && run.currentRound.ordinal > 1 && !sourceCommand) {
        throw new DagActorInterventionRuntimeError(
          "command_fence_missing",
          `DAG actor ${current.run_id}/${current.actor_id} has no current-round command to supersede`,
        );
      }

      cancelUnclaimedDagActorCommands({
        run_id: current.run_id,
        actor_id: current.actor_id,
        completed_at: now,
        reason: { code: "actor_intervention", operation: applying.operation },
      });
      _releaseActorLeaseForIntervention(current, applying.operation, now);

      const nextSession: NodeSessionState = {
        sessionId: _newSessionId(run.runId, current.node_id),
        attempt: current.attempt + 1,
        ...(current.session_id ? { parentSessionId: current.session_id } : {}),
        resumeInstruction: _interventionInstruction(applying),
        status: applying.operation === "interrupt" || applying.operation === "cancel"
          ? "cancelled"
          : "active",
      };
      const nextActor = advanceDagActorGeneration({
        run_id: current.run_id,
        actor_id: current.actor_id,
        expected_generation: current.generation,
        expected_version: current.version,
        session_id: nextSession.sessionId,
        attempt: nextSession.attempt,
        checkpoint_ref: `portable:${checkpoint.checkpoint_version}`,
      });
      terminateDagActorLiveCommands({
        run_id: nextActor.run_id,
        actor_id: nextActor.actor_id,
        status: "superseded",
        reason: `Actor generation advanced to ${nextActor.generation} for ${applying.operation}`,
        transitioned_at: now,
      });
      _persistNodeSession(run, nextActor.node_id, nextSession);

      if (resumesActor && sourceCommand) {
        const identity = _interventionCommandIdentity(applying, nextActor.generation);
        createDagActorCommand({
          ...identity,
          run_id: nextActor.run_id,
          actor_id: nextActor.actor_id,
          round_id: run.currentRound.round_id,
          target_generation: nextActor.generation,
          payload: {
            kind: "actor_intervention",
            intervention_id: applying.intervention_id,
            operation: applying.operation,
            instruction: _interventionInstruction(applying),
            source_command_id: sourceCommand.command_id,
            source_payload: sourceCommand.payload,
          },
        });
      }

      if (applying.operation === "interrupt" || applying.operation === "cancel") {
        failNode(run.dagRun, nextActor.node_id, {
          code: "actor_intervention",
          operation: applying.operation,
        });
        run.dagRun.nodeStates.set(nextActor.node_id, "CANCELLED");
      } else {
        _resetActorBranchForIntervention({
          run,
          actor: nextActor,
          intervention_id: applying.intervention_id,
          operation: applying.operation,
          instruction: _interventionInstruction(applying),
        });
      }

      if (
        applying.operation === "reassign"
        && oldTarget?.state === "dispatched"
        && oldTarget.targetType
        && oldTarget.targetId
      ) {
        upsertDagActorDispatchExclusion({
          run_id: run.runId,
          actor_id: nextActor.actor_id,
          node_id: nextActor.node_id,
          target_type: oldTarget.targetType,
          target_id: oldTarget.targetId,
          intervention_id: applying.intervention_id,
          created_at: now,
        });
      } else if (applying.operation !== "reassign") {
        clearDagActorDispatchExclusion({ run_id: run.runId, node_id: nextActor.node_id });
      }

      supersedeDagLiveSurfaceForIntervention({
        run_id: run.runId,
        actor_id: nextActor.actor_id,
        intervention_id: applying.intervention_id,
        created_at: now,
      });
      if (
        (applying.operation === "interrupt" || applying.operation === "cancel")
        && isRunTerminal(run.dagRun)
      ) {
        run.status = "cancelled";
        run.completedAt = now;
        _persistTerminalRun(run, "cancelled");
        terminalizedRun = true;
      } else {
        writeRunMetadata(run.runId, serializeRunMetadata(run));
      }
      return completeDagActorIntervention({
        intervention_id: applying.intervention_id,
        from_generation: current.generation,
        to_generation: nextActor.generation,
        resulting_actor_version: nextActor.version,
        completed_at: now,
      }).intervention;
    }).immediate();
  } catch (error) {
    _restoreMutableRun(run, before);
    try {
      failDagActorIntervention({
        intervention_id: applying.intervention_id,
        failure: { message: error instanceof Error ? error.message : String(error) },
      });
    } catch {
      // Preserve the original failure; a concurrent recovery may have completed the intervention.
    }
    throw error;
  }

  if (completed.operation === "reassign") excludeCurrentDispatchTarget(run.runId, actor.node_id);
  else clearDispatchTarget(run.runId, actor.node_id);
  _sendInterventionInterrupt(oldTarget, run.runId, actor.node_id, completed);
  _emitNodeStateChanges(run, beforeStates);
  emit("dag:actor_intervention_applied", {
    runId: run.runId,
    actorId: actor.actor_id,
    operation: completed.operation,
    interventionId: completed.intervention_id,
  });
  if (terminalizedRun) {
    _emitStatusUpdate(run);
    emit("dag:run_cancelled", { runId: run.runId });
    deprovisionProvisionedForRun(run.runId);
  }
  return completed;
}

/** Queue and apply a branch-local Actor intervention without exposing physical execution identity. */
export function interveneActiveRunActor(
  runId: string,
  request: InterveneDagActorRequest,
): InterveneDagActorResult {
  const existing = findDagActorInterventionByKey({
    run_id: runId,
    actor_id: request.actor_id,
    idempotency_key: request.idempotency_key,
  });
  if (existing) {
    const verified = createDagActorIntervention({
      intervention_id: existing.intervention_id,
      run_id: existing.run_id,
      actor_id: existing.actor_id,
      operation: request.operation,
      instruction: request.instruction,
      expected_actor_generation: existing.expected_actor_generation,
      expected_actor_version: existing.expected_actor_version,
      idempotency_key: request.idempotency_key,
      checkpoint_version: request.checkpoint_version,
    }).intervention;
    const current = verified.status === "queued" || verified.status === "applying"
      ? _applyPersistedDagActorIntervention(verified)
      : verified;
    return _interventionResult(current, true);
  }

  const run = store.get(runId);
  if (!run || run.status !== "active") {
    throw new DagActorInterventionRuntimeError("run_not_active", `DAG run ${runId} is not active`);
  }
  const actor = getDagActor(runId, request.actor_id);
  if (!actor) {
    throw new DagActorInterventionRuntimeError("actor_not_found", `Unknown DAG actor: ${runId}/${request.actor_id}`);
  }
  if (getDagActorLease({ run_id: runId, actor_id: actor.actor_id })?.state === "retired") {
    throw new DagActorInterventionRuntimeError(
      "actor_retired",
      `DAG actor ${runId}/${actor.actor_id} is retired and cannot accept another intervention`,
    );
  }
  const control = getDagActorControlState(runId, actor.actor_id);
  if (control.state_token !== request.expected_state_token.trim()) {
    throw new DagActorInterventionRuntimeError(
      "state_token_conflict",
      `DAG actor ${runId}/${actor.actor_id} state changed before intervention`,
    );
  }
  const oldTarget = request.operation === "reassign"
    ? findDispatchTarget(runId, actor.node_id)
    : undefined;
  const queued = getDb().transaction(() => {
    const created = createDagActorIntervention({
      intervention_id: _interventionId(runId, actor.actor_id, request.idempotency_key),
      run_id: runId,
      actor_id: actor.actor_id,
      operation: request.operation,
      instruction: request.instruction,
      expected_actor_generation: actor.generation,
      expected_actor_version: actor.version,
      idempotency_key: request.idempotency_key,
      checkpoint_version: request.checkpoint_version,
    });
    if (
      created.changed
      && oldTarget?.state === "dispatched"
      && oldTarget.targetType
      && oldTarget.targetId
    ) {
      upsertDagActorDispatchExclusion({
        run_id: runId,
        actor_id: actor.actor_id,
        node_id: actor.node_id,
        target_type: oldTarget.targetType,
        target_id: oldTarget.targetId,
        intervention_id: created.intervention.intervention_id,
      });
    }
    return created;
  }).immediate();
  const applied = _applyPersistedDagActorIntervention(queued.intervention);
  return _interventionResult(applied, queued.deduplicated);
}

/** Resume interventions durably queued before a Manager crash. */
export function recoverDagActorInterventions(): DagActorInterventionRecoverySummary {
  const summary: DagActorInterventionRecoverySummary = { applied: [], failed: [], skipped: [] };
  const runsNeedingOrphanDemotion = new Set<string>();
  const rows = getDb().prepare(`
    SELECT intervention_id, run_id FROM dag_actor_interventions
    WHERE status IN ('queued', 'applying')
    ORDER BY created_at, intervention_id
  `).all() as Array<{ intervention_id: string; run_id: string }>;
  for (const row of rows) {
    if (!store.has(row.run_id)) {
      summary.skipped.push(row.intervention_id);
      continue;
    }
    try {
      const record = getDagActorIntervention(row.intervention_id);
      if (!record) {
        summary.skipped.push(row.intervention_id);
        continue;
      }
      const applied = _applyPersistedDagActorIntervention(record);
      if (applied.status === "applied") summary.applied.push(applied.intervention_id);
      else {
        summary.failed.push(applied.intervention_id);
        runsNeedingOrphanDemotion.add(row.run_id);
      }
    } catch (error) {
      try {
        failDagActorIntervention({
          intervention_id: row.intervention_id,
          failure: { message: error instanceof Error ? error.message : String(error) },
        });
      } catch {
        // The apply path may already have recorded a bounded failure.
      }
      summary.failed.push(row.intervention_id);
      runsNeedingOrphanDemotion.add(row.run_id);
    }
  }
  for (const runId of runsNeedingOrphanDemotion) {
    const run = store.get(runId);
    if (!run || run.status !== "active") continue;
    const demoted = _applyOrphanedNodeDemotion(run);
    if (demoted.length === 0) continue;
    writeRunMetadata(run.runId, serializeRunMetadata(run));
    _emitStatusUpdate(run);
  }
  for (const exclusion of listDagActorDispatchExclusions()) {
    const run = store.get(exclusion.run_id);
    const actor = getDagActor(exclusion.run_id, exclusion.actor_id);
    const intervention = getDagActorIntervention(exclusion.intervention_id);
    if (
      !run
      || run.status !== "active"
      || !actor
      || actor.node_id !== exclusion.node_id
      || run.dagRun.nodeStates.get(actor.node_id) !== "READY"
      || intervention?.status !== "applied"
      || intervention.operation !== "reassign"
      || intervention.to_generation !== actor.generation
    ) {
      clearDagActorDispatchExclusion({ run_id: exclusion.run_id, node_id: exclusion.node_id });
      continue;
    }
    restoreDispatchExclusion(
      exclusion.run_id,
      exclusion.node_id,
      exclusion.target_type,
      exclusion.target_id,
    );
  }
  return summary;
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
    node.node_type === "broker_gateway" ||
    node.node_type === "approval_gateway" ||
    node.node_type === "state_gateway" ||
    node.node_type === "fanout_gateway" ||
    node.node_type === "await_command_gateway";
}

const inFlightBrokerGateways = new Set<string>();

function _brokerGatewayInput(run: ActiveRun, node: DAGGraphNode): Record<string, unknown> {
  const config = node.gateway_config;
  const inputs = _nodeInputs(run.dagRun, node.node_id);
  const selectedValues = config?.input ? inputs[config.input] : undefined;
  const selected = selectedValues && selectedValues.length > 0
    ? selectedValues[selectedValues.length - 1]
    : _firstInputValue(inputs);
  const mapped: Record<string, unknown> = {};
  if (config?.input_map) {
    for (const [key, field] of Object.entries(config.input_map)) {
      mapped[key] = _fieldValue(selected, field);
    }
  } else {
    const value = _fieldValue(selected, config?.input_field);
    if (value !== undefined) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("broker gateway selected input must be an object");
      }
      Object.assign(mapped, value as Record<string, unknown>);
    }
  }
  if (config?.static_input) Object.assign(mapped, structuredClone(config.static_input));
  return mapped;
}

function _startBrokerGateway(
  run: ActiveRun,
  node: DAGGraphNode,
  dispatcher: DAGDispatcher,
): boolean {
  const key = `${run.runId}:${node.node_id}`;
  if (inFlightBrokerGateways.has(key)) return false;
  const config = node.gateway_config;
  if (!config?.credential_ref || !config.broker || !config.action) {
    throw new Error("broker gateway configuration is incomplete");
  }
  const input = _brokerGatewayInput(run, node);
  const request: DagCredentialBrokerCallRequest = {
    request_id: randomUUID(),
    run_id: run.runId,
    node_id: node.node_id,
    session_id: `manager-broker-${node.node_id}-${randomUUID()}`,
    credential_ref: config.credential_ref,
    broker: config.broker,
    action: config.action,
    input,
  };
  startNode(run.dagRun, node.node_id);
  inFlightBrokerGateways.add(key);
  writeRunMetadata(run.runId, serializeRunMetadata(run));
  emit("dag:gateway_executed", {
    runId: run.runId,
    nodeId: node.node_id,
    gatewayType: node.node_type,
    phase: "started",
    broker: config.broker,
    action: config.action,
  });
  void import("./credential-broker.js")
    .then(({ executeManagerCredentialBrokerCall }) => executeManagerCredentialBrokerCall(request))
    .then((result) => {
      const current = getActiveRun(run.runId);
      if (!current || current.status !== "active" || current.dagRun.nodeStates.get(node.node_id) !== "RUNNING") return;
      const port = result.ok ? config.result_port || "result" : config.error_port || "error";
      const payload = result.ok ? result.result : { ok: false, error: result.error };
      handoffActiveRun(run.runId, node.node_id, port, payload);
      emit("dag:gateway_executed", {
        runId: run.runId,
        nodeId: node.node_id,
        gatewayType: node.node_type,
        phase: "completed",
        port,
      });
      dispatchReadyNodesUntilStable(run.runId, dispatcher);
    })
    .catch((error) => {
      const current = getActiveRun(run.runId);
      if (!current || current.status !== "active" || current.dagRun.nodeStates.get(node.node_id) !== "RUNNING") return;
      failActiveRun(
        run.runId,
        node.node_id,
        `broker gateway execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      inFlightBrokerGateways.delete(key);
    });
  return true;
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
  const initialPrompt = run.initialPrompt;
  if (initialPrompt !== undefined && initialPrompt.trim().length > 0) {
    const payload = _structuredGatewayValue(initialPrompt);
    const targets = run.runInputTargets && run.runInputTargets.length > 0
      ? run.runInputTargets
      : run.dagRun.graph.nodes
        .filter((node) => !run.dagRun.graph.edges.some((edge) =>
          edge.to_node === node.node_id && edge.label === "after_dep"
        ))
        .map((node) => ({ node: node.node_id, port: "prompt" }));
    for (const target of targets) {
      if (!resetNodeIds.has(target.node)) continue;
      const inputs = carryover.get(target.node) ?? [];
      inputs.push({
        fromNode: "$run.input",
        port: target.port,
        value: structuredClone(payload),
      });
      carryover.set(target.node, inputs);
    }
  }
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

function _ephemeralActorInputPorts(run: ActiveRun): Set<string> {
  const ports = new Set(["command", "correction", "intervention", "checkpoint_resume"]);
  for (const node of run.dagRun.graph.nodes) {
    if (node.node_type !== "await_command_gateway") continue;
    ports.add(node.gateway_config?.command_port || "command");
  }
  return ports;
}

function _branchInterventionResetNodeIds(run: ActiveRun, actorNodeId: string): string[] {
  const reset = new Set([actorNodeId]);
  const queue = [actorNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of run.dagRun.graph.edges) {
      if (edge.from_node !== current || !edge.to_node || reset.has(edge.to_node)) continue;
      const target = run.dagRun.graph.nodes.find((node) => node.node_id === edge.to_node);
      if (!target || !_isGatewayNode(target)) continue;
      reset.add(target.node_id);
      queue.push(target.node_id);
    }
  }
  return Array.from(reset).sort();
}

function _resetActorBranchForIntervention(input: {
  run: ActiveRun;
  actor: DagActorRecord;
  intervention_id: string;
  operation: string;
  instruction: string;
}): { resetNodeIds: string[]; readyNodeIds: string[] } {
  const resetNodeIds = _branchInterventionResetNodeIds(input.run, input.actor.node_id);
  const resetSet = new Set(resetNodeIds);
  const carryover = _roundCarryoverInputs(input.run, resetSet);
  const previousMailbox = input.run.dagRun.mailboxes.get(input.actor.node_id);
  if (previousMailbox) {
    const actorCarryover = carryover.get(input.actor.node_id) ?? [];
    const ephemeralPorts = _ephemeralActorInputPorts(input.run);
    for (const [port, values] of previousMailbox.entries()) {
      if (ephemeralPorts.has(port) || actorCarryover.some((entry) => entry.port === port)) continue;
      const value = values.at(-1);
      if (value !== undefined) {
        actorCarryover.push({ fromNode: "__previous_actor_input__", port, value });
      }
    }
    if (actorCarryover.length > 0) carryover.set(input.actor.node_id, actorCarryover);
  }
  const reset = resetNodesForRound(input.run.dagRun, {
    resetNodeIds,
    carryoverInputs: carryover,
    commandInputs: new Map([[input.actor.node_id, {
      port: "intervention",
      value: {
        intervention_id: input.intervention_id,
        operation: input.operation,
        instruction: input.instruction,
      },
    }]]),
  });
  return { resetNodeIds, readyNodeIds: reset.readyNodes };
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

function _unwrapSingleJoinValue(input: unknown): unknown {
  const structured = _structuredGatewayValue(input);
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return structured;
  const envelope = structured as Record<string, unknown>;
  if (
    !Array.isArray(envelope.values)
    || envelope.values.length !== 1
    || envelope.total !== 1
    || typeof envelope.passed !== "boolean"
    || (envelope.mode !== "all" && envelope.mode !== "any" && envelope.mode !== "n_of_m")
  ) return structured;
  return envelope.values[0];
}

function _whileGatewayResult(
  run: ActiveRun,
  node: DAGGraphNode,
  input: unknown,
): { port: string; payload: Record<string, unknown> } {
  const config = node.gateway_config;
  const normalizedInput = config?.unwrap_single_join_value === true
    ? _unwrapSingleJoinValue(input)
    : input;
  const selected = _fieldValue(normalizedInput, config?.field);
  const matched = _gatewayComparison(selected, config?.operator, config?.value);
  const iteration = run.counters.gateway_iterations[node.node_id] ?? 0;
  const maxIterations = Math.max(1, Math.floor(config?.max_iterations ?? 3));
  if (matched) {
    _terminateLoopSource(run, node.node_id);
    return {
      port: config?.done_port || "done",
      payload: { input: normalizedInput, iteration, max_iterations: maxIterations, matched: true },
    };
  }
  if (iteration >= maxIterations) {
    _terminateLoopSource(run, node.node_id);
    return {
      port: config?.exhausted_port || "exhausted",
      payload: { input: normalizedInput, iteration, max_iterations: maxIterations, matched: false, exhausted: true },
    };
  }
  run.counters.gateway_iterations[node.node_id] = iteration + 1;
  return {
    port: config?.continue_port || "continue",
    payload: { input: normalizedInput, iteration: iteration + 1, max_iterations: maxIterations, matched: false },
  };
}

function _commandAllowlist(): Set<string> {
  const configured = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST ?? "";
  return new Set(configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

const RUN_WORKSPACE_CWD = "$run_workspace";
const RUN_INPUT_ARGUMENT_PREFIX = "$run_input/";

function _pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function _pathsReferToSameLocation(left: string, right: string): boolean {
  if (path.relative(left, right) === "" && path.relative(right, left) === "") return true;
  try {
    const leftStat = statSync(left, { bigint: true });
    const rightStat = statSync(right, { bigint: true });
    return leftStat.ino !== 0n && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
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
  if (command[0].startsWith(RUN_INPUT_ARGUMENT_PREFIX)) {
    return {
      port: config?.failure_port || "failed",
      payload: { ok: false, error: "$run_input cannot be used as a command executable" },
    };
  }
  let resolvedCommand: string[];
  try {
    resolvedCommand = command.map((part, index) => {
      if (index === 0 || !part.startsWith(RUN_INPUT_ARGUMENT_PREFIX)) return part;
      const logicalName = part.slice(RUN_INPUT_ARGUMENT_PREFIX.length);
      if (!logicalName || logicalName.includes("/") || logicalName.includes("\\")) {
        throw new Error("$run_input arguments must reference one logical input name");
      }
      return dagRunInputPath(run.runId, logicalName);
    });
  } catch (error) {
    return {
      port: config?.failure_port || "failed",
      payload: { ok: false, error: error instanceof Error ? error.message : String(error) },
    };
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
  const result = spawnSync(resolvedCommand[0], resolvedCommand.slice(1), {
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
      // 与其他 state 操作保持同一载荷契约（operation/updated/record/previous），
      // 前端 StateResultCard 依赖这两个字段区分"已写入"与"未变更"
      payload: {
        operation,
        updated: reservation.admitted,
        ...reservation,
        limit,
        record: reservation.record ?? null,
        input: stateInput,
      },
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
  invocation: number;
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

function _fanoutSafeRelativePath(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim().replace(/\\/g, "/") : fallback;
  const segments = value.split("/");
  if (path.isAbsolute(value) || segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`fanout workspace path '${value}' is unsafe`);
  }
  return segments.join("/");
}

function _fanoutChildWorkspacePath(node: DAGGraphNode, state: FanoutRuntimeState, index: number): string {
  const root = _fanoutSafeRelativePath(node.gateway_config?.workspace_root, "workers");
  return `${root}/${node.node_id}/inv_${String(state.invocation).padStart(4, "0")}/item_${String(index + 1).padStart(4, "0")}`;
}

function _fanoutRepositoryPath(node: DAGGraphNode): string {
  return node.gateway_config?.repository_path === "."
    ? "."
    : _fanoutSafeRelativePath(node.gateway_config?.repository_path, "repo");
}

function _fanoutWorkerRuntime(
  node: DAGGraphNode,
  state: FanoutRuntimeState,
  index: number,
  childId: string,
  workspacePath?: string,
): Record<string, unknown> {
  const configured = node.gateway_config?.worker_policy;
  const policy = configured && typeof configured === "object" && !Array.isArray(configured)
    ? structuredClone(configured as Record<string, unknown>)
    : {};
  const replacements: Record<string, string> = {
    "{{fanout_parent}}": node.node_id,
    "{{fanout_invocation}}": String(state.invocation),
    "{{fanout_index}}": String(index + 1),
    "{{fanout_child}}": childId,
    ...(workspacePath ? { "{{fanout_workspace}}": workspacePath } : {}),
  };
  const replacePath = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    return Object.entries(replacements).reduce((result, [token, replacement]) => result.split(token).join(replacement), value);
  };
  const rawAccess = policy.workspace_access;
  const access = rawAccess && typeof rawAccess === "object" && !Array.isArray(rawAccess)
    ? structuredClone(rawAccess as Record<string, unknown>)
    : {};
  const managerReadOnlyPaths = ["input"];
  if (workspacePath) {
    const declaredWritablePaths = Array.isArray(access.writable_paths)
      ? access.writable_paths.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (declaredWritablePaths.length !== 1 || declaredWritablePaths[0] !== "{{fanout_workspace}}") {
      throw new Error("isolated git worktree fanout must explicitly declare {{fanout_workspace}} as its writable path");
    }
    access.writable_paths = [workspacePath];
    // Every isolated fan-out child snapshots the shared run workspace. Sibling
    // worktrees may legitimately change while this child is running, so exclude
    // only those Manager-derived paths from mutation ownership accounting. This
    // runtime-only field is deliberately not accepted by WorkflowSpec v1.
    access.snapshot_exclude_paths = state.items
      .map((_item, siblingIndex) => siblingIndex === index
        ? undefined
        : _fanoutChildWorkspacePath(node, state, siblingIndex))
      .filter((entry): entry is string => typeof entry === "string");
    const repositoryPath = _fanoutRepositoryPath(node);
    // The primary checkout is Manager-owned and shares its common Git object
    // store with every linked worktree. Marking it read-only also causes the
    // Worker snapshotter to ignore only that checkout's root `.git` directory,
    // so a sibling's Manager-owned commit cannot look like a worker mutation.
    // Nested `.git` directories created inside this child's writable worktree
    // remain visible to the snapshot policy.
    if (repositoryPath !== ".") managerReadOnlyPaths.push(repositoryPath);
  } else {
    access.writable_paths = Array.isArray(access.writable_paths) ? access.writable_paths.map(replacePath) : [];
  }
  access.readonly_paths = Array.from(new Set([
    ...managerReadOnlyPaths,
    ...(Array.isArray(access.readonly_paths) ? access.readonly_paths.map(replacePath).filter((entry): entry is string => typeof entry === "string") : []),
  ])).sort();
  policy.workspace_access = access;
  if (policy.builtin_tool_policy === "backend_native") {
    if (policy.allowed_builtin_tools !== undefined) {
      throw new Error("fanout builtin_tool_policy is mutually exclusive with allowed_builtin_tools");
    }
  } else {
    policy.allowed_builtin_tools = Array.isArray(policy.allowed_builtin_tools) ? policy.allowed_builtin_tools : [];
  }
  policy.allowed_dag_tools = Array.isArray(policy.allowed_dag_tools) ? policy.allowed_dag_tools : ["handoff"];
  policy.credentials = Array.isArray(policy.credentials) ? policy.credentials : [];
  return policy;
}

function _portableGitMetadataPath(from: string, to: string): string {
  const relative = path.relative(from, to);
  if (!relative || path.isAbsolute(relative) || /[\r\n\0]/u.test(relative)) {
    throw new Error("fanout git worktree metadata path is not portable");
  }
  return relative.split(path.sep).join("/");
}

function _findWorktreeAdminDirectory(worktreesRoot: string, target: string): string | undefined {
  for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(worktreesRoot, entry.name);
    if (_pathsReferToSameLocation(candidate, target)) return candidate;
  }
  return undefined;
}

function _replaceExistingFileContents(target: string, content: string): void {
  // Git for Windows marks the linked worktree `.git` pointer hidden. Opening a
  // hidden file with CREATE_ALWAYS (Node's default `writeFileSync(path, ...)`
  // behaviour) fails with EPERM even after its read-only bit is cleared. Open
  // the already-validated file in place, then truncate and rewrite it through
  // the same handle so its Windows attributes are preserved.
  const fd = openSync(target, "r+");
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}

function _makeFanoutGitWorktreeRelocatable(repository: string, target: string): void {
  const worktreeGitFile = path.join(target, ".git");
  const match = /^gitdir:\s*(.+?)\s*$/u.exec(readFileSync(worktreeGitFile, "utf8"));
  if (!match?.[1]) throw new Error("fanout git worktree metadata is malformed");

  // Git for Windows can expand an 8.3 path (for example RUNNER~1) while
  // Node's portable realpath keeps the caller's spelling. Resolve every side
  // through the native filesystem identity before enforcing containment and
  // the bidirectional linked-worktree binding.
  const commonGitDir = realpathSync.native(path.join(repository, ".git"));
  const portableWorktreesRoot = path.join(repository, ".git", "worktrees");
  const worktreesRoot = realpathSync.native(portableWorktreesRoot);
  const referencedAdminGitDir = path.resolve(target, match[1]);
  const adminGitDir = realpathSync.native(referencedAdminGitDir);
  if (!_pathsReferToSameLocation(worktreesRoot, realpathSync.native(path.join(commonGitDir, "worktrees")))) {
    throw new Error("fanout git worktree metadata root is not bound to the declared repository");
  }

  // Enumerate the repository's own worktree entries instead of rebuilding a
  // path from Git's host-specific spelling. Git for Windows may write an 8.3
  // alias into the worktree pointer; readdir returns the actual directory name
  // under HomeRail's run-workspace spelling. Finding the same filesystem object
  // also proves that the referenced admin directory is a direct child of this
  // repository's worktree metadata root.
  const portableAdminGitDir = _findWorktreeAdminDirectory(portableWorktreesRoot, adminGitDir);
  if (!portableAdminGitDir) {
    throw new Error("fanout git worktree metadata escaped the repository or is not bound to it");
  }

  const adminBackPointer = path.join(portableAdminGitDir, "gitdir");
  const backPointerValue = readFileSync(adminBackPointer, "utf8").trim();
  const backPointer = path.resolve(portableAdminGitDir, backPointerValue);
  // On Windows, realpathSync.native() can return EPERM when the target is the
  // linked worktree's ordinary `.git` pointer file. Compare the paths directly
  // and fall back to their stat identity instead; this still requires both
  // sides of the Git link to reference the exact same filesystem object.
  if (!_pathsReferToSameLocation(backPointer, worktreeGitFile)) {
    throw new Error("fanout git worktree metadata is not bidirectionally bound");
  }

  // Linked-worktree metadata generated by Git contains absolute host paths.
  // Workers see the whole run workspace mounted at /workspace, so those paths
  // are invalid in the container. Relative pointers preserve the binding in
  // both namespaces and if the retained run workspace is moved as a unit.
  // Git for Windows marks linked-worktree pointer files read-only. Clear that
  // attribute only after validating both ends of the binding. Rewrite the
  // existing files in place because Windows also marks the `.git` pointer hidden.
  chmodSync(worktreeGitFile, 0o600);
  chmodSync(adminBackPointer, 0o600);
  _replaceExistingFileContents(worktreeGitFile, `gitdir: ${_portableGitMetadataPath(target, portableAdminGitDir)}\n`);
  _replaceExistingFileContents(adminBackPointer, `${_portableGitMetadataPath(portableAdminGitDir, worktreeGitFile)}\n`);

  const verified = spawnManagerGitSync(target, ["rev-parse", "--is-inside-work-tree"], {
    timeout: 10_000,
  });
  if (verified.status !== 0 || verified.error || String(verified.stdout).trim() !== "true") {
    const detail = String(verified.stderr || verified.error?.message || "unknown error").trim().slice(0, 1_000);
    throw new Error(`fanout git worktree portable metadata verification failed: ${detail}`);
  }
}

function _prepareFanoutGitWorktree(
  run: ActiveRun,
  node: DAGGraphNode,
  state: FanoutRuntimeState,
  index: number,
): string | undefined {
  if (node.gateway_config?.workspace_strategy !== "isolated_git_worktree") return undefined;
  const workspacePath = _fanoutChildWorkspacePath(node, state, index);
  const resolved = _commandGatewayCwd(run, RUN_WORKSPACE_CWD);
  if ("error" in resolved) throw new Error(resolved.error);
  const runWorkspace = resolved.cwd;
  const repositoryPath = _fanoutRepositoryPath(node);
  const repository = path.resolve(runWorkspace, repositoryPath);
  const target = path.resolve(runWorkspace, workspacePath);
  if (!_pathIsWithin(runWorkspace, repository) || !_pathIsWithin(runWorkspace, target)) {
    throw new Error("fanout git worktree path escaped the run workspace");
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const existing = spawnManagerGitSync(target, ["rev-parse", "--is-inside-work-tree"], {
    timeout: 10_000,
  });
  if (existing.status === 0 && String(existing.stdout).trim() === "true") {
    _makeFanoutGitWorktreeRelocatable(repository, target);
    return workspacePath;
  }
  const selectedRevision = node.gateway_config?.revision_field
    ? _fieldValue(state.context, node.gateway_config.revision_field)
    : undefined;
  const revision = typeof selectedRevision === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(selectedRevision)
    ? selectedRevision.toLowerCase()
    : "HEAD";
  if (revision !== "HEAD") {
    const local = spawnManagerGitSync(repository, ["cat-file", "-e", `${revision}^{commit}`], {
      timeout: 10_000,
    });
    if (local.status !== 0) {
      const fetched = spawnManagerGitSync(repository, ["fetch", "--no-tags", "origin", revision], {
        timeout: 60_000,
        maxBuffer: 256_000,
      });
      if (fetched.status !== 0 || fetched.error) {
        const detail = String(fetched.stderr || fetched.error?.message || "unknown error").trim().slice(0, 1_000);
        throw new Error(`fanout git revision fetch failed: ${detail}`);
      }
    }
  }
  const created = spawnManagerGitSync(repository, ["worktree", "add", "--detach", target, revision], {
    timeout: 60_000,
    maxBuffer: 256_000,
  });
  if (created.status !== 0 || created.error) {
    const detail = String(created.stderr || created.error?.message || "unknown error").trim().slice(0, 1_000);
    throw new Error(`fanout git worktree creation failed: ${detail}`);
  }
  _makeFanoutGitWorktreeRelocatable(repository, target);
  return workspacePath;
}

function _spawnFanoutChildren(run: ActiveRun, node: DAGGraphNode, state: FanoutRuntimeState): void {
  const config = node.gateway_config;
  const maxParallelism = Math.max(1, Math.floor(config?.max_parallelism ?? 1));
  while (state.active.length < maxParallelism && state.next_index < state.items.length) {
    const index = state.next_index++;
    const childId = state.invocation === 1
      ? `${node.node_id}__item_${String(index + 1).padStart(4, "0")}`
      : `${node.node_id}__inv_${String(state.invocation).padStart(4, "0")}__item_${String(index + 1).padStart(4, "0")}`;
    const workspacePath = _prepareFanoutGitWorktree(run, node, state, index);
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
        dynamic_fanout: { parent_node: node.node_id, index, invocation: state.invocation },
        agent_runtime: _fanoutWorkerRuntime(node, state, index, childId, workspacePath),
        ...(config?.result_contract ? {
          workflow_spec_v1: {
            input_contracts: {},
            output_contracts: { result: config.result_contract },
            ...(Array.isArray(config.result_required_broker_actions) ? {
              output_broker_requirements: { result: config.result_required_broker_actions },
            } : {}),
            ...(Array.isArray(config.result_required_workspace_files) ? {
              output_workspace_file_requirements: { result: config.result_required_workspace_files },
            } : {}),
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
      ...(workspacePath === undefined ? {} : { workspace_path: workspacePath }),
    }]);
    state.active.push(childId);
  }
  writeRunMetadata(run.runId, serializeRunMetadata(run));
}

function _startFanout(run: ActiveRun, node: DAGGraphNode): boolean {
  const config = node.gateway_config;
  const resultEvidenceConfigured = (
    (Array.isArray(config?.result_required_broker_actions) && config.result_required_broker_actions.length > 0)
    || (Array.isArray(config?.result_required_workspace_files) && config.result_required_workspace_files.length > 0)
  );
  if (resultEvidenceConfigured && !config?.result_contract) {
    abortActiveRun(
      run.runId,
      "DAG_FANOUT_RESULT_CONTRACT_REQUIRED fanout result evidence requirements require result_contract",
      node.node_id,
    );
    return false;
  }
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
  const invocation = (run.counters.fanout_invocations[node.node_id] ?? 0) + 1;
  run.counters.fanout_invocations[node.node_id] = invocation;
  const state: FanoutRuntimeState = { invocation, items, context, next_index: 0, active: [], results: [] };
  node.extra = { ...(node.extra ?? {}), fanout_runtime: state as unknown as Record<string, unknown> };
  run.dagRun.nodeStates.set(node.node_id, "RUNNING");
  try {
    _spawnFanoutChildren(run, node, state);
  } catch (error) {
    abortActiveRun(run.runId, error instanceof Error ? error.message : String(error), node.node_id);
    return false;
  }
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

interface FanoutGitResultContext {
  workspace: string;
  git: (args: string[], timeout?: number) => ReturnType<typeof spawnSync>;
}

function _fanoutGitResultContext(
  run: ActiveRun,
  parent: DAGGraphNode,
  state: FanoutRuntimeState,
  index: number,
  content: unknown,
): FanoutGitResultContext {
  const validation = parent.gateway_config?.result_git_commit;
  if (!validation) throw new Error("DAG_FANOUT_GIT_RESULT_INVALID result_git_commit is not configured");
  if (parent.gateway_config?.workspace_strategy !== "isolated_git_worktree") {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID result_git_commit requires isolated_git_worktree");
  }
  const reportedWorkspace = _fieldValue(content, validation.workspace_field);
  const expectedWorkspace = _fanoutChildWorkspacePath(parent, state, index);
  if (reportedWorkspace !== expectedWorkspace) {
    throw new Error(
      `DAG_FANOUT_GIT_RESULT_INVALID workspace '${String(reportedWorkspace ?? "")}' does not match '${expectedWorkspace}'`,
    );
  }
  const resolved = _commandGatewayCwd(run, RUN_WORKSPACE_CWD);
  if ("error" in resolved) throw new Error(`DAG_FANOUT_GIT_RESULT_INVALID ${resolved.error}`);
  const runWorkspace = resolved.cwd;
  const workspace = path.resolve(runWorkspace, expectedWorkspace);
  if (!_pathIsWithin(runWorkspace, workspace)) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID workspace escaped the run workspace");
  }
  const repositoryPath = parent.gateway_config?.repository_path === "."
    ? "."
    : _fanoutSafeRelativePath(parent.gateway_config?.repository_path, "repo");
  const repository = path.resolve(runWorkspace, repositoryPath);
  const git = (args: string[], timeout = 10_000) => spawnManagerGitSync(workspace, args, {
    timeout,
    maxBuffer: 256_000,
  });
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
  let resolvedTopLevel: string;
  let resolvedCommonDir: string;
  let resolvedGitDir: string;
  let expectedTopLevel: string;
  let expectedCommonDir: string;
  try {
    // Git for Windows can expand an 8.3 path (for example RUNNER~1) while
    // Node's portable realpath keeps the caller's spelling. Native realpath
    // gives both sides one OS-resolved identity before the security checks.
    resolvedTopLevel = realpathSync.native(String(topLevel.stdout).trim());
    resolvedCommonDir = realpathSync.native(String(commonDir.stdout).trim());
    resolvedGitDir = realpathSync.native(String(gitDir.stdout).trim());
    expectedTopLevel = realpathSync.native(workspace);
    expectedCommonDir = realpathSync.native(path.join(repository, ".git"));
  } catch {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID isolated worktree Git metadata could not be resolved");
  }
  if (
    topLevel.status !== 0 || commonDir.status !== 0 || gitDir.status !== 0
    || !_pathsReferToSameLocation(resolvedTopLevel, expectedTopLevel)
    || !_pathsReferToSameLocation(resolvedCommonDir, expectedCommonDir)
    || !_pathIsWithin(path.join(expectedCommonDir, "worktrees"), resolvedGitDir)
  ) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID isolated worktree Git binding is invalid");
  }
  return { workspace, git };
}

function _assertFanoutGitCommitResult(
  run: ActiveRun,
  parent: DAGGraphNode,
  state: FanoutRuntimeState,
  index: number,
  content: unknown,
): void {
  const validation = parent.gateway_config?.result_git_commit;
  if (!validation) return;
  const commitSha = _fieldValue(content, validation.commit_field);
  if (typeof commitSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha)) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID commit SHA is missing or malformed");
  }
  const { git } = _fanoutGitResultContext(run, parent, state, index, content);
  const exists = git(["cat-file", "-e", `${commitSha.toLowerCase()}^{commit}`]);
  if (exists.status !== 0 || exists.error) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID commit does not exist in the isolated worktree");
  }
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0 || head.error || String(head.stdout).trim().toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID commit is not the isolated worktree HEAD");
  }
  if (validation.require_clean !== false) {
    const status = git(["status", "--porcelain"]);
    if (status.status !== 0 || status.error || String(status.stdout).trim()) {
      throw new Error("DAG_FANOUT_GIT_RESULT_INVALID isolated worktree has uncommitted changes");
    }
  }
}

function _fanoutChildSucceeded(parent: DAGGraphNode, port: string, content: unknown): boolean {
  const config = parent.gateway_config;
  const selected = _fieldValue(content, config?.success_field);
  const successValues = config?.success_values ?? [true, "pass", "passed", "success", "approved", "yes", "act"];
  return port !== "failed" && (!config?.success_field || successValues.some((value) => value === selected));
}

function _materializeManagerOwnedFanoutCommit(
  run: ActiveRun,
  child: DAGGraphNode,
  port: string,
  content: unknown,
): unknown {
  const dynamic = child.extra?.dynamic_fanout;
  if (!dynamic || typeof dynamic !== "object" || Array.isArray(dynamic)) return content;
  const info = dynamic as Record<string, unknown>;
  const parentId = typeof info.parent_node === "string" ? info.parent_node : "";
  const index = typeof info.index === "number" ? info.index : -1;
  const invocation = typeof info.invocation === "number" ? info.invocation : 1;
  const parent = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === parentId);
  const state = parent ? _fanoutState(parent) : undefined;
  const validation = parent?.gateway_config?.result_git_commit;
  if (
    !parent || !state || invocation !== state.invocation || index < 0
    || validation?.commit_mode !== "manager"
    || !_fanoutChildSucceeded(parent, port, content)
  ) {
    return content;
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID manager-owned commit requires an object result");
  }

  const enriched = structuredClone(content as Record<string, unknown>);
  const { git } = _fanoutGitResultContext(run, parent, state, index, enriched);
  const message = `homerail fanout ${parent.node_id}/${child.node_id}`;
  const status = git(["status", "--porcelain"]);
  if (status.status !== 0 || status.error) {
    throw new Error(`DAG_FANOUT_GIT_RESULT_INVALID unable to inspect manager-owned changes: ${String(status.stderr || status.error?.message || "unknown error").trim().slice(0, 1_000)}`);
  }
  if (String(status.stdout).trim()) {
    const added = git(["add", "--all", "--", "."]);
    if (added.status !== 0 || added.error) {
      throw new Error(`DAG_FANOUT_GIT_RESULT_INVALID Manager could not stage worker changes: ${String(added.stderr || added.error?.message || "unknown error").trim().slice(0, 1_000)}`);
    }
    const staged = git(["diff", "--cached", "--quiet"]);
    if (staged.status !== 1 || staged.error) {
      throw new Error("DAG_FANOUT_GIT_RESULT_INVALID worker produced no committable changes");
    }
    const committed = git([
      "-c", "user.name=HomeRail Manager",
      "-c", "user.email=homerail-manager@localhost",
      "-c", "commit.gpgsign=false",
      "commit", "--no-gpg-sign", "-m", message,
    ], 60_000);
    if (committed.status !== 0 || committed.error) {
      throw new Error(`DAG_FANOUT_GIT_RESULT_INVALID Manager could not commit worker changes: ${String(committed.stderr || committed.error?.message || "unknown error").trim().slice(0, 1_000)}`);
    }
  } else {
    const subject = git(["log", "-1", "--format=%s"]);
    if (subject.status !== 0 || subject.error || String(subject.stdout).trim() !== message) {
      throw new Error("DAG_FANOUT_GIT_RESULT_INVALID worker produced no changes for Manager to commit");
    }
  }

  const head = git(["rev-parse", "HEAD"]);
  const commitSha = String(head.stdout).trim().toLowerCase();
  if (head.status !== 0 || head.error || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha)) {
    throw new Error("DAG_FANOUT_GIT_RESULT_INVALID Manager commit did not produce a valid HEAD");
  }
  enriched[validation.commit_field] = commitSha;
  _assertFanoutGitCommitResult(run, parent, state, index, enriched);
  emit("dag:fanout_git_commit_created", {
    runId: run.runId,
    nodeId: child.node_id,
    parentNodeId: parent.node_id,
    index,
    commitSha,
    owner: "manager",
  });
  return enriched;
}

function _recordFanoutChild(run: ActiveRun, child: DAGGraphNode, port: string, content: unknown): void {
  const dynamic = child.extra?.dynamic_fanout;
  if (!dynamic || typeof dynamic !== "object" || Array.isArray(dynamic)) return;
  const info = dynamic as Record<string, unknown>;
  const parentId = typeof info.parent_node === "string" ? info.parent_node : "";
  const index = typeof info.index === "number" ? info.index : -1;
  const invocation = typeof info.invocation === "number" ? info.invocation : 1;
  const parent = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === parentId);
  const state = parent ? _fanoutState(parent) : undefined;
  if (!parent || !state || invocation !== state.invocation || index < 0 || state.results.some((result) => result.node_id === child.node_id)) return;
  state.active = state.active.filter((id) => id !== child.node_id);
  const config = parent.gateway_config;
  const success = _fanoutChildSucceeded(parent, port, content);
  if (success) _assertFanoutGitCommitResult(run, parent, state, index, content);
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
    try {
      _spawnFanoutChildren(run, parent, state);
    } catch (error) {
      abortActiveRun(run.runId, error instanceof Error ? error.message : String(error), parent.node_id);
    }
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

function _executeGatewayNode(
  runId: string,
  run: ActiveRun,
  node: DAGGraphNode,
  dispatcher: DAGDispatcher,
): boolean {
  if (node.node_type === "await_command_gateway") {
    if (!_startAwaitCommand(run, node)) return false;
    emit("dag:gateway_executed", {
      runId,
      nodeId: node.node_id,
      gatewayType: node.node_type,
      port: "waiting",
    });
    try {
      consumeDagActorLiveCommandFallbacksAtBoundary(runId);
    } catch (error) {
      // The command remains durable and queued. A later waiting-run recovery
      // pass can retry the same sequence without reopening a partial round.
      console.warn(
        `[homerail_manager] live command fallback remained queued for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  if (node.node_type === "command_gateway") {
    const result = _commandGatewayResult(run, node);
    return Boolean(handoffActiveRun(runId, node.node_id, result.port, result.payload));
  }

  if (node.node_type === "broker_gateway") {
    return _startBrokerGateway(run, node, dispatcher);
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
      result: payload,
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
      result: payload,
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
      result: result.payload,
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
      result: result.payload,
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
      reasoningEffort: agentConfig.llm?.reasoning_effort,
      serviceTier: agentConfig.llm?.service_tier,
    });
    return {
      ok: true,
      agentConfig: {
        ...agentConfig,
        agent_type: resolved.agent_type,
        llm: {
          ...agentConfig.llm,
          provider: resolved.provider_name,
          provider_display_name: resolved.provider_display_name,
          model: resolved.model,
          model_display_name: resolved.model_display_name,
          api_key: resolved.api_key,
          base_url: resolved.base_url,
          protocol: resolved.protocol,
          anthropic_auth_mode: resolved.anthropic_auth_mode,
          reasoning_effort: resolved.reasoning_effort,
          reasoning_effort_map: resolved.reasoning_effort_map,
          service_tier: resolved.service_tier,
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

function _workspaceAccess(
  run: ActiveRun,
  node: DAGGraphNode,
): DagWorkspaceAccess | undefined {
  const raw = _agentRuntimeConfig(node).workspace_access;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const writable = Array.isArray(value.writable_paths)
    ? value.writable_paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const readonly = Array.isArray(value.readonly_paths)
    ? value.readonly_paths.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const snapshotExclude = Array.isArray(value.snapshot_exclude_paths)
    ? value.snapshot_exclude_paths.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const access: DagWorkspaceAccess = {
    writable_paths: writable,
    ...(readonly ? { readonly_paths: readonly } : {}),
    ...(value.git_metadata_read_only === true ? { git_metadata_read_only: true } : {}),
    ...(typeof value.max_snapshot_files === "number" ? { max_snapshot_files: value.max_snapshot_files } : {}),
    ...(snapshotExclude ? { snapshot_exclude_paths: snapshotExclude } : {}),
  };
  const projectionExclusions = run.dagRun.graph.nodes.flatMap((candidate) => {
    const evidenceContext = _reviewEvidenceContext(run, candidate.node_id);
    return evidenceContext ? [reviewEvidenceProjectionWorkspacePath(evidenceContext)] : [];
  });
  if (projectionExclusions.length > 0) {
    access.snapshot_exclude_paths = Array.from(new Set([
      ...(access.snapshot_exclude_paths ?? []),
      ...projectionExclusions,
    ])).sort();
  }
  return access;
}

function _allowedBuiltinTools(node: DAGGraphNode): AgentBuiltinToolName[] | undefined {
  const raw = _agentRuntimeConfig(node).allowed_builtin_tools;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(AGENT_BUILTIN_TOOL_NAMES);
  return raw.filter((entry): entry is AgentBuiltinToolName => (
    typeof entry === "string" && allowed.has(entry)
  ));
}

function _builtinToolPolicy(node: DAGGraphNode): AgentBuiltinToolPolicy | undefined {
  const raw = _agentRuntimeConfig(node).builtin_tool_policy;
  if (raw === undefined) return undefined;
  if (raw !== "backend_native") throw new Error(`unsupported builtin_tool_policy '${String(raw)}'`);
  return raw;
}

function _maxBuiltinToolCalls(run: ActiveRun, node: DAGGraphNode): number | undefined {
  const configured = _agentRuntimeConfig(node).max_builtin_tool_calls;
  const nodeLimit = Number.isInteger(configured) && Number(configured) > 0
    ? Number(configured)
    : undefined;
  const workflowLimit = run.limits.max_tool_calls_per_node > 0
    ? run.limits.max_tool_calls_per_node
    : undefined;
  if (nodeLimit !== undefined && workflowLimit !== undefined) {
    return Math.min(nodeLimit, workflowLimit);
  }
  return nodeLimit ?? workflowLimit;
}

function _codexSandbox(node: DAGGraphNode): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  const raw = _agentRuntimeConfig(node).codex_sandbox;
  if (raw === undefined) return undefined;
  if (raw !== "read-only" && raw !== "workspace-write" && raw !== "danger-full-access") {
    throw new Error(`unsupported codex_sandbox '${String(raw)}'`);
  }
  return raw;
}

function _allowedDagTools(node: DAGGraphNode): DagAgentToolName[] | undefined {
  const raw = _agentRuntimeConfig(node).allowed_dag_tools;
  if (!Array.isArray(raw)) return undefined;
  const allowed = new Set<string>(DAG_AGENT_TOOL_NAMES);
  return raw.filter((entry): entry is DagAgentToolName => (
    typeof entry === "string" && allowed.has(entry)
  ));
}

function _credentialProjections(run: ActiveRun, node: DAGGraphNode): DagCredentialProjection[] {
  const raw = _agentRuntimeConfig(node).credentials;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const projections: DagCredentialProjection[] = [];
  const claimedEnv = new Set<string>();
  const forbiddenEnv = /^(?:HOMERAIL_|MANAGER_|AGENT_BACKEND$|PATH$|HOME$|NODE_OPTIONS$|LD_|DYLD_|ANTHROPIC_|OPENAI_|KIMI_|LLM_)/;

  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid credential binding on node ${node.node_id}`);
    }
    const binding = entry as Record<string, unknown>;
    const credentialRef = String(binding.credential_ref ?? "");
    const purpose = String(binding.purpose ?? "");
    const inject = binding.inject;
    if (!inject || typeof inject !== "object" || Array.isArray(inject)) {
      throw new Error(`Credential binding '${credentialRef}' has no injection policy`);
    }
    const policy = inject as Record<string, unknown>;
    const mode = String(policy.mode ?? "");
    if (mode === "manager_broker") {
      const record = getCredential(credentialRef);
      if (!record || record.status !== "active") {
        throw new Error(`Manager-broker credential is unavailable: ${credentialRef}`);
      }
      if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
        throw new Error(`Manager-broker credential is expired: ${credentialRef}`);
      }
      projections.push({
        credential_ref: credentialRef,
        purpose,
        mode,
        broker: String(policy.broker ?? ""),
        allowed_actions: Array.isArray(policy.allowed_actions)
          ? policy.allowed_actions.map(String)
          : [],
      });
      continue;
    }

    const materialized = materializeCredential(credentialRef, {
      actor: `dag:${run.runId}:${node.node_id}`,
      run_id: run.runId,
      node_id: node.node_id,
      purpose,
    });
    if (mode === "env") {
      const mappings = policy.mappings;
      if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
        throw new Error(`Credential binding '${credentialRef}' has invalid env mappings`);
      }
      const values: Record<string, string> = {};
      for (const [secretField, rawEnv] of Object.entries(mappings)) {
        const env = String(rawEnv);
        if (forbiddenEnv.test(env)) throw new Error(`Credential binding cannot override reserved env '${env}'`);
        if (claimedEnv.has(env)) throw new Error(`Credential env '${env}' is bound more than once on node ${node.node_id}`);
        const secret = materialized.secret[secretField];
        if (secret === undefined) {
          throw new Error(`Credential '${credentialRef}' has no secret field '${secretField}'`);
        }
        claimedEnv.add(env);
        values[env] = secret;
      }
      projections.push({ credential_ref: credentialRef, purpose, mode, values });
      continue;
    }
    if (mode === "file" || mode === "stdin") {
      const field = String(policy.field ?? "");
      const env = String(policy.env ?? "");
      if (forbiddenEnv.test(env)) throw new Error(`Credential binding cannot override reserved env '${env}'`);
      if (claimedEnv.has(env)) throw new Error(`Credential env '${env}' is bound more than once on node ${node.node_id}`);
      const content = materialized.secret[field];
      if (content === undefined) throw new Error(`Credential '${credentialRef}' has no secret field '${field}'`);
      claimedEnv.add(env);
      projections.push({
        credential_ref: credentialRef,
        purpose,
        mode,
        field,
        content,
        filename: String(policy.filename ?? "credential"),
        env,
      });
      continue;
    }
    throw new Error(`Credential binding '${credentialRef}' has unsupported mode '${mode}'`);
  }
  return projections;
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
  let skillContext;
  try {
    skillContext = getDagRunSkillContext(run.runId, agentId)?.context;
  } catch (cause) {
    return {
      ok: false,
      reason: `Skill Context validation failed for agent ${agentId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (agentConfig.skills?.length) {
    if (!skillContext) {
      return { ok: false, reason: `pinned Skill Context is unavailable for agent ${agentId}` };
    }
    const declaredIds = [...agentConfig.skills].sort();
    const pinnedIds = skillContext.skills.map((skill) => skill.id);
    if (!isDeepStrictEqual(declaredIds, pinnedIds)) {
      return { ok: false, reason: `pinned Skill Context does not match agent ${agentId} declarations` };
    }
  }
  try {
    if (skillContext) {
      assertDagWorkerSurfaceViewAllowlist({
        agent_id: agentId,
        context: skillContext,
        allowed_surface_views: agentConfig.allowed_surface_views,
      });
    }
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const credentials = _withDispatchCredentials(agentConfig);
  if (!credentials.ok) return credentials;
  const advisorResolution = _advisorConfigs(run, node);
  if (!advisorResolution.ok) return advisorResolution;
  let credentialProjections: DagCredentialProjection[];
  try {
    credentialProjections = _credentialProjections(run, node);
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }

  const inputs = _nodeInputs(run.dagRun, nodeId);
  const nodeSession = _ensureNodeSession(run, nodeId);
  const actor = _ensureLogicalActor(run, node);
  const actorId = actor.actor_id;
  const generation = actor.generation;
  const surfaceId = actor.surface_id;
  const actorSurfaceView = getDagActorSurfaceView(run.runId, actorId);
  const correctionOnly = Array.isArray(inputs.correction) && inputs.correction.length > 0;
  const effectiveCredentialProjections = correctionOnly
    ? credentialProjections.flatMap((projection) => {
        if (projection.mode !== "manager_broker") return [];
        const requiredActions = new Set(_outputBrokerActionRequirements(run, nodeId)
          .filter((requirement) => (
            requirement.credential_ref === projection.credential_ref
            && requirement.broker === projection.broker
          ))
          .map((requirement) => requirement.action));
        const allowedActions = projection.allowed_actions.filter((action) => requiredActions.has(action));
        return allowedActions.length > 0 ? [{ ...projection, allowed_actions: allowedActions }] : [];
      })
    : credentialProjections;
  const requestedCheckpointVersion = actor.checkpoint_ref?.match(/^portable:(\d+)$/)?.[1];
  const freshDispatchContext = _nodeSessionScope(node) === "dispatch";
  const actorCheckpointRecord = freshDispatchContext
    ? undefined
    : requestedCheckpointVersion
    ? getDagActorCheckpoint({
        run_id: run.runId,
        actor_id: actorId,
        checkpoint_version: Number(requestedCheckpointVersion),
      })
    : getLatestDagActorCheckpoint({ run_id: run.runId, actor_id: actorId });
  if (!freshDispatchContext && requestedCheckpointVersion && !actorCheckpointRecord) {
    return { ok: false, reason: `portable checkpoint ${requestedCheckpointVersion} is unavailable for actor ${actorId}` };
  }
  const actorCheckpoint = actorCheckpointRecord?.checkpoint;
  const roundCommand = listDagActorCommands({
    run_id: run.runId,
    actor_id: actorId,
    round_id: run.currentRound.round_id,
  }).find((command) =>
    command.target_generation === generation
    && command.status !== "cancelled"
    && command.status !== "failed"
  );
  const dispatchInputs = nodeSession.resumeInstruction
    ? { ...inputs, checkpoint_resume: [nodeSession.resumeInstruction] }
    : inputs;
  const outgoingEdges = run.dagRun.graph.edges.filter(
    (e) => e.from_node === nodeId && e.label !== "after_dep",
  );
  const outputContracts = Object.fromEntries(Array.from(new Set(
    outgoingEdges.map((edge) => edge.from_port),
  )).sort().flatMap((port) => {
    const outputContract = _outputContract(run, nodeId, port);
    return outputContract?.schema === undefined
      ? []
      : [[port, { contract: outputContract.contract, schema: outputContract.schema }] as const];
  }));

  return {
    ok: true,
    envelope: {
      runId: run.runId,
      nodeId,
      sessionId: nodeSession.sessionId,
      agentId,
      agentConfig: credentials.agentConfig,
      ...(skillContext ? { skillContext } : {}),
      inputs: dispatchInputs,
      outgoingEdges,
      ...(Object.keys(outputContracts).length > 0 ? { outputContracts } : {}),
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
      workspaceAccess: _workspaceAccess(run, node),
      builtinToolPolicy: _builtinToolPolicy(node),
      allowedBuiltinTools: _allowedBuiltinTools(node),
      maxBuiltinToolCalls: _maxBuiltinToolCalls(run, node),
      codexSandbox: _codexSandbox(node),
      allowedDagTools: _allowedDagTools(node),
      ...(effectiveCredentialProjections.length > 0
        ? { credentialProjections: effectiveCredentialProjections }
        : {}),
      activity: {
        roundId: run.currentRound.round_id,
        actorId,
        generation,
        ...(roundCommand ? { commandId: roundCommand.command_id } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        sequenceStart: getDagActivitySequenceCursor(run.runId, actorId, generation),
        surfacePatchSequenceStart: actorSurfaceView?.generation === generation
          ? actorSurfaceView.body_revision
          : 0,
        surfaceReportingComplete: correctionOnly
          && actorSurfaceView?.generation === generation
          && actorSurfaceView.round_id === run.currentRound.round_id
          && actorSurfaceView.phase === "final",
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
  // Reviewers share one run workspace and execute concurrently. Materialize
  // every ready reviewer's session before building any envelope so each Worker
  // can exclude the exact set of Manager-owned projection files that sibling
  // reviewers may publish while its snapshot is active.
  for (const nodeId of ready) {
    const node = run.dagRun.graph.nodes.find((candidate) => candidate.node_id === nodeId);
    if (node && !_isGatewayNode(node) && _reviewEvidenceEnabled(run, nodeId)) {
      _prepareNodeSessionForDispatch(run, node);
    }
  }
  for (const nodeId of ready) {
    const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
    if (!node) continue;
    if (_isGatewayNode(node)) {
      try {
        if (_executeGatewayNode(runId, run, node, dispatcher)) count++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failActiveRun(runId, nodeId, `gateway execution failed: ${message}`);
      }
      if (run.status !== "active") break;
      continue;
    }

    _prepareNodeSessionForDispatch(run, node);

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

/**
 * Advance every synchronously reachable READY node, stopping once execution
 * is waiting on an agent, an asynchronous gateway, or external capacity.
 *
 * Broker gateways complete outside GraphExecutor.tick(). Their callback must
 * therefore drain condition/join/while chains itself; otherwise a newly READY
 * deterministic gateway has no subsequent event that can wake it.
 */
export function dispatchReadyNodesUntilStable(
  runId: string,
  dispatcher: DAGDispatcher,
): number {
  const run = store.get(runId);
  if (!run || run.status !== "active") return 0;
  const maxPasses = Math.max(1, run.dagRun.graph.nodes.length * 2);
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const advanced = dispatchReadyNodes(runId, dispatcher);
    total += advanced;
    if (advanced === 0) break;
  }
  return total;
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
  _prepareNodeSessionForDispatch(run, node);
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

import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { GraphExecutor } from "./graph-executor.js";
import type { DAGAgentConfig, DAGGraphNode, DAGOutputRoute, ParsedDAG } from "./graph.js";
import { parseWorkflowSourceFile } from "./workflow-spec-v1.js";
import { assertProviderPolicy } from "./provider-policy.js";
import { assertNoYamlProviderRuntime } from "./runtime-selection.js";
import {
  applyDagRuntimeProfile,
  getDagRuntimeProfile,
  getDagWorkflow,
  parseStoredDagWorkflow,
  resolveDagRuntimeProfile,
} from "../persistence/dag-workflows.js";
import { appendRunNode, cancelActiveRun, cancelAllActiveRuns, checkpointResumeActiveRun, injectActiveRun } from "../runtime/active-runs.js";
import type { InjectResult, CancelAllResult, CheckpointResumeRequest } from "../runtime/active-runs.js";
import { emit } from "../events/bus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.HOMERAIL_REPO_ROOT
  ? path.resolve(process.env.HOMERAIL_REPO_ROOT)
  : path.resolve(__dirname, "../../..");

export interface CreateRunRequest {
  yamlPath?: string;
  workflowId?: string;
  profile?: string;
  runId?: string;
  prompt?: string;
  llmSettingId?: string;
}

export interface CreateRunResponse {
  runId: string;
  workflowId?: string;
  workflowName?: string;
  workflowRevision?: number;
  canonicalHash?: string;
  compilerVersion?: string;
  sourceApiVersion?: string;
  nodeCount: number;
  status: string;
  createdAt: number;
}

export interface InvokeRunResponse {
  dispatched: number;
}

export interface InjectRunResponse {
  injected: boolean;
  nodeId: string;
  mode: string;
  delivered: boolean;
  delivery_target_type?: "worker" | "node";
  delivery_target_id?: string;
  delivery_gap?: string;
}

export interface CheckpointResumeResponse {
  scheduled: boolean;
  resumed: boolean;
  runId: string;
  nodeId: string;
  sessionId: string;
  parentSessionId?: string;
  attempt: number;
  entryUuid?: string;
  keptEntries: number;
  totalEntries: number;
  dispatched: boolean;
  dispatch_state: "dispatched" | "pending";
  dispatch_count: number;
}

export interface AppendNodeRequest {
  nodeId: string;
  agentId?: string;
  agent?: DAGAgentConfig;
  after?: string[];
  outputs?: Record<string, DAGOutputRoute>;
  name?: string;
  description?: string;
  image?: string;
  container_group?: string;
}

export interface AppendNodeResponse {
  runId: string;
  nodeId: string;
  ready: boolean;
  dispatched: number;
  nodeCount: number;
}

export interface ManagerRunCommandRequest {
  command: string;
  commandId?: string;
  source?: string;
  append?: AppendNodeRequest;
}

export interface ManagerRunCommandResponse {
  runId: string;
  commandId: string;
  command: string;
  source: string;
  result: AppendNodeResponse;
}

export interface CreateAndRunRequest {
  yamlPath?: string;
  workflowId?: string;
  profile?: string;
  runId?: string;
  prompt?: string;
  llmSettingId?: string;
}

export interface CreateAndRunResponse {
  run_id: string;
  runId: string;
  workflowId?: string;
  workflowName?: string;
  workflowRevision?: number;
  canonicalHash?: string;
  compilerVersion?: string;
  sourceApiVersion?: string;
  nodeCount: number;
  status: string;
  createdAt: number;
  dispatched: number;
}

function _resolveYamlPath(yamlPath: string): string {
  const resolved = path.resolve(REPO_ROOT, yamlPath);
  // Prevent path traversal outside repo
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("yamlPath must be within the repository");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`YAML file not found: ${yamlPath}`);
  }
  return resolved;
}

function _generateRunId(): string {
  return Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

function _applyProfile(
  parsed: ParsedDAG,
  profileName: string,
): ParsedDAG {
  const profiles = parsed.meta.runtime_profiles ?? {};
  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(`Profile '${profileName}' not found in YAML`);
  }

  const agents = parsed.meta.agents
    ? { ...parsed.meta.agents }
    : {};

  const wildcard = profile.agents?.["*"];
  if (wildcard) {
    for (const agentId of Object.keys(agents)) {
      agents[agentId] = {
        ...agents[agentId],
        agent_type: wildcard.agent_type ?? agents[agentId]?.agent_type,
      };
    }
  }

  // Also apply specific agent mappings if present
  if (profile.agents) {
    for (const [agentId, mapping] of Object.entries(profile.agents)) {
      if (agentId === "*") continue;
      if (agents[agentId]) {
        agents[agentId] = {
          ...agents[agentId],
          agent_type: mapping.agent_type ?? agents[agentId]?.agent_type,
        };
      }
    }
  }

  return {
    meta: { ...parsed.meta, agents },
    graph: parsed.graph,
    loop_sources: parsed.loop_sources,
  };
}

function _applyRunRuntimeSelection(parsed: ParsedDAG, llmSettingId: string | undefined): ParsedDAG {
  if (!llmSettingId) return parsed;
  const agentIds = new Set([
    ...Object.keys(parsed.meta.agents ?? {}),
    ...parsed.graph.nodes
      .map((node) => node.agent)
      .filter((agentId) => agentId && agentId !== "__gateway__"),
  ]);
  const agents = Object.fromEntries(
    Array.from(agentIds).map((agentId) => [
      agentId,
      { ...(parsed.meta.agents?.[agentId] ?? {}), llm_setting_id: llmSettingId },
    ]),
  );
  return {
    meta: { ...parsed.meta, agents },
    graph: parsed.graph,
    loop_sources: parsed.loop_sources,
  };
}

function _loadDagForRequest(request: CreateRunRequest): ParsedDAG {
  const workflowId = request.workflowId?.trim();
  if (workflowId) {
    const workflow = getDagWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`DAG workflow not found in database: ${workflowId}. Run hr dag sync first.`);
    }
    return parseStoredDagWorkflow(workflow);
  }
  if (!request.yamlPath) {
    throw new Error("Missing required field: yamlPath or workflow_id");
  }
  const resolvedPath = _resolveYamlPath(request.yamlPath);
  return parseWorkflowSourceFile(resolvedPath);
}

function _applyRuntimeProfile(parsed: ParsedDAG, request: CreateRunRequest): ParsedDAG {
  const profileName = request.profile?.trim();
  if (!profileName) return parsed;
  const workflowId = request.workflowId?.trim() || parsed.meta.workflow_id;
  if (workflowId) {
    const dbProfile = getDagRuntimeProfile(workflowId, profileName);
    if (dbProfile) {
      return applyDagRuntimeProfile(parsed, resolveDagRuntimeProfile(dbProfile));
    }
    if (!parsed.meta.runtime_profiles?.[profileName]) {
      throw new Error(`DAG runtime profile not found in database for workflow '${workflowId}': ${profileName}. Run hr profile sync first.`);
    }
  }
  return _applyProfile(parsed, profileName);
}

export class ChangeOrchestrator {
  constructor(private graphExecutor: GraphExecutor) {}

  createRun(request: CreateRunRequest): CreateRunResponse {
    const parsed = _loadDagForRequest(request);
    assertNoYamlProviderRuntime(parsed);
    const dagWithProfile = _applyRuntimeProfile(parsed, request);
    const dagWithRuntime = _applyRunRuntimeSelection(dagWithProfile, request.llmSettingId);
    assertProviderPolicy(dagWithRuntime);

    const runId = request.runId ?? _generateRunId();
    const run = this.graphExecutor.createRun(runId, dagWithRuntime, request.prompt);

    return {
      runId: run.runId,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workflowRevision: run.workflowRevision,
      canonicalHash: run.canonicalHash,
      compilerVersion: run.compilerVersion,
      sourceApiVersion: run.sourceApiVersion,
      nodeCount: run.nodeCount ?? dagWithRuntime.graph.nodes.length,
      status: run.status,
      createdAt: run.createdAt,
    };
  }

  invokeRun(runId: string): InvokeRunResponse {
    const run = this.graphExecutor.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const dispatched = this.graphExecutor.tick(runId);
    return { dispatched };
  }

  createAndRun(request: CreateAndRunRequest): CreateAndRunResponse {
    const createResult = this.createRun(request);
    const invokeResult = this.invokeRun(createResult.runId);
    return {
      run_id: createResult.runId,
      runId: createResult.runId,
      workflowId: createResult.workflowId,
      workflowName: createResult.workflowName,
      workflowRevision: createResult.workflowRevision,
      canonicalHash: createResult.canonicalHash,
      compilerVersion: createResult.compilerVersion,
      sourceApiVersion: createResult.sourceApiVersion,
      nodeCount: createResult.nodeCount,
      status: createResult.status,
      createdAt: createResult.createdAt,
      dispatched: invokeResult.dispatched,
    };
  }

  cancelRun(runId: string): boolean {
    const run = this.graphExecutor.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    cancelActiveRun(runId);
    return true;
  }

  emergencyStopAllRuns(): { stopped: number; run_ids: string[]; active_before: number; active_after: number } {
    const result: CancelAllResult = cancelAllActiveRuns();
    return {
      stopped: result.cancelled.length,
      run_ids: result.cancelled,
      active_before: result.activeBefore,
      active_after: result.activeAfter,
    };
  }

  injectRun(runId: string, nodeId: string, instruction: string, mode: string): InjectRunResponse {
    const run = this.graphExecutor.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (run.status !== "active") {
      emit("dag:instruction_terminal_no_active_target", {
        runId,
        nodeId,
        instruction,
        mode,
        reason: "run is terminal",
      });
      throw new Error(`Run is terminal: ${runId}`);
    }
    const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
    if (!node) {
      throw new Error(`Node not found in run graph: ${nodeId}`);
    }
    const result = injectActiveRun(runId, nodeId, instruction, mode);
    if (!result) {
      throw new Error(`Injection failed for run ${runId} node ${nodeId}`);
    }
    return {
      injected: true,
      nodeId,
      mode,
      delivered: result.delivered,
      delivery_target_type: result.deliveryTargetType,
      delivery_target_id: result.deliveryTargetId,
      delivery_gap: result.deliveryGap,
    };
  }

  checkpointResumeNode(runId: string, nodeId: string, request: CheckpointResumeRequest): CheckpointResumeResponse {
    const run = this.graphExecutor.getRun(runId);
    if (!run) {
      throw new Error(`Run is not active in this Manager process: ${runId}; persisted runs are replay-only until a Manager recovery pass is implemented.`);
    }
    if (run.status !== "active") {
      throw new Error(`Run is terminal: ${runId}`);
    }
    const node = run.dagRun.graph.nodes.find((n) => n.node_id === nodeId);
    if (!node) {
      throw new Error(`Node not found in run graph: ${nodeId}`);
    }
    const result = checkpointResumeActiveRun(runId, nodeId, request);
    if (result.status !== "scheduled") {
      throw new Error(result.reason);
    }
    const dispatched = this.graphExecutor.tick(runId);
    return {
      scheduled: true,
      resumed: true,
      runId,
      nodeId,
      sessionId: result.sessionId,
      parentSessionId: result.parentSessionId,
      attempt: result.attempt,
      entryUuid: result.entryUuid,
      keptEntries: result.keptEntries,
      totalEntries: result.totalEntries,
      dispatched: dispatched > 0,
      dispatch_state: dispatched > 0 ? "dispatched" : "pending",
      dispatch_count: dispatched,
    };
  }

  appendNode(runId: string, request: AppendNodeRequest): AppendNodeResponse {
    const run = this.graphExecutor.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "active") throw new Error(`Run is terminal: ${runId}`);
    if (!/^[A-Za-z0-9._-]+$/.test(request.nodeId)) {
      throw new Error("nodeId contains unsupported characters");
    }
    const agentId = request.agentId ?? `${request.nodeId}-agent`;
    const node: DAGGraphNode = {
      node_id: request.nodeId,
      name: request.name ?? request.nodeId,
      description: request.description ?? "",
      node_type: "agent",
      agent: agentId,
      after: request.after ?? [],
      outputs: request.outputs ?? { done: { to: "" } },
      image: request.image ?? "homerail-worker:latest",
      container_group: request.container_group,
    };
    if (!request.agent) {
      throw new Error("Dynamic node append requires explicit agent configuration");
    }
    const agent = request.agent;
    const result = appendRunNode(runId, { node, agentConfig: agent });
    if (!result) throw new Error(`Append node failed for run ${runId}`);
    const dispatched = this.graphExecutor.tick(runId);
    return { ...result, dispatched };
  }

  runManagerCommand(runId: string, request: ManagerRunCommandRequest): ManagerRunCommandResponse {
    const run = this.graphExecutor.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "active") throw new Error(`Run is terminal: ${runId}`);
    void request;
    throw new Error("Worker-sourced run commands are unsupported; express topology changes in the DAG template before run creation.");
  }
}

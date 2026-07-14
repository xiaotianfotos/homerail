import type { DAGEventType, DAGEventPayload } from "../events/bus.js";
import type {
  DAGGatewayConfig,
  DAGArtifactDeclaration,
  DAGNodeRequirements,
  DAGPatternInstanceMeta,
  ScorecardPolicyConfig,
} from "../orchestration/graph.js";
import type { DAGRunCounters, DAGRunLimits } from "../runtime/active-runs.js";
import type { DagRunStatus } from "./status.js";

export interface PersistedGraphNode {
  node_id: string;
  name: string;
  description: string;
  node_type: string;
  agent: string;
  after: string[];
  outputs: Record<string, { to: string | string[]; condition?: string; retry_policy?: { max_retries?: number } }>;
  image?: string;
  container_group?: string;
  requires?: DAGNodeRequirements;
  gateway_config?: DAGGatewayConfig;
  extra?: Record<string, unknown>;
}

export interface PersistedGraphEdge {
  from_node: string;
  from_port: string;
  to_node: string;
  to_port: string;
  condition: string;
  terminal_outcome?: "success" | "failure" | "cancelled";
  label?: string;
  retry_policy?: { max_retries?: number };
}

export interface PersistedGraphData {
  nodes: PersistedGraphNode[];
  edges: PersistedGraphEdge[];
}

export interface RunWorkspaceRetention {
  pinned: boolean;
  updatedAt: number;
  cleanedAt?: number;
}

export type DagRunRoundStatus = "active" | "waiting" | "completed" | "cancelled" | "failed";

export interface PersistedCurrentDagRunRound {
  round_id: string;
  ordinal: number;
  status: DagRunRoundStatus;
  target_actor_ids: string[];
  await_node_id?: string;
  opened_at: number;
  closed_at?: number;
  expires_at?: number;
}

export interface PersistedDagRuntimeState {
  after_satisfied: Record<string, string[]>;
  input_satisfied: Record<string, string[]>;
  mailboxes: Record<string, Record<string, unknown[]>>;
  loop_sources: string[];
}

export interface PersistedRunMetadata {
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
  agents?: Record<string, { agent_type?: string; model?: string; system?: string; description?: string; skills?: string[]; extra?: Record<string, unknown> }>;
  workspace?: Record<string, unknown>;
  workspaceRetention?: RunWorkspaceRetention;
  scorecard?: ScorecardPolicyConfig;
  pattern?: DAGPatternInstanceMeta;
  createdAt: number;
  status: DagRunStatus;
  currentRound?: PersistedCurrentDagRunRound;
  dagRuntimeState?: PersistedDagRuntimeState;
  completedAt?: number;
  limits?: DAGRunLimits;
  counters?: DAGRunCounters;
  nodeStates: Record<string, string>;
  handoffedNodes: string[];
  graph?: PersistedGraphData;
}

export interface PersistedEvent {
  type: DAGEventType;
  payload: DAGEventPayload;
  timestamp: number;
}

export interface HandoffRecord {
  runId: string;
  roundId?: string;
  fromNode: string;
  port: string;
  content?: unknown;
  timestamp: number;
}

export interface ChatEntry {
  role: "manager" | "worker" | "node";
  type: "prompt" | "response";
  targetId?: string;
  content?: unknown;
  timestamp: number;
}

/** Token usage snapshot reported by a worker for a single node. The worker
 * emits cumulative totals once per node (on handoff, normal completion, or
 * error). Persisted to Manager SQLite; the last record per node wins. */
export interface NodeUsageRecord {
  runId: string;
  nodeId: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  duration_ms?: number;
  num_turns?: number;
  timestamp: number;
}

export interface PersistedRunSnapshot {
  metadata: PersistedRunMetadata;
  events: PersistedEvent[];
  handoffs: HandoffRecord[];
  chats: Record<string, ChatEntry[]>;
  /** Per-node token usage records (one or more per node; last wins). */
  usages?: NodeUsageRecord[];
}

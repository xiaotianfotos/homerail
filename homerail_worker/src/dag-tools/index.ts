/**
 * DAG tools — factory that creates the full tool set for a node run.
 * @version 0.1.0
 */

import type {
  AgentUsage,
  DagActorSurfacePatchPhaseV1,
  DagAdvisorConfig,
  DagActivityType,
  DagCredentialProjection,
  DagNodeConfig,
  DagWorkerSkillVisualDataContractV1,
  DagWorkspaceAccess,
  Edge,
} from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import { createHandoffTool } from "./handoff.js";
import { createSendMessageTool } from "./send-message.js";
import { createReceiveMessageTool } from "./receive-message.js";
import { createGraphContextTool } from "./graph-context.js";
import { createManagerCommandTool } from "./manager-command.js";
import { createConsultAdvisorTool } from "./advisor.js";
import { createReportActivityTool } from "./report-activity.js";
import {
  createReportSurfaceStateTool,
  type PinnedSurfaceViewRegistry,
  type SurfacePatchEmitter,
} from "./report-surface-state.js";
import type { SurfaceMediaPublisher } from "./surface-media.js";
import {
  createCredentialBrokerCallTool,
  type CredentialBrokerCaller,
} from "./credential-broker.js";

export interface AdvisorCallResult {
  text: string;
  usage: Partial<AgentUsage>;
}

export interface DagToolsOptions {
  advisorRunner?: (advisor: DagAdvisorConfig, question: string) => Promise<AdvisorCallResult>;
  activityEmitter?: (
    type: Extract<DagActivityType, "progress" | "finding" | "blocked">,
    payload: Record<string, unknown>,
  ) => void;
  surfacePatchEmitter?: SurfacePatchEmitter;
  surfaceMediaPublisher?: SurfaceMediaPublisher;
  pinnedSurfaceViews?: PinnedSurfaceViewRegistry;
  pinnedSurfaceDataContracts?: ReadonlyMap<string, DagWorkerSkillVisualDataContractV1>;
  trustedInputs?: Readonly<Record<string, unknown[]>>;
  credentialBrokerBindings?: ReadonlyArray<
    Extract<DagCredentialProjection, { mode: "manager_broker" }>
  >;
  credentialBrokerCaller?: CredentialBrokerCaller;
}

/** Mutable state shared across all DAG tools for a single prompt run. */
export interface DagToolsState {
  nodeId: string;
  runId: string;
  sessionId: string;
  roundId?: string;
  actorId?: string;
  generation?: number;
  leaseGeneration?: number;
  surfaceId?: string;
  surfacePatchSequence: number;
  surfacePatchIds: Set<string>;
  /** A pinned Skill contract requires its full Surface phase sequence before handoff. */
  surfaceReportingRequired: boolean;
  surfaceReportingComplete: boolean;
  surfaceExpectedPhase?: DagActorSurfacePatchPhaseV1;
  surfaceReportingFatalError?: { code: string; message: string };
  commandId?: string;
  graphNodes: string[];
  availablePorts: string[];
  outgoingEdges: Edge[];
  incomingEdges: Edge[];
  /** Whether handoff has been called this turn. */
  yielded: boolean;
  handoffData: unknown | null;
  /** Incoming message inbox. */
  inbox: unknown[];
  /** Waiters for receive_message (nodeId → callback). */
  waiters: Map<string, () => void>;
  /** Send raw data over the WebSocket. */
  wsSend: (data: string) => void;
  advisors: DagAdvisorConfig[];
  advisorCalls: Map<string, number>;
  workspaceAccess?: DagWorkspaceAccess;
}

interface RoutedNodeMessage {
  type: "node_message";
  runId: string;
  fromNode: string;
  toNode: string;
  content: unknown;
  timestamp: number;
}

function isRoutedNodeMessage(value: unknown): value is RoutedNodeMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.type === "node_message"
    && typeof obj.runId === "string"
    && typeof obj.fromNode === "string"
    && typeof obj.toNode === "string"
    && "content" in obj
    && typeof obj.timestamp === "number";
}

/** Create a DagToolsState from a DagNodeConfig. */
export function createDagToolsState(
  config: DagNodeConfig,
  runId: string,
  wsSend: (data: string) => void,
): DagToolsState {
  const surfacePatchSequenceStart = (config as DagNodeConfig & {
    surface_patch_sequence_start?: number;
  }).surface_patch_sequence_start;
  const ports = new Set<string>();
  for (const e of config.outgoing_edges) {
    if (e.from_port) ports.add(e.from_port);
  }

  return {
    nodeId: config.node_id,
    runId,
    sessionId: config.session_id || runId,
    roundId: config.round_id,
    actorId: config.actor_id,
    generation: config.generation,
    leaseGeneration: config.lease_generation,
    surfaceId: config.surface_id,
    surfacePatchSequence: Number.isSafeInteger(surfacePatchSequenceStart) && (surfacePatchSequenceStart ?? -1) >= 0
      ? surfacePatchSequenceStart as number
      : 0,
    surfacePatchIds: new Set(),
    surfaceReportingRequired: false,
    surfaceReportingComplete: config.surface_reporting_complete === true,
    commandId: config.command_id,
    graphNodes: config.graph_nodes,
    availablePorts: [...ports].sort(),
    outgoingEdges: config.outgoing_edges,
    incomingEdges: config.incoming_edges,
    yielded: false,
    handoffData: null,
    inbox: [],
    waiters: new Map(),
    wsSend,
    advisors: config.advisors ?? [],
    advisorCalls: new Map((config.advisors ?? []).map((advisor) => [advisor.id, advisor.calls_used ?? 0])),
    workspaceAccess: config.workspace_access,
  };
}

/** Create the full set of DAG tools for a prompt run. */
export function createDagTools(state: DagToolsState, options: DagToolsOptions = {}): DagToolDefinition[] {
  const tools = [
    createHandoffTool(state),
    createSendMessageTool(state),
    createReceiveMessageTool(state),
    createGraphContextTool(state),
    createManagerCommandTool(state),
  ];
  if (state.advisors.length > 0 && options.advisorRunner) {
    tools.push(createConsultAdvisorTool(state, options.advisorRunner));
  }
  if (options.activityEmitter) {
    tools.push(createReportActivityTool(options.activityEmitter));
  }
  if (options.credentialBrokerBindings?.length && options.credentialBrokerCaller) {
    tools.push(createCredentialBrokerCallTool(
      state,
      options.credentialBrokerBindings,
      options.credentialBrokerCaller,
    ));
  }
  if (options.surfacePatchEmitter) {
    tools.push(createReportSurfaceStateTool(
      state,
      options.surfacePatchEmitter,
      options.surfaceMediaPublisher,
      options.pinnedSurfaceViews,
      options.pinnedSurfaceDataContracts,
      options.trustedInputs,
    ));
  }
  return tools;
}

/**
 * Deliver a message to a node's inbox.
 * If the node has a pending receive_message waiter, wake it.
 */
export function deliverInbox(state: DagToolsState, content: unknown): void {
  state.inbox.push(isRoutedNodeMessage(content) ? content : { from: "external", content });
  const waiter = state.waiters.get(state.nodeId);
  if (waiter) {
    state.waiters.delete(state.nodeId);
    waiter();
  }
}

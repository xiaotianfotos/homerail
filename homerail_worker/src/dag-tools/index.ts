/**
 * DAG tools — factory that creates the full tool set for a node run.
 * @version 0.1.0
 */

import type { AgentUsage, DagAdvisorConfig, DagNodeConfig, DagWorkspaceAccess, Edge } from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import { createHandoffTool } from "./handoff.js";
import { createSendMessageTool } from "./send-message.js";
import { createReceiveMessageTool } from "./receive-message.js";
import { createGraphContextTool } from "./graph-context.js";
import { createManagerCommandTool } from "./manager-command.js";
import { createConsultAdvisorTool } from "./advisor.js";

export interface AdvisorCallResult {
  text: string;
  usage: Partial<AgentUsage>;
}

export interface DagToolsOptions {
  advisorRunner?: (advisor: DagAdvisorConfig, question: string) => Promise<AdvisorCallResult>;
}

/** Mutable state shared across all DAG tools for a single prompt run. */
export interface DagToolsState {
  nodeId: string;
  runId: string;
  sessionId: string;
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
  const ports = new Set<string>();
  for (const e of config.outgoing_edges) {
    if (e.from_port) ports.add(e.from_port);
  }

  return {
    nodeId: config.node_id,
    runId,
    sessionId: config.session_id || runId,
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

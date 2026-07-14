import type { DAGAgentConfig, DAGEdge } from "./graph.js";
import type { AgentBuiltinToolName, DagAdvisorConfig, DagAgentToolName, DagWorkspaceAccess } from "homerail-protocol";

export interface DispatchEnvelope {
  runId: string;
  nodeId: string;
  sessionId?: string;
  agentId: string;
  agentConfig: DAGAgentConfig;
  inputs: Record<string, unknown[]>;
  outgoingEdges: DAGEdge[];
  checkpointResume?: {
    parentSessionId?: string;
    entryUuid?: string;
    instruction: string;
    attempt: number;
  };
  workflowId?: string;
  workflowName?: string;
  workspace?: Record<string, unknown>;
  image?: string;
  container_group?: string;
  requiredCapabilities?: string[];
  advisors?: DagAdvisorConfig[];
  workspaceAccess?: DagWorkspaceAccess;
  allowedBuiltinTools?: AgentBuiltinToolName[];
  allowedDagTools?: DagAgentToolName[];
}

export type DispatchResult =
  | {
      status: "dispatched";
      targetType?: "fake" | "worker" | "node";
      targetId?: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
      retryable?: boolean;
    };

export interface DAGDispatcher {
  dispatch(envelope: DispatchEnvelope): DispatchResult;
}

export class FakeDAGDispatcher implements DAGDispatcher {
  dispatched: DispatchEnvelope[] = [];
  private dispatchedKeys = new Set<string>();

  dispatch(envelope: DispatchEnvelope): DispatchResult {
    const key = `${envelope.runId}:${envelope.nodeId}`;
    if (this.dispatchedKeys.has(key)) {
      return { status: "skipped", reason: "already dispatched" };
    }
    this.dispatchedKeys.add(key);
    this.dispatched.push(envelope);
    return { status: "dispatched", targetType: "fake", targetId: "fake" };
  }

  reset(): void {
    this.dispatched = [];
    this.dispatchedKeys.clear();
  }
}

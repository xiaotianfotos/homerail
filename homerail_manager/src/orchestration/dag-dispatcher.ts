import type { DAGAgentConfig, DAGEdge } from "./graph.js";
import type {
  AgentBuiltinToolName,
  DagActorCheckpointV1,
  DagAdvisorConfig,
  DagAgentToolName,
  DagWorkspaceAccess,
  DagWorkerSkillContextV1,
  DagCredentialProjection,
} from "homerail-protocol";

export interface DispatchEnvelope {
  runId: string;
  nodeId: string;
  sessionId?: string;
  agentId: string;
  agentConfig: DAGAgentConfig;
  /** Immutable, digest-pinned Skill bodies for this logical Agent. */
  skillContext?: DagWorkerSkillContextV1;
  inputs: Record<string, unknown[]>;
  outgoingEdges: DAGEdge[];
  checkpointResume?: {
    parentSessionId?: string;
    entryUuid?: string;
    instruction: string;
    attempt: number;
  };
  /** Durable provider-neutral context used when the physical Worker changes. */
  actorCheckpoint?: DagActorCheckpointV1;
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
  /** Turn-scoped secrets or opaque Manager-broker references. Never persist this field. */
  credentialProjections?: DagCredentialProjection[];
  activity?: {
    roundId: string;
    actorId: string;
    generation: number;
    /** Physical Worker binding generation, assigned by the dispatch adapter. */
    leaseGeneration?: number;
    commandId?: string;
    surfaceId?: string;
    sequenceStart: number;
    surfacePatchSequenceStart: number;
    /** True only when a correction turn follows an applied final Surface patch in the same round. */
    surfaceReportingComplete?: boolean;
  };
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

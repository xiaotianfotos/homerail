export type DAGEventType =
  | "dag:run_created"
  | "dag:handoff"
  | "dag:node_ready"
  | "dag:node_added"
  | "dag:status_update"
  | "dag:node_state_changed"
  | "dag:node_correction_requested"
  | "dag:node_auto_handoff"
  | "dag:node_dispatch_retry"
  | "dag:checkpoint_resume"
  | "dag:stale_session_ignored"
  | "dag:gateway_executed"
  | "dag:worker_manager_command_requested"
  | "dag:manager_command_received"
  | "dag:node_dispatched"
  | "dag:node_failed"
  | "dag:run_completed"
  | "dag:run_failed"
  | "dag:run_cancelled"
  | "dag:artifact_pending"
  | "dag:artifact_ready"
  | "dag:artifact_failed"
  | "dag:artifact_skipped"
  | "dag:engine_started"
  | "dag:engine_completed"
  | "dag:engine_aborted"
  | "dag:terminal_failure_handoff"
  | "dag:ws_dispatched"
  | "dag:ws_dispatch_failed"
  | "dag:response_handoff_applied"
  | "dag:response_handoff_failed"
  | "dag:message_sent"
  | "dag:message_received"
  | "dag:instruction_injected"
  | "dag:instruction_delivered"
  | "dag:instruction_delivery_failed"
  | "dag:instruction_terminal_no_active_target"
  | "dag:provisioning_requested"
  | "dag:provisioning_completed"
  | "dag:provisioning_failed"
  | "dag:cleanup_requested"
  | "dag:cleanup_completed"
  | "dag:cleanup_failed"
  | "dag:workspace_retention_updated"
  | "dag:workspace_cleanup_requested"
  | "dag:workspace_cleanup_completed"
  | "dag:workspace_cleanup_failed"
  | "dag:run_recovered"
  | "dag:deterministic_command"
  | "dag:state_updated"
  | "dag:approval_requested"
  | "dag:approval_decided"
  | "dag:approval_expired"
  | "dag:fanout_started"
  | "dag:fanout_completed"
  | "dag:trigger_skipped"
  | "dag:trigger_dispatched"
  | "dag:trigger_failed"
  | "voice:session_status";

export const DAG_EVENT_TYPES: DAGEventType[] = [
  "dag:run_created",
  "dag:handoff",
  "dag:node_ready",
  "dag:node_added",
  "dag:status_update",
  "dag:node_state_changed",
  "dag:node_correction_requested",
  "dag:node_auto_handoff",
  "dag:node_dispatch_retry",
  "dag:checkpoint_resume",
  "dag:stale_session_ignored",
  "dag:gateway_executed",
  "dag:worker_manager_command_requested",
  "dag:manager_command_received",
  "dag:node_dispatched",
  "dag:node_failed",
  "dag:run_completed",
  "dag:run_failed",
  "dag:run_cancelled",
  "dag:artifact_pending",
  "dag:artifact_ready",
  "dag:artifact_failed",
  "dag:artifact_skipped",
  "dag:engine_started",
  "dag:engine_completed",
  "dag:engine_aborted",
  "dag:terminal_failure_handoff",
  "dag:ws_dispatched",
  "dag:ws_dispatch_failed",
  "dag:response_handoff_applied",
  "dag:response_handoff_failed",
  "dag:message_sent",
  "dag:message_received",
  "dag:instruction_injected",
  "dag:instruction_delivered",
  "dag:instruction_delivery_failed",
  "dag:instruction_terminal_no_active_target",
  "dag:provisioning_requested",
  "dag:provisioning_completed",
  "dag:provisioning_failed",
  "dag:cleanup_requested",
  "dag:cleanup_completed",
  "dag:cleanup_failed",
  "dag:workspace_retention_updated",
  "dag:workspace_cleanup_requested",
  "dag:workspace_cleanup_completed",
  "dag:workspace_cleanup_failed",
  "dag:run_recovered",
  "dag:deterministic_command",
  "dag:state_updated",
  "dag:approval_requested",
  "dag:approval_decided",
  "dag:approval_expired",
  "dag:fanout_started",
  "dag:fanout_completed",
  "dag:trigger_skipped",
  "dag:trigger_dispatched",
  "dag:trigger_failed",
  "voice:session_status",
];

export interface RunCreatedPayload {
  runId: string;
  workflowId?: string;
  nodeCount?: number;
}

export interface HandoffPayload {
  runId: string;
  fromNode: string;
  port: string;
}

export interface NodeReadyPayload {
  runId: string;
  nodeId: string;
}

export interface NodeAddedPayload {
  runId: string;
  nodeId: string;
  after: string[];
}

export interface StatusUpdatePayload {
  runId: string;
  run_id: string;
  dag_run_id: string;
  status: string;
  nodes: Array<{ id: string; name: string; status: string }>;
  timestamp: string;
}

export interface NodeStateChangedPayload {
  runId: string;
  run_id: string;
  dag_run_id: string;
  nodeId: string;
  node_id: string;
  node_name: string;
  status: string;
  previousStatus?: string;
  previous_status?: string;
  timestamp: string;
}

export interface NodeCorrectionRequestedPayload {
  runId: string;
  nodeId: string;
  reason: string;
  attempt: number;
  maxAttempts: number;
}

export interface NodeAutoHandoffPayload {
  runId: string;
  nodeId: string;
  port: string;
  reason: string;
}

export interface NodeDispatchRetryPayload {
  runId: string;
  nodeId: string;
  reason: string;
  attempt: number;
  maxAttempts: number;
}

export interface CheckpointResumePayload {
  runId: string;
  nodeId: string;
  sessionId: string;
  parentSessionId?: string;
  attempt: number;
  entryUuid?: string;
  instructionPreview: string;
}

export interface RunRecoveredPayload {
  runId: string;
  recoveredAt: number;
  /** Node ids that were RUNNING at crash time and demoted to FAILED. */
  demotedFromRunning?: string[];
  /** Why a single-node demotion happened, if applicable. */
  reason?: string;
}

export interface StaleSessionIgnoredPayload {
  runId: string;
  nodeId: string;
  sessionId: string;
  currentSessionId: string;
  source: string;
  sourceId: string;
  messageType: string;
}

export interface GatewayExecutedPayload {
  runId: string;
  nodeId: string;
  gatewayType: "loop_gateway" | "condition_gateway" | string;
  port: string;
}

export interface ManagerCommandReceivedPayload {
  runId: string;
  commandId: string;
  command: string;
  source: string;
  nodeId?: string;
}

export interface WorkerManagerCommandRequestedPayload {
  runId: string;
  commandId: string;
  command: string;
  workerId: string;
  sourceNodeId: string;
  nodeId?: string;
}

export interface NodeDispatchedPayload {
  runId: string;
  nodeId: string;
  agentId: string;
  sessionId?: string;
}

export interface RunCompletedPayload {
  runId: string;
}

export interface NodeFailedPayload {
  runId: string;
  nodeId: string;
  reason: string;
}

export interface RunFailedPayload {
  runId: string;
  nodeId: string;
  reason: string;
}

export interface RunCancelledPayload {
  runId: string;
}

export interface EngineStartedPayload {
  runId: string;
  workflowId?: string;
  limits?: Record<string, number>;
}

export interface EngineCompletedPayload {
  runId: string;
}

export interface EngineAbortedPayload {
  runId: string;
  nodeId?: string;
  reason: string;
}

export interface TerminalFailureHandoffPayload {
  runId: string;
  fromNode: string;
  port: string;
}

export interface WsDispatchedPayload {
  runId: string;
  nodeId: string;
  targetType: "worker" | "node";
  targetId: string;
}

export interface WsDispatchFailedPayload {
  runId: string;
  nodeId: string;
  reason: string;
}

export interface ResponseHandoffAppliedPayload {
  runId: string;
  nodeId: string;
  port: string;
  source: "worker" | "node";
  sourceId: string;
}

export interface ResponseHandoffFailedPayload {
  runId?: string;
  nodeId?: string;
  reason: string;
  source: "worker" | "node";
  sourceId: string;
}

export interface MessageSentPayload {
  runId: string;
  fromNode: string;
  toNode: string;
  source: "worker" | "node";
  sourceId: string;
  delivery: "delivered" | "queued";
}

export interface MessageReceivedPayload {
  runId: string;
  nodeId: string;
  source: "worker" | "node";
  sourceId: string;
  delivery: "delivered" | "waiting";
}

export interface InstructionInjectedPayload {
  runId: string;
  nodeId: string;
  instruction: string;
  mode: string;
}

export interface InstructionDeliveredPayload {
  runId: string;
  nodeId: string;
  instruction: string;
  mode: string;
  targetType: "worker" | "node";
  targetId: string;
}

export interface InstructionDeliveryFailedPayload {
  runId: string;
  nodeId: string;
  instruction: string;
  mode: string;
  reason: string;
}

export interface InstructionTerminalNoActiveTargetPayload {
  runId: string;
  nodeId: string;
  instruction: string;
  mode: string;
  reason: string;
}

export interface ProvisioningRequestedPayload {
  runId: string;
  nodeId: string;
  nodeIdForProvision: string;
}

export interface ProvisioningCompletedPayload {
  runId: string;
  nodeId: string;
  workerId: string;
  containerId: string;
}

export interface ProvisioningFailedPayload {
  runId: string;
  nodeId: string;
  reason: string;
}

export interface CleanupRequestedPayload {
  runId: string;
  workerCount: number;
}

export interface CleanupCompletedPayload {
  runId: string;
  workerId: string;
  nodeId: string;
  containerId: string;
  stopped: boolean;
  removed: boolean;
}

export interface CleanupFailedPayload {
  runId: string;
  workerId: string;
  nodeId: string;
  containerId: string;
  reason: string;
}

export interface VoiceSessionStatusPayload {
  voiceSessionId: string;
  status: string;
  phase?: string;
  timestamp: string;
}

export interface RuntimePrimitivePayload {
  runId?: string;
  nodeId?: string;
  [key: string]: unknown;
}

export type DAGEventPayload =
  | RunCreatedPayload
  | HandoffPayload
  | NodeReadyPayload
  | NodeAddedPayload
  | StatusUpdatePayload
  | NodeStateChangedPayload
  | NodeCorrectionRequestedPayload
  | NodeAutoHandoffPayload
  | NodeDispatchRetryPayload
  | CheckpointResumePayload
  | StaleSessionIgnoredPayload
  | GatewayExecutedPayload
  | WorkerManagerCommandRequestedPayload
  | ManagerCommandReceivedPayload
  | NodeDispatchedPayload
  | NodeFailedPayload
  | RunCompletedPayload
  | RunFailedPayload
  | RunCancelledPayload
  | EngineStartedPayload
  | EngineCompletedPayload
  | EngineAbortedPayload
  | TerminalFailureHandoffPayload
  | WsDispatchedPayload
  | WsDispatchFailedPayload
  | ResponseHandoffAppliedPayload
  | ResponseHandoffFailedPayload
  | MessageSentPayload
  | MessageReceivedPayload
  | InstructionInjectedPayload
  | InstructionDeliveredPayload
  | InstructionDeliveryFailedPayload
  | InstructionTerminalNoActiveTargetPayload
  | ProvisioningRequestedPayload
  | ProvisioningCompletedPayload
  | ProvisioningFailedPayload
  | CleanupRequestedPayload
  | CleanupCompletedPayload
  | CleanupFailedPayload
  | RunRecoveredPayload
  | RuntimePrimitivePayload
  | VoiceSessionStatusPayload;

type Handler = (payload: DAGEventPayload) => void;

const listeners = new Map<string, Handler[]>();

export function _clearListeners(): void {
  listeners.clear();
}

export function subscribe(
  type: DAGEventType,
  handler: Handler,
): () => void {
  const list = listeners.get(type) ?? [];
  list.push(handler);
  listeners.set(type, list);
  return () => {
    const current = listeners.get(type) ?? [];
    listeners.set(
      type,
      current.filter((h) => h !== handler),
    );
  };
}

export function emit(type: DAGEventType, payload: DAGEventPayload): void {
  const list = listeners.get(type) ?? [];
  for (const handler of list) {
    handler(payload);
  }
}

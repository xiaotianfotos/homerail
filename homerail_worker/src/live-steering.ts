import {
  DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
  type DagActorLiveCommandData,
  type DagActorLiveCommandMessage,
  type DagActorLiveCommandStatusMessage,
  type DagActorLiveCommandWorkerStatus,
  redactTelemetry,
  validateDagActorLiveCommandMessage,
} from "homerail-protocol";
import {
  AgentTurnController,
  type AgentTurnSteerReceipt,
} from "./agent/turn-controller.js";

export interface ActivePromptTransportIdentity {
  runId: string;
  nodeId: string;
  sessionId: string;
  roundId: string;
  actorId: string;
  generation: number;
  leaseGeneration: number;
  /** Command that established the active turn. New live commands have their own IDs. */
  commandId: string;
}

export interface ActivePromptLiveSteering {
  identity: ActivePromptTransportIdentity;
  controller: AgentTurnController;
  /** Update Worker-owned trusted inputs after a new live command passes admission. */
  onCommandAccepted?: (command: DagActorLiveCommandData) => void;
}

export function activePromptTransportIdentity(input: {
  runId: string;
  nodeId: string;
  sessionId?: string;
  roundId?: string;
  actorId?: string;
  generation?: number;
  leaseGeneration?: number;
  commandId?: string;
}): ActivePromptTransportIdentity {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    sessionId: input.sessionId ?? input.runId,
    roundId: input.roundId ?? "",
    actorId: input.actorId ?? "",
    generation: input.generation ?? 0,
    leaseGeneration: input.leaseGeneration ?? 0,
    commandId: input.commandId ?? "",
  };
}

export interface DagActorCommandRouteResult {
  handled: boolean;
  reason?: string;
}

type CommandStatusIdentity = Pick<
  DagActorLiveCommandData,
  | "schema_version"
  | "command_id"
  | "sequence"
  | "run_id"
  | "node_id"
  | "session_id"
  | "round_id"
  | "actor_id"
  | "generation"
  | "lease_generation"
  | "expected_state_token"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.length >= 1 && value.length <= maxLength ? value : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function statusIdentityFromUnknown(value: unknown): CommandStatusIdentity | null {
  if (!isRecord(value) || value.type !== "dag_actor_command" || !isRecord(value.data)) return null;
  const data = value.data;
  const commandId = boundedString(data.command_id, 256);
  const runId = boundedString(data.run_id, 256);
  const nodeId = boundedString(data.node_id, 256);
  const sessionId = boundedString(data.session_id, 512);
  const roundId = boundedString(data.round_id, 256);
  const actorId = boundedString(data.actor_id, 256);
  const expectedStateToken = boundedString(data.expected_state_token, 64);
  const sequence = positiveSafeInteger(data.sequence);
  const generation = positiveSafeInteger(data.generation);
  const leaseGeneration = positiveSafeInteger(data.lease_generation);
  if (
    data.schema_version !== DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION
    || !commandId
    || !runId
    || !nodeId
    || !sessionId
    || !roundId
    || !actorId
    || !expectedStateToken
    || !/^[0-9a-f]{64}$/.test(expectedStateToken)
    || sequence === null
    || generation === null
    || leaseGeneration === null
  ) {
    return null;
  }
  return {
    schema_version: DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
    command_id: commandId,
    sequence,
    run_id: runId,
    node_id: nodeId,
    session_id: sessionId,
    round_id: roundId,
    actor_id: actorId,
    generation,
    lease_generation: leaseGeneration,
    expected_state_token: expectedStateToken,
  };
}

function statusIdentityFromCommand(command: DagActorLiveCommandData): CommandStatusIdentity {
  return {
    schema_version: command.schema_version,
    command_id: command.command_id,
    sequence: command.sequence,
    run_id: command.run_id,
    node_id: command.node_id,
    session_id: command.session_id,
    round_id: command.round_id,
    actor_id: command.actor_id,
    generation: command.generation,
    lease_generation: command.lease_generation,
    expected_state_token: command.expected_state_token,
  };
}

function safeReason(reason: string): string {
  return String(redactTelemetry(reason)).slice(0, 4096);
}

function sendStatus(
  send: (data: string) => void,
  identity: CommandStatusIdentity,
  status: DagActorLiveCommandWorkerStatus,
  reason?: string,
): void {
  const message: DagActorLiveCommandStatusMessage = {
    type: "dag_actor_command_status",
    data: {
      ...identity,
      status,
      ...(reason ? { reason: safeReason(reason) } : {}),
    },
  };
  send(JSON.stringify(message));
}

function steeringContent(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() ? payload : null;
  if (!isRecord(payload)) return null;
  for (const key of ["instruction", "content", "text", "prompt"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    const encoded = JSON.stringify(payload);
    return encoded && encoded !== "{}" ? encoded : null;
  } catch {
    return null;
  }
}

export function activePromptFenceMismatch(
  active: ActivePromptTransportIdentity,
  command: DagActorLiveCommandData,
): string | null {
  const comparisons: Array<[string, string | number, string | number]> = [
    ["run_id", active.runId, command.run_id],
    ["node_id", active.nodeId, command.node_id],
    ["session_id", active.sessionId, command.session_id],
    ["round_id", active.roundId, command.round_id],
    ["actor_id", active.actorId, command.actor_id],
    ["generation", active.generation, command.generation],
    ["lease_generation", active.leaseGeneration, command.lease_generation],
  ];
  const mismatch = comparisons.find(([, expected, actual]) => expected !== actual);
  if (!mismatch) return null;
  const [field, expected, actual] = mismatch;
  return `stale ${field}: active=${String(expected)} command=${String(actual)}`;
}

async function reportReceipt(
  send: (data: string) => void,
  identity: CommandStatusIdentity,
  receipt: AgentTurnSteerReceipt,
): Promise<void> {
  const accepted = await receipt.accepted;
  if (accepted.status === "failed") {
    sendStatus(send, identity, "failed", accepted.reason);
    return;
  }
  sendStatus(send, identity, "accepted");

  const applied = await receipt.applied;
  if (applied.status === "failed") {
    sendStatus(send, identity, "failed", applied.reason);
    return;
  }
  sendStatus(send, identity, "applied");

  const completed = await receipt.completed;
  if (completed.status === "failed") {
    sendStatus(send, identity, "failed", completed.reason);
    return;
  }
  sendStatus(send, identity, "completed");
}

export async function routeDagActorCommand(
  rawMessage: unknown,
  activePrompt: ActivePromptLiveSteering | null,
  send: (data: string) => void,
): Promise<DagActorCommandRouteResult> {
  const statusIdentity = statusIdentityFromUnknown(rawMessage);
  const validation = validateDagActorLiveCommandMessage(rawMessage);
  if (!validation.valid) {
    const reason = `invalid dag_actor_command: ${validation.errors
      .map((error) => `${error.path || "/"} ${error.message}`)
      .join("; ")}`;
    if (statusIdentity) sendStatus(send, statusIdentity, "rejected", reason);
    return { handled: Boolean(statusIdentity), reason };
  }

  const message = rawMessage as DagActorLiveCommandMessage;
  const command = message.data;
  const identity = statusIdentityFromCommand(command);
  if (!activePrompt) {
    const reason = "no active prompt is bound to this Worker";
    sendStatus(send, identity, "rejected", reason);
    return { handled: true, reason };
  }

  const fenceMismatch = activePromptFenceMismatch(activePrompt.identity, command);
  if (fenceMismatch) {
    sendStatus(send, identity, "rejected", fenceMismatch);
    return { handled: true, reason: fenceMismatch };
  }

  const content = steeringContent(command.payload);
  if (!content) {
    const reason = "dag_actor_command payload does not contain non-empty steering content";
    sendStatus(send, identity, "rejected", reason);
    return { handled: true, reason };
  }

  const submission = activePrompt.controller.steer({
    commandId: command.command_id,
    idempotencyKey: command.idempotency_key,
    sequence: command.sequence,
    content,
  });
  if (submission.status === "unsupported" || submission.status === "rejected") {
    sendStatus(send, identity, submission.status, submission.reason);
    return { handled: true, reason: submission.reason };
  }

  if (!submission.duplicate) activePrompt.onCommandAccepted?.(command);

  await reportReceipt(send, identity, submission);
  return { handled: true };
}

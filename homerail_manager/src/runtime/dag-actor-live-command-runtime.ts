import WebSocket from "ws";
import {
  DAG_ACTOR_LIVE_COMMAND_CAPABILITY,
  DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
  validateDagActorLiveCommandMessage,
  validateDagActorLiveCommandStatusMessage,
  type DagActorLiveCommandMessage,
  type DagActorLiveCommandStatusMessage,
} from "homerail-protocol";
import { emit } from "../events/bus.js";
import {
  createDagActorLiveCommandBatch,
  getDagActorLiveCommand,
  listOutstandingDagActorLiveCommands,
  markDagActorLiveCommandFallback,
  recordDagActorLiveCommandSendAttempt,
  transitionDagActorLiveCommand,
  type DagActorLiveCommandRecord,
} from "../persistence/dag-actor-live-commands.js";
import { getDagActor, getDagActorCommand } from "../persistence/dag-actors.js";
import { getDagActorLease } from "../persistence/dag-actor-leases.js";
import { getNode } from "../node/registry.js";
import { getWorker } from "../worker/registry.js";
import { assessDagTransportFence, type DagTransportFenceSource } from "../orchestration/response-bridge.js";
import {
  findDispatchTarget,
  isCurrentDispatchTarget,
} from "../orchestration/dispatch-tracker.js";
import {
  getActiveRun,
  getCurrentNodeSession,
  listActiveRuns,
} from "./active-runs.js";
import { getDagActorControlState } from "./dag-actor-control-state.js";

export interface SendDagActorLiveCommandRequest {
  expected_round_id?: string;
  commands: Array<{
    actor_id: string;
    payload: unknown;
    idempotency_key?: string;
    expected_state_token?: string;
  }>;
}

export interface SendDagActorLiveCommandResult {
  delivery_mode: "live";
  resumed: false;
  run_id: string;
  round_id: string;
  actor_ids: string[];
  command_ids: string[];
  command_statuses: Array<{
    command_id: string;
    actor_id: string;
    sequence: number;
    status: DagActorLiveCommandRecord["status"];
  }>;
  sent: number;
  fallback_pending: number;
  deduplicated?: boolean;
}

export class DagActorLiveCommandRuntimeError extends Error {
  constructor(
    public readonly code:
      | "run_not_active"
      | "actor_not_found"
      | "expected_round_conflict"
      | "state_token_required"
      | "state_token_conflict"
      | "idempotency_key_required",
    message: string,
  ) {
    super(message);
    this.name = "DagActorLiveCommandRuntimeError";
  }
}

export type DagActorLiveCommandStatusResult =
  | { status: "advanced" | "fallback_queued"; command: DagActorLiveCommandRecord }
  | {
      status: "ignored";
      disposition: "stale" | "duplicate" | "invalid";
      reason: string;
      command_id?: string;
    }
  | { status: "malformed_payload"; reason: string };

interface SendAttemptResult {
  command: DagActorLiveCommandRecord;
  sent: boolean;
}

function fallback(commandId: string, reason: string): DagActorLiveCommandRecord {
  try {
    return markDagActorLiveCommandFallback({ command_id: commandId, reason }).command;
  } catch {
    return getDagActorLiveCommand(commandId)!;
  }
}

function targetSocket(command: DagActorLiveCommandRecord): {
  targetType: "worker" | "node";
  targetId: string;
  socket: WebSocket;
  capabilities: string[];
} | undefined {
  const target = findDispatchTarget(command.run_id, command.node_id);
  if (target?.state !== "dispatched" || !target.targetType || !target.targetId) return undefined;
  if (target.targetType === "worker") {
    const worker = getWorker(target.targetId);
    return worker
      ? { targetType: "worker", targetId: target.targetId, socket: worker.socket, capabilities: worker.capabilities }
      : undefined;
  }
  const node = getNode(target.targetId);
  return node
    ? { targetType: "node", targetId: target.targetId, socket: node.socket, capabilities: node.capabilities }
    : undefined;
}

/** A successful WebSocket write is only a send attempt; durable status remains queued. */
export function trySendDagActorLiveCommand(rawCommandId: string): SendAttemptResult {
  const command = getDagActorLiveCommand(rawCommandId);
  if (!command) throw new Error(`Unknown DAG actor live command: ${rawCommandId}`);
  if (command.status !== "queued") return { command, sent: false };

  const linkedRoundCommand = getDagActorCommand(command.command_id);
  if (
    linkedRoundCommand
    && linkedRoundCommand.run_id === command.run_id
    && linkedRoundCommand.actor_id === command.actor_id
    && linkedRoundCommand.target_generation === command.target_generation
  ) {
    if (linkedRoundCommand.status === "acknowledged") {
      return {
        command: transitionDagActorLiveCommand({
          command_id: command.command_id,
          status: "completed",
        }).command,
        sent: false,
      };
    }
    if (linkedRoundCommand.status === "failed" || linkedRoundCommand.status === "cancelled") {
      return {
        command: transitionDagActorLiveCommand({
          command_id: command.command_id,
          status: linkedRoundCommand.status,
          reason: `linked round command ${linkedRoundCommand.status}`,
        }).command,
        sent: false,
      };
    }
    return {
      command: fallback(command.command_id, `consumed by durable round ${linkedRoundCommand.round_id}`),
      sent: false,
    };
  }

  const run = getActiveRun(command.run_id);
  if (!run || run.status !== "active") {
    return { command: fallback(command.command_id, "run is not actively dispatching"), sent: false };
  }
  const actor = getDagActor(command.run_id, command.actor_id);
  if (!actor || actor.node_id !== command.node_id || actor.generation !== command.target_generation) {
    const superseded = transitionDagActorLiveCommand({
      command_id: command.command_id,
      status: "superseded",
      reason: "actor generation or ownership changed before live delivery",
    }).command;
    return { command: superseded, sent: false };
  }
  if (run.dagRun.nodeStates.get(command.node_id) !== "RUNNING") {
    return { command: fallback(command.command_id, "actor is dormant until the next command boundary"), sent: false };
  }

  const target = targetSocket(command);
  if (!target || target.socket.readyState !== WebSocket.OPEN) {
    return { command: fallback(command.command_id, "current dispatch target is unavailable"), sent: false };
  }
  if (target.targetType !== "worker") {
    return {
      command: fallback(
        command.command_id,
        "direct Node dispatch has no verified Worker live-command forwarding adapter",
      ),
      sent: false,
    };
  }
  if (!target.capabilities.includes(DAG_ACTOR_LIVE_COMMAND_CAPABILITY)) {
    return { command: fallback(command.command_id, "current dispatch target does not support live commands"), sent: false };
  }
  const lease = getDagActorLease({ run_id: command.run_id, actor_id: command.actor_id });
  const leaseTargetType = lease?.target_type === "provisioned_worker" ? "worker" : lease?.target_type;
  if (
    !lease
    || lease.state !== "leased"
    || leaseTargetType !== target.targetType
    || lease.target_id !== target.targetId
    || lease.lease_generation < 1
  ) {
    return { command: fallback(command.command_id, "actor lease does not match the current dispatch target"), sent: false };
  }
  const session = getCurrentNodeSession(command.run_id, command.node_id);
  if (!session?.sessionId) {
    return { command: fallback(command.command_id, "actor has no current dispatch session"), sent: false };
  }

  const attempted = recordDagActorLiveCommandSendAttempt({
    command_id: command.command_id,
    session_id: session.sessionId,
    round_id: run.currentRound.round_id,
    lease_generation: lease.lease_generation,
  }).command;
  const message: DagActorLiveCommandMessage = {
    type: "dag_actor_command",
    data: {
      schema_version: DAG_ACTOR_LIVE_COMMAND_PROTOCOL_VERSION,
      command_id: attempted.command_id,
      idempotency_key: attempted.idempotency_key,
      sequence: attempted.sequence,
      run_id: attempted.run_id,
      node_id: attempted.node_id,
      session_id: attempted.session_id,
      round_id: attempted.round_id,
      actor_id: attempted.actor_id,
      generation: attempted.target_generation,
      lease_generation: attempted.target_lease_generation,
      expected_state_token: attempted.expected_state_token,
      payload: attempted.payload,
    },
  };
  const validation = validateDagActorLiveCommandMessage(message);
  if (!validation.valid) {
    return {
      command: fallback(
        command.command_id,
        `persisted live command failed protocol validation: ${validation.errors[0]?.message ?? "invalid message"}`,
      ),
      sent: false,
    };
  }
  try {
    target.socket.send(JSON.stringify(message));
    emit("dag:actor_live_command_sent", {
      runId: attempted.run_id,
      nodeId: attempted.node_id,
      actorId: attempted.actor_id,
      commandId: attempted.command_id,
      sequence: attempted.sequence,
      targetType: target.targetType,
      targetId: target.targetId,
    });
    return { command: getDagActorLiveCommand(command.command_id)!, sent: true };
  } catch (error) {
    return {
      command: fallback(
        command.command_id,
        `live command socket write failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      sent: false,
    };
  }
}

export function sendDagActorLiveCommands(
  runId: string,
  request: SendDagActorLiveCommandRequest,
): SendDagActorLiveCommandResult {
  const run = getActiveRun(runId);
  if (!run || run.status !== "active") {
    throw new DagActorLiveCommandRuntimeError("run_not_active", `Run ${runId} is not active`);
  }
  if (!Array.isArray(request.commands) || request.commands.length < 1 || request.commands.length > 128) {
    throw new Error("commands must contain between 1 and 128 entries");
  }
  const expectedRoundId = request.expected_round_id?.trim();
  if (expectedRoundId && expectedRoundId !== run.currentRound.round_id) {
    throw new DagActorLiveCommandRuntimeError(
      "expected_round_conflict",
      `Active round conflict: current round is ${run.currentRound.round_id}`,
    );
  }
  const actors = request.commands.map((requested, index) => {
    const actorId = requested.actor_id?.trim();
    const actor = actorId ? getDagActor(runId, actorId) : undefined;
    if (!actor) {
      throw new DagActorLiveCommandRuntimeError(
        "actor_not_found",
        `Unknown DAG actor: ${runId}/${actorId || `commands[${index}]`}`,
      );
    }
    const idempotencyKey = requested.idempotency_key?.trim();
    if (!idempotencyKey) {
      throw new DagActorLiveCommandRuntimeError(
        "idempotency_key_required",
        `commands[${index}].idempotency_key is required for active Actor delivery`,
      );
    }
    const expectedStateToken = requested.expected_state_token?.trim();
    if (!expectedStateToken) {
      throw new DagActorLiveCommandRuntimeError(
        "state_token_required",
        `commands[${index}].expected_state_token is required for active Actor delivery`,
      );
    }
    const lease = getDagActorLease({ run_id: runId, actor_id: actor.actor_id });
    return {
      actor,
      input: {
        run_id: runId,
        actor_id: actor.actor_id,
        node_id: actor.node_id,
        session_id: actor.session_id ?? "unbound",
        round_id: run.currentRound.round_id,
        target_generation: actor.generation,
        target_lease_generation: lease?.lease_generation ?? 0,
        expected_state_token: expectedStateToken,
        idempotency_key: idempotencyKey,
        payload: requested.payload,
      },
    };
  });
  if (new Set(actors.map(({ actor }) => actor.actor_id)).size !== actors.length) {
    throw new Error("commands must contain unique actor_id values");
  }

  const persisted = createDagActorLiveCommandBatch(
    actors.map(({ input }) => input),
    {
      validate_new: (input) => {
        const currentRun = getActiveRun(runId);
        if (!currentRun || currentRun.status !== "active") {
          throw new DagActorLiveCommandRuntimeError("run_not_active", `Run ${runId} is not active`);
        }
        if (currentRun.currentRound.round_id !== run.currentRound.round_id) {
          throw new DagActorLiveCommandRuntimeError(
            "expected_round_conflict",
            `Active round changed to ${currentRun.currentRound.round_id}`,
          );
        }
        const current = getDagActorControlState(runId, input.actor_id);
        if (current.state_token !== input.expected_state_token) {
          throw new DagActorLiveCommandRuntimeError(
            "state_token_conflict",
            `Actor ${runId}/${input.actor_id} state token changed`,
          );
        }
      },
    },
  );

  const attempts = persisted.map(({ command }) => trySendDagActorLiveCommand(command.command_id));
  const commands = attempts.map((attempt) => attempt.command);
  return {
    delivery_mode: "live",
    resumed: false,
    run_id: runId,
    round_id: run.currentRound.round_id,
    actor_ids: commands.map((command) => command.actor_id),
    command_ids: commands.map((command) => command.command_id),
    command_statuses: commands.map((command) => ({
      command_id: command.command_id,
      actor_id: command.actor_id,
      sequence: command.sequence,
      status: command.status,
    })),
    sent: attempts.filter((attempt) => attempt.sent).length,
    fallback_pending: commands.filter((command) => command.status === "queued" && command.fallback_reason).length,
    ...(persisted.every((entry) => entry.deduplicated) ? { deduplicated: true } : {}),
  };
}

function ignoredStatus(
  disposition: "stale" | "duplicate" | "invalid",
  reason: string,
  commandId?: string,
): DagActorLiveCommandStatusResult {
  return {
    status: "ignored",
    disposition,
    reason,
    ...(commandId ? { command_id: commandId } : {}),
  };
}

/**
 * Advance status using the persisted token echo and current transport fence.
 * Deliberately does not recompute the Actor control-state token: surface state
 * may have advanced after the command's submission CAS.
 */
export function handleDagActorLiveCommandStatus(
  source: DagTransportFenceSource,
  rawMessage: unknown,
): DagActorLiveCommandStatusResult {
  const validation = validateDagActorLiveCommandStatusMessage(rawMessage);
  if (!validation.valid) {
    return {
      status: "malformed_payload",
      reason: validation.errors.map((error) => `${error.path || "/"} ${error.message}`).join("; "),
    };
  }
  const message = rawMessage as DagActorLiveCommandStatusMessage;
  const data = message.data;
  let command: DagActorLiveCommandRecord | undefined;
  try {
    command = getDagActorLiveCommand(data.command_id);
  } catch {
    return ignoredStatus("invalid", "Live command identity is invalid");
  }
  if (!command) {
    return ignoredStatus("invalid", `Unknown live command ${data.command_id}`, data.command_id);
  }
  const assessment = assessDagTransportFence({
    runId: data.run_id,
    nodeId: data.node_id,
    round_id: data.round_id,
    actor_id: data.actor_id,
    generation: data.generation,
    lease_generation: data.lease_generation,
    command_id: data.command_id,
  }, source);
  if (assessment.status !== "current") {
    if (assessment.status === "malformed_payload") {
      return { status: "malformed_payload", reason: assessment.reason };
    }
    if (assessment.status === "unknown_run") {
      return ignoredStatus("stale", `Unknown run ${assessment.runId}`, data.command_id);
    }
    return ignoredStatus(assessment.disposition, assessment.reason, data.command_id);
  }
  if (!isCurrentDispatchTarget(data.run_id, data.node_id, source.targetType, source.targetId)) {
    return ignoredStatus("invalid", "status source is not the current dispatch target", data.command_id);
  }
  const run = getActiveRun(data.run_id);
  const actor = getDagActor(data.run_id, data.actor_id);
  const lease = getDagActorLease({ run_id: data.run_id, actor_id: data.actor_id });
  const session = getCurrentNodeSession(data.run_id, data.node_id);
  const leaseTargetType = lease?.target_type === "provisioned_worker" ? "worker" : lease?.target_type;
  if (
    !run
    || run.status !== "active"
    || run.currentRound.round_id !== data.round_id
    || !actor
    || actor.node_id !== data.node_id
    || actor.generation !== data.generation
    || session?.sessionId !== data.session_id
    || !lease
    || lease.state !== "leased"
    || lease.lease_generation !== data.lease_generation
    || leaseTargetType !== source.targetType
    || lease.target_id !== source.targetId
  ) {
    return ignoredStatus("stale", "status no longer matches the current Actor dispatch fence", data.command_id);
  }
  if (
    command.run_id !== data.run_id
    || command.actor_id !== data.actor_id
    || command.node_id !== data.node_id
    || command.session_id !== data.session_id
    || command.round_id !== data.round_id
    || command.target_generation !== data.generation
    || command.target_lease_generation !== data.lease_generation
    || command.sequence !== data.sequence
    || command.expected_state_token !== data.expected_state_token
  ) {
    return ignoredStatus("invalid", "status does not echo the persisted command fence", data.command_id);
  }

  if (data.status === "unsupported") {
    if (command.status !== "queued") {
      return ignoredStatus("invalid", `unsupported status cannot follow ${command.status}`, data.command_id);
    }
    const queued = markDagActorLiveCommandFallback({
      command_id: command.command_id,
      reason: data.reason || "dispatch target reported live commands unsupported",
    }).command;
    emit("dag:actor_live_command_fallback", {
      runId: command.run_id,
      nodeId: command.node_id,
      actorId: command.actor_id,
      commandId: command.command_id,
      reason: queued.fallback_reason,
    });
    return { status: "fallback_queued", command: queued };
  }

  const nextStatus = data.status === "accepted"
    ? "delivered"
    : data.status === "applied"
      ? "applied"
      : data.status === "completed"
        ? "completed"
        : data.status;
  try {
    const advanced = transitionDagActorLiveCommand({
      command_id: command.command_id,
      status: nextStatus,
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    }).command;
    emit("dag:actor_live_command_status", {
      runId: advanced.run_id,
      nodeId: advanced.node_id,
      actorId: advanced.actor_id,
      commandId: advanced.command_id,
      sequence: advanced.sequence,
      status: advanced.status,
    });
    return { status: "advanced", command: advanced };
  } catch (error) {
    return ignoredStatus(
      "duplicate",
      error instanceof Error ? error.message : String(error),
      data.command_id,
    );
  }
}

export function recoverDagActorLiveCommands(): { sent: string[]; fallback_pending: string[]; skipped: string[] } {
  const result = { sent: [] as string[], fallback_pending: [] as string[], skipped: [] as string[] };
  for (const run of listActiveRuns()) {
    if (run.status !== "active") continue;
    for (const command of listOutstandingDagActorLiveCommands(run.runId)) {
      if (command.status !== "queued") continue;
      try {
        const attempt = trySendDagActorLiveCommand(command.command_id);
        if (attempt.sent) result.sent.push(command.command_id);
        else if (attempt.command.status === "queued" && attempt.command.fallback_reason) {
          result.fallback_pending.push(command.command_id);
        } else {
          result.skipped.push(command.command_id);
        }
      } catch {
        result.skipped.push(command.command_id);
      }
    }
  }
  return result;
}

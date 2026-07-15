import type { DagTransportFenceMetadata } from "homerail-protocol";
import { getDagActorByNode, getDagActorCommand } from "../persistence/dag-actors.js";
import { acquireDagActorLease, assessDagActorLease } from "../persistence/dag-actor-leases.js";
import { getActiveRun, handoffActiveRun } from "../runtime/active-runs.js";

export type TransportFenceDisposition = "stale" | "duplicate" | "invalid";

export type TransportFenceAssessment =
  | ({ status: "current"; runId: string; nodeId: string } & DagTransportFenceMetadata)
  | { status: "unknown_run"; runId: string; nodeId: string }
  | {
      status: "ignored";
      disposition: TransportFenceDisposition;
      runId: string;
      nodeId: string;
      reason: string;
    }
  | { status: "malformed_payload"; reason: string };

export interface DagTransportFenceSource {
  targetType: "worker" | "node";
  targetId: string;
}

export type ResponseBridgeResult =
  | { status: "handoff_applied"; runId: string; nodeId: string; port: string }
  | {
      status: "handoff_ignored";
      disposition: TransportFenceDisposition;
      runId: string;
      nodeId: string;
      reason: string;
    }
  | { status: "malformed_payload"; reason: string }
  | { status: "unknown_run"; runId: string }
  | { status: "handoff_failed"; runId: string; nodeId: string; reason: string };

function transportMetadataError(obj: Record<string, unknown>): string | undefined {
  for (const field of ["round_id", "actor_id", "command_id"] as const) {
    const value = obj[field];
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0 || value.length > 256)) {
      return `${field} must be a non-empty string of at most 256 characters`;
    }
  }
  if (obj.generation !== undefined && (
    typeof obj.generation !== "number"
    || !Number.isSafeInteger(obj.generation)
    || obj.generation < 1
  )) {
    return "generation must be a positive safe integer";
  }
  if (
    typeof obj.lease_generation !== "number"
    || !Number.isSafeInteger(obj.lease_generation)
    || obj.lease_generation < 1
  ) {
    return "lease_generation must be a positive safe integer";
  }
  return undefined;
}

function ignored(
  disposition: TransportFenceDisposition,
  runId: string,
  nodeId: string,
  reason: string,
): TransportFenceAssessment {
  return { status: "ignored", disposition, runId, nodeId, reason };
}

/**
 * Resolve terminal transport identity without mutating the active run. Fence
 * conflicts are ignored here so they can never enter correction/failure paths.
 */
export function assessDagTransportFence(
  payload: unknown,
  source: DagTransportFenceSource,
): TransportFenceAssessment {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { status: "malformed_payload", reason: "payload is not an object" };
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.runId !== "string") {
    return { status: "malformed_payload", reason: "runId must be a string" };
  }
  if (typeof obj.nodeId !== "string") {
    return { status: "malformed_payload", reason: "nodeId must be a string" };
  }
  const metadataError = transportMetadataError(obj);
  if (metadataError) return { status: "malformed_payload", reason: metadataError };

  const runId = obj.runId;
  const nodeId = obj.nodeId;
  const run = getActiveRun(runId);
  if (!run) return { status: "unknown_run", runId, nodeId };
  const actor = getDagActorByNode(runId, nodeId);
  if (!actor) {
    return ignored("invalid", runId, nodeId, `DAG_TRANSPORT_ACTOR_FENCE_MISSING ${runId}/${nodeId}`);
  }

  const roundId = typeof obj.round_id === "string" ? obj.round_id : undefined;
  const actorId = typeof obj.actor_id === "string" ? obj.actor_id : undefined;
  const generation = typeof obj.generation === "number" ? obj.generation : undefined;
  const leaseGeneration = obj.lease_generation as number;
  const commandId = typeof obj.command_id === "string" ? obj.command_id : undefined;
  const currentRoundId = run.currentRound.round_id;
  const requiresDurableFence = run.currentRound.ordinal > 1;

  const leaseInput = {
    run_id: runId,
    actor_id: actor.actor_id,
    lease_generation: leaseGeneration,
    target_type: source.targetType,
    target_id: source.targetId,
  };
  let lease = assessDagActorLease(leaseInput);
  if (!lease.current && lease.reason === "expired" && run.status === "active" && lease.lease) {
    try {
      acquireDagActorLease({
        run_id: runId,
        actor_id: actor.actor_id,
        target_type: source.targetType,
        target_id: source.targetId,
        expected_version: lease.lease.version,
      });
      lease = assessDagActorLease(leaseInput);
    } catch {
      // A concurrent renewal, reassignment, or release owns the current lease.
      // The authoritative re-assessment below remains fail-closed.
      lease = assessDagActorLease(leaseInput);
    }
  }
  if (!lease.current) {
    const disposition = lease.reason === "target_mismatch" ? "invalid" : "stale";
    return ignored(
      disposition,
      runId,
      nodeId,
      `DAG_TRANSPORT_LEASE_${lease.reason.toUpperCase()} ${runId}/${nodeId}`,
    );
  }

  if (!roundId) {
    return ignored(
      "invalid",
      runId,
      nodeId,
      `DAG_TRANSPORT_ROUND_FENCE_MISSING ${runId}/${nodeId}: current ${currentRoundId}`,
    );
  }

  if (roundId !== currentRoundId) {
    return ignored(
      "stale",
      runId,
      nodeId,
      `DAG_TRANSPORT_ROUND_STALE ${runId}/${nodeId}: received ${roundId}, current ${currentRoundId}`,
    );
  }
  if (actorId !== undefined && actorId !== actor.actor_id) {
    return ignored("invalid", runId, nodeId, `DAG_TRANSPORT_ACTOR_CONFLICT ${runId}/${nodeId}`);
  }
  if (generation !== undefined && generation !== actor.generation) {
    const disposition = generation < actor.generation ? "stale" : "invalid";
    return ignored(
      disposition,
      runId,
      nodeId,
      `DAG_TRANSPORT_GENERATION_${disposition === "stale" ? "STALE" : "CONFLICT"} ${runId}/${nodeId}: received ${generation}, current ${actor.generation}`,
    );
  }

  if (commandId) {
    const command = getDagActorCommand(commandId);
    if (!command) {
      return ignored("invalid", runId, nodeId, `DAG_TRANSPORT_COMMAND_UNKNOWN ${runId}/${nodeId}: ${commandId}`);
    }
    if (command.run_id !== runId || command.actor_id !== actor.actor_id) {
      return ignored("invalid", runId, nodeId, `DAG_TRANSPORT_COMMAND_CONFLICT ${runId}/${nodeId}`);
    }
    if (command.round_id !== currentRoundId || command.target_generation !== actor.generation) {
      const disposition = command.round_id !== currentRoundId || command.target_generation < actor.generation
        ? "stale"
        : "invalid";
      return ignored(
        disposition,
        runId,
        nodeId,
        `DAG_TRANSPORT_COMMAND_${disposition === "stale" ? "STALE" : "CONFLICT"} ${runId}/${nodeId}: ${commandId}`,
      );
    }
    if (command.status === "acknowledged") {
      return ignored("duplicate", runId, nodeId, `DAG_TRANSPORT_COMMAND_DUPLICATE ${runId}/${nodeId}: ${commandId}`);
    }
  }

  if (run.dagRun.handoffedNodes.has(nodeId)) {
    return ignored("duplicate", runId, nodeId, `DAG_TRANSPORT_HANDOFF_DUPLICATE ${runId}/${nodeId}`);
  }
  if (run.status !== "active") {
    return ignored("stale", runId, nodeId, `DAG_TRANSPORT_RUN_NOT_ACTIVE ${runId}: ${run.status}`);
  }
  if (!actorId || generation === undefined || (requiresDurableFence && !commandId)) {
    return ignored(
      "invalid",
      runId,
      nodeId,
      requiresDurableFence
        ? `DAG_TRANSPORT_COMMAND_FENCE_MISSING ${runId}/${nodeId}`
        : `DAG_TRANSPORT_FENCE_MISSING ${runId}/${nodeId}`,
    );
  }

  return {
    status: "current",
    runId,
    nodeId,
    round_id: roundId,
    ...(actorId === undefined ? {} : { actor_id: actorId }),
    ...(generation === undefined ? {} : { generation }),
    lease_generation: leaseGeneration,
    ...(commandId === undefined ? {} : { command_id: commandId }),
  };
}

export function applyResponseHandoff(
  payload: unknown,
  source: DagTransportFenceSource,
): ResponseBridgeResult {
  if (typeof payload !== "object" || payload === null) {
    return {
      status: "malformed_payload",
      reason: "payload is not an object",
    };
  }

  const obj = payload as Record<string, unknown>;

  if (typeof obj.runId !== "string") {
    return {
      status: "malformed_payload",
      reason: "runId must be a string",
    };
  }

  if (typeof obj.nodeId !== "string") {
    return {
      status: "malformed_payload",
      reason: "nodeId must be a string",
    };
  }

  if (typeof obj.port !== "string") {
    return {
      status: "malformed_payload",
      reason: "port must be a string",
    };
  }

  const assessment = assessDagTransportFence(obj, source);
  if (assessment.status === "malformed_payload") return assessment;
  if (assessment.status === "unknown_run") {
    return { status: "unknown_run", runId: assessment.runId };
  }
  if (assessment.status === "ignored") {
    return {
      status: "handoff_ignored",
      disposition: assessment.disposition,
      runId: assessment.runId,
      nodeId: assessment.nodeId,
      reason: assessment.reason,
    };
  }

  let run;
  try {
    run = handoffActiveRun(obj.runId, obj.nodeId, obj.port, obj.content, {
      transport: true,
      ...(typeof obj.round_id === "string" ? { roundId: obj.round_id } : {}),
      ...(typeof obj.actor_id === "string" ? { actorId: obj.actor_id } : {}),
      ...(typeof obj.generation === "number" ? { generation: obj.generation } : {}),
      ...(typeof obj.lease_generation === "number" ? { leaseGeneration: obj.lease_generation } : {}),
      ...(typeof obj.command_id === "string" ? { commandId: obj.command_id } : {}),
    });
  } catch (error) {
    return {
      status: "handoff_failed",
      runId: obj.runId,
      nodeId: obj.nodeId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!run) {
    return {
      status: "unknown_run",
      runId: obj.runId,
    };
  }

  return {
    status: "handoff_applied",
    runId: obj.runId,
    nodeId: obj.nodeId,
    port: obj.port,
  };
}

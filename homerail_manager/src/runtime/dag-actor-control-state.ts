import { createHash } from "node:crypto";
import { getDagLiveSurfaceProjection } from "../generative-ui/dag-live-surface-projector.js";
import { getDagActorLease } from "../persistence/dag-actor-leases.js";
import { getDagActor } from "../persistence/dag-actors.js";
import { getCurrentDagRunRound } from "../persistence/dag-run-rounds.js";
import { loadRunMetadata } from "../persistence/store.js";

export type DagActorControlStateName =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface DagActorControlState {
  run_id: string;
  actor_id: string;
  actor_state: DagActorControlStateName;
  state_token: string;
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be between 1 and 256 printable characters`);
  }
  return normalized;
}

function controlStateName(nodeState: string | undefined): DagActorControlStateName {
  switch (nodeState) {
    case "READY": return "ready";
    case "RUNNING": return "running";
    case "WAITING_FOR_COMMAND":
    case "WAITING_FOR_APPROVAL": return "waiting";
    case "COMPLETED": return "completed";
    case "FAILED": return "failed";
    case "CANCELLED":
    case "SKIPPED": return "cancelled";
    default: return "pending";
  }
}

/** Build an opaque CAS token from every durable fence that controls one logical Actor. */
export function getDagActorControlState(runId: string, actorId: string): DagActorControlState {
  const normalizedRunId = assertIdentifier(runId, "run_id");
  const normalizedActorId = assertIdentifier(actorId, "actor_id");
  const actor = getDagActor(normalizedRunId, normalizedActorId);
  if (!actor) throw new Error(`Unknown DAG actor: ${normalizedRunId}/${normalizedActorId}`);
  const metadata = loadRunMetadata(normalizedRunId);
  if (!metadata) throw new Error(`Run not found: ${normalizedRunId}`);
  const round = getCurrentDagRunRound(normalizedRunId);
  const lease = getDagActorLease({ run_id: normalizedRunId, actor_id: normalizedActorId });
  const projection = getDagLiveSurfaceProjection(normalizedRunId, normalizedActorId);
  const nodeState = metadata.nodeStates[actor.node_id];
  const tokenPayload = {
    schema_version: 1,
    run_id: normalizedRunId,
    actor_id: normalizedActorId,
    actor_generation: actor.generation,
    actor_version: actor.version,
    node_state: nodeState ?? "PENDING",
    round_id: round?.round_id ?? null,
    round_status: round?.status ?? null,
    lease_state: lease?.state ?? null,
    lease_generation: lease?.lease_generation ?? 0,
    lease_version: lease?.version ?? 0,
    projection_generation: projection?.generation ?? 0,
    surface_revision: projection?.surface_revision ?? 0,
    visibility_state: projection?.visibility_state ?? null,
  };
  return {
    run_id: normalizedRunId,
    actor_id: normalizedActorId,
    actor_state: controlStateName(nodeState),
    state_token: createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex"),
  };
}

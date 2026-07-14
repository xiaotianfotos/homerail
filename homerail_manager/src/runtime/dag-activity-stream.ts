import { appendDagActivityEvent } from "../persistence/dag-activity-journal.js";
import { getDagActorByNode } from "../persistence/dag-actors.js";

export interface DagActivityStreamContext {
  runId: string;
  nodeId: string;
  roundId?: string;
}

export function ingestDagActivityStream(
  data: Record<string, unknown>,
  context: DagActivityStreamContext,
): ReturnType<typeof appendDagActivityEvent> | undefined {
  if (data.event !== "dag_activity") return undefined;
  const activity = data.activity;
  if (typeof activity !== "object" || activity === null || Array.isArray(activity)) {
    throw new Error("invalid DAG activity event: expected an object");
  }

  const event = activity as Record<string, unknown>;
  if (
    event.run_id !== context.runId
    || event.node_id !== context.nodeId
    || (context.roundId !== undefined && event.round_id !== context.roundId)
  ) {
    throw new Error("DAG activity identity does not match the transport stream context");
  }
  const actor = getDagActorByNode(context.runId, context.nodeId);
  if (actor) {
    if (event.actor_id !== actor.actor_id) {
      throw new Error("DAG activity actor identity does not match the logical actor registry");
    }
    if (typeof event.generation !== "number" || event.generation !== actor.generation) {
      throw new Error("DAG activity generation does not match the logical actor registry");
    }
    if (event.surface_id !== undefined && event.surface_id !== actor.surface_id) {
      throw new Error("DAG activity surface identity does not match the logical actor registry");
    }
  }
  return appendDagActivityEvent(activity);
}

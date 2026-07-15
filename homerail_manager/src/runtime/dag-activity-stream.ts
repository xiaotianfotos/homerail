import { appendDagActivityEvent } from "../persistence/dag-activity-journal.js";

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
  return appendDagActivityEvent(activity);
}

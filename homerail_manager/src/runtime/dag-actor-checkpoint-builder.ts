import { redactTelemetry, type DagActorCheckpointV1 } from "homerail-protocol";
import { listDagActors, listDagActorCommands, type DagActorRecord } from "../persistence/dag-actors.js";
import { listDagActivityEvents } from "../persistence/dag-activity-journal.js";
import { listRunArtifacts } from "../persistence/run-artifacts.js";
import { loadRunSnapshot } from "../persistence/store.js";

const MAX_CHECKPOINT_ITEMS = 24;
const MAX_ITEM_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 32_000;

function boundedText(value: unknown, maxChars = MAX_ITEM_CHARS): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(redactTelemetry(value));
    } catch {
      return undefined;
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}

function payloadMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return boundedText(payload);
  const record = payload as Record<string, unknown>;
  return boundedText(record.message ?? record.summary ?? record.result ?? payload);
}

function uniqueBounded(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
    .slice(-MAX_CHECKPOINT_ITEMS);
}

function checkpointContext(input: {
  actor: DagActorRecord;
  nodeStates: Record<string, string>;
  handoffs: Array<{ roundId?: string; fromNode: string; port: string; content?: unknown; timestamp: number }>;
  chats: Array<{ role: string; type: string; content?: unknown; timestamp: number }>;
  activities: ReturnType<typeof listDagActivityEvents>["events"];
  commands: ReturnType<typeof listDagActorCommands>;
}): string {
  const context = {
    node_states: input.nodeStates,
    recent_handoffs: input.handoffs.slice(-12).map((handoff) => ({
      round_id: handoff.roundId,
      from_node: handoff.fromNode,
      port: handoff.port,
      content: boundedText(handoff.content),
      timestamp: handoff.timestamp,
    })),
    recent_messages: input.chats.slice(-16).map((entry) => ({
      role: entry.role,
      type: entry.type,
      content: boundedText(entry.content),
      timestamp: entry.timestamp,
    })),
    recent_activity: input.activities.slice(-16).map((entry) => ({
      event_id: entry.event.event_id,
      type: entry.event.type,
      payload: payloadMessage(entry.event.payload),
      timestamp: entry.event.timestamp,
    })),
    outstanding_commands: input.commands
      .filter((command) => !["acknowledged", "failed", "cancelled"].includes(command.status))
      .slice(-12)
      .map((command) => ({
        command_id: command.command_id,
        round_id: command.round_id,
        status: command.status,
        payload: boundedText(command.payload),
      })),
  };
  const encoded = JSON.stringify(redactTelemetry(context));
  return encoded.length <= MAX_CONTEXT_CHARS
    ? encoded
    : JSON.stringify({
        truncated: true,
        actor_id: input.actor.actor_id,
        recent_activity: context.recent_activity.slice(-8),
        recent_handoffs: context.recent_handoffs.slice(-6),
        outstanding_commands: context.outstanding_commands,
      }).slice(0, MAX_CONTEXT_CHARS);
}

export function buildDagActorCheckpoint(input: {
  runId: string;
  actor: DagActorRecord;
  roundId: string;
  capturedAt?: number;
}): DagActorCheckpointV1 {
  const snapshot = loadRunSnapshot(input.runId);
  if (!snapshot) throw new Error(`Unknown DAG run: ${input.runId}`);
  const activities = listDagActivityEvents({
    run_id: input.runId,
    actor_id: input.actor.actor_id,
    limit: 100,
  }).events;
  const handoffs = snapshot.handoffs.filter((handoff) => handoff.fromNode === input.actor.node_id);
  const chats = snapshot.chats[input.actor.node_id] ?? [];
  const commands = listDagActorCommands({
    run_id: input.runId,
    actor_id: input.actor.actor_id,
  });
  const completedActivity = activities.filter((entry) => entry.event.type === "finding" || entry.event.type === "completed");
  const unresolvedActivity = activities.filter((entry) => entry.event.type === "blocked" || entry.event.type === "progress");
  const objective = boundedText(snapshot.metadata.initialPrompt ?? snapshot.metadata.workflowName ?? input.actor.role, 8_000)
    ?? input.actor.role;

  return {
    schema_version: 1,
    objective,
    confirmed_conclusions: uniqueBounded([
      ...handoffs.map((handoff) => boundedText(handoff.content)),
      ...completedActivity.map((entry) => payloadMessage(entry.event.payload)),
    ]),
    unresolved_items: uniqueBounded([
      ...commands
        .filter((command) => !["acknowledged", "failed", "cancelled"].includes(command.status))
        .map((command) => boundedText(command.payload)),
      ...unresolvedActivity.map((entry) => payloadMessage(entry.event.payload)),
    ]),
    key_event_refs: activities.slice(-MAX_CHECKPOINT_ITEMS).map((entry) => entry.event.event_id),
    artifact_refs: listRunArtifacts(input.runId)
      .filter((artifact) => artifact.status === "ready")
      .map((artifact) => `${artifact.name}:${artifact.artifact_id}`)
      .slice(-MAX_CHECKPOINT_ITEMS),
    ...(input.actor.workspace_ref ? { workspace_ref: input.actor.workspace_ref } : {}),
    surface_binding: input.actor.surface_id,
    context_summary: checkpointContext({
      actor: input.actor,
      nodeStates: snapshot.metadata.nodeStates,
      handoffs,
      chats,
      activities,
      commands,
    }),
    round_id: input.roundId,
    actor_generation: input.actor.generation,
    captured_at: input.capturedAt ?? Date.now(),
  };
}

export function buildRunActorCheckpoints(input: {
  runId: string;
  roundId: string;
  capturedAt?: number;
}): Array<{ actor: DagActorRecord; checkpoint: DagActorCheckpointV1 }> {
  return listDagActors(input.runId).map((actor) => ({
    actor,
    checkpoint: buildDagActorCheckpoint({
      runId: input.runId,
      actor,
      roundId: input.roundId,
      capturedAt: input.capturedAt,
    }),
  }));
}

export function renderDagActorCheckpointInstruction(checkpoint: DagActorCheckpointV1): string {
  return [
    "## HomeRail portable actor checkpoint",
    "This checkpoint is authoritative durable context from a previous Worker lease.",
    "Continue the same objective and logical actor. Do not claim unrecorded conclusions.",
    "The checkpoint contains no hidden reasoning or provider session state.",
    JSON.stringify(checkpoint),
  ].join("\n");
}

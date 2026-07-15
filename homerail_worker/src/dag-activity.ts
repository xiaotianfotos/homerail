import { randomUUID } from "node:crypto";
import type {
  DagActivityEventV1,
  DagActivityPayload,
  DagActivityType,
  DagNodeConfig,
} from "homerail-protocol";
import { DAG_ACTIVITY_EVENT_SCHEMA_VERSION, redactTelemetry } from "homerail-protocol";

const MAX_COMPLETED_ACTIVITY_ITEMS = 8;

export interface DagActivityEmitter {
  emit(type: DagActivityType, payload?: Record<string, unknown>): DagActivityEventV1;
  currentSequence(): number;
}

function normalizedActivitySummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactTelemetry(value);
  if (typeof redacted !== "string") return undefined;
  const summary = redacted.trim();
  return summary || undefined;
}

function normalizedActivityItems(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(normalizedActivitySummary)
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_COMPLETED_ACTIVITY_ITEMS);
  return items.length > 0 ? items : undefined;
}

export function completedActivityPayloadForHandoff(
  handoff: Record<string, unknown>,
): Record<string, unknown> {
  const content = handoff.content;
  const contentSummary = content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, unknown>).summary
    : undefined;
  const contentItems = content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, unknown>).items
    : undefined;
  const summary = normalizedActivitySummary(contentSummary)
    ?? normalizedActivitySummary(handoff.summary);
  const items = normalizedActivityItems(contentItems);
  const port = typeof handoff.port === "string"
    ? handoff.port
    : typeof handoff.from_port === "string"
      ? handoff.from_port
      : undefined;
  return {
    ...(port ? { port } : {}),
    ...(summary ? { summary } : {}),
    ...(items ? { items } : {}),
  };
}

export function createDagActivityEmitter(
  config: DagNodeConfig,
  runId: string,
  sink: (event: DagActivityEventV1) => void,
): DagActivityEmitter {
  const requestedSequence = config.activity_sequence_start;
  const requestedGeneration = config.generation;
  let sequence = Number.isSafeInteger(requestedSequence) && (requestedSequence ?? -1) >= 0
    ? requestedSequence as number
    : 0;
  const generation = Number.isSafeInteger(requestedGeneration) && (requestedGeneration ?? 0) >= 1
    ? requestedGeneration as number
    : 1;
  const actorId = config.actor_id?.trim() || config.node_id;
  const roundId = config.round_id?.trim() || config.session_id?.trim() || `${runId}:round:1`;
  const surfaceId = config.surface_id?.trim() || undefined;

  return {
    emit(type, payload = {}) {
      sequence += 1;
      const event: DagActivityEventV1 = {
        schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
        event_id: randomUUID(),
        run_id: runId,
        round_id: roundId,
        node_id: config.node_id,
        actor_id: actorId,
        generation,
        ...(config.lease_generation !== undefined ? { lease_generation: config.lease_generation } : {}),
        ...(surfaceId ? { surface_id: surfaceId } : {}),
        sequence,
        timestamp: Date.now(),
        type,
        // Agent tool arguments are JSON wire values. The Manager validates the
        // serialized envelope again before accepting it into the journal.
        payload: payload as DagActivityPayload,
      };
      sink(event);
      return event;
    },
    currentSequence() {
      return sequence;
    },
  };
}

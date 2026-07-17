import type { DagActorSurfacePatchV1 } from "homerail-protocol";
import { projectDagActorSurfacePatch } from "../generative-ui/dag-live-surface-projector.js";
import { getDagActorByNode } from "../persistence/dag-actors.js";
import { appendDagActorSurfacePatch } from "../persistence/dag-actor-surface-patches.js";

export interface DagActorSurfacePatchStreamContext {
  runId: string;
  nodeId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Ingest a transport-fenced Worker proposal without routing it through Activity facts. */
export function ingestDagActorSurfacePatchStream(
  data: Record<string, unknown>,
  context: DagActorSurfacePatchStreamContext,
): {
  appended: ReturnType<typeof appendDagActorSurfacePatch>;
  projected: ReturnType<typeof projectDagActorSurfacePatch>;
} | undefined {
  if (data.event !== "dag_actor_surface_patch") return undefined;
  const rawPatch = record(data.patch);
  if (!rawPatch) throw new Error("invalid Actor surface patch: expected patch object");
  const patch = rawPatch as unknown as DagActorSurfacePatchV1;
  const identityMatches = data.run_id === context.runId
    && data.node_id === context.nodeId
    && patch.run_id === context.runId
    && patch.node_id === context.nodeId
    && typeof data.session_id === "string"
    && patch.session_id === data.session_id
    && typeof data.round_id === "string"
    && patch.round_id === data.round_id
    && typeof data.actor_id === "string"
    && patch.actor_id === data.actor_id
    && typeof data.generation === "number"
    && patch.generation === data.generation
    && typeof data.lease_generation === "number"
    && patch.lease_generation === data.lease_generation;
  if (!identityMatches) {
    throw new Error("Actor surface patch identity does not match the transport stream context");
  }

  const actor = getDagActorByNode(context.runId, context.nodeId);
  if (!actor
    || actor.actor_id !== patch.actor_id
    || actor.generation !== patch.generation
    || actor.session_id !== patch.session_id
    || data.surface_id !== actor.surface_id) {
    throw new Error("Actor surface patch identity does not match the logical Actor registry");
  }
  const appended = appendDagActorSurfacePatch(rawPatch);
  const projected = projectDagActorSurfacePatch(appended.journal.journal_seq);
  return { appended, projected };
}

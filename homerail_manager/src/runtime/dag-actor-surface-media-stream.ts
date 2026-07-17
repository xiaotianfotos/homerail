import { createHash } from "node:crypto";
import {
  validateDagActorSurfaceMediaV1,
  type DagActorSurfaceMediaV1,
} from "homerail-protocol";
import { getDagActorByNode } from "../persistence/dag-actors.js";
import { getDagActorLease } from "../persistence/dag-actor-leases.js";
import { getCurrentDagRunRound } from "../persistence/dag-run-rounds.js";
import { getRunArtifact, publishActorSurfaceMediaArtifact } from "../persistence/run-artifacts.js";

export interface DagActorSurfaceMediaStreamContext {
  runId: string;
  nodeId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Publishes authenticated Worker bytes before the subsequent Surface patch references them. */
export function ingestDagActorSurfaceMediaStream(
  data: Record<string, unknown>,
  context: DagActorSurfaceMediaStreamContext,
): { artifact_name: string; uri: string; deduplicated: boolean } | undefined {
  if (data.event !== "dag_actor_surface_media") return undefined;
  const rawMedia = record(data.media);
  if (!rawMedia) throw new Error("invalid Actor surface media: expected media object");
  const validation = validateDagActorSurfaceMediaV1(rawMedia);
  if (!validation.valid) {
    throw new Error(`invalid Actor surface media: ${validation.errors[0]?.message ?? "protocol validation failed"}`);
  }
  const media = rawMedia as unknown as DagActorSurfaceMediaV1;
  const identityMatches = data.run_id === context.runId
    && data.node_id === context.nodeId
    && media.run_id === context.runId
    && media.node_id === context.nodeId
    && typeof data.session_id === "string"
    && media.session_id === data.session_id
    && typeof data.round_id === "string"
    && media.round_id === data.round_id
    && typeof data.actor_id === "string"
    && media.actor_id === data.actor_id
    && typeof data.generation === "number"
    && media.generation === data.generation
    && typeof data.lease_generation === "number"
    && media.lease_generation === data.lease_generation;
  if (!identityMatches) {
    throw new Error("Actor surface media identity does not match the transport stream context");
  }

  const actor = getDagActorByNode(context.runId, context.nodeId);
  if (!actor
    || actor.actor_id !== media.actor_id
    || actor.generation !== media.generation
    || actor.session_id !== media.session_id) {
    throw new Error("Actor surface media identity does not match the logical Actor registry");
  }
  const round = getCurrentDagRunRound(context.runId);
  if (!round || round.round_id !== media.round_id) {
    throw new Error("Actor surface media round is not current");
  }
  const lease = getDagActorLease({ run_id: context.runId, actor_id: actor.actor_id });
  if (!lease || lease.state !== "leased" || lease.lease_generation !== media.lease_generation) {
    throw new Error("Actor surface media lease is not current");
  }

  const bytes = Buffer.from(media.content_base64, "base64");
  if (bytes.byteLength !== media.size_bytes
    || createHash("sha256").update(bytes).digest("hex") !== media.sha256) {
    throw new Error("Actor surface media bytes do not match the declared size and digest");
  }
  const prior = getRunArtifact(media.run_id, media.artifact_name);
  const deduplicated = prior?.status === "ready"
    && prior.sha256 === media.sha256
    && prior.size_bytes === media.size_bytes;
  const existing = publishActorSurfaceMediaArtifact({
    run_id: media.run_id,
    artifact_name: media.artifact_name,
    media_type: media.media_type,
    sha256: media.sha256,
    bytes,
  });
  return {
    artifact_name: existing.name,
    uri: `/api/runs/${encodeURIComponent(media.run_id)}/artifacts/${encodeURIComponent(existing.name)}/content`,
    deduplicated,
  };
}

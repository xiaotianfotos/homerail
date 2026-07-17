import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorSurfaceMediaV1,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import { getDagActorSurfaceView } from "../src/persistence/dag-actor-surface-patches.js";
import { closeDb } from "../src/persistence/db.js";
import { getRunArtifact, getRunArtifactBlobPath } from "../src/persistence/run-artifacts.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  createActiveRun,
} from "../src/runtime/active-runs.js";
import { ingestDagActorSurfaceMediaStream } from "../src/runtime/dag-actor-surface-media-stream.js";
import { ingestDagActorSurfacePatchStream } from "../src/runtime/dag-actor-surface-patch-stream.js";

describe("DAG Actor surface media stream ingestion", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    _clearActiveRuns();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-actor-media-stream-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("publishes fenced bytes idempotently before a template-relative media patch", () => {
    const runId = "surface-media-dispatch";
    createActiveRun(runId, parseDAGYaml(`
name: surface-media-dispatch
workflow_id: surface-media-dispatch
agents:
  worker: { agent_type: deterministic }
nodes:
  research:
    agent: worker
    extra:
      agent_runtime:
        actor_id: researcher
        surface_id: surface-research
        allowed_dag_tools: [handoff, report_surface_state]
    outputs:
      done: { to: "" }
`));
    const dispatch = buildCurrentDispatchEnvelope(runId, "research");
    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) return;
    const actor = getDagActorByNode(runId, "research")!;
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: actor.actor_id,
      target_type: "worker",
      target_id: "worker-media",
    });
    const bytes = Buffer.from("webp-actor-media");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactName = `actor-media-${sha256}.webp`;
    const media: DagActorSurfaceMediaV1 = {
      schema_version: DAG_ACTOR_SURFACE_MEDIA_SCHEMA_VERSION,
      run_id: runId,
      node_id: "research",
      session_id: dispatch.envelope.sessionId!,
      round_id: dispatch.envelope.activity.roundId,
      actor_id: actor.actor_id,
      generation: actor.generation,
      lease_generation: lease.lease_generation,
      artifact_name: artifactName,
      media_type: "image/webp",
      size_bytes: bytes.byteLength,
      sha256,
      content_base64: bytes.toString("base64"),
    };
    const mediaStream = {
      event: "dag_actor_surface_media",
      run_id: runId,
      node_id: "research",
      session_id: media.session_id,
      round_id: media.round_id,
      actor_id: media.actor_id,
      generation: media.generation,
      lease_generation: media.lease_generation,
      media,
    };

    const first = ingestDagActorSurfaceMediaStream(mediaStream, { runId, nodeId: "research" })!;
    const second = ingestDagActorSurfaceMediaStream(mediaStream, { runId, nodeId: "research" })!;
    expect(first).toMatchObject({ artifact_name: artifactName, deduplicated: false });
    expect(second).toMatchObject({ artifact_name: artifactName, deduplicated: true });
    expect(getRunArtifact(runId, artifactName)).toMatchObject({
      status: "ready",
      media_type: "image/webp",
      sha256,
      source: { type: "actor_surface_media", sha256 },
    });
    expect(fs.readFileSync(getRunArtifactBlobPath(runId, artifactName)!)).toEqual(bytes);

    const patch: DagActorSurfacePatchV1 = {
      schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
      run_id: runId,
      node_id: "research",
      session_id: media.session_id,
      round_id: media.round_id,
      actor_id: media.actor_id,
      generation: media.generation,
      lease_generation: media.lease_generation,
      patch_id: "visual-1",
      patch_sequence: 1,
      timestamp: 1_800_000_000_000,
      phase: "partial",
      op: "replace_body",
      body: {
        a2ui: {
          version: HOMERAIL_A2UI_VERSION,
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [
            {
              id: "root",
              component: "List",
              children: { path: "/actor_view/data/items", componentId: "preview" },
            },
            { id: "preview", component: "Image", url: { path: "image_uri" }, description: "Preview" },
          ],
        },
        data: { items: [{ image_uri: first.uri }, { image_uri: first.uri }] },
        fallback: { title: "Visual result" },
      },
    };
    const projected = ingestDagActorSurfacePatchStream({
      ...mediaStream,
      event: "dag_actor_surface_patch",
      surface_id: actor.surface_id,
      patch,
      media: undefined,
    }, { runId, nodeId: "research" });
    expect(projected).toMatchObject({ appended: { inserted: true }, projected: { applied_count: 1 } });
    expect(getDagActorSurfaceView(runId, actor.actor_id)).toMatchObject({
      body: { data: { items: [{ image_uri: first.uri }, { image_uri: first.uri }] } },
    });
  });

  it("rejects transport identity and digest mismatches before publishing", () => {
    const runId = "surface-media-rejected";
    createActiveRun(runId, parseDAGYaml(`
name: surface-media-rejected
workflow_id: surface-media-rejected
agents:
  worker: { agent_type: deterministic }
nodes:
  research:
    agent: worker
    extra:
      agent_runtime: { actor_id: researcher, surface_id: surface-research }
    outputs:
      done: { to: "" }
`));
    const dispatch = buildCurrentDispatchEnvelope(runId, "research");
    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) return;
    const actor = getDagActorByNode(runId, "research")!;
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: actor.actor_id,
      target_type: "worker",
      target_id: "worker-media",
    });
    const bytes = Buffer.from("image");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const media: DagActorSurfaceMediaV1 = {
      schema_version: 1,
      run_id: runId,
      node_id: "research",
      session_id: dispatch.envelope.sessionId!,
      round_id: dispatch.envelope.activity.roundId,
      actor_id: actor.actor_id,
      generation: actor.generation,
      lease_generation: lease.lease_generation,
      artifact_name: `actor-media-${sha256}.webp`,
      media_type: "image/webp",
      size_bytes: bytes.byteLength,
      sha256,
      content_base64: bytes.toString("base64"),
    };
    const stream = {
      event: "dag_actor_surface_media",
      run_id: runId,
      node_id: "research",
      session_id: media.session_id,
      round_id: media.round_id,
      actor_id: media.actor_id,
      generation: media.generation,
      lease_generation: media.lease_generation,
      media,
    };
    expect(() => ingestDagActorSurfaceMediaStream({ ...stream, actor_id: "sibling" }, { runId, nodeId: "research" }))
      .toThrow("transport stream context");
    const corrupted = { ...media, content_base64: Buffer.from("other").toString("base64") };
    expect(() => ingestDagActorSurfaceMediaStream({ ...stream, media: corrupted }, { runId, nodeId: "research" }))
      .toThrow("declared size and digest");
    expect(getRunArtifact(runId, media.artifact_name)).toBeUndefined();
  });
});

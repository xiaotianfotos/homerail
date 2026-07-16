import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { getDagActorByNode } from "../src/persistence/dag-actors.js";
import { acquireDagActorLease } from "../src/persistence/dag-actor-leases.js";
import {
  getQueuedDagActorSurfacePatch,
  getDagActorSurfaceView,
  listDagActorSurfacePatchQueue,
} from "../src/persistence/dag-actor-surface-patches.js";
import { closeDb } from "../src/persistence/db.js";
import {
  _clearActiveRuns,
  buildCurrentDispatchEnvelope,
  createActiveRun,
} from "../src/runtime/active-runs.js";
import { ingestDagActorSurfacePatchStream } from "../src/runtime/dag-actor-surface-patch-stream.js";

function body(summary: string): DagActorSurfacePatchV1["body"] {
  return {
    a2ui: {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["summary"] },
        { id: "summary", component: "Text", text: { path: "/actor_view/data/summary" } },
      ],
    },
    data: { summary, api_key: "sk-stream-secret" },
    fallback: { title: "Research output", summary },
  };
}

describe("DAG Actor surface patch stream ingestion", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    _clearActiveRuns();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-actor-surface-stream-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    _clearActiveRuns();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("ingests a fenced patch idempotently and dispatches the durable body sequence", () => {
    const runId = "surface-stream-dispatch";
    createActiveRun(runId, parseDAGYaml(`
name: surface-stream-dispatch
workflow_id: surface-stream-dispatch
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
    const initial = buildCurrentDispatchEnvelope(runId, "research");
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const actor = getDagActorByNode(runId, "research")!;
    const lease = acquireDagActorLease({
      run_id: runId,
      actor_id: actor.actor_id,
      target_type: "worker",
      target_id: "worker-stream",
    });
    const patch: DagActorSurfacePatchV1 = {
      schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
      run_id: runId,
      node_id: "research",
      session_id: initial.envelope.sessionId!,
      round_id: initial.envelope.activity.roundId,
      actor_id: actor.actor_id,
      generation: actor.generation,
      lease_generation: lease.lease_generation,
      patch_id: "update-1",
      patch_sequence: 1,
      timestamp: 1_800_000_000_001,
      op: "replace_body",
      phase: "started",
      body: body("First durable result"),
    };
    const stream = {
      event: "dag_actor_surface_patch",
      surface_id: actor.surface_id,
      run_id: runId,
      node_id: "research",
      session_id: patch.session_id,
      round_id: patch.round_id,
      actor_id: patch.actor_id,
      generation: patch.generation,
      lease_generation: patch.lease_generation,
      patch,
    };

    const first = ingestDagActorSurfacePatchStream(stream, { runId, nodeId: "research" });
    expect(first).toMatchObject({ appended: { inserted: true }, projected: { applied_count: 1 } });
    expect(ingestDagActorSurfacePatchStream(stream, { runId, nodeId: "research" }))
      .toMatchObject({ appended: { inserted: false, deduplicated: true }, projected: { applied_count: 0 } });
    expect(listDagActorSurfacePatchQueue({ run_id: runId, actor_id: actor.actor_id }))
      .toMatchObject([{ status: "applied", body_revision: 1, visual_revision: 1 }]);
    expect(getDagActorSurfaceView(runId, actor.actor_id)).toMatchObject({
      body_revision: 1,
      body: { data: { summary: "First durable result", api_key: "***REDACTED***" } },
    });
    expect(JSON.stringify(getQueuedDagActorSurfacePatch(first!.appended.journal.journal_seq)))
      .not.toContain("sk-stream-secret");

    expect(() => ingestDagActorSurfacePatchStream({
      ...stream,
      patch: { ...patch, patch_id: "update-2", patch_sequence: 2, actor_id: "sibling" },
    }, { runId, nodeId: "research" })).toThrow("identity does not match the transport stream context");
    expect(listDagActorSurfacePatchQueue({ run_id: runId, actor_id: actor.actor_id })).toHaveLength(1);

    const resumed = buildCurrentDispatchEnvelope(runId, "research");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.envelope.allowedDagTools).toEqual(["handoff", "report_surface_state"]);
    expect(resumed.envelope.activity).toMatchObject({
      actorId: "researcher",
      surfacePatchSequenceStart: 1,
    });
  });
});

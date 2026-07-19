import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  type DagActorSurfacePatchV1,
} from "homerail-protocol";
import {
  flushDagActorSurfacePatches,
  getDagLiveSurfaceDocument,
  getDagLiveSurfaceProjection,
  projectDagActorSurfacePatch,
  projectDagActivityJournalEntry,
  recoverDagActorSurfacePatches,
} from "../src/generative-ui/dag-live-surface-projector.js";
import { persistentGenerativeUiDocumentService } from "../src/generative-ui/shadow-service.js";
import { appendDagActivityEvent } from "../src/persistence/dag-activity-journal.js";
import {
  advanceDagActorGeneration,
  getDagActor,
  registerDagActor,
  updateDagActorBinding,
} from "../src/persistence/dag-actors.js";
import { acquireDagActorLease, ensureDagActorLease } from "../src/persistence/dag-actor-leases.js";
import {
  appendDagActorSurfacePatch,
  getDagActorSurfaceView,
  listDagActorSurfacePatchQueue,
  listDagActorSurfaceSnapshots,
} from "../src/persistence/dag-actor-surface-patches.js";
import { closeDb } from "../src/persistence/db.js";
import { createInitialDagRunRound } from "../src/persistence/dag-run-rounds.js";
import { ensureRunDir } from "../src/persistence/store.js";

const RUN_ID = "actor-surface-projector";
const ROUND_ID = "round-1";
const SESSION_ID = "session-research";

function setupActors(actorIds: string[]): void {
  ensureRunDir(RUN_ID);
  for (const actorId of actorIds) {
    const registered = registerDagActor({
      run_id: RUN_ID,
      actor_id: actorId,
      node_id: `node-${actorId}`,
      role: `${actorId} role`,
      surface_id: `surface:${actorId}`,
    }).actor;
    updateDagActorBinding({
      run_id: RUN_ID,
      actor_id: actorId,
      expected_version: registered.version,
      session_id: actorId === "research" ? SESSION_ID : `session-${actorId}`,
    });
  }
  createInitialDagRunRound({
    run_id: RUN_ID,
    round_id: ROUND_ID,
    target_actor_ids: actorIds,
    opened_at: 100,
  });
  for (const actorId of actorIds) {
    const dormant = ensureDagActorLease({ run_id: RUN_ID, actor_id: actorId, now: 100 });
    acquireDagActorLease({
      run_id: RUN_ID,
      actor_id: actorId,
      target_type: "worker",
      target_id: `worker-${actorId}`,
      expected_version: dormant.version,
      now: 101,
    });
  }
}

function patchFor(input: {
  actor_id?: string;
  sequence: number;
  patch_id?: string;
  summary?: string;
  phase?: DagActorSurfacePatchV1["phase"];
  op?: "replace_body" | "clear_body";
  media_uri?: string;
}): DagActorSurfacePatchV1 {
  const actorId = input.actor_id ?? "research";
  const sessionId = actorId === "research" ? SESSION_ID : `session-${actorId}`;
  const identity = {
    schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
    run_id: RUN_ID,
    node_id: `node-${actorId}`,
    session_id: sessionId,
    round_id: ROUND_ID,
    actor_id: actorId,
    generation: 1,
    lease_generation: 1,
    patch_id: input.patch_id ?? `patch-${input.sequence}`,
    patch_sequence: input.sequence,
    timestamp: 1_800_000_000_000 + input.sequence,
    phase: input.phase ?? (input.sequence === 1 ? "started" : "partial"),
  } as const;
  if (input.op === "clear_body") return { ...identity, op: "clear_body" };
  const summary = input.summary ?? `Result ${input.sequence}`;
  return {
    ...identity,
    op: "replace_body",
    body: {
      a2ui: {
        version: HOMERAIL_A2UI_VERSION,
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        components: input.media_uri
          ? [
              { id: "root", component: "Column", children: ["preview"] },
              { id: "preview", component: "Image", url: input.media_uri, description: "Preview" },
            ]
          : [
              { id: "root", component: "Column", children: ["summary"] },
              { id: "summary", component: "Text", text: { path: "/actor_view/data/summary" } },
            ],
      },
      data: { summary },
      fallback: { title: `${actorId} output`, summary },
    },
  };
}

function appendAndProject(value: DagActorSurfacePatchV1) {
  const appended = appendDagActorSurfacePatch(value);
  const projected = projectDagActorSurfacePatch(appended.journal.journal_seq);
  return { appended, projected };
}

describe("DAG Actor surface Projector", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-actor-surface-projector-"));
    process.env.HOMERAIL_HOME = home;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("establishes actor_view and preserves it across host Activity revisions", () => {
    setupActors(["research"]);
    appendAndProject(patchFor({ sequence: 1 }));

    const projectionBefore = getDagLiveSurfaceProjection(RUN_ID, "research")!;
    const documentBefore = getDagLiveSurfaceDocument(RUN_ID)!;
    const nodeBefore = documentBefore.nodes.find((node) => node.id === "surface:research")!;
    expect(nodeBefore.provenance).toMatchObject({ run_id: RUN_ID, actor_id: "research" });
    expect(nodeBefore.status).toMatchObject({ phase: "running", label: "Started" });
    expect((nodeBefore.content as Record<string, any>).actor_view.data).toEqual({ summary: "Result 1" });
    expect(nodeBefore.a2ui?.components.find((component) => component.id === "root"))
      .toMatchObject({ children: ["actor.root"] });
    expect(nodeBefore.a2ui?.components.filter((component) => component.id.startsWith("actor."))).toHaveLength(2);
    expect(nodeBefore.a2ui?.components.map((component) => component.id))
      .not.toEqual(expect.arrayContaining(["header", "summary", "progress", "findings"]));

    projectDagActivityJournalEntry(appendDagActivityEvent({
      schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
      event_id: "activity-1",
      run_id: RUN_ID,
      round_id: ROUND_ID,
      node_id: "node-research",
      actor_id: "research",
      generation: 1,
      lease_generation: 1,
      surface_id: "surface:research",
      sequence: 1,
      timestamp: 1_800_000_000_100,
      type: "progress",
      payload: { message: "Host progress", progress: 25 },
    }));

    const projectionAfter = getDagLiveSurfaceProjection(RUN_ID, "research")!;
    const nodeAfter = getDagLiveSurfaceDocument(RUN_ID)!.nodes.find((node) => node.id === "surface:research")!;
    expect(projectionAfter.surface_revision).toBeGreaterThan(projectionBefore.surface_revision);
    expect(getDagActorSurfaceView(RUN_ID, "research")).toMatchObject({ body_revision: 1, visual_revision: 1 });
    expect((nodeAfter.content as Record<string, any>).actor_view.data).toEqual({ summary: "Result 1" });
    expect((nodeAfter.content as Record<string, any>).data.state).toMatchObject({ summary: "Host progress", progress: 25 });
  });

  it("coalesces partial data, uses data-only patches, and detects no-ops independently of surface revision", () => {
    setupActors(["research"]);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    appendAndProject(patchFor({ sequence: 1 }));
    const second = appendDagActorSurfacePatch(patchFor({ sequence: 2, summary: "Result 2" }));
    const third = appendDagActorSurfacePatch(patchFor({ sequence: 3, summary: "Result 3" }));
    projectDagActorSurfacePatch(second.journal.journal_seq);
    projectDagActorSurfacePatch(third.journal.journal_seq);
    expect(flushDagActorSurfacePatches(RUN_ID, "research")).toBe(2);

    let queue = listDagActorSurfacePatchQueue({ run_id: RUN_ID, actor_id: "research" });
    expect(queue.map((entry) => [entry.patch_sequence, entry.status, entry.apply_kind])).toEqual([
      [1, "applied", "patch_components"],
      [2, "coalesced", "coalesced"],
      [3, "applied", "update_data_model"],
    ]);
    const appliedTransaction = persistentGenerativeUiDocumentService
      .listTransactions(getDagLiveSurfaceProjection(RUN_ID, "research")!.document_id, { type: "run", id: RUN_ID })
      .find((entry) => entry.transaction_id === queue[2].transaction_id)!;
    expect(appliedTransaction.transaction.operations[0]).toMatchObject({ op: "patch" });
    expect((appliedTransaction.transaction.operations[0] as any).changes).not.toHaveProperty("a2ui");

    const beforeNoop = getDagActorSurfaceView(RUN_ID, "research")!;
    const fourth = appendDagActorSurfacePatch(patchFor({ sequence: 4, summary: "Result 3" }));
    projectDagActorSurfacePatch(fourth.journal.journal_seq);
    flushDagActorSurfacePatches(RUN_ID, "research");
    const afterNoop = getDagActorSurfaceView(RUN_ID, "research")!;
    expect(afterNoop).toMatchObject({ body_revision: 4, visual_revision: beforeNoop.visual_revision });
    queue = listDagActorSurfacePatchQueue({ run_id: RUN_ID, actor_id: "research" });
    expect(queue.at(-1)).toMatchObject({ status: "noop", apply_kind: "no_op" });
    now.mockRestore();
  });

  it("rejects phase regression and keeps final closed within one round", () => {
    setupActors(["research"]);
    appendAndProject(patchFor({ sequence: 1, phase: "started" }));
    appendAndProject(patchFor({ sequence: 2, phase: "partial" }));
    appendAndProject(patchFor({ sequence: 3, phase: "started" }));

    expect(getDagActorSurfaceView(RUN_ID, "research")).toMatchObject({
      body_revision: 3,
      visual_revision: 2,
      phase: "partial",
    });
    expect(listDagActorSurfacePatchQueue({ run_id: RUN_ID, actor_id: "research" }).at(-1))
      .toMatchObject({ status: "rejected", body_revision: 3 });

    appendAndProject(patchFor({ sequence: 4, phase: "final" }));
    appendAndProject(patchFor({ sequence: 5, phase: "partial" }));
    flushDagActorSurfacePatches(RUN_ID, "research");
    expect(getDagActorSurfaceView(RUN_ID, "research")).toMatchObject({
      body_revision: 5,
      phase: "final",
    });
    expect(listDagActorSurfacePatchQueue({ run_id: RUN_ID, actor_id: "research" }).at(-1))
      .toMatchObject({ status: "rejected", body_revision: 5 });
  });

  it("rejects unbrokered media without blocking the next contiguous patch", () => {
    setupActors(["research"]);
    appendAndProject(patchFor({ sequence: 1, media_uri: "https://example.com/private.png" }));
    expect(getDagActorSurfaceView(RUN_ID, "research")).toMatchObject({ body_revision: 1, visual_revision: 0 });
    expect(getDagActorSurfaceView(RUN_ID, "research")?.body).toBeUndefined();
    expect(listDagActorSurfacePatchQueue({ run_id: RUN_ID, actor_id: "research" })[0])
      .toMatchObject({ status: "rejected", body_revision: 1, visual_revision: 0 });

    appendAndProject(patchFor({ sequence: 2, summary: "Safe fallback" }));
    expect(getDagActorSurfaceView(RUN_ID, "research")).toMatchObject({
      body_revision: 2,
      visual_revision: 1,
      body: expect.objectContaining({ data: { summary: "Safe fallback" } }),
    });
  });

  it("isolates sibling surfaces and snapshots then clears an old generation during cold recovery", () => {
    setupActors(["research", "review"]);
    appendAndProject(patchFor({ actor_id: "research", sequence: 1, patch_id: "update-1" }));
    appendAndProject(patchFor({ actor_id: "review", sequence: 1, patch_id: "update-1", summary: "Review body" }));
    appendAndProject(patchFor({ actor_id: "research", sequence: 2, op: "clear_body" }));

    let document = getDagLiveSurfaceDocument(RUN_ID)!;
    const researchNode = document.nodes.find((node) => node.id === "surface:research")!;
    const reviewNode = document.nodes.find((node) => node.id === "surface:review")!;
    expect((researchNode.content as Record<string, unknown>).actor_view).toBeUndefined();
    expect((reviewNode.content as Record<string, any>).actor_view.data).toEqual({ summary: "Review body" });

    const reviewActor = getDagActor(RUN_ID, "review")!;
    advanceDagActorGeneration({
      run_id: RUN_ID,
      actor_id: "review",
      expected_generation: reviewActor.generation,
      expected_version: reviewActor.version,
      session_id: "session-review-2",
    });
    expect(recoverDagActorSurfacePatches(RUN_ID)).toMatchObject({ failed: [], applied_patches: 0 });
    document = getDagLiveSurfaceDocument(RUN_ID)!;
    const resetReview = document.nodes.find((node) => node.id === "surface:review")!;
    expect((resetReview.content as Record<string, unknown>).actor_view).toBeUndefined();
    expect(resetReview.a2ui?.components.some((component) => component.id.startsWith("actor."))).toBe(false);
    expect(listDagActorSurfaceSnapshots({ run_id: RUN_ID, actor_id: "review" })).toEqual([
      expect.objectContaining({ generation: 1, superseded_by_generation: 2, body_revision: 1 }),
    ]);
  });
});

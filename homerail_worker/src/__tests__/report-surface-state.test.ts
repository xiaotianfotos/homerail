import { describe, expect, it, vi } from "vitest";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  validateDagActorSurfacePatchV1,
  type DagNodeConfig,
} from "homerail-protocol";
import { createDagTools, createDagToolsState } from "../dag-tools/index.js";
import {
  DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY,
  MAX_SURFACE_PATCH_BODY_BYTES,
  REPORT_SURFACE_STATE_INPUT_SCHEMA,
  REPORT_SURFACE_STATE_PROMPT,
  REPORT_SURFACE_STATE_TOOL_NAME,
  type DagActorSurfacePatchProposalV1,
} from "../dag-tools/report-surface-state.js";

function config(overrides: Partial<DagNodeConfig> = {}): DagNodeConfig {
  return {
    node_id: "research",
    agent_type: "claude-sdk",
    model: "test",
    outgoing_edges: [],
    incoming_edges: [],
    graph_nodes: ["research"],
    session_id: "session-1",
    round_id: "round-2",
    actor_id: "actor-research",
    generation: 3,
    lease_generation: 4,
    surface_id: "surface:actor-research",
    ...overrides,
  };
}

function richBody(): Record<string, unknown> {
  return {
    a2ui: {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["image", "video", "metric", "timeline", "comparison", "route"] },
        { id: "image", component: "Image", url: "https://example.com/progress.png", description: "Current evidence" },
        { id: "video", component: "Video", url: "https://example.com/progress.mp4" },
        { id: "metric", component: "HrMetric", label: "Coverage", value: { path: "/actor_view/data/coverage" }, unit: "%" },
        {
          id: "timeline",
          component: "HrTimeline",
          source: { path: "/actor_view/data/events" },
          itemTitlePath: "/title",
          itemDetailPath: "/detail",
          itemTimePath: "/time",
        },
        {
          id: "comparison",
          component: "HrBarChart",
          source: { path: "/actor_view/data/options" },
          itemLabelPath: "/label",
          itemValuePath: "/value",
        },
        {
          id: "route",
          component: "HrDag",
          source: { path: "/actor_view/data/route" },
          itemIdPath: "/id",
          itemLabelPath: "/label",
          itemDependsOnPath: "/dependsOn",
        },
      ],
    },
    data: {
      coverage: 84,
      api_key: "must-not-leave-worker",
      events: [{ title: "Collected", detail: "Media checked", time: "09:00" }],
      options: [{ label: "A", value: 72 }, { label: "B", value: 84 }],
      route: [
        { id: "collect", label: "Collect", dependsOn: [] },
        { id: "verify", label: "Verify", dependsOn: ["collect"] },
      ],
    },
    fallback: {
      title: "Research progress",
      summary: "Evidence, metrics, comparison, and route are available.",
    },
    presentation_hint: { density: "summary", canvas_size: "2x2", preferred_visual: "comparison" },
  };
}

function replaceArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patch_id: "patch-1",
    patch_sequence: 1,
    phase: "partial",
    op: "replace_body",
    body: richBody(),
    ...overrides,
  };
}

function payload(result: Awaited<ReturnType<ReturnType<typeof createDagTools>[number]["handler"]>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("report_surface_state", () => {
  it("is opt-in, advertises the capability, and exposes only the passive schema", () => {
    const state = createDagToolsState(config(), "run-1", vi.fn());
    expect(createDagTools(state).map((tool) => tool.name)).not.toContain(REPORT_SURFACE_STATE_TOOL_NAME);
    expect(createDagTools(state, { surfacePatchEmitter: vi.fn() }).map((tool) => tool.name))
      .toContain(REPORT_SURFACE_STATE_TOOL_NAME);
    expect(DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY).toBe("dag-actor-surface-patch-v1");

    const schema = REPORT_SURFACE_STATE_INPUT_SCHEMA as {
      properties: Record<string, unknown> & {
        body: { properties: { a2ui: { properties: { components: { items: { properties: { component: { enum: string[] } } } } } } } };
      };
    };
    expect(Object.keys(schema.properties)).toEqual(["patch_id", "patch_sequence", "phase", "op", "body"]);
    const catalog = schema.properties.body.properties.a2ui.properties.components.items.properties.component.enum;
    expect(catalog).toEqual(expect.arrayContaining(["Image", "Video", "AudioPlayer", "HrMetric", "HrTimeline", "HrBarChart", "HrDag"]));
    expect(catalog).not.toEqual(expect.arrayContaining(["Button", "TextField", "Modal"]));
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("never mutates the Canvas directly");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("readable fallback");
  });

  it("submits media and non-text A2UI with locked identity after redaction", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-locked", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: (proposal) => emitted.push(proposal) })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const result = await tool.handler(replaceArgs());

    expect(result.is_error).toBeFalsy();
    expect(payload(result)).toEqual({
      status: "submitted",
      patch_id: "patch-1",
      patch_sequence: 1,
      surface_id: "surface:actor-research",
      manager_validation: "pending",
      canvas_mutated: false,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      surface_id: "surface:actor-research",
      patch: {
        schema_version: 1,
        run_id: "run-locked",
        node_id: "research",
        session_id: "session-1",
        round_id: "round-2",
        actor_id: "actor-research",
        generation: 3,
        lease_generation: 4,
        patch_id: "patch-1",
        patch_sequence: 1,
        phase: "partial",
        op: "replace_body",
      },
    });
    expect(emitted[0]!.patch.timestamp).toEqual(expect.any(Number));
    expect(validateDagActorSurfacePatchV1(emitted[0]!.patch)).toEqual({ valid: true, errors: [] });
    expect(JSON.stringify(emitted[0])).not.toContain("must-not-leave-worker");
    if (emitted[0]!.patch.op !== "replace_body") throw new Error("expected replace_body");
    expect(emitted[0]!.patch.body.data.api_key).toBe("***REDACTED***");
  });

  it("rejects model-supplied identity and unavailable dispatch fences without emitting", async () => {
    const emit = vi.fn();
    const state = createDagToolsState(config(), "run-1", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: emit })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const spoofed = await tool.handler(replaceArgs({ run_id: "spoof", surface_id: "surface:sibling" }));
    expect(spoofed.is_error).toBe(true);
    expect(payload(spoofed)).toMatchObject({ status: "rejected", code: "identity_spoof", expected_patch_sequence: 1 });
    expect(emit).not.toHaveBeenCalled();

    const unfenced = createDagToolsState(config({ surface_id: undefined }), "run-1", vi.fn());
    const unfencedTool = createDagTools(unfenced, { surfacePatchEmitter: emit })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const missing = await unfencedTool.handler(replaceArgs());
    expect(payload(missing)).toMatchObject({ status: "rejected", code: "identity_unavailable" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before transport", async () => {
    const emit = vi.fn();
    const state = createDagToolsState(config(), "run-1", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: emit })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const body = richBody();
    body.data = {
      chunks: Array.from({ length: 20 }, () => "x".repeat(Math.ceil(MAX_SURFACE_PATCH_BODY_BYTES / 20))),
    };

    const result = await tool.handler(replaceArgs({ body }));

    expect(result.is_error).toBe(true);
    expect(payload(result)).toMatchObject({ status: "rejected", code: "payload_budget" });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Button action",
      [
        { id: "root", component: "Button", child: "label", action: { functionCall: { call: "open" } } },
        { id: "label", component: "Text", text: "Unsafe" },
      ],
      "active_content",
    ],
    ["form input", [{ id: "root", component: "TextField", label: "Input" }], "invalid_patch"],
    ["HTML artifact", [{ id: "root", component: "HrArtifact", kind: "html", uri: "/artifact/result.html" }], "invalid_patch"],
    ["script field", [{ id: "root", component: "Text", text: "Unsafe", script: "alert(1)" }], "active_content"],
  ])("rejects %s from the passive Actor surface", async (_label, components, expectedCode) => {
    const emit = vi.fn();
    const state = createDagToolsState(config(), "run-1", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: emit })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const body = richBody();
    (body.a2ui as Record<string, unknown>).components = components;

    const result = await tool.handler(replaceArgs({ body }));

    expect(payload(result)).toMatchObject({ status: "rejected", code: expectedCode });
    expect(emit).not.toHaveBeenCalled();
  });

  it("enforces patch id and sequence uniqueness and accepts a body-less clear", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-1", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: (proposal) => emitted.push(proposal) })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    expect(payload(await tool.handler(replaceArgs()))).toMatchObject({ status: "submitted", patch_sequence: 1 });
    expect(payload(await tool.handler(replaceArgs({ patch_sequence: 2 }))))
      .toMatchObject({ status: "rejected", code: "duplicate_patch_id", expected_patch_sequence: 2 });
    expect(payload(await tool.handler(replaceArgs({ patch_id: "patch-2", patch_sequence: 3 }))))
      .toMatchObject({ status: "rejected", code: "sequence_conflict", expected_patch_sequence: 2 });
    expect(payload(await tool.handler({
      patch_id: "patch-2",
      patch_sequence: 2,
      phase: "final",
      op: "clear_body",
    }))).toMatchObject({ status: "submitted", patch_sequence: 2, canvas_mutated: false });
    expect(emitted.map((proposal) => proposal.patch.op)).toEqual(["replace_body", "clear_body"]);
  });

  it("does not advance sequence when transport rejects the proposal", async () => {
    const state = createDagToolsState(config(), "run-1", vi.fn());
    const tool = createDagTools(state, { surfacePatchEmitter: () => { throw new Error("closed"); } })
      .find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const result = await tool.handler(replaceArgs());

    expect(payload(result)).toMatchObject({ status: "rejected", code: "transport_rejected", expected_patch_sequence: 1 });
    expect(state.surfacePatchSequence).toBe(0);
    expect(state.surfacePatchIds.size).toBe(0);
  });
});

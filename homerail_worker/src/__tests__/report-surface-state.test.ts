import { describe, expect, it, vi } from "vitest";
import {
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  validateDagActorSurfacePatchV1,
  type DagNodeConfig,
  type DagWorkerSkillVisualDataContractV1,
  type HomerailA2uiSurfaceV1,
} from "homerail-protocol";
import { createDagTools, createDagToolsState } from "../dag-tools/index.js";
import {
  DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY,
  MAX_SURFACE_PATCH_BODY_BYTES,
  REPORT_SURFACE_STATE_INPUT_SCHEMA,
  REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA,
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
        { id: "image", component: "Image", url: "/api/runs/run-locked/artifacts/image/content", description: "Current evidence" },
        { id: "video", component: "Video", url: "/api/runs/run-locked/artifacts/video/content" },
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
        body: {
          properties: {
            view_id: Record<string, unknown>;
            a2ui: { properties: { components: { items: { properties: { component: { enum: string[] } } } } } };
          };
          oneOf: unknown[];
        };
      };
    };
    expect(Object.keys(schema.properties)).toEqual([
      "patch_id",
      "patch_sequence",
      "phase",
      "op",
      "body",
      "view_id",
      "data",
      "fallback",
      "presentation_hint",
    ]);
    const catalog = schema.properties.body.properties.a2ui.properties.components.items.properties.component.enum;
    expect(schema.properties.body.properties.view_id).toMatchObject({ type: "string", minLength: 1 });
    expect(schema.properties.body.oneOf).toHaveLength(2);
    expect(catalog).toEqual(expect.arrayContaining(["Image", "Video", "AudioPlayer", "HrMetric", "HrTimeline", "HrBarChart", "HrDag"]));
    expect(catalog).not.toEqual(expect.arrayContaining(["Button", "TextField", "Modal"]));
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("never mutates the Canvas directly");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("readable fallback");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("flat top-level tool arguments");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("always use its advertised shallow form");
    expect(REPORT_SURFACE_STATE_PROMPT.indexOf("always use its advertised shallow form"))
      .toBeLessThan(REPORT_SURFACE_STATE_PROMPT.indexOf("Only when no pinned Skill view fits"));
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("omit patch_id, patch_sequence");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("phases only move forward");
    expect(REPORT_SURFACE_STATE_PROMPT).toContain("correct that value and retry the same required phase");
  });

  it("resolves a digest-pinned Skill view without letting the model copy or modify A2UI", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["review:summary", pinnedA2ui], ["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    expect(tool.description).toContain("Pinned Skill view_id values: review:summary, summary");
    expect(tool.description).toContain("PINNED SKILL VIEW MODE");
    expect(tool.description).toContain("only top-level arguments are phase, view_id, data, optional fallback");
    expect(tool.description).toContain("summary data keys: coverage, events, options, route");
    expect(tool.description).toContain("Worker assigns patch_id and patch_sequence");
    expect(tool.input_schema).toMatchObject(REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA);
    expect((tool.input_schema.properties as Record<string, Record<string, unknown>>).view_id?.enum)
      .toEqual(["review:summary", "summary"]);
    expect(Object.keys((tool.input_schema.properties ?? {}) as Record<string, unknown>)).toEqual([
      "phase",
      "view_id",
      "data",
      "fallback",
      "presentation_hint",
    ]);
    expect(JSON.stringify(tool.input_schema)).not.toContain('"op"');
    expect(JSON.stringify(tool.input_schema)).not.toContain('"body"');
    const result = await tool.handler({
      phase: "partial",
      view_id: "summary",
      data: { coverage: 91 },
      fallback: "Pinned summary",
      presentation_hint: { density: "summary", canvas_size: "1x1" },
    });

    expect(payload(result)).toMatchObject({ status: "submitted", patch_sequence: 1 });
    expect(emitted).toHaveLength(1);
    const patch = emitted[0]!.patch;
    if (patch.op !== "replace_body") throw new Error("expected replace_body");
    expect(patch.patch_id).toMatch(/^worker-[a-f0-9]{24}$/);
    expect(patch.body.a2ui).toEqual(pinnedA2ui);
    expect(patch.body.data).toEqual({ coverage: 91 });
    expect(patch.body.fallback).toEqual({ title: "Pinned summary" });
    expect(JSON.stringify(patch.body)).not.toContain("view_id");
  });

  it("materializes trusted source fields and source prefixes instead of trusting model copies", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config({
      outgoing_edges: [{ from_port: "done", to_node: "sink", to_port: "in" }],
      graph_nodes: ["research", "sink"],
    }), "run-trusted-pinned", vi.fn());
    const pinnedA2ui: HomerailA2uiSurfaceV1 = {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "Column", children: ["title", "steps", "phase"] },
        { id: "title", component: "Text", text: { path: "/actor_view/data/title" } },
        { id: "steps", component: "List", children: { path: "/actor_view/data/steps", componentId: "step" } },
        { id: "step", component: "Text", text: { path: "label" } },
        { id: "phase", component: "Text", text: { path: "/actor_view/data/phase_text" } },
      ],
    };
    const dataContract: DagWorkerSkillVisualDataContractV1 = {
      source: {
        input_port: "mission",
        value_index: 0,
        encoding: "json" as const,
        json_prefix: "EVIDENCE: ",
        pointer: "/route/data",
      },
      required_phases: ["started", "partial", "final"],
      fields: [
        { field: "title", mode: "source" as const, source_pointer: "/title" },
        { field: "steps", mode: "source_prefix" as const, source_pointer: "/steps", max_items: 2 },
        {
          field: "phase_text",
          mode: "presentation" as const,
          value_schema: { type: "string" as const, enum: ["Starting", "Working", "Done"], max_length: 32 },
        },
      ],
    };
    const tools = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["route", pinnedA2ui]]),
      pinnedSurfaceDataContracts: new Map([["route", dataContract]]),
      trustedInputs: {
        mission: ["EVIDENCE: {\"route\":{\"data\":{\"title\":\"Trusted route\",\"steps\":[{\"label\":\"one\"},{\"label\":\"two\"}]}}}"],
      },
    });
    const tool = tools.find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const handoff = tools.find((candidate) => candidate.name === "handoff")!;

    const earlyHandoff = await handoff.handler({ port: "done", content: { status: "ready" } });
    expect(payload(earlyHandoff)).toMatchObject({
      status: "rejected",
      code: "surface_sequence_incomplete",
      expected_phase: "started",
      retryable: true,
    });
    expect(state.yielded).toBe(false);

    expect(tool.description).toContain("omit Worker-owned source fields [title]");
    expect(tool.description).toContain("send integer prefix counts [steps<=2]");
    expect(tool.description).toContain(
      'model-owned presentation fields [phase_text:<=32 chars enum="Starting"|"Working"|"Done"]',
    );
    expect(tool.description).toContain("required calls in exact order [started -> partial -> final]");
    expect(tool.description).toContain("derives fallback from trusted title/summary");
    const contractedInputSchema = tool.input_schema as Record<string, unknown>;
    const contractedProperties = contractedInputSchema.properties as Record<string, Record<string, unknown>>;
    expect(contractedInputSchema).toMatchObject({
      required: ["phase", "view_id", "steps"],
      additionalProperties: false,
    });
    expect(contractedProperties.steps).toMatchObject({ type: "integer", minimum: 0, maximum: 2 });
    expect(contractedProperties.phase_text).toMatchObject({
      type: "string",
      enum: ["Starting", "Working", "Done"],
      maxLength: 32,
      description: expect.stringContaining("Presentation-only"),
    });
    expect(contractedProperties.canvas_size).toBeUndefined();
    expect(contractedProperties.density).toBeUndefined();
    expect(contractedProperties.preferred_visual).toBeUndefined();
    expect(contractedProperties.data).toBeUndefined();
    expect(contractedProperties.presentation_hint).toBeUndefined();
    expect(contractedProperties.title).toBeUndefined();

    const prematureFinal = await tool.handler({
      phase: "final",
      view_id: "route",
      data: { steps: 2, phase_text: "Done" },
    });
    expect(payload(prematureFinal)).toMatchObject({
      status: "rejected",
      code: "phase_sequence",
      expected_phase: "started",
    });
    expect(emitted).toHaveLength(0);

    const overlongPresentation = await tool.handler({
      phase: "started",
      view_id: "route",
      steps: 0,
      phase_text: "x".repeat(33),
    });
    expect(payload(overlongPresentation)).toMatchObject({
      status: "rejected",
      code: "invalid_data_projection",
      message: "data.phase_text must contain between 1 and 32 characters; received 33",
      retryable: true,
      expected_phase: "started",
      issues: [
        "data.phase_text must contain between 1 and 32 characters; received 33",
        'data.phase_text must be one of "Starting", "Working", "Done"',
      ],
      next_action: "Correct every rejected presentation value and retry report_surface_state with phase started.",
    });
    expect(emitted).toHaveLength(0);

    const unknownPresentationEnum = await tool.handler({
      phase: "started",
      view_id: "route",
      steps: 0,
      phase_text: "Unknown",
    });
    expect(payload(unknownPresentationEnum)).toMatchObject({
      status: "rejected",
      code: "invalid_data_projection",
      message: 'data.phase_text must be one of "Starting", "Working", "Done"',
      retryable: true,
      expected_phase: "started",
    });
    expect(emitted).toHaveLength(0);

    const started = await tool.handler({
      phase: "started",
      view_id: "route",
      steps: 0,
      phase_text: "Starting",
    });
    expect(payload(started)).toMatchObject({
      status: "submitted",
      source_prefix_counts: { steps: 0 },
      next_allowed_phases: ["partial"],
      next_action: "Call report_surface_state next with phase partial.",
    });
    const startedPatch = emitted[0]!.patch;
    if (startedPatch.op !== "replace_body") throw new Error("expected replace_body");
    expect(startedPatch.body.fallback).toEqual({ title: "Trusted route" });
    expect(startedPatch.body.presentation_hint).toBeUndefined();

    const skippedPartial = await tool.handler({
      phase: "final",
      view_id: "route",
      data: { steps: 2, phase_text: "Done" },
    });
    expect(payload(skippedPartial)).toMatchObject({
      status: "rejected",
      code: "phase_sequence",
      expected_phase: "partial",
    });
    expect(emitted).toHaveLength(1);

    const partial = await tool.handler({
      phase: "partial",
      view_id: "route",
      data: {
        title: "model rewrote this",
        steps: [{ label: "invented" }],
        phase_text: "Working",
      },
    });
    expect(payload(partial)).toMatchObject({
      status: "submitted",
      trusted_data_materialized: ["title", "steps"],
      ignored_model_source_fields: ["title"],
      normalized_legacy_prefix_arrays: ["steps"],
      source_prefix_counts: { steps: 1 },
      next_allowed_phases: ["final"],
    });
    const partialPatch = emitted[1]!.patch;
    if (partialPatch.op !== "replace_body") throw new Error("expected replace_body");
    expect(partialPatch.body.data).toEqual({
      title: "Trusted route",
      steps: [{ label: "one" }],
      phase_text: "Working",
    });

    const final = await tool.handler({
      phase: "final",
      view_id: "route",
      data: { steps: 2, phase_text: "Done" },
    });
    expect(payload(final)).toMatchObject({
      status: "submitted",
      source_prefix_counts: { steps: 2 },
      trusted_final_prefix_values: {
        steps: [{ label: "one" }, { label: "two" }],
      },
    });
    const finalPatch = emitted[2]!.patch;
    if (finalPatch.op !== "replace_body") throw new Error("expected replace_body");
    expect(finalPatch.body.data).toEqual({
      title: "Trusted route",
      steps: [{ label: "one" }, { label: "two" }],
      phase_text: "Done",
    });

    const completedHandoff = await handoff.handler({ port: "done", content: { status: "ready" } });
    expect(completedHandoff.is_error).not.toBe(true);
    expect(state.yielded).toBe(true);
  });

  it("allows a handoff-only correction after Manager attests the current round's final Surface", async () => {
    const state = createDagToolsState(config({
      outgoing_edges: [{ from_port: "done", to_node: "sink", to_port: "in" }],
      graph_nodes: ["research", "sink"],
      surface_patch_sequence_start: 3,
      surface_reporting_complete: true,
    }), "run-surface-correction", vi.fn());
    const pinnedA2ui: HomerailA2uiSurfaceV1 = {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
    };
    const tools = createDagTools(state, {
      surfacePatchEmitter: vi.fn(),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
      pinnedSurfaceDataContracts: new Map([["summary", {
        source: { input_port: "mission", encoding: "json" as const },
        required_phases: ["started", "partial", "final"] as ["started", "partial", "final"],
        fields: [{ field: "title", mode: "source" as const, source_pointer: "/title" }],
      }]]),
      trustedInputs: { mission: ['{"title":"Trusted"}'] },
    });
    const handoff = tools.find((candidate) => candidate.name === "handoff")!;

    expect(state).toMatchObject({
      surfaceReportingRequired: true,
      surfaceReportingComplete: true,
      surfaceExpectedPhase: undefined,
    });
    const result = await handoff.handler({ port: "done", content: { status: "ready" } });
    expect(result.is_error).not.toBe(true);
    expect(state.yielded).toBe(true);
  });

  it("binds a final source prefix to trusted command input instead of the model count", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-command-bound-prefix", vi.fn());
    const pinnedA2ui: HomerailA2uiSurfaceV1 = {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: "root", component: "List", children: { path: "/actor_view/data/steps", componentId: "step" } },
        { id: "step", component: "Text", text: { path: "label" } },
      ],
    };
    const dataContract: DagWorkerSkillVisualDataContractV1 = {
      source: { input_port: "mission", encoding: "json", pointer: "/route" },
      required_phases: ["started", "partial", "final"],
      fields: [{
        field: "steps",
        mode: "source_prefix",
        source_pointer: "/steps",
        max_items: 3,
        final_count: {
          source: { input_port: "command", pointer: "/payload/steps_count" },
          default: 2,
        },
      }],
    };
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["route", pinnedA2ui]]),
      pinnedSurfaceDataContracts: new Map([["route", dataContract]]),
      trustedInputs: {
        mission: [JSON.stringify({ route: { steps: [{ label: "one" }, { label: "two" }, { label: "three" }] } })],
        command: [{ payload: { steps_count: 1 } }],
      },
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    expect(tool.description).toContain("steps<=1 (this turn's trusted final count)");
    const inputSchema = tool.input_schema as Record<string, unknown>;
    const inputProperties = inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(inputProperties.steps).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 1,
      description: expect.stringContaining("trusted final count is 1"),
    });
    for (const phase of ["started", "partial", "final"] as const) {
      const result = await tool.handler({
        phase,
        view_id: "route",
        steps: 3,
      });
      expect(payload(result)).toMatchObject({
        status: "submitted",
        source_prefix_counts: { steps: 1 },
        trusted_final_prefix_counts: { steps: 1 },
        adjusted_source_prefix_counts: { steps: { requested: 3, applied: 1 } },
        ...(phase === "final"
          ? { trusted_final_prefix_values: { steps: [{ label: "one" }] } }
          : {}),
      });
    }
    expect(emitted).toHaveLength(3);
    for (const proposal of emitted) {
      if (proposal.patch.op !== "replace_body") throw new Error("expected replace_body");
      expect(proposal.patch.body.data.steps).toEqual([{ label: "one" }]);
    }
  });

  it("fails closed when a trusted data contract cannot resolve or receives undeclared data", async () => {
    const state = createDagToolsState(config({
      outgoing_edges: [{ from_port: "done", to_node: "sink", to_port: "in" }],
      graph_nodes: ["research", "sink"],
    }), "run-trusted-rejected", vi.fn());
    const pinnedA2ui: HomerailA2uiSurfaceV1 = {
      version: HOMERAIL_A2UI_VERSION,
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [{ id: "root", component: "Text", text: { path: "/actor_view/data/title" } }],
    };
    const options = {
      surfacePatchEmitter: vi.fn(),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
      pinnedSurfaceDataContracts: new Map([["summary", {
        source: { input_port: "mission", encoding: "json" as const, pointer: "/result" },
        required_phases: ["started", "partial", "final"] as ["started", "partial", "final"],
        fields: [{ field: "title", mode: "source" as const, source_pointer: "/title" }],
      }]]),
      trustedInputs: { mission: ["{}"] },
    };
    const tools = createDagTools(state, options);
    const tool = tools.find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const handoff = tools.find((candidate) => candidate.name === "handoff")!;

    const unresolved = await tool.handler({
      phase: "started",
      view_id: "summary",
      data: {},
      fallback: "Summary",
    });
    expect(payload(unresolved)).toMatchObject({
      status: "rejected",
      code: "source_contract_unavailable",
      retryable: false,
      next_action: expect.stringMatching(/Do not retry report_surface_state or call handoff.*End the turn/),
    });
    const blockedHandoff = await handoff.handler({ port: "done", content: { status: "ready" } });
    expect(payload(blockedHandoff)).toMatchObject({
      status: "rejected",
      code: "surface_reporting_blocked",
      retryable: false,
    });
    expect(state.yielded).toBe(false);

    options.trustedInputs.mission[0] = '{"result":{"title":"Trusted"}}';
    const unknown = await tool.handler({
      phase: "started",
      view_id: "summary",
      data: { extra: "not declared" },
      fallback: "Summary",
    });
    expect(payload(unknown)).toMatchObject({ status: "rejected", code: "invalid_data_projection" });
    expect(options.surfacePatchEmitter).not.toHaveBeenCalled();
  });

  it("drops unknown pinned fallback fields without weakening known field bounds", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-pinned-fallback", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const accepted = await tool.handler({
      phase: "partial",
      view_id: "summary",
      data: { coverage: 91 },
      fallback: {
        title: "Pinned summary",
        summary: "Verified source data",
        items: ["one"],
        fallback: "provider-added duplicate",
      },
    });

    expect(payload(accepted)).toMatchObject({ status: "submitted", patch_sequence: 1 });
    const patch = emitted[0]!.patch;
    if (patch.op !== "replace_body") throw new Error("expected replace_body");
    expect(patch.body.fallback).toEqual({
      title: "Pinned summary",
      summary: "Verified source data",
      items: ["one"],
    });

    const rejected = await tool.handler({
      phase: "partial",
      view_id: "summary",
      data: { coverage: 92 },
      fallback: { title: "Still bounded", items: ["x".repeat(501)] },
    });
    expect(payload(rejected)).toMatchObject({ status: "rejected", code: "invalid_arguments" });
    expect(emitted).toHaveLength(1);
  });

  it("keeps pinned protocol sequencing Worker-owned even when a model sends stale values", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config({ surface_patch_sequence_start: 8 }), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const result = await tool.handler({
      patch_id: "model-owned-id",
      patch_sequence: 1,
      phase: "partial",
      view_id: "summary",
      data: { coverage: 91 },
      fallback: "Pinned summary",
    });

    expect(payload(result)).toMatchObject({ status: "submitted", patch_sequence: 9 });
    expect(emitted[0]!.patch).toMatchObject({ patch_sequence: 9 });
    expect(emitted[0]!.patch.patch_id).toMatch(/^worker-[a-f0-9]{24}$/);
  });

  it("serializes concurrent pinned media calls before assigning protocol sequence", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const call = (phase: "started" | "partial") => tool.handler({
      phase,
      view_id: "summary",
      data: { coverage: phase === "started" ? 10 : 50 },
      fallback: `Pinned ${phase}`,
    });
    const results = await Promise.all([call("started"), call("partial")]);

    expect(results.map(payload).map((entry) => entry.patch_sequence)).toEqual([1, 2]);
    expect(emitted.map((entry) => entry.patch.patch_sequence)).toEqual([1, 2]);
    expect(new Set(emitted.map((entry) => entry.patch.patch_id)).size).toBe(2);
  });

  it("keeps Surface phases monotonic and closes reporting after final", async () => {
    const emitted: DagActorSurfacePatchProposalV1[] = [];
    const state = createDagToolsState(config(), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: (proposal) => emitted.push(proposal),
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;
    const call = (phase: "started" | "partial" | "final") => tool.handler({
      phase,
      view_id: "summary",
      data: { coverage: phase === "started" ? 10 : phase === "partial" ? 50 : 100 },
      fallback: `Pinned ${phase}`,
    });

    expect(payload(await call("started"))).toMatchObject({
      status: "submitted",
      patch_sequence: 1,
      surface_phase: "started",
      next_allowed_phases: ["started", "partial", "verified", "refined", "final"],
    });
    expect(payload(await call("partial"))).toMatchObject({ status: "submitted", patch_sequence: 2 });
    expect(payload(await call("started"))).toMatchObject({
      status: "rejected",
      code: "phase_regression",
      expected_patch_sequence: 3,
    });
    expect(payload(await call("final"))).toMatchObject({
      status: "submitted",
      patch_sequence: 3,
      surface_turn_closed: true,
    });
    const afterFinal = await call("partial");
    expect(afterFinal.is_error).not.toBe(true);
    expect(payload(afterFinal)).toMatchObject({
      status: "ignored",
      code: "surface_turn_closed",
      expected_patch_sequence: 4,
    });
    expect(emitted.map((entry) => entry.patch.phase)).toEqual(["started", "partial", "final"]);
    expect(state.surfacePatchSequence).toBe(3);
  });

  it("rejects ambiguous pinned shorthand without consuming a sequence", async () => {
    const emit = vi.fn();
    const state = createDagToolsState(config(), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: emit,
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const result = await tool.handler({
      patch_id: "patch-1",
      patch_sequence: 1,
      phase: "partial",
      op: "replace_body",
      view_id: "summary",
      data: {},
      fallback: "Pinned summary",
    });

    expect(payload(result)).toMatchObject({
      status: "rejected",
      code: "invalid_arguments",
      expected_patch_sequence: 1,
    });
    expect(state.surfacePatchSequence).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("fails closed for unknown or model-overridden pinned views", async () => {
    const emit = vi.fn();
    const state = createDagToolsState(config(), "run-pinned", vi.fn());
    const pinnedA2ui = structuredClone(richBody().a2ui) as NonNullable<
      Extract<DagActorSurfacePatchProposalV1["patch"], { op: "replace_body" }>["body"]
    >["a2ui"];
    const tool = createDagTools(state, {
      surfacePatchEmitter: emit,
      pinnedSurfaceViews: new Map([["summary", pinnedA2ui]]),
    }).find((candidate) => candidate.name === REPORT_SURFACE_STATE_TOOL_NAME)!;

    const unknown = await tool.handler(replaceArgs({
      body: { view_id: "missing", data: {}, fallback: { title: "Missing" } },
    }));
    expect(payload(unknown)).toMatchObject({
      status: "rejected",
      code: "unknown_profile_view",
      expected_patch_sequence: 1,
    });

    const overridden = await tool.handler(replaceArgs({
      body: {
        view_id: "summary",
        a2ui: richBody().a2ui,
        data: {},
        fallback: { title: "Override" },
      },
    }));
    expect(payload(overridden)).toMatchObject({ status: "rejected", code: "invalid_profile_view" });
    expect(emit).not.toHaveBeenCalled();
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
      surface_phase: "partial",
      next_allowed_phases: ["partial", "verified", "refined", "final"],
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

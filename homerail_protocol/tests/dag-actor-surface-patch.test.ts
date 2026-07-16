import { describe, expect, it } from "vitest";
import {
  DAG_ACTOR_SURFACE_PATCH_MAX_BYTES,
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  validateDagActorSurfacePatchV1,
  type DagActorSurfacePatchV1,
} from "../src/index.js";

function patch(): DagActorSurfacePatchV1 {
  return {
    schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "research",
    session_id: "session-1",
    round_id: "round-1",
    actor_id: "actor-research",
    generation: 1,
    lease_generation: 2,
    patch_id: "patch-1",
    patch_sequence: 1,
    timestamp: 1_725_000_000_000,
    op: "replace_body",
    phase: "partial",
    body: {
      a2ui: {
        version: HOMERAIL_A2UI_VERSION,
        catalogId: HOMERAIL_A2UI_CATALOG_ID,
        components: [
          { id: "root", component: "Column", children: ["title"] },
          { id: "title", component: "Text", text: { path: "/actor_view/data/title" } },
        ],
      },
      data: { title: "Bounded result" },
      fallback: { title: "Result", summary: "Bounded result" },
      presentation_hint: { density: "summary", canvas_size: "2x2" },
    },
  };
}

describe("DagActorSurfacePatchV1", () => {
  it("accepts an exact passive replace_body patch and a body-less clear_body patch", () => {
    expect(validateDagActorSurfacePatchV1(patch())).toEqual({ valid: true, errors: [] });
    const clear: DagActorSurfacePatchV1 = {
      ...patch(),
      patch_id: "patch-2",
      patch_sequence: 2,
      op: "clear_body",
      phase: "final",
      body: undefined,
    };
    delete (clear as { body?: unknown }).body;
    expect(validateDagActorSurfacePatchV1(clear)).toEqual({ valid: true, errors: [] });
    expect(validateDagActorSurfacePatchV1({ ...clear, body: patch().body }).valid).toBe(false);
  });

  it("is exact and rejects missing fence identity or unknown fields", () => {
    const missing = { ...patch() } as Record<string, unknown>;
    delete missing.lease_generation;
    expect(validateDagActorSurfacePatchV1(missing).valid).toBe(false);
    expect(validateDagActorSurfacePatchV1({ ...patch(), surface_id: "sibling" }).valid).toBe(false);
  });

  it("rejects interactive components, forms, function actions, and HTML artifacts", () => {
    const button = patch();
    if (button.op !== "replace_body") throw new Error("unexpected patch operation");
    button.body.a2ui.components = [
      { id: "root", component: "Column", children: ["label", "button"] },
      { id: "label", component: "Text", text: "Unsafe" },
      {
        id: "button",
        component: "Button",
        child: "label",
        action: { event: { name: "unsafe" } },
      },
    ];
    expect(validateDagActorSurfacePatchV1(button).errors.map((error) => error.keyword))
      .toContain("actorSurfacePassiveCatalog");

    const form = patch();
    if (form.op !== "replace_body") throw new Error("unexpected patch operation");
    form.body.a2ui.components = [
      { id: "root", component: "TextField", label: "Input" },
    ];
    expect(validateDagActorSurfacePatchV1(form).valid).toBe(false);

    const functionAction = patch();
    if (functionAction.op !== "replace_body") throw new Error("unexpected patch operation");
    functionAction.body.a2ui.components = [
      { id: "root", component: "Button", child: "label", action: { functionCall: { call: "not" } } },
      { id: "label", component: "Text", text: "Unsafe" },
    ];
    expect(validateDagActorSurfacePatchV1(functionAction).valid).toBe(false);

    const html = patch();
    if (html.op !== "replace_body") throw new Error("unexpected patch operation");
    html.body.a2ui.components = [
      { id: "html", component: "HrArtifact", kind: "html", uri: "/artifact/result.html" },
      { id: "root", component: "Column", children: ["html"] },
    ];
    expect(validateDagActorSurfacePatchV1(html).errors.map((error) => error.keyword))
      .toContain("actorSurfaceHtml");
  });

  it("enforces Actor data ownership and the narrower graph budgets", () => {
    const owned = patch();
    if (owned.op !== "replace_body") throw new Error("unexpected patch operation");
    owned.body.a2ui.components[1] = {
      id: "title",
      component: "Text",
      text: { path: "/data/projector" },
    };
    expect(validateDagActorSurfacePatchV1(owned).errors.map((error) => error.keyword))
      .toContain("actorSurfaceDataOwnership");

    const wide = patch();
    if (wide.op !== "replace_body") throw new Error("unexpected patch operation");
    const children = Array.from({ length: 17 }, (_, index) => `item-${index}`);
    wide.body.a2ui.components = [
      { id: "root", component: "Column", children },
      ...children.map((id) => ({ id, component: "Text" as const, text: id })),
    ];
    expect(validateDagActorSurfacePatchV1(wide).errors.map((error) => error.keyword))
      .toContain("maxActorSurfaceDirectChildren");

    const deep = patch();
    if (deep.op !== "replace_body") throw new Error("unexpected patch operation");
    deep.body.a2ui.components = [
      { id: "root", component: "Column", children: ["d2"] },
      { id: "d2", component: "Column", children: ["d3"] },
      { id: "d3", component: "Column", children: ["d4"] },
      { id: "d4", component: "Column", children: ["d5"] },
      { id: "d5", component: "Column", children: ["d6"] },
      { id: "d6", component: "Column", children: ["d7"] },
      { id: "d7", component: "Text", text: "too deep" },
    ];
    expect(validateDagActorSurfacePatchV1(deep).errors.map((error) => error.keyword))
      .toContain("maxActorSurfaceDepth");
  });

  it("rejects payloads above 64 KiB before schema traversal", () => {
    const oversized = patch();
    if (oversized.op !== "replace_body") throw new Error("unexpected patch operation");
    oversized.body.data = { value: "x".repeat(DAG_ACTOR_SURFACE_PATCH_MAX_BYTES) };
    expect(validateDagActorSurfacePatchV1(oversized)).toMatchObject({
      valid: false,
      errors: [{ keyword: "maxPayloadBytes" }],
    });
  });
});

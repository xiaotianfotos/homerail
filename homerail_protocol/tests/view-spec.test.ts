import { describe, expect, it } from "vitest";
import {
  applyHomerailDirectUiProjection,
  buildHomerailViewModel,
  HOMERAIL_VIEW_SPEC_MAX_BYTES,
  validateGenerativeUiNode,
  validateHomerailViewSpec,
  type GenerativeUiNodeV1,
  type HomerailViewSpecV1,
} from "../src/index.js";

function view(): HomerailViewSpecV1 {
  return {
    view_version: 1,
    root: {
      id: "root",
      type: "stack",
      gap: "md",
      children: [
        { id: "title", type: "heading", text: { path: "/data/title" }, level: 2 },
        {
          id: "metrics",
          type: "grid",
          columns: { default: 2, compact: 1 },
          children: [
            { id: "passed", type: "metric", label: { literal: "Passed" }, value: { path: "/data/passed", format: "number" }, tone: "positive" },
            { id: "risk", type: "badge", text: { path: "/data/status" }, tone: { path: "/data/status", format: "tone" } },
          ],
        },
        {
          id: "checks",
          type: "repeat",
          source: "/data/checks",
          max_items: 4,
          item: {
            id: "check",
            type: "section",
            title: { item_path: "/label" },
            children: [{ id: "check-detail", type: "text", text: { item_path: "/detail" } }],
          },
        },
      ],
    },
  };
}

function node(viewValue: HomerailViewSpecV1 = view()): GenerativeUiNodeV1 {
  return {
    ir_version: 1,
    id: "com.example.views:one",
    kind: "com.example.views/generated",
    kind_version: 1,
    owner: { id: "com.example.views", version: "1.0.0" },
    surface: "result",
    importance: "primary",
    content: {
      data: {
        title: "Release readiness",
        passed: 3,
        status: "blocked",
        checks: [
          { label: "Manager", detail: "583 passed" },
          { label: "Windows", detail: "Pending" },
        ],
      },
    },
    view: viewValue,
    fallback: { title: "Release readiness" },
  };
}

describe("ViewSpec V1", () => {
  it("validates and materializes bounded runtime bindings and repeats", () => {
    expect(validateHomerailViewSpec(view()).valid).toBe(true);
    expect(validateGenerativeUiNode(node()).valid).toBe(true);
    const model = buildHomerailViewModel(view(), node().content, { locale: "en-US" });
    expect(model.node_count).toBe(10);
    expect(model.root.children?.[0]).toMatchObject({ type: "heading", text: "Release readiness" });
    expect(model.root.children?.[1].children?.[0]).toMatchObject({ type: "metric", value: "3", tone: "positive" });
    expect(model.root.children?.[1].children?.[1]).toMatchObject({ type: "badge", text: "blocked", tone: "warning" });
    expect(model.root.children?.[2].children).toEqual([
      expect.objectContaining({ id: "check:0", title: "Manager" }),
      expect.objectContaining({ id: "check:1", title: "Windows" }),
    ]);
  });

  it("rejects unknown shape, duplicate ids, out-of-scope item bindings, and unbound actions", () => {
    expect(validateHomerailViewSpec({
      view_version: 1,
      root: { id: "root", type: "text", text: { literal: "Hello" }, css: "position:fixed" },
    }).valid).toBe(false);
    const duplicate = view();
    (duplicate.root as Extract<typeof duplicate.root, { type: "stack" }>).children[1].id = "title";
    expect(validateHomerailViewSpec(duplicate).errors.some(error => error.keyword === "uniqueViewNodeId")).toBe(true);
    expect(validateHomerailViewSpec({
      view_version: 1,
      root: { id: "root", type: "text", text: { item_path: "/secret" } },
    }).errors.some(error => error.keyword === "itemBindingScope")).toBe(true);
    expect(validateHomerailViewSpec({
      view_version: 1,
      root: { id: "root", type: "action", action_id: "delete", label: { literal: "Delete" } },
    }, { action_ids: new Set(["approve"]) }).errors.some(error => error.keyword === "viewActionReference")).toBe(true);
    expect(validateGenerativeUiNode(node({
      view_version: 1,
      root: { id: "root", type: "action", action_id: "inspect", label: { literal: "Inspect" } },
    })).errors.some(error => error.keyword === "viewActionReference")).toBe(true);
    expect(validateHomerailViewSpec({
      view_version: 1,
      root: { id: "root", type: "heading" },
    }).errors.some(error => error.keyword === "required")).toBe(true);
  });

  it("enforces byte, depth, template-node, and repeat limits", () => {
    expect(validateHomerailViewSpec({
      view_version: 1,
      root: { id: "oversized", type: "text", text: { literal: "x".repeat(HOMERAIL_VIEW_SPEC_MAX_BYTES) } },
    }).errors.some(error => error.keyword === "maxPayloadBytes")).toBe(true);

    let deepRoot: HomerailViewSpecV1["root"] = { id: "leaf", type: "text", text: { literal: "leaf" } };
    for (let depth = 0; depth < 8; depth += 1) {
      deepRoot = { id: `depth-${depth}`, type: "section", children: [deepRoot] };
    }
    expect(validateHomerailViewSpec({ view_version: 1, root: deepRoot })
      .errors.some(error => error.keyword === "maxViewDepth")).toBe(true);

    const wideRoot: HomerailViewSpecV1["root"] = {
      id: "wide-root",
      type: "stack",
      children: Array.from({ length: 24 }, (_, group) => ({
        id: `group-${group}`,
        type: "stack" as const,
        children: Array.from({ length: 6 }, (_, item) => ({
          id: `item-${group}-${item}`,
          type: "text" as const,
          text: { literal: "item" },
        })),
      })),
    };
    expect(validateHomerailViewSpec({ view_version: 1, root: wideRoot })
      .errors.some(error => error.keyword === "maxViewNodes")).toBe(true);

    expect(validateHomerailViewSpec({
      view_version: 1,
      root: {
        id: "repeat",
        type: "repeat",
        source: "/data/items",
        max_items: 51,
        item: { id: "entry", type: "text", text: { item_path: "" } },
      },
    }).valid).toBe(false);

    const repeated = buildHomerailViewModel({
      view_version: 1,
      root: {
        id: "repeat",
        type: "repeat",
        source: "/data/items",
        max_items: 50,
        item: { id: "entry", type: "text", text: { item_path: "" } },
      },
    }, { data: { items: Array.from({ length: 60 }, (_, index) => `item-${index}`) } });
    expect(repeated.root.children).toHaveLength(50);
    expect(repeated.node_count).toBe(51);

    const oversizedMaterialization = node({
      view_version: 1,
      root: {
        id: "repeat",
        type: "repeat",
        source: "/data/items",
        max_items: 50,
        item: {
          id: "entry",
          type: "stack",
          children: [
            { id: "entry-title", type: "text", text: { item_path: "/title" } },
            { id: "entry-detail", type: "text", text: { item_path: "/detail" } },
          ],
        },
      },
    });
    oversizedMaterialization.content = {
      data: {
        items: Array.from({ length: 50 }, (_, index) => ({
          title: `Item ${index}`,
          detail: `Detail ${index}`,
        })),
      },
    };
    // Keep existing stored documents readable across upgrades. The dynamic
    // budget is enforced when a new direct projection is written.
    expect(validateGenerativeUiNode(oversizedMaterialization).valid).toBe(true);
    expect(() => applyHomerailDirectUiProjection({
      plugin: { id: "com.example.views", version: "1.0.0" },
      arguments: {
        id: "com.example.views:oversized",
        title: "Oversized",
        content: oversizedMaterialization.content,
        view: oversizedMaterialization.view,
      },
      projection: {
        projection_version: 1,
        type: "direct_ui_node",
        kind: "com.example.views/generated",
        kind_version: 1,
        node_id_pointer: "/id",
        content_pointer: "/content",
        view_pointer: "/view",
        omit_content_fields: [],
        fallback: { title_pointer: "/title" },
        defaults: {
          surface: "result",
          importance: "primary",
          density: "detail",
          persistence: "session",
        },
      },
    })).toThrow("Projected UI node view is not materializable: Materialized view exceeds 128 nodes");

    const compactTable = node({
      view_version: 1,
      root: {
        id: "results",
        type: "table",
        source: "/data/items",
        max_items: 50,
        columns: [
          { id: "title", label: "Title", path: "/title" },
          { id: "detail", label: "Detail", path: "/detail" },
        ],
      },
    });
    compactTable.content = structuredClone(oversizedMaterialization.content);
    expect(validateGenerativeUiNode(compactTable).valid).toBe(true);
    const compactModel = buildHomerailViewModel(compactTable.view!, compactTable.content);
    expect(compactModel.node_count).toBe(1);
    expect(compactModel.root.items).toHaveLength(50);
  });

  it("projects ViewSpec and host-owned presentation separately from content", () => {
    const result = applyHomerailDirectUiProjection({
      plugin: { id: "com.example.views", version: "1.0.0" },
      arguments: {
        id: "com.example.views:one",
        title: "Runtime view",
        surface: "task",
        importance: "critical",
        density: "summary",
        canvas_size: "1x2",
        persistence: "turn",
        content: node().content,
        view: view(),
      },
      projection: {
        projection_version: 1,
        type: "direct_ui_node",
        kind: "com.example.views/generated",
        kind_version: 1,
        node_id_pointer: "/id",
        content_pointer: "/content",
        view_pointer: "/view",
        surface_pointer: "/surface",
        importance_pointer: "/importance",
        density_pointer: "/density",
        canvas_size_pointer: "/canvas_size",
        persistence_pointer: "/persistence",
        omit_content_fields: [],
        fallback: { title_pointer: "/title" },
        defaults: {
          surface: "result",
          importance: "primary",
          density: "detail",
          canvas_size: "2x2",
          persistence: "session",
        },
      },
    });
    expect(result.node).toMatchObject({
      surface: "task",
      importance: "critical",
      presentation: { density: "summary", canvas_size: "1x2" },
      lifecycle: { persistence: "turn" },
      content: node().content,
      view: view(),
    });
  });

  it("drops unsafe materialized links instead of creating executable navigation", () => {
    const linkView: HomerailViewSpecV1 = {
      view_version: 1,
      root: { id: "link", type: "link", label: { literal: "Unsafe" }, uri: { path: "/data/url" } },
    };
    expect(() => buildHomerailViewModel(linkView, { data: { url: "javascript:alert(1)" } })).toThrow("root did not materialize");
  });

  it("materializes only browser-safe image, HTML, and file artifacts", () => {
    const artifactView: HomerailViewSpecV1 = {
      view_version: 1,
      root: {
        id: "cover",
        type: "artifact",
        kind: "image",
        uri: { path: "/data/url" },
        title: { literal: "AI cover" },
        description: { literal: "Generated from the selected topic" },
        alt: { literal: "Abstract AI cover" },
        layout: "portrait",
      },
    };
    const model = buildHomerailViewModel(artifactView, {
      data: { url: "/api/voice-agent/sessions/session-one/artifacts/cover.png" },
    });
    expect(model.root).toMatchObject({
      type: "artifact",
      artifact_kind: "image",
      uri: "/api/voice-agent/sessions/session-one/artifacts/cover.png",
      title: "AI cover",
      layout: "portrait",
    });
    expect(() => buildHomerailViewModel(artifactView, {
      data: { url: "file:///etc/passwd" },
    })).toThrow("root did not materialize");
  });
});

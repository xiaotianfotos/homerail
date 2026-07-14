import { describe, expect, it } from "vitest";

import {
  GENERATIVE_UI_IR_VERSION,
  type GenerativeUiDocumentV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiSurfaceContextV1,
  type GenerativeUiUserOverrideV1,
} from "homerail-protocol";
import {
  composeGenerativeUi,
  type GenerativeUiKindCompositionMetadataV1,
} from "../src/generative-ui/surface-composer.js";

const time0 = "2026-07-11T19:00:00.000Z";

function node(input: Partial<GenerativeUiStoredNodeV1> & Pick<GenerativeUiStoredNodeV1, "id">): GenerativeUiStoredNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: input.id,
    kind: input.kind ?? "com.example.plugin/card",
    kind_version: input.kind_version ?? 1,
    owner: input.owner ?? { id: "com.example.plugin", version: "1.0.0" },
    surface: input.surface ?? "task",
    importance: input.importance ?? "secondary",
    content: input.content ?? { title: input.id },
    fallback: input.fallback ?? { title: input.id },
    revision: input.revision ?? 1,
    updated_at: input.updated_at ?? time0,
    ...(input.status ? { status: input.status } : {}),
    ...(input.presentation ? { presentation: input.presentation } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
}

function document(nodes: GenerativeUiStoredNodeV1[]): GenerativeUiDocumentV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    document_id: "composer-document",
    scope: { type: "voice_session", id: "voice-session-1" },
    revision: 3,
    nodes,
    updated_at: time0,
  };
}

function context(input: Partial<GenerativeUiSurfaceContextV1> = {}): GenerativeUiSurfaceContextV1 {
  return {
    device: "desktop",
    input: "mouse",
    viewport: "wide",
    attention: "focused",
    ...input,
  };
}

function override(input: Omit<GenerativeUiUserOverrideV1, "document_id" | "updated_at">): GenerativeUiUserOverrideV1 {
  return {
    document_id: "composer-document",
    updated_at: time0,
    ...input,
  };
}

const metadata: GenerativeUiKindCompositionMetadataV1[] = [{
  kind: "com.example.plugin/card",
  kind_version: 1,
  allowed_surfaces: ["task", "result"],
  default_surface: "task",
  default_variant: "detail",
}];

describe("Generative UI Surface Composer", () => {
  it("ranks pinned, urgent, active, importance, recency and id deterministically", () => {
    const nodes = [
      node({ id: "z-pinned", importance: "ambient" }),
      node({ id: "a-failed", status: { phase: "failed" } }),
      node({ id: "active", provenance: { actor: "plugin", run_id: "run-1" } }),
      node({ id: "primary-old", importance: "primary", updated_at: "2026-07-11T18:00:00.000Z" }),
      node({ id: "primary-new", importance: "primary", updated_at: "2026-07-11T18:30:00.000Z" }),
      node({ id: "a-tie" }),
      node({ id: "b-tie" }),
    ];
    const overrides = [override({ node_id: "z-pinned", pinned: true })];
    const composed = composeGenerativeUi(document(nodes), overrides, context({ active_run_id: "run-1" }), metadata);

    expect(composed.items.map((item) => item.node_id)).toEqual([
      "z-pinned",
      "a-failed",
      "active",
      "primary-new",
      "primary-old",
      "a-tie",
      "b-tie",
    ]);
    expect(composed.items.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps user visibility and preferred surface separate from Agent hints", () => {
    const nodes = [
      node({ id: "hidden" }),
      node({ id: "minimized", presentation: { density: "detail" } }),
      node({ id: "moved", surface: "task" }),
      node({ id: "unsafe-move", surface: "task" }),
    ];
    const overrides = [
      override({ node_id: "hidden", visibility: "hidden" }),
      override({ node_id: "minimized", visibility: "minimized", pinned: true }),
      override({ node_id: "moved", preferred_surface: "result" }),
      override({ node_id: "unsafe-move", preferred_surface: "execution" }),
    ];
    const composed = composeGenerativeUi(document(nodes), overrides, context(), metadata);

    expect(composed.hidden_node_ids).toEqual(["hidden"]);
    expect(composed.items.find((item) => item.node_id === "minimized")).toMatchObject({
      variant: "glance",
      placement: "overflow",
      pinned: true,
      visibility: "minimized",
    });
    expect(composed.items.find((item) => item.node_id === "moved")?.surface).toBe("result");
    expect(composed.items.find((item) => item.node_id === "unsafe-move")?.surface).toBe("task");
  });

  it("uses bounded host capacities and never reads plugin coordinate hints", () => {
    const withHints = document([
      node({ id: "one", content: { width: 99, row: "top", component: "RootShell" } }),
      node({ id: "two" }),
      node({ id: "three" }),
    ]);
    const withoutHints = structuredClone(withHints);
    withoutHints.nodes[0].content = {};
    const surfaceContext = context({ surface_capacities: { task: 1 } });

    const composed = composeGenerativeUi(withHints, [], surfaceContext, metadata);
    expect(composed.items.map((item) => item.placement)).toEqual(["primary", "overflow", "overflow"]);
    expect(composeGenerativeUi(withoutHints, [], surfaceContext, metadata)).toEqual(composed);
  });

  it.each([
    ["portrait phone", context({ device: "phone", input: "touch", viewport: "compact" }), "summary"],
    ["landscape phone", context({ device: "phone", input: "touch", viewport: "regular" }), "detail"],
    ["wide desktop", context(), "detail"],
    ["glance TV", context({ device: "tv", input: "gamepad", attention: "glance" }), "glance"],
  ] as const)("selects a finite renderer variant for %s", (_name, surfaceContext, variant) => {
    const composed = composeGenerativeUi(
      document([node({ id: "fixture", presentation: { density: "detail" } })]),
      [],
      surfaceContext,
      metadata,
    );
    expect(composed.items[0].variant).toBe(variant);
  });

  it("produces byte-for-byte stable output for shuffled input order", () => {
    const nodes = [node({ id: "b" }), node({ id: "a" }), node({ id: "c" })];
    const overrides = [
      override({ node_id: "a", pinned: false }),
      override({ node_id: "c", preferred_surface: "result" }),
    ];
    const first = composeGenerativeUi(document(nodes), overrides, context(), metadata);
    const second = composeGenerativeUi(
      document([...nodes].reverse()),
      [...overrides].reverse(),
      context(),
      [...metadata].reverse(),
    );
    expect(second).toEqual(first);
  });

  it("demotes third-party critical importance while preserving blocked urgency", () => {
    const nodes = [
      node({ id: "third-party-critical", importance: "critical", updated_at: "2026-07-11T18:00:00.000Z" }),
      node({ id: "primary-new", importance: "primary", updated_at: "2026-07-11T19:00:00.000Z" }),
      node({ id: "blocked", importance: "ambient", status: { phase: "blocked" } }),
    ];
    const composed = composeGenerativeUi(document(nodes), [], context(), metadata);
    expect(composed.items.map((item) => item.node_id)).toEqual([
      "blocked",
      "primary-new",
      "third-party-critical",
    ]);
  });

  it("rejects ambiguous overrides and unbounded host context", () => {
    const doc = document([node({ id: "one" })]);
    expect(() => composeGenerativeUi(doc, [
      override({ node_id: "one", pinned: true }),
      override({ node_id: "one", visibility: "hidden" }),
    ], context(), metadata)).toThrow("Duplicate Generative UI override");
    expect(() => composeGenerativeUi(doc, [], context({
      surface_capacities: { task: 129 },
    }), metadata)).toThrow("between 0 and 128");
    expect(() => composeGenerativeUi(doc, [], context({
      active_run_id: "not a valid run id",
    }), metadata)).toThrow("bounded identifier");
  });
});

import { describe, expect, it } from "vitest";
import {
  GENERATIVE_UI_CANVAS_CONTEXT_MAX_BYTES,
  GENERATIVE_UI_CANVAS_CONTEXT_MAX_NODES,
  GENERATIVE_UI_IR_VERSION,
  type GenerativeUiDocumentV1,
} from "homerail-protocol";
import { buildGenerativeUiCanvasContext } from "../src/generative-ui/canvas-context.js";
import { _buildManagerAgentPromptForTest } from "../src/server/host-codex-manager-agent.js";

function document(nodeCount = 10): GenerativeUiDocumentV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    document_id: "canvas-one",
    scope: { type: "voice_session", id: "session-one" },
    revision: nodeCount,
    updated_at: "2026-07-13T00:00:00.000Z",
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      ir_version: GENERATIVE_UI_IR_VERSION,
      id: `com.homerail.core:block-${index}`,
      kind: "com.homerail.core/generated_view",
      kind_version: 1,
      owner: { id: "com.homerail.core", version: "0.1.8" },
      surface: "result" as const,
      importance: "primary" as const,
      content: { data: { index, detail: `Block ${index}` } },
      a2ui: {
        version: "v1.0" as const,
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1" as const,
        components: [{ id: "root", component: "Text" as const, text: { path: "/data/detail" } }],
      },
      presentation: { density: "summary" as const, canvas_size: "1x2" as const },
      lifecycle: { persistence: "session" as const },
      fallback: { title: `Block ${index}`, summary: `Summary ${index}` },
      revision: index + 1,
      updated_at: `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  };
}

describe("Generative UI canvas turn context", () => {
  it("places the selected authoritative node first and bounds the node count", () => {
    const context = buildGenerativeUiCanvasContext(
      document(),
      "com.homerail.core:block-1",
    );

    expect(context?.selected_node_id).toBe("com.homerail.core:block-1");
    expect(context?.nodes).toHaveLength(GENERATIVE_UI_CANVAS_CONTEXT_MAX_NODES);
    expect(context?.nodes[0]).toMatchObject({
      id: "com.homerail.core:block-1",
      selected: true,
      content: { data: { index: 1, detail: "Block 1" } },
      a2ui: {
        version: "v1.0",
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        components: [{ id: "root", component: "Text" }],
      },
    });
  });

  it("ignores a forged or stale selected node id", () => {
    const context = buildGenerativeUiCanvasContext(document(2), "other-plugin:forged");

    expect(context?.selected_node_id).toBeUndefined();
    expect(context?.nodes.every((node) => node.selected === false)).toBe(true);
  });

  it("bounds large application content before adding it to a prompt", () => {
    const source = document(1);
    source.nodes[0]!.content = {
      data: {
        rows: Array.from({ length: 100 }, (_, index) => ({
          index,
          text: "x".repeat(5_000),
        })),
      },
    };
    const context = buildGenerativeUiCanvasContext(source, source.nodes[0]!.id)!;

    expect(Buffer.byteLength(JSON.stringify(context), "utf8"))
      .toBeLessThanOrEqual(GENERATIVE_UI_CANVAS_CONTEXT_MAX_BYTES);
    expect(context.nodes[0]!.content_truncated).toBe(true);
  });

  it("omits an over-budget A2UI surface atomically instead of truncating its component graph", () => {
    const source = document(1);
    const childIds = Array.from({ length: 16 }, (_, index) => `detail-${index}`);
    source.nodes[0]!.a2ui = {
      version: "v1.0",
      catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
      components: [
        { id: "root", component: "Column", children: childIds },
        ...childIds.map((id, index) => ({
          id,
          component: "Text" as const,
          text: `Detail ${index}: ${"x".repeat(1_200)}`,
        })),
      ],
    };

    const context = buildGenerativeUiCanvasContext(source, source.nodes[0]!.id)!;

    expect(context.nodes[0]).toMatchObject({
      id: source.nodes[0]!.id,
      content: source.nodes[0]!.content,
      a2ui_omitted: true,
    });
    expect(context.nodes[0]).not.toHaveProperty("a2ui");
    expect(JSON.stringify(context.nodes[0])).not.toContain("detail-0");
    expect(source.nodes[0]!.a2ui.components).toHaveLength(17);
  });

  it("labels canvas values as data and keeps the user message last", () => {
    const canvasContext = buildGenerativeUiCanvasContext(document(1))!;
    const prompt = _buildManagerAgentPromptForTest({
      history: [{ role: "assistant", content: "Earlier answer" }],
      message: "深入第二条",
      canvas_context: canvasContext,
    });

    expect(prompt).toContain("authoritative read-only application data for resolving this request");
    expect(prompt).toContain("Do not claim that the selected Block, its id, or its content is missing");
    expect(prompt).toContain("Resolve references such as 'the second item'");
    expect(prompt).toContain("call update_selected_generated_view");
    expect(prompt).toContain("HomeRail binds that Tool to selected_node_id");
    expect(prompt).toContain('"document_id":"canvas-one"');
    expect(prompt.endsWith("New user message:\n深入第二条")).toBe(true);
  });
});

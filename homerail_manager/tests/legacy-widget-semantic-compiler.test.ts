import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateGenerativeUiNode,
  validateGenerativeUiTransaction,
  type GenerativeUiNodeV1,
} from "homerail-protocol";
import {
  compileLegacyVoiceSurfaceToGenerativeUiTransaction,
  compileLegacyWidgetToGenerativeUiNode,
  type LegacyVoiceWidget,
} from "../src/generative-ui/legacy-widget-compiler.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(testDir, "fixtures", "legacy-widgets");
const fileWidgetTypes = [
  "memo",
  "task_draft",
  "progress_status",
  "checklist",
  "artifact_ref",
  "timeline",
] as const;

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, relativePath), "utf8")) as T;
}

function materializedLegacyWidget(widget: LegacyVoiceWidget): Record<string, unknown> {
  return {
    id: widget.id,
    type: widget.type,
    title: widget.title,
    body: widget.body ?? "",
    priority: widget.priority === "low" || widget.priority === "high" ? widget.priority : "normal",
    status: typeof widget.status === "string" && widget.status.trim() ? widget.status.trim() : null,
    items: [...(widget.items ?? [])],
    steps: [...(widget.steps ?? [])],
    active_step: typeof widget.active_step === "number" && Number.isFinite(widget.active_step)
      ? Math.max(0, Math.floor(widget.active_step))
      : null,
    data: structuredClone(widget.data ?? {}),
  };
}

function semanticProjection(node: GenerativeUiNodeV1): Record<string, unknown> {
  return {
    id: node.id,
    owner: node.owner.id,
    kind: node.kind,
    surface: node.surface,
    importance: node.importance,
    phase: node.status?.phase ?? null,
    status_label: node.status?.label ?? null,
    density: node.presentation?.density ?? null,
    preferred_visual: node.presentation?.preferred_visual ?? null,
    default_visibility: node.lifecycle?.default_visibility ?? null,
  };
}

function expectedFallback(widget: LegacyVoiceWidget): Record<string, unknown> {
  const items = [...(widget.items ?? []), ...(widget.steps ?? [])];
  const fallback: Record<string, unknown> = {
    title: widget.title,
    ...(widget.body ? { summary: widget.body } : {}),
    ...(items.length ? { items } : {}),
  };
  if (widget.data?.artifact_path || widget.data?.preview_path) {
    fallback.artifact_refs = [
      ...(widget.data.artifact_path
        ? [{ label: "Artifact", uri: widget.data.artifact_path }]
        : []),
      ...(widget.data.preview_path
        ? [{ label: "Preview", uri: widget.data.preview_path }]
        : []),
    ];
  }
  return fallback;
}

describe("legacy Widget to semantic transaction compiler", () => {
  const fileGoldens = readJson<Record<string, LegacyVoiceWidget>>("widget-file-protocol.golden.json");
  const dynamicGoldens = readJson<LegacyVoiceWidget[]>("show-dynamic-widget.golden.json");
  const mappingGolden = readJson<Array<Record<string, unknown>>>("semantic-mapping.golden.json");
  const legacyWidgets = [
    ...fileWidgetTypes.map((type) => fileGoldens[type]),
    ...dynamicGoldens,
  ];

  it("compiles every M0 Golden through one valid, deterministic transaction", () => {
    const input = {
      transaction_id: "legacy-compile-1",
      document_id: "voice-session-compat-ui",
      base_revision: 7,
      created_at: "2026-07-11T10:45:00.000Z",
      voice_surface: {
        widgets: legacyWidgets,
        remove_widget_ids: ["obsolete-legacy-widget"],
      },
    } as const;
    const before = structuredClone(input);
    const transaction = compileLegacyVoiceSurfaceToGenerativeUiTransaction(input);

    expect(transaction).not.toBeNull();
    if (!transaction) throw new Error("expected a semantic transaction");
    expect(validateGenerativeUiTransaction(transaction)).toEqual({
      valid: true,
      value: transaction,
      errors: [],
    });
    expect(transaction).toMatchObject({
      transaction_id: "legacy-compile-1",
      document_id: "voice-session-compat-ui",
      base_revision: 7,
      actor: { type: "system", id: "legacy-widget-compiler" },
      created_at: "2026-07-11T10:45:00.000Z",
    });
    expect(transaction.operations).toHaveLength(legacyWidgets.length + 1);
    expect(transaction.operations.at(-1)).toEqual({ op: "remove", node_id: "obsolete-legacy-widget" });

    const nodes = transaction.operations
      .filter((operation) => operation.op === "put")
      .map((operation) => operation.node);
    expect(nodes.map((node) => semanticProjection(node))).toEqual(mappingGolden);
    nodes.forEach((node, index) => {
      expect(node.id).toBe(legacyWidgets[index].id);
      expect(node.owner.version).toBe(node.owner.id === "com.homerail.core" ? "0.1.8" : "0.1.0");
      expect(node.content.legacy_widget).toEqual(materializedLegacyWidget(legacyWidgets[index]));
      const baseFallback = expectedFallback(legacyWidgets[index]);
      expect(node.fallback).toMatchObject({
        title: baseFallback.title,
        ...(baseFallback.summary ? { summary: baseFallback.summary } : {}),
      });
      if (baseFallback.items) {
        expect(node.fallback.items).toEqual(expect.arrayContaining(baseFallback.items as string[]));
      }
      if (baseFallback.artifact_refs) {
        expect(node.fallback.artifact_refs).toEqual(expect.arrayContaining(
          baseFallback.artifact_refs as Array<Record<string, unknown>>,
        ));
      }
      expect(node.lifecycle).toMatchObject({ persistence: "session", removable: true });
      expect(validateGenerativeUiNode(node).valid).toBe(true);
    });

    expect(input).toEqual(before);
    expect(compileLegacyVoiceSurfaceToGenerativeUiTransaction(input)).toEqual(transaction);
  });

  it("preserves opaque Unicode stable ids verbatim", () => {
    const node = compileLegacyWidgetToGenerativeUiNode({
      id: "widget-note-任务 草稿",
      type: "note",
      title: "任务草稿",
      body: "保留旧 Widget id。",
      priority: "normal",
      items: [],
      steps: [],
      data: {},
    });

    expect(node.id).toBe("widget-note-任务 草稿");
    expect(validateGenerativeUiNode(node).valid).toBe(true);
  });

  it("materializes a portable fallback for unknown legacy types", () => {
    const node = compileLegacyWidgetToGenerativeUiNode({
      id: "legacy-custom-panel",
      type: "custom_panel",
      title: "未知旧组件",
      body: "没有专用 Renderer 时仍需可读。",
      priority: "low",
      status: "mystery",
      items: ["第一项"],
      steps: ["第二项"],
      data: { ui_state: "hidden", custom: true },
    });

    expect(node).toMatchObject({
      id: "legacy-custom-panel",
      owner: { id: "com.homerail.legacy", version: "0.1.0" },
      kind: "com.homerail.legacy/widget",
      surface: "ambient",
      importance: "ambient",
      presentation: { density: "summary", preferred_visual: "custom_panel" },
      lifecycle: { persistence: "session", default_visibility: "hidden", removable: true },
      fallback: {
        title: "未知旧组件",
        summary: "没有专用 Renderer 时仍需可读。",
        items: ["第一项", "第二项"],
      },
    });
    expect(node.status).toBeUndefined();
    expect(validateGenerativeUiNode(node).valid).toBe(true);
  });

  it("materializes bounded scenario meaning when specialized renderers are unavailable", () => {
    const nodes = Object.fromEntries(dynamicGoldens.map((widget) => [
      widget.type,
      compileLegacyWidgetToGenerativeUiNode(widget),
    ]));

    expect(nodes.metric_strip.fallback.items).toEqual(expect.arrayContaining([
      "完成节点: 4个",
      "耗时: 18秒",
    ]));
    expect(nodes.chart.fallback.items).toEqual(expect.arrayContaining(["TOML: 100", "动态组件: 80"]));
    expect(nodes.topic_outline.fallback.items).toEqual(expect.arrayContaining([
      "为什么需要语义 DSL: 隔离模型与布局; 提供稳定 ABI",
      "Question: 首个插件选择哪个场景？",
      "Source: HomeRail 架构草案",
    ]));
    expect(nodes.slide_deck.fallback.items).toEqual(expect.arrayContaining([
      "模型生成语义: Semantic UI IR; 确定性布局",
    ]));
    expect(nodes.xiaohongshu_note.fallback).toMatchObject({
      items: expect.arrayContaining(["#家庭影院", "Image: cover.png"]),
      artifact_refs: expect.arrayContaining([
        { label: "Artifact", uri: "artifact:artifact-xhs-001" },
        { label: "Image", uri: "cover.png" },
      ]),
    });
  });

  it("uses own-property lookup and drops executable artifact URI schemes", () => {
    const node = compileLegacyWidgetToGenerativeUiNode({
      id: "prototype-safe",
      type: "__proto__",
      title: "Prototype-safe fallback",
      data: {
        visual: "constructor",
        artifact_path: "/safe/report.html",
        preview_path: " //evil.example/x",
        preview_url: "javascript:alert(document.domain)",
        url: "data:text/html,unsafe",
        images: ["\\\\evil.example\\share"],
      },
    });

    expect(node).toMatchObject({
      kind: "com.homerail.legacy/widget",
      owner: { id: "com.homerail.legacy" },
      fallback: {
        artifact_refs: [{ label: "Artifact", uri: "/safe/report.html" }],
      },
    });
    expect(validateGenerativeUiNode(node).valid).toBe(true);
  });

  it("returns no transaction for an empty legacy surface", () => {
    expect(compileLegacyVoiceSurfaceToGenerativeUiTransaction({
      transaction_id: "legacy-empty-1",
      document_id: "voice-session-empty-ui",
      base_revision: 0,
      created_at: "2026-07-11T10:45:00.000Z",
      voice_surface: {},
    })).toBeNull();
  });

  it("rejects legacy surfaces that cannot fit the Protocol transaction envelope", () => {
    const widgets = Array.from({ length: 33 }, (_, index): LegacyVoiceWidget => ({
      id: `widget-${index}`,
      type: "note",
      title: `Widget ${index}`,
    }));
    expect(() => compileLegacyVoiceSurfaceToGenerativeUiTransaction({
      transaction_id: "legacy-overflow",
      document_id: "voice-session-overflow-ui",
      base_revision: 0,
      created_at: "2026-07-11T10:45:00.000Z",
      voice_surface: { widgets },
    })).toThrow("at most 32 operations");
  });

  it("rejects invalid legacy identities instead of silently changing stable ids", () => {
    expect(() => compileLegacyWidgetToGenerativeUiNode({
      id: " ",
      type: "note",
      title: "Invalid",
    })).toThrow("legacy widget id must be a non-empty string");
    expect(() => compileLegacyWidgetToGenerativeUiNode({
      id: "valid-id",
      type: "note",
      title: " ",
    })).toThrow("legacy widget valid-id title must be a non-empty string");
  });
});

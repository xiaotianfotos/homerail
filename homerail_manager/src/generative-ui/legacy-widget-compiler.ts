import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActorType,
  GenerativeUiDensity,
  GenerativeUiImportance,
  GenerativeUiPersistence,
  GenerativeUiPhase,
  GenerativeUiSurface,
  GenerativeUiVisibility,
  isSafeGenerativeUiArtifactUri,
  type GenerativeUiActorV1,
  type GenerativeUiArtifactRefV1,
  type GenerativeUiFallbackV1,
  type GenerativeUiNodeV1,
  type GenerativeUiOperationV1,
  type GenerativeUiPluginRef,
  type GenerativeUiStatusV1,
  type GenerativeUiTransactionV1,
} from "homerail-protocol";

export interface LegacyVoiceWidget {
  id: string;
  type: string;
  title: string;
  body?: string;
  priority?: string;
  status?: string | null;
  items?: readonly string[];
  steps?: readonly string[];
  active_step?: number | null;
  data?: Record<string, unknown>;
}

export interface LegacyVoiceSurfacePatch {
  widgets?: readonly LegacyVoiceWidget[];
  remove_widget_ids?: readonly string[];
}

export interface CompileLegacyVoiceSurfaceInput {
  transaction_id: string;
  document_id: string;
  base_revision: number;
  created_at: string;
  voice_surface: LegacyVoiceSurfacePatch;
  actor?: GenerativeUiActorV1;
  project_widget?: LegacyWidgetSemanticProjector;
}

export type LegacyWidgetSemanticProjector = (widget: LegacyVoiceWidget) => GenerativeUiNodeV1 | undefined;

interface LegacyKindMapping {
  owner: GenerativeUiPluginRef;
  kind: string;
  surface: GenerativeUiSurface;
  density: GenerativeUiDensity;
  preferred_visual: string;
}

const CORE_OWNER: GenerativeUiPluginRef = { id: "com.homerail.core", version: "0.1.8" };
const CONTENT_OWNER: GenerativeUiPluginRef = { id: "com.homerail.content", version: "0.1.0" };
const PRESENTATION_OWNER: GenerativeUiPluginRef = { id: "com.homerail.presentation", version: "0.1.0" };
const LEGACY_OWNER: GenerativeUiPluginRef = { id: "com.homerail.legacy", version: "0.1.0" };

const DEFAULT_ACTOR: GenerativeUiActorV1 = {
  type: GenerativeUiActorType.SYSTEM,
  id: "legacy-widget-compiler",
};

const KNOWN_MAPPINGS: Record<string, Omit<LegacyKindMapping, "preferred_visual">> = {
  task_draft: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/task_summary",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  memo: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/task_summary",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  status: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/notice",
    surface: GenerativeUiSurface.AMBIENT,
    density: GenerativeUiDensity.GLANCE,
  },
  note: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/notice",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  list: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/checklist",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  checklist: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/checklist",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  progress: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/execution_progress",
    surface: GenerativeUiSurface.EXECUTION,
    density: GenerativeUiDensity.SUMMARY,
  },
  progress_status: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/execution_progress",
    surface: GenerativeUiSurface.EXECUTION,
    density: GenerativeUiDensity.SUMMARY,
  },
  dag_flow: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/execution_graph",
    surface: GenerativeUiSurface.EXECUTION,
    density: GenerativeUiDensity.DETAIL,
  },
  timeline: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/timeline",
    surface: GenerativeUiSurface.EXECUTION,
    density: GenerativeUiDensity.SUMMARY,
  },
  metric_strip: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/metric_set",
    surface: GenerativeUiSurface.AMBIENT,
    density: GenerativeUiDensity.GLANCE,
  },
  chart: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/metric_set",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.SUMMARY,
  },
  artifact: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/artifact",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.SUMMARY,
  },
  artifact_ref: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/artifact",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.SUMMARY,
  },
  confirmation: {
    owner: CORE_OWNER,
    kind: "com.homerail.core/confirmation",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.SUMMARY,
  },
  // Explicit M0 compatibility kind. New topic outlines use the independent
  // com.homerail.topic-outline plugin and semantic execution side channel.
  topic_outline: {
    owner: CONTENT_OWNER,
    kind: "com.homerail.content/topic_outline",
    surface: GenerativeUiSurface.TASK,
    density: GenerativeUiDensity.DETAIL,
  },
  xiaohongshu_note: {
    owner: CONTENT_OWNER,
    kind: "com.homerail.content/xiaohongshu_note",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.DETAIL,
  },
  slide_deck: {
    owner: PRESENTATION_OWNER,
    kind: "com.homerail.presentation/slide_deck",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.DETAIL,
  },
  html: {
    owner: LEGACY_OWNER,
    kind: "com.homerail.legacy/rich_content",
    surface: GenerativeUiSurface.RESULT,
    density: GenerativeUiDensity.DETAIL,
  },
};

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertLegacyWidget(widget: LegacyVoiceWidget): void {
  if (!nonEmpty(widget.id)) throw new TypeError("legacy widget id must be a non-empty string");
  if (!nonEmpty(widget.type)) throw new TypeError(`legacy widget ${widget.id} type must be a non-empty string`);
  if (!nonEmpty(widget.title)) throw new TypeError(`legacy widget ${widget.id} title must be a non-empty string`);
}

function legacyVisual(widget: LegacyVoiceWidget): string {
  return nonEmpty(widget.data?.visual).toLowerCase() || nonEmpty(widget.type).toLowerCase();
}

function mappingFor(widget: LegacyVoiceWidget): LegacyKindMapping {
  const visual = legacyVisual(widget);
  const type = nonEmpty(widget.type).toLowerCase();
  const mapping = Object.prototype.hasOwnProperty.call(KNOWN_MAPPINGS, visual)
    ? KNOWN_MAPPINGS[visual]
    : Object.prototype.hasOwnProperty.call(KNOWN_MAPPINGS, type)
      ? KNOWN_MAPPINGS[type]
      : undefined;
  if (mapping) return { ...mapping, owner: { ...mapping.owner }, preferred_visual: visual };
  return {
    owner: { ...LEGACY_OWNER },
    kind: "com.homerail.legacy/widget",
    surface: GenerativeUiSurface.AMBIENT,
    density: GenerativeUiDensity.SUMMARY,
    preferred_visual: visual || "text",
  };
}

function legacyPriority(widget: LegacyVoiceWidget): "low" | "normal" | "high" {
  if (widget.priority === "low" || widget.priority === "high") return widget.priority;
  return "normal";
}

function importanceFor(widget: LegacyVoiceWidget): GenerativeUiImportance {
  const priority = legacyPriority(widget);
  if (priority === "high") return GenerativeUiImportance.PRIMARY;
  if (priority === "low") return GenerativeUiImportance.AMBIENT;
  return GenerativeUiImportance.SECONDARY;
}

function statusFor(widget: LegacyVoiceWidget): GenerativeUiStatusV1 | undefined {
  const label = nonEmpty(widget.status);
  if (!label) return undefined;
  const key = label.toLowerCase();
  let phase: GenerativeUiPhase | undefined;
  if (["draft", "todo", "listening"].includes(key)) phase = GenerativeUiPhase.DRAFT;
  if (["idle", "clarifying", "waiting", "waiting_for_confirmation", "needs_confirmation"].includes(key)) {
    phase = GenerativeUiPhase.WAITING;
  }
  if (["ready", "submitted"].includes(key)) phase = GenerativeUiPhase.READY;
  if (["doing", "executing", "running", "live", "in_progress"].includes(key)) phase = GenerativeUiPhase.RUNNING;
  if (key === "blocked") phase = GenerativeUiPhase.BLOCKED;
  if (["done", "complete", "completed", "success", "succeeded"].includes(key)) phase = GenerativeUiPhase.SUCCEEDED;
  if (["failed", "error"].includes(key)) phase = GenerativeUiPhase.FAILED;
  if (["cancelled", "canceled"].includes(key)) phase = GenerativeUiPhase.CANCELLED;
  if (!phase) return undefined;

  const rawProgress = widget.data?.progress;
  const progress = typeof rawProgress === "number" && Number.isFinite(rawProgress)
    ? Math.max(0, Math.min(100, rawProgress))
    : undefined;
  return { phase, label, ...(progress === undefined ? {} : { progress }) };
}

function defaultVisibility(widget: LegacyVoiceWidget): GenerativeUiVisibility {
  const value = nonEmpty(widget.data?.ui_state);
  if (value === GenerativeUiVisibility.MINIMIZED) return GenerativeUiVisibility.MINIMIZED;
  if (value === GenerativeUiVisibility.HIDDEN) return GenerativeUiVisibility.HIDDEN;
  return GenerativeUiVisibility.VISIBLE;
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function dataFallbackItems(widget: LegacyVoiceWidget): string[] {
  const data = widget.data ?? {};
  const visual = legacyVisual(widget);
  const items: string[] = [];
  const add = (value: string) => {
    const bounded = boundedText(value, 500);
    if (bounded && !items.includes(bounded)) items.push(bounded);
  };

  if (visual === "metric_strip" || visual === "chart") {
    const values = visual === "metric_strip" ? data.metrics : data.chart_values;
    for (const raw of Array.isArray(values) ? values : []) {
      const item = objectValue(raw);
      if (!item) continue;
      const label = scalarText(item.label);
      const value = scalarText(item.value);
      const unit = scalarText(item.unit);
      if (label || value) add(`${label || "Value"}: ${value}${unit}`);
    }
  }
  if (visual === "dag_flow") {
    for (const raw of Array.isArray(data.nodes) ? data.nodes : []) {
      const item = objectValue(raw);
      if (!item) continue;
      const label = scalarText(item.label) || scalarText(item.id);
      const status = scalarText(item.status);
      const detail = scalarText(item.detail);
      add(`${label}${status ? ` [${status}]` : ""}${detail ? `: ${detail}` : ""}`);
    }
  }
  if (visual === "timeline") {
    const timeline = Array.isArray(data.timeline) ? data.timeline : Array.isArray(data.events) ? data.events : [];
    for (const raw of timeline) {
      const item = objectValue(raw);
      if (!item) continue;
      const time = scalarText(item.time);
      const label = scalarText(item.label) || scalarText(item.title);
      const status = scalarText(item.status);
      const detail = scalarText(item.detail);
      add(`${time ? `${time} ` : ""}${label}${status ? ` [${status}]` : ""}${detail ? `: ${detail}` : ""}`);
    }
  }
  if (visual === "topic_outline") {
    const thesis = scalarText(data.thesis);
    if (thesis) add(thesis);
    for (const raw of Array.isArray(data.outline) ? data.outline : []) {
      const item = objectValue(raw);
      if (!item) continue;
      const title = scalarText(item.title);
      const points = Array.isArray(item.points) ? item.points.map(scalarText).filter(Boolean) : [];
      add(`${title}${points.length ? `: ${points.join("; ")}` : ""}`);
    }
    for (const question of Array.isArray(data.questions) ? data.questions : []) add(`Question: ${scalarText(question)}`);
    for (const raw of Array.isArray(data.sources) ? data.sources : []) {
      const source = objectValue(raw);
      if (source) add(`Source: ${scalarText(source.title)}`);
    }
  }
  if (visual === "slide_deck") {
    const subtitle = scalarText(data.deck_subtitle);
    if (subtitle) add(subtitle);
    for (const raw of Array.isArray(data.slides) ? data.slides : []) {
      const slide = objectValue(raw);
      if (!slide) continue;
      const title = scalarText(slide.title);
      const bullets = Array.isArray(slide.bullets) ? slide.bullets.map(scalarText).filter(Boolean) : [];
      add(`${title}${bullets.length ? `: ${bullets.join("; ")}` : ""}`);
    }
  }
  if (visual === "xiaohongshu_note") {
    for (const tag of Array.isArray(data.tags) ? data.tags : []) add(`#${scalarText(tag)}`);
    for (const image of Array.isArray(data.images) ? data.images : []) add(`Image: ${scalarText(image)}`);
  }
  const nextAction = scalarText(data.next_action);
  if (nextAction) add(`Next: ${nextAction}`);
  return items;
}

function artifactRefs(widget: LegacyVoiceWidget): GenerativeUiArtifactRefV1[] {
  const candidates: Array<[string, unknown]> = [
    ["Artifact", widget.data?.artifact_path],
    ["Preview", widget.data?.preview_path],
    ["Artifact", widget.data?.path],
    ["Preview", widget.data?.preview_url],
    ["Preview", widget.data?.url],
  ];
  const seen = new Set<string>();
  const refs: GenerativeUiArtifactRefV1[] = [];
  const artifactId = boundedText(widget.data?.artifact_id, 512);
  if (artifactId) candidates.unshift(["Artifact", `artifact:${encodeURIComponent(artifactId)}`]);
  for (const image of Array.isArray(widget.data?.images) ? widget.data.images : []) {
    candidates.push(["Image", image]);
  }
  for (const [label, raw] of candidates) {
    const uri = boundedText(raw, 2048);
    if (!isSafeGenerativeUiArtifactUri(uri)) continue;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    refs.push({ label, uri });
  }
  return refs.slice(0, 16);
}

function fallbackFor(widget: LegacyVoiceWidget): GenerativeUiFallbackV1 {
  const summary = boundedText(
    widget.body || widget.data?.brief || widget.data?.body || widget.data?.deck_subtitle,
    4000,
  );
  const items = [...(widget.items ?? []), ...(widget.steps ?? [])]
    .map((item) => boundedText(item, 500))
    .filter(Boolean)
    .concat(dataFallbackItems(widget))
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 16);
  const artifact_refs = artifactRefs(widget);
  return {
    title: boundedText(widget.title, 200),
    ...(summary ? { summary } : {}),
    ...(items.length ? { items } : {}),
    ...(artifact_refs.length ? { artifact_refs } : {}),
  };
}

function materializeLegacyWidget(widget: LegacyVoiceWidget): Record<string, unknown> {
  const activeStep = typeof widget.active_step === "number" && Number.isFinite(widget.active_step)
    ? Math.max(0, Math.floor(widget.active_step))
    : null;
  return {
    id: widget.id,
    type: widget.type,
    title: widget.title,
    body: widget.body ?? "",
    priority: legacyPriority(widget),
    status: nonEmpty(widget.status) || null,
    items: [...(widget.items ?? [])],
    steps: [...(widget.steps ?? [])],
    active_step: activeStep,
    data: structuredClone(widget.data ?? {}),
  };
}

export function compileLegacyWidgetToGenerativeUiNode(
  widget: LegacyVoiceWidget,
  projector?: LegacyWidgetSemanticProjector,
): GenerativeUiNodeV1 {
  assertLegacyWidget(widget);
  const projected = projector?.(structuredClone(widget));
  if (projected) return structuredClone(projected);
  const mapping = mappingFor(widget);
  const status = statusFor(widget);
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    // The opaque IR id deliberately preserves the stable legacy Widget id verbatim.
    id: widget.id,
    kind: mapping.kind,
    kind_version: 1,
    owner: mapping.owner,
    surface: mapping.surface,
    importance: importanceFor(widget),
    ...(status ? { status } : {}),
    content: { legacy_widget: materializeLegacyWidget(widget) },
    presentation: {
      density: mapping.density,
      preferred_visual: mapping.preferred_visual.slice(0, 80),
    },
    lifecycle: {
      persistence: GenerativeUiPersistence.SESSION,
      default_visibility: defaultVisibility(widget),
      removable: true,
    },
    fallback: fallbackFor(widget),
  };
}

export function compileLegacyVoiceSurfaceToGenerativeUiTransaction(
  input: CompileLegacyVoiceSurfaceInput,
): GenerativeUiTransactionV1 | null {
  const operationCount = (input.voice_surface.widgets?.length ?? 0)
    + (input.voice_surface.remove_widget_ids?.length ?? 0);
  if (operationCount > 32) {
    throw new RangeError("legacy voice surface supports at most 32 operations per transaction");
  }
  const operations: GenerativeUiOperationV1[] = [];
  for (const widget of input.voice_surface.widgets ?? []) {
    operations.push({ op: "put", node: compileLegacyWidgetToGenerativeUiNode(widget, input.project_widget) });
  }
  for (const nodeId of input.voice_surface.remove_widget_ids ?? []) {
    if (!nonEmpty(nodeId)) throw new TypeError("legacy remove widget id must be a non-empty string");
    operations.push({ op: "remove", node_id: nodeId });
  }
  if (!operations.length) return null;

  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    transaction_id: input.transaction_id,
    document_id: input.document_id,
    base_revision: input.base_revision,
    actor: structuredClone(input.actor ?? DEFAULT_ACTOR),
    operations,
    created_at: input.created_at,
  };
}

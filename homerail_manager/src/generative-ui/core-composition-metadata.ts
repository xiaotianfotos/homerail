import type { GenerativeUiKindCompositionMetadataV1 } from "./surface-composer.js";

/** Static M2 bridge metadata. M3 replaces this with the installed Kind Registry. */
export const CORE_GENERATIVE_UI_COMPOSITION_METADATA: readonly GenerativeUiKindCompositionMetadataV1[] = [
  { kind: "com.homerail.core/task_summary", kind_version: 1, allowed_surfaces: ["task"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/notice", kind_version: 1, allowed_surfaces: ["task", "ambient"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/checklist", kind_version: 1, allowed_surfaces: ["task"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/execution_progress", kind_version: 1, allowed_surfaces: ["execution"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/execution_graph", kind_version: 1, allowed_surfaces: ["execution"], default_variant: "detail", allow_critical: true },
  { kind: "com.homerail.core/timeline", kind_version: 1, allowed_surfaces: ["execution"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/metric_set", kind_version: 1, allowed_surfaces: ["ambient", "result"], default_variant: "glance", allow_critical: true },
  { kind: "com.homerail.core/artifact", kind_version: 1, allowed_surfaces: ["result"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/confirmation", kind_version: 1, allowed_surfaces: ["task"], default_variant: "summary", allow_critical: true },
  { kind: "com.homerail.core/generated_view", kind_version: 2, allowed_surfaces: ["task", "execution", "result", "ambient"], default_variant: "detail", allow_critical: true },
  { kind: "com.homerail.content/topic_outline", kind_version: 1, allowed_surfaces: ["task"], default_variant: "detail" },
  { kind: "com.homerail.content/xiaohongshu_note", kind_version: 1, allowed_surfaces: ["result"], default_variant: "detail" },
  { kind: "com.homerail.presentation/slide_deck", kind_version: 1, allowed_surfaces: ["result"], default_variant: "detail" },
  { kind: "com.homerail.legacy/rich_content", kind_version: 1, allowed_surfaces: ["result"], default_variant: "detail" },
  { kind: "com.homerail.legacy/widget", kind_version: 1, allowed_surfaces: ["ambient"], default_variant: "summary" },
];

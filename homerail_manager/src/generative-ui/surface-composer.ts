import {
  validateGenerativeUiDocument,
  validateGenerativeUiUserOverride,
  type GenerativeUiCompositionV1,
  type GenerativeUiDensity,
  type GenerativeUiDocumentV1,
  type GenerativeUiImportance,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiSurface,
  type GenerativeUiSurfaceContextV1,
  type GenerativeUiUserOverrideV1,
  type GenerativeUiVisibility,
} from "homerail-protocol";

export interface GenerativeUiKindCompositionMetadataV1 {
  kind: string;
  kind_version: number;
  allowed_surfaces: readonly GenerativeUiSurface[];
  default_surface?: GenerativeUiSurface;
  default_variant?: GenerativeUiDensity;
  /** Core policy only. Third-party metadata defaults to false. */
  allow_critical?: boolean;
}

const SURFACES = ["task", "execution", "result", "ambient"] as const satisfies readonly GenerativeUiSurface[];
const DEVICES = new Set(["phone", "desktop", "tv"]);
const INPUTS = new Set(["touch", "mouse", "gamepad", "voice"]);
const VIEWPORTS = new Set(["compact", "regular", "wide"]);
const ATTENTION = new Set(["glance", "focused"]);
const CONTEXT_FIELDS = new Set([
  "device",
  "input",
  "viewport",
  "attention",
  "active_run_id",
  "active_session_id",
  "surface_capacities",
]);

const IMPORTANCE_SCORE: Record<GenerativeUiImportance, number> = {
  critical: 4,
  primary: 3,
  secondary: 2,
  ambient: 1,
};

interface Candidate {
  node: GenerativeUiStoredNodeV1;
  metadata?: GenerativeUiKindCompositionMetadataV1;
  override?: GenerativeUiUserOverrideV1;
  visibility: GenerativeUiVisibility;
  surface: GenerativeUiSurface;
  pinned: boolean;
  urgent: boolean;
  active: boolean;
  importance: number;
  updatedAt: number;
}

function key(kind: string, kindVersion: number): string {
  return `${kind}\u0000${kindVersion}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSurfaceContext(context: GenerativeUiSurfaceContextV1): void {
  if (!context || typeof context !== "object") throw new Error("Generative UI surface context must be an object");
  const unknown = Object.keys(context).filter((field) => !CONTEXT_FIELDS.has(field));
  if (unknown.length) throw new Error(`Unknown Generative UI surface context fields: ${unknown.join(", ")}`);
  if (!DEVICES.has(context.device)) throw new Error(`Unsupported Generative UI device: ${context.device}`);
  if (!INPUTS.has(context.input)) throw new Error(`Unsupported Generative UI input: ${context.input}`);
  if (!VIEWPORTS.has(context.viewport)) throw new Error(`Unsupported Generative UI viewport: ${context.viewport}`);
  if (!ATTENTION.has(context.attention)) throw new Error(`Unsupported Generative UI attention: ${context.attention}`);
  if (
    context.active_run_id !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(context.active_run_id)
  ) {
    throw new Error("Generative UI active_run_id must be a bounded identifier");
  }
  if (
    context.active_session_id !== undefined
    && (
      context.active_session_id.length < 1
      || context.active_session_id.length > 256
      || /[\u0000-\u001F\u007F]/.test(context.active_session_id)
    )
  ) {
    throw new Error("Generative UI active_session_id must be a bounded opaque id");
  }
  if (context.surface_capacities) {
    for (const [surface, capacity] of Object.entries(context.surface_capacities)) {
      if (!SURFACES.includes(surface as GenerativeUiSurface)) {
        throw new Error(`Unsupported Generative UI surface capacity: ${surface}`);
      }
      if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 128) {
        throw new Error(`Generative UI surface capacity must be an integer between 0 and 128: ${surface}`);
      }
    }
  }
}

function indexOverrides(
  document: GenerativeUiDocumentV1,
  overrides: readonly GenerativeUiUserOverrideV1[],
): Map<string, GenerativeUiUserOverrideV1> {
  const indexed = new Map<string, GenerativeUiUserOverrideV1>();
  for (const override of overrides) {
    const validation = validateGenerativeUiUserOverride(override);
    if (!validation.valid) {
      throw new Error(`Invalid Generative UI user override: ${JSON.stringify(validation.errors)}`);
    }
    const stable = validation.value ?? override;
    if (stable.document_id !== document.document_id) {
      throw new Error(`Generative UI override does not belong to document: ${stable.node_id}`);
    }
    if (indexed.has(stable.node_id)) {
      throw new Error(`Duplicate Generative UI override for node: ${stable.node_id}`);
    }
    indexed.set(stable.node_id, stable);
  }
  return indexed;
}

function indexMetadata(
  metadata: readonly GenerativeUiKindCompositionMetadataV1[],
): Map<string, GenerativeUiKindCompositionMetadataV1> {
  const indexed = new Map<string, GenerativeUiKindCompositionMetadataV1>();
  for (const entry of metadata) {
    if (!entry.kind || !Number.isSafeInteger(entry.kind_version) || entry.kind_version < 1) {
      throw new Error("Generative UI composition metadata requires kind and positive kind_version");
    }
    const allowed = [...new Set(entry.allowed_surfaces)];
    if (!allowed.length || allowed.some((surface) => !SURFACES.includes(surface))) {
      throw new Error(`Generative UI composition metadata has invalid surfaces: ${entry.kind}`);
    }
    if (entry.default_surface && !allowed.includes(entry.default_surface)) {
      throw new Error(`Generative UI default surface is not allowed: ${entry.kind}`);
    }
    const metadataKey = key(entry.kind, entry.kind_version);
    if (indexed.has(metadataKey)) {
      throw new Error(`Duplicate Generative UI composition metadata: ${entry.kind}@${entry.kind_version}`);
    }
    indexed.set(metadataKey, { ...entry, allowed_surfaces: allowed });
  }
  return indexed;
}

function visibilityFor(
  node: GenerativeUiStoredNodeV1,
  override: GenerativeUiUserOverrideV1 | undefined,
): GenerativeUiVisibility {
  return override?.visibility ?? node.lifecycle?.default_visibility ?? "visible";
}

function surfaceFor(
  node: GenerativeUiStoredNodeV1,
  override: GenerativeUiUserOverrideV1 | undefined,
  metadata: GenerativeUiKindCompositionMetadataV1 | undefined,
): GenerativeUiSurface {
  const allowed = metadata?.allowed_surfaces ?? [node.surface];
  if (override?.preferred_surface && allowed.includes(override.preferred_surface)) {
    return override.preferred_surface;
  }
  if (allowed.includes(node.surface)) return node.surface;
  return metadata?.default_surface ?? allowed[0];
}

function importanceFor(
  node: GenerativeUiStoredNodeV1,
  metadata: GenerativeUiKindCompositionMetadataV1 | undefined,
): number {
  if (node.importance !== "critical") return IMPORTANCE_SCORE[node.importance];
  const criticalAllowed = node.owner.id === "com.homerail.core" || metadata?.allow_critical === true;
  return criticalAllowed ? IMPORTANCE_SCORE.critical : IMPORTANCE_SCORE.primary;
}

function candidateFor(
  document: GenerativeUiDocumentV1,
  node: GenerativeUiStoredNodeV1,
  context: GenerativeUiSurfaceContextV1,
  override: GenerativeUiUserOverrideV1 | undefined,
  metadata: GenerativeUiKindCompositionMetadataV1 | undefined,
): Candidate {
  const phase = node.status?.phase;
  const importance = importanceFor(node, metadata);
  return {
    node,
    metadata,
    override,
    visibility: visibilityFor(node, override),
    surface: surfaceFor(node, override, metadata),
    pinned: override?.pinned === true,
    urgent: importance === IMPORTANCE_SCORE.critical || phase === "blocked" || phase === "failed",
    active: Boolean(
      (context.active_run_id && node.provenance?.run_id === context.active_run_id)
      || (
        context.active_session_id
        && document.scope.type === "voice_session"
        && document.scope.id === context.active_session_id
      )
    ),
    importance,
    updatedAt: Date.parse(node.updated_at),
  };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.urgent !== right.urgent) return left.urgent ? -1 : 1;
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (left.importance !== right.importance) return right.importance - left.importance;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  return compareText(left.node.id, right.node.id);
}

function variantFor(candidate: Candidate, context: GenerativeUiSurfaceContextV1): GenerativeUiDensity {
  if (candidate.visibility === "minimized") return "glance";
  if (context.attention === "glance") return candidate.urgent ? "summary" : "glance";
  const preferred = candidate.node.presentation?.density ?? candidate.metadata?.default_variant ?? "summary";
  if (context.viewport === "compact" && preferred === "detail") return "summary";
  return preferred;
}

function defaultCapacity(context: GenerativeUiSurfaceContextV1, surface: GenerativeUiSurface): number {
  if (context.device === "phone") {
    if (surface === "ambient") return 1;
    return context.viewport === "compact" ? 2 : 3;
  }
  if (context.device === "tv") return context.attention === "glance" ? 2 : 4;
  if (surface === "ambient") return context.viewport === "wide" ? 4 : 2;
  return context.viewport === "wide" ? 6 : context.viewport === "regular" ? 4 : 3;
}

/**
 * Deterministic, side-effect-free Core composition. It never reads Node content
 * for layout, so plugin payload fields cannot smuggle coordinates into the host.
 */
export function composeGenerativeUi(
  document: GenerativeUiDocumentV1,
  overrides: readonly GenerativeUiUserOverrideV1[],
  context: GenerativeUiSurfaceContextV1,
  registryMetadata: readonly GenerativeUiKindCompositionMetadataV1[] = [],
): GenerativeUiCompositionV1 {
  const documentValidation = validateGenerativeUiDocument(document);
  if (!documentValidation.valid) {
    throw new Error(`Invalid Generative UI document for composition: ${JSON.stringify(documentValidation.errors)}`);
  }
  assertSurfaceContext(context);
  const stableDocument = documentValidation.value ?? document;
  const overrideByNode = indexOverrides(stableDocument, overrides);
  const metadataByKind = indexMetadata(registryMetadata);
  const ranked = stableDocument.nodes.map((node) => candidateFor(
    stableDocument,
    node,
    context,
    overrideByNode.get(node.id),
    metadataByKind.get(key(node.kind, node.kind_version)),
  )).sort(compareCandidates);

  const hidden_node_ids = ranked
    .filter((candidate) => candidate.visibility === "hidden")
    .map((candidate) => candidate.node.id);
  const visible = ranked.filter((candidate) => candidate.visibility !== "hidden");
  const primaryCount = new Map<GenerativeUiSurface, number>();
  const items = visible.map((candidate, index) => {
    const capacity = context.surface_capacities?.[candidate.surface]
      ?? defaultCapacity(context, candidate.surface);
    const used = primaryCount.get(candidate.surface) ?? 0;
    const primary = candidate.visibility === "visible" && used < capacity;
    if (primary) primaryCount.set(candidate.surface, used + 1);
    return {
      node_id: candidate.node.id,
      node_revision: candidate.node.revision,
      surface: candidate.surface,
      variant: variantFor(candidate, context),
      rank: index + 1,
      placement: primary ? "primary" as const : "overflow" as const,
      pinned: candidate.pinned,
      visibility: candidate.visibility as "visible" | "minimized",
    };
  });

  return {
    composition_version: 1,
    document_id: stableDocument.document_id,
    document_revision: stableDocument.revision,
    context: structuredClone(context),
    items,
    hidden_node_ids,
  };
}

import { createHash } from "node:crypto";

import {
  DAG_ACTOR_SURFACE_PATCH_MAX_BYTES,
  DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS,
  DAG_ACTOR_SURFACE_PATCH_PHASES,
  DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
  DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID,
  HOMERAIL_A2UI_CATALOG_ID,
  HOMERAIL_A2UI_VERSION,
  analyzeGenerativeUiJsonValue,
  redactTelemetry,
  validateDagActorSurfacePatchV1,
  type DagActorSurfaceBodyV1,
  type DagActorSurfacePatchPhaseV1,
  type DagActorSurfacePatchV1,
  type DagWorkerSkillVisualDataContractV1,
  type HomerailA2uiSurfaceV1,
} from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import type { DagToolsState } from "./index.js";
import {
  brokerSurfaceMediaBody,
  SurfaceMediaError,
  type SurfaceMediaPublisher,
} from "./surface-media.js";

export const REPORT_SURFACE_STATE_TOOL_NAME = "report_surface_state" as const;
export const DAG_ACTOR_SURFACE_PATCH_V1_CAPABILITY = DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID;

export const MAX_SURFACE_PATCH_BODY_BYTES = 56 * 1024;
export const MAX_SURFACE_PATCH_BYTES = DAG_ACTOR_SURFACE_PATCH_MAX_BYTES;
export const MAX_SURFACE_PATCH_COMPONENTS = DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS;

export type PinnedSurfaceViewRegistry = ReadonlyMap<string, HomerailA2uiSurfaceV1>;
export type PinnedSurfaceDataContractRegistry = ReadonlyMap<string, DagWorkerSkillVisualDataContractV1>;

const PATCH_ID_PATTERN = /^(?!\s*$)[^\u0000-\u001F\u007F]{1,256}$/u;
const MAX_REDACTION_DEPTH = 8;
const MAX_REDACTION_COLLECTION_SIZE = 100;
const MAX_REDACTION_STRING_LENGTH = 4_000;

/** The protocol validator applies the same passive catalog authoritatively. */
export const PASSIVE_A2UI_COMPONENTS = [
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Divider",
  "HrGrid",
  "HrGridItem",
  "HrSection",
  "HrMetric",
  "HrStatusBadge",
  "HrProgress",
  "HrStep",
  "HrList",
  "HrTable",
  "HrTimeline",
  "HrBarChart",
  "HrDag",
  "HrDisclosure",
  "HrLink",
  "HrArtifact",
  "HrIf",
] as const;

const IDENTITY_KEYS = new Set([
  "schema_version",
  "run_id", "runId",
  "node_id", "nodeId",
  "session_id", "sessionId",
  "round_id", "roundId",
  "actor_id", "actorId",
  "generation",
  "lease_generation", "leaseGeneration",
  "surface_id", "surfaceId", "surface",
  "timestamp",
]);
const TOOL_INPUT_KEYS = new Set([
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
const FLAT_PRESENTATION_HINT_KEYS = ["density", "canvas_size", "preferred_visual"] as const;
const EXECUTABLE_A2UI_FIELD_NAMES = [
  "action",
  "actions",
  "functionCall",
  "function_call",
  "html",
  "onClick",
  "onSubmit",
  "script",
  "srcdoc",
] as const;
const EXECUTABLE_A2UI_KEYS = new Set<string>(EXECUTABLE_A2UI_FIELD_NAMES);

export interface DagActorSurfacePatchProposalV1 {
  /** Projector routing identity locked from the dispatch, not model input. */
  surface_id: string;
  patch: DagActorSurfacePatchV1;
}

export type SurfacePatchEmitter = (proposal: DagActorSurfacePatchProposalV1) => void;

export const REPORT_SURFACE_STATE_PROMPT = [
  "RICH SURFACE REPORTING CAPABILITY.",
  "report_surface_state submits a bounded passive A2UI proposal for this Actor's existing Surface; it never mutates the Canvas directly.",
  "When a digest-pinned Skill view is available, always use its advertised shallow form and omit patch_id, patch_sequence, op, body, and a2ui. The Worker assigns protocol identity and resolves the immutable A2UI structure.",
  "A sole pinned trusted data contract advertises its source_prefix counts and typed presentation values as flat top-level tool arguments; do not wrap them in data or presentation_hint. The Worker packs them into body.data and materializes exact facts from dispatch input. Canvas layout is Manager-owned, so omit density, canvas_size, and preferred_visual. Legacy pinned views still use object data and require exact source copying.",
  "Only when no pinned Skill view fits, use custom A2UI with op=replace_body plus body.a2ui, body.data, and body.fallback. Keep component ids stable across patch_sequence revisions; use clear_body only to remove a custom proposed body.",
  "A2UI data bindings must stay under /actor_view/data, which resolves against body.data.",
  "For custom A2UI and legacy pinned views, always provide a readable fallback. A trusted data contract may derive fallback from its Worker-owned title and summary. Image, Video, AudioPlayer, metrics, comparisons, routes/DAGs, and timelines are allowed passive expressions.",
  "Public HTTPS media used by Image, Video, or AudioPlayer is automatically copied into the Manager artifact broker; normal HrLink URLs remain external links.",
  "Button, form/input components, arbitrary HTML, scripts, action fields, and function actions are forbidden.",
  "Run, node, session, round, actor, generation, lease, surface, schema, and timestamp identity are injected and locked by the Worker; never include them in tool arguments.",
  "For custom A2UI, only status=submitted advances patch_sequence. Pinned Skill views never require the model to manage patch ids or sequence numbers.",
  "Within one active turn, phases only move forward in this order: started, partial, verified, refined, final. A pinned data contract may declare a narrower exact sequence; that sequence is authoritative. Final closes Surface reporting for that turn.",
  "If a pinned presentation value is rejected for its type, enum, or length, correct that value and retry the same required phase. A rejected proposal does not advance the Surface sequence.",
  "A submitted result means Manager validation is pending. It never means a Surface revision was applied, and it must not be polled or retried in the same turn.",
  "When final returns trusted_final_prefix_values, use those exact Worker-selected values for subsequent activity and handoff evidence instead of prior-round memory.",
].join("\n");

const componentSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    component: { type: "string", enum: [...PASSIVE_A2UI_COMPONENTS] },
  },
  required: ["id", "component"],
  propertyNames: { not: { enum: [...EXECUTABLE_A2UI_FIELD_NAMES] } },
  allOf: [{
    not: {
      properties: {
        component: { const: "HrArtifact" },
        kind: { const: "html" },
      },
      required: ["component", "kind"],
    },
  }],
  additionalProperties: true,
} as const;

const fallbackSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 4_000 },
    items: { type: "array", maxItems: 16, items: { type: "string", maxLength: 500 } },
    artifact_refs: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1, maxLength: 200 },
          uri: { type: "string", minLength: 1, maxLength: 2_048 },
          media_type: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: ["label", "uri"],
        additionalProperties: false,
      },
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const pinnedFallbackObjectSchema = {
  type: "object",
  properties: {
    title: fallbackSchema.properties.title,
    summary: fallbackSchema.properties.summary,
    items: fallbackSchema.properties.items,
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const pinnedFallbackSchema = {
  anyOf: [
    pinnedFallbackObjectSchema,
    {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Compact accessible title; the Worker converts it to fallback.title.",
    },
  ],
} as const;

const bodySchema = {
  type: "object",
  properties: {
    view_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Digest-pinned Skill visual profile view. Omit a2ui when this is used.",
    },
    a2ui: {
      type: "object",
      properties: {
        version: { const: HOMERAIL_A2UI_VERSION },
        catalogId: { const: HOMERAIL_A2UI_CATALOG_ID },
        components: {
          type: "array",
          minItems: 1,
          maxItems: MAX_SURFACE_PATCH_COMPONENTS,
          items: componentSchema,
        },
      },
      required: ["version", "catalogId", "components"],
      additionalProperties: false,
    },
    data: {
      type: "object",
      maxProperties: MAX_REDACTION_COLLECTION_SIZE,
      additionalProperties: true,
    },
    fallback: fallbackSchema,
    presentation_hint: {
      type: "object",
      properties: {
        density: { type: "string", enum: ["glance", "summary", "detail"] },
        canvas_size: { type: "string", enum: ["1x1", "1x2", "2x2", "3x3"] },
        preferred_visual: { type: "string", minLength: 1, maxLength: 120 },
      },
      additionalProperties: false,
    },
  },
  required: ["data", "fallback"],
  oneOf: [
    { required: ["a2ui"], not: { required: ["view_id"] } },
    { required: ["view_id"], not: { required: ["a2ui"] } },
  ],
  additionalProperties: false,
} as const;

export const REPORT_SURFACE_STATE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    patch_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
      description: "Unique proposal id within this Actor generation.",
    },
    patch_sequence: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "Next contiguous body revision for this Actor generation.",
    },
    phase: { type: "string", enum: [...DAG_ACTOR_SURFACE_PATCH_PHASES] },
    op: { type: "string", enum: ["replace_body", "clear_body"] },
    body: bodySchema,
    view_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Pinned Skill view shorthand. Use at top level and omit op, body, and a2ui.",
    },
    data: {
      type: "object",
      maxProperties: MAX_REDACTION_COLLECTION_SIZE,
      additionalProperties: true,
      description: "Data for the pinned Skill view shorthand.",
    },
    fallback: pinnedFallbackSchema,
    presentation_hint: bodySchema.properties.presentation_hint,
  },
  required: ["phase"],
  oneOf: [
    {
      required: ["view_id", "data", "fallback"],
      not: {
        anyOf: [
          { required: ["body"] },
          { required: ["op"] },
        ],
      },
    },
    {
      properties: { op: { const: "replace_body" } },
      required: ["patch_id", "patch_sequence", "op", "body"],
      not: { required: ["view_id"] },
    },
    {
      properties: { op: { const: "clear_body" } },
      required: ["patch_id", "patch_sequence", "op"],
      not: {
        anyOf: [
          { required: ["body"] },
          { required: ["view_id"] },
          { required: ["data"] },
          { required: ["fallback"] },
          { required: ["presentation_hint"] },
        ],
      },
    },
  ],
  additionalProperties: false,
};

export const REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    phase: { type: "string", enum: [...DAG_ACTOR_SURFACE_PATCH_PHASES] },
    view_id: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Digest-pinned Skill view identifier advertised in this tool description.",
    },
    data: {
      type: "object",
      maxProperties: MAX_REDACTION_COLLECTION_SIZE,
      additionalProperties: true,
      description: "Data for the selected pinned Skill view. Follow its advertised contract exactly: omit Worker-owned source fields, use integer counts for source_prefix fields, and send only listed presentation fields. Legacy views without a contract require exact source copying.",
    },
    fallback: pinnedFallbackSchema,
    presentation_hint: bodySchema.properties.presentation_hint,
  },
  // Contracted pinned views can derive a deterministic fallback from trusted
  // title/summary fields. Legacy pinned views still require it in the handler.
  required: ["phase", "view_id", "data"],
  additionalProperties: false,
};

function contractedPinnedDataSchema(
  contract: DagWorkerSkillVisualDataContractV1,
  trustedFinalPrefixCounts: Readonly<Record<string, number>> = {},
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of contract.fields) {
    if (field.mode === "source") continue;
    if (field.mode === "source_prefix") {
      const trustedMaximum = trustedFinalPrefixCounts[field.field];
      properties[field.field] = {
        type: "integer",
        minimum: 0,
        maximum: trustedMaximum ?? field.max_items ?? 100,
        description: trustedMaximum !== undefined
          ? `Requested trusted-source prefix for this phase. This turn's trusted final count is ${trustedMaximum}; never request more.`
          : field.final_count
            ? "Requested trusted-source prefix for this phase. The Worker owns the exact final count."
          : "Requested trusted-source prefix count for this phase.",
      };
      required.push(field.field);
      continue;
    }
    const valueSchema = field.value_schema;
    properties[field.field] = {
      type: valueSchema?.type ?? "string",
      ...(valueSchema?.enum ? { enum: valueSchema.enum } : {}),
      ...((valueSchema?.type ?? "string") === "string"
        ? { minLength: 1, maxLength: valueSchema?.max_length ?? 500 }
        : {}),
      description: "Presentation-only value. It cannot replace or modify trusted source facts.",
    };
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required: required.sort() } : {}),
    additionalProperties: false,
    "x-homerail-sdk-object-only": true,
    description: "Exact model-owned data fields for this pinned Skill view. Worker-owned source fields are intentionally absent.",
  };
}

function contractedPinnedInputSchema(
  viewId: string,
  contract: DagWorkerSkillVisualDataContractV1,
  trustedInputs?: Readonly<Record<string, unknown[]>>,
): Record<string, unknown> {
  const baseProperties = REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA.properties as Record<string, unknown>;
  const dataSchema = contractedPinnedDataSchema(
    contract,
    trustedFinalPrefixCountsForSchema(contract, trustedInputs),
  );
  const dataProperties = dataSchema.properties as Record<string, unknown>;
  return {
    type: "object",
    properties: {
      phase: baseProperties.phase,
      view_id: {
        ...(baseProperties.view_id as Record<string, unknown>),
        enum: [viewId],
      },
      ...dataProperties,
      fallback: baseProperties.fallback,
    },
    required: [
      "phase",
      "view_id",
      ...(Array.isArray(dataSchema.required) ? dataSchema.required.map(String) : []),
    ],
    additionalProperties: false,
    description: "Flat low-ambiguity input for one digest-pinned trusted Skill view. Worker-owned source fields are intentionally absent.",
  };
}

function pinnedInputSchema(
  viewIds: readonly string[],
  dataContracts?: PinnedSurfaceDataContractRegistry,
  trustedInputs?: Readonly<Record<string, unknown[]>>,
): Record<string, unknown> {
  const properties = REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA.properties as Record<string, unknown>;
  const soleContract = viewIds.length === 1 ? dataContracts?.get(viewIds[0]!) : undefined;
  if (soleContract) return contractedPinnedInputSchema(viewIds[0]!, soleContract, trustedInputs);
  return {
    ...REPORT_SURFACE_STATE_PINNED_INPUT_SCHEMA,
    properties: {
      ...properties,
      view_id: {
        ...(properties.view_id as Record<string, unknown>),
        enum: [...viewIds],
      },
    },
  };
}

function normalizeContractedPinnedArguments(
  args: Record<string, unknown>,
  contract: DagWorkerSkillVisualDataContractV1,
): Record<string, unknown> {
  const normalized = { ...args };
  const data = isRecord(args.data) ? { ...args.data } : {};
  let hasData = isRecord(args.data);
  for (const field of contract.fields) {
    if (field.mode === "source" || !Object.prototype.hasOwnProperty.call(args, field.field)) continue;
    data[field.field] = args[field.field];
    delete normalized[field.field];
    hasData = true;
  }
  if (hasData) normalized.data = data;

  const presentationHint = isRecord(args.presentation_hint) ? { ...args.presentation_hint } : {};
  let hasPresentationHint = isRecord(args.presentation_hint);
  for (const key of FLAT_PRESENTATION_HINT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    presentationHint[key] = args[key];
    delete normalized[key];
    hasPresentationHint = true;
  }
  if (hasPresentationHint) normalized.presentation_hint = presentationHint;
  return normalized;
}

interface RejectionDetails {
  expected_patch_sequence?: number;
  expected_phase?: DagActorSurfacePatchPhaseV1;
  issues?: string[];
  retryable?: boolean;
  next_action?: string;
}

function rejected(code: string, message: string, details: RejectionDetails = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ status: "rejected", code, message, ...details }),
    }],
    is_error: true,
  };
}

function ignored(code: string, message: string, details: RejectionDetails = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ status: "ignored", code, message, ...details }),
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unexpectedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function normalizePinnedFallback(
  value: string | Record<string, unknown>,
): { fallback?: DagActorSurfaceBodyV1["fallback"]; error?: string } {
  const source = typeof value === "string" ? { title: value.trim() } : value;
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title || title.length > 200) {
    return { error: "fallback must provide a bounded title" };
  }

  const fallback: DagActorSurfaceBodyV1["fallback"] = { title };
  if (source.summary !== undefined) {
    if (typeof source.summary !== "string" || source.summary.length > 4_000) {
      return { error: "fallback.summary must be a string no longer than 4000 characters" };
    }
    fallback.summary = source.summary;
  }
  if (source.items !== undefined) {
    if (!Array.isArray(source.items)
      || source.items.length > 16
      || source.items.some((item) => typeof item !== "string" || item.length > 500)) {
      return { error: "fallback.items must contain at most 16 strings of 500 characters or fewer" };
    }
    fallback.items = [...source.items] as string[];
  }
  return { fallback };
}

function derivePinnedFallback(
  data: Record<string, unknown>,
  viewId: string,
): DagActorSurfaceBodyV1["fallback"] {
  const sourceTitle = typeof data.title === "string" ? data.title.trim() : "";
  const title = (sourceTitle || viewId).slice(0, 200);
  const sourceSummary = typeof data.summary === "string" ? data.summary.trim() : "";
  return {
    title,
    ...(sourceSummary ? { summary: sourceSummary.slice(0, 4_000) } : {}),
  };
}

function pinnedViewDataKeys(a2ui: HomerailA2uiSurfaceV1): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.path === "string" && value.path.startsWith("/actor_view/data/")) {
      const key = value.path.slice("/actor_view/data/".length).split("/", 1)[0];
      if (key) keys.add(key.replace(/~1/g, "/").replace(/~0/g, "~"));
    }
    Object.values(value).forEach(visit);
  };
  visit(a2ui);
  return [...keys].sort();
}

interface PointerResult {
  found: boolean;
  value?: unknown;
}

function pointerValue(root: unknown, pointer: string): PointerResult {
  if (pointer === "") return { found: true, value: root };
  if (!pointer.startsWith("/")) return { found: false };
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) return { found: false };
      value = value[index];
      continue;
    }
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, token)) return { found: false };
    value = value[token];
  }
  return { found: true, value };
}

interface DataSourceResolution {
  source?: unknown;
  error?: string;
  missing?: boolean;
}

function resolveDataSource(
  descriptor: DagWorkerSkillVisualDataContractV1["source"],
  trustedInputs: Readonly<Record<string, unknown[]>> | undefined,
): DataSourceResolution {
  const values = trustedInputs?.[descriptor.input_port];
  const index = descriptor.value_index ?? 0;
  if (!Array.isArray(values) || index >= values.length) {
    return {
      error: `trusted input ${descriptor.input_port}[${index}] is unavailable`,
      missing: true,
    };
  }
  let source: unknown = values[index];
  if ((descriptor.encoding ?? "value") === "json") {
    if (typeof source !== "string") {
      return { error: `trusted input ${descriptor.input_port}[${index}] must be a JSON string` };
    }
    let encoded = source;
    if (descriptor.json_prefix !== undefined) {
      if (!encoded.startsWith(descriptor.json_prefix)) {
        return { error: `trusted input ${descriptor.input_port}[${index}] is missing its declared JSON prefix` };
      }
      encoded = encoded.slice(descriptor.json_prefix.length);
    }
    try {
      source = JSON.parse(encoded);
    } catch {
      return { error: `trusted input ${descriptor.input_port}[${index}] is not valid JSON` };
    }
  }
  const selected = pointerValue(source, descriptor.pointer ?? "");
  if (!selected.found || selected.value === undefined) {
    return {
      error: `trusted input source pointer ${descriptor.pointer ?? "<root>"} did not resolve`,
      missing: true,
    };
  }
  return { source: selected.value };
}

function resolveContractSource(
  contract: DagWorkerSkillVisualDataContractV1,
  trustedInputs: Readonly<Record<string, unknown[]>> | undefined,
): { source?: unknown; error?: string } {
  const resolved = resolveDataSource(contract.source, trustedInputs);
  return resolved.source === undefined
    ? { error: resolved.error ?? "trusted input source is unavailable" }
    : { source: resolved.source };
}

interface ContractMaterialization {
  data?: Record<string, unknown>;
  error?: string;
  issues?: string[];
  sourceFields?: string[];
  ignoredSourceFields?: string[];
  legacyPrefixArrays?: string[];
  prefixCounts?: Record<string, number>;
  finalPrefixCounts?: Record<string, number>;
  adjustedPrefixCounts?: Record<string, { requested: number; applied: number }>;
}

function trustedFinalPrefixCountsForSchema(
  contract: DagWorkerSkillVisualDataContractV1,
  trustedInputs: Readonly<Record<string, unknown[]>> | undefined,
): Record<string, number> {
  const proposed = Object.fromEntries(
    contract.fields
      .filter((field) => field.mode === "source_prefix")
      .map((field) => [field.field, 0]),
  );
  const materialized = materializeContractData(proposed, contract, trustedInputs, "final");
  return materialized.error ? {} : materialized.finalPrefixCounts ?? {};
}

function materializeContractData(
  proposed: Record<string, unknown>,
  contract: DagWorkerSkillVisualDataContractV1,
  trustedInputs: Readonly<Record<string, unknown[]>> | undefined,
  phase: DagActorSurfacePatchPhaseV1,
): ContractMaterialization {
  const allowed = new Set(contract.fields.map((field) => field.field));
  const extras = Object.keys(proposed).filter((field) => !allowed.has(field)).sort();
  if (extras.length > 0) {
    return { error: `data contains fields outside the pinned contract: ${extras.join(", ")}` };
  }
  const resolved = resolveContractSource(contract, trustedInputs);
  if (resolved.error) return { error: resolved.error };

  const data: Record<string, unknown> = {};
  const sourceFields: string[] = [];
  const ignoredSourceFields: string[] = [];
  const legacyPrefixArrays: string[] = [];
  const prefixCounts: Record<string, number> = {};
  const finalPrefixCounts: Record<string, number> = {};
  const adjustedPrefixCounts: Record<string, { requested: number; applied: number }> = {};
  const presentationIssues: string[] = [];
  for (const field of contract.fields) {
    if (field.mode === "presentation") {
      if (Object.prototype.hasOwnProperty.call(proposed, field.field)) {
        const schema = field.value_schema;
        const type = schema?.type ?? "string";
        const value = proposed[field.field];
        const matchesType = type === "string"
          ? typeof value === "string"
          : type === "boolean"
            ? typeof value === "boolean"
            : type === "integer"
              ? Number.isSafeInteger(value)
              : typeof value === "number" && Number.isFinite(value);
        if (!matchesType) {
          presentationIssues.push(`data.${field.field} must be a ${type}`);
          continue;
        }
        let valid = true;
        if (typeof value === "string") {
          const length = [...value].length;
          const maximum = schema?.max_length ?? 500;
          if (length < 1 || length > maximum) {
            presentationIssues.push(
              `data.${field.field} must contain between 1 and ${maximum} characters; received ${length}`,
            );
            valid = false;
          }
        }
        if (schema?.enum && !schema.enum.some((candidate) => candidate === value)) {
          presentationIssues.push(
            `data.${field.field} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`,
          );
          valid = false;
        }
        if (valid) data[field.field] = structuredClone(value);
      }
      continue;
    }
    const selected = pointerValue(resolved.source, field.source_pointer ?? "");
    if (!selected.found || selected.value === undefined) {
      return { error: `source pointer ${field.source_pointer ?? "<root>"} for data.${field.field} did not resolve` };
    }
    sourceFields.push(field.field);
    if (field.mode === "source") {
      if (Object.prototype.hasOwnProperty.call(proposed, field.field)) ignoredSourceFields.push(field.field);
      data[field.field] = structuredClone(selected.value);
      continue;
    }
    if (!Array.isArray(selected.value)) {
      return { error: `source pointer ${field.source_pointer} for data.${field.field} must resolve to an array` };
    }
    const requested = proposed[field.field];
    const requestedCount = Number.isSafeInteger(requested)
      ? Number(requested)
      : Array.isArray(requested)
        ? requested.length
        : -1;
    if (Array.isArray(requested)) legacyPrefixArrays.push(field.field);
    const limit = Math.min(field.max_items ?? 100, selected.value.length);
    let count = requestedCount;
    if (field.final_count) {
      const resolvedCount = resolveDataSource(field.final_count.source, trustedInputs);
      if (resolvedCount.error && !resolvedCount.missing) return { error: resolvedCount.error };
      const selectedCount = resolvedCount.missing
        ? field.final_count.default
        : resolvedCount.source;
      const finalCount = selectedCount === "source_length"
        ? limit
        : Number.isSafeInteger(selectedCount) && Number(selectedCount) >= 0
          ? Math.min(Number(selectedCount), limit)
          : -1;
      if (finalCount < 0) {
        return { error: `trusted final count for data.${field.field} must be a non-negative integer` };
      }
      finalPrefixCounts[field.field] = finalCount;
      if (phase === "final") {
        count = finalCount;
      } else if (requested === undefined) {
        count = phase === "started" ? Math.min(1, finalCount) : finalCount;
      } else if (requestedCount >= 0) {
        count = Math.min(requestedCount, finalCount);
      }
    }
    if (count < 0 || count > limit) {
      return {
        error: `data.${field.field} must be an integer prefix count between 0 and ${limit}`,
      };
    }
    if (requestedCount >= 0 && requestedCount !== count) {
      adjustedPrefixCounts[field.field] = { requested: requestedCount, applied: count };
    }
    prefixCounts[field.field] = count;
    data[field.field] = structuredClone(selected.value.slice(0, count));
  }
  if (presentationIssues.length > 0) {
    return {
      error: presentationIssues[0],
      issues: presentationIssues,
    };
  }
  return {
    data,
    sourceFields,
    ignoredSourceFields,
    legacyPrefixArrays,
    prefixCounts,
    finalPrefixCounts,
    adjustedPrefixCounts,
  };
}

function pinnedDataContractDescription(
  viewId: string,
  contract: DagWorkerSkillVisualDataContractV1,
  trustedInputs?: Readonly<Record<string, unknown[]>>,
): string {
  const trustedFinalPrefixCounts = trustedFinalPrefixCountsForSchema(contract, trustedInputs);
  const source = contract.fields.filter((field) => field.mode === "source").map((field) => field.field);
  const prefixes = contract.fields
    .filter((field) => field.mode === "source_prefix")
    .map((field) => {
      const trustedCount = trustedFinalPrefixCounts[field.field];
      return trustedCount === undefined
        ? `${field.field}<=${field.max_items ?? 100}${field.final_count ? " (trusted final count)" : ""}`
        : `${field.field}<=${trustedCount} (this turn's trusted final count)`;
    });
  const presentation = contract.fields
    .filter((field) => field.mode === "presentation")
    .map((field) => {
      const schema = field.value_schema;
      const type = schema?.type ?? "string";
      const bound = type === "string" ? `<=${schema?.max_length ?? 500} chars` : type;
      const allowed = schema?.enum?.length ? ` enum=${schema.enum.map((value) => JSON.stringify(value)).join("|")}` : "";
      return `${field.field}:${bound}${allowed}`;
    });
  return [
    `${viewId} trusted data`,
    `omit Worker-owned source fields [${source.join(", ") || "none"}]`,
    `send integer prefix counts [${prefixes.join(", ") || "none"}]`,
    `model-owned presentation fields [${presentation.join(", ") || "none"}]`,
    ...(contract.required_phases
      ? [`required calls in exact order [${contract.required_phases.join(" -> ")}]`]
      : []),
    "send no other data keys",
  ].join(": ");
}

function trustedFinalPrefixValues(
  contract: DagWorkerSkillVisualDataContractV1,
  materialization: ContractMaterialization,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of contract.fields) {
    if (field.mode !== "source_prefix") continue;
    const selected = materialization.data?.[field.field];
    if (Array.isArray(selected)) values[field.field] = structuredClone(selected);
  }
  return values;
}

function generatedPinnedPatchId(state: DagToolsState, expectedSequence: number): string {
  const digest = createHash("sha256")
    .update([
      state.runId,
      state.nodeId,
      state.roundId ?? "",
      state.actorId ?? "",
      String(state.generation ?? ""),
      String(expectedSequence),
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `worker-${digest}`;
}

function surfacePhaseRank(phase: DagActorSurfacePatchPhaseV1): number {
  return DAG_ACTOR_SURFACE_PATCH_PHASES.indexOf(phase);
}

function redactionStableShapeError(value: unknown, depth = 0, path = "body"): string | undefined {
  if (depth > MAX_REDACTION_DEPTH) return `${path} exceeds redaction depth ${MAX_REDACTION_DEPTH}`;
  if (typeof value === "string" && value.length > MAX_REDACTION_STRING_LENGTH) {
    return `${path} exceeds redaction string limit ${MAX_REDACTION_STRING_LENGTH}`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_REDACTION_COLLECTION_SIZE) {
      return `${path} exceeds redaction collection limit ${MAX_REDACTION_COLLECTION_SIZE}`;
    }
    for (const [index, entry] of value.entries()) {
      const issue = redactionStableShapeError(entry, depth + 1, `${path}/${index}`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_REDACTION_COLLECTION_SIZE) {
      return `${path} exceeds redaction collection limit ${MAX_REDACTION_COLLECTION_SIZE}`;
    }
    for (const [key, entry] of entries) {
      const issue = redactionStableShapeError(entry, depth + 1, `${path}/${key}`);
      if (issue) return issue;
    }
  }
  return undefined;
}

function executableA2uiField(value: unknown, path = "body/a2ui"): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const issue = executableA2uiField(entry, `${path}/${index}`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (EXECUTABLE_A2UI_KEYS.has(key)) return `${path}/${key}`;
    const issue = executableA2uiField(entry, `${path}/${key}`);
    if (issue) return issue;
  }
  return undefined;
}

function protocolIssues(patch: unknown): string[] {
  return validateDagActorSurfacePatchV1(patch).errors
    .slice(0, 5)
    .map((error) => `${error.path || "/"}: ${error.message}`);
}

function resolvePinnedSurfaceBody(
  value: Record<string, unknown>,
  phase: DagActorSurfacePatchPhaseV1,
  pinnedViews: PinnedSurfaceViewRegistry | undefined,
  pinnedDataContracts: PinnedSurfaceDataContractRegistry | undefined,
  trustedInputs: Readonly<Record<string, unknown[]>> | undefined,
): {
  body?: DagActorSurfaceBodyV1;
  code?: string;
  message?: string;
  issues?: string[];
  materialization?: ContractMaterialization;
} {
  const viewId = value.view_id;
  if (viewId === undefined) {
    return { body: structuredClone(value) as unknown as DagActorSurfaceBodyV1 };
  }
  if (typeof viewId !== "string" || !viewId.trim() || viewId !== viewId.trim() || viewId.length > 256) {
    return { code: "invalid_profile_view", message: "body.view_id must be a bounded pinned view identifier" };
  }
  if (value.a2ui !== undefined) {
    return { code: "invalid_profile_view", message: "body.view_id and body.a2ui are mutually exclusive" };
  }
  const a2ui = pinnedViews?.get(viewId);
  if (!a2ui) {
    const available = [...(pinnedViews?.keys() ?? [])].sort().slice(0, 16);
    return {
      code: "unknown_profile_view",
      message: available.length
        ? `body.view_id is not pinned for this Actor; available views: ${available.join(", ")}`
        : "body.view_id is not pinned for this Actor",
    };
  }
  const { view_id: _viewId, ...body } = value;
  const contract = pinnedDataContracts?.get(viewId);
  let materialization: ContractMaterialization | undefined;
  if (contract) {
    if (!isRecord(body.data)) {
      return { code: "invalid_data_projection", message: "pinned data contract requires object body.data" };
    }
    materialization = materializeContractData(body.data, contract, trustedInputs, phase);
    if (!materialization.data) {
      return {
        code: materialization.error?.startsWith("trusted input") || materialization.error?.startsWith("source pointer")
          ? "source_contract_unavailable"
          : "invalid_data_projection",
        message: materialization.error ?? "Worker could not materialize the pinned data contract",
        ...(materialization.issues?.length ? { issues: materialization.issues } : {}),
      };
    }
    body.data = materialization.data;
    if (body.fallback === undefined) {
      body.fallback = derivePinnedFallback(materialization.data, viewId);
    }
  }
  return {
    body: {
      ...structuredClone(body),
      a2ui: structuredClone(a2ui),
    } as unknown as DagActorSurfaceBodyV1,
    ...(materialization ? { materialization } : {}),
  };
}

interface LockedIdentity {
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string;
  generation: number;
  lease_generation: number;
  surface_id: string;
}

function lockedIdentity(state: DagToolsState): LockedIdentity | undefined {
  if (!state.runId.trim() || !state.nodeId.trim() || !state.sessionId.trim()
    || !state.roundId?.trim() || !state.actorId?.trim() || !state.surfaceId?.trim()
    || !Number.isSafeInteger(state.generation) || (state.generation ?? 0) < 1
    || !Number.isSafeInteger(state.leaseGeneration) || (state.leaseGeneration ?? 0) < 1) {
    return undefined;
  }
  return {
    run_id: state.runId,
    node_id: state.nodeId,
    session_id: state.sessionId,
    round_id: state.roundId,
    actor_id: state.actorId,
    generation: state.generation as number,
    lease_generation: state.leaseGeneration as number,
    surface_id: state.surfaceId,
  };
}

export function createReportSurfaceStateTool(
  state: DagToolsState,
  emit: SurfacePatchEmitter,
  publishMedia?: SurfaceMediaPublisher,
  pinnedViews?: PinnedSurfaceViewRegistry,
  pinnedDataContracts?: PinnedSurfaceDataContractRegistry,
  trustedInputs?: Readonly<Record<string, unknown[]>>,
): DagToolDefinition {
  const pinnedViewIds = [...(pinnedViews?.keys() ?? [])].sort();
  const pinnedViewContracts = [...(pinnedViews?.entries() ?? [])]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([viewId, a2ui]) => {
      const dataContract = pinnedDataContracts?.get(viewId);
      if (dataContract) return pinnedDataContractDescription(viewId, dataContract, trustedInputs);
      const keys = pinnedViewDataKeys(a2ui);
      return `${viewId} data keys: ${keys.length > 0 ? keys.join(", ") : "none"}`;
    });
  const solePinnedDataContract = pinnedViewIds.length === 1
    ? pinnedDataContracts?.get(pinnedViewIds[0]!)
    : undefined;
  const soleRequiredPhases = solePinnedDataContract?.required_phases;
  if (soleRequiredPhases?.length) {
    state.surfaceReportingRequired = true;
    state.surfaceExpectedPhase = state.surfaceReportingComplete ? undefined : soleRequiredPhases[0];
    state.surfaceReportingFatalError = undefined;
  }
  let callQueue: Promise<void> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const result = callQueue.then(task);
    callQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  let acceptedPhase: DagActorSurfacePatchPhaseV1 | undefined;
  let acceptedPinnedViewId: string | undefined;
  let acceptedRequiredPhaseCount = 0;
  const tool: DagToolDefinition = {
    name: REPORT_SURFACE_STATE_TOOL_NAME,
    description: [
      "Submit a bounded passive A2UI body and readable fallback for this Actor's stable Surface.",
      ...(pinnedViewIds.length > 0
        ? [
            "PINNED SKILL VIEW MODE: use the advertised shallow pinned form instead of custom A2UI.",
            ...(solePinnedDataContract
              ? ["SOLE TRUSTED VIEW: send phase, view_id, the listed source-prefix/presentation fields, and optional fallback as flat top-level arguments. Do not send data, presentation_hint, or Canvas layout arguments."]
              : ["Its only top-level arguments are phase, view_id, data, optional fallback, and optional presentation_hint."]),
          ]
        : []),
      "The Worker injects immutable run/node/session/round/actor/generation/lease/surface identity and timestamp.",
      "This is a proposal to the Manager projector, never a direct Canvas mutation; submitted does not mean applied. Do not poll or retry a submitted proposal in the same turn.",
      "Phases are monotonic within this turn. A pinned contract's required calls are an exact sequence and take precedence; final closes Surface reporting. Follow next_allowed_phases or next_action in each result.",
      "If a pinned presentation field is rejected for type, enum, or length, shorten or correct it and retry the same required phase; rejection does not advance the sequence.",
      ...(pinnedViewIds.length === 0
        ? [`For custom A2UI, the next accepted patch_sequence is ${state.surfacePatchSequence + 1}.`]
        : []),
      ...(pinnedViewIds.length > 0
        ? [
            `Pinned Skill view_id values: ${pinnedViewIds.join(", ")}.`,
            `Pinned view contracts: ${pinnedViewContracts.join("; ")}.`,
            solePinnedDataContract
              ? "For this sole trusted view, send source_prefix counts and typed presentation fields directly at tool-argument root. The Worker packs body.data; Canvas layout is Manager-owned."
              : "For a legacy or multi-view pinned call, send only top-level phase, view_id, data, optional fallback, and optional presentation_hint.",
            "The Worker assigns patch_id and patch_sequence for every pinned view call.",
            "Omit Worker-owned source fields. The Worker materializes exact source values and derives fallback from trusted title/summary when omitted. After final, copy downstream evidence only from trusted_final_prefix_values when it is returned.",
            "For legacy views without a trusted data contract, fallback remains required and verified source values and media URLs must be preserved exactly. A submitted final is the last Surface call in this turn.",
          ]
        : []),
    ].join(" "),
    input_schema: pinnedViewIds.length > 0
      ? pinnedInputSchema(pinnedViewIds, pinnedDataContracts, trustedInputs)
      : REPORT_SURFACE_STATE_INPUT_SCHEMA,
    async handler(args: Record<string, unknown>) {
      if (!isRecord(args)) {
        return rejected("invalid_arguments", "tool arguments must be an object", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }
      const acceptedInputKeys = solePinnedDataContract
        ? new Set([
            ...TOOL_INPUT_KEYS,
            ...FLAT_PRESENTATION_HINT_KEYS,
            ...solePinnedDataContract.fields
              .filter((field) => field.mode !== "source")
              .map((field) => field.field),
          ])
        : TOOL_INPUT_KEYS;
      const extras = unexpectedKeys(args, acceptedInputKeys);
      if (extras.length) {
        const identitySpoof = extras.some((key) => IDENTITY_KEYS.has(key));
        return rejected(
          identitySpoof ? "identity_spoof" : "invalid_arguments",
          identitySpoof
            ? `identity is Worker-owned and cannot be supplied: ${extras.join(", ")}`
            : `unsupported tool fields: ${extras.join(", ")}`,
          { expected_patch_sequence: state.surfacePatchSequence + 1 },
        );
      }

      let toolArgs = solePinnedDataContract
        ? normalizeContractedPinnedArguments(args, solePinnedDataContract)
        : args;
      const pinnedShortcutFields = ["view_id", "data", "fallback", "presentation_hint"]
        .filter((key) => Object.prototype.hasOwnProperty.call(toolArgs, key));
      if (pinnedShortcutFields.length > 0) {
        if (toolArgs.body !== undefined || toolArgs.op !== undefined) {
          return rejected(
            "invalid_arguments",
            "pinned view shorthand must use top-level view_id and data with optional fallback, and omit op and body",
            { expected_patch_sequence: state.surfacePatchSequence + 1 },
          );
        }
        const shortcutViewId = typeof toolArgs.view_id === "string" ? toolArgs.view_id.trim() : "";
        const shortcutContract = shortcutViewId
          ? pinnedDataContracts?.get(shortcutViewId)
          : undefined;
        const hasValidFallback = typeof toolArgs.fallback === "string" || isRecord(toolArgs.fallback);
        if (!shortcutViewId
          || !isRecord(toolArgs.data)
          || (toolArgs.fallback !== undefined && !hasValidFallback)
          || (toolArgs.fallback === undefined && !shortcutContract)) {
          return rejected(
            "invalid_arguments",
            shortcutContract
              ? "pinned view shorthand requires top-level view_id and object data; fallback, when supplied, must be a string or object"
              : "legacy pinned view shorthand requires top-level view_id, object data, and fallback",
            { expected_patch_sequence: state.surfacePatchSequence + 1 },
          );
        }
        if (toolArgs.presentation_hint !== undefined && !isRecord(toolArgs.presentation_hint)) {
          return rejected(
            "invalid_arguments",
            "presentation_hint must be an object",
            { expected_patch_sequence: state.surfacePatchSequence + 1 },
          );
        }
        const normalizedFallback = toolArgs.fallback === undefined
          ? undefined
          : normalizePinnedFallback(toolArgs.fallback as string | Record<string, unknown>);
        if (normalizedFallback && !normalizedFallback.fallback) {
          return rejected(
            "invalid_arguments",
            normalizedFallback.error ?? "fallback must provide a bounded title",
            { expected_patch_sequence: state.surfacePatchSequence + 1 },
          );
        }
        const expectedSequence = state.surfacePatchSequence + 1;
        toolArgs = {
          patch_id: generatedPinnedPatchId(state, expectedSequence),
          patch_sequence: expectedSequence,
          phase: toolArgs.phase,
          op: "replace_body",
          body: {
            view_id: toolArgs.view_id,
            data: toolArgs.data,
            ...(normalizedFallback?.fallback
              ? { fallback: normalizedFallback.fallback }
              : {}),
            ...(toolArgs.presentation_hint === undefined
              ? {}
              : { presentation_hint: toolArgs.presentation_hint }),
          },
        };
      }

      const identity = lockedIdentity(state);
      if (!identity) {
        return rejected(
          "identity_unavailable",
          "dispatch is missing a locked round, actor, generation, lease, or surface identity",
          { expected_patch_sequence: state.surfacePatchSequence + 1 },
        );
      }

      const patchId = typeof toolArgs.patch_id === "string" ? toolArgs.patch_id.trim() : "";
      if (!PATCH_ID_PATTERN.test(patchId)) {
        return rejected("invalid_patch_id", "patch_id must be a bounded opaque identifier", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }
      if (state.surfacePatchIds.has(patchId)) {
        return rejected("duplicate_patch_id", "patch_id was already submitted in this Actor generation", {
          expected_patch_sequence: state.surfacePatchSequence + 1,
        });
      }

      const expectedSequence = state.surfacePatchSequence + 1;
      if (!Number.isSafeInteger(toolArgs.patch_sequence) || Number(toolArgs.patch_sequence) !== expectedSequence) {
        return rejected("sequence_conflict", `patch_sequence must equal ${expectedSequence}`, {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (!DAG_ACTOR_SURFACE_PATCH_PHASES.includes(toolArgs.phase as DagActorSurfacePatchPhaseV1)) {
        return rejected("invalid_phase", `phase must be one of ${DAG_ACTOR_SURFACE_PATCH_PHASES.join(", ")}`, {
          expected_patch_sequence: expectedSequence,
        });
      }
      const phase = toolArgs.phase as DagActorSurfacePatchPhaseV1;
      const requestedPinnedViewId = toolArgs.op === "replace_body"
        && isRecord(toolArgs.body)
        && typeof toolArgs.body.view_id === "string"
        ? toolArgs.body.view_id
        : undefined;
      if (acceptedPinnedViewId && requestedPinnedViewId && requestedPinnedViewId !== acceptedPinnedViewId) {
        return rejected(
          "profile_view_changed",
          `pinned view cannot change from ${acceptedPinnedViewId} to ${requestedPinnedViewId} in the current turn`,
          { expected_patch_sequence: expectedSequence },
        );
      }
      const requiredPhases = requestedPinnedViewId
        ? pinnedDataContracts?.get(requestedPinnedViewId)?.required_phases
        : undefined;
      const expectedRequiredPhase = requiredPhases?.[acceptedRequiredPhaseCount];
      if (expectedRequiredPhase && phase !== expectedRequiredPhase) {
        return rejected(
          "phase_sequence",
          `phase must be ${expectedRequiredPhase} for the next required Surface update`,
          {
            expected_patch_sequence: expectedSequence,
            expected_phase: expectedRequiredPhase,
            issues: [`required phases: ${requiredPhases!.join(" -> ")}`],
          },
        );
      }
      if (acceptedPhase === "final") {
        return ignored(
          "surface_turn_closed",
          "phase final already closed this Surface for the current turn; no state changed; continue with activity or handoff",
          { expected_patch_sequence: expectedSequence },
        );
      }
      if (acceptedPhase && surfacePhaseRank(phase) < surfacePhaseRank(acceptedPhase)) {
        return rejected(
          "phase_regression",
          `phase cannot move backward from ${acceptedPhase} to ${phase} in the current turn`,
          { expected_patch_sequence: expectedSequence },
        );
      }
      if (toolArgs.op !== "replace_body" && toolArgs.op !== "clear_body") {
        return rejected("invalid_operation", "op must be replace_body or clear_body", {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (toolArgs.op === "clear_body" && toolArgs.body !== undefined) {
        return rejected("invalid_body", "clear_body must not include body", {
          expected_patch_sequence: expectedSequence,
        });
      }
      if (toolArgs.op === "replace_body" && !isRecord(toolArgs.body)) {
        return rejected("invalid_body", "replace_body requires an object body", {
          expected_patch_sequence: expectedSequence,
        });
      }

      const replaceBody = toolArgs.op === "replace_body"
        ? toolArgs.body as Record<string, unknown>
        : undefined;
      if (toolArgs.op === "replace_body") {
        const shapeIssue = redactionStableShapeError(replaceBody);
        if (shapeIssue) {
          return rejected("payload_budget", shapeIssue, { expected_patch_sequence: expectedSequence });
        }
        const bodyAnalysis = analyzeGenerativeUiJsonValue(replaceBody, {
          path: "/body",
          limits: {
            max_depth: MAX_REDACTION_DEPTH,
            max_values: 4_000,
            max_bytes: MAX_SURFACE_PATCH_BODY_BYTES,
          },
        });
        if (!bodyAnalysis.valid) {
          return rejected(
            "payload_budget",
            bodyAnalysis.error?.message ?? "body exceeds its JSON budget",
            { expected_patch_sequence: expectedSequence },
          );
        }
        const executable = executableA2uiField(replaceBody?.a2ui);
        if (executable) {
          return rejected("active_content", `passive A2UI cannot contain executable field ${executable}`, {
            expected_patch_sequence: expectedSequence,
          });
        }
      }

      let brokeredBody: DagActorSurfaceBodyV1 | undefined;
      let contractMaterialization: ContractMaterialization | undefined;
      if (replaceBody) {
        const resolved = resolvePinnedSurfaceBody(
          replaceBody,
          phase,
          pinnedViews,
          pinnedDataContracts,
          trustedInputs,
        );
        if (!resolved.body) {
          const sourceContractUnavailable = resolved.code === "source_contract_unavailable";
          const invalidDataProjection = resolved.code === "invalid_data_projection";
          if (sourceContractUnavailable) {
            state.surfaceReportingFatalError = {
              code: resolved.code!,
              message: resolved.message ?? "Worker could not resolve the pinned Skill visual profile",
            };
          }
          return rejected(
            resolved.code ?? "invalid_profile_view",
            resolved.message ?? "Worker could not resolve the pinned Skill visual profile",
            {
              expected_patch_sequence: expectedSequence,
              ...(sourceContractUnavailable
                ? {
                    retryable: false,
                    next_action: "Do not retry report_surface_state or call handoff in this turn. End the turn so the runtime records the immutable Surface input-contract failure.",
                  }
                : invalidDataProjection
                  ? {
                      retryable: true,
                      expected_phase: phase,
                      ...(resolved.issues?.length ? { issues: resolved.issues.slice(0, 16) } : {}),
                      next_action: `Correct every rejected presentation value and retry report_surface_state with phase ${phase}.`,
                    }
                : {}),
            },
          );
        }
        contractMaterialization = resolved.materialization;
        const resolvedAnalysis = analyzeGenerativeUiJsonValue(resolved.body, {
          path: "/body",
          limits: {
            max_depth: MAX_REDACTION_DEPTH,
            max_values: 4_000,
            max_bytes: MAX_SURFACE_PATCH_BODY_BYTES,
          },
        });
        if (!resolvedAnalysis.valid) {
          return rejected(
            "payload_budget",
            resolvedAnalysis.error?.message ?? "resolved body exceeds its JSON budget",
            { expected_patch_sequence: expectedSequence },
          );
        }
        const executable = executableA2uiField(resolved.body.a2ui);
        if (executable) {
          return rejected("active_content", `passive A2UI cannot contain executable field ${executable}`, {
            expected_patch_sequence: expectedSequence,
          });
        }
        try {
          brokeredBody = await brokerSurfaceMediaBody(
            resolved.body,
            publishMedia,
          );
        } catch (error) {
          const mediaError = error instanceof SurfaceMediaError ? error : undefined;
          return rejected(
            mediaError?.code ?? "media_broker_failed",
            mediaError?.message ?? "Worker could not broker Actor surface media",
            { expected_patch_sequence: expectedSequence },
          );
        }
      }

      const timestamp = Date.now();
      const patchBase = {
        schema_version: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION,
        run_id: identity.run_id,
        node_id: identity.node_id,
        session_id: identity.session_id,
        round_id: identity.round_id,
        actor_id: identity.actor_id,
        generation: identity.generation,
        lease_generation: identity.lease_generation,
        patch_id: patchId,
        patch_sequence: expectedSequence,
        timestamp,
        phase,
      };
      const rawPatch: DagActorSurfacePatchV1 = toolArgs.op === "clear_body"
        ? { ...patchBase, op: "clear_body" as const }
        : {
            ...patchBase,
            op: "replace_body" as const,
            body: brokeredBody!,
          };
      const rawIssues = protocolIssues(rawPatch);
      if (rawIssues.length) {
        return rejected("invalid_patch", "proposal failed the Actor Surface protocol", {
          expected_patch_sequence: expectedSequence,
          issues: rawIssues,
        });
      }

      const patch: DagActorSurfacePatchV1 = toolArgs.op === "clear_body"
        ? rawPatch
        : {
            ...patchBase,
            op: "replace_body",
            body: redactTelemetry(brokeredBody) as DagActorSurfaceBodyV1,
          };
      const redactedIssues = protocolIssues(patch);
      if (redactedIssues.length) {
        return rejected("redaction_invalid", "redaction made the proposal protocol-invalid", {
          expected_patch_sequence: expectedSequence,
          issues: redactedIssues,
        });
      }

      try {
        emit({ surface_id: identity.surface_id, patch });
      } catch {
        return rejected("transport_rejected", "Worker could not submit the proposal to Manager transport", {
          expected_patch_sequence: expectedSequence,
        });
      }
      state.surfacePatchSequence = expectedSequence;
      state.surfacePatchIds.add(patchId);
      acceptedPhase = phase;
      if (requestedPinnedViewId) {
        acceptedPinnedViewId = requestedPinnedViewId;
        if (requiredPhases) acceptedRequiredPhaseCount += 1;
      }
      const nextRequiredPhase = requiredPhases?.[acceptedRequiredPhaseCount];
      if (requiredPhases) {
        state.surfaceExpectedPhase = nextRequiredPhase;
        state.surfaceReportingComplete = nextRequiredPhase === undefined && phase === "final";
        if (state.surfaceReportingComplete) state.surfaceReportingFatalError = undefined;
      }
      const acceptedDataContract = requestedPinnedViewId
        ? pinnedDataContracts?.get(requestedPinnedViewId)
        : undefined;
      const finalPrefixValues = phase === "final" && acceptedDataContract && contractMaterialization
        ? trustedFinalPrefixValues(acceptedDataContract, contractMaterialization)
        : {};
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "submitted",
            patch_id: patchId,
            patch_sequence: expectedSequence,
            surface_id: identity.surface_id,
            manager_validation: "pending",
            canvas_mutated: false,
            surface_phase: phase,
            ...(contractMaterialization
              ? {
                  trusted_data_materialized: contractMaterialization.sourceFields ?? [],
                  source_prefix_counts: contractMaterialization.prefixCounts ?? {},
                  ...(Object.keys(contractMaterialization.finalPrefixCounts ?? {}).length > 0
                    ? { trusted_final_prefix_counts: contractMaterialization.finalPrefixCounts }
                    : {}),
                  ...(Object.keys(contractMaterialization.adjustedPrefixCounts ?? {}).length > 0
                    ? { adjusted_source_prefix_counts: contractMaterialization.adjustedPrefixCounts }
                    : {}),
                  ...(Object.keys(finalPrefixValues).length > 0
                    ? { trusted_final_prefix_values: finalPrefixValues }
                    : {}),
                  ...(contractMaterialization.ignoredSourceFields?.length
                    ? { ignored_model_source_fields: contractMaterialization.ignoredSourceFields }
                    : {}),
                  ...(contractMaterialization.legacyPrefixArrays?.length
                    ? { normalized_legacy_prefix_arrays: contractMaterialization.legacyPrefixArrays }
                    : {}),
                }
              : {}),
            ...(phase === "final"
              ? {
                  surface_turn_closed: true,
                  next_action: "Do not call report_surface_state again in this turn. Use trusted_final_prefix_values when present, then continue with activity or handoff.",
                }
              : nextRequiredPhase
                ? {
                    next_allowed_phases: [nextRequiredPhase],
                    next_action: `Call report_surface_state next with phase ${nextRequiredPhase}.`,
                  }
              : {
                  next_allowed_phases: DAG_ACTOR_SURFACE_PATCH_PHASES.slice(surfacePhaseRank(phase)),
                }),
          }),
        }],
      };
    },
  };
  const handler = tool.handler;
  tool.handler = (args) => serialize(() => handler(args));
  return tool;
}

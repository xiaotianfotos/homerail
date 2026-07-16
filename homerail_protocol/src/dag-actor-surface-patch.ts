/**
 * Durable rich-surface proposals emitted by one logical DAG Actor.
 * @version 1
 */

import type {
  GenerativeUiCanvasSize,
  GenerativeUiDensity,
  GenerativeUiFallbackV1,
  HomerailA2uiSurfaceV1,
} from "./generative-ui/index.js";

export const DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION = 1 as const;
export const DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID = "dag-actor-surface-patch-v1" as const;
export const DAG_ACTOR_SURFACE_PATCH_MAX_BYTES = 64 * 1024;
export const DAG_ACTOR_SURFACE_PATCH_MAX_COMPONENTS = 64;
export const DAG_ACTOR_SURFACE_PATCH_MAX_DEPTH = 6;
export const DAG_ACTOR_SURFACE_PATCH_MAX_DIRECT_CHILDREN = 16;

export const DAG_ACTOR_SURFACE_PATCH_PHASES = [
  "started",
  "partial",
  "verified",
  "refined",
  "final",
] as const;
export type DagActorSurfacePatchPhaseV1 = (typeof DAG_ACTOR_SURFACE_PATCH_PHASES)[number];

export interface DagActorSurfacePresentationHintV1 {
  density?: GenerativeUiDensity;
  canvas_size?: GenerativeUiCanvasSize;
  preferred_visual?: string;
}

export interface DagActorSurfaceBodyV1 {
  a2ui: HomerailA2uiSurfaceV1;
  data: Record<string, unknown>;
  fallback: GenerativeUiFallbackV1;
  presentation_hint?: DagActorSurfacePresentationHintV1;
}

interface DagActorSurfacePatchIdentityV1 {
  schema_version: typeof DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION;
  run_id: string;
  node_id: string;
  session_id: string;
  round_id: string;
  actor_id: string;
  generation: number;
  lease_generation: number;
  patch_id: string;
  /** Contiguous body revision within one logical Actor generation. */
  patch_sequence: number;
  /** Unix epoch milliseconds assigned by the patch source. */
  timestamp: number;
  phase: DagActorSurfacePatchPhaseV1;
}

export type DagActorSurfacePatchV1 = DagActorSurfacePatchIdentityV1 & (
  | { op: "replace_body"; body: DagActorSurfaceBodyV1 }
  | { op: "clear_body"; body?: never }
);

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
} as const;

const jsonValueSchema = {
  oneOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "#/definitions/jsonValue" } },
    { type: "object", additionalProperties: { $ref: "#/definitions/jsonValue" } },
  ],
} as const;

const artifactRefSchema = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    uri: { type: "string", minLength: 1, maxLength: 2_048 },
    media_type: { type: "string", minLength: 1, maxLength: 160 },
  },
  required: ["label", "uri"],
  additionalProperties: false,
} as const;

const fallbackSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 4_000 },
    items: {
      type: "array",
      maxItems: 16,
      items: { type: "string", maxLength: 500 },
    },
    artifact_refs: {
      type: "array",
      maxItems: 16,
      items: artifactRefSchema,
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const presentationHintSchema = {
  type: "object",
  properties: {
    density: { type: "string", enum: ["glance", "summary", "detail"] },
    canvas_size: { type: "string", enum: ["1x1", "1x2", "2x2", "3x3"] },
    preferred_visual: { type: "string", minLength: 1, maxLength: 120 },
  },
  additionalProperties: false,
} as const;

/**
 * Projector-owned generated_view content may expose this one optional Actor
 * partition. Patch validation remains the stricter source for nested JSON.
 */
export const dagActorSurfaceActorViewV1Schema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      additionalProperties: true,
    },
    fallback: fallbackSchema,
    presentation_hint: presentationHintSchema,
  },
  required: ["data", "fallback"],
  additionalProperties: false,
} as const;

const bodySchema = {
  type: "object",
  properties: {
    a2ui: { $ref: "homerail-a2ui-surface-v1" },
    data: {
      type: "object",
      additionalProperties: { $ref: "#/definitions/jsonValue" },
    },
    fallback: fallbackSchema,
    presentation_hint: presentationHintSchema,
  },
  required: ["a2ui", "data", "fallback"],
  additionalProperties: false,
} as const;

export const dagActorSurfacePatchV1Schema = {
  $id: DAG_ACTOR_SURFACE_PATCH_V1_SCHEMA_ID,
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  definitions: { jsonValue: jsonValueSchema },
  properties: {
    schema_version: { type: "integer", const: DAG_ACTOR_SURFACE_PATCH_SCHEMA_VERSION },
    run_id: identifierSchema,
    node_id: identifierSchema,
    session_id: identifierSchema,
    round_id: identifierSchema,
    actor_id: identifierSchema,
    generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    lease_generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    patch_id: identifierSchema,
    patch_sequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    timestamp: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    op: { type: "string", enum: ["replace_body", "clear_body"] },
    phase: { type: "string", enum: DAG_ACTOR_SURFACE_PATCH_PHASES },
    body: bodySchema,
  },
  required: [
    "schema_version",
    "run_id",
    "node_id",
    "session_id",
    "round_id",
    "actor_id",
    "generation",
    "lease_generation",
    "patch_id",
    "patch_sequence",
    "timestamp",
    "op",
    "phase",
  ],
  oneOf: [
    {
      properties: { op: { const: "replace_body" } },
      required: ["body"],
    },
    {
      properties: { op: { const: "clear_body" } },
      not: { required: ["body"] },
    },
  ],
  additionalProperties: false,
} as const;

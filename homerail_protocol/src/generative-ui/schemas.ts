/**
 * Draft-07 JSON Schemas for the Generative UI semantic protocol.
 * @version 0.1.0
 */

import {
  GENERATIVE_UI_COMPOSITION_VERSION,
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActionStyle,
  GenerativeUiAttention,
  GenerativeUiActorType,
  GenerativeUiCanvasSize,
  GenerativeUiDensity,
  GenerativeUiDevice,
  GenerativeUiDocumentScopeType,
  GenerativeUiImportance,
  GenerativeUiInputModality,
  GenerativeUiMotionProfile,
  GenerativeUiPlacement,
  GenerativeUiPersistence,
  GenerativeUiPhase,
  GenerativeUiPatchUnsetField,
  GenerativeUiSurface,
  GenerativeUiViewport,
  GenerativeUiVisibility,
} from "./types.js";
import { HOMERAIL_VIEW_SPEC_VERSION } from "./view-spec.js";

const opaqueId = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s*$)[^\\u0000-\\u001F\\u007F]+$",
} as const;
const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 160,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;
const dateTime = {
  type: "string",
  maxLength: 40,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
} as const;
const pluginId = {
  type: "string",
  minLength: 3,
  maxLength: 160,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+$",
} as const;
const semanticKind = {
  type: "string",
  minLength: 5,
  maxLength: 200,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+/[a-z][a-z0-9._-]*$",
} as const;
const irVersion = { const: GENERATIVE_UI_IR_VERSION } as const;
const surface = { type: "string", enum: Object.values(GenerativeUiSurface) } as const;
const importance = { type: "string", enum: Object.values(GenerativeUiImportance) } as const;
const viewPointer = {
  type: "string",
  maxLength: 500,
  pattern: "^(?:/(?:[^~/]|~[01])*)*$",
} as const;
const viewValueSchema = {
  $id: "homerail-view-value-v1",
  oneOf: [
    {
      type: "object",
      properties: { literal: { type: ["string", "number", "boolean"] } },
      required: ["literal"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        path: viewPointer,
        format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        item_path: viewPointer,
        format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
      },
      required: ["item_path"],
      additionalProperties: false,
    },
  ],
} as const;
const viewToneSchema = {
  oneOf: [
    { type: "string", enum: ["neutral", "info", "positive", "warning", "critical"] },
    { $ref: "homerail-view-value-v1" },
  ],
} as const;
const viewPredicateSchema = {
  type: "object",
  properties: {
    path: viewPointer,
    item_path: viewPointer,
    operator: { type: "string", enum: ["exists", "not_empty", "equals", "not_equals", "gt", "gte", "lt", "lte"] },
    value: { type: ["string", "number", "boolean"] },
  },
  required: ["operator"],
  additionalProperties: false,
} as const;
const viewTableColumnSchema = {
  type: "object",
  properties: {
    id: identifier,
    label: { type: "string", minLength: 1, maxLength: 80 },
    path: viewPointer,
    format: { type: "string", enum: ["text", "number", "percent", "datetime", "duration", "status", "tone"] },
  },
  required: ["id", "label", "path"],
  additionalProperties: false,
} as const;

/** Closed primitive vocabulary; per-type field legality is enforced semantically. */
export const homerailViewNodeSchema = {
  $id: "homerail-view-node-v1",
  type: "object",
  properties: {
    id: identifier,
    type: { type: "string", enum: [
      "stack", "grid", "section", "heading", "text", "markdown", "icon", "badge", "divider",
      "metric", "progress", "list", "table", "timeline", "bar_chart", "dag", "action", "disclosure", "link", "artifact", "repeat",
    ] },
    span: { type: "integer", minimum: 1, maximum: 3 },
    when: viewPredicateSchema,
    children: { type: "array", minItems: 1, maxItems: 24, items: { $ref: "homerail-view-node-v1" } },
    item: { $ref: "homerail-view-node-v1" },
    gap: { type: "string", enum: ["none", "xs", "sm", "md", "lg"] },
    align: { type: "string", enum: ["start", "center", "end", "stretch"] },
    columns: {
      oneOf: [
        {
          type: "object",
          properties: {
            default: { type: "integer", minimum: 1, maximum: 3 },
            compact: { type: "integer", minimum: 1, maximum: 2 },
          },
          required: ["default"],
          additionalProperties: false,
        },
        { type: "array", minItems: 1, maxItems: 8, items: viewTableColumnSchema },
      ],
    },
    title: { $ref: "homerail-view-value-v1" },
    text: { $ref: "homerail-view-value-v1" },
    label: { $ref: "homerail-view-value-v1" },
    value: { $ref: "homerail-view-value-v1" },
    unit: { $ref: "homerail-view-value-v1" },
    uri: { $ref: "homerail-view-value-v1" },
    description: { $ref: "homerail-view-value-v1" },
    alt: { $ref: "homerail-view-value-v1" },
    kind: { type: "string", enum: ["image", "html", "file"] },
    layout: { type: "string", enum: ["fluid", "portrait"] },
    tone: viewToneSchema,
    level: { type: "integer", minimum: 1, maximum: 3 },
    max_lines: { type: "integer", minimum: 1, maximum: 24 },
    name: { type: "string", enum: [
      "activity", "alert", "check", "clock", "database", "external-link", "file", "git", "monitor",
      "pause", "play", "search", "server", "settings", "shield", "sparkles", "user", "x",
    ] },
    source: viewPointer,
    max_items: { type: "integer", minimum: 1, maximum: 50 },
    item_title_path: viewPointer,
    item_detail_path: viewPointer,
    item_badge_path: viewPointer,
    item_status_path: viewPointer,
    item_time_path: viewPointer,
    item_label_path: viewPointer,
    item_value_path: viewPointer,
    item_tone_path: viewPointer,
    item_id_path: viewPointer,
    item_progress_path: viewPointer,
    item_depends_on_path: viewPointer,
    action_id: identifier,
    style: { type: "string", enum: ["primary", "secondary", "danger"] },
    open: { type: "boolean" },
  },
  required: ["id", "type"],
  additionalProperties: false,
} as const;

export const homerailViewSpecSchema = {
  $id: "homerail-view-spec-v1",
  type: "object",
  properties: {
    view_version: { const: HOMERAIL_VIEW_SPEC_VERSION },
    root: { $ref: "homerail-view-node-v1" },
  },
  required: ["view_version", "root"],
  additionalProperties: false,
} as const;

const pluginRefSchema = {
  type: "object",
  properties: {
    id: pluginId,
    version: { type: "string", minLength: 1, maxLength: 64 },
  },
  required: ["id", "version"],
  additionalProperties: false,
} as const;

const statusSchema = {
  type: "object",
  properties: {
    phase: { type: "string", enum: Object.values(GenerativeUiPhase) },
    label: { type: "string", maxLength: 160 },
    progress: { type: "number", minimum: 0, maximum: 100 },
  },
  required: ["phase"],
  additionalProperties: false,
} as const;

const presentationSchema = {
  type: "object",
  properties: {
    density: { type: "string", enum: Object.values(GenerativeUiDensity) },
    canvas_size: { type: "string", enum: Object.values(GenerativeUiCanvasSize) },
    motion_profile: { type: "string", enum: Object.values(GenerativeUiMotionProfile) },
    preferred_visual: { type: "string", minLength: 1, maxLength: 80 },
  },
  additionalProperties: false,
} as const;

const lifecycleSchema = {
  type: "object",
  properties: {
    persistence: { type: "string", enum: Object.values(GenerativeUiPersistence) },
    default_visibility: { type: "string", enum: Object.values(GenerativeUiVisibility) },
    expires_at: dateTime,
    removable: { type: "boolean" },
  },
  required: ["persistence"],
  additionalProperties: false,
} as const;

const artifactRefSchema = {
  type: "object",
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    uri: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      pattern: "^(?![\\s])(?![\\\\/]{2})(?!\\\\)(?!.*[\\s]$)(?:[Hh][Tt][Tt][Pp][Ss]?://[^\\s\\\\\\u0000-\\u001F\\u007F]+|[Aa][Rr][Tt][Ii][Ff][Aa][Cc][Tt]:[A-Za-z0-9][A-Za-z0-9._~/%-]*|[A-Za-z]:[\\\\/](?![\\\\/])[^\\u0000-\\u001F\\u007F]*|[^:\\u0000-\\u001F\\u007F]+)$",
    },
    media_type: { type: "string", minLength: 1, maxLength: 160 },
  },
  required: ["label", "uri"],
  additionalProperties: false,
} as const;

const fallbackSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 4000 },
    items: { type: "array", maxItems: 16, items: { type: "string", maxLength: 500 } },
    artifact_refs: { type: "array", maxItems: 16, items: artifactRefSchema },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const confirmationSchema = {
  type: "object",
  properties: {
    required: { type: "boolean" },
    message: { type: "string", maxLength: 1000 },
  },
  required: ["required"],
  additionalProperties: false,
} as const;

const actionSchema = {
  type: "object",
  properties: {
    id: identifier,
    label: { type: "string", minLength: 1, maxLength: 120 },
    intent: identifier,
    arguments: { type: "object", maxProperties: 64, additionalProperties: true },
    style: { type: "string", enum: Object.values(GenerativeUiActionStyle) },
    confirmation: confirmationSchema,
  },
  required: ["id", "label", "intent"],
  additionalProperties: false,
} as const;

const provenanceSchema = {
  type: "object",
  properties: {
    actor: { type: "string", enum: Object.values(GenerativeUiActorType) },
    actor_id: opaqueId,
    plugin: pluginRefSchema,
    skill_id: identifier,
    turn_id: identifier,
    run_id: identifier,
  },
  required: ["actor"],
  additionalProperties: false,
} as const;

const nodeProperties = {
  ir_version: irVersion,
  id: opaqueId,
  kind: semanticKind,
  kind_version: { type: "integer", minimum: 1 },
  owner: pluginRefSchema,
  surface,
  importance,
  status: statusSchema,
  content: { type: "object", maxProperties: 128, additionalProperties: true },
  view: { $ref: "homerail-view-spec-v1" },
  presentation: presentationSchema,
  lifecycle: lifecycleSchema,
  actions: { type: "array", maxItems: 12, items: actionSchema },
  fallback: fallbackSchema,
  provenance: provenanceSchema,
} as const;

const nodeRequired = [
  "ir_version",
  "id",
  "kind",
  "kind_version",
  "owner",
  "surface",
  "importance",
  "content",
  "fallback",
] as const;

export const generativeUiNodeSchema = {
  $id: "generative-ui-node",
  type: "object",
  properties: nodeProperties,
  required: nodeRequired,
  additionalProperties: false,
} as const;

export const generativeUiStoredNodeSchema = {
  $id: "generative-ui-stored-node",
  type: "object",
  properties: {
    ...nodeProperties,
    revision: { type: "integer", minimum: 1 },
    updated_at: dateTime,
  },
  required: [...nodeRequired, "revision", "updated_at"],
  additionalProperties: false,
} as const;

const documentScopeSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: Object.values(GenerativeUiDocumentScopeType) },
    id: opaqueId,
  },
  required: ["type", "id"],
  additionalProperties: false,
} as const;

export const generativeUiDocumentSchema = {
  $id: "generative-ui-document",
  type: "object",
  properties: {
    ir_version: irVersion,
    document_id: opaqueId,
    scope: documentScopeSchema,
    revision: { type: "integer", minimum: 0 },
    nodes: { type: "array", maxItems: 128, items: { $ref: "generative-ui-stored-node" } },
    updated_at: dateTime,
  },
  required: [
    "ir_version",
    "document_id",
    "scope",
    "revision",
    "nodes",
    "updated_at",
  ],
  additionalProperties: false,
} as const;

const patchSchema = {
  type: "object",
  properties: {
    surface,
    importance,
    status: statusSchema,
    content: { type: "object", maxProperties: 128, additionalProperties: true },
    view: { $ref: "homerail-view-spec-v1" },
    presentation: presentationSchema,
    lifecycle: lifecycleSchema,
    actions: { type: "array", maxItems: 12, items: actionSchema },
    fallback: fallbackSchema,
    provenance: provenanceSchema,
    unset: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: Object.values(GenerativeUiPatchUnsetField) },
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const actorSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: Object.values(GenerativeUiActorType) },
    id: identifier,
    plugin: pluginRefSchema,
    skill_id: identifier,
    turn_id: identifier,
  },
  required: ["type"],
  additionalProperties: false,
} as const;

export const generativeUiTransactionSchema = {
  $id: "generative-ui-transaction",
  type: "object",
  properties: {
    ir_version: irVersion,
    transaction_id: identifier,
    document_id: opaqueId,
    base_revision: { type: "integer", minimum: 0 },
    actor: actorSchema,
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              op: { const: "put" },
              node: { $ref: "generative-ui-node" },
            },
            required: ["op", "node"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { const: "patch" },
              node_id: opaqueId,
              if_revision: { type: "integer", minimum: 1 },
              changes: patchSchema,
            },
            required: ["op", "node_id", "changes"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              op: { const: "remove" },
              node_id: opaqueId,
              if_revision: { type: "integer", minimum: 1 },
            },
            required: ["op", "node_id"],
            additionalProperties: false,
          },
        ],
      },
    },
    created_at: dateTime,
  },
  required: [
    "ir_version",
    "transaction_id",
    "document_id",
    "base_revision",
    "actor",
    "operations",
    "created_at",
  ],
  additionalProperties: false,
} as const;

export const generativeUiUserOverrideSchema = {
  $id: "generative-ui-user-override",
  type: "object",
  properties: {
    document_id: opaqueId,
    node_id: opaqueId,
    visibility: { type: "string", enum: Object.values(GenerativeUiVisibility) },
    pinned: { type: "boolean" },
    preferred_surface: surface,
    updated_at: dateTime,
  },
  required: ["document_id", "node_id", "updated_at"],
  anyOf: [
    { required: ["visibility"] },
    { required: ["pinned"] },
    { required: ["preferred_surface"] },
  ],
  additionalProperties: false,
} as const;

const surfaceCapacitiesSchema = {
  type: "object",
  properties: Object.fromEntries(
    Object.values(GenerativeUiSurface).map((name) => [name, { type: "integer", minimum: 0, maximum: 128 }]),
  ),
  minProperties: 1,
  additionalProperties: false,
} as const;

export const generativeUiCompositionContextSchema = {
  $id: "generative-ui-composition-context",
  type: "object",
  properties: {
    device: { type: "string", enum: Object.values(GenerativeUiDevice) },
    input: { type: "string", enum: Object.values(GenerativeUiInputModality) },
    viewport: { type: "string", enum: Object.values(GenerativeUiViewport) },
    attention: { type: "string", enum: Object.values(GenerativeUiAttention) },
    active_run_id: identifier,
    active_session_id: opaqueId,
    surface_capacities: surfaceCapacitiesSchema,
  },
  required: ["device", "input", "viewport", "attention"],
  additionalProperties: false,
} as const;

const compositionItemSchema = {
  type: "object",
  properties: {
    node_id: opaqueId,
    node_revision: { type: "integer", minimum: 1 },
    surface,
    variant: { type: "string", enum: Object.values(GenerativeUiDensity) },
    rank: { type: "integer", minimum: 1, maximum: 128 },
    placement: { type: "string", enum: Object.values(GenerativeUiPlacement) },
    pinned: { type: "boolean" },
    visibility: {
      type: "string",
      enum: [GenerativeUiVisibility.VISIBLE, GenerativeUiVisibility.MINIMIZED],
    },
  },
  required: [
    "node_id",
    "node_revision",
    "surface",
    "variant",
    "rank",
    "placement",
    "pinned",
    "visibility",
  ],
  additionalProperties: false,
} as const;

export const generativeUiCompositionSchema = {
  $id: "generative-ui-composition",
  type: "object",
  properties: {
    composition_version: { const: GENERATIVE_UI_COMPOSITION_VERSION },
    document_id: opaqueId,
    document_revision: { type: "integer", minimum: 0 },
    context: { $ref: "generative-ui-composition-context" },
    items: { type: "array", maxItems: 128, items: compositionItemSchema },
    hidden_node_ids: { type: "array", maxItems: 128, items: opaqueId },
  },
  required: [
    "composition_version",
    "document_id",
    "document_revision",
    "context",
    "items",
    "hidden_node_ids",
  ],
  additionalProperties: false,
} as const;

export const generativeUiInteractionEventSchema = {
  $id: "generative-ui-interaction-event",
  type: "object",
  properties: {
    ir_version: irVersion,
    event_id: identifier,
    idempotency_key: identifier,
    document_id: opaqueId,
    node_id: opaqueId,
    node_revision: { type: "integer", minimum: 1 },
    action_id: identifier,
    input: { type: "object", maxProperties: 64, additionalProperties: true },
    created_at: dateTime,
  },
  required: [
    "ir_version",
    "event_id",
    "idempotency_key",
    "document_id",
    "node_id",
    "node_revision",
    "action_id",
    "created_at",
  ],
  additionalProperties: false,
} as const;

export const generativeUiSchemas: Record<string, Record<string, unknown>> = {
  "homerail-view-value-v1": viewValueSchema as Record<string, unknown>,
  "homerail-view-node-v1": homerailViewNodeSchema as Record<string, unknown>,
  "homerail-view-spec-v1": homerailViewSpecSchema as Record<string, unknown>,
  "generative-ui-node": generativeUiNodeSchema as Record<string, unknown>,
  "generative-ui-stored-node": generativeUiStoredNodeSchema as Record<string, unknown>,
  "generative-ui-document": generativeUiDocumentSchema as Record<string, unknown>,
  "generative-ui-transaction": generativeUiTransactionSchema as Record<string, unknown>,
  "generative-ui-user-override": generativeUiUserOverrideSchema as Record<string, unknown>,
  "generative-ui-composition-context": generativeUiCompositionContextSchema as Record<string, unknown>,
  "generative-ui-composition": generativeUiCompositionSchema as Record<string, unknown>,
  "generative-ui-interaction-event": generativeUiInteractionEventSchema as Record<string, unknown>,
};

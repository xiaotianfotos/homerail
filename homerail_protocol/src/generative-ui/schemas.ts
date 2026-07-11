/**
 * Draft-07 JSON Schemas for the Generative UI semantic protocol.
 * @version 0.1.0
 */

import {
  GENERATIVE_UI_IR_VERSION,
  GenerativeUiActionStyle,
  GenerativeUiActorType,
  GenerativeUiDensity,
  GenerativeUiDocumentScopeType,
  GenerativeUiImportance,
  GenerativeUiPersistence,
  GenerativeUiPhase,
  GenerativeUiPatchUnsetField,
  GenerativeUiSurface,
  GenerativeUiVisibility,
} from "./types.js";

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
    uri: { type: "string", minLength: 1, maxLength: 2048 },
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
  "generative-ui-node": generativeUiNodeSchema as Record<string, unknown>,
  "generative-ui-stored-node": generativeUiStoredNodeSchema as Record<string, unknown>,
  "generative-ui-document": generativeUiDocumentSchema as Record<string, unknown>,
  "generative-ui-transaction": generativeUiTransactionSchema as Record<string, unknown>,
  "generative-ui-user-override": generativeUiUserOverrideSchema as Record<string, unknown>,
  "generative-ui-interaction-event": generativeUiInteractionEventSchema as Record<string, unknown>,
};

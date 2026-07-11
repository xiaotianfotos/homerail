/** Draft-07 schema for the HomeRail Plugin Manifest V1. */

import {
  HOMERAIL_PLUGIN_MANIFEST_VERSION,
  HomerailPluginConfirmation,
  HomerailPluginEffect,
  HomerailPluginModality,
  HomerailPluginPermission,
  HomerailPluginRendererMode,
  HomerailPluginRuntimeTrust,
} from "./types.js";
import {
  GenerativeUiDensity,
  GenerativeUiDevice,
  GenerativeUiSurface,
} from "../generative-ui/types.js";

const localId = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z][a-z0-9._-]*$",
} as const;

const toolId = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_]*$",
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

const semver = {
  type: "string",
  minLength: 5,
  maxLength: 64,
  pattern: "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
} as const;

const packagePath = {
  type: "string",
  minLength: 1,
  maxLength: 300,
  pattern: "^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
} as const;

const shortText = { type: "string", minLength: 1, maxLength: 240 } as const;
const permission = { type: "string", enum: Object.values(HomerailPluginPermission) } as const;
const permissions = {
  type: "array",
  maxItems: 32,
  uniqueItems: true,
  items: permission,
} as const;
const confirmation = {
  type: "string",
  enum: Object.values(HomerailPluginConfirmation),
} as const;
const effect = { type: "string", enum: Object.values(HomerailPluginEffect) } as const;
const surface = { type: "string", enum: Object.values(GenerativeUiSurface) } as const;

const handlerSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "projection" },
        file: packagePath,
      },
      required: ["type", "file"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "runtime" },
        method: localId,
      },
      required: ["type", "method"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "builtin" },
        id: localId,
      },
      required: ["type", "id"],
      additionalProperties: false,
    },
  ],
} as const;

const compatibilitySchema = {
  type: "object",
  properties: {
    homerail: {
      type: "object",
      properties: {
        min: semver,
        max_exclusive: semver,
      },
      required: ["min", "max_exclusive"],
      additionalProperties: false,
    },
    plugin_api: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: "integer", minimum: 1 },
    },
    ui_ir: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: "integer", minimum: 1 },
    },
    renderer_api: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      items: { type: "integer", minimum: 1 },
    },
  },
  required: ["homerail", "plugin_api", "ui_ir", "renderer_api"],
  additionalProperties: false,
} as const;

const capabilitySchema = {
  type: "object",
  properties: {
    id: localId,
    summary: shortText,
    intents: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
    tags: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: localId,
    },
    modalities: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: { type: "string", enum: Object.values(HomerailPluginModality) },
    },
    required_inputs: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: localId,
    },
    skill: localId,
    tools: { type: "array", maxItems: 32, uniqueItems: true, items: toolId },
    workflows: { type: "array", maxItems: 32, uniqueItems: true, items: localId },
    actions: { type: "array", maxItems: 32, uniqueItems: true, items: localId },
  },
  required: [
    "id",
    "summary",
    "intents",
    "modalities",
    "required_inputs",
    "skill",
    "tools",
    "workflows",
    "actions",
  ],
  additionalProperties: false,
} as const;

const skillSchema = {
  type: "object",
  properties: {
    id: localId,
    path: packagePath,
    description: shortText,
  },
  required: ["id", "path", "description"],
  additionalProperties: false,
} as const;

const schemaRefSchema = {
  type: "object",
  properties: {
    id: localId,
    file: packagePath,
  },
  required: ["id", "file"],
  additionalProperties: false,
} as const;

const kindVersionSchema = {
  type: "object",
  properties: {
    version: { type: "integer", minimum: 1 },
    content_schema: localId,
    allowed_surfaces: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: surface,
    },
    default_surface: surface,
    default_variant: { type: "string", enum: Object.values(GenerativeUiDensity) },
    max_content_bytes: { type: "integer", minimum: 1, maximum: 131072 },
    preferred_visuals: {
      type: "array",
      maxItems: 16,
      uniqueItems: true,
      items: localId,
    },
    fallback: { const: "portable_required" },
    actions: { type: "array", maxItems: 32, uniqueItems: true, items: localId },
  },
  required: [
    "version",
    "content_schema",
    "allowed_surfaces",
    "default_surface",
    "default_variant",
    "max_content_bytes",
    "preferred_visuals",
    "fallback",
    "actions",
  ],
  additionalProperties: false,
} as const;

const kindSchema = {
  type: "object",
  properties: {
    kind: semanticKind,
    current_version: { type: "integer", minimum: 1 },
    versions: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: kindVersionSchema,
    },
    migrations: {
      type: "array",
      maxItems: 31,
      items: {
        type: "object",
        properties: {
          from: { type: "integer", minimum: 1 },
          to: { type: "integer", minimum: 2 },
          file: packagePath,
        },
        required: ["from", "to", "file"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "current_version", "versions", "migrations"],
  additionalProperties: false,
} as const;

const toolSchema = {
  type: "object",
  properties: {
    id: toolId,
    description: shortText,
    input_schema: localId,
    output_schema: localId,
    effect,
    permissions,
    confirmation,
    handler: handlerSchema,
  },
  required: [
    "id",
    "description",
    "input_schema",
    "effect",
    "permissions",
    "confirmation",
    "handler",
  ],
  additionalProperties: false,
} as const;

const workflowSchema = {
  type: "object",
  properties: {
    id: localId,
    uri: {
      type: "string",
      minLength: 12,
      maxLength: 400,
      pattern: "^plugin://[a-z0-9]+(?:[.-][a-z0-9]+)+/[A-Za-z0-9._/-]+$",
    },
    file: packagePath,
    effect,
    permissions,
    confirmation,
  },
  required: ["id", "uri", "file", "effect", "permissions", "confirmation"],
  additionalProperties: false,
} as const;

const rendererSourceSchema = {
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "builtin" }, id: localId },
      required: ["type", "id"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "declarative" }, file: packagePath },
      required: ["type", "file"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "custom" }, file: packagePath },
      required: ["type", "file"],
      additionalProperties: false,
    },
  ],
} as const;

const rendererFallbackSchema = {
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "portable" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "core_projection" }, file: packagePath },
      required: ["type", "file"],
      additionalProperties: false,
    },
  ],
} as const;

const rendererSchema = {
  type: "object",
  properties: {
    id: localId,
    kind: semanticKind,
    kind_version: { type: "integer", minimum: 1 },
    renderer_api: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: Object.values(HomerailPluginRendererMode) },
    surfaces: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: surface,
    },
    devices: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string", enum: Object.values(GenerativeUiDevice) },
    },
    source: rendererSourceSchema,
    fallback: rendererFallbackSchema,
  },
  required: [
    "id",
    "kind",
    "kind_version",
    "renderer_api",
    "mode",
    "surfaces",
    "devices",
    "source",
    "fallback",
  ],
  additionalProperties: false,
} as const;

const actionSchema = {
  type: "object",
  properties: {
    id: localId,
    intent: {
      type: "string",
      minLength: 3,
      maxLength: 200,
      pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+[.:][a-z][a-z0-9._-]*$",
    },
    input_schema: localId,
    effect,
    permissions,
    confirmation,
    handler: handlerSchema,
  },
  required: [
    "id",
    "intent",
    "input_schema",
    "effect",
    "permissions",
    "confirmation",
    "handler",
  ],
  additionalProperties: false,
} as const;

const permissionGrantSchema = {
  type: "object",
  properties: {
    permission,
    paths: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    hosts: {
      type: "array",
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
  },
  required: ["permission"],
  additionalProperties: false,
} as const;

const stateMigrationSchema = {
  type: "object",
  properties: {
    from: { type: "integer", minimum: 1 },
    to: { type: "integer", minimum: 2 },
    file: packagePath,
    effect,
    permissions,
    confirmation,
  },
  required: ["from", "to", "file", "effect", "permissions", "confirmation"],
  additionalProperties: false,
} as const;

export const homerailPluginManifestSchema = {
  $id: "homerail-plugin-manifest-v1",
  type: "object",
  properties: {
    manifest_version: { const: HOMERAIL_PLUGIN_MANIFEST_VERSION },
    id: pluginId,
    version: semver,
    name: { type: "string", minLength: 1, maxLength: 120 },
    publisher: {
      type: "object",
      properties: {
        id: pluginId,
        name: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
    license: { type: "string", minLength: 1, maxLength: 80 },
    compatibility: compatibilitySchema,
    capabilities: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: capabilitySchema,
    },
    skills: { type: "array", minItems: 1, maxItems: 64, items: skillSchema },
    schemas: { type: "array", minItems: 1, maxItems: 128, items: schemaRefSchema },
    kinds: { type: "array", maxItems: 64, items: kindSchema },
    tools: { type: "array", maxItems: 64, items: toolSchema },
    workflows: { type: "array", maxItems: 64, items: workflowSchema },
    renderers: { type: "array", maxItems: 128, items: rendererSchema },
    actions: { type: "array", maxItems: 128, items: actionSchema },
    runtime: {
      type: "object",
      properties: {
        trust: { type: "string", enum: Object.values(HomerailPluginRuntimeTrust) },
        plugin_api: { type: "integer", minimum: 1 },
        entrypoint: {
          type: "object",
          properties: {
            file: packagePath,
            args: {
              type: "array",
              maxItems: 32,
              items: { type: "string", maxLength: 500 },
            },
          },
          required: ["file", "args"],
          additionalProperties: false,
        },
      },
      required: ["trust", "plugin_api"],
      additionalProperties: false,
    },
    permissions: {
      type: "object",
      properties: {
        required: { type: "array", maxItems: 32, items: permissionGrantSchema },
        optional: { type: "array", maxItems: 32, items: permissionGrantSchema },
      },
      required: ["required", "optional"],
      additionalProperties: false,
    },
    state: {
      type: "object",
      properties: {
        schema_version: { type: "integer", minimum: 1 },
        migrations: { type: "array", maxItems: 63, items: stateMigrationSchema },
      },
      required: ["schema_version", "migrations"],
      additionalProperties: false,
    },
  },
  required: [
    "manifest_version",
    "id",
    "version",
    "name",
    "publisher",
    "license",
    "compatibility",
    "capabilities",
    "skills",
    "schemas",
    "kinds",
    "tools",
    "workflows",
    "renderers",
    "actions",
    "runtime",
    "permissions",
    "state",
  ],
  additionalProperties: false,
} as const;

export const homerailPluginSchemas: Record<string, Record<string, unknown>> = {
  "homerail-plugin-manifest-v1": homerailPluginManifestSchema as Record<string, unknown>,
};

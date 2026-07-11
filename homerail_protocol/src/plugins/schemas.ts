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
  GenerativeUiImportance,
  GenerativeUiPersistence,
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
    version: { type: "integer", minimum: 1, maximum: 32 },
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
    current_version: { type: "integer", minimum: 1, maximum: 32 },
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
          from: { type: "integer", minimum: 1, maximum: 31 },
          to: { type: "integer", minimum: 2, maximum: 32 },
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
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: 253,
        pattern: "^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$",
      },
    },
  },
  required: ["permission"],
  additionalProperties: false,
} as const;

const stateMigrationSchema = {
  type: "object",
  properties: {
    from: { type: "integer", minimum: 1, maximum: 63 },
    to: { type: "integer", minimum: 2, maximum: 64 },
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
        schema_version: { type: "integer", minimum: 1, maximum: 64 },
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

const sha256Digest = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
} as const;
const qualifiedId = {
  type: "string",
  minLength: 5,
  maxLength: 260,
  pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+:[a-z][a-z0-9._-]*$",
} as const;
const capabilityIds = {
  type: "array",
  maxItems: 64,
  uniqueItems: true,
  items: qualifiedId,
} as const;
const safeInteger = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

const resolvedHandlerSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "projection" },
        file: packagePath,
        digest: sha256Digest,
        document: { type: "object" },
      },
      required: ["type", "file", "digest", "document"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "runtime" }, method: localId },
      required: ["type", "method"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "builtin" }, id: localId },
      required: ["type", "id"],
      additionalProperties: false,
    },
  ],
} as const;

const skillDescriptorSchema = {
  type: "object",
  properties: {
    plugin_id: pluginId,
    plugin_version: semver,
    local_id: localId,
    qualified_id: qualifiedId,
    capability_ids: capabilityIds,
    description: shortText,
    digest: sha256Digest,
  },
  required: [
    "plugin_id", "plugin_version", "local_id", "qualified_id",
    "capability_ids", "description", "digest",
  ],
  additionalProperties: false,
} as const;

const toolDescriptorSchema = {
  type: "object",
  properties: {
    plugin_id: pluginId,
    plugin_version: semver,
    local_id: toolId,
    qualified_id: qualifiedId,
    wire_id: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
    },
    capability_ids: capabilityIds,
    // Turn Context descriptions include the stable qualified Tool identity in
    // addition to the manifest's bounded human description.
    description: { type: "string", minLength: 1, maxLength: 600 },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    effect,
    permissions,
    confirmation,
    handler: resolvedHandlerSchema,
  },
  required: [
    "plugin_id", "plugin_version", "local_id", "qualified_id", "wire_id",
    "capability_ids", "description", "input_schema", "effect", "permissions",
    "confirmation", "handler",
  ],
  additionalProperties: false,
} as const;

const actionDescriptorSchema = {
  type: "object",
  properties: {
    plugin_id: pluginId,
    plugin_version: semver,
    local_id: localId,
    qualified_id: qualifiedId,
    capability_ids: capabilityIds,
    intent: {
      type: "string",
      minLength: 3,
      maxLength: 200,
      pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)+[.:][a-z][a-z0-9._-]*$",
    },
  },
  required: ["plugin_id", "plugin_version", "local_id", "qualified_id", "capability_ids", "intent"],
  additionalProperties: false,
} as const;

const kindRegistrationSchema = {
  type: "object",
  properties: {
    plugin_id: pluginId,
    plugin_version: semver,
    manifest_digest: sha256Digest,
    enabled: { type: "boolean" },
    schema_id: localId,
    kind: semanticKind,
    kind_version: { type: "integer", minimum: 1, maximum: 32 },
    schema: { type: "object" },
    allowed_surfaces: {
      type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: surface,
    },
    max_payload_bytes: { type: "integer", minimum: 1, maximum: 131072 },
    fallback_required: { const: true },
    preferred_visuals: { type: "array", maxItems: 16, uniqueItems: true, items: localId },
    action_ids: { type: "array", maxItems: 32, uniqueItems: true, items: localId },
  },
  required: [
    "plugin_id", "plugin_version", "manifest_digest", "enabled", "schema_id",
    "kind", "kind_version", "schema", "allowed_surfaces", "max_payload_bytes",
    "fallback_required", "preferred_visuals", "action_ids",
  ],
  additionalProperties: false,
} as const;

const rendererRegistrationSchema = {
  type: "object",
  properties: {
    plugin_id: pluginId,
    plugin_version: semver,
    manifest_digest: sha256Digest,
    enabled: { type: "boolean" },
    renderer_id: localId,
    kind: semanticKind,
    kind_version: { type: "integer", minimum: 1, maximum: 32 },
    renderer_api: { type: "integer", minimum: 1, maximum: 64 },
    mode: { type: "string", enum: Object.values(HomerailPluginRendererMode) },
    surfaces: {
      type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: surface,
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
    "plugin_id", "plugin_version", "manifest_digest", "enabled", "renderer_id",
    "kind", "kind_version", "renderer_api", "mode", "surfaces", "devices",
    "source", "fallback",
  ],
  additionalProperties: false,
} as const;

export const homerailPluginTurnContextSchema = {
  $id: "homerail-plugin-turn-context-v1",
  type: "object",
  properties: {
    context_version: { const: 1 },
    registry_revision: safeInteger,
    enabled_plugins: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        properties: { id: pluginId, version: semver, manifest_digest: sha256Digest },
        required: ["id", "version", "manifest_digest"],
        additionalProperties: false,
      },
    },
    skills: { type: "array", maxItems: 1024, items: skillDescriptorSchema },
    tools: { type: "array", maxItems: 1024, items: toolDescriptorSchema },
    actions: { type: "array", maxItems: 2048, items: actionDescriptorSchema },
    permission_revision: safeInteger,
    context_digest: sha256Digest,
  },
  required: [
    "context_version", "registry_revision", "enabled_plugins", "skills", "tools",
    "actions", "permission_revision", "context_digest",
  ],
  additionalProperties: false,
} as const;

export const homerailPluginUiProjectionSchema = {
  $id: "homerail-plugin-ui-projection-v1",
  type: "object",
  properties: {
    registry_revision: safeInteger,
    registry_fingerprint: sha256Digest,
    kinds: { type: "array", maxItems: 2048, items: kindRegistrationSchema },
    renderers: { type: "array", maxItems: 4096, items: rendererRegistrationSchema },
    actions: { type: "array", maxItems: 2048, items: actionDescriptorSchema },
  },
  required: ["registry_revision", "registry_fingerprint", "kinds", "renderers", "actions"],
  additionalProperties: false,
} as const;

export const homerailResolvedPluginDescriptorSchema = {
  $id: "homerail-resolved-plugin-descriptor-v1",
  type: "object",
  properties: {
    descriptor_version: { const: 1 },
    manifest: { $ref: "homerail-plugin-manifest-v1" },
    manifest_digest: sha256Digest,
    package_digest: sha256Digest,
    schemas: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          id: localId,
          file: packagePath,
          digest: sha256Digest,
          schema: { type: "object" },
        },
        required: ["id", "file", "digest", "schema"],
        additionalProperties: false,
      },
    },
    skills: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        properties: {
          id: localId,
          path: packagePath,
          digest: sha256Digest,
          content: { type: "string", maxLength: 262144 },
        },
        required: ["id", "path", "digest", "content"],
        additionalProperties: false,
      },
    },
    referenced_files: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        properties: {
          path: packagePath,
          digest: sha256Digest,
          encoding: { const: "base64" },
          content: {
            type: "string",
            maxLength: 699052,
            pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          },
        },
        required: ["path", "digest", "encoding", "content"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "descriptor_version", "manifest", "manifest_digest", "package_digest",
    "schemas", "skills", "referenced_files",
  ],
  additionalProperties: false,
} as const;

const jsonPointer = {
  type: "string",
  maxLength: 500,
  pattern: "^(?:/(?:[^~/]|~[01])*)*$",
} as const;

const fallbackItemProjectionSchema = {
  type: "object",
  properties: {
    pointer: jsonPointer,
    mode: { type: "string", enum: ["scalar", "strings", "records"] },
    prefix: { type: "string", maxLength: 80 },
    title_pointer: jsonPointer,
    detail_pointer: jsonPointer,
    items_pointer: jsonPointer,
  },
  required: ["pointer", "mode"],
  additionalProperties: false,
} as const;

export const homerailDirectUiProjectionSchema = {
  $id: "homerail-direct-ui-projection-v1",
  type: "object",
  properties: {
    projection_version: { const: 1 },
    type: { const: "direct_ui_node" },
    kind: semanticKind,
    kind_version: { type: "integer", minimum: 1, maximum: 32 },
    node_id_pointer: jsonPointer,
    content_pointer: jsonPointer,
    omit_content_fields: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z_][A-Za-z0-9_-]*$" },
    },
    fallback: {
      type: "object",
      properties: {
        title_pointer: jsonPointer,
        summary_pointer: jsonPointer,
        items_pointer: jsonPointer,
        item_projections: {
          type: "array",
          maxItems: 16,
          items: fallbackItemProjectionSchema,
        },
      },
      required: ["title_pointer"],
      additionalProperties: false,
    },
    defaults: {
      type: "object",
      properties: {
        surface,
        importance: { type: "string", enum: Object.values(GenerativeUiImportance) },
        density: { type: "string", enum: Object.values(GenerativeUiDensity) },
        persistence: { type: "string", enum: Object.values(GenerativeUiPersistence) },
      },
      required: ["surface", "importance", "density", "persistence"],
      additionalProperties: false,
    },
    legacy_bridge: {
      type: "object",
      properties: {
        widget_type: localId,
        visual: localId,
      },
      required: ["widget_type", "visual"],
      additionalProperties: false,
    },
  },
  required: [
    "projection_version", "type", "kind", "kind_version", "node_id_pointer",
    "content_pointer", "omit_content_fields", "fallback", "defaults",
  ],
  additionalProperties: false,
} as const;

export const homerailPluginToolExecutionEnvelopeSchema = {
  $id: "homerail-plugin-tool-execution-envelope-v1",
  type: "object",
  properties: {
    execution_version: { const: 1 },
    status: { const: "projected" },
    committed: { const: false },
    plugin: {
      type: "object",
      properties: { id: pluginId, version: semver },
      required: ["id", "version"],
      additionalProperties: false,
    },
    tool: {
      type: "object",
      properties: {
        local_id: toolId,
        qualified_id: qualifiedId,
        wire_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
        },
        handler_digest: sha256Digest,
      },
      required: ["local_id", "qualified_id", "wire_id", "handler_digest"],
      additionalProperties: false,
    },
    arguments: { type: "object" },
    projection: {
      type: "object",
      properties: {
        projection_version: { const: 1 },
        node: { type: "object" },
        legacy_widget: { type: "object" },
      },
      required: ["projection_version", "node"],
      additionalProperties: false,
    },
  },
  required: ["execution_version", "status", "committed", "plugin", "tool", "arguments", "projection"],
  additionalProperties: false,
} as const;

export const homerailPluginSchemas: Record<string, Record<string, unknown>> = {
  "homerail-plugin-manifest-v1": homerailPluginManifestSchema as Record<string, unknown>,
  "homerail-plugin-turn-context-v1": homerailPluginTurnContextSchema as Record<string, unknown>,
  "homerail-plugin-ui-projection-v1": homerailPluginUiProjectionSchema as Record<string, unknown>,
  "homerail-resolved-plugin-descriptor-v1": homerailResolvedPluginDescriptorSchema as Record<string, unknown>,
  "homerail-direct-ui-projection-v1": homerailDirectUiProjectionSchema as Record<string, unknown>,
  "homerail-plugin-tool-execution-envelope-v1": homerailPluginToolExecutionEnvelopeSchema as Record<string, unknown>,
};

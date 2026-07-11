/**
 * HomeRail plugin package protocol.
 *
 * The manifest is intentionally declarative. It describes a vertical
 * capability slice without granting a package arbitrary Manager or UI code.
 * @version 0.1.0
 */

import type {
  GenerativeUiDevice,
  GenerativeUiDensity,
  GenerativeUiSurface,
  GenerativeUiNodeV1,
  GenerativeUiImportance,
  GenerativeUiPersistence,
} from "../generative-ui/types.js";

export const HOMERAIL_PLUGIN_MANIFEST_VERSION = 1 as const;
export type HomerailPluginManifestVersion = typeof HOMERAIL_PLUGIN_MANIFEST_VERSION;

export const HOMERAIL_PLUGIN_API_VERSION = 1 as const;
export const HOMERAIL_RENDERER_API_VERSION = 1 as const;

export const HomerailPluginModality = {
  VOICE: "voice",
  TEXT: "text",
  TOUCH: "touch",
  GAMEPAD: "gamepad",
  AUTOMATION: "automation",
} as const;
export type HomerailPluginModality =
  (typeof HomerailPluginModality)[keyof typeof HomerailPluginModality];

export const HomerailPluginEffect = {
  READ: "read",
  WRITE: "write",
  EXTERNAL: "external",
  DESTRUCTIVE: "destructive",
} as const;
export type HomerailPluginEffect =
  (typeof HomerailPluginEffect)[keyof typeof HomerailPluginEffect];

export const HomerailPluginConfirmation = {
  NEVER: "never",
  POLICY: "policy",
  ALWAYS: "always",
} as const;
export type HomerailPluginConfirmation =
  (typeof HomerailPluginConfirmation)[keyof typeof HomerailPluginConfirmation];

export const HomerailPluginRuntimeTrust = {
  DATA_ONLY: "data_only",
  SANDBOXED_RUNTIME: "sandboxed_runtime",
  TRUSTED_BUILTIN: "trusted_builtin",
} as const;
export type HomerailPluginRuntimeTrust =
  (typeof HomerailPluginRuntimeTrust)[keyof typeof HomerailPluginRuntimeTrust];

export const HomerailPluginHandlerType = {
  PROJECTION: "projection",
  RUNTIME: "runtime",
  BUILTIN: "builtin",
} as const;
export type HomerailPluginHandlerType =
  (typeof HomerailPluginHandlerType)[keyof typeof HomerailPluginHandlerType];

export const HomerailPluginRendererMode = {
  BUILTIN: "builtin",
  DECLARATIVE: "declarative",
  CUSTOM: "custom",
} as const;
export type HomerailPluginRendererMode =
  (typeof HomerailPluginRendererMode)[keyof typeof HomerailPluginRendererMode];

export const HomerailPluginPermission = {
  WORKSPACE_READ: "workspace.read",
  WORKSPACE_WRITE: "workspace.write",
  ARTIFACT_READ: "artifact.read",
  ARTIFACT_WRITE: "artifact.write",
  PLUGIN_DATA_READ: "plugin_data.read",
  PLUGIN_DATA_WRITE: "plugin_data.write",
  NETWORK_CONNECT: "network.connect",
  SECRET_USE: "secret.use",
  PROCESS_SPAWN: "process.spawn",
  GPU_USE: "gpu.use",
  DEVICE_CONTROL: "device.control",
  CAMERA_READ: "camera.read",
  MICROPHONE_READ: "microphone.read",
  NOTIFICATION_SEND: "notification.send",
} as const;
export type HomerailPluginPermission =
  (typeof HomerailPluginPermission)[keyof typeof HomerailPluginPermission];

export interface HomerailPluginCompatibilityV1 {
  homerail: {
    min: string;
    max_exclusive: string;
  };
  plugin_api: number[];
  ui_ir: number[];
  renderer_api: number[];
}

export interface HomerailPluginPublisherV1 {
  id: string;
  name: string;
}

export interface HomerailPluginCapabilityV1 {
  id: string;
  summary: string;
  intents: string[];
  tags?: string[];
  modalities: HomerailPluginModality[];
  required_inputs: string[];
  skill: string;
  tools: string[];
  workflows: string[];
  actions: string[];
}

export interface HomerailPluginSkillV1 {
  id: string;
  path: string;
  description: string;
}

export interface HomerailPluginSchemaV1 {
  id: string;
  file: string;
}

export interface HomerailPluginKindVersionV1 {
  version: number;
  content_schema: string;
  allowed_surfaces: GenerativeUiSurface[];
  default_surface: GenerativeUiSurface;
  default_variant: GenerativeUiDensity;
  max_content_bytes: number;
  preferred_visuals: string[];
  fallback: "portable_required";
  /** Manifest action ids that this kind version may expose. */
  actions: string[];
}

export interface HomerailPluginKindMigrationV1 {
  from: number;
  to: number;
  file: string;
}

export interface HomerailPluginKindV1 {
  kind: string;
  current_version: number;
  versions: HomerailPluginKindVersionV1[];
  migrations: HomerailPluginKindMigrationV1[];
}

export type HomerailPluginHandlerV1 =
  | { type: "projection"; file: string }
  | { type: "runtime"; method: string }
  | { type: "builtin"; id: string };

export type HomerailPluginResolvedHandlerV1 =
  | {
      type: "projection";
      file: string;
      digest: string;
      document: Record<string, unknown>;
    }
  | { type: "runtime"; method: string }
  | { type: "builtin"; id: string };

export interface HomerailPluginToolV1 {
  id: string;
  description: string;
  input_schema: string;
  output_schema?: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  confirmation: HomerailPluginConfirmation;
  handler: HomerailPluginHandlerV1;
}

export interface HomerailPluginWorkflowV1 {
  id: string;
  uri: string;
  file: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  confirmation: HomerailPluginConfirmation;
}

export interface HomerailPluginRendererV1 {
  id: string;
  kind: string;
  kind_version: number;
  renderer_api: number;
  mode: HomerailPluginRendererMode;
  surfaces: GenerativeUiSurface[];
  devices: GenerativeUiDevice[];
  source:
    | { type: "builtin"; id: string }
    | { type: "declarative"; file: string }
    | { type: "custom"; file: string };
  fallback:
    | { type: "portable" }
    | { type: "core_projection"; file: string };
}

export interface HomerailPluginActionV1 {
  id: string;
  intent: string;
  input_schema: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  confirmation: HomerailPluginConfirmation;
  handler: HomerailPluginHandlerV1;
}

export interface HomerailPluginPermissionGrantV1 {
  permission: HomerailPluginPermission;
  paths?: string[];
  hosts?: string[];
}

export interface HomerailPluginRuntimeV1 {
  trust: HomerailPluginRuntimeTrust;
  plugin_api: number;
  entrypoint?: {
    file: string;
    args: string[];
  };
}

export interface HomerailPluginStateMigrationV1 {
  from: number;
  to: number;
  file: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  confirmation: HomerailPluginConfirmation;
}

export interface HomerailPluginStateV1 {
  schema_version: number;
  migrations: HomerailPluginStateMigrationV1[];
}

export interface HomerailPluginManifestV1 {
  manifest_version: HomerailPluginManifestVersion;
  id: string;
  version: string;
  name: string;
  publisher: HomerailPluginPublisherV1;
  license: string;
  compatibility: HomerailPluginCompatibilityV1;
  capabilities: HomerailPluginCapabilityV1[];
  skills: HomerailPluginSkillV1[];
  schemas: HomerailPluginSchemaV1[];
  kinds: HomerailPluginKindV1[];
  tools: HomerailPluginToolV1[];
  workflows: HomerailPluginWorkflowV1[];
  renderers: HomerailPluginRendererV1[];
  actions: HomerailPluginActionV1[];
  runtime: HomerailPluginRuntimeV1;
  permissions: {
    required: HomerailPluginPermissionGrantV1[];
    optional: HomerailPluginPermissionGrantV1[];
  };
  state: HomerailPluginStateV1;
}

export interface HomerailDirectUiProjectionV1 {
  projection_version: 1;
  type: "direct_ui_node";
  kind: string;
  kind_version: number;
  /** RFC 6901 JSON Pointer into Tool arguments. */
  node_id_pointer: string;
  /** RFC 6901 JSON Pointer to an object copied into semantic content. */
  content_pointer: string;
  omit_content_fields: string[];
  fallback: {
    title_pointer: string;
    summary_pointer?: string;
    items_pointer?: string;
    item_projections?: HomerailDirectUiFallbackItemProjectionV1[];
  };
  defaults: {
    surface: GenerativeUiSurface;
    importance: GenerativeUiImportance;
    density: GenerativeUiDensity;
    persistence: GenerativeUiPersistence;
  };
  /** Explicit reversible bridge while the legacy Voice surface remains live. */
  legacy_bridge?: {
    widget_type: string;
    visual: string;
  };
}

export interface HomerailDirectUiFallbackItemProjectionV1 {
  pointer: string;
  mode: "scalar" | "strings" | "records";
  prefix?: string;
  title_pointer?: string;
  detail_pointer?: string;
  items_pointer?: string;
}

export interface HomerailDirectUiProjectionResultV1 {
  projection_version: 1;
  node: GenerativeUiNodeV1;
  legacy_widget?: Record<string, unknown>;
}

export interface HomerailPluginToolExecutionEnvelopeV1 {
  execution_version: 1;
  status: "projected";
  /** Projection is validated but not committed until Manager accepts it. */
  committed: false;
  plugin: { id: string; version: string };
  tool: { local_id: string; qualified_id: string; wire_id: string; handler_digest: string };
  /** Immutable validated input so Manager can deterministically replay the projection. */
  arguments: Record<string, unknown>;
  projection: HomerailDirectUiProjectionResultV1;
}

export interface HomerailPluginCompatibilityTargetV1 {
  homerail: string;
  plugin_api: number;
  ui_ir: number;
  renderer_api: number;
}

export interface HomerailPluginValidationError {
  path: string;
  message: string;
  keyword: string;
}

export interface HomerailPluginValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: HomerailPluginValidationError[];
}

/**
 * Pure-data registration used by Manager and Agent UI projections. Installed
 * schemas remain registered for history even when enabled is false.
 */
export interface HomerailPluginKindRegistrationV1 {
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  enabled: boolean;
  schema_id: string;
  kind: string;
  kind_version: number;
  schema: Record<string, unknown>;
  allowed_surfaces: GenerativeUiSurface[];
  max_payload_bytes: number;
  fallback_required: true;
  preferred_visuals: string[];
  action_ids: string[];
}

export interface HomerailPluginRendererRegistrationV1 {
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  enabled: boolean;
  renderer_id: string;
  kind: string;
  kind_version: number;
  renderer_api: number;
  mode: HomerailPluginRendererMode;
  surfaces: GenerativeUiSurface[];
  devices: GenerativeUiDevice[];
  source: HomerailPluginRendererV1["source"];
  fallback: HomerailPluginRendererV1["fallback"];
}

export interface HomerailPluginUiProjectionV1 {
  registry_revision: number;
  registry_fingerprint: string;
  kinds: HomerailPluginKindRegistrationV1[];
  renderers: HomerailPluginRendererRegistrationV1[];
  /** Enabled symbolic actions. Disabled historical nodes are read-only. */
  actions: HomerailPluginActionDescriptorV1[];
}

export interface HomerailPluginToolDescriptorV1 {
  plugin_id: string;
  plugin_version: string;
  local_id: string;
  qualified_id: string;
  /** Harness-safe deterministic name, limited to 64 ASCII characters. */
  wire_id: string;
  capability_ids: string[];
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  confirmation: HomerailPluginConfirmation;
  handler: HomerailPluginResolvedHandlerV1;
}

export interface HomerailPluginSkillDescriptorV1 {
  plugin_id: string;
  plugin_version: string;
  local_id: string;
  qualified_id: string;
  capability_ids: string[];
  description: string;
  digest: string;
}

export interface HomerailPluginActionDescriptorV1 {
  plugin_id: string;
  plugin_version: string;
  local_id: string;
  qualified_id: string;
  capability_ids: string[];
  intent: string;
}

export interface HomerailPluginTurnContextV1 {
  context_version: 1;
  registry_revision: number;
  enabled_plugins: Array<{
    id: string;
    version: string;
    manifest_digest: string;
  }>;
  skills: HomerailPluginSkillDescriptorV1[];
  tools: HomerailPluginToolDescriptorV1[];
  actions: HomerailPluginActionDescriptorV1[];
  /** Effective grant snapshot; M3 is zero until the Permission Broker lands. */
  permission_revision: number;
  context_digest: string;
}

export interface HomerailResolvedPluginSchemaV1 {
  id: string;
  file: string;
  digest: string;
  schema: Record<string, unknown>;
}

export interface HomerailResolvedPluginSkillV1 {
  id: string;
  path: string;
  digest: string;
  content: string;
}

/** Immutable archive unit. Historical validation never follows package paths. */
export interface HomerailResolvedPluginDescriptorV1 {
  descriptor_version: 1;
  manifest: HomerailPluginManifestV1;
  manifest_digest: string;
  package_digest: string;
  schemas: HomerailResolvedPluginSchemaV1[];
  skills: HomerailResolvedPluginSkillV1[];
  referenced_files: Array<{
    path: string;
    digest: string;
    encoding: "base64";
    /** Exact immutable package bytes, including declarative projectors/workflows. */
    content: string;
  }>;
}

/**
 * HomeRail plugin package protocol.
 *
 * The manifest is intentionally declarative. It describes a vertical
 * capability slice without granting a package arbitrary Manager or UI code.
 * @version 0.1.0
 */

import type {
  GenerativeUiCanvasSize,
  GenerativeUiDevice,
  GenerativeUiDensity,
  GenerativeUiSurface,
  GenerativeUiNodeV1,
  GenerativeUiTransactionV1,
  GenerativeUiDocumentScopeV1,
  GenerativeUiImportance,
  GenerativeUiMotionProfile,
  GenerativeUiPersistence,
  GenerativeUiActionStyle,
} from "../generative-ui/types.js";

export const HOMERAIL_PLUGIN_MANIFEST_VERSION = 1 as const;
export const HOMERAIL_PLUGIN_ID_PATTERN_SOURCE = "^[a-z0-9]+(?:[.-][a-z0-9]+)+$" as const;
export const HOMERAIL_PLUGIN_ID_PATTERN = new RegExp(HOMERAIL_PLUGIN_ID_PATTERN_SOURCE);

export function isHomerailPluginId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 160
    && HOMERAIL_PLUGIN_ID_PATTERN.test(value);
}
export type HomerailPluginManifestVersion = typeof HOMERAIL_PLUGIN_MANIFEST_VERSION;

export const HOMERAIL_PLUGIN_API_VERSION = 1 as const;
export const HOMERAIL_RENDERER_API_VERSION = 1 as const;
export const HOMERAIL_ACTION_BUS_VERSION = 1 as const;
export const HOMERAIL_TOOL_BUS_VERSION = 1 as const;
export const HOMERAIL_RUNTIME_RPC_VERSION = 1 as const;
/** Capability claims are deliberately short lived and single use. */
export const HOMERAIL_ACTION_CAPABILITY_MAX_TTL_MS = 5 * 60 * 1000;
export const HOMERAIL_ACTION_CONFIRMATION_MAX_TTL_MS = 10 * 60 * 1000;
export const HOMERAIL_ACTION_REQUEST_MAX_TTL_MS = 15 * 60 * 1000;
export const HOMERAIL_ACTION_ARGUMENT_MAX_BYTES = 32 * 1024;
export const HOMERAIL_RUNTIME_DOMAIN_OUTPUT_MAX_BYTES = 256 * 1024;
export const HOMERAIL_RUNTIME_LOG_MAX_ITEMS = 128;
export const HOMERAIL_RUNTIME_ARTIFACT_MAX_ITEMS = 32;

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
  /** Explicit callable surfaces; Action-only Tools never enter Agent catalogs. */
  exposure: Array<"agent" | "action">;
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

/**
 * Safe, expression-free Renderer DSL for data-only plugins. All JSON pointers
 * are evaluated relative to semantic node.content. HTML, CSS, scripts,
 * templates, network requests, and arbitrary component imports are absent by
 * construction.
 */
export interface HomerailDeclarativeRendererV1 {
  renderer_version: 1;
  type: "card";
  title_pointer: string;
  subtitle_pointer?: string;
  empty_message?: string;
  sections: HomerailDeclarativeRendererSectionV1[];
}

export type HomerailDeclarativeRendererSectionV1 =
  | {
      id: string;
      type: "text";
      label?: string;
      pointer: string;
      max_lines?: number;
    }
  | {
      id: string;
      type: "list";
      label?: string;
      pointer: string;
      item_title_pointer: string;
      item_detail_pointer?: string;
      item_badge_pointer?: string;
      max_items?: number;
    }
  | {
      id: string;
      type: "metrics";
      label?: string;
      items: Array<{
        label: string;
        pointer: string;
        format: "text" | "number" | "percent";
      }>;
    }
  | {
      id: string;
      type: "links";
      label?: string;
      pointer: string;
      item_label_pointer: string;
      item_uri_pointer: string;
      max_items?: number;
    };

export type HomerailPluginResolvedRendererSourceV1 =
  | { type: "builtin"; id: string }
  | {
      type: "declarative";
      file: string;
      digest: string;
      document: HomerailDeclarativeRendererV1;
    }
  | {
      /**
       * An immutable ES module fetched by exact package identity and executed
       * only inside the Agent UI's opaque-origin Renderer sandbox.
       */
      type: "custom";
      file: string;
      digest: string;
    };

export interface HomerailPluginActionV1 {
  id: string;
  intent: string;
  /** Same-plugin Tool that is the sole execution and policy authority. */
  tool: string;
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
  /** Optional RFC 6901 pointer to a direct A2UI surface copied outside semantic content. */
  a2ui_pointer?: string;
  /** Optional bounded presentation bindings; defaults remain authoritative when absent. */
  surface_pointer?: string;
  importance_pointer?: string;
  density_pointer?: string;
  canvas_size_pointer?: string;
  motion_profile_pointer?: string;
  persistence_pointer?: string;
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
    canvas_size?: GenerativeUiCanvasSize;
    motion_profile?: GenerativeUiMotionProfile;
    persistence: GenerativeUiPersistence;
  };
  /** Safe Action presentation/binding; execution policy remains Tool-owned. */
  actions?: Array<{
    id: string;
    label: string;
    style?: GenerativeUiActionStyle;
    /** RFC 6901 pointer to a Tool-input object snapshotted as fixed Action arguments. */
    arguments_pointer?: string;
  }>;
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

/**
 * Exact symbolic identity selected from a Generative UI document. Revisions
 * make an invocation stale as soon as either the document or node changes.
 */
export interface HomerailPluginActionTargetV1 {
  document_id: string;
  document_revision: number;
  node_id: string;
  node_revision: number;
  action_id: string;
  action_intent: string;
}

/** Immutable package and Turn Context snapshot resolved by Manager. */
export interface HomerailPluginToolBindingV1 {
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  package_digest: string;
  context_digest: string;
  registry_revision: number;
  permission_revision: number;
}

/**
 * Effective, version-scoped grant resolved by Manager for one Action.
 *
 * This is intentionally separate from the manifest declaration and persisted
 * grant status. It contains only the authority that will be conveyed to the
 * runtime. The grant list, and each paths/hosts list, use ascending canonical
 * order so the exact scope is stable across confirmation, capability and RPC
 * boundaries.
 */
export interface HomerailPluginEffectivePermissionGrantV1 {
  permission: HomerailPluginPermission;
  paths?: string[];
  hosts?: string[];
}

export interface HomerailPluginToolPolicyV1 {
  effect: HomerailPluginEffect;
  /** Canonically sorted exact permission set; capabilities may not widen it. */
  permissions: HomerailPluginPermission[];
  /** Canonically sorted effective authority, including path/host narrowing. */
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  confirmation: HomerailPluginConfirmation;
  /** Host policy resolution for the manifest's policy/always/never setting. */
  confirmation_required: boolean;
}

/**
 * Tool Bus V1 request. `request_digest` is the SHA-256 digest of
 * `homerailPluginToolInvocationDigestInput(value)` encoded canonically.
 * The digest therefore binds the exact effective path/host grants in policy.
 * Protocol defines that ABI but intentionally does not sign or issue it.
 */
export interface HomerailPluginToolInvocationV1 {
  tool_bus_version: 1;
  request_id: string;
  idempotency_key: string;
  request_digest: string;
  invoked_at: string;
  deadline_at: string;
  source:
    | {
      type: "ui_action";
      target: HomerailPluginActionTargetV1;
      action: {
        local_id: string;
        qualified_id: string;
      };
      /** Digest of user-supplied Action input before Manager-owned fixed arguments are merged. */
      input_digest: string;
    }
    | {
      type: "agent";
      call_id: string;
      modality: HomerailPluginModality;
      /** Manager-resolved scope and canonical commit target; callers never choose a document id. */
      scope: GenerativeUiDocumentScopeV1;
      target: {
        document_id: string;
        base_revision: number;
      };
    };
  tool: {
    local_id: string;
    qualified_id: string;
    wire_id: string;
    handler:
      | { type: "projection"; digest: string }
      | { type: "runtime"; method: string }
      | { type: "builtin"; id: string };
  };
  binding: HomerailPluginToolBindingV1;
  policy: HomerailPluginToolPolicyV1;
  arguments: Record<string, unknown>;
}

/** Short-lived, single-use bearer capability claims; signing is out of scope. */
export interface HomerailPluginToolCapabilityClaimsV1 {
  capability_version: 1;
  capability_id: string;
  audience: "homerail.plugin-runtime";
  scope: "plugin.tool.execute";
  nonce: string;
  single_use: true;
  request_id: string;
  request_digest: string;
  binding: HomerailPluginToolBindingV1;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  issued_at: string;
  expires_at: string;
}

export interface HomerailPluginToolConfirmationChallengeV1 {
  confirmation_version: 1;
  challenge_id: string;
  request_id: string;
  request_digest: string;
  effect: HomerailPluginEffect;
  permissions: HomerailPluginPermission[];
  effective_grants: HomerailPluginEffectivePermissionGrantV1[];
  message: string;
  issued_at: string;
  expires_at: string;
}

export interface HomerailPluginToolConfirmationDecisionV1 {
  confirmation_version: 1;
  challenge_id: string;
  request_id: string;
  request_digest: string;
  decision: "approved" | "denied";
  actor: { type: "user"; id: string };
  decided_at: string;
}

export interface HomerailPluginAuthorizedToolInvocationV1 {
  authorization_version: 1;
  invocation: HomerailPluginToolInvocationV1;
  capability: HomerailPluginToolCapabilityClaimsV1;
  confirmation?: {
    challenge: HomerailPluginToolConfirmationChallengeV1;
    decision: HomerailPluginToolConfirmationDecisionV1;
  };
}

export interface HomerailPluginRuntimeLogEntryV1 {
  sequence: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Passive artifact reference. Runtime RPC never transports artifact bytes. */
export interface HomerailPluginRuntimeArtifactV1 {
  id: string;
  label: string;
  uri: string;
  media_type?: string;
  digest?: string;
  size_bytes?: number;
}

/** Pure prepare-phase declaration; it contains no bytes or upload authority. */
export interface HomerailPluginRuntimeArtifactDeclarationV1 {
  id: string;
  label: string;
  media_type: "application/json" | "image/jpeg" | "image/png" | "image/webp";
  digest: string;
  size_bytes: number;
}

/** Manager-issued, single-use upload authority for one prepared declaration. */
export interface HomerailPluginRuntimeArtifactUploadV1 extends HomerailPluginRuntimeArtifactDeclarationV1 {
  capability_id: string;
  upload_url: string;
  token: string;
}

export interface HomerailPluginRuntimeRpcPrepareRequestV1 {
  runtime_rpc_version: 1;
  message_type: "request";
  method: "prepare";
  rpc_id: string;
  sent_at: string;
  params: { authorization: HomerailPluginAuthorizedToolInvocationV1 };
}

export interface HomerailPluginRuntimeRpcExecuteRequestV1 {
  runtime_rpc_version: 1;
  message_type: "request";
  method: "execute";
  rpc_id: string;
  sent_at: string;
  params: {
    authorization: HomerailPluginAuthorizedToolInvocationV1;
    /** Present only after a matching pure prepare result. */
    artifact_uploads?: HomerailPluginRuntimeArtifactUploadV1[];
  };
}

export interface HomerailPluginRuntimeRpcCancelRequestV1 {
  runtime_rpc_version: 1;
  message_type: "request";
  method: "cancel";
  rpc_id: string;
  sent_at: string;
  params: {
    request_id: string;
    request_digest: string;
    reason: "user" | "deadline" | "shutdown" | "superseded";
  };
}

export interface HomerailPluginRuntimeRpcHealthRequestV1 {
  runtime_rpc_version: 1;
  message_type: "request";
  method: "health";
  rpc_id: string;
  sent_at: string;
  params: { binding: HomerailPluginToolBindingV1 };
}

export interface HomerailPluginRuntimeRpcReconcileRequestV1 {
  runtime_rpc_version: 1;
  message_type: "request";
  method: "reconcile";
  rpc_id: string;
  sent_at: string;
  params: { request_id: string; request_digest: string };
}

export type HomerailPluginRuntimeRpcRequestV1 =
  | HomerailPluginRuntimeRpcPrepareRequestV1
  | HomerailPluginRuntimeRpcExecuteRequestV1
  | HomerailPluginRuntimeRpcCancelRequestV1
  | HomerailPluginRuntimeRpcHealthRequestV1
  | HomerailPluginRuntimeRpcReconcileRequestV1;

export type HomerailPluginRuntimeExecutionOutputV1 =
  | { type: "domain_output"; output: Record<string, unknown> }
  | { type: "ui_transaction"; transaction: GenerativeUiTransactionV1 };

export interface HomerailPluginRuntimeRpcPrepareResultV1 {
  runtime_rpc_version: 1;
  message_type: "result";
  method: "prepare";
  rpc_id: string;
  completed_at: string;
  request_id: string;
  request_digest: string;
  binding: HomerailPluginToolBindingV1;
  artifact_declarations: HomerailPluginRuntimeArtifactDeclarationV1[];
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: [];
}

export interface HomerailPluginRuntimeRpcExecuteResultV1 {
  runtime_rpc_version: 1;
  message_type: "result";
  method: "execute";
  rpc_id: string;
  completed_at: string;
  request_id: string;
  request_digest: string;
  binding: HomerailPluginToolBindingV1;
  output: HomerailPluginRuntimeExecutionOutputV1;
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: HomerailPluginRuntimeArtifactV1[];
}

export interface HomerailPluginRuntimeRpcCancelResultV1 {
  runtime_rpc_version: 1;
  message_type: "result";
  method: "cancel";
  rpc_id: string;
  completed_at: string;
  request_id: string;
  request_digest: string;
  status: "accepted" | "already_finished" | "not_found";
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: HomerailPluginRuntimeArtifactV1[];
}

export interface HomerailPluginRuntimeRpcHealthResultV1 {
  runtime_rpc_version: 1;
  message_type: "result";
  method: "health";
  rpc_id: string;
  completed_at: string;
  binding: HomerailPluginToolBindingV1;
  status: "ready" | "degraded" | "unhealthy";
  runtime_api: 1;
  started_at: string;
  active_requests: number;
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: HomerailPluginRuntimeArtifactV1[];
}

export interface HomerailPluginRuntimeRpcReconcileResultV1 {
  runtime_rpc_version: 1;
  message_type: "result";
  method: "reconcile";
  rpc_id: string;
  completed_at: string;
  request_id: string;
  request_digest: string;
  binding: HomerailPluginToolBindingV1;
  status: "completed" | "absent" | "running" | "failed";
  output_digest?: string;
  output?: HomerailPluginRuntimeExecutionOutputV1;
  error?: { code: string; message: string };
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: HomerailPluginRuntimeArtifactV1[];
}

export const HomerailPluginRuntimeRpcErrorCode = {
  INVALID_REQUEST: "invalid_request",
  UNAUTHORIZED: "unauthorized",
  PERMISSION_DENIED: "permission_denied",
  CONFIRMATION_REQUIRED: "confirmation_required",
  STALE_TARGET: "stale_target",
  IDEMPOTENCY_COLLISION: "idempotency_collision",
  DEADLINE_EXCEEDED: "deadline_exceeded",
  CANCELLED: "cancelled",
  RUNTIME_UNAVAILABLE: "runtime_unavailable",
  INTERNAL: "internal",
} as const;
export type HomerailPluginRuntimeRpcErrorCode =
  (typeof HomerailPluginRuntimeRpcErrorCode)[keyof typeof HomerailPluginRuntimeRpcErrorCode];

export interface HomerailPluginRuntimeRpcErrorV1 {
  runtime_rpc_version: 1;
  message_type: "error";
  method: "prepare" | "execute" | "cancel" | "health" | "reconcile";
  rpc_id: string;
  completed_at: string;
  request_id?: string;
  request_digest?: string;
  /** Required for health errors; forbidden for execute/cancel errors. */
    binding?: HomerailPluginToolBindingV1;
  error: {
    code: HomerailPluginRuntimeRpcErrorCode;
    message: string;
    retryable: boolean;
  };
  logs: HomerailPluginRuntimeLogEntryV1[];
  artifacts: HomerailPluginRuntimeArtifactV1[];
}

export type HomerailPluginRuntimeRpcResponseV1 =
  | HomerailPluginRuntimeRpcPrepareResultV1
  | HomerailPluginRuntimeRpcExecuteResultV1
  | HomerailPluginRuntimeRpcCancelResultV1
  | HomerailPluginRuntimeRpcHealthResultV1
  | HomerailPluginRuntimeRpcReconcileResultV1
  | HomerailPluginRuntimeRpcErrorV1;

/** Expected live state supplied by Manager for stale/tamper checks. */
export interface HomerailPluginToolValidationOptionsV1 {
  now_ms?: number;
  expected?: {
    source?: HomerailPluginToolInvocationV1["source"];
    tool?: HomerailPluginToolInvocationV1["tool"];
    binding: HomerailPluginToolBindingV1;
    /** Optional manifest/broker policy snapshot for direct escalation checks. */
    policy?: HomerailPluginToolPolicyV1;
    request_id?: string;
    request_digest?: string;
  };
  idempotency_records?: ReadonlyMap<string, {
    request_id: string;
    request_digest: string;
  }>;
  consumed_capability_nonces?: ReadonlySet<string>;
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
  source: HomerailPluginResolvedRendererSourceV1;
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

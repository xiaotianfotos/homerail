/**
 * Semantic Generative UI protocol types.
 * @version 0.1.0
 */

export const GENERATIVE_UI_IR_VERSION = 1 as const;
export type GenerativeUiIrVersion = typeof GENERATIVE_UI_IR_VERSION;

export const GenerativeUiSurface = {
  TASK: "task",
  EXECUTION: "execution",
  RESULT: "result",
  AMBIENT: "ambient",
} as const;
export type GenerativeUiSurface = (typeof GenerativeUiSurface)[keyof typeof GenerativeUiSurface];

export const GenerativeUiImportance = {
  CRITICAL: "critical",
  PRIMARY: "primary",
  SECONDARY: "secondary",
  AMBIENT: "ambient",
} as const;
export type GenerativeUiImportance = (typeof GenerativeUiImportance)[keyof typeof GenerativeUiImportance];

export const GenerativeUiPhase = {
  DRAFT: "draft",
  WAITING: "waiting",
  READY: "ready",
  RUNNING: "running",
  BLOCKED: "blocked",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type GenerativeUiPhase = (typeof GenerativeUiPhase)[keyof typeof GenerativeUiPhase];

export const GenerativeUiDensity = {
  GLANCE: "glance",
  SUMMARY: "summary",
  DETAIL: "detail",
} as const;
export type GenerativeUiDensity = (typeof GenerativeUiDensity)[keyof typeof GenerativeUiDensity];

export const GenerativeUiVisibility = {
  VISIBLE: "visible",
  MINIMIZED: "minimized",
  HIDDEN: "hidden",
} as const;
export type GenerativeUiVisibility = (typeof GenerativeUiVisibility)[keyof typeof GenerativeUiVisibility];

export const GenerativeUiPersistence = {
  TURN: "turn",
  SESSION: "session",
  PROJECT: "project",
} as const;
export type GenerativeUiPersistence = (typeof GenerativeUiPersistence)[keyof typeof GenerativeUiPersistence];

export const GenerativeUiDocumentScopeType = {
  VOICE_SESSION: "voice_session",
  PROJECT: "project",
  RUN: "run",
} as const;
export type GenerativeUiDocumentScopeType =
  (typeof GenerativeUiDocumentScopeType)[keyof typeof GenerativeUiDocumentScopeType];

export const GenerativeUiActorType = {
  AGENT: "agent",
  TOOL: "tool",
  PLUGIN: "plugin",
  USER: "user",
  SYSTEM: "system",
} as const;
export type GenerativeUiActorType = (typeof GenerativeUiActorType)[keyof typeof GenerativeUiActorType];

export const GenerativeUiActionStyle = {
  PRIMARY: "primary",
  SECONDARY: "secondary",
  DANGER: "danger",
} as const;
export type GenerativeUiActionStyle = (typeof GenerativeUiActionStyle)[keyof typeof GenerativeUiActionStyle];

export const GenerativeUiPatchUnsetField = {
  STATUS: "status",
  PRESENTATION: "presentation",
  LIFECYCLE: "lifecycle",
  ACTIONS: "actions",
  PROVENANCE: "provenance",
} as const;
export type GenerativeUiPatchUnsetField =
  (typeof GenerativeUiPatchUnsetField)[keyof typeof GenerativeUiPatchUnsetField];

export interface GenerativeUiPluginRef {
  /** Reverse-DNS plugin id, for example com.homerail.core. */
  id: string;
  version: string;
}

export interface GenerativeUiStatusV1 {
  phase: GenerativeUiPhase;
  label?: string;
  progress?: number;
}

export interface GenerativeUiPresentationHintV1 {
  /** Soft hints only. The host remains responsible for composition and layout. */
  density?: GenerativeUiDensity;
  preferred_visual?: string;
}

export interface GenerativeUiLifecycleV1 {
  persistence: GenerativeUiPersistence;
  default_visibility?: GenerativeUiVisibility;
  expires_at?: string;
  removable?: boolean;
}

export interface GenerativeUiArtifactRefV1 {
  label: string;
  uri: string;
  media_type?: string;
}

export interface GenerativeUiFallbackV1 {
  /** Required portable content used when a specialized renderer is unavailable. */
  title: string;
  summary?: string;
  items?: string[];
  artifact_refs?: GenerativeUiArtifactRefV1[];
}

export interface GenerativeUiActionV1 {
  id: string;
  label: string;
  /** Symbolic plugin-owned intent. Never executable code or a direct URL. */
  intent: string;
  arguments?: Record<string, unknown>;
  style?: GenerativeUiActionStyle;
  confirmation?: {
    required: boolean;
    message?: string;
  };
}

export interface GenerativeUiProvenanceV1 {
  actor: GenerativeUiActorType;
  actor_id?: string;
  plugin?: GenerativeUiPluginRef;
  skill_id?: string;
  turn_id?: string;
  run_id?: string;
}

export interface GenerativeUiNodeV1<
  TContent extends Record<string, unknown> = Record<string, unknown>,
> {
  ir_version: GenerativeUiIrVersion;
  id: string;
  /** Globally namespaced semantic kind, for example com.homerail.core/task_summary. */
  kind: string;
  /** Version of the plugin-owned content schema, independent of the IR version. */
  kind_version: number;
  owner: GenerativeUiPluginRef;
  surface: GenerativeUiSurface;
  importance: GenerativeUiImportance;
  status?: GenerativeUiStatusV1;
  content: TContent;
  presentation?: GenerativeUiPresentationHintV1;
  lifecycle?: GenerativeUiLifecycleV1;
  actions?: GenerativeUiActionV1[];
  fallback: GenerativeUiFallbackV1;
  provenance?: GenerativeUiProvenanceV1;
}

export interface GenerativeUiStoredNodeV1<
  TContent extends Record<string, unknown> = Record<string, unknown>,
> extends GenerativeUiNodeV1<TContent> {
  revision: number;
  updated_at: string;
}

export interface GenerativeUiDocumentScopeV1 {
  type: GenerativeUiDocumentScopeType;
  id: string;
}

export interface GenerativeUiDocumentV1 {
  ir_version: GenerativeUiIrVersion;
  document_id: string;
  scope: GenerativeUiDocumentScopeV1;
  revision: number;
  nodes: GenerativeUiStoredNodeV1[];
  updated_at: string;
}

export interface GenerativeUiNodePatchV1 {
  surface?: GenerativeUiSurface;
  importance?: GenerativeUiImportance;
  status?: GenerativeUiStatusV1;
  content?: Record<string, unknown>;
  presentation?: GenerativeUiPresentationHintV1;
  lifecycle?: GenerativeUiLifecycleV1;
  actions?: GenerativeUiActionV1[];
  fallback?: GenerativeUiFallbackV1;
  provenance?: GenerativeUiProvenanceV1;
  /** Explicitly removes optional fields; omitted fields otherwise remain unchanged. */
  unset?: GenerativeUiPatchUnsetField[];
}

export interface GenerativeUiPutOperationV1 {
  op: "put";
  node: GenerativeUiNodeV1;
}

export interface GenerativeUiPatchOperationV1 {
  op: "patch";
  node_id: string;
  if_revision?: number;
  changes: GenerativeUiNodePatchV1;
}

export interface GenerativeUiRemoveOperationV1 {
  op: "remove";
  node_id: string;
  if_revision?: number;
}

export type GenerativeUiOperationV1 =
  | GenerativeUiPutOperationV1
  | GenerativeUiPatchOperationV1
  | GenerativeUiRemoveOperationV1;

export interface GenerativeUiActorV1 {
  type: GenerativeUiActorType;
  id?: string;
  plugin?: GenerativeUiPluginRef;
  skill_id?: string;
  turn_id?: string;
}

export interface GenerativeUiTransactionV1 {
  ir_version: GenerativeUiIrVersion;
  transaction_id: string;
  document_id: string;
  base_revision: number;
  actor: GenerativeUiActorV1;
  operations: GenerativeUiOperationV1[];
  /** ISO timestamp supplied by the transaction producer for deterministic replay. */
  created_at: string;
}

export interface GenerativeUiValidationError {
  path: string;
  message: string;
  keyword: string;
}

export type GenerativeUiKindValidatorV1 = (
  node: GenerativeUiStoredNodeV1,
) => GenerativeUiValidationError[];

export interface GenerativeUiReducerContextV1 {
  /** Supplied by the transaction store, which owns the durable idempotency ledger. */
  transaction_already_applied: boolean;
  /** Required registry hook for plugin-owned kind/content validation. */
  validate_kind: GenerativeUiKindValidatorV1;
}

export type GenerativeUiTransactionStatus = "applied" | "duplicate" | "conflict" | "rejected";

export interface GenerativeUiTransactionResultV1 {
  status: GenerativeUiTransactionStatus;
  revision: number;
  document: GenerativeUiDocumentV1;
  errors?: GenerativeUiValidationError[];
}

export interface GenerativeUiUserOverrideV1 {
  document_id: string;
  node_id: string;
  visibility?: GenerativeUiVisibility;
  pinned?: boolean;
  preferred_surface?: GenerativeUiSurface;
  updated_at: string;
}

export interface GenerativeUiInteractionEventV1 {
  ir_version: GenerativeUiIrVersion;
  event_id: string;
  idempotency_key: string;
  document_id: string;
  node_id: string;
  node_revision: number;
  action_id: string;
  input?: Record<string, unknown>;
  created_at: string;
}

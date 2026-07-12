import type {
  GenerativeUiActionV1,
  GenerativeUiCompositionItemV1,
  GenerativeUiCompositionV1,
  GenerativeUiDocumentV1,
  GenerativeUiSurfaceContextV1,
  GenerativeUiTransactionV1,
  GenerativeUiUserOverrideV1,
  HomerailPluginToolConfirmationChallengeV1,
  HomerailPluginUiProjectionV1,
} from 'homerail-protocol'

export type GenerativeUiActionMode = 'emit' | 'manager' | 'disabled'

interface GenerativeUiProjectionBaseV1 {
  stream_version: 1
  document: GenerativeUiDocumentV1
  cursor: number
  overrides: GenerativeUiUserOverrideV1[]
  composition: GenerativeUiCompositionV1
  ui_registry: HomerailPluginUiProjectionV1
}

export interface GenerativeUiShadowProjectionV1 extends GenerativeUiProjectionBaseV1 {
  mode: 'shadow'
  authoritative: false
  purpose: 'legacy_widget_shadow'
}

export interface GenerativeUiCanonicalProjectionV1 extends GenerativeUiProjectionBaseV1 {
  mode: 'prefer'
  authoritative: true
  purpose: 'canonical'
  pending_tool_confirmations: PendingAgentToolConfirmationV1[]
}

export type GenerativeUiProjectionV1 =
  | GenerativeUiShadowProjectionV1
  | GenerativeUiCanonicalProjectionV1

interface GenerativeUiSnapshotStreamEventBaseV1 {
  type: 'generative_ui'
  event: 'snapshot'
  stream_version: 1
  document: GenerativeUiDocumentV1
  cursor: number
  overrides: GenerativeUiUserOverrideV1[]
  composition: GenerativeUiCompositionV1
  ui_registry: HomerailPluginUiProjectionV1
}

export type GenerativeUiSnapshotStreamEventV1 = GenerativeUiSnapshotStreamEventBaseV1 & (
  | {
      mode: 'shadow'
      authoritative: false
      purpose: 'legacy_widget_shadow'
    }
  | {
      mode: 'prefer'
      authoritative: true
      purpose: 'canonical'
      pending_tool_confirmations: PendingAgentToolConfirmationV1[]
    }
)

export interface GenerativeUiTransactionStreamEventV1 {
  type: 'generative_ui'
  event: 'transaction'
  stream_version: 1
  authoritative: false
  purpose: 'legacy_widget_shadow'
  seq: number
  document_id: string
  transaction_id: string
  committed_revision: number
  committed_at: string
  revision: number
  transaction: GenerativeUiTransactionV1
}

export type GenerativeUiStreamEventV1 =
  | GenerativeUiSnapshotStreamEventV1
  | GenerativeUiTransactionStreamEventV1

export interface GenerativeUiRendererPropsV1 {
  node: GenerativeUiDocumentV1['nodes'][number]
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
}

export interface GenerativeUiActionRequestV1 {
  document_id: string
  node_id: string
  node_revision: number
  action: GenerativeUiActionV1
}

export interface GenerativeUiPreviewRequestV1 {
  title?: string
  url: string
  kind?: 'html' | 'image' | 'gallery'
  layout?: 'fluid' | 'portrait'
  images?: string[]
}

export interface AgentToolReferenceV1 {
  local_id: string
  qualified_id: string
  wire_id: string
}

export type AgentToolStatusV1 =
  | 'needs_grant'
  | 'awaiting_confirmation'
  | 'authorized'
  | 'running'
  | 'committed'
  | 'denied'
  | 'failed'
  | 'cancelled'

export interface AgentToolResponseV1 {
  request_id: string
  request_digest: string
  status: AgentToolStatusV1
  idempotent: boolean
  tool: AgentToolReferenceV1
  source: 'agent'
  missing_permissions?: string[]
  denied_permissions?: string[]
  challenge?: HomerailPluginToolConfirmationChallengeV1
  result?: Record<string, unknown>
  error_code?: string
  error_message?: string
}

export interface PendingAgentToolConfirmationV1 extends AgentToolResponseV1 {
  status: 'awaiting_confirmation'
  idempotent: true
  challenge: HomerailPluginToolConfirmationChallengeV1
  missing_permissions?: never
  denied_permissions?: never
  result?: never
  error_code?: never
  error_message?: never
}

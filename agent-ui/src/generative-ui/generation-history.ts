import type { GenerativeUiStoredNodeV1 } from 'homerail-protocol'

export interface GenerativeUiInterventionSummary {
  operation: 'interrupt' | 'cancel' | 'retry' | 'reassign' | 'checkpoint_fork'
  status: 'queued' | 'applying' | 'applied' | 'failed'
  created_at: number
}

export interface GenerativeUiGenerationHistoryEntry {
  key: string
  node: GenerativeUiStoredNodeV1
  created_at: number
}

export interface GenerativeUiGenerationContext {
  superseded_count: number
  latest_intervention?: GenerativeUiInterventionSummary
  history: GenerativeUiGenerationHistoryEntry[]
  history_loading: boolean
  history_loaded: boolean
  history_error?: string
}

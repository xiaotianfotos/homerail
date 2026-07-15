import {
  validateGenerativeUiDocument,
  validateGenerativeUiStoredNode,
  type GenerativeUiDocumentV1,
  type GenerativeUiStoredNodeV1,
} from 'homerail-protocol'
import { http, type ApiResponse } from '@/api/clients/http-client'

export type DagLiveSurfaceActivityState =
  | 'started'
  | 'progress'
  | 'finding'
  | 'blocked'
  | 'completed'
  | 'failed'

export type DagLiveSurfaceVisibilityState = 'visible' | 'focused' | 'removed'

export type DagActorInterventionOperation =
  | 'interrupt'
  | 'cancel'
  | 'retry'
  | 'reassign'
  | 'checkpoint_fork'

export type DagActorInterventionStatus = 'queued' | 'applying' | 'applied' | 'failed'

export interface DagActorInterventionSummary {
  intervention_id: string
  run_id: string
  actor_id: string
  operation: DagActorInterventionOperation
  status: DagActorInterventionStatus
  instruction?: string
  created_at: number
  started_at?: number
  completed_at?: number
}

export interface DagLiveSurfaceState {
  actor_id: string
  surface_id: string
  generation_state: 'current'
  superseded_count: number
  latest_intervention?: DagActorInterventionSummary
}

export interface DagSurfaceGenerationSnapshot {
  run_id: string
  actor_id: string
  generation: number
  node_id: string
  surface_id: string
  document_id: string
  node_revision: number
  document_revision: number
  surface_revision: number
  activity_state: string
  visibility_state: string
  last_event_id?: string
  node_snapshot: GenerativeUiStoredNodeV1
  superseded_by_generation: number
  intervention_id: string
  created_at: number
}

export interface DagActorSurfaceHistory {
  run_id: string
  actor_id: string
  generation_state: 'superseded'
  history: DagSurfaceGenerationSnapshot[]
  total: number
}

export interface DagActorInterventionList {
  run_id: string
  actor_id: string
  interventions: DagActorInterventionSummary[]
  total: number
}

export interface DagLiveSurfaceProjectionRecord {
  run_id: string
  actor_id: string
  node_id: string
  surface_id: string
  document_id: string
  generation: number
  last_activity_sequence: number
  journal_cursor: number
  surface_revision: number
  activity_state: DagLiveSurfaceActivityState
  visibility_state: DagLiveSurfaceVisibilityState
  last_event_id?: string
  focused_until?: number
  created_at: number
  updated_at: number
}

export interface DagLiveSurfaceSnapshot {
  run_id: string
  projections: DagLiveSurfaceProjectionRecord[]
  surface_states?: DagLiveSurfaceState[]
  document: GenerativeUiDocumentV1 | null
}

const ACTIVITY_STATES = new Set<DagLiveSurfaceActivityState>([
  'started',
  'progress',
  'finding',
  'blocked',
  'completed',
  'failed',
])
const VISIBILITY_STATES = new Set<DagLiveSurfaceVisibilityState>(['visible', 'focused', 'removed'])
const INTERVENTION_OPERATIONS = new Set<DagActorInterventionOperation>([
  'interrupt',
  'cancel',
  'retry',
  'reassign',
  'checkpoint_fork',
])
const INTERVENTION_STATUSES = new Set<DagActorInterventionStatus>([
  'queued',
  'applying',
  'applied',
  'failed',
])

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid DAG live surface response: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid DAG live surface response: ${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label)
}

function literal<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  if (!allowed.has(value as T)) {
    throw new Error(`Invalid DAG live surface response: ${label} is invalid`)
  }
  return value as T
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid DAG live surface response: ${label} must be a non-negative safe integer`)
  }
  return Number(value)
}

function activityState(value: unknown): DagLiveSurfaceActivityState {
  if (!ACTIVITY_STATES.has(value as DagLiveSurfaceActivityState)) {
    throw new Error('Invalid DAG live surface response: activity_state is invalid')
  }
  return value as DagLiveSurfaceActivityState
}

function visibilityState(value: unknown): DagLiveSurfaceVisibilityState {
  if (!VISIBILITY_STATES.has(value as DagLiveSurfaceVisibilityState)) {
    throw new Error('Invalid DAG live surface response: visibility_state is invalid')
  }
  return value as DagLiveSurfaceVisibilityState
}

function normalizeProjection(value: unknown): DagLiveSurfaceProjectionRecord {
  const record = objectValue(value, 'projection')
  return {
    run_id: requiredString(record.run_id, 'run_id'),
    actor_id: requiredString(record.actor_id, 'actor_id'),
    node_id: requiredString(record.node_id, 'node_id'),
    surface_id: requiredString(record.surface_id, 'surface_id'),
    document_id: requiredString(record.document_id, 'document_id'),
    generation: safeInteger(record.generation, 'generation'),
    last_activity_sequence: safeInteger(record.last_activity_sequence, 'last_activity_sequence'),
    journal_cursor: safeInteger(record.journal_cursor, 'journal_cursor'),
    surface_revision: safeInteger(record.surface_revision, 'surface_revision'),
    activity_state: activityState(record.activity_state),
    visibility_state: visibilityState(record.visibility_state),
    ...(optionalString(record.last_event_id, 'last_event_id')
      ? { last_event_id: String(record.last_event_id) }
      : {}),
    ...(record.focused_until === undefined
      ? {}
      : { focused_until: safeInteger(record.focused_until, 'focused_until') }),
    created_at: safeInteger(record.created_at, 'created_at'),
    updated_at: safeInteger(record.updated_at, 'updated_at'),
  }
}

function normalizeIntervention(value: unknown): DagActorInterventionSummary {
  const record = objectValue(value, 'intervention')
  return {
    intervention_id: requiredString(record.intervention_id, 'intervention_id'),
    run_id: requiredString(record.run_id, 'run_id'),
    actor_id: requiredString(record.actor_id, 'actor_id'),
    operation: literal(record.operation, INTERVENTION_OPERATIONS, 'operation'),
    status: literal(record.status, INTERVENTION_STATUSES, 'status'),
    ...(optionalString(record.instruction, 'instruction') ? { instruction: String(record.instruction) } : {}),
    created_at: safeInteger(record.created_at, 'created_at'),
    ...(record.started_at === undefined ? {} : { started_at: safeInteger(record.started_at, 'started_at') }),
    ...(record.completed_at === undefined ? {} : { completed_at: safeInteger(record.completed_at, 'completed_at') }),
  }
}

function normalizeSurfaceState(value: unknown): DagLiveSurfaceState {
  const record = objectValue(value, 'surface_state')
  if (record.generation_state !== 'current') {
    throw new Error('Invalid DAG live surface response: generation_state must be current')
  }
  return {
    actor_id: requiredString(record.actor_id, 'actor_id'),
    surface_id: requiredString(record.surface_id, 'surface_id'),
    generation_state: 'current',
    superseded_count: safeInteger(record.superseded_count, 'superseded_count'),
    ...(record.latest_intervention === undefined
      ? {}
      : { latest_intervention: normalizeIntervention(record.latest_intervention) }),
  }
}

function normalizeGenerationSnapshot(value: unknown): DagSurfaceGenerationSnapshot {
  const record = objectValue(value, 'surface history entry')
  const validation = validateGenerativeUiStoredNode(record.node_snapshot)
  if (!validation.value || validation.errors.length) {
    throw new Error('Invalid DAG live surface response: historical node failed protocol validation')
  }
  return {
    run_id: requiredString(record.run_id, 'run_id'),
    actor_id: requiredString(record.actor_id, 'actor_id'),
    generation: safeInteger(record.generation, 'generation'),
    node_id: requiredString(record.node_id, 'node_id'),
    surface_id: requiredString(record.surface_id, 'surface_id'),
    document_id: requiredString(record.document_id, 'document_id'),
    node_revision: safeInteger(record.node_revision, 'node_revision'),
    document_revision: safeInteger(record.document_revision, 'document_revision'),
    surface_revision: safeInteger(record.surface_revision, 'surface_revision'),
    activity_state: requiredString(record.activity_state, 'activity_state'),
    visibility_state: requiredString(record.visibility_state, 'visibility_state'),
    ...(optionalString(record.last_event_id, 'last_event_id')
      ? { last_event_id: String(record.last_event_id) }
      : {}),
    node_snapshot: structuredClone(validation.value),
    superseded_by_generation: safeInteger(record.superseded_by_generation, 'superseded_by_generation'),
    intervention_id: requiredString(record.intervention_id, 'intervention_id'),
    created_at: safeInteger(record.created_at, 'created_at'),
  }
}

function projectedData(node: GenerativeUiDocumentV1['nodes'][number]): Record<string, unknown> {
  const content = objectValue(node.content, `node ${node.id} content`)
  return objectValue(content.data, `node ${node.id} content.data`)
}

function verifyProjectedNode(
  node: GenerativeUiDocumentV1['nodes'][number],
  projection: DagLiveSurfaceProjectionRecord,
): void {
  const data = projectedData(node)
  const projector = objectValue(data.projector, `node ${node.id} projector`)
  const actor = objectValue(data.actor, `node ${node.id} actor`)
  const state = objectValue(data.state, `node ${node.id} state`)
  if (
    node.id !== projection.surface_id
    || node.kind !== 'com.homerail.core/generated_view'
    || node.kind_version !== 2
    || node.owner.id !== 'com.homerail.core'
    || node.provenance?.run_id !== projection.run_id
    || node.provenance?.actor_id !== projection.actor_id
    || projector.id !== 'dag-live-surface-projector'
    || projector.version !== 1
    || actor.id !== projection.actor_id
    || actor.node_id !== projection.node_id
    || state.activity !== projection.activity_state
    || state.visibility !== projection.visibility_state
    || state.surface_revision !== projection.surface_revision
  ) {
    throw new Error(`Invalid DAG live surface response: node ${node.id} does not match its projection`)
  }
}

export function normalizeDagLiveSurfaceSnapshot(
  value: unknown,
  expectedRunId?: string,
): DagLiveSurfaceSnapshot {
  const record = objectValue(value, 'snapshot')
  const runId = requiredString(record.run_id, 'run_id')
  if (expectedRunId && runId !== expectedRunId) {
    throw new Error(`Invalid DAG live surface response: expected run ${expectedRunId}, received ${runId}`)
  }
  if (!Array.isArray(record.projections)) {
    throw new Error('Invalid DAG live surface response: projections must be an array')
  }
  const projections = record.projections.map(normalizeProjection)
  const actorIds = new Set<string>()
  const surfaceIds = new Set<string>()
  for (const projection of projections) {
    if (projection.run_id !== runId) {
      throw new Error('Invalid DAG live surface response: projection run_id mismatch')
    }
    if (actorIds.has(projection.actor_id) || surfaceIds.has(projection.surface_id)) {
      throw new Error('Invalid DAG live surface response: duplicate actor or surface projection')
    }
    actorIds.add(projection.actor_id)
    surfaceIds.add(projection.surface_id)
  }

  const surfaceStates = record.surface_states === undefined
    ? []
    : Array.isArray(record.surface_states)
      ? record.surface_states.map(normalizeSurfaceState)
      : (() => { throw new Error('Invalid DAG live surface response: surface_states must be an array') })()
  const stateActors = new Set<string>()
  const stateSurfaces = new Set<string>()
  for (const state of surfaceStates) {
    if (stateActors.has(state.actor_id) || stateSurfaces.has(state.surface_id)) {
      throw new Error('Invalid DAG live surface response: duplicate surface state')
    }
    const projection = projections.find(candidate => candidate.actor_id === state.actor_id)
    if (!projection || projection.surface_id !== state.surface_id) {
      throw new Error('Invalid DAG live surface response: surface state does not match a projection')
    }
    if (
      state.latest_intervention
      && (state.latest_intervention.run_id !== runId || state.latest_intervention.actor_id !== state.actor_id)
    ) {
      throw new Error('Invalid DAG live surface response: intervention identity mismatch')
    }
    stateActors.add(state.actor_id)
    stateSurfaces.add(state.surface_id)
  }

  let document: GenerativeUiDocumentV1 | null = null
  if (record.document === null) {
    if (projections.some(projection => projection.visibility_state !== 'removed')) {
      throw new Error('Invalid DAG live surface response: active projections require a document')
    }
  } else {
    const validation = validateGenerativeUiDocument(record.document)
    if (!validation.value || validation.errors.length) {
      throw new Error('Invalid DAG live surface response: document failed protocol validation')
    }
    document = structuredClone(validation.value)
    if (document.scope.type !== 'run' || document.scope.id !== runId) {
      throw new Error('Invalid DAG live surface response: document run scope mismatch')
    }
    const projectionBySurface = new Map(projections.map(projection => [projection.surface_id, projection]))
    const nodeIds = new Set(document.nodes.map(node => node.id))
    for (const node of document.nodes) {
      const projection = projectionBySurface.get(node.id)
      if (!projection || projection.visibility_state === 'removed') {
        throw new Error(`Invalid DAG live surface response: node ${node.id} has no active projection`)
      }
      if (projection.document_id !== document.document_id) {
        throw new Error('Invalid DAG live surface response: projection document_id mismatch')
      }
      verifyProjectedNode(node, projection)
    }
    for (const projection of projections) {
      if (projection.visibility_state === 'removed') continue
      if (projection.document_id !== document.document_id || !nodeIds.has(projection.surface_id)) {
        throw new Error(`Invalid DAG live surface response: active projection ${projection.surface_id} has no node`)
      }
    }
  }

  return { run_id: runId, projections, surface_states: surfaceStates, document }
}

export function normalizeDagActorSurfaceHistory(
  value: unknown,
  expectedRunId?: string,
  expectedActorId?: string,
): DagActorSurfaceHistory {
  const record = objectValue(value, 'surface history')
  const runId = requiredString(record.run_id, 'run_id')
  const actorId = requiredString(record.actor_id, 'actor_id')
  if (expectedRunId && runId !== expectedRunId) throw new Error('Invalid DAG surface history run identity')
  if (expectedActorId && actorId !== expectedActorId) throw new Error('Invalid DAG surface history Actor identity')
  if (record.generation_state !== 'superseded' || !Array.isArray(record.history)) {
    throw new Error('Invalid DAG live surface response: malformed surface history')
  }
  const history = record.history.map(normalizeGenerationSnapshot)
  for (const entry of history) {
    if (
      entry.run_id !== runId
      || entry.actor_id !== actorId
      || entry.node_snapshot.id !== entry.surface_id
      || entry.node_snapshot.revision !== entry.node_revision
    ) {
      throw new Error('Invalid DAG live surface response: historical node identity mismatch')
    }
  }
  const total = safeInteger(record.total, 'total')
  if (total < history.length) throw new Error('Invalid DAG live surface response: history total is invalid')
  return { run_id: runId, actor_id: actorId, generation_state: 'superseded', history, total }
}

export function normalizeDagActorInterventions(
  value: unknown,
  expectedRunId?: string,
  expectedActorId?: string,
): DagActorInterventionList {
  const record = objectValue(value, 'intervention list')
  const runId = requiredString(record.run_id, 'run_id')
  const actorId = requiredString(record.actor_id, 'actor_id')
  if (expectedRunId && runId !== expectedRunId) throw new Error('Invalid DAG intervention run identity')
  if (expectedActorId && actorId !== expectedActorId) throw new Error('Invalid DAG intervention Actor identity')
  if (!Array.isArray(record.interventions)) {
    throw new Error('Invalid DAG live surface response: interventions must be an array')
  }
  const interventions = record.interventions.map(normalizeIntervention)
  if (interventions.some(item => item.run_id !== runId || item.actor_id !== actorId)) {
    throw new Error('Invalid DAG live surface response: intervention identity mismatch')
  }
  const total = safeInteger(record.total, 'total')
  if (total < interventions.length) throw new Error('Invalid DAG live surface response: intervention total is invalid')
  return { run_id: runId, actor_id: actorId, interventions, total }
}

export async function getDagLiveSurfaces(
  runId: string,
): Promise<ApiResponse<DagLiveSurfaceSnapshot>> {
  const response = await http.get<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/live-surfaces`,
  )
  return {
    ...response,
    data: normalizeDagLiveSurfaceSnapshot(response.data, runId),
  }
}

export async function getDagActorSurfaceHistory(
  runId: string,
  actorId: string,
  limit = 20,
): Promise<ApiResponse<DagActorSurfaceHistory>> {
  const response = await http.get<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/actors/${encodeURIComponent(actorId)}/surface-history?limit=${limit}`,
  )
  return {
    ...response,
    data: normalizeDagActorSurfaceHistory(response.data, runId, actorId),
  }
}

export async function getDagActorInterventions(
  runId: string,
  actorId: string,
  limit = 20,
): Promise<ApiResponse<DagActorInterventionList>> {
  const response = await http.get<unknown>(
    `/api/runs/${encodeURIComponent(runId)}/actors/${encodeURIComponent(actorId)}/interventions?limit=${limit}`,
  )
  return {
    ...response,
    data: normalizeDagActorInterventions(response.data, runId, actorId),
  }
}

import { describe, expect, it } from 'vitest'
import { HOMERAIL_A2UI_CATALOG_ID } from 'homerail-protocol'
import { normalizeDagLiveSurfaceSnapshot } from './dag-live-surface-api'

function projectedNode(actorId: string, revision: number, activity = 'progress') {
  const surfaceId = `surface:${actorId}`
  return {
    ir_version: 1,
    id: surfaceId,
    kind: 'com.homerail.core/generated_view',
    kind_version: 2,
    owner: { id: 'com.homerail.core', version: '0.1.0' },
    surface: 'execution',
    importance: 'primary',
    status: { phase: 'running', label: 'In progress', progress: revision * 10 },
    content: {
      data: {
        projector: { id: 'dag-live-surface-projector', version: 1 },
        actor: { id: actorId, role: 'Worker', node_id: `node:${actorId}`, generation: 1 },
        title: `Worker ${actorId}`,
        state: {
          activity,
          visibility: 'visible',
          label: 'In progress',
          summary: 'Working',
          tone: 'info',
          progress: revision * 10,
          event_id: `event:${actorId}:${revision}`,
          round_id: 'round:1',
          sequence: revision,
          updated_at: 1_789_000_000_000 + revision,
          surface_revision: revision,
        },
        findings: [],
      },
    },
    a2ui: {
      version: 'v1.0',
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: 'root', component: 'Column', children: ['title'] },
        { id: 'title', component: 'Text', text: { path: '/data/title' } },
      ],
    },
    presentation: { density: 'summary' },
    lifecycle: { persistence: 'session', removable: true },
    fallback: { title: `Worker ${actorId}`, summary: 'Working' },
    provenance: { actor: 'agent', actor_id: actorId, run_id: 'run:one' },
    revision,
    updated_at: `2026-07-15T10:00:0${revision}.000Z`,
  }
}

function projection(actorId: string, revision: number) {
  return {
    run_id: 'run:one',
    actor_id: actorId,
    node_id: `node:${actorId}`,
    surface_id: `surface:${actorId}`,
    document_id: 'document:run:one',
    generation: 1,
    last_activity_sequence: revision,
    journal_cursor: revision,
    surface_revision: revision,
    activity_state: 'progress',
    visibility_state: 'visible',
    last_event_id: `event:${actorId}:${revision}`,
    created_at: 1_789_000_000_000,
    updated_at: 1_789_000_000_000 + revision,
  }
}

function snapshot() {
  const actors = ['build', 'research', 'verify']
  return {
    run_id: 'run:one',
    projections: actors.map((actor, index) => projection(actor, index + 1)),
    document: {
      ir_version: 1,
      document_id: 'document:run:one',
      scope: { type: 'run', id: 'run:one' },
      revision: 3,
      nodes: actors.map((actor, index) => projectedNode(actor, index + 1)),
      updated_at: '2026-07-15T10:00:03.000Z',
    },
  }
}

describe('DAG live surface API contract', () => {
  it('accepts the #41 projector snapshot and preserves actor order', () => {
    const normalized = normalizeDagLiveSurfaceSnapshot(snapshot(), 'run:one')
    expect(normalized.projections.map(item => item.actor_id)).toEqual(['build', 'research', 'verify'])
    expect(normalized.document?.nodes.map(node => node.id)).toEqual([
      'surface:build',
      'surface:research',
      'surface:verify',
    ])
  })

  it('rejects cross-run, duplicate, and forged projector identities', () => {
    const crossRun = snapshot()
    crossRun.projections[0]!.run_id = 'run:other'
    expect(() => normalizeDagLiveSurfaceSnapshot(crossRun, 'run:one')).toThrow('projection run_id mismatch')

    const duplicate = snapshot()
    duplicate.projections[1]!.actor_id = duplicate.projections[0]!.actor_id
    expect(() => normalizeDagLiveSurfaceSnapshot(duplicate)).toThrow('duplicate actor or surface')

    const forged = snapshot()
    forged.document.nodes[0]!.content.data.projector.id = 'another-projector'
    expect(() => normalizeDagLiveSurfaceSnapshot(forged)).toThrow('does not match its projection')
  })

  it('rejects state revisions that disagree with projector recovery metadata', () => {
    const value = snapshot()
    value.document.nodes[2]!.content.data.state.surface_revision = 99
    expect(() => normalizeDagLiveSurfaceSnapshot(value)).toThrow('does not match its projection')
  })

  it('rejects active projections without their recovered document node', () => {
    const missingNode = snapshot()
    missingNode.document.nodes.pop()
    expect(() => normalizeDagLiveSurfaceSnapshot(missingNode))
      .toThrow('active projection surface:verify has no node')

    const missingDocument = snapshot()
    missingDocument.document = null as unknown as ReturnType<typeof snapshot>['document']
    expect(() => normalizeDagLiveSurfaceSnapshot(missingDocument))
      .toThrow('active projections require a document')
  })
})

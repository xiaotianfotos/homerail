import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import {
  HOMERAIL_A2UI_CATALOG_ID,
  type GenerativeUiStoredNodeV1,
} from 'homerail-protocol'
import type {
  DagLiveSurfaceActivityState,
  DagLiveSurfaceSnapshot,
  DagLiveSurfaceVisibilityState,
} from '@/api/services/dag-live-surface-api'
import { dagTaskCanvasSelectionStorageKey } from '@/generative-ui/dag-task-canvas'
import { i18n } from '@/plugins/i18n'
import DagTaskCanvas from './DagTaskCanvas.vue'

const mocks = vi.hoisted(() => ({
  getDagLiveSurfaces: vi.fn(),
  getDagActorSurfaceHistory: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  onStateChange: vi.fn(() => () => undefined),
}))

vi.mock('@/api/agent', () => ({
  getDagActorSurfaceHistory: mocks.getDagActorSurfaceHistory,
  getDagLiveSurfaces: mocks.getDagLiveSurfaces,
}))

vi.mock('@/api/clients/events-ws', () => ({
  voiceWs: {
    on: mocks.onEvent,
    onStateChange: mocks.onStateChange,
  },
}))

function node(
  actorId: string,
  revision: number,
  activity: DagLiveSurfaceActivityState = 'progress',
  visibility: DagLiveSurfaceVisibilityState = 'visible',
): GenerativeUiStoredNodeV1 {
  const phase = activity === 'completed' ? 'succeeded' : activity === 'failed' ? 'failed' : 'running'
  return {
    ir_version: 1,
    id: `surface:${actorId}`,
    kind: 'com.homerail.core/generated_view',
    kind_version: 2,
    owner: { id: 'com.homerail.core', version: '0.1.0' },
    surface: 'execution',
    importance: visibility === 'focused' ? 'critical' : 'primary',
    status: { phase, label: activity, progress: activity === 'completed' ? 100 : revision * 10 },
    content: {
      data: {
        projector: { id: 'dag-live-surface-projector', version: 1 },
        actor: { id: actorId, role: 'Worker', node_id: `node:${actorId}`, generation: 1 },
        title: `Worker ${actorId}`,
        state: {
          activity,
          visibility,
          label: activity,
          summary: `Update ${revision}`,
          tone: activity === 'failed' ? 'critical' : 'info',
          progress: revision * 10,
          event_id: `event:${actorId}:${revision}`,
          round_id: 'round:1',
          sequence: revision,
          updated_at: 1_789_000_000_000 + revision,
          surface_revision: revision,
        },
        findings: Array.from({ length: revision }, (_, index) => ({
          id: `${actorId}:${index}`,
          title: `Finding ${index + 1}`,
        })),
      },
    },
    a2ui: {
      version: 'v1.0',
      catalogId: HOMERAIL_A2UI_CATALOG_ID,
      components: [
        { id: 'root', component: 'Column', children: ['header', 'summary', 'progress'] },
        { id: 'header', component: 'Row', children: ['title', 'status'], justify: 'spaceBetween' },
        { id: 'title', component: 'Text', text: { path: '/data/title' } },
        { id: 'status', component: 'HrStatusBadge', text: { path: '/data/state/label' }, tone: { path: '/data/state/tone' } },
        { id: 'summary', component: 'Text', text: { path: '/data/state/summary' } },
        { id: 'progress', component: 'HrProgress', value: { path: '/data/state/progress' }, tone: { path: '/data/state/tone' } },
      ],
    },
    presentation: { density: 'summary' },
    lifecycle: { persistence: 'session', removable: true },
    fallback: { title: `Worker ${actorId}`, summary: `Update ${revision}` },
    provenance: { actor: 'agent', actor_id: actorId, run_id: 'run:one' },
    revision,
    updated_at: `2026-07-15T10:00:0${revision}.000Z`,
  }
}

function snapshot(): DagLiveSurfaceSnapshot {
  const actors = ['build', 'research', 'verify']
  return {
    run_id: 'run:one',
    projections: actors.map((actorId, index) => ({
      run_id: 'run:one',
      actor_id: actorId,
      node_id: `node:${actorId}`,
      surface_id: `surface:${actorId}`,
      document_id: 'document:run:one',
      generation: 1,
      last_activity_sequence: index + 1,
      journal_cursor: index + 1,
      surface_revision: index + 1,
      activity_state: 'progress',
      visibility_state: 'visible',
      created_at: 1_789_000_000_000,
      updated_at: 1_789_000_000_000 + index,
    })),
    surface_states: actors.map(actorId => ({
      actor_id: actorId,
      surface_id: `surface:${actorId}`,
      generation_state: 'current' as const,
      superseded_count: 0,
    })),
    document: {
      ir_version: 1,
      document_id: 'document:run:one',
      scope: { type: 'run', id: 'run:one' },
      revision: 3,
      nodes: actors.map((actorId, index) => node(actorId, index + 1)),
      updated_at: '2026-07-15T10:00:03.000Z',
    },
  }
}

let app: App<Element> | null = null
let root: HTMLElement | null = null
let controls: { refresh: () => Promise<void> } | null = null

function mount(props: Record<string, unknown> = {}): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(DagTaskCanvas, {
    runId: 'run:one',
    autoRefresh: false,
    ...props,
  })
  app.use(i18n)
  controls = app.mount(root) as unknown as { refresh: () => Promise<void> }
  return root
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  controls = null
  mocks.getDagLiveSurfaces.mockReset()
  mocks.getDagActorSurfaceHistory.mockReset()
  mocks.onEvent.mockClear()
  mocks.onStateChange.mockClear()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DagTaskCanvas', () => {
  it('holds the final three-Block geometry while loading, then renders ordered 1x2 Workers', async () => {
    let resolveRequest!: (value: { success: true; data: DagLiveSurfaceSnapshot }) => void
    mocks.getDagLiveSurfaces.mockReturnValue(new Promise(resolve => { resolveRequest = resolve }))
    const mounted = mount()

    expect(mounted.querySelector('[data-state="loading"]')).toBeTruthy()
    expect(mounted.querySelectorAll('.dag-task-canvas__skeleton-block')).toHaveLength(3)

    resolveRequest({ success: true, data: snapshot() })
    await settle()
    const blocks = [...mounted.querySelectorAll<HTMLElement>('[data-generative-ui-node]')]
    expect(blocks.map(block => block.dataset.generativeUiNode)).toEqual([
      'surface:build',
      'surface:research',
      'surface:verify',
    ])
    expect(blocks.map(block => block.dataset.canvasSize)).toEqual(['1x2', '1x2', '1x2'])
    expect(mounted.querySelectorAll('.homerail-a2ui')).toHaveLength(3)
    expect(mounted.querySelector('.generative-ui-fallback--unavailable')).toBeNull()
    expect(mounted.querySelector('[data-state="ready"]')).toBeTruthy()
  })

  it('flattens into the Cockpit grid for one horizontal scroll layer and keeps all legal sizes', async () => {
    const sized = snapshot()
    sized.document!.nodes[0]!.presentation = { density: 'glance', canvas_size: '1x1' }
    sized.document!.nodes[1]!.presentation = { density: 'detail', canvas_size: '2x2' }
    sized.document!.nodes[2]!.presentation = { density: 'immersive', canvas_size: '3x3' }
    mocks.getDagLiveSurfaces.mockResolvedValue({ success: true, data: sized })

    const mounted = mount({ embedded: true })
    await settle()

    expect(mounted.querySelector('.dag-task-canvas--embedded')).toBeTruthy()
    expect(mounted.querySelector('.generative-ui-surface-host--embedded')).toBeTruthy()
    expect([...mounted.querySelectorAll<HTMLElement>('[data-generative-ui-node]')]
      .map(block => block.dataset.canvasSize)).toEqual(['1x1', '2x2', '3x3'])
  })

  it('restores selection and supports internal collapse plus touch-compatible fullscreen exit', async () => {
    sessionStorage.setItem(dagTaskCanvasSelectionStorageKey('run:one'), 'surface:build')
    mocks.getDagLiveSurfaces.mockResolvedValue({ success: true, data: snapshot() })
    const mounted = mount()
    await settle()

    const build = mounted.querySelector<HTMLElement>('[data-generative-ui-node="surface:build"]')!
    expect(build.classList.contains('generative-ui-node-host--selected')).toBe(true)

    build.querySelector<HTMLButtonElement>('.generative-ui-node-host__minimize')!.click()
    await nextTick()
    expect(build.dataset.collapsed).toBe('true')
    expect(build.querySelector('.generative-ui-node-host__minimal')?.textContent).toContain('Worker build')

    build.querySelector<HTMLButtonElement>('.generative-ui-node-host__minimize')!.click()
    build.querySelector<HTMLButtonElement>('.generative-ui-node-host__expand')!.click()
    await nextTick()
    expect(build.dataset.expanded).toBe('true')
    expect(document.body.classList.contains('generative-ui-node-expanded')).toBe(true)

    build.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(build.dataset.expanded).toBe('false')
    expect(document.body.classList.contains('generative-ui-node-expanded')).toBe(false)
  })

  it('shows compact intervention state and lazy read-only history only in expanded view', async () => {
    const current = snapshot()
    current.surface_states![0] = {
      ...current.surface_states![0]!,
      superseded_count: 1,
      latest_intervention: {
        intervention_id: 'intervention:retry',
        run_id: 'run:one',
        actor_id: 'build',
        operation: 'retry',
        status: 'applied',
        created_at: 1_789_000_000_500,
      },
    }
    mocks.getDagLiveSurfaces.mockResolvedValue({ success: true, data: current })
    mocks.getDagActorSurfaceHistory.mockResolvedValue({
      success: true,
      data: {
        run_id: 'run:one',
        actor_id: 'build',
        generation_state: 'superseded',
        history: [{
          run_id: 'run:one',
          actor_id: 'build',
          generation: 1,
          node_id: 'node:build',
          surface_id: 'surface:build',
          document_id: 'document:run:one',
          node_revision: 1,
          document_revision: 3,
          surface_revision: 1,
          activity_state: 'failed',
          visibility_state: 'visible',
          node_snapshot: node('build', 1, 'failed'),
          superseded_by_generation: 2,
          intervention_id: 'intervention:retry',
          created_at: 1_789_000_000_500,
        }],
        total: 1,
      },
    })

    const mounted = mount()
    await settle()
    const build = mounted.querySelector<HTMLElement>('[data-generative-ui-node="surface:build"]')!
    expect(build.querySelector('[data-generation-badge="current"]')?.textContent).toContain('Current')
    expect(build.querySelector('[data-generation-badge="superseded"]')?.textContent).toContain('Superseded 1')
    expect(build.querySelector('[data-generation-badge="intervention"]')?.textContent).toContain('Retry · Applied')
    expect(mounted.querySelector('[data-generation-history]')).toBeNull()

    build.querySelector<HTMLButtonElement>('.generative-ui-node-host__expand')!.click()
    await settle()
    expect(mocks.getDagActorSurfaceHistory).toHaveBeenCalledWith('run:one', 'build', 20)
    const tabs = mounted.querySelectorAll<HTMLButtonElement>('[data-generation-history] [role="tab"]')
    expect(tabs).toHaveLength(2)
    tabs[1]!.click()
    await nextTick()
    expect(build.dataset.generationState).toBe('superseded')
    expect(build.querySelector('.generative-ui-node-host__historical-banner')?.textContent)
      .toContain('Historical content is read-only')
    expect(build.textContent).not.toContain('node:build')
    expect(build.textContent).not.toContain('intervention:retry')

    build.querySelector<HTMLButtonElement>('.generative-ui-node-host__expand')!.click()
    await nextTick()
    expect(build.dataset.generationState).toBe('current')
  })

  it('reconciles update, complete, fail, and remove, then retains the last snapshot while stale', async () => {
    vi.useFakeTimers()
    const initial = snapshot()
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: initial })
    const mounted = mount()
    await settle()
    const unchangedResearchBlock = mounted.querySelector('[data-generative-ui-node="surface:research"]')
    const unchangedVerifyBlock = mounted.querySelector('[data-generative-ui-node="surface:verify"]')

    const updated = snapshot()
    updated.document!.revision = 4
    updated.document!.updated_at = '2026-07-15T10:00:04.000Z'
    updated.projections[0] = {
      ...updated.projections[0]!,
      surface_revision: 4,
      activity_state: 'progress',
      updated_at: 1_789_000_000_100,
    }
    updated.document!.nodes[0] = node('build', 4, 'progress')
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: updated })
    await controls!.refresh()
    await settle()
    expect(mounted.querySelector('[data-generative-ui-node="surface:research"]')).toBe(unchangedResearchBlock)
    expect(mounted.querySelector('[data-generative-ui-node="surface:verify"]')).toBe(unchangedVerifyBlock)
    expect(mounted.querySelector('[data-generative-ui-node="surface:research"]')
      ?.getAttribute('data-lifecycle-motion')).toBe('idle')
    expect(mounted.querySelector('[data-generative-ui-node="surface:build"]')?.getAttribute('data-lifecycle-motion'))
      .toBe('update')
    await vi.advanceTimersByTimeAsync(700)

    const completed = snapshot()
    completed.document!.revision = 5
    completed.document!.updated_at = '2026-07-15T10:00:05.000Z'
    completed.projections[0] = {
      ...completed.projections[0]!,
      surface_revision: 5,
      activity_state: 'completed',
      updated_at: 1_789_000_000_200,
    }
    completed.document!.nodes[0] = node('build', 5, 'completed')
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: completed })
    await controls!.refresh()
    await settle()
    expect(mounted.querySelector('[data-generative-ui-node="surface:build"]')?.getAttribute('data-lifecycle-motion'))
      .toBe('complete')
    await vi.advanceTimersByTimeAsync(1000)

    const failed = snapshot()
    failed.document!.revision = 6
    failed.document!.updated_at = '2026-07-15T10:00:06.000Z'
    failed.projections[0] = {
      ...failed.projections[0]!,
      surface_revision: 6,
      activity_state: 'failed',
      updated_at: 1_789_000_000_300,
    }
    failed.document!.nodes[0] = node('build', 6, 'failed')
    failed.projections[1] = { ...failed.projections[1]!, visibility_state: 'removed' }
    failed.document!.nodes = failed.document!.nodes.filter(candidate => candidate.id !== 'surface:research')
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: failed })
    await controls!.refresh()
    await settle()
    expect(mounted.querySelector('[data-generative-ui-node="surface:build"]')?.getAttribute('data-lifecycle-motion'))
      .toBe('fail')
    expect(mounted.querySelector('[data-generative-ui-node="surface:research"]')
      ?.classList.contains('generative-ui-node-leave-active')).toBe(true)
    await vi.advanceTimersByTimeAsync(350)
    await nextTick()
    expect(mounted.querySelector('[data-generative-ui-node="surface:research"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(650)
    expect(mounted.querySelectorAll('[data-generative-ui-node]')).toHaveLength(2)

    mocks.getDagLiveSurfaces.mockRejectedValueOnce(new Error('Manager restarting'))
    await controls!.refresh()
    await settle()
    expect(mounted.querySelector('[data-state="stale"]')).toBeTruthy()
    expect(mounted.querySelectorAll('[data-generative-ui-node]')).toHaveLength(2)

    const recovered = snapshot()
    recovered.document!.revision = 7
    recovered.document!.nodes[0] = node('build', 7, 'completed')
    recovered.projections[0] = {
      ...recovered.projections[0]!,
      surface_revision: 7,
      activity_state: 'completed',
      updated_at: 1_789_000_000_400,
    }
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: recovered })
    await controls!.refresh()
    await settle()
    expect(mounted.querySelector('[data-state="ready"]')).toBeTruthy()
    expect([...mounted.querySelectorAll<HTMLElement>('[data-generative-ui-node]')]
      .map(block => block.dataset.generativeUiNode)).toEqual([
        'surface:build',
        'surface:research',
        'surface:verify',
      ])
  })

  it('coalesces overlapping recovery signals into a serial refresh queue', async () => {
    mocks.getDagLiveSurfaces.mockResolvedValueOnce({ success: true, data: snapshot() })
    mount()
    await settle()

    const pending: Array<(value: { success: true; data: DagLiveSurfaceSnapshot }) => void> = []
    let activeRequests = 0
    let maxActiveRequests = 0
    mocks.getDagLiveSurfaces.mockImplementation(() => new Promise(resolve => {
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      pending.push(value => {
        activeRequests -= 1
        resolve(value)
      })
    }))

    const first = controls!.refresh()
    const second = controls!.refresh()
    const third = controls!.refresh()
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(pending).toHaveLength(1)

    pending.shift()!({ success: true, data: snapshot() })
    await settle()
    expect(pending).toHaveLength(1)
    pending.shift()!({ success: true, data: snapshot() })
    await Promise.all([first, second, third])
    expect(maxActiveRequests).toBe(1)
    expect(mocks.getDagLiveSurfaces).toHaveBeenCalledTimes(3)
  })

  it('disables transition motion when the browser requests reduced motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    mocks.getDagLiveSurfaces.mockResolvedValue({ success: true, data: snapshot() })
    const mounted = mount()
    await settle()

    expect(mounted.querySelector('.generative-ui-surface-host')
      ?.getAttribute('data-reduced-motion')).toBe('true')
  })
})

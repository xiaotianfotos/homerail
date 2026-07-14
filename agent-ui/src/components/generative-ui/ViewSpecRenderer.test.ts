import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import type { GenerativeUiCompositionItemV1, GenerativeUiStoredNodeV1, GenerativeUiSurfaceContextV1, HomerailViewSpecV1 } from 'homerail-protocol'
import { i18n } from '@/plugins/i18n'
import ViewSpecRenderer from './ViewSpecRenderer.vue'

let app: App<Element> | null = null
let root: HTMLElement | null = null
let requestedActions: string[] = []
let requestedPreviews: Array<{ title?: string; url: string; kind?: string; layout?: string }> = []

const placement: GenerativeUiCompositionItemV1 = {
  node_id: 'com.homerail.core:view-one', node_revision: 1, surface: 'result', variant: 'detail', rank: 1,
  placement: 'primary', pinned: false, visibility: 'visible',
}
const context: GenerativeUiSurfaceContextV1 = { device: 'desktop', input: 'mouse', viewport: 'wide', attention: 'focused' }

function node(view: HomerailViewSpecV1): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: placement.node_id,
    kind: 'com.homerail.core/generated_view',
    kind_version: 1,
    owner: { id: 'com.homerail.core', version: '0.1.0' },
    surface: 'result',
    importance: 'primary',
    content: {
      data: {
        title: 'Release readiness', passed: 3, progress: 72, markdown: '**Grounded** [unsafe](javascript:alert(1))',
        docs: 'https://example.com/evidence',
        checks: [{ id: 'ci', label: 'CI', detail: '583 passed', status: 'passed', value: 80, depends_on: [] }],
      },
    },
    view,
    actions: [{ id: 'inspect', label: 'Inspect', intent: 'inspect' }],
    fallback: { title: 'Release readiness' },
    revision: 1,
    updated_at: '2026-07-12T10:00:00.000Z',
  }
}

function mount(view: HomerailViewSpecV1, inputContext = context, expanded = false): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ViewSpecRenderer, {
    node: node(view), placement, context: inputContext, expanded,
    onRequestAction: (actionId: string) => requestedActions.push(actionId),
    onOpenPreview: (preview: { title?: string; url: string; kind?: string; layout?: string }) => requestedPreviews.push(preview),
  })
  app.use(i18n)
  app.mount(root)
  return root
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  requestedActions = []
  requestedPreviews = []
})

describe('ViewSpecRenderer', () => {
  it('renders a runtime-authored component tree without a scenario component', () => {
    const mounted = mount({
      view_version: 1,
      root: {
        id: 'root', type: 'stack', gap: 'md', children: [
          { id: 'title', type: 'heading', text: { path: '/data/title' }, level: 2 },
          { id: 'metric', type: 'metric', label: { literal: 'Passed' }, value: { path: '/data/passed', format: 'number' }, tone: 'positive' },
          { id: 'progress', type: 'progress', label: { literal: 'Progress' }, value: { path: '/data/progress', format: 'percent' }, tone: 'info' },
          { id: 'list', type: 'list', source: '/data/checks', item_title_path: '/label', item_detail_path: '/detail', item_status_path: '/status' },
          { id: 'timeline', type: 'timeline', source: '/data/checks', item_title_path: '/label', item_detail_path: '/detail', item_status_path: '/status' },
          { id: 'chart', type: 'bar_chart', source: '/data/checks', item_label_path: '/label', item_value_path: '/value', item_tone_path: '/status' },
          { id: 'dag', type: 'dag', source: '/data/checks', item_id_path: '/id', item_label_path: '/label', item_status_path: '/status', item_progress_path: '/value', item_depends_on_path: '/depends_on' },
        ],
      },
    })
    expect(mounted.textContent).toContain('Release readiness')
    expect(mounted.textContent).toContain('583 passed')
    expect(mounted.querySelector('.hr-view__metric')?.textContent).toContain('3')
    expect(mounted.querySelector('.hr-view__progress-track')?.getAttribute('aria-valuenow')).toBe('72')
    expect(mounted.querySelectorAll('.hr-view__list li')).toHaveLength(1)
    expect(mounted.querySelectorAll('.hr-view__timeline li')).toHaveLength(1)
    expect(mounted.querySelectorAll('.hr-view__bar_chart > div')).toHaveLength(1)
    expect(mounted.querySelectorAll('.hr-view__dag-node')).toHaveLength(1)
  })

  it('keeps markdown executable content inert and dispatches only symbolic actions', async () => {
    const mounted = mount({
      view_version: 1,
      root: {
        id: 'root', type: 'stack', children: [
          { id: 'markdown', type: 'markdown', text: { path: '/data/markdown' } },
          { id: 'inspect', type: 'action', action_id: 'inspect', label: { literal: 'Inspect' }, style: 'primary' },
        ],
      },
    })
    expect(mounted.querySelector('.hr-view__markdown strong')?.textContent).toBe('Grounded')
    expect(mounted.querySelector('.hr-view__markdown a')).toBeNull()
    mounted.querySelector<HTMLButtonElement>('.hr-view__action')?.click()
    await nextTick()
    expect(mounted.querySelector('.hr-view__action')?.textContent).toBe('Inspect')
    expect(requestedActions).toEqual(['inspect'])
  })

  it('renders the remaining bounded content and layout primitives from one generic tree', () => {
    const mounted = mount({
      view_version: 1,
      root: {
        id: 'root', type: 'stack', children: [
          { id: 'section', type: 'section', title: { literal: 'Evidence' }, children: [
            { id: 'icon', type: 'icon', name: 'shield', tone: 'positive' },
            { id: 'divider', type: 'divider' },
            { id: 'table', type: 'table', source: '/data/checks', columns: [
              { id: 'label', label: 'Check', path: '/label' },
              { id: 'status', label: 'Status', path: '/status', format: 'status' },
            ] },
            { id: 'repeat', type: 'repeat', source: '/data/checks', item: {
              id: 'repeat-label', type: 'text', text: { item_path: '/label' },
            } },
            { id: 'details', type: 'disclosure', title: { literal: 'References' }, open: true, children: [
              { id: 'docs', type: 'link', label: { literal: 'Open evidence' }, uri: { path: '/data/docs' } },
            ] },
          ] },
        ],
      },
    })
    expect(mounted.querySelector('.hr-view__section > header')?.textContent).toBe('Evidence')
    expect(mounted.querySelector('.hr-view__icon svg')).toBeTruthy()
    expect(mounted.querySelector('.hr-view__divider')).toBeTruthy()
    expect(mounted.querySelectorAll('.hr-view__table tbody tr')).toHaveLength(1)
    expect(mounted.querySelector('.hr-view__repeat')?.textContent).toContain('CI')
    expect(mounted.querySelector<HTMLDetailsElement>('.hr-view__disclosure')?.open).toBe(true)
    expect(mounted.querySelector<HTMLAnchorElement>('.hr-view__link')?.href).toBe('https://example.com/evidence')
  })

  it('marks compact grids and repeats so the renderer can balance odd two-column content', () => {
    const mounted = mount({
      view_version: 1,
      root: { id: 'root', type: 'stack', children: [
        { id: 'grid', type: 'grid', columns: { default: 3, compact: 2 }, children: [
          { id: 'one', type: 'text', text: { literal: 'One' } },
          { id: 'two', type: 'text', text: { literal: 'Two' } },
          { id: 'three', type: 'text', text: { literal: 'Three' } },
        ] },
        {
          id: 'repeat', type: 'repeat', source: '/data/checks', columns: { default: 3, compact: 2 }, gap: 'xs', item: {
            id: 'repeated-check', type: 'text', text: { item_path: '/label' },
          },
        },
      ] },
    }, { ...context, device: 'phone', viewport: 'compact', input: 'touch' })
    expect(mounted.querySelector('.homerail-view-spec')?.getAttribute('data-viewport')).toBe('compact')
    expect(mounted.querySelector<HTMLElement>('.hr-view__grid')?.style.getPropertyValue('--columns')).toBe('3')
    expect(mounted.querySelector<HTMLElement>('.hr-view__grid')?.style.getPropertyValue('--compact-columns')).toBe('2')
    expect(mounted.querySelector('.hr-view__grid')?.getAttribute('data-compact-columns')).toBe('2')
    expect(mounted.querySelectorAll('.hr-view__grid > .hr-view__node')).toHaveLength(3)
    expect(mounted.querySelector<HTMLElement>('.hr-view__repeat')?.style.getPropertyValue('--columns')).toBe('3')
    expect(mounted.querySelector<HTMLElement>('.hr-view__repeat')?.style.getPropertyValue('--compact-columns')).toBe('2')
    expect(mounted.querySelector('.hr-view__repeat')?.getAttribute('data-compact-columns')).toBe('2')
  })

  it('opens secondary disclosure content when the host expands the Block', () => {
    const mounted = mount({
      view_version: 1,
      root: { id: 'root', type: 'stack', children: [
        { id: 'summary', type: 'text', text: { literal: 'Minimum summary' } },
        { id: 'details', type: 'disclosure', title: { literal: 'Detailed evidence' }, children: [
          { id: 'evidence', type: 'text', text: { literal: 'Full evidence' } },
        ] },
      ] },
    }, context, true)

    expect(mounted.querySelector('.homerail-view-spec')?.getAttribute('data-expanded')).toBe('true')
    expect(mounted.querySelector<HTMLDetailsElement>('.hr-view__disclosure')?.open).toBe(true)
  })

  it('previews image and HTML artifacts through the generic ViewSpec node', async () => {
    const mounted = mount({
      view_version: 1,
      root: { id: 'root', type: 'grid', columns: { default: 2 }, children: [
        {
          id: 'cover', type: 'artifact', kind: 'image',
          uri: { literal: '/api/voice-agent/sessions/session-one/artifacts/cover.png' },
          title: { literal: 'AI cover' }, alt: { literal: 'AI cover preview' }, layout: 'portrait',
        },
        {
          id: 'page', type: 'artifact', kind: 'html',
          uri: { literal: '/api/voice-agent/sessions/session-one/artifacts/story.html' },
          title: { literal: 'Story page' }, description: { literal: 'Interactive draft' },
        },
      ] },
    })
    const image = mounted.querySelector<HTMLButtonElement>('button.hr-view__artifact')!
    const frame = mounted.querySelector<HTMLIFrameElement>('iframe')!
    const htmlButton = mounted.querySelector<HTMLButtonElement>('div.hr-view__artifact > button')!

    expect(image.querySelector('img')?.getAttribute('alt')).toBe('AI cover preview')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-pointer-lock allow-popups')
    image.click()
    htmlButton.click()
    await nextTick()
    expect(requestedPreviews).toEqual([
      expect.objectContaining({ title: 'AI cover', kind: 'image', layout: 'portrait' }),
      expect.objectContaining({ title: 'Story page', kind: 'html', layout: 'fluid' }),
    ])
  })
})

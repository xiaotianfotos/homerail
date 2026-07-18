import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import {
  HOMERAIL_A2UI_CATALOG_ID,
  type GenerativeUiCompositionItemV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiSurfaceContextV1,
  type HomerailA2uiSurfaceV1,
} from 'homerail-protocol'
import { i18n } from '@/plugins/i18n'
import rendererSource from './A2uiRenderer.vue?raw'
import hostSource from './GenerativeUiNodeHost.vue?raw'
import A2uiRenderer from './A2uiRenderer.vue'

let app: App<Element> | null = null
let root: HTMLElement | null = null
let requestedActions: string[] = []
let requestedPreviews: Array<{ title?: string; url: string; kind?: string; layout?: string }> = []

const placement: GenerativeUiCompositionItemV1 = {
  node_id: 'com.homerail.core:a2ui-one',
  node_revision: 1,
  surface: 'result',
  variant: 'detail',
  rank: 1,
  placement: 'primary',
  pinned: false,
  visibility: 'visible',
}
const context: GenerativeUiSurfaceContextV1 = {
  device: 'desktop', input: 'mouse', viewport: 'wide', attention: 'focused',
}

function node(a2ui: HomerailA2uiSurfaceV1, content: Record<string, unknown> = {}): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: placement.node_id,
    kind: 'com.homerail.core/generated_view',
    kind_version: 1,
    owner: { id: 'com.homerail.core', version: '0.1.0' },
    surface: 'result',
    importance: 'primary',
    content,
    a2ui,
    actions: [{ id: 'inspect', label: 'Inspect', intent: 'inspect' }],
    fallback: { title: 'A2UI view' },
    revision: 1,
    updated_at: '2026-07-12T10:00:00.000Z',
  }
}

function mount(
  a2ui: HomerailA2uiSurfaceV1,
  content: Record<string, unknown> = {},
  inputContext = context,
  expanded = false,
): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(A2uiRenderer, {
    node: node(a2ui, content),
    placement,
    context: inputContext,
    expanded,
    onRequestAction: (name: string) => requestedActions.push(name),
    onOpenPreview: (preview: { title?: string; url: string; kind?: string; layout?: string }) => requestedPreviews.push(preview),
  })
  app.use(i18n)
  app.mount(root)
  return root
}

function surface(components: HomerailA2uiSurfaceV1['components']): HomerailA2uiSurfaceV1 {
  return { version: 'v1.0', catalogId: HOMERAIL_A2UI_CATALOG_ID, components }
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  requestedActions = []
  requestedPreviews = []
})

describe('A2uiRenderer', () => {
  it('renders Text, absolute and relative bindings, template children, and @index', () => {
    const mounted = mount(surface([
      { id: 'root', component: 'Column', children: ['title', 'items'] },
      {
        id: 'title', component: 'Text', text: { path: '/title' },
        accessibility: { label: 'Release title', description: { path: '/titleDescription' } },
      },
      { id: 'items', component: 'List', children: { path: '/items', componentId: 'row' } },
      { id: 'row', component: 'Row', children: ['name', 'position'] },
      { id: 'name', component: 'Text', text: { path: 'name' } },
      { id: 'position', component: 'Text', text: { call: '@index', args: { offset: 1 } } },
    ]), {
      title: '**Release readiness** [unsafe](javascript:alert(1))',
      titleDescription: 'Current release status',
      items: [{ name: 'Manager' }, { name: 'Worker' }],
    })

    expect(mounted.querySelector('.hr-a2ui__text strong')?.textContent).toBe('Release readiness')
    expect(mounted.querySelector('[data-a2ui-id="title"]')?.getAttribute('aria-label')).toBe('Release title')
    expect(mounted.querySelector('[data-a2ui-id="title"]')?.getAttribute('aria-description')).toBe('Current release status')
    expect(mounted.querySelector('.hr-a2ui__text a')).toBeNull()
    expect(mounted.textContent).toContain('Manager')
    expect(mounted.textContent).toContain('Worker')
    expect([...mounted.querySelectorAll('[data-a2ui-id="position"]')].map(element => element.textContent?.trim())).toEqual(['1', '2'])
  })

  it('renders connected rich steps with template-relative content', () => {
    const mounted = mount(surface([
      { id: 'root', component: 'List', children: { path: '/steps', componentId: 'step' }, direction: 'vertical' },
      {
        id: 'step', component: 'HrStep', index: { call: '@index', args: { offset: 1 } },
        label: { path: 'label' }, detail: { path: 'result' }, tone: { path: 'tone' }, child: 'body',
      },
      { id: 'body', component: 'Text', text: { path: 'body' } },
    ]), {
      steps: [
        { label: 'First generation', result: 'Nightwing', tone: 'info', body: 'Parent A + helper' },
        { label: 'Second generation', result: 'Anubis', tone: 'positive', body: 'Child + helper' },
      ],
    })

    const steps = [...mounted.querySelectorAll<HTMLElement>('.hr-a2ui__step')]
    expect(steps).toHaveLength(2)
    expect(steps[0]?.querySelector('.hr-a2ui__step-rail')?.textContent).toBe('1')
    expect(steps[1]?.querySelector('.hr-a2ui__step-rail')?.textContent).toBe('2')
    expect(steps[1]?.querySelector('header')?.textContent).toContain('Anubis')
    expect(steps[1]?.dataset.tone).toBe('positive')
    expect(rendererSource).toContain('.hr-a2ui__step-rail::after')
  })

  it('applies the semantic palette to tone-bearing collection items', () => {
    const mounted = mount(surface([
      { id: 'root', component: 'HrBarChart', source: { path: '/channels' }, itemLabelPath: '/label', itemValuePath: '/value', itemTonePath: '/tone' },
    ]), {
      channels: [
        { label: 'Video', value: 82, tone: 'info' },
        { label: 'Article', value: 64, tone: 'positive' },
        { label: 'Post', value: 91, tone: 'warning' },
        { label: 'Live', value: 48, tone: 'critical' },
      ],
    })

    expect([...mounted.querySelectorAll<HTMLElement>('.hr-a2ui__bar-chart > div')].map(item => item.dataset.tone)).toEqual([
      'info', 'positive', 'warning', 'critical',
    ])
    expect(rendererSource).toContain(".homerail-a2ui [data-tone='info'] { --tone: #59b8ff; }")
    expect(rendererSource).toContain(".homerail-a2ui [data-tone='positive'] { --tone: #45d58a; }")
  })

  it('renders camelCase Metric, Table, DAG, and passive Artifact components', async () => {
    const mounted = mount(surface([
      { id: 'root', component: 'Column', children: ['metric', 'table', 'dag', 'source', 'remote', 'image', 'html'] },
      { id: 'metric', component: 'HrMetric', label: 'Passed', value: { path: '/passed' }, unit: 'checks', tone: 'positive' },
      {
        id: 'table', component: 'HrTable', source: { path: '/rows' },
        columns: [
          { id: 'name', label: 'Check', path: '/name' },
          { id: 'finished', label: 'Finished', path: '/finished', format: 'datetime' },
        ],
      },
      {
        id: 'dag', component: 'HrDag', source: { path: '/dag' },
        itemIdPath: '/id', itemLabelPath: '/label', itemDetailPath: '/detail',
        itemStatusPath: '/status', itemProgressPath: '/progress', itemDependsOnPath: '/dependsOn',
      },
      {
        id: 'source', component: 'HrLink', label: 'Source report',
        url: 'https://example.com/report', description: 'External evidence',
      },
      {
        id: 'remote', component: 'Image',
        url: 'https://paldb.cn/images/Pal/Texture/PalIcon/Normal/T_Anubis_icon_normal.webp',
        description: 'Anubis',
      },
      {
        id: 'image', component: 'HrArtifact', kind: 'image',
        uri: '/api/voice-agent/sessions/session-one/artifacts/cover.png',
        title: 'AI cover', alt: 'AI cover preview', layout: 'portrait',
      },
      {
        id: 'html', component: 'HrArtifact', kind: 'html',
        uri: '/api/voice-agent/sessions/session-one/artifacts/by-id/story/preview?revision=2',
        title: 'Story page', description: 'Interactive draft',
      },
    ]), {
      passed: 3,
      rows: [{ name: 'CI', finished: '2026-07-14T08:00:00.000Z' }],
      dag: [
        { id: 'build', label: 'Build', detail: 'Compiled', status: 'passed', progress: 100, dependsOn: [] },
        { id: 'ship', label: 'Ship', detail: 'Queued', status: 'running', progress: 40, dependsOn: ['build'] },
      ],
    })

    expect(mounted.querySelector('.hr-a2ui__metric')?.textContent).toContain('3')
    expect(mounted.querySelectorAll('.hr-a2ui__table tbody tr')).toHaveLength(1)
    expect(mounted.querySelectorAll('.hr-a2ui__dag-node')).toHaveLength(2)
    const source = mounted.querySelector<HTMLAnchorElement>('.hr-a2ui__link')!
    const remoteImage = mounted.querySelector<HTMLImageElement>('[data-a2ui-id="remote"]')!
    const image = mounted.querySelector<HTMLImageElement>('.hr-a2ui__artifact img')!
    const frame = mounted.querySelector<HTMLIFrameElement>('.hr-a2ui__artifact iframe')!
    expect(remoteImage.alt).toBe('Anubis')
    expect(source.href).toBe('https://example.com/report')
    expect(source.target).toBe('_blank')
    expect(source.rel).toBe('noopener noreferrer')
    expect(source.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(remoteImage.hasAttribute('crossorigin')).toBe(false)
    expect(remoteImage.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image.alt).toBe('AI cover preview')
    expect(image.hasAttribute('crossorigin')).toBe(false)
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.getAttribute('allow')).toBe('')
    expect(frame.getAttribute('src')).toContain('/artifacts/by-id/story/preview?revision=2')

    mounted.querySelector<HTMLButtonElement>('button.hr-a2ui__artifact')?.click()
    mounted.querySelector<HTMLButtonElement>('div.hr-a2ui__artifact > button')?.click()
    await nextTick()
    expect(requestedPreviews).toEqual([
      expect.objectContaining({ title: 'AI cover', kind: 'image', layout: 'portrait' }),
      expect.objectContaining({ title: 'Story page', kind: 'html', layout: 'fluid' }),
    ])
  })

  it('renders passive Actor media, metrics, comparisons, timelines, and routes without active controls', () => {
    const actorMediaUrl = `/api/runs/run-actor-01/artifacts/actor-media-${'a'.repeat(64)}.webp/content`
    const mounted = mount(surface([
      { id: 'root', component: 'Column', children: ['image', 'video', 'metric', 'timeline', 'comparison', 'route'] },
      { id: 'image', component: 'Image', url: actorMediaUrl, description: 'Evidence image' },
      { id: 'video', component: 'Video', url: 'https://example.com/evidence.mp4' },
      { id: 'metric', component: 'HrMetric', label: 'Coverage', value: { path: '/coverage' }, unit: '%' },
      {
        id: 'timeline', component: 'HrTimeline', source: { path: '/events' },
        itemTitlePath: '/title', itemDetailPath: '/detail', itemTimePath: '/time',
      },
      {
        id: 'comparison', component: 'HrBarChart', source: { path: '/options' },
        itemLabelPath: '/label', itemValuePath: '/value',
      },
      {
        id: 'route', component: 'HrDag', source: { path: '/route' },
        itemIdPath: '/id', itemLabelPath: '/label', itemDependsOnPath: '/dependsOn',
      },
    ]), {
      coverage: 84,
      events: [{ title: 'Collected', detail: 'Media checked', time: '09:00' }],
      options: [{ label: 'A', value: 72 }, { label: 'B', value: 84 }],
      route: [
        { id: 'collect', label: 'Collect', dependsOn: [] },
        { id: 'verify', label: 'Verify', dependsOn: ['collect'] },
      ],
    })

    const actorImage = mounted.querySelector<HTMLImageElement>('[data-a2ui-id="image"]')
    expect(actorImage?.tagName).toBe('IMG')
    expect(actorImage?.getAttribute('src')).toBe(actorMediaUrl)
    expect(actorImage?.dataset.unavailable).toBeUndefined()

    expect(mounted.querySelector<HTMLImageElement>('[data-a2ui-id="image"]')?.alt).toBe('Evidence image')
    expect(mounted.querySelector<HTMLVideoElement>('[data-a2ui-id="video"]')?.controls).toBe(true)
    expect(mounted.querySelector('.hr-a2ui__metric')?.textContent).toContain('84')
    expect(mounted.querySelectorAll('.hr-a2ui__timeline > li')).toHaveLength(1)
    expect(mounted.querySelectorAll('.hr-a2ui__bar-chart > div')).toHaveLength(2)
    expect(mounted.querySelectorAll('.hr-a2ui__dag-node')).toHaveLength(2)
    expect(mounted.querySelector('form, input, .hr-a2ui__button')).toBeNull()
  })

  it('keeps the stable A2UI root, local tab state, and focus across node revisions', async () => {
    const a2ui = surface([
      {
        id: 'root', component: 'Tabs', tabs: [
          { title: 'Overview', child: 'overview' },
          { title: 'Details', child: 'details' },
        ],
      },
      { id: 'overview', component: 'Text', text: { path: '/overview' } },
      { id: 'details', component: 'Text', text: { path: '/details' } },
    ])
    const currentNode = ref(node(a2ui, { overview: 'Revision one', details: 'Initial details' }))
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp({
      setup: () => () => h(A2uiRenderer, {
        node: currentNode.value,
        placement,
        context,
      }),
    })
    app.use(i18n)
    app.mount(root)

    const stableRoot = root.querySelector<HTMLElement>('[data-a2ui-id="root"]')!
    const detailsTab = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!
    detailsTab.click()
    detailsTab.focus()
    await nextTick()
    expect(detailsTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(detailsTab)

    currentNode.value = {
      ...node(a2ui, { overview: 'Revision two', details: 'Updated details' }),
      revision: 2,
      updated_at: '2026-07-12T10:00:01.000Z',
    }
    await nextTick()
    await nextTick()

    expect(root.querySelector('[data-a2ui-id="root"]')).toBe(stableRoot)
    expect(root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]).toBe(detailsTab)
    expect(detailsTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(detailsTab)
    expect(root.querySelector('.hr-a2ui__tab-panel')?.textContent).toContain('Updated details')
  })

  it('refreshes an interactive Artifact in place when its revision URL changes', async () => {
    const artifact = (revision: number) => surface([
      { id: 'root', component: 'Column', children: ['preview'] },
      {
        id: 'preview', component: 'HrArtifact', kind: 'html', title: 'Live preview',
        uri: `/api/voice-agent/sessions/session-one/artifacts/by-id/live-preview/preview?revision=${revision}`,
      },
    ])
    const currentNode = ref(node(artifact(1)))
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp({
      setup: () => () => h(A2uiRenderer, { node: currentNode.value, placement, context }),
    })
    app.use(i18n)
    app.mount(root)

    const frame = root.querySelector<HTMLIFrameElement>('[data-a2ui-id="preview"] iframe')!
    currentNode.value = {
      ...node(artifact(2)),
      revision: 2,
      updated_at: '2026-07-12T10:00:01.000Z',
    }
    await nextTick()
    await nextTick()

    expect(root.querySelector('[data-a2ui-id="preview"] iframe')).toBe(frame)
    expect(frame.getAttribute('src')).toContain('preview?revision=2')
  })

  it('keeps invalid inputs editable, binds writable values, and disables failed actions', async () => {
    const mounted = mount(surface([
      { id: 'root', component: 'Column', children: ['name', 'mirror', 'literal', 'slider', 'blocked', 'check', 'choice', 'date'] },
      {
        id: 'name', component: 'TextField', label: 'Name', value: { path: '/form/name' }, placeholder: 'Enter name',
        checks: [{ condition: false, message: 'Name needs review' }],
      },
      { id: 'mirror', component: 'Text', text: { path: '/form/name' } },
      { id: 'literal', component: 'TextField', label: 'Read only', value: 'literal' },
      { id: 'slider', component: 'Slider', label: 'Score', value: { path: '/form/score' }, max: 10, steps: 2 },
      {
        id: 'blocked', component: 'Button', child: 'blocked-label', action: { event: { name: 'inspect' } },
        checks: [{ condition: false, message: 'Action unavailable' }],
      },
      { id: 'blocked-label', component: 'Text', text: 'Inspect' },
      { id: 'check', component: 'CheckBox', label: 'Ready', value: { path: '/form/ready' } },
      {
        id: 'choice', component: 'ChoicePicker', label: 'Mode', value: { path: '/form/modes' },
        options: [{ label: 'Fast', value: 'fast' }, { label: 'Safe', value: 'safe' }],
        displayStyle: 'chips', filterable: true,
      },
      { id: 'date', component: 'DateTimeInput', label: 'When', value: { path: '/form/when' }, enableDate: true },
    ]), { form: { name: 'Initial', score: 4, ready: false, modes: ['fast'], when: '2026-07-14' } })

    const nameInput = mounted.querySelector<HTMLInputElement>('[data-a2ui-id="name"] input')!
    expect(nameInput.placeholder).toBe('Enter name')
    expect(nameInput.disabled).toBe(false)
    expect(nameInput.getAttribute('aria-invalid')).toBe('true')
    nameInput.value = 'Updated'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(mounted.querySelector('[data-a2ui-id="mirror"]')?.textContent).toContain('Updated')
    expect(mounted.querySelector<HTMLInputElement>('[data-a2ui-id="literal"] input')?.disabled).toBe(true)
    expect(mounted.querySelector<HTMLInputElement>('[data-a2ui-id="slider"] input')?.step).toBe('5')
    expect(mounted.querySelector<HTMLButtonElement>('[data-a2ui-id="blocked"] > button')?.disabled).toBe(true)
    expect(mounted.querySelector('[data-a2ui-id="blocked"] [role="alert"]')?.textContent).toBe('Action unavailable')
    expect(mounted.querySelectorAll('[data-a2ui-id="choice"] .hr-a2ui__choice-options label')).toHaveLength(2)
    expect(mounted.querySelector<HTMLInputElement>('[data-a2ui-id="choice"] input[type="radio"]')?.checked).toBe(true)
    const filter = mounted.querySelector<HTMLInputElement>('[data-a2ui-id="choice"] input[type="search"]')!
    expect(filter.placeholder).toBe('')
    expect(filter.getAttribute('aria-label')).toBe('Mode')
    filter.value = 'safe'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(mounted.querySelectorAll('[data-a2ui-id="choice"] .hr-a2ui__choice-options label')).toHaveLength(1)
    mounted.querySelector<HTMLButtonElement>('[data-a2ui-id="blocked"] > button')?.click()
    expect(requestedActions).toEqual([])
  })

  it('marks compact mobile output, evaluates disclosure.open, and expands details with the host', () => {
    const mounted = mount(surface([
      { id: 'root', component: 'HrGrid', children: ['cell'], columns: { default: 3, compact: 3 } },
      { id: 'cell', component: 'HrGridItem', child: 'details', span: 2 },
      { id: 'details', component: 'HrDisclosure', title: 'Evidence', open: { path: '/open' }, children: ['text'] },
      { id: 'text', component: 'Text', text: 'Full evidence' },
    ]), { open: false }, {
      device: 'phone', input: 'touch', viewport: 'compact', attention: 'focused',
    }, true)

    expect(mounted.querySelector('.homerail-a2ui')?.getAttribute('data-device')).toBe('phone')
    expect(mounted.querySelector('.homerail-a2ui')?.getAttribute('data-viewport')).toBe('compact')
    expect(mounted.querySelector('.homerail-a2ui')?.getAttribute('data-expanded')).toBe('true')
    expect(mounted.querySelector('.hr-a2ui__grid')?.getAttribute('data-compact-columns')).toBe('3')
    expect(rendererSource).toContain(".hr-a2ui__grid[data-compact-columns='3'] .hr-a2ui__image[data-variant='smallFeature']")
    expect(mounted.querySelector<HTMLDetailsElement>('.hr-a2ui__disclosure')?.open).toBe(true)
  })

  it('keeps one host scroll owner and bounded internal overflow with reduced-motion fallbacks', () => {
    expect(rendererSource).toContain('overflow: visible;')
    expect(rendererSource).toContain('.hr-a2ui__table')
    expect(rendererSource).toContain('overflow-x: auto;')
    expect(rendererSource).toContain('overflow-y: visible;')
    expect(rendererSource).toContain('.hr-a2ui__dag-scroll')
    expect(rendererSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(hostSource).toContain('.generative-ui-node-host--expanded')
    expect(hostSource).toContain('overflow-x: hidden;')
    expect(hostSource).toContain('overflow-y: auto;')
  })
})

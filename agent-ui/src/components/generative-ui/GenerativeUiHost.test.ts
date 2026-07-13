import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiCompositionV1,
  GenerativeUiDocumentV1,
  GenerativeUiStoredNodeV1,
} from 'homerail-protocol'
import { i18n } from '@/plugins/i18n'
import { GenerativeUiActionRegistry } from '@/generative-ui/action-registry'
import { GenerativeUiRendererRegistry } from '@/generative-ui/renderer-registry'
import GenerativeUiNodeHost from './GenerativeUiNodeHost.vue'
import GenerativeUiSurfaceHost from './GenerativeUiSurfaceHost.vue'
import TopicOutlineRenderer from '@/plugins/builtin/topic-outline/TopicOutlineRenderer.vue'

const ExactRenderer = defineComponent({
  name: 'ExactRenderer',
  props: ['node'],
  render() {
    return h('div', { class: 'exact-renderer' }, this.node.fallback.title)
  },
})

const CrashingRenderer = defineComponent({
  name: 'CrashingRenderer',
  setup() {
    throw new Error('renderer exploded')
  },
})

function node(id = 'node-one', input: Partial<GenerativeUiStoredNodeV1> = {}): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id,
    kind: 'com.example.plugin/card',
    kind_version: 1,
    owner: { id: 'com.example.plugin', version: '1.0.0' },
    surface: 'task',
    importance: 'secondary',
    content: {},
    fallback: { title: `Fallback ${id}`, summary: 'Portable summary' },
    revision: 1,
    updated_at: '2026-07-11T19:00:00.000Z',
    ...input,
  }
}

function placement(nodeId = 'node-one', rank = 1): GenerativeUiCompositionItemV1 {
  return {
    node_id: nodeId,
    node_revision: 1,
    surface: 'task',
    variant: 'summary',
    rank,
    placement: 'primary',
    pinned: false,
    visibility: 'visible',
  }
}

const context = {
  device: 'desktop',
  input: 'mouse',
  viewport: 'wide',
  attention: 'focused',
} as const

function registry(component = ExactRenderer): GenerativeUiRendererRegistry {
  return new GenerativeUiRendererRegistry([{
    renderer_api_version: 1,
    plugin_id: 'com.example.plugin',
    plugin_version: '1.0.0',
    renderer_id: 'card-main',
    kind: 'com.example.plugin/card',
    kind_version: 1,
    surface: 'task',
    device: 'desktop',
    mode: 'specialized',
    component,
  }])
}

function actionRegistry(): GenerativeUiActionRegistry {
  return new GenerativeUiActionRegistry([{
    plugin_id: 'com.example.plugin',
    plugin_version: '1.0.0',
    local_id: 'approve',
    qualified_id: 'com.example.plugin:approve',
    capability_ids: [],
    intent: 'com.example.plugin.approve',
  }])
}

let app: App<Element> | null = null
let root: HTMLElement | null = null

function mount(component: Parameters<typeof createApp>[0], props: Record<string, unknown>): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(component, props)
  app.use(i18n)
  app.mount(root)
  return root
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  vi.useRealTimers()
})

describe('GenerativeUiNodeHost', () => {
  it('renders an exact registered component', () => {
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node(),
      placement: placement(),
      context,
      registry: registry(),
    })
    expect(mounted.querySelector('.exact-renderer')?.textContent).toBe('Fallback node-one')
    expect(mounted.querySelector('[data-renderer-resolution="specialized"]')).toBeTruthy()
  })

  it('renders a portable fallback for unknown versions', () => {
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node('node-one', { kind_version: 2 }),
      placement: placement(),
      context,
      registry: registry(),
    })
    expect(mounted.textContent).toContain('Fallback node-one')
    expect(mounted.querySelector('[data-renderer-resolution="fallback"]')).toBeTruthy()
  })

  it('contains renderer crashes and exposes the portable fallback', async () => {
    const onRendererError = vi.fn()
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node(),
      placement: placement(),
      context,
      registry: registry(CrashingRenderer),
      onRendererError,
    })
    await nextTick()
    expect(mounted.textContent).toContain('Fallback node-one')
    expect(mounted.textContent).toContain('renderer exploded')
    expect(onRendererError).toHaveBeenCalledWith({ node_id: 'node-one', message: 'renderer exploded' })
  })

  it('emits symbolic actions without invoking a Tool or URL', () => {
    const onAction = vi.fn()
    const candidate = node('node-one', {
      actions: [{ id: 'approve', label: 'Approve', intent: 'com.example.plugin.approve' }],
    })
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: candidate,
      placement: placement(),
      context,
      registry: registry(),
      actionRegistry: actionRegistry(),
      onAction,
    })
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()
    expect(onAction).toHaveBeenCalledWith({
      document_id: 'document-one',
      node_id: 'node-one',
      node_revision: 1,
      action: candidate.actions![0],
    })
  })

  it('suppresses every Action control in non-interactive shadow projection', () => {
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node('node-one', {
        actions: [{ id: 'approve', label: 'Approve', intent: 'com.example.plugin.approve' }],
      }),
      placement: placement(),
      context,
      registry: registry(),
      actionRegistry: actionRegistry(),
      interactive: false,
    })
    expect(mounted.querySelector('.generative-ui-node-host__actions')).toBeNull()
  })

  it('suppresses Actions that are absent from the enabled Manager projection', () => {
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node('node-one', {
        actions: [{ id: 'approve', label: 'Approve', intent: 'com.example.plugin.approve' }],
      }),
      placement: placement(),
      context,
      registry: registry(),
      actionRegistry: new GenerativeUiActionRegistry([]),
    })
    expect(mounted.querySelector('.generative-ui-node-host__actions')).toBeNull()
  })

  it('marks and emits the selected Block without changing its renderer', () => {
    const onSelect = vi.fn()
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node(),
      placement: placement(),
      context,
      registry: registry(),
      selected: true,
      onSelect,
    })
    const host = mounted.querySelector<HTMLElement>('[data-generative-ui-node]')!

    expect(host.classList.contains('generative-ui-node-host--selected')).toBe(true)
    expect(host.getAttribute('aria-selected')).toBe('true')
    host.click()
    expect(onSelect).toHaveBeenCalledWith({ node_id: 'node-one' })
    expect(mounted.querySelector('.exact-renderer')?.textContent).toBe('Fallback node-one')
  })

  it('renders canonical topic content without a legacy_widget envelope', () => {
    const mounted = mount(TopicOutlineRenderer, {
      node: node('topic-one', {
        kind: 'com.homerail.topic-outline/outline',
        owner: { id: 'com.homerail.topic-outline', version: '1.0.0' },
        content: {
          title: 'Plugin pipeline',
          brief: 'Design a repeatable plugin development path.',
          outline: [{ title: 'Manifest', status: 'ready', points: ['Declare the scene'] }],
        },
      }),
    })
    expect(mounted.textContent).toContain('Design a repeatable plugin development path.')
    expect(mounted.textContent).toContain('Manifest')
    expect(mounted.textContent).toContain('Declare the scene')
  })

  it('never turns an unsafe topic source URL into an executable link', () => {
    const mounted = mount(TopicOutlineRenderer, {
      node: node('topic-one', {
        kind: 'com.homerail.topic-outline/outline',
        owner: { id: 'com.homerail.topic-outline', version: '1.0.0' },
        content: {
          sources: [
            { title: 'Unsafe source', url: 'javascript:alert(document.domain)' },
            { title: 'Safe source', url: 'https://example.com/reference' },
          ],
        },
      }),
    })
    const links = [...mounted.querySelectorAll<HTMLAnchorElement>('.topic-outline-widget__sources a')]
    expect(links).toHaveLength(2)
    expect(links[0].textContent).toContain('Unsafe source')
    expect(links[0].hasAttribute('href')).toBe(false)
    expect(links[1].getAttribute('href')).toBe('https://example.com/reference')
    expect(links[1].getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('GenerativeUiSurfaceHost', () => {
  it('keeps keyboard and Gamepad-style focus navigation inside the composed order', () => {
    const nodes = [node('node-one'), node('node-two')]
    const documentValue: GenerativeUiDocumentV1 = {
      ir_version: 1,
      document_id: 'document-one',
      scope: { type: 'voice_session', id: 'session-one' },
      revision: 1,
      nodes,
      updated_at: '2026-07-11T19:00:00.000Z',
    }
    const compositionValue: GenerativeUiCompositionV1 = {
      composition_version: 1,
      document_id: 'document-one',
      document_revision: 1,
      context,
      items: [placement('node-one', 1), placement('node-two', 2)],
      hidden_node_ids: [],
    }
    const mounted = mount(GenerativeUiSurfaceHost, {
      document: documentValue,
      composition: compositionValue,
      registry: new GenerativeUiRendererRegistry([]),
    })
    const hosts = [...mounted.querySelectorAll<HTMLElement>('[data-generative-ui-node]')]
    expect(hosts).toHaveLength(2)
    hosts[0].focus()
    hosts[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(hosts[1])
    hosts[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(hosts[0])
  })

  it('lays out independent Blocks on the 3-column canvas using only supported footprints', async () => {
    const nodes = [
      node('status', { presentation: { density: 'glance', canvas_size: '1x1' } }),
      node('checks', { presentation: { density: 'summary', canvas_size: '1x2' } }),
      node('graph', {
        presentation: { density: 'detail', canvas_size: '3x3' },
        updated_at: '2026-07-11T19:01:00.000Z',
      }),
    ]
    const documentValue: GenerativeUiDocumentV1 = {
      ir_version: 1,
      document_id: 'document-layout',
      scope: { type: 'voice_session', id: 'session-layout' },
      revision: 3,
      nodes,
      updated_at: '2026-07-11T19:01:00.000Z',
    }
    const compositionValue: GenerativeUiCompositionV1 = {
      composition_version: 1,
      document_id: 'document-layout',
      document_revision: 3,
      context,
      items: nodes.map((candidate, index) => placement(candidate.id, index + 1)),
      hidden_node_ids: [],
    }

    const mounted = mount(GenerativeUiSurfaceHost, {
      document: documentValue,
      composition: compositionValue,
      registry: new GenerativeUiRendererRegistry([]),
    })
    await nextTick()

    expect(mounted.querySelector('.generative-ui-surface-host')?.getAttribute('data-canvas-rows')).toBe('3')
    expect(mounted.querySelector('.generative-ui-surface-host')?.getAttribute('data-canvas-columns')).toBe('3')
    expect(mounted.querySelector('.generative-ui-surface-host')?.getAttribute('data-content-layout')).toBe('flow')
    expect([...mounted.querySelectorAll('[data-canvas-size]')].map(element => element.getAttribute('data-canvas-size')))
      .toEqual(['1x1', '1x2', '3x3'])
    expect(document.activeElement?.getAttribute('data-generative-ui-node')).toBe('graph')
  })

  it('applies the bounded motion profile and clears Manager attention after its deadline', async () => {
    vi.useFakeTimers()
    const nodes = [node('motion-card', {
      presentation: { density: 'summary', canvas_size: '1x2', motion_profile: 'standard' },
    })]
    const mounted = mount(GenerativeUiSurfaceHost, {
      document: {
        ir_version: 1,
        document_id: 'document-motion',
        scope: { type: 'voice_session', id: 'session-motion' },
        revision: 1,
        nodes,
        updated_at: '2026-07-11T19:00:00.000Z',
      } satisfies GenerativeUiDocumentV1,
      composition: {
        composition_version: 1,
        document_id: 'document-motion',
        document_revision: 1,
        context,
        items: [placement('motion-card', 1)],
        hidden_node_ids: [],
      } satisfies GenerativeUiCompositionV1,
      registry: new GenerativeUiRendererRegistry([]),
    })
    await nextTick()

    const host = mounted.querySelector<HTMLElement>('[data-generative-ui-node="motion-card"]')!
    expect(mounted.querySelector('.generative-ui-surface-host')?.getAttribute('data-content-layout')).toBe('single')
    expect(host.dataset.motionProfile).toBe('standard')
    expect(host.dataset.attention).toBe('true')
    expect(host.classList.contains('generative-ui-node-host--attention')).toBe(true)

    await vi.advanceTimersByTimeAsync(2400)
    await nextTick()
    expect(host.dataset.attention).toBe('false')
    expect(host.classList.contains('generative-ui-node-host--attention')).toBe(false)
  })

  it('expands one selected Block and restores it with Escape', async () => {
    const mounted = mount(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node: node(),
      placement: placement(),
      canvasSize: '2x2',
      context,
      registry: registry(),
    })
    const host = mounted.querySelector<HTMLElement>('[data-generative-ui-node]')!
    const toggle = mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__expand')!

    toggle.click()
    await nextTick()
    expect(host.dataset.expanded).toBe('true')
    expect(document.body.classList.contains('generative-ui-node-expanded')).toBe(true)

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(host.dataset.expanded).toBe('false')
    expect(document.body.classList.contains('generative-ui-node-expanded')).toBe(false)
  })
})

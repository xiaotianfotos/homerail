import { defineComponent, h, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { GenerativeUiStoredNodeV1, HomerailPluginUiProjectionV1 } from 'homerail-protocol'
import { legacyWidgetFromGenerativeUiNode } from './legacy-widget-adapter'
import { buildProjectedGenerativeUiRegistry } from './projected-registry'
import {
  GenerativeUiRendererRegistry,
  type GenerativeUiRendererRegistrationV1,
} from './renderer-registry'

const Core = defineComponent({ name: 'CoreProjection', render: () => h('div', 'core') })
const Specialized = defineComponent({ name: 'SpecializedRenderer', render: () => h('div', 'specialized') })

function node(input: Partial<GenerativeUiStoredNodeV1> = {}): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: 'registry-node',
    kind: 'com.example.plugin/card',
    kind_version: 1,
    owner: { id: 'com.example.plugin', version: '1.0.0' },
    surface: 'task',
    importance: 'secondary',
    content: {},
    fallback: { title: 'Portable card', summary: 'Readable without the plugin.' },
    revision: 1,
    updated_at: '2026-07-11T19:00:00.000Z',
    ...input,
  }
}

function registration(
  mode: GenerativeUiRendererRegistrationV1['mode'],
  component = Core,
): GenerativeUiRendererRegistrationV1 {
  return {
    renderer_api_version: 1,
    plugin_id: 'com.example.plugin',
    plugin_version: '1.0.0',
    renderer_id: 'card-main',
    kind: 'com.example.plugin/card',
    kind_version: 1,
    surface: 'task',
    device: 'desktop',
    mode,
    component,
  }
}

describe('GenerativeUiRendererRegistry', () => {
  it('resolves exact specialized renderer before an exact Core projection', () => {
    const registry = new GenerativeUiRendererRegistry([
      registration('core_projection'),
      registration('specialized', Specialized),
    ])
    expect(registry.resolve(node(), 'task', 'desktop')).toMatchObject({
      mode: 'specialized',
      component: Specialized,
    })
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.registrations)).toBe(true)
  })

  it('never fuzzily matches kind version, surface or device', () => {
    const registry = new GenerativeUiRendererRegistry([registration('specialized', Specialized)])
    expect(registry.resolve(node({ kind_version: 2 }), 'task', 'desktop').mode).toBe('fallback')
    expect(registry.resolve(node(), 'result', 'desktop').mode).toBe('fallback')
    expect(registry.resolve(node(), 'task', 'phone').mode).toBe('fallback')
    expect(registry.resolve(node({ owner: { id: 'com.example.plugin', version: '2.0.0' } }), 'task', 'desktop').mode)
      .toBe('fallback')
  })

  it('returns the portable fallback for unknown kinds and an explicit diagnostic for corrupt fallback', () => {
    const registry = new GenerativeUiRendererRegistry([])
    expect(registry.resolve(node({ kind: 'com.unknown.plugin/result' }), 'task', 'tv')).toEqual({
      mode: 'fallback',
      reason: 'renderer_not_registered',
    })
    expect(registry.resolve(node({ fallback: { title: '' } }), 'task', 'tv')).toEqual({
      mode: 'unavailable',
      reason: 'portable_fallback_invalid',
    })
  })

  it('rejects duplicate exact registrations within one trust tier', () => {
    expect(() => new GenerativeUiRendererRegistry([
      registration('specialized'),
      registration('specialized', Specialized),
    ])).toThrow('Duplicate specialized renderer')
  })

  it.each(['phone', 'desktop', 'tv'] as const)('projects the enabled topic-outline renderer for %s', device => {
    const runtime = buildProjectedGenerativeUiRegistry(topicProjection(true))
    const topic = node({
      kind: 'com.homerail.topic-outline/outline',
      owner: { id: 'com.homerail.topic-outline', version: '1.0.0' },
      content: { title: 'Topic outline', outline: [] },
    })
    expect(runtime.renderers.resolve(topic, 'task', device).mode).toBe('specialized')
    expect(runtime.renderers.resolve({ ...topic, kind_version: 2 }, 'task', device).mode)
      .toBe('fallback')
  })

  it.each(['phone', 'desktop', 'tv'] as const)('projects the PR closeout renderer for %s', device => {
    const projection = topicProjection(true)
    projection.kinds[0] = {
      ...projection.kinds[0],
      plugin_id: 'com.homerail.pr-closeout',
      kind: 'com.homerail.pr-closeout/report',
      schema_id: 'pr-closeout-content-v1',
      allowed_surfaces: ['task', 'result'],
      preferred_visuals: ['dashboard', 'graph', 'timeline', 'matrix'],
    }
    projection.renderers[0] = {
      ...projection.renderers[0],
      plugin_id: 'com.homerail.pr-closeout',
      renderer_id: 'pr-closeout-main',
      kind: 'com.homerail.pr-closeout/report',
      surfaces: ['task', 'result'],
      source: { type: 'builtin', id: 'pr-closeout' },
    }
    const runtime = buildProjectedGenerativeUiRegistry(projection)
    const report = node({
      kind: 'com.homerail.pr-closeout/report',
      owner: { id: 'com.homerail.pr-closeout', version: '1.0.0' },
      surface: 'result',
      content: { title: 'PR closeout', repository: 'owner/repo', pr_number: 21 },
    })
    expect(runtime.renderers.resolve(report, 'result', device).mode).toBe('specialized')
  })

  it.each(['phone', 'desktop', 'tv'] as const)('projects runtime A2UI through the trusted Catalog for %s', device => {
    const projection = topicProjection(true)
    projection.kinds[0] = {
      ...projection.kinds[0],
      plugin_id: 'com.homerail.core',
      plugin_version: '0.1.0',
      kind: 'com.homerail.core/generated_view',
      schema_id: 'generated-view-content-v1',
      allowed_surfaces: ['task', 'execution', 'result', 'ambient'],
      preferred_visuals: ['dashboard', 'table', 'timeline', 'chart', 'dag'],
    }
    projection.renderers[0] = {
      ...projection.renderers[0],
      plugin_id: 'com.homerail.core',
      plugin_version: '0.1.0',
      renderer_id: 'core-generated-view',
      kind: 'com.homerail.core/generated_view',
      surfaces: ['task', 'execution', 'result', 'ambient'],
      source: { type: 'builtin', id: 'a2ui' },
    }
    const runtime = buildProjectedGenerativeUiRegistry(projection)
    const generated = node({
      kind: 'com.homerail.core/generated_view',
      owner: { id: 'com.homerail.core', version: '0.1.0' },
      surface: 'result',
      content: { data: { title: 'Runtime view' } },
      a2ui: {
        version: 'v1.0',
        catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1',
        components: [{ id: 'root', component: 'Text', text: { path: '/data/title' } }],
      },
    })
    expect(runtime.renderers.resolve(generated, 'result', device).mode).toBe('specialized')
  })

  it('removes disabled and unknown built-in renderers without dynamic loading', () => {
    const topic = node({
      kind: 'com.homerail.topic-outline/outline',
      owner: { id: 'com.homerail.topic-outline', version: '1.0.0' },
      content: { title: 'Topic outline' },
    })
    expect(buildProjectedGenerativeUiRegistry(topicProjection(false)).renderers.resolve(topic, 'task', 'desktop').mode)
      .toBe('fallback')
    const unknown = topicProjection(true)
    if (unknown.renderers[0].source.type === 'builtin') unknown.renderers[0].source.id = 'not-compiled'
    const runtime = buildProjectedGenerativeUiRegistry(unknown)
    expect(runtime.renderers.resolve(topic, 'task', 'desktop').mode).toBe('fallback')
    expect(runtime.unresolved_renderer_ids).toEqual(['com.homerail.topic-outline:topic-outline-main'])
  })

  it('projects an exact declarative Renderer without loading plugin code', () => {
    const projection = topicProjection(true)
    projection.kinds[0] = {
      ...projection.kinds[0],
      plugin_id: 'com.example.plugin',
      plugin_version: '1.0.0',
      kind: 'com.example.plugin/card',
      schema_id: 'card-v1',
    }
    projection.renderers[0] = {
      ...projection.renderers[0],
      plugin_id: 'com.example.plugin',
      plugin_version: '1.0.0',
      renderer_id: 'card-declarative',
      kind: 'com.example.plugin/card',
      mode: 'declarative',
      source: {
        type: 'declarative',
        file: 'ui/card.json',
        digest: 'c'.repeat(64),
        document: {
          renderer_version: 1,
          type: 'card',
          title_pointer: '/title',
          sections: [{ id: 'summary', type: 'text', pointer: '/summary' }],
        },
      },
    }
    const runtime = buildProjectedGenerativeUiRegistry(projection)
    expect(runtime.renderers.resolve(node({ content: { title: 'Card', summary: 'Safe data.' } }), 'task', 'desktop'))
      .toMatchObject({ mode: 'declarative', document: { title_pointer: '/title' } })
    expect(runtime.unresolved_renderer_ids).toEqual([])
  })

  it('projects custom Renderer metadata without importing plugin code into the host realm', () => {
    const projection = topicProjection(true)
    projection.kinds[0] = {
      ...projection.kinds[0],
      plugin_id: 'com.example.plugin',
      plugin_version: '1.0.0',
      kind: 'com.example.plugin/card',
      schema_id: 'card-v1',
    }
    projection.renderers[0] = {
      ...projection.renderers[0],
      plugin_id: 'com.example.plugin',
      plugin_version: '1.0.0',
      renderer_id: 'card-custom',
      kind: 'com.example.plugin/card',
      mode: 'custom',
      source: {
        type: 'custom',
        file: 'ui/card.mjs',
        digest: 'c'.repeat(64),
      },
    }
    const runtime = buildProjectedGenerativeUiRegistry(projection)
    const resolved = runtime.renderers.resolve(node(), 'task', 'desktop')
    expect(resolved).toMatchObject({
      mode: 'custom',
      source: { type: 'custom', file: 'ui/card.mjs', digest: 'c'.repeat(64) },
      registration: { manifest_digest: 'a'.repeat(64) },
    })
    if (resolved.mode !== 'custom') throw new Error('custom Renderer did not resolve')
    expect(Object.isFrozen(resolved.source)).toBe(true)
    expect(runtime.unresolved_renderer_ids).toEqual([])
  })

  it('keeps the old topic kind inside the isolated legacy compatibility path', () => {
    const runtime = buildProjectedGenerativeUiRegistry(topicProjection(true))
    const legacyTopic = node({
      kind: 'com.homerail.content/topic_outline',
      owner: { id: 'com.homerail.content', version: '0.1.0' },
      content: { legacy_widget: legacyWidget() },
    })
    expect(runtime.renderers.resolve(legacyTopic, 'task', 'desktop').mode).toBe('specialized')
  })

  it('accepts Vue-reactive projection envelopes without cloning proxies', () => {
    const runtime = buildProjectedGenerativeUiRegistry(reactive(topicProjection(true)))
    expect(runtime.renderers.registrations.length).toBeGreaterThan(0)
  })
})

function topicProjection(enabled: boolean): HomerailPluginUiProjectionV1 {
  const manifestDigest = 'a'.repeat(64)
  return {
    registry_revision: 2,
    registry_fingerprint: 'b'.repeat(64),
    kinds: [{
      plugin_id: 'com.homerail.topic-outline',
      plugin_version: '1.0.0',
      manifest_digest: manifestDigest,
      enabled,
      schema_id: 'topic-outline-content-v1',
      kind: 'com.homerail.topic-outline/outline',
      kind_version: 1,
      schema: { type: 'object' },
      allowed_surfaces: ['task'],
      max_payload_bytes: 32768,
      fallback_required: true,
      preferred_visuals: ['outline'],
      action_ids: [],
    }],
    renderers: [{
      plugin_id: 'com.homerail.topic-outline',
      plugin_version: '1.0.0',
      manifest_digest: manifestDigest,
      enabled,
      renderer_id: 'topic-outline-main',
      kind: 'com.homerail.topic-outline/outline',
      kind_version: 1,
      renderer_api: 1,
      mode: 'builtin',
      surfaces: ['task'],
      devices: ['phone', 'desktop', 'tv'],
      source: { type: 'builtin', id: 'topic-outline' },
      fallback: { type: 'portable' },
    }],
    actions: [],
  }
}

function legacyWidget(): Record<string, unknown> {
  return {
    id: 'registry-node',
    type: 'topic_outline',
    title: 'Topic outline',
    body: 'Brief',
    priority: 'normal',
    status: 'ready',
    items: [],
    steps: [],
    active_step: null,
    data: { outline: [] },
  }
}

describe('legacyWidgetFromGenerativeUiNode', () => {
  it('materializes a defensive legacy compatibility value without routing on widget.type', () => {
    const source = node({ content: { legacy_widget: legacyWidget() } })
    const widget = legacyWidgetFromGenerativeUiNode(source)
    expect(widget).toMatchObject({ id: source.id, type: 'topic_outline', data: { outline: [] } })
    widget.data.outline = ['mutated']
    expect((source.content.legacy_widget as { data: { outline: unknown[] } }).data.outline).toEqual([])
  })

  it('unwraps Vue projection proxies before cloning legacy JSON data', () => {
    const source = reactive(node({ content: { legacy_widget: legacyWidget() } }))
    expect(legacyWidgetFromGenerativeUiNode(source)).toMatchObject({
      id: 'registry-node',
      data: { outline: [] },
    })
  })

  it('rejects identity mismatches and malformed compatibility payloads', () => {
    expect(() => legacyWidgetFromGenerativeUiNode(node({
      content: { legacy_widget: { ...legacyWidget(), id: 'other' } },
    }))).toThrow('does not match')
    expect(() => legacyWidgetFromGenerativeUiNode(node({ content: {} }))).toThrow('no legacy widget payload')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { HOMERAIL_A2UI_CATALOG_ID } from 'homerail-protocol'
import type { GenerativeUiActionRequestV1 } from '@/generative-ui/types'
import { GenerativeUiActionRegistry } from '@/generative-ui/action-registry'
import { GenerativeUiRendererRegistry } from '@/generative-ui/renderer-registry'
import { i18n } from '@/plugins/i18n'
import A2uiRenderer from './A2uiRenderer.vue'
import GenerativeUiNodeHost from './GenerativeUiNodeHost.vue'

let app: App<Element> | null = null
let root: HTMLElement | null = null

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('A2UI action bridge', () => {
  it('maps event.name back to the authoritative HomeRail Action Registry', async () => {
    const actions: GenerativeUiActionRequestV1[] = []
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(GenerativeUiNodeHost, {
      documentId: 'document-one',
      documentRevision: 1,
      documentScope: { type: 'voice_session', id: 'session-one' },
      node: {
        ir_version: 1,
        id: 'com.example.views:one',
        kind: 'com.example.views/generated',
        kind_version: 1,
        owner: { id: 'com.example.views', version: '1.0.0' },
        surface: 'result',
        importance: 'primary',
        content: { selectedId: 'content-must-not-become-action-args' },
        a2ui: {
          version: 'v1.0',
          catalogId: HOMERAIL_A2UI_CATALOG_ID,
          components: [
            { id: 'root', component: 'Button', child: 'label', action: { event: { name: 'inspect' } } },
            { id: 'label', component: 'Text', text: 'Inspect' },
          ],
        },
        actions: [{ id: 'inspect', label: 'Inspect', intent: 'com.example.views.inspect' }],
        fallback: { title: 'Generated A2UI' },
        revision: 1,
        updated_at: '2026-07-12T10:00:00.000Z',
      },
      placement: {
        node_id: 'com.example.views:one', node_revision: 1, surface: 'result', variant: 'summary', rank: 1,
        placement: 'primary', pinned: false, visibility: 'visible',
      },
      context: { device: 'desktop', input: 'mouse', viewport: 'wide', attention: 'focused' },
      registry: new GenerativeUiRendererRegistry([{
        renderer_api_version: 1,
        plugin_id: 'com.example.views', plugin_version: '1.0.0', renderer_id: 'a2ui',
        kind: 'com.example.views/generated', kind_version: 1, surface: 'result', device: 'desktop',
        mode: 'specialized', component: A2uiRenderer,
      }]),
      actionRegistry: new GenerativeUiActionRegistry([{
        plugin_id: 'com.example.views', plugin_version: '1.0.0', local_id: 'inspect',
        qualified_id: 'com.example.views:inspect', capability_ids: [], intent: 'com.example.views.inspect',
      }]),
      actionMode: 'emit',
      onAction: (request: GenerativeUiActionRequestV1) => actions.push(request),
    })
    app.use(i18n)
    app.mount(root)
    await nextTick()

    expect(root.querySelectorAll('.hr-a2ui__button > button')).toHaveLength(1)
    expect(root.querySelector('.generative-ui-node-host__actions')).toBeNull()
    root.querySelector<HTMLButtonElement>('.hr-a2ui__button > button')?.click()
    await nextTick()
    expect(actions).toEqual([expect.objectContaining({
      document_id: 'document-one',
      node_id: 'com.example.views:one',
      action: {
        id: 'inspect',
        label: 'Inspect',
        intent: 'com.example.views.inspect',
      },
    })])
    expect(actions[0]).not.toHaveProperty('context')
    expect(actions[0]).not.toHaveProperty('selectedId')
  })
})

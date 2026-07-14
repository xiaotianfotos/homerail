import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiCompositionV1,
  GenerativeUiDocumentV1,
  GenerativeUiStoredNodeV1,
} from 'homerail-protocol'
import { http } from '@/api/clients/http-client'
import { i18n } from '@/plugins/i18n'
import { GenerativeUiActionRegistry } from '@/generative-ui/action-registry'
import { GenerativeUiRendererRegistry } from '@/generative-ui/renderer-registry'
import GenerativeUiNodeHost from './GenerativeUiNodeHost.vue'
import GenerativeUiSurfaceHost from './GenerativeUiSurfaceHost.vue'

const digest = 'a'.repeat(64)
const Renderer = defineComponent({
  props: ['node'],
  render() {
    return h('div', this.node.fallback.title)
  },
})

function node(): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: 'node-one',
    kind: 'com.example.plugin/card',
    kind_version: 1,
    owner: { id: 'com.example.plugin', version: '1.0.0' },
    surface: 'task',
    importance: 'secondary',
    content: {},
    actions: [{
      id: 'approve',
      label: 'Approve',
      intent: 'com.example.plugin.approve',
      arguments: { value: true },
    }],
    fallback: { title: 'Example card' },
    revision: 3,
    updated_at: '2026-07-12T01:00:00.000Z',
  }
}

function placement(): GenerativeUiCompositionItemV1 {
  return {
    node_id: 'node-one',
    node_revision: 3,
    surface: 'task',
    variant: 'summary',
    rank: 1,
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

const registry = new GenerativeUiRendererRegistry([{
  renderer_api_version: 1,
  plugin_id: 'com.example.plugin',
  plugin_version: '1.0.0',
  renderer_id: 'card-main',
  kind: 'com.example.plugin/card',
  kind_version: 1,
  surface: 'task',
  device: 'desktop',
  mode: 'specialized',
  component: Renderer,
}])

const actions = new GenerativeUiActionRegistry([{
  plugin_id: 'com.example.plugin',
  plugin_version: '1.0.0',
  local_id: 'approve',
  qualified_id: 'com.example.plugin:approve',
  capability_ids: [],
  intent: 'com.example.plugin.approve',
}])

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

function mountNode(props: Record<string, unknown> = {}): HTMLElement {
  return mount(GenerativeUiNodeHost, {
    documentId: 'document-one',
    documentRevision: 7,
    documentScope: { type: 'voice_session', id: 'session-one' },
    node: node(),
    placement: placement(),
    context,
    registry,
    actionRegistry: actions,
    actionMode: 'manager',
    ...props,
  })
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  vi.restoreAllMocks()
})

describe('Generative UI Manager Action flow', () => {
  it('starts a new immutable request after grant, then confirms and commits it', async () => {
    const onAction = vi.fn()
    const onActionStatus = vi.fn()
    let invocationCount = 0
    const post = vi.spyOn(http, 'post').mockImplementation(async (url, body) => {
      const input = body as Record<string, unknown>
      const requestId = String(input.request_id || '')
      if (url === '/api/plugins/actions') {
        invocationCount += 1
        if (invocationCount === 1) {
          return {
            success: true,
            data: {
              request_id: requestId,
              request_digest: digest,
              status: 'needs_grant',
              missing_permissions: ['network'],
            },
          }
        }
        return {
          success: true,
          data: {
            request_id: requestId,
            request_digest: digest,
            status: 'awaiting_confirmation',
            challenge: {
              challenge_id: 'challenge-12345678',
              request_id: requestId,
              request_digest: digest,
              effect: 'write',
              permissions: ['network.connect'],
              effective_grants: [{ permission: 'network.connect', hosts: ['api.example.com'] }],
              message: 'Allow this write?',
              expires_at: '2026-07-12T01:05:00.000Z',
            },
          },
        }
      }
      expect(url).toMatch(/^\/api\/plugins\/actions\/.+\/confirmation$/)
      return {
        success: true,
        data: {
          request_id: decodeURIComponent(String(url).split('/')[4] || ''),
          request_digest: digest,
          status: 'committed',
          result: { document_revision: 8 },
        },
      }
    })

    const mounted = mountNode({ onAction, onActionStatus })
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()

    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="needs_grant"]')).toBeTruthy()
    })
    expect(onAction).not.toHaveBeenCalled()
    const firstRequest = post.mock.calls[0]?.[1] as Record<string, unknown>
    expect(firstRequest).toMatchObject({
      idempotency_key: firstRequest.request_id,
      scope: { type: 'voice_session', id: 'session-one' },
      document_id: 'document-one',
      document_revision: 7,
      node_id: 'node-one',
      node_revision: 3,
      action_id: 'approve',
      input: {},
    })
    expect(firstRequest).not.toHaveProperty('action_intent')
    expect(firstRequest).not.toHaveProperty('plugin_id')

    mounted.querySelector<HTMLButtonElement>('[data-action-retry]')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="awaiting_confirmation"]')).toBeTruthy()
    })
    const secondRequest = post.mock.calls[1]?.[1] as Record<string, unknown>
    expect(secondRequest).toMatchObject({
      scope: firstRequest.scope,
      document_id: firstRequest.document_id,
      document_revision: firstRequest.document_revision,
      node_id: firstRequest.node_id,
      node_revision: firstRequest.node_revision,
      action_id: firstRequest.action_id,
      input: firstRequest.input,
      idempotency_key: secondRequest.request_id,
    })
    expect(secondRequest.request_id).not.toBe(firstRequest.request_id)
    expect(mounted.textContent).toContain('Allow this write?')
    expect(mounted.querySelector('[data-action-authority]')?.textContent).toContain('write')
    expect(mounted.querySelector('[data-action-authority]')?.textContent).toContain('api.example.com')

    mounted.querySelector<HTMLButtonElement>('[data-action-confirm="approved"]')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="committed"]')).toBeTruthy()
    })
    expect(post.mock.calls[2]?.[0]).toBe(
      `/api/plugins/actions/${encodeURIComponent(String(secondRequest.request_id))}/confirmation`,
    )
    expect(post.mock.calls[2]?.[1]).toEqual({
      challenge_id: 'challenge-12345678',
      decision: 'approved',
    })
    expect(onActionStatus).toHaveBeenLastCalledWith({
      node_id: 'node-one',
      action_id: 'approve',
      response: expect.objectContaining({ status: 'committed' }),
    })
  })

  it('shows transport failure and retries the exact request identity', async () => {
    let firstRequest: Record<string, unknown> | undefined
    const post = vi.spyOn(http, 'post')
      .mockImplementationOnce(async (_url, body) => {
        firstRequest = body as Record<string, unknown>
        throw { message: 'Manager is offline', code: 0 }
      })
      .mockImplementationOnce(async (_url, body) => ({
        success: true,
        data: {
          request_id: String((body as Record<string, unknown>).request_id),
          request_digest: digest,
          status: 'committed',
        },
      }))

    const mounted = mountNode()
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="failed"]')).toBeTruthy()
      expect(mounted.textContent).toContain('Manager is offline')
    })

    mounted.querySelector<HTMLButtonElement>('[data-action-retry]')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="committed"]')).toBeTruthy()
    })
    expect(post.mock.calls[1]?.[1]).toEqual(firstRequest)
  })

  it('recovers a lost response through running to the committed terminal state', async () => {
    let firstRequest: Record<string, unknown> | undefined
    const post = vi.spyOn(http, 'post')
      .mockImplementationOnce(async (_url, body) => {
        firstRequest = body as Record<string, unknown>
        throw { message: 'Initial response was lost', code: 0 }
      })
      .mockImplementationOnce(async (_url, body) => ({
        success: true,
        data: {
          request_id: String((body as Record<string, unknown>).request_id),
          request_digest: digest,
          status: 'running',
        },
      }))
      .mockImplementationOnce(async (_url, body) => ({
        success: true,
        data: {
          request_id: String((body as Record<string, unknown>).request_id),
          request_digest: digest,
          status: 'committed',
          result: { document_revision: 8 },
        },
      }))

    const onActionStatus = vi.fn()
    const mounted = mountNode({ onActionStatus })
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()
    await vi.waitFor(() => expect(mounted.querySelector('[data-action-retry]')).toBeTruthy())

    mounted.querySelector<HTMLButtonElement>('[data-action-retry]')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="committed"]')).toBeTruthy()
    }, { timeout: 2_000 })
    expect(post).toHaveBeenCalledTimes(3)
    expect(post.mock.calls[1]?.[1]).toEqual(firstRequest)
    expect(post.mock.calls[2]?.[1]).toEqual(firstRequest)
    expect(onActionStatus).toHaveBeenLastCalledWith({
      node_id: 'node-one',
      action_id: 'approve',
      response: expect.objectContaining({ status: 'committed' }),
    })
  })

  it('shows definitive Manager failures without offering an unsafe retry', async () => {
    const post = vi.spyOn(http, 'post').mockRejectedValue({
      message: 'Plugin Action node revision is stale',
      code: 409,
    })
    const mounted = mountNode()
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()

    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="failed"]')).toBeTruthy()
      expect(mounted.textContent).toContain('node revision is stale')
    })
    expect(mounted.querySelector('[data-action-retry]')).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('locks an indeterminate Runtime Action until Manager reconciliation', async () => {
    const post = vi.spyOn(http, 'post').mockImplementation(async (_url, body) => ({
      success: true,
      data: {
        request_id: String((body as Record<string, unknown>).request_id),
        request_digest: digest,
        status: 'failed',
        error_code: 'runtime_indeterminate',
        error_message: 'Runtime result requires reconciliation',
      },
    }))
    const mounted = mountNode()
    const actionButton = mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!
    actionButton.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-action-status="failed"]')).toBeTruthy()
      expect(actionButton.disabled).toBe(true)
    })
    expect(mounted.querySelector('[data-action-retry]')).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('never calls Manager from non-interactive shadow or disabled preview surfaces', () => {
    const post = vi.spyOn(http, 'post')
    const documentValue: GenerativeUiDocumentV1 = {
      ir_version: 1,
      document_id: 'document-one',
      scope: { type: 'voice_session', id: 'session-one' },
      revision: 7,
      nodes: [node()],
      updated_at: '2026-07-12T01:00:00.000Z',
    }
    const composition: GenerativeUiCompositionV1 = {
      composition_version: 1,
      document_id: 'document-one',
      document_revision: 7,
      context,
      items: [placement()],
      hidden_node_ids: [],
    }
    const mounted = mount(GenerativeUiSurfaceHost, {
      document: documentValue,
      composition,
      registry,
      actionRegistry: actions,
      interactive: false,
      actionMode: 'manager',
    })
    expect(mounted.querySelector('.generative-ui-node-host__actions')).toBeNull()
    expect(post).not.toHaveBeenCalled()

    app?.unmount()
    root!.innerHTML = ''
    app = createApp(GenerativeUiNodeHost, {
      documentId: 'document-one',
      documentRevision: 7,
      documentScope: { type: 'voice_session', id: 'session-one' },
      node: node(),
      placement: placement(),
      context,
      registry,
      actionRegistry: actions,
      interactive: true,
      actionMode: 'disabled',
    })
    app.use(i18n)
    app.mount(root!)
    expect(root!.querySelector('.generative-ui-node-host__actions')).toBeNull()
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps the legacy symbolic emit mode free of Manager side effects', () => {
    const post = vi.spyOn(http, 'post')
    const onAction = vi.fn()
    const mounted = mountNode({ actionMode: 'emit', onAction })
    mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')!.click()
    expect(onAction).toHaveBeenCalledWith({
      document_id: 'document-one',
      node_id: 'node-one',
      node_revision: 3,
      action: node().actions![0],
    })
    expect(post).not.toHaveBeenCalled()
  })
})

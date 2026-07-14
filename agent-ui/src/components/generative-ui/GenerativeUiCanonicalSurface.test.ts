import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import type {
  GenerativeUiCanonicalProjectionV1,
  PendingAgentToolConfirmationV1,
} from '@/generative-ui/types'
import { http } from '@/api/clients/http-client'
import { i18n } from '@/plugins/i18n'
import GenerativeUiCanonicalSurface from './GenerativeUiCanonicalSurface.vue'

const digest = 'a'.repeat(64)
const agentRequestId = 'agent:request-12345678'
let app: App<Element> | null = null
let root: HTMLElement | null = null

function pendingToolConfirmation(): PendingAgentToolConfirmationV1 {
  return {
    request_id: agentRequestId,
    request_digest: digest,
    status: 'awaiting_confirmation',
    idempotent: true,
    source: 'agent',
    tool: {
      local_id: 'publish_card',
      qualified_id: 'com.example.plugin:publish_card',
      wire_id: 'p_1234567890_publish_card',
    },
    challenge: {
      confirmation_version: 1,
      challenge_id: 'confirm:challenge-12345678',
      request_id: agentRequestId,
      request_digest: digest,
      effect: 'external',
      permissions: ['network.connect'],
      effective_grants: [{ permission: 'network.connect', hosts: ['api.example.com'] }],
      message: 'Allow the Agent Tool to publish this card?',
      issued_at: '2026-07-12T01:00:00.000Z',
      expires_at: '2026-07-12T01:04:00.000Z',
    },
  }
}

function projection(revision: number, title: string): GenerativeUiCanonicalProjectionV1 {
  const updatedAt = `2026-07-12T01:00:0${revision}.000Z`
  return {
    stream_version: 1,
    mode: 'prefer',
    authoritative: true,
    purpose: 'canonical',
    document: {
      ir_version: 1,
      document_id: 'canonical-document',
      scope: { type: 'voice_session', id: 'session-one' },
      revision,
      nodes: [{
        ir_version: 1,
        id: 'com.example.plugin:current',
        kind: 'com.example.plugin/card',
        kind_version: 1,
        owner: { id: 'com.example.plugin', version: '1.0.0' },
        surface: 'task',
        importance: 'primary',
        content: { title },
        lifecycle: { persistence: 'session' },
        actions: [{
          id: 'complete',
          label: 'Complete',
          intent: 'com.example.plugin.complete',
        }],
        fallback: { title },
        revision,
        updated_at: updatedAt,
      }],
      updated_at: updatedAt,
    },
    cursor: revision,
    overrides: [],
    composition: {
      composition_version: 1,
      document_id: 'canonical-document',
      document_revision: revision,
      context: {
        device: 'desktop',
        input: 'mouse',
        viewport: 'wide',
        attention: 'focused',
        active_session_id: 'session-one',
      },
      items: [{
        node_id: 'com.example.plugin:current',
        node_revision: revision,
        surface: 'task',
        variant: 'detail',
        rank: 1,
        placement: 'primary',
        pinned: false,
        visibility: 'visible',
      }],
      hidden_node_ids: [],
    },
    ui_registry: {
      registry_revision: 1,
      registry_fingerprint: '0'.repeat(64),
      kinds: [],
      renderers: [],
      actions: [{
        plugin_id: 'com.example.plugin',
        plugin_version: '1.0.0',
        local_id: 'complete',
        qualified_id: 'com.example.plugin:complete',
        capability_ids: ['com.example.plugin:manage-card'],
        intent: 'com.example.plugin.complete',
      }],
    },
    pending_tool_confirmations: [],
  }
}

function mount(props: Record<string, unknown> = {}): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(GenerativeUiCanonicalSurface, {
    sessionId: 'session-one',
    ...props,
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
  vi.restoreAllMocks()
})

describe('GenerativeUiCanonicalSurface', () => {
  it('reports unavailable so prefer keeps the legacy fallback', async () => {
    vi.spyOn(http, 'get').mockRejectedValue({ code: 404, message: 'not found' })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [] }))
    expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [], loading: true })
    expect(mounted.querySelector('[data-generative-ui-mode="prefer"]')).toBeNull()
  })

  it('renders authoritative manager Actions and refreshes after commit', async () => {
    const get = vi.spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: projection(1, 'Ready') })
      .mockResolvedValueOnce({ success: true, data: projection(2, 'Committed') })
    vi.spyOn(http, 'post').mockImplementation(async (_url, body) => ({
      success: true,
      data: {
        request_id: String((body as Record<string, unknown>).request_id),
        request_digest: digest,
        status: 'committed',
        result: { document_revision: 2 },
      },
    }))
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-generative-ui-authoritative="true"]')).toBeTruthy()
      expect(mounted.textContent).toContain('Ready')
    })
    const action = mounted.querySelector<HTMLButtonElement>('.generative-ui-node-host__actions button')
    expect(action).toBeTruthy()
    action!.click()
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2)
      expect(mounted.textContent).toContain('Committed')
    })
    expect(onAvailability).toHaveBeenCalledWith({
      available: true,
      node_ids: ['com.example.plugin:current'],
    })
  })

  it('rejects a shadow response instead of making it interactive', async () => {
    const shadow = {
      ...projection(1, 'Shadow'),
      mode: 'shadow',
      authoritative: false,
      purpose: 'legacy_widget_shadow',
    }
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: shadow })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [] }))
    expect(mounted.querySelector('.generative-ui-node-host__actions')).toBeNull()
  })

  it('rejects a canonical document bound to another voice session', async () => {
    const crossSession = projection(1, 'Wrong session')
    crossSession.document.scope.id = 'session-two'
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: crossSession })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [] }))
    expect(mounted.querySelector('[data-generative-ui-authoritative="true"]')).toBeNull()
  })

  it('rejects an empty canonical document so prefer remains on the legacy fallback', async () => {
    const empty = projection(1, 'Removed')
    empty.document.nodes = []
    empty.composition.items = []
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: empty })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [] }))
    expect(mounted.querySelector('[data-generative-ui-authoritative="true"]')).toBeNull()
  })

  it('keeps empty-document canonical authority for a Manager-owned Agent Tool confirmation', async () => {
    const pendingProjection = projection(1, 'No nodes')
    pendingProjection.document.nodes = []
    pendingProjection.composition.items = []
    pendingProjection.pending_tool_confirmations = [pendingToolConfirmation()]
    const resolvedProjection = projection(1, 'Resolved')
    resolvedProjection.document.nodes = []
    resolvedProjection.composition.items = []
    const get = vi.spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: pendingProjection })
      .mockResolvedValueOnce({ success: true, data: resolvedProjection })
    let finishDecision!: (value: unknown) => void
    const post = vi.spyOn(http, 'post').mockReturnValue(new Promise(resolve => {
      finishDecision = resolve
    }) as never)
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })

    await vi.waitFor(() => {
      expect(onAvailability).toHaveBeenCalledWith({ available: true, node_ids: [] })
      expect(mounted.querySelector('[data-agent-tool-confirmations][data-manager-owned="true"]')).toBeTruthy()
      expect(mounted.textContent).toContain('Allow the Agent Tool to publish this card?')
      expect(mounted.textContent).toContain('api.example.com')
    })
    const approve = mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirm="approved"]')!
    const deny = mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirm="denied"]')!
    approve.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-agent-tool-confirmation-busy]')).toBeTruthy()
      expect(approve.disabled).toBe(true)
      expect(deny.disabled).toBe(true)
    })
    expect(post).toHaveBeenCalledWith(
      '/api/plugins/tools/agent%3Arequest-12345678/confirmation',
      { challenge_id: 'confirm:challenge-12345678', decision: 'approved' },
    )
    finishDecision({
      success: true,
      data: {
        request_id: agentRequestId,
        request_digest: digest,
        status: 'committed',
        idempotent: false,
        source: 'agent',
        tool: pendingToolConfirmation().tool,
        result: { document_revision: 2 },
      },
    })
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2)
      expect(mounted.querySelector('[data-agent-tool-confirmations]')).toBeNull()
      expect(onAvailability).toHaveBeenLastCalledWith({ available: false, node_ids: [] })
    })
  })

  it('shows confirmation errors and refreshes Manager state without replaying the decision', async () => {
    const pendingProjection = projection(1, 'No nodes')
    pendingProjection.document.nodes = []
    pendingProjection.composition.items = []
    pendingProjection.pending_tool_confirmations = [pendingToolConfirmation()]
    const get = vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: pendingProjection })
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: {
        request_id: agentRequestId,
        request_digest: digest,
        status: 'denied',
        idempotent: false,
        source: 'agent',
        tool: {
          ...pendingToolConfirmation().tool,
          qualified_id: 'com.other.plugin:publish_card',
        },
      },
    })
    const mounted = mount()
    await vi.waitFor(() => expect(mounted.querySelector('[data-agent-tool-confirm="denied"]')).toBeTruthy())

    mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirm="denied"]')!.click()
    await vi.waitFor(() => {
      expect(mounted.querySelector('[data-agent-tool-confirmation-error]')?.textContent)
        .toContain('did not match the displayed confirmation')
      expect(mounted.querySelector('[data-agent-tool-confirmation-refresh]')).toBeTruthy()
      expect(mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirm="approved"]')?.disabled).toBe(true)
      expect(mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirm="denied"]')?.disabled).toBe(true)
    })
    mounted.querySelector<HTMLButtonElement>('[data-agent-tool-confirmation-refresh]')!.click()
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2)
      expect(mounted.querySelector('[data-agent-tool-confirmation-error]')).toBeNull()
    })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed pending Tool authority instead of rendering confirmation controls', async () => {
    const malformed = projection(1, 'Malformed authority') as unknown as Record<string, unknown>
    malformed.pending_tool_confirmations = [{
      ...pendingToolConfirmation(),
      source: 'ui_action',
    }]
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: malformed })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(onAvailability).toHaveBeenCalledWith({ available: false, node_ids: [] }))
    expect(mounted.querySelector('[data-agent-tool-confirmations]')).toBeNull()
  })

  it('retains a cached canonical projection across a transient network failure', async () => {
    vi.spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: projection(1, 'Canonical') })
      .mockRejectedValueOnce({ code: 0, message: 'network unavailable' })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(mounted.textContent).toContain('Canonical'))

    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => expect(onAvailability).toHaveBeenLastCalledWith({
      available: true,
      node_ids: ['com.example.plugin:current'],
    }))
    expect(mounted.textContent).toContain('Canonical')
  })

  it('drops a cached canonical projection immediately when the runtime kill switch returns 404', async () => {
    vi.spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: projection(1, 'Canonical') })
      .mockRejectedValueOnce({ code: 404, message: 'Generative UI document not found' })
    const onAvailability = vi.fn()
    const mounted = mount({ onAvailability })
    await vi.waitFor(() => expect(mounted.textContent).toContain('Canonical'))

    window.dispatchEvent(new Event('resize'))
    await vi.waitFor(() => {
      expect(onAvailability).toHaveBeenLastCalledWith({ available: false, node_ids: [] })
      expect(mounted.querySelector('[data-generative-ui-mode="prefer"]')).toBeNull()
    })
  })
})

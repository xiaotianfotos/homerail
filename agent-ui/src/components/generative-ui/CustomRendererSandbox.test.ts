import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'
import { getCustomRendererSource } from '@/api/services/custom-renderer-api'
import type { GenerativeUiRendererRegistrationV1 } from '@/generative-ui/renderer-registry'
import { i18n } from '@/plugins/i18n'
import CustomRendererSandbox from './CustomRendererSandbox.vue'

vi.mock('@/api/services/custom-renderer-api', () => ({
  getCustomRendererSource: vi.fn(),
}))

const source = 'export function render(payload) { return { version: "v1.0", catalogId: "https://homerail.dev/a2ui/catalogs/core/v1", components: [{ id: "root", component: "Text", text: String(payload?.node?.id || "safe") }] } }'
const digest = '867b39d5e7715516371477d7c12d6617aedd4f4b74bea50c5265f3033ef1e2fb'
const manifestDigest = 'b'.repeat(64)

const node: GenerativeUiStoredNodeV1 = {
  ir_version: 1,
  id: 'node-one',
  kind: 'com.example.cards/card',
  kind_version: 1,
  owner: { id: 'com.example.cards', version: '1.0.0' },
  surface: 'task',
  importance: 'secondary',
  content: { title: 'Sandboxed' },
  fallback: { title: 'Portable card' },
  actions: [{ id: 'approve', label: 'Approve', intent: 'com.example.cards:approve' }],
  revision: 4,
  updated_at: '2026-07-12T00:00:00.000Z',
}
const placement: GenerativeUiCompositionItemV1 = {
  node_id: node.id,
  node_revision: node.revision,
  surface: 'task',
  variant: 'summary',
  rank: 0,
  placement: 'primary',
  pinned: false,
  visibility: 'visible',
}
const context: GenerativeUiSurfaceContextV1 = {
  device: 'desktop', input: 'mouse', viewport: 'wide', attention: 'focused',
}
const registration: GenerativeUiRendererRegistrationV1 = {
  renderer_api_version: 1,
  plugin_id: node.owner.id,
  plugin_version: node.owner.version,
  manifest_digest: manifestDigest,
  renderer_id: 'card-custom',
  kind: node.kind,
  kind_version: node.kind_version,
  surface: 'task',
  device: 'desktop',
  mode: 'custom',
  custom_source: { type: 'custom', file: 'ui/card.mjs', digest },
}

let app: App<Element> | undefined
let root: HTMLElement | undefined
let originalCrypto: Crypto

async function flush(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  })
  vi.mocked(getCustomRendererSource).mockResolvedValue({
    bridge_api: 1,
    renderer_api: 1,
    plugin_id: registration.plugin_id,
    plugin_version: registration.plugin_version,
    manifest_digest: manifestDigest,
    renderer_id: registration.renderer_id,
    file: 'ui/card.mjs',
    digest,
    media_type: 'text/javascript',
    content: source,
  })
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
  root = undefined
  Object.defineProperty(globalThis, 'crypto', {
    value: originalCrypto,
    configurable: true,
  })
  vi.clearAllMocks()
})

describe('CustomRendererSandbox', () => {
  it('creates an opaque bootstrap iframe with no plugin DOM or network authority', async () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CustomRendererSandbox, {
      node,
      placement,
      context,
      registration,
      source: registration.custom_source,
      actionIds: ['approve'],
    })
    app.use(i18n)
    app.mount(root)
    await flush()
    await vi.waitFor(() => expect(root!.querySelector('iframe')).toBeTruthy())

    const frame = root.querySelector<HTMLIFrameElement>('iframe')
    expect(frame).toBeTruthy()
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame!.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(frame!.getAttribute('sandbox')).not.toContain('allow-popups')
    expect(frame!.getAttribute('sandbox')).not.toContain('allow-forms')
    expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame!.getAttribute('allow')).toBe('')
    expect(frame!.hasAttribute('credentialless')).toBe(true)
    expect(frame!.getAttribute('allow')).not.toContain("camera *")
    expect(frame!.srcdoc).toContain("default-src 'none'")
    expect(frame!.srcdoc).toContain("connect-src 'none'")
    expect(frame!.srcdoc).toContain('worker-src blob:')
    expect(frame!.srcdoc).toContain('new Worker(workerUrl')
    expect(frame!.srcdoc).not.toContain('document.createElement')
    expect(frame!.srcdoc).not.toContain('ResizeObserver')
    expect(frame!.srcdoc).not.toContain('homerail.custom-renderer.action')
    expect(frame!.srcdoc).toContain('event.source !== parent')
    expect(frame!.srcdoc).toContain('event.origin !== parentOrigin')
    expect(getCustomRendererSource).toHaveBeenCalledWith(expect.objectContaining({
      plugin_id: node.owner.id,
      plugin_version: node.owner.version,
      manifest_digest: manifestDigest,
      renderer_id: registration.renderer_id,
      digest,
    }))
  })

  it('hands parent-validated Worker A2UI to the shared renderer and emits only action name', async () => {
    const onAction = vi.fn()
    const onSurfaceActions = vi.fn()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CustomRendererSandbox, {
      node,
      placement,
      context,
      registration,
      source: registration.custom_source,
      actionIds: ['approve'],
      onAction,
      onSurfaceActions,
    })
    app.use(i18n)
    app.mount(root)
    await flush()
    await vi.waitFor(() => expect(root!.querySelector('iframe')).toBeTruthy())

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!
    const nonce = frame.srcdoc.match(/<script nonce="([a-f0-9]{48})">/)?.[1]
    expect(nonce).toBeTruthy()
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'null',
      data: {
        bridge_version: 1,
        type: 'homerail.custom-renderer.a2ui',
        nonce,
        plugin_id: registration.plugin_id,
        plugin_version: registration.plugin_version,
        renderer_id: registration.renderer_id,
        renderer_digest: digest,
        node_id: node.id,
        node_revision: node.revision,
        request_id: 'render-1',
        a2ui: {
          version: 'v1.0',
          catalogId: 'https://homerail.dev/a2ui/catalogs/core/v1',
          components: [
            { id: 'root', component: 'Column', children: ['metric', 'approve'] },
            { id: 'metric', component: 'HrMetric', label: 'Title', value: { path: '/title' } },
            { id: 'approve', component: 'Button', child: 'label', action: { event: { name: 'approve' } } },
            { id: 'label', component: 'Text', text: 'Approve' },
          ],
        },
      },
    }))
    await nextTick()

    expect(root.querySelector('.homerail-a2ui')?.textContent).toContain('Sandboxed')
    expect(onSurfaceActions).toHaveBeenCalledWith(['approve'])
    root.querySelector<HTMLButtonElement>('.hr-a2ui__button > button')?.click()
    await nextTick()
    expect(onAction).toHaveBeenCalledWith('approve')
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('fails closed before creating an iframe when source bytes do not match the projection digest', async () => {
    vi.mocked(getCustomRendererSource).mockResolvedValueOnce({
      ...(await getCustomRendererSource({
        plugin_id: registration.plugin_id,
        plugin_version: registration.plugin_version,
        manifest_digest: manifestDigest,
        renderer_id: registration.renderer_id,
        file: 'ui/card.mjs',
        digest,
      })),
      content: `${source}\n// tampered`,
    })
    const onRendererError = vi.fn()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CustomRendererSandbox, {
      node,
      placement,
      context,
      registration,
      source: registration.custom_source,
      actionIds: ['approve'],
      onRendererError,
    })
    app.use(i18n)
    app.mount(root)
    await flush()
    await vi.waitFor(() => expect(onRendererError).toHaveBeenCalled())
    expect(root.querySelector('iframe')).toBeNull()
    expect(onRendererError).toHaveBeenCalledWith({ message: 'Custom Renderer source digest mismatch' })
  })
})

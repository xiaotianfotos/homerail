import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import type { GenerativeUiCompositionItemV1, GenerativeUiStoredNodeV1 } from 'homerail-protocol'
import { getCustomRendererSource } from '@/api/services/custom-renderer-api'
import { GenerativeUiRendererRegistry } from '@/generative-ui/renderer-registry'
import { i18n } from '@/plugins/i18n'
import GenerativeUiNodeHost from './GenerativeUiNodeHost.vue'

vi.mock('@/api/services/custom-renderer-api', () => ({
  getCustomRendererSource: vi.fn(),
}))

const digest = '497018890ccedd0f79998bc0356a0e16b745312518cef7375aae1cc563dd9192'
const manifestDigest = 'b'.repeat(64)
const node: GenerativeUiStoredNodeV1 = {
  ir_version: 1,
  id: 'node-one',
  kind: 'com.example.cards/card',
  kind_version: 1,
  owner: { id: 'com.example.cards', version: '1.0.0' },
  surface: 'task',
  importance: 'secondary',
  content: { title: 'Untrusted card' },
  fallback: { title: 'Portable card', summary: 'The safe fallback remains readable.' },
  revision: 1,
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
const registry = new GenerativeUiRendererRegistry([{
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
}])

let app: App<Element> | undefined
let root: HTMLElement | undefined
let originalCrypto: Crypto

beforeEach(() => {
  originalCrypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
  root = undefined
  Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true })
  vi.clearAllMocks()
})

describe('custom Renderer host fallback', () => {
  it('replaces a failed sandbox with the portable semantic fallback', async () => {
    vi.mocked(getCustomRendererSource).mockResolvedValue({
      bridge_api: 1,
      renderer_api: 1,
      plugin_id: node.owner.id,
      plugin_version: node.owner.version,
      manifest_digest: manifestDigest,
      renderer_id: 'card-custom',
      file: 'ui/card.mjs',
      digest,
      media_type: 'text/javascript',
      content: 'export function render() {} // digest does not match',
    })
    const onRendererError = vi.fn()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(GenerativeUiNodeHost, {
      documentId: 'document-one',
      node,
      placement,
      context: { device: 'desktop', input: 'mouse', viewport: 'wide', attention: 'focused' },
      registry,
      onRendererError,
    })
    app.use(i18n)
    app.mount(root)

    await vi.waitFor(() => expect(root!.querySelector('.generative-ui-fallback')).toBeTruthy())
    expect(root.textContent).toContain('Portable card')
    expect(root.textContent).toContain('The safe fallback remains readable.')
    expect(root.querySelector('iframe')).toBeNull()
    expect(onRendererError).toHaveBeenCalledWith({
      node_id: node.id,
      message: 'Custom Renderer source digest mismatch',
    })
  })
})

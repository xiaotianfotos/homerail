import {
  HOMERAIL_A2UI_MAX_BYTES,
  type GenerativeUiCompositionItemV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'

export const CUSTOM_RENDERER_BRIDGE_VERSION = 1 as const
export const CUSTOM_RENDERER_MAX_SOURCE_BYTES = 512 * 1024
export const CUSTOM_RENDERER_MAX_OUTPUT_BYTES = HOMERAIL_A2UI_MAX_BYTES
export const CUSTOM_RENDERER_MAX_JSON_DEPTH = 32
export const CUSTOM_RENDERER_MAX_JSON_NODES = 8_192
export const CUSTOM_RENDERER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  'worker-src blob:',
  "manifest-src 'none'",
  "form-action 'none'",
] as const

export interface CustomRendererIdentityV1 {
  plugin_id: string
  plugin_version: string
  renderer_id: string
  renderer_digest: string
  node_id: string
  node_revision: number
}

export interface CustomRendererInitPayloadV1 {
  node: GenerativeUiStoredNodeV1
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
}

export type CustomRendererBridgeMessageV1 =
  | ({ type: 'homerail.custom-renderer.ready' } & CustomRendererIdentityV1)
  | ({ type: 'homerail.custom-renderer.a2ui'; request_id: string; a2ui: unknown } & CustomRendererIdentityV1)
  | ({ type: 'homerail.custom-renderer.error'; message: string } & CustomRendererIdentityV1)

export interface CustomRendererMessageExpectationV1 {
  source: MessageEventSource | null
  origin: string
  identity: CustomRendererIdentityV1
  nonce: string
}

const COMMON_MESSAGE_KEYS = [
  'bridge_version',
  'type',
  'nonce',
  'plugin_id',
  'plugin_version',
  'renderer_id',
  'renderer_digest',
  'node_id',
  'node_revision',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, extra: string[] = []): boolean {
  const expected = [...COMMON_MESSAGE_KEYS, ...extra].sort()
  return Object.keys(value).sort().join('\0') === expected.join('\0')
}

function hasExactIdentity(value: Record<string, unknown>, identity: CustomRendererIdentityV1): boolean {
  return value.plugin_id === identity.plugin_id
    && value.plugin_version === identity.plugin_version
    && value.renderer_id === identity.renderer_id
    && value.renderer_digest === identity.renderer_digest
    && value.node_id === identity.node_id
    && value.node_revision === identity.node_revision
}

function jsonTransportClone(value: unknown): unknown {
  const visiting = new WeakSet<object>()
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes += 1
    if (nodes > CUSTOM_RENDERER_MAX_JSON_NODES || depth > CUSTOM_RENDERER_MAX_JSON_DEPTH) {
      throw new Error('Custom Renderer output exceeds its JSON structure limit')
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('Custom Renderer output contains a non-finite number')
      return
    }
    if (typeof current !== 'object') throw new Error('Custom Renderer output is not JSON serializable')
    if (visiting.has(current)) throw new Error('Custom Renderer output contains a cycle')
    visiting.add(current)
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || Object.keys(current).length !== current.length) {
        throw new Error('Custom Renderer output contains a non-JSON array')
      }
      current.forEach(item => visit(item, depth + 1))
    } else {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Custom Renderer output contains a custom prototype')
      }
      const descriptors = Object.getOwnPropertyDescriptors(current)
      if (Reflect.ownKeys(current).some(key => typeof key !== 'string')) {
        throw new Error('Custom Renderer output contains a symbol property')
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Custom Renderer output contains an accessor or hidden property')
        }
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          throw new Error('Custom Renderer output contains a forbidden property')
        }
        visit(descriptor.value, depth + 1)
      }
    }
    visiting.delete(current)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > CUSTOM_RENDERER_MAX_OUTPUT_BYTES) {
    throw new Error('Custom Renderer output exceeds its byte limit')
  }
  return JSON.parse(encoded) as unknown
}

/** Transport parser only. A2UI semantics are validated once by the parent host. */
export function readCustomRendererBridgeMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  expected: CustomRendererMessageExpectationV1,
): CustomRendererBridgeMessageV1 | undefined {
  if (event.source !== expected.source || event.origin !== expected.origin || !isRecord(event.data)) return undefined
  const value = event.data
  if (value.bridge_version !== CUSTOM_RENDERER_BRIDGE_VERSION
    || value.nonce !== expected.nonce
    || !hasExactIdentity(value, expected.identity)) return undefined
  const identity = structuredClone(expected.identity)
  if (value.type === 'homerail.custom-renderer.ready' && exactKeys(value)) {
    return { type: value.type, ...identity }
  }
  if (value.type === 'homerail.custom-renderer.a2ui'
    && exactKeys(value, ['request_id', 'a2ui'])
    && typeof value.request_id === 'string'
    && /^render-[1-9][0-9]*$/.test(value.request_id)) {
    try {
      return {
        type: value.type,
        ...identity,
        request_id: value.request_id,
        a2ui: jsonTransportClone(value.a2ui),
      }
    } catch {
      return undefined
    }
  }
  if (value.type === 'homerail.custom-renderer.error'
    && exactKeys(value, ['message'])
    && typeof value.message === 'string'
    && value.message.length > 0
    && value.message.length <= 500) {
    return { type: value.type, ...identity, message: value.message }
  }
  return undefined
}

export function createCustomRendererNonce(): string {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure Renderer nonce generation is unavailable')
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Utf8(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Renderer source digest verification is unavailable')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function validateCustomRendererModuleSource(source: string): void {
  const bytes = new TextEncoder().encode(source).byteLength
  if (!source.trim() || bytes > CUSTOM_RENDERER_MAX_SOURCE_BYTES || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(source)) {
    throw new Error('Custom Renderer module source is invalid')
  }
  if (/\bimport\b/.test(source)) throw new Error('Custom Renderer module imports are forbidden')
  const exports = source.match(/\bexport\b/g) ?? []
  if (exports.length !== 1 || !/\bexport\s+(?:async\s+)?function\s+render\s*\(\s*payload\s*\)\s*\{/.test(source)) {
    throw new Error('Custom Renderer must have exactly one named render export')
  }
}

export function customRendererInitEnvelope(
  identity: CustomRendererIdentityV1,
  nonce: string,
  payload: CustomRendererInitPayloadV1,
): Record<string, unknown> {
  return {
    bridge_version: CUSTOM_RENDERER_BRIDGE_VERSION,
    type: 'homerail.custom-renderer.init',
    nonce,
    ...structuredClone(identity),
    payload: structuredClone(payload),
  }
}

export const CUSTOM_RENDERER_WORKER_BOOTSTRAP = String.raw`
(() => {
  'use strict';
  const safePostMessage = globalThis.postMessage.bind(globalThis);
  const safeAddEventListener = globalThis.addEventListener.bind(globalThis);
  const safeStructuredClone = globalThis.structuredClone.bind(globalThis);
  const safeObjectKeys = Object.keys.bind(Object);
  const safeOwnKeys = Reflect.ownKeys.bind(Reflect);
  const safeDescriptors = Object.getOwnPropertyDescriptors.bind(Object);
  const safeGetPrototypeOf = Object.getPrototypeOf.bind(Object);
  const safeObjectCreate = Object.create.bind(Object);
  const safeHasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
  const safeIsArray = Array.isArray.bind(Array);
  const safeIsFinite = Number.isFinite.bind(Number);
  const safeStringify = JSON.stringify.bind(JSON);
  const safeParse = JSON.parse.bind(JSON);
  const safeEncode = new TextEncoder().encode.bind(new TextEncoder());
  const SafeSet = Set;
  const SafeWeakSet = WeakSet;
  const safeSetHas = Function.call.bind(Set.prototype.has);
  const safeSetAdd = Function.call.bind(Set.prototype.add);
  const safeWeakHas = Function.call.bind(WeakSet.prototype.has);
  const safeWeakAdd = Function.call.bind(WeakSet.prototype.add);
  const safeWeakDelete = Function.call.bind(WeakSet.prototype.delete);
  const safeArrayPrototype = Array.prototype;
  const safeObjectPrototype = Object.prototype;
  const exact = (value, required) => {
    if (!value || typeof value !== 'object' || safeIsArray(value)) return false;
    const keys = safeObjectKeys(value);
    if (keys.length !== required.length) return false;
    for (let index = 0; index < required.length; index += 1) if (!safeHasOwn(value, required[index])) return false;
    const allowed = new SafeSet(required);
    for (let index = 0; index < keys.length; index += 1) if (!safeSetHas(allowed, keys[index])) return false;
    return true;
  };
  const exactIdentity = value => exact(value, [
    'plugin_id','plugin_version','renderer_id','renderer_digest','node_id','node_revision',
  ]) && typeof value.plugin_id === 'string' && typeof value.plugin_version === 'string'
    && typeof value.renderer_id === 'string' && /^[a-f0-9]{64}$/.test(value.renderer_digest)
    && typeof value.node_id === 'string' && Number.isSafeInteger(value.node_revision);
  const sameIdentity = (left, right) => left.plugin_id === right.plugin_id
    && left.plugin_version === right.plugin_version && left.renderer_id === right.renderer_id
    && left.renderer_digest === right.renderer_digest && left.node_id === right.node_id
    && left.node_revision === right.node_revision;
  const lock = name => {
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
  };
  for (const name of [
    'fetch','XMLHttpRequest','WebSocket','WebSocketStream','EventSource','RTCPeerConnection',
    'WebTransport','Worker','SharedWorker','importScripts','BroadcastChannel','postMessage',
    'caches','indexedDB',
  ]) lock(name);
  try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined, writable: false, configurable: false }); } catch {}

  const jsonClone = raw => {
    const visiting = new SafeWeakSet();
    let nodes = 0;
    const clone = (value, depth) => {
      nodes += 1;
      if (nodes > 8192 || depth > 32) throw new Error('Renderer output exceeds its JSON structure limit');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (!safeIsFinite(value)) throw new Error('Renderer output contains a non-finite number');
        return value;
      }
      if (typeof value !== 'object') throw new Error('Renderer output is not JSON serializable');
      if (safeWeakHas(visiting, value)) throw new Error('Renderer output contains a cycle');
      safeWeakAdd(visiting, value);
      let result;
      if (safeIsArray(value)) {
        if (safeGetPrototypeOf(value) !== safeArrayPrototype || safeObjectKeys(value).length !== value.length) {
          throw new Error('Renderer output contains a non-JSON array');
        }
        result = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!safeHasOwn(value, String(index))) throw new Error('Renderer output contains a sparse array');
          result.push(clone(value[index], depth + 1));
        }
      } else {
        const prototype = safeGetPrototypeOf(value);
        if (prototype !== safeObjectPrototype && prototype !== null) throw new Error('Renderer output contains a custom prototype');
        const keys = safeOwnKeys(value);
        const descriptors = safeDescriptors(value);
        result = safeObjectCreate(null);
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          if (typeof key !== 'string') throw new Error('Renderer output contains a symbol property');
          const descriptor = descriptors[key];
          if (!descriptor || !descriptor.enumerable || !safeHasOwn(descriptor, 'value')) {
            throw new Error('Renderer output contains an accessor or hidden property');
          }
          if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            throw new Error('Renderer output contains a forbidden property');
          }
          result[key] = clone(descriptor.value, depth + 1);
        }
      }
      safeWeakDelete(visiting, value);
      return result;
    };
    const cloned = clone(raw, 0);
    const encoded = safeStringify(cloned);
    if (encoded === undefined || safeEncode(encoded).byteLength > ${HOMERAIL_A2UI_MAX_BYTES}) throw new Error('Renderer output exceeds its byte limit');
    return safeParse(encoded);
  };

  let configured = false;
  let identity;
  let nonce;
  let renderFunction;
  const send = (type, extra = {}) => safePostMessage({
    worker_protocol: 1, type, nonce, identity: safeStructuredClone(identity), ...extra,
  });
  const fail = (requestId, cause) => {
    const message = String(cause && cause.message ? cause.message : cause || 'Renderer Worker failed').slice(0, 500);
    send('homerail.custom-renderer.worker.error', { ...(requestId ? { request_id: requestId } : {}), message });
  };
  safeAddEventListener('message', async event => {
    const value = event.data;
    if (!configured) {
      if (!exact(value, ['worker_protocol','type','nonce','identity','source'])
        || value.worker_protocol !== 1 || value.type !== 'homerail.custom-renderer.worker.configure'
        || typeof value.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(value.nonce)
        || !exactIdentity(value.identity) || typeof value.source !== 'string'
        || value.source.length < 1 || safeEncode(value.source).byteLength > 524288
        || /\bimport\b/.test(value.source)
        || (value.source.match(/\bexport\b/g) || []).length !== 1
        || !/\bexport\s+(?:async\s+)?function\s+render\s*\(\s*payload\s*\)\s*\{/.test(value.source)) return;
      configured = true;
      identity = safeStructuredClone(value.identity);
      nonce = value.nonce;
      const moduleUrl = URL.createObjectURL(new Blob([value.source], { type: 'text/javascript' }));
      try {
        const module = await import(moduleUrl);
        if (typeof module.render !== 'function') throw new Error('Custom Renderer must export render(payload)');
        renderFunction = module.render;
        send('homerail.custom-renderer.worker.ready');
      } catch (cause) { fail(undefined, cause); }
      finally { URL.revokeObjectURL(moduleUrl); }
      return;
    }
    if (!exact(value, ['worker_protocol','type','nonce','identity','request_id','payload'])
      || value.worker_protocol !== 1 || value.type !== 'homerail.custom-renderer.worker.render'
      || value.nonce !== nonce || !exactIdentity(value.identity) || !sameIdentity(value.identity, identity)
      || typeof value.request_id !== 'string' || !/^render-[1-9][0-9]*$/.test(value.request_id)
      || !value.payload || typeof value.payload !== 'object' || safeIsArray(value.payload)) return;
    try {
      const rawA2ui = await renderFunction(safeStructuredClone(value.payload));
      send('homerail.custom-renderer.worker.a2ui', {
        request_id: value.request_id,
        a2ui: jsonClone(rawA2ui),
      });
    } catch (cause) { fail(value.request_id, cause); }
  });
})();
`

export function buildCustomRendererSrcdoc(input: {
  source: string
  nonce: string
  identity: CustomRendererIdentityV1
  parent_origin: string
}): string {
  if (!/^https?:\/\/[^/]+$/.test(input.parent_origin)) {
    throw new Error('Custom Renderer parent origin must be an HTTP(S) origin')
  }
  validateCustomRendererModuleSource(input.source)
  const csp = [
    ...CUSTOM_RENDERER_CSP,
    `script-src 'nonce-${input.nonce}' blob:`,
  ].join('; ')
  const source = inlineJson(input.source)
  const workerBootstrap = inlineJson(CUSTOM_RENDERER_WORKER_BOOTSTRAP)
  const identity = inlineJson(input.identity)
  const nonce = inlineJson(input.nonce)
  const parentOrigin = inlineJson(input.parent_origin)
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${csp}">
</head><body>
<script nonce="${input.nonce}">
(() => {
  'use strict';
  const identity = ${identity};
  const nonce = ${nonce};
  const parentOrigin = ${parentOrigin};
  const pluginSource = ${source};
  const workerBootstrap = ${workerBootstrap};
  let initialized = false;
  let workerReady = false;
  let failed = false;
  let pendingPayload;
  let requestSequence = 0;
  let activeRequest;
  let requestTimer;
  const identityKeys = ['plugin_id','plugin_version','renderer_id','renderer_digest','node_id','node_revision'].sort();
  const exactIdentity = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\\0') === identityKeys.join('\\0')
    && value.plugin_id === identity.plugin_id && value.plugin_version === identity.plugin_version
    && value.renderer_id === identity.renderer_id && value.renderer_digest === identity.renderer_digest
    && value.node_id === identity.node_id && value.node_revision === identity.node_revision;
  const initKeys = ['bridge_version','type','nonce',...identityKeys,'payload'].sort();
  const exactInit = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\\0') === initKeys.join('\\0')
    && value.bridge_version === 1 && value.type === 'homerail.custom-renderer.init'
    && value.nonce === nonce && exactIdentity(Object.fromEntries(identityKeys.map(key => [key, value[key]])))
    && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    && Object.keys(value.payload).sort().join('\\0') === ['context','node','placement'].join('\\0');
  const send = (type, extra = {}) => parent.postMessage({ bridge_version: 1, type, nonce, ...identity, ...extra }, parentOrigin);
  const workerUrl = URL.createObjectURL(new Blob([workerBootstrap], { type: 'text/javascript' }));
  const worker = new Worker(workerUrl, { name: 'homerail-custom-renderer' });
  const stopWorker = () => {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  };
  const fail = cause => {
    if (failed) return;
    failed = true;
    clearTimeout(requestTimer);
    stopWorker();
    send('homerail.custom-renderer.error', { message: String(cause && cause.message ? cause.message : cause || 'Renderer failed').slice(0, 500) });
  };
  const dispatchRender = payload => {
    if (!workerReady) { pendingPayload = payload; return; }
    requestSequence += 1;
    activeRequest = 'render-' + requestSequence;
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => fail(new Error('Custom Renderer Worker timed out')), 2000);
    worker.postMessage({
      worker_protocol: 1,
      type: 'homerail.custom-renderer.worker.render',
      nonce,
      identity,
      request_id: activeRequest,
      payload: structuredClone(payload),
    });
  };
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== parentOrigin || initialized || !exactInit(event.data)) return;
    initialized = true;
    dispatchRender(event.data.payload);
  });
  worker.addEventListener('message', event => {
    const value = event.data;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.worker_protocol !== 1 || value.nonce !== nonce || !exactIdentity(value.identity)) return;
    const keys = Object.keys(value).sort().join('\\0');
    if (value.type === 'homerail.custom-renderer.worker.ready'
      && keys === ['identity','nonce','type','worker_protocol'].join('\\0')) {
      workerReady = true;
      clearTimeout(bootstrapTimer);
      URL.revokeObjectURL(workerUrl);
      send('homerail.custom-renderer.ready');
      if (pendingPayload) {
        const payload = pendingPayload;
        pendingPayload = undefined;
        dispatchRender(payload);
      }
      return;
    }
    if (value.type === 'homerail.custom-renderer.worker.a2ui'
      && keys === ['a2ui','identity','nonce','request_id','type','worker_protocol'].join('\\0')
      && value.request_id === activeRequest) {
      clearTimeout(requestTimer);
      send('homerail.custom-renderer.a2ui', { request_id: value.request_id, a2ui: value.a2ui });
      stopWorker();
      return;
    }
    if (value.type === 'homerail.custom-renderer.worker.error'
      && (keys === ['identity','message','nonce','type','worker_protocol'].join('\\0')
        || keys === ['identity','message','nonce','request_id','type','worker_protocol'].join('\\0'))
      && (value.request_id === undefined || value.request_id === activeRequest)
      && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 500) {
      fail(new Error(value.message));
    }
  });
  worker.addEventListener('error', event => fail(event.error || event.message));
  worker.postMessage({
    worker_protocol: 1,
    type: 'homerail.custom-renderer.worker.configure',
    nonce,
    identity,
    source: pluginSource,
  });
  const bootstrapTimer = setTimeout(() => fail(new Error('Custom Renderer Worker failed to initialize')), 2000);
})();
</script></body></html>`
}

import { describe, expect, it } from 'vitest'
import {
  asrRealtimeCapability,
  decideAsrRealtimeUrlPersistence,
  isVerifiedAsrRealtimeProbe,
  type AsrRealtimeProbeLike
} from './asr-endpoint-capability'

// Reporter's production case (issue #193): a local SenseVoice-compatible
// service answers POST /v1/audio/transcriptions but has no native
// /v1/realtime WebSocket endpoint. Pre-upgrade 401/403/404 responses for
// the derived ws:// URL must never be treated as realtime support.
const SENSEVOICE_BATCH_URL = 'http://192.168.100.10:5002/v1/audio/transcriptions'
const SENSEVOICE_DERIVED_REALTIME_URL = 'ws://192.168.100.10:5002/v1/realtime'

function legacyWebSocketResult(partial: Partial<AsrRealtimeProbeLike>): AsrRealtimeProbeLike {
  return {
    url: SENSEVOICE_DERIVED_REALTIME_URL,
    kind: 'websocket',
    message: 'probe',
    ...partial
  }
}

describe('asrRealtimeCapability', () => {
  it('treats a completed WebSocket upgrade as verified (legacy shape)', () => {
    const result = legacyWebSocketResult({ ok: true, reachable: true, message: 'WebSocket handshake succeeded' })
    expect(asrRealtimeCapability(result)).toBe('verified')
    expect(isVerifiedAsrRealtimeProbe(result)).toBe(true)
  })

  it.each([401, 403])('treats pre-upgrade HTTP %i as authentication-required, not verified', (status) => {
    // Legacy Manager builds answered ok=true for 401/403; the capability
    // rule must not trust that signal.
    const legacyOk = legacyWebSocketResult({ ok: true, reachable: true, status_code: status })
    expect(asrRealtimeCapability(legacyOk)).toBe('authentication_required')
    expect(isVerifiedAsrRealtimeProbe(legacyOk)).toBe(false)

    const explicit = legacyWebSocketResult({
      ok: false,
      reachable: true,
      status_code: status,
      capability: 'authentication_required'
    })
    expect(asrRealtimeCapability(explicit)).toBe('authentication_required')
    expect(isVerifiedAsrRealtimeProbe(explicit)).toBe(false)
  })

  it.each([404, 405])('treats pre-upgrade HTTP %i as not-found, not verified', (status) => {
    const result = legacyWebSocketResult({ ok: false, reachable: true, status_code: status })
    expect(asrRealtimeCapability(result)).toBe('not_found')
    expect(isVerifiedAsrRealtimeProbe(result)).toBe(false)
  })

  it.each([400, 418, 500, 503])('treats other pre-upgrade HTTP %i as rejected, not verified', (status) => {
    const result = legacyWebSocketResult({ ok: status < 500, reachable: true, status_code: status })
    expect(asrRealtimeCapability(result)).toBe('rejected')
    expect(isVerifiedAsrRealtimeProbe(result)).toBe(false)
  })

  it('treats network failures as unreachable', () => {
    const result = legacyWebSocketResult({ ok: false, reachable: false, message: 'connect ECONNREFUSED' })
    expect(asrRealtimeCapability(result)).toBe('unreachable')
    expect(isVerifiedAsrRealtimeProbe(result)).toBe(false)
  })

  it('treats a socket closed before the handshake as rejected', () => {
    const result = legacyWebSocketResult({ ok: false, reachable: true, message: 'WebSocket closed before the handshake completed' })
    expect(asrRealtimeCapability(result)).toBe('rejected')
  })

  it('trusts an explicit capability outcome over legacy heuristics', () => {
    expect(asrRealtimeCapability({ capability: 'verified', ok: true, reachable: true })).toBe('verified')
    expect(asrRealtimeCapability({ capability: 'authentication_required', ok: false, reachable: true, status_code: 401 }))
      .toBe('authentication_required')
    expect(asrRealtimeCapability({ outcome: 'not-found', ok: false, reachable: true, status_code: 404 }))
      .toBe('not_found')
    expect(asrRealtimeCapability({ capability: 'auth_required', ok: false, reachable: true, status_code: 403 }))
      .toBe('authentication_required')
    expect(asrRealtimeCapability({ capability: 'unreachable', ok: false, reachable: false }))
      .toBe('unreachable')
  })

  it('never reports verified without a probe result', () => {
    expect(asrRealtimeCapability(undefined)).toBe('unreachable')
    expect(asrRealtimeCapability(null)).toBe('unreachable')
    expect(isVerifiedAsrRealtimeProbe(undefined)).toBe(false)
  })
})

describe('decideAsrRealtimeUrlPersistence', () => {
  const verifiedProbe = legacyWebSocketResult({ ok: true, reachable: true })
  const authRequiredProbe = legacyWebSocketResult({ ok: true, reachable: true, status_code: 401 })

  it('persists a verified derived candidate automatically', () => {
    const decision = decideAsrRealtimeUrlPersistence({
      derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL,
      probeResult: verifiedProbe
    })
    expect(decision).toEqual({ url: SENSEVOICE_DERIVED_REALTIME_URL, reason: 'verified' })
  })

  it.each([401, 403, 404])(
    'does not persist the derived candidate when the batch endpoint works but the probe returned %i',
    (status) => {
      const decision = decideAsrRealtimeUrlPersistence({
        derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL,
        probeResult: legacyWebSocketResult({ ok: status < 404, reachable: true, status_code: status })
      })
      expect(decision.url).toBe('')
      expect(decision.reason).toBe('unverified')
    }
  )

  it('does not persist the derived candidate without a probe result', () => {
    expect(decideAsrRealtimeUrlPersistence({ derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL }).url).toBe('')
    expect(decideAsrRealtimeUrlPersistence({}).url).toBe('')
  })

  it('keeps a user-entered URL even when the probe failed or never ran', () => {
    const explicit = 'ws://speech.example/custom-realtime'
    expect(decideAsrRealtimeUrlPersistence({ explicitUrl: explicit, derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL }))
      .toEqual({ url: explicit, reason: 'explicit' })
    expect(decideAsrRealtimeUrlPersistence({ explicitUrl: explicit, probeResult: authRequiredProbe }))
      .toEqual({ url: explicit, reason: 'explicit' })
  })

  it('keeps an explicitly cleared URL empty even when a derived candidate is verified', () => {
    expect(decideAsrRealtimeUrlPersistence({ explicitUrl: '', derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL }))
      .toEqual({ url: '', reason: 'cleared' })
    expect(decideAsrRealtimeUrlPersistence({
      explicitUrl: '   ',
      derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL,
      probeResult: verifiedProbe
    })).toEqual({ url: '', reason: 'cleared' })
  })

  it('trims surrounding whitespace from explicit and derived URLs', () => {
    expect(decideAsrRealtimeUrlPersistence({ explicitUrl: '  ws://a.example/rt  ' }).url)
      .toBe('ws://a.example/rt')
    expect(decideAsrRealtimeUrlPersistence({
      derivedUrl: `  ${SENSEVOICE_DERIVED_REALTIME_URL}  `,
      probeResult: verifiedProbe
    }).url).toBe(SENSEVOICE_DERIVED_REALTIME_URL)
  })
})

describe('SenseVoice regression: batch HTTP works, derived realtime is not native', () => {
  it.each([
    ['legacy ok=true 401', { ok: true, reachable: true, status_code: 401 }],
    ['explicit authentication_required 401', { ok: false, reachable: true, status_code: 401, capability: 'authentication_required' }],
    ['legacy ok=true 403', { ok: true, reachable: true, status_code: 403 }],
    ['explicit authentication_required 403', { ok: false, reachable: true, status_code: 403, capability: 'authentication_required' }],
    ['legacy 404', { ok: false, reachable: true, status_code: 404 }],
    ['explicit not_found 404', { ok: false, reachable: true, status_code: 404, capability: 'not_found' }]
  ])('persists the batch endpoint but not the realtime URL for %s', (_label, realtimeProbe) => {
    const batchResult = {
      id: 'asr_http',
      kind: 'http',
      url: SENSEVOICE_BATCH_URL,
      ok: true,
      reachable: true,
      status_code: 200,
      message: 'Endpoint is reachable'
    }
    expect(batchResult.ok).toBe(true)

    const decision = decideAsrRealtimeUrlPersistence({
      derivedUrl: SENSEVOICE_DERIVED_REALTIME_URL,
      probeResult: legacyWebSocketResult(realtimeProbe)
    })
    expect(decision.url).toBe('')
    expect(decision.reason).toBe('unverified')
    expect(isVerifiedAsrRealtimeProbe(legacyWebSocketResult(realtimeProbe))).toBe(false)
  })
})

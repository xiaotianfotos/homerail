import { describe, expect, it } from 'vitest'
import type { DAGNodeResult } from '@/api/types/dag.types'
import {
  asJoinPayload,
  previewValue,
  prettyValue,
  resolveCommandEnvelope,
  resolveCommandValue,
} from './dagNodeResultPresentation'

function makeResult(overrides: Partial<DAGNodeResult>): DAGNodeResult {
  return {
    node_id: 'n1',
    node_name: 'n1',
    node_type: 'agent',
    result_kind: 'worker',
    status: 'completed',
    latest: null,
    handoffs: [],
    ...overrides,
  }
}

describe('dagNodeResultPresentation', () => {
  describe('resolveCommandEnvelope', () => {
    it('prefers the telemetry envelope over handoff content', () => {
      const result = makeResult({
        result_kind: 'command',
        latest: { port: 'passed', content: { verdict: 'pass' }, timestamp: '2026-01-01T00:00:00Z' },
        telemetry: { ok: true, exit_code: 0, stdout: '{"verdict":"pass"}' },
      })
      expect(resolveCommandEnvelope(result)).toMatchObject({ ok: true, exit_code: 0 })
    })

    it('falls back to an envelope-shaped handoff content', () => {
      const result = makeResult({
        result_kind: 'command',
        latest: {
          port: 'passed',
          content: { ok: true, command: 'node', exit_code: 0, stdout: 'ready' },
          timestamp: '2026-01-01T00:00:00Z',
        },
      })
      expect(resolveCommandEnvelope(result)).toMatchObject({ ok: true, stdout: 'ready' })
    })

    it('returns null when neither telemetry nor envelope content exists', () => {
      const result = makeResult({
        result_kind: 'command',
        latest: { port: 'passed', content: 'plain value', timestamp: '2026-01-01T00:00:00Z' },
      })
      expect(resolveCommandEnvelope(result)).toBeNull()
    })
  })

  describe('resolveCommandValue', () => {
    it('returns the handoff value when it is not an envelope', () => {
      const result = makeResult({
        result_kind: 'command',
        latest: { port: 'passed', content: { verdict: 'pass' }, timestamp: '2026-01-01T00:00:00Z' },
        telemetry: { ok: true, exit_code: 0 },
      })
      expect(resolveCommandValue(result)).toEqual({ verdict: 'pass' })
    })

    it('returns undefined when the handoff content is the envelope itself', () => {
      const result = makeResult({
        result_kind: 'command',
        latest: { port: 'passed', content: { ok: true, exit_code: 0 }, timestamp: '2026-01-01T00:00:00Z' },
      })
      expect(resolveCommandValue(result)).toBeUndefined()
    })
  })

  describe('asJoinPayload', () => {
    it('accepts join-shaped payloads', () => {
      expect(asJoinPayload({ mode: 'all', successes: 2, passed: true })).toMatchObject({ successes: 2 })
    })

    it('rejects non-join payloads', () => {
      expect(asJoinPayload('text')).toBeNull()
      expect(asJoinPayload({ unrelated: true })).toBeNull()
      expect(asJoinPayload(null)).toBeNull()
    })
  })

  describe('previewValue / prettyValue', () => {
    it('truncates long values for list previews', () => {
      const long = 'x'.repeat(300)
      expect(previewValue(long, 100).length).toBe(100)
    })

    it('serializes objects compactly for previews and expanded for details', () => {
      const value = { a: 1 }
      expect(previewValue(value)).toBe('{"a":1}')
      expect(prettyValue(value)).toBe('{\n  "a": 1\n}')
    })

    it('keeps strings as-is for detail blocks', () => {
      expect(prettyValue('raw text')).toBe('raw text')
    })
  })
})

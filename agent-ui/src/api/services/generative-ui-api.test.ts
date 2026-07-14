import { afterEach, describe, expect, it, vi } from 'vitest'
import { http } from '@/api/clients/http-client'
import {
  confirmPluginAgentTool,
  confirmPluginAction,
  invokePluginAction,
  normalizeAgentToolResponse,
  normalizePendingAgentToolConfirmations,
  normalizePluginActionResponse,
  type InvokePluginActionRequest,
} from './generative-ui-api'

const request: InvokePluginActionRequest = {
  request_id: 'ui:request-12345678',
  idempotency_key: 'ui:request-12345678',
  scope: { type: 'voice_session', id: 'session-one' },
  document_id: 'document-one',
  document_revision: 7,
  node_id: 'node-one',
  node_revision: 3,
  action_id: 'approve',
  input: { value: true },
}

const digest = 'a'.repeat(64)
const agentRequestId = 'agent:request-12345678'
const agentTool = {
  local_id: 'publish_card',
  qualified_id: 'com.example.plugin:publish_card',
  wire_id: 'p_1234567890_publish_card',
}
const agentChallenge = {
  confirmation_version: 1 as const,
  challenge_id: 'confirm:challenge-12345678',
  request_id: agentRequestId,
  request_digest: digest,
  effect: 'external' as const,
  permissions: ['network.connect'] as const,
  effective_grants: [{ permission: 'network.connect' as const, hosts: ['api.example.com'] }],
  message: 'Allow the Agent Tool to publish this card?',
  issued_at: '2026-07-12T01:00:00.000Z',
  expires_at: '2026-07-12T01:04:00.000Z',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Generative UI plugin Action API', () => {
  it('posts only the minimal interaction to the Manager Action endpoint', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: {
        request_id: request.request_id,
        request_digest: digest,
        status: 'needs_grant',
        missing_permissions: ['network'],
      },
    })

    await expect(invokePluginAction(request)).resolves.toMatchObject({
      data: { status: 'needs_grant', missing_permissions: ['network'] },
    })
    expect(post).toHaveBeenCalledWith('/api/plugins/actions', request)
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('action_intent')
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('plugin_id')
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('created_at')
  })

  it('posts confirmation decisions to the request-scoped endpoint', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: {
        request_id: request.request_id,
        request_digest: digest,
        status: 'committed',
        result: { document_revision: 8 },
      },
    })

    await expect(confirmPluginAction(request.request_id, {
      challenge_id: 'challenge-12345678',
      decision: 'approved',
    })).resolves.toMatchObject({
      data: { status: 'committed', result: { document_revision: 8 } },
    })
    expect(post).toHaveBeenCalledWith(
      '/api/plugins/actions/ui%3Arequest-12345678/confirmation',
      { challenge_id: 'challenge-12345678', decision: 'approved' },
    )
  })

  it('rejects an awaiting response without an exact confirmation challenge', () => {
    expect(() => normalizePluginActionResponse({
      request_id: request.request_id,
      request_digest: digest,
      status: 'awaiting_confirmation',
    })).toThrow('confirmation challenge is required')
  })

  it('rejects challenge bindings that disagree with the request', () => {
    expect(() => normalizePluginActionResponse({
      request_id: request.request_id,
      request_digest: digest,
      status: 'awaiting_confirmation',
      challenge: {
        challenge_id: 'challenge-12345678',
        request_id: 'different-request',
        request_digest: digest,
        effect: 'write',
        permissions: ['network.connect'],
        effective_grants: [{ permission: 'network.connect', hosts: ['api.example.com'] }],
        message: 'Approve this action?',
        expires_at: '2026-07-12T01:05:00.000Z',
      },
    })).toThrow('challenge request binding mismatch')
  })

  it('requires exact effect and scoped grants for every confirmation challenge', () => {
    const challenge = {
      challenge_id: 'challenge-12345678',
      request_id: request.request_id,
      request_digest: digest,
      effect: 'external',
      permissions: ['network.connect'],
      effective_grants: [{ permission: 'network.connect', hosts: ['api.example.com'] }],
      message: 'Approve this action?',
      expires_at: '2026-07-12T01:05:00.000Z',
    }
    expect(normalizePluginActionResponse({
      request_id: request.request_id,
      request_digest: digest,
      status: 'awaiting_confirmation',
      challenge,
    })).toMatchObject({ challenge })
    expect(() => normalizePluginActionResponse({
      request_id: request.request_id,
      request_digest: digest,
      status: 'awaiting_confirmation',
      challenge: { ...challenge, effective_grants: [] },
    })).toThrow('effective grants do not match permissions')
  })

  it('rejects unknown terminal states and malformed digests', () => {
    expect(() => normalizePluginActionResponse({
      request_id: request.request_id,
      status: 'finished',
    })).toThrow('unknown status')
    expect(() => normalizePluginActionResponse({
      request_id: request.request_id,
      request_digest: 'not-a-digest',
      status: 'failed',
    })).toThrow('request_digest must be SHA-256')
  })
})

describe('Generative UI Agent Tool confirmation API', () => {
  it('posts a request-bound decision to the dedicated Tool endpoint and validates the response', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: {
        request_id: agentRequestId,
        request_digest: digest,
        status: 'denied',
        idempotent: false,
        tool: agentTool,
        source: 'agent',
      },
    })

    await expect(confirmPluginAgentTool(agentRequestId, {
      challenge_id: agentChallenge.challenge_id,
      decision: 'denied',
    })).resolves.toMatchObject({ data: { status: 'denied', source: 'agent' } })
    expect(post).toHaveBeenCalledWith(
      '/api/plugins/tools/agent%3Arequest-12345678/confirmation',
      { challenge_id: agentChallenge.challenge_id, decision: 'denied' },
    )
  })

  it('accepts only exact Manager-owned pending Agent Tool confirmation snapshots', () => {
    const pending = {
      request_id: agentRequestId,
      request_digest: digest,
      status: 'awaiting_confirmation',
      idempotent: true,
      tool: agentTool,
      source: 'agent',
      challenge: agentChallenge,
    }
    expect(normalizePendingAgentToolConfirmations([pending])).toEqual([pending])
    expect(() => normalizePendingAgentToolConfirmations([{
      ...pending,
      source: 'ui_action',
    }])).toThrow('source must be agent')
    expect(() => normalizePendingAgentToolConfirmations([{
      ...pending,
      injected_policy: 'allow-all',
    }])).toThrow('unknown field injected_policy')
    expect(() => normalizePendingAgentToolConfirmations([{
      ...pending,
      challenge: { ...agentChallenge, request_digest: 'b'.repeat(64) },
    }])).toThrow('challenge request binding mismatch')
  })

  it('rejects non-canonical Tool identities and unknown confirmation response fields', () => {
    const response = {
      request_id: agentRequestId,
      request_digest: digest,
      status: 'committed',
      idempotent: false,
      tool: agentTool,
      source: 'agent',
      result: { document_revision: 2 },
    }
    expect(normalizeAgentToolResponse(response)).toEqual(response)
    expect(() => normalizeAgentToolResponse({
      ...response,
      tool: { ...agentTool, qualified_id: 'not-qualified' },
    })).toThrow('tool identity is not canonical')
    expect(() => normalizeAgentToolResponse({ ...response, action_id: 'approve' }))
      .toThrow('unknown field action_id')
  })
})

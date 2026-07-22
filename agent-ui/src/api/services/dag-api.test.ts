import { afterEach, describe, expect, it, vi } from 'vitest'

import { http } from '../clients/http-client'
import {
  getDagEvents,
  getDagExperienceIngestStatus,
  getDagManagerChat,
  getDagNodeChat,
  getDagNodeDetail,
  getDagRunMetrics,
  getDagStatus,
  retryDagExperienceIngest
} from './dag-api'

function backendDag(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: 'run-1',
    graph: {
      nodes: [
        { node_id: 'plan', name: 'Plan', node_type: 'agent', agent: 'planner' },
        {
          node_id: 'review',
          name: 'Review quorum',
          node_type: 'join_gateway',
          agent: '__gateway__',
          gateway_config: { mode: 'n_of_m', threshold: 2 }
        }
      ],
      edges: [
        { from_node: 'plan', to_node: 'review', condition: 'success' },
        { from_node: 'review', to_node: '', condition: '' }
      ]
    },
    execution: {
      complete: false,
      active_nodes: ['plan'],
      completed_nodes: [],
      failed_nodes: [],
      ready_nodes: [],
      node_count: 2,
      nodes: {
        plan: {
          status: 'running',
          retry_count: 1,
          started_at: '2026-07-10T00:00:00Z',
          completed_at: null,
          token_usage: { input_tokens: 12, output_tokens: 4 },
          context_limit: 1000,
          context_usage_pct: 1.6,
          latest_todos: [{ content: 'Inspect', status: 'in_progress' }]
        }
      },
      ...overrides
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DAG API', () => {
  it('transforms graph and execution state into the UI DAG contract', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: backendDag() })

    await expect(getDagStatus('run-1')).resolves.toEqual({
      dag_run_id: 'run-1',
      status: 'running',
      nodes: [
        expect.objectContaining({
          id: 'plan',
          name: 'Plan',
          node_type: 'agent',
          agent_id: 'planner',
          agent_name: 'planner',
          status: 'running',
          dependencies: [],
          retry_count: 1,
          started_at: '2026-07-10T00:00:00Z',
          completed_at: undefined,
          token_usage: {
            input_tokens: 12,
            output_tokens: 4,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          },
          context_limit: 1000,
          context_usage_pct: 1.6,
          latest_todos: [{ content: 'Inspect', status: 'in_progress' }]
        }),
        expect.objectContaining({
          id: 'review',
          name: 'Review quorum',
          node_type: 'join_gateway',
          gateway_config: { mode: 'n_of_m', threshold: 2 },
          agent_id: '',
          agent_name: 'Review quorum',
          status: 'pending',
          dependencies: ['plan'],
          token_usage: undefined
        })
      ],
      edges: [
        {
          id: 'e-0',
          source: 'plan',
          target: 'review',
          condition: 'success'
        }
      ]
    })
  })

  it.each([
    [{ status: 'cancelled', complete: true, failed_nodes: [] }, 'cancelled'],
    [{ complete: true, failed_nodes: [] }, 'completed'],
    [{ complete: true, failed_nodes: ['review'] }, 'failed'],
    [{ complete: false, active_nodes: [], ready_nodes: ['review'] }, 'running'],
    [{
      complete: false,
      active_nodes: [],
      ready_nodes: [],
      waiting_nodes: ['plan'],
      nodes: { plan: { status: 'waiting_for_command', retry_count: 0, started_at: null, completed_at: null } }
    }, 'waiting'],
    [{ complete: false, active_nodes: [], ready_nodes: [] }, 'pending']
  ])('derives the overall DAG status from execution state', async (execution, status) => {
    vi.spyOn(http, 'get').mockResolvedValue({
      success: true,
      data: backendDag(execution)
    })

    await expect(getDagStatus('run-1')).resolves.toMatchObject({ status })
  })

  it('returns null for failed, empty, or malformed DAG responses', async () => {
    vi.spyOn(http, 'get')
      .mockResolvedValueOnce({ success: false, data: null })
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({ success: true, data: { graph: {} } })

    await expect(getDagStatus('failed')).resolves.toBeNull()
    await expect(getDagStatus('empty')).resolves.toBeNull()
    await expect(getDagStatus('malformed')).resolves.toBeNull()
  })

  it('returns node details from the transport payload', async () => {
    const detail = { id: 'plan', status: 'running' }
    const get = vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: detail })

    await expect(getDagNodeDetail('run-1', 'plan')).resolves.toBe(detail)
    expect(get).toHaveBeenCalledWith('/api/dag-status/run-1/node/plan')
  })

  it('converts worker chat events and filters diagnostic entries', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({
      success: true,
      data: {
        messages: [
          null,
          { content: 'not-an-event' },
          {
            timestamp: '2026-07-10T00:00:00Z',
            targetId: 'worker-1',
            content: { event: 'text', text: 'Implemented' }
          },
          {
            timestamp: '2026-07-10T00:00:01Z',
            targetId: 'worker-1',
            content: { type: 'content', content: 'Verified' }
          },
          {
            role: 'worker',
            type: 'response',
            timestamp: '2026-07-10T00:00:02Z',
            targetId: 'worker-1',
            content: {
              text: 'Persisted worker response',
              run_id: 'run-1',
              node_id: 'plan',
              session_id: 'session-1'
            }
          },
          {
            role: 'manager',
            type: 'response',
            content: { text: 'Not a node response' }
          },
          {
            targetId: 'worker-1',
            content: { event: 'thinking', summary: 'Checking behavior' }
          },
          {
            targetId: 'worker-1',
            content: {
              event: 'tool_use',
              tool_id: 'tool-1',
              tool_name: 'mcp__dag-tools__handoff',
              tool_input: { artifact: 'review' }
            }
          },
          {
            targetId: 'worker-1',
            content: {
              event: 'tool_result',
              tool_use_id: 'tool-1',
              result_preview: 'done',
              is_error: true
            }
          },
          { content: { event: 'agent_debug', message: 'ignored' } }
        ]
      }
    })

    const messages = await getDagNodeChat('run-1', 'plan')

    expect(messages).toHaveLength(6)
    expect(messages[0]).toMatchObject({
      type: 'text',
      content: 'Implemented',
      worker_id: 'worker-1'
    })
    expect(messages[1]).toMatchObject({ type: 'text', content: 'Verified' })
    expect(messages[2]).toMatchObject({
      type: 'text',
      content: 'Persisted worker response',
      worker_id: 'worker-1'
    })
    expect(messages[3]).toMatchObject({ type: 'thinking', content: 'Checking behavior' })
    expect(messages[4]).toMatchObject({
      type: 'tool_use',
      message_id: 'tool-1',
      tool_name: 'handoff',
      tool_input: { artifact: 'review' }
    })
    expect(messages[5]).toMatchObject({
      type: 'tool_result',
      message_id: 'tool-1',
      tool_result: 'done',
      is_error: true
    })
  })

  it('uses empty chat arrays when the backend omits messages', async () => {
    vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: {} })

    await expect(getDagNodeChat('run-1', 'plan')).resolves.toEqual([])
    await expect(getDagManagerChat('run-1')).resolves.toEqual([])
  })

  it('returns Manager chat and event history payloads', async () => {
    const get = vi
      .spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: { messages: [{ type: 'text' }] } })
      .mockResolvedValueOnce({ success: true, data: { events: [{ event_type: 'node_started' }] } })

    await expect(getDagManagerChat('run-1')).resolves.toEqual([{ type: 'text' }])
    await expect(getDagEvents('run-1')).resolves.toEqual([{ event_type: 'node_started' }])
    expect(get).toHaveBeenNthCalledWith(1, '/api/dag-status/run-1/manager/chat')
    expect(get).toHaveBeenNthCalledWith(2, '/api/dag-status/run-1/events/history')
  })

  it('handles optional metrics and experience-ingest payloads', async () => {
    const get = vi
      .spyOn(http, 'get')
      .mockResolvedValueOnce({ success: false, data: null })
      .mockResolvedValueOnce({ success: true, data: { total_tokens: 42 } })
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({ success: true, data: { status: 'completed' } })
    const post = vi
      .spyOn(http, 'post')
      .mockResolvedValueOnce({ success: false, data: null })
      .mockResolvedValueOnce({ success: true, data: { status: 'queued' } })

    await expect(getDagRunMetrics('missing')).resolves.toBeNull()
    await expect(getDagRunMetrics('run-1')).resolves.toEqual({ total_tokens: 42 })
    await expect(getDagExperienceIngestStatus('missing')).resolves.toBeNull()
    await expect(getDagExperienceIngestStatus('run-1')).resolves.toEqual({ status: 'completed' })
    await expect(retryDagExperienceIngest('missing')).resolves.toBeNull()
    await expect(retryDagExperienceIngest('run-1')).resolves.toEqual({ status: 'queued' })
    expect(post).toHaveBeenLastCalledWith('/api/dag-status/run-1/experience-ingest/retry')
  })
})

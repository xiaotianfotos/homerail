import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { clearAllListeners, eventBus } from '@/utils/eventBus'
import type { DAGExecution, DAGTaskNode } from '@/api/types/dag.types'
import { bindAgentDagEvents } from './dag-events'

const ws = vi.hoisted(() => ({
  connect: vi.fn(),
  wildcardHandler: undefined as ((message: any) => void) | undefined,
  stateHandler: undefined as ((state: string) => void) | undefined,
  wildcardUnsubscribe: vi.fn(() => {
    ws.wildcardHandler = undefined
  }),
  stateUnsubscribe: vi.fn(() => {
    ws.stateHandler = undefined
  }),
  on: vi.fn((type: string, handler: (message: any) => void) => {
    if (type === '*') ws.wildcardHandler = handler
    return ws.wildcardUnsubscribe
  }),
  onStateChange: vi.fn((handler: (state: string) => void) => {
    ws.stateHandler = handler
    return ws.stateUnsubscribe
  }),
}))

const api = vi.hoisted(() => ({ getDagStatus: vi.fn() }))

vi.mock('@/api/clients/events-ws', () => ({ voiceWs: ws }))
vi.mock('@/api/services/dag-api', () => ({ getDagStatus: api.getDagStatus }))

function taskNode(status: DAGTaskNode['status'] = 'ready'): DAGTaskNode {
  return {
    id: 'review',
    name: 'Review',
    status,
    agent_id: 'reviewer',
    agent_name: 'Reviewer',
    dependencies: [],
    retry_count: 0,
    pool_count: 1,
    iteration: 0,
  }
}

function execution(status: DAGExecution['status'] = 'running'): DAGExecution {
  return {
    dag_run_id: 'run-live',
    status,
    nodes: [taskNode()],
    edges: [],
  }
}

function bind() {
  const dagExecution = ref<DAGExecution | null>(execution())
  const nodes = ref<DAGTaskNode[]>(dagExecution.value!.nodes)
  const setDagExecution = vi.fn((next: DAGExecution) => {
    dagExecution.value = next
    nodes.value = next.nodes
  })
  const controller = bindAgentDagEvents({
    currentRunId: ref<string | null>('run-live'),
    dagExecution,
    nodes,
    edges: ref([]),
    selectedNodeId: ref<string | null>(null),
    chatMessages: ref([]),
    wsStreamedCount: ref(0),
    persist: vi.fn(),
    setDagExecution,
    selectNode: vi.fn(),
  })
  controller.initialize()
  return { dagExecution, nodes, setDagExecution, controller }
}

describe('agent DAG websocket events', () => {
  beforeEach(() => {
    clearAllListeners()
    vi.clearAllMocks()
    api.getDagStatus.mockReset()
    ws.wildcardHandler = undefined
    ws.stateHandler = undefined
  })

  it('bridges Manager payload events into live node state', () => {
    const state = bind()

    ws.wildcardHandler?.({
      type: 'dag:node_state_changed',
      payload: { runId: 'run-live', nodeId: 'review', status: 'running' },
    })

    expect(ws.connect).toHaveBeenCalledOnce()
    expect(state.nodes.value[0]?.status).toBe('running')
  })

  it('accepts canonical camelCase lifecycle payloads', () => {
    const state = bind()

    ws.wildcardHandler?.({
      type: 'dag:run_failed',
      payload: { runId: 'run-live', nodeId: 'review', reason: 'failed' },
    })

    expect(state.dagExecution.value?.status).toBe('failed')
  })

  it('preserves cancellation as a distinct run status', () => {
    const state = bind()

    ws.wildcardHandler?.({
      type: 'dag:run_cancelled',
      payload: { runId: 'run-live' },
    })

    expect(state.dagExecution.value?.status).toBe('cancelled')
  })

  it('reloads the authoritative snapshot after websocket reconnect', async () => {
    const state = bind()
    const snapshot = execution('completed')
    snapshot.nodes[0]!.status = 'completed'
    api.getDagStatus.mockResolvedValue(snapshot)

    ws.stateHandler?.('connected')
    await vi.waitFor(() => expect(state.setDagExecution).toHaveBeenCalledWith(snapshot))

    expect(state.nodes.value[0]?.status).toBe('completed')
  })

  it('coalesces reconnect refreshes and allows at most one trailing request', async () => {
    const state = bind()
    const snapshot = execution('completed')
    let resolveFirst!: (value: DAGExecution) => void
    api.getDagStatus
      .mockImplementationOnce(() => new Promise<DAGExecution>(resolve => {
        resolveFirst = resolve
      }))
      .mockResolvedValueOnce(snapshot)

    ws.stateHandler?.('connected')
    ws.stateHandler?.('connected')
    await vi.waitFor(() => expect(api.getDagStatus).toHaveBeenCalledTimes(1))

    ws.stateHandler?.('connected')
    ws.stateHandler?.('connected')
    expect(api.getDagStatus).toHaveBeenCalledTimes(1)

    resolveFirst(snapshot)
    await vi.waitFor(() => expect(api.getDagStatus).toHaveBeenCalledTimes(2))
    expect(state.setDagExecution).toHaveBeenCalledTimes(2)
  })

  it('disposes shared websocket and event-bus subscriptions without disconnecting the socket', () => {
    const state = bind()

    state.controller.dispose()
    eventBus.emit('dag:run_failed', { runId: 'run-live' })

    expect(ws.wildcardUnsubscribe).toHaveBeenCalledOnce()
    expect(ws.stateUnsubscribe).toHaveBeenCalledOnce()
    expect(ws.wildcardHandler).toBeUndefined()
    expect(ws.stateHandler).toBeUndefined()
    expect(state.dagExecution.value?.status).toBe('running')
    expect(ws.connect).toHaveBeenCalledOnce()
  })
})

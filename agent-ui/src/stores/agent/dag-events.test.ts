import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { clearAllListeners } from '@/utils/eventBus'
import type { DAGExecution, DAGTaskNode } from '@/api/types/dag.types'
import { bindAgentDagEvents } from './dag-events'

const ws = vi.hoisted(() => ({
  connect: vi.fn(),
  wildcardHandler: undefined as ((message: any) => void) | undefined,
  stateHandler: undefined as ((state: string) => void) | undefined,
  on: vi.fn((type: string, handler: (message: any) => void) => {
    if (type === '*') ws.wildcardHandler = handler
    return vi.fn()
  }),
  onStateChange: vi.fn((handler: (state: string) => void) => {
    ws.stateHandler = handler
    return vi.fn()
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
  const initialize = bindAgentDagEvents({
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
  initialize()
  return { dagExecution, nodes, setDagExecution }
}

describe('agent DAG websocket events', () => {
  beforeEach(() => {
    clearAllListeners()
    vi.clearAllMocks()
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

  it('reloads the authoritative snapshot after websocket reconnect', async () => {
    const state = bind()
    const snapshot = execution('completed')
    snapshot.nodes[0]!.status = 'completed'
    api.getDagStatus.mockResolvedValue(snapshot)

    ws.stateHandler?.('connected')
    await vi.waitFor(() => expect(state.setDagExecution).toHaveBeenCalledWith(snapshot))

    expect(state.nodes.value[0]?.status).toBe('completed')
  })
})

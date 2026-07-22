import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { clearAllListeners, eventBus } from '@/utils/eventBus'
import { useDagNodeMessages } from './useDagNodeMessages'

const api = vi.hoisted(() => ({
  getDagNodeChat: vi.fn(),
  getDagManagerChat: vi.fn(),
}))

vi.mock('@/api/services/dag-api', () => ({ dagApi: api }))

describe('useDagNodeMessages realtime invalidation', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearAllListeners()
    api.getDagNodeChat.mockResolvedValue([])
    api.getDagManagerChat.mockResolvedValue([])
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.useRealTimers()
    clearAllListeners()
  })

  it('debounces selected-node chat refreshes without clearing the current view', async () => {
    const runId = ref<string | undefined>('run-live')
    const nodeId = ref<string | null>('review')
    const isManager = ref(false)

    const Harness = defineComponent({
      setup() {
        useDagNodeMessages(runId, nodeId, isManager)
        return () => h('div')
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.mount(root)
    await nextTick()
    await vi.waitFor(() => expect(api.getDagNodeChat).toHaveBeenCalledTimes(1))

    eventBus.emit('dag:node_chat_updated', {
      runId: 'run-live',
      nodeId: 'review',
      timestamp: new Date().toISOString(),
    })
    eventBus.emit('dag:node_chat_updated', {
      runId: 'run-live',
      nodeId: 'review',
      timestamp: new Date().toISOString(),
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(api.getDagNodeChat).toHaveBeenCalledTimes(2)
  })

  it('ignores chat invalidations for a different node', async () => {
    const Harness = defineComponent({
      setup() {
        useDagNodeMessages(ref('run-live'), ref('review'), ref(false))
        return () => h('div')
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.mount(root)
    await nextTick()
    await vi.waitFor(() => expect(api.getDagNodeChat).toHaveBeenCalledTimes(1))

    eventBus.emit('dag:node_chat_updated', {
      runId: 'run-live',
      nodeId: 'implement',
      timestamp: new Date().toISOString(),
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(api.getDagNodeChat).toHaveBeenCalledTimes(1)
  })

  it('refreshes periodically while chat invalidations continue without a quiet gap', async () => {
    const Harness = defineComponent({
      setup() {
        useDagNodeMessages(ref('run-live'), ref('review'), ref(false))
        return () => h('div')
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.mount(root)
    await nextTick()
    await vi.waitFor(() => expect(api.getDagNodeChat).toHaveBeenCalledTimes(1))

    for (let elapsed = 0; elapsed < 1_200; elapsed += 50) {
      eventBus.emit('dag:node_chat_updated', {
        runId: 'run-live',
        nodeId: 'review',
        timestamp: new Date().toISOString(),
      })
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(api.getDagNodeChat.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(api.getDagNodeChat.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('loads the next node immediately when live selection follows a handoff', async () => {
    const nodeId = ref<string | null>('review')
    const Harness = defineComponent({
      setup() {
        useDagNodeMessages(ref('run-live'), nodeId, ref(false))
        return () => h('div')
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.mount(root)
    await nextTick()
    await vi.waitFor(() => expect(api.getDagNodeChat).toHaveBeenCalledWith('run-live', 'review'))

    nodeId.value = 'implement'
    await nextTick()

    expect(api.getDagNodeChat).toHaveBeenLastCalledWith('run-live', 'implement')
  })
})

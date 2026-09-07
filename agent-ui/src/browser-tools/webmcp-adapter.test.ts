import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import type { HomeRailUiSurfaceController } from './ui-surface-controller'
import {
  startHomeRailBrowserTools,
  type HomeRailBrowserToolsRuntimeStatus,
} from './webmcp-adapter'

interface CapturedNativeTool {
  name: string
  execute(input: Record<string, unknown>): Promise<string>
  signal?: AbortSignal
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function status(
  enabled: boolean,
  overrides: Partial<DesktopBrowserToolsStatus> = {},
): DesktopBrowserToolsStatus {
  return {
    supported: true,
    enabled,
    runtimeEnabled: enabled,
    restartRequired: false,
    state: enabled ? 'connected' : 'disabled',
    ...overrides,
  }
}

function controller(): HomeRailUiSurfaceController {
  return {
    getState: () => ({
      active_surface: null,
      dag_run_id: null,
      dag_status_view: null,
      widgets: [],
      widgets_truncated: false,
      ambiguous_widget_count: 0,
    }),
    listDagRuns: async () => [],
    openDagStatus: async () => undefined,
    closeDagStatus: () => undefined,
    describeWidget: () => { throw new Error('missing') },
    focusWidget: () => { throw new Error('missing') },
    setWidgetExpanded: () => { throw new Error('missing') },
  }
}

function connectedDirectFactory() {
  const start = vi.fn(async () => undefined)
  const stop = vi.fn()
  const create = vi.fn((onStatus: (status: any) => void) => ({
    async start() {
      start()
      onStatus({ state: 'connected', target: {
        connection_id: 'connection-1',
        ui_session_id: 'session-1',
        tab_id: 'tab-1',
        navigation_id: 'navigation-1',
      } })
    },
    stop(reason?: string) {
      stop(reason)
      onStatus({ state: 'disabled', target: null })
    },
  }))
  return { create, start, stop }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WebMCP adapter', () => {
  it('runs the direct renderer in Desktop and registers native tools only for a supported runtime', async () => {
    const registrations: Array<{ name: string; signal?: AbortSignal }> = []
    let statusListener: ((next: DesktopBrowserToolsStatus) => void) | undefined
    const modelContext = {
      registerTool: vi.fn(async (tool: { name: string }, options?: { signal?: AbortSignal }) => {
        registrations.push({ name: tool.name, signal: options?.signal })
      }),
    }
    const bridge: HomeRailDesktopBridge = {
      browserToolsStatus: vi.fn(async () => status(true, { state: 'starting' })),
      onBrowserToolsStatus: vi.fn((listener) => {
        statusListener = listener
        return () => { statusListener = undefined }
      }),
    }
    const direct = connectedDirectFactory()

    const stop = await startHomeRailBrowserTools(controller(), {
      bridge,
      modelContext,
      createDirectBridge: direct.create,
      hostWindow: null,
    })
    await vi.waitFor(() => expect(registrations).toHaveLength(6))

    expect(direct.start).toHaveBeenCalledOnce()
    expect(registrations.map(entry => entry.name)).toEqual([
      'ui_get_state',
      'ui_open_surface',
      'ui_close_surface',
      'ui_describe_widget',
      'ui_focus_widget',
      'ui_set_widget_expanded',
    ])
    expect(registrations.every(entry => entry.signal?.aborted === false)).toBe(true)

    statusListener?.(status(true, { state: 'unavailable' }))
    expect(registrations.every(entry => entry.signal?.aborted === false)).toBe(true)

    statusListener?.(status(false))
    expect(registrations.every(entry => entry.signal?.aborted === true)).toBe(true)
    expect(direct.stop).toHaveBeenCalledWith('feature_disabled')
    stop()
  })

  it('does not let a stale initial Desktop snapshot override a newer disable event', async () => {
    const initialStatus = deferred<DesktopBrowserToolsStatus>()
    let statusListener: ((next: DesktopBrowserToolsStatus) => void) | undefined
    const modelContext = { registerTool: vi.fn(async () => undefined) }
    const direct = connectedDirectFactory()
    const statuses: HomeRailBrowserToolsRuntimeStatus[] = []
    const start = startHomeRailBrowserTools(controller(), {
      bridge: {
        browserToolsStatus: vi.fn(() => initialStatus.promise),
        onBrowserToolsStatus: vi.fn((listener) => {
          statusListener = listener
          return () => { statusListener = undefined }
        }),
      },
      modelContext,
      createDirectBridge: direct.create,
      onStatus: next => statuses.push(next),
      hostWindow: null,
    })
    await vi.waitFor(() => expect(statusListener).toBeDefined())

    statusListener?.(status(false))
    initialStatus.resolve(status(true, { state: 'connected' }))
    const stop = await start
    await flush()

    expect(direct.create).not.toHaveBeenCalled()
    expect(direct.start).not.toHaveBeenCalled()
    expect(modelContext.registerTool).not.toHaveBeenCalled()
    expect(statuses.at(-1)?.state).toBe('disabled')
    stop()
  })

  it('keeps the Desktop direct fallback when native WebMCP is unsupported or restart-required', async () => {
    const modelContext = { registerTool: vi.fn(async () => undefined) }
    const direct = connectedDirectFactory()
    const stop = await startHomeRailBrowserTools(controller(), {
      bridge: {
        browserToolsStatus: vi.fn(async () => status(true, {
          supported: false,
          runtimeEnabled: false,
          restartRequired: true,
          state: 'unavailable',
        })),
      },
      modelContext,
      createDirectBridge: direct.create,
      hostWindow: null,
    })
    await flush()

    expect(direct.start).toHaveBeenCalledOnce()
    expect(modelContext.registerTool).not.toHaveBeenCalled()
    stop()
  })

  it('is visible to pure Web as a default-off, immediate switch without requiring modelContext', async () => {
    const enabled = ref(false)
    const direct = connectedDirectFactory()
    const statuses: HomeRailBrowserToolsRuntimeStatus[] = []
    const stop = await startHomeRailBrowserTools(controller(), {
      bridge: null,
      modelContext: null,
      webEnabled: enabled,
      createDirectBridge: direct.create,
      onStatus: next => statuses.push(next),
      hostWindow: null,
    })

    expect(direct.start).not.toHaveBeenCalled()
    expect(statuses.at(-1)?.state).toBe('disabled')

    enabled.value = true
    await flush()
    expect(direct.start).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toMatchObject({
      state: 'direct',
      directConnected: true,
      nativeRegistered: false,
    })

    enabled.value = false
    await flush()
    expect(direct.stop).toHaveBeenCalledWith('feature_disabled')
    expect(statuses.at(-1)?.state).toBe('disabled')
    stop()
  })

  it('distinguishes a direct bridge plus optional native WebMCP', async () => {
    const enabled = ref(true)
    const direct = connectedDirectFactory()
    const statuses: HomeRailBrowserToolsRuntimeStatus[] = []
    const stop = await startHomeRailBrowserTools(controller(), {
      bridge: null,
      webEnabled: enabled,
      modelContext: { registerTool: vi.fn(async () => undefined) },
      createDirectBridge: direct.create,
      onStatus: next => statuses.push(next),
      hostWindow: null,
    })
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('direct-native'))

    expect(statuses.at(-1)).toMatchObject({
      state: 'direct-native',
      directConnected: true,
      nativeRegistered: true,
    })
    stop()
  })

  it('aborts a pending native invocation before it can commit a visible action', async () => {
    const enabled = ref(true)
    const registrations: CapturedNativeTool[] = []
    let listSignal: AbortSignal | undefined
    const openDagStatus = vi.fn(async () => undefined)
    const pendingController: HomeRailUiSurfaceController = {
      ...controller(),
      listDagRuns: vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        listSignal = signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('request cancelled', 'AbortError'))
        }, { once: true })
      })),
      openDagStatus,
    }
    const direct = connectedDirectFactory()
    const stop = await startHomeRailBrowserTools(pendingController, {
      bridge: null,
      webEnabled: enabled,
      modelContext: {
        registerTool: vi.fn(async (tool, options) => {
          registrations.push({ ...tool, signal: options?.signal })
        }),
      },
      createDirectBridge: direct.create,
      hostWindow: null,
    })
    await vi.waitFor(() => expect(registrations).toHaveLength(6))

    const openTool = registrations.find(entry => entry.name === 'ui_open_surface')
    const invocation = openTool!.execute({ surface: 'dag_status' })
    const rejected = expect(invocation).rejects.toMatchObject({
      name: 'AbortError',
      message: 'HomeRail UI tool was cancelled',
    })
    await vi.waitFor(() => expect(listSignal).toBeDefined())

    enabled.value = false
    await flush()

    await rejected
    expect(listSignal?.aborted).toBe(true)
    expect(openDagStatus).not.toHaveBeenCalled()
    stop()
  })

  it('reports a pending native invocation as indeterminate when disable follows action commit', async () => {
    const enabled = ref(true)
    const registrations: CapturedNativeTool[] = []
    let invocationSignal: AbortSignal | undefined
    let actionCommitted = false
    const committedController: HomeRailUiSurfaceController = {
      ...controller(),
      openDagStatus: vi.fn((_runId, signal, onActionCommitted) => new Promise<void>((_resolve, reject) => {
        invocationSignal = signal
        onActionCommitted?.()
        actionCommitted = true
        signal?.addEventListener('abort', () => {
          reject(new DOMException('request cancelled', 'AbortError'))
        }, { once: true })
      })),
    }
    const direct = connectedDirectFactory()
    const stop = await startHomeRailBrowserTools(committedController, {
      bridge: null,
      webEnabled: enabled,
      modelContext: {
        registerTool: vi.fn(async (tool, options) => {
          registrations.push({ ...tool, signal: options?.signal })
        }),
      },
      createDirectBridge: direct.create,
      hostWindow: null,
    })
    await vi.waitFor(() => expect(registrations).toHaveLength(6))

    const openTool = registrations.find(entry => entry.name === 'ui_open_surface')
    const invocation = openTool!.execute({ surface: 'dag_status' })
    const rejected = expect(invocation).rejects.toThrow(
      'indeterminate: action may have completed (request cancelled)',
    )
    await vi.waitFor(() => expect(actionCommitted).toBe(true))

    enabled.value = false
    await flush()

    await rejected
    expect(invocationSignal?.aborted).toBe(true)
    stop()
  })

  it('reports a native executor failure after action commit as indeterminate', async () => {
    const enabled = ref(true)
    const registrations: CapturedNativeTool[] = []
    const committedController: HomeRailUiSurfaceController = {
      ...controller(),
      openDagStatus: vi.fn(async (_runId, _signal, onActionCommitted) => {
        onActionCommitted?.()
        throw new Error('renderer failed')
      }),
    }
    const direct = connectedDirectFactory()
    const stop = await startHomeRailBrowserTools(committedController, {
      bridge: null,
      webEnabled: enabled,
      modelContext: {
        registerTool: vi.fn(async (tool, options) => {
          registrations.push({ ...tool, signal: options?.signal })
        }),
      },
      createDirectBridge: direct.create,
      hostWindow: null,
    })
    await vi.waitFor(() => expect(registrations).toHaveLength(6))

    const openTool = registrations.find(entry => entry.name === 'ui_open_surface')
    await expect(openTool!.execute({ surface: 'dag_status' })).rejects.toThrow(
      'indeterminate: action may have completed (renderer failed)',
    )
    stop()
  })

  it('continues one bounded exponential retry loop while the switch remains on', async () => {
    vi.useFakeTimers()
    const enabled = ref(true)
    let onDirectStatus: ((status: any) => void) | undefined
    const start = vi.fn(async () => {
      onDirectStatus?.({ state: 'unavailable', target: null, error: 'offline' })
    })
    const stopDirect = vi.fn(() => onDirectStatus?.({ state: 'disabled', target: null }))
    const stop = await startHomeRailBrowserTools(controller(), {
      bridge: null,
      modelContext: null,
      webEnabled: enabled,
      retryDelaysMs: [Number.NaN, 0, -1, 10, 20],
      createDirectBridge: (listener) => {
        onDirectStatus = listener
        return { start, stop: stopDirect }
      },
      hostWindow: null,
    })
    await flush()
    expect(start).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10)
    expect(start).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20)
    expect(start).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(20)
    expect(start).toHaveBeenCalledTimes(4)

    enabled.value = false
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    expect(start).toHaveBeenCalledTimes(4)
    stop()
  })
})

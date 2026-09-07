import { HOMERAIL_UI_TOOL_CONTRACTS } from 'homerail-protocol'
import { watch, type Ref } from 'vue'
import {
  HomeRailBrowserRendererBridge,
  type BrowserRendererBridgeStatus,
  setDesktopBrowserToolsTransportAvailable,
} from './browser-renderer-bridge'
import type { HomeRailUiSurfaceController } from './ui-surface-controller'
import { executeHomeRailUiTool } from './ui-surface-controller'

interface WebMcpToolRegistration {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    untrustedContentHint: boolean
  }
  execute: (input: Record<string, unknown>) => Promise<string>
}

interface WebMcpModelContext {
  registerTool(
    tool: WebMcpToolRegistration,
    options?: { signal?: AbortSignal },
  ): Promise<void>
}

interface BrowserToolsDocument extends Document {
  modelContext?: WebMcpModelContext
}

interface DirectRendererBridge {
  start(): Promise<void>
  stop(reason?: 'navigation' | 'reload' | 'feature_disabled' | 'window_closed'): void
}

function nativeToolExecutionError(
  error: unknown,
  signal: AbortSignal,
  actionCommitted: boolean,
): Error {
  const message = (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof error.message === 'string'
  ) ? error.message : String(error)
  if (actionCommitted) {
    return new Error(`indeterminate: action may have completed (${message})`)
  }
  if (
    signal.aborted
    || (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return new DOMException('HomeRail UI tool was cancelled', 'AbortError')
  }
  return error instanceof Error ? error : new Error(message)
}

export type HomeRailBrowserToolsRuntimeState =
  | 'disabled'
  | 'starting'
  | 'direct'
  | 'direct-native'
  | 'native-only'
  | 'unavailable'
  | 'error'

export interface HomeRailBrowserToolsRuntimeStatus {
  state: HomeRailBrowserToolsRuntimeState
  directConnected: boolean
  nativeRegistered: boolean
  error?: string
}

export interface BrowserToolsAdapterDependencies {
  bridge?: HomeRailDesktopBridge | null
  modelContext?: WebMcpModelContext | null
  webEnabled?: Readonly<Ref<boolean>> | null
  onStatus?: (status: HomeRailBrowserToolsRuntimeStatus) => void
  createDirectBridge?: (
    onStatus: (status: BrowserRendererBridgeStatus) => void,
  ) => DirectRendererBridge
  hostWindow?: Window | null
  retryDelaysMs?: readonly number[]
}

async function registerTools(
  modelContext: WebMcpModelContext,
  controller: HomeRailUiSurfaceController,
  signal: AbortSignal,
): Promise<void> {
  for (const contract of HOMERAIL_UI_TOOL_CONTRACTS) {
    if (signal.aborted || contract.page_exposure !== 'webmcp_local') return
    await modelContext.registerTool({
      name: contract.name,
      description: contract.description,
      inputSchema: structuredClone(contract.input_schema),
      annotations: {
        readOnlyHint: contract.effect === 'read',
        untrustedContentHint: true,
      },
      async execute(input) {
        let actionCommitted = false
        try {
          const result = await executeHomeRailUiTool(contract.name, input, controller, {
            signal,
            onActionCommitted: () => { actionCommitted = true },
          })
          if (signal.aborted) {
            throw new DOMException('HomeRail UI tool was cancelled', 'AbortError')
          }
          return JSON.stringify(result)
        } catch (error) {
          throw nativeToolExecutionError(error, signal, actionCommitted)
        }
      },
    }, { signal })
  }
}

/**
 * Bind both experimental renderer transports to one total feature switch.
 * The direct, ticket-authenticated bridge is the Manager/Voice path in Web and
 * Desktop. document.modelContext is an optional native enhancement and never a
 * prerequisite for the direct bridge.
 */
export async function startHomeRailBrowserTools(
  controller: HomeRailUiSurfaceController,
  dependencies: BrowserToolsAdapterDependencies = {},
): Promise<() => void> {
  const hostWindow = dependencies.hostWindow === undefined
    ? (typeof window === 'undefined' ? null : window)
    : dependencies.hostWindow
  const bridge = dependencies.bridge !== undefined
    ? dependencies.bridge
    : hostWindow?.homerailDesktop ?? null
  const isDesktop = Boolean(bridge?.browserToolsStatus)
  const modelContext = dependencies.modelContext
    ?? (typeof document === 'undefined'
      ? null
      : (document as BrowserToolsDocument).modelContext ?? null)
  const configuredRetryDelays = dependencies.retryDelaysMs
    ?.filter(delay => Number.isFinite(delay) && delay > 0)
    .map(delay => Math.max(1, Math.floor(delay)))
  const retryDelaysMs = configuredRetryDelays?.length
    ? configuredRetryDelays
    : [1_000, 3_000, 10_000, 30_000]

  let stopped = false
  let totalEnabled = false
  let lifecycleSuspended = false
  let nativeDesired = false
  let nativeRegistration: AbortController | null = null
  let nativeGeneration = 0
  let nativeState: 'disabled' | 'registering' | 'registered' | 'unavailable' | 'error' = 'disabled'
  let nativeError = ''
  let directBridge: DirectRendererBridge | null = null
  let directState: BrowserRendererBridgeStatus['state'] = 'disabled'
  let directError = ''
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let latestDesktopStatus: DesktopBrowserToolsStatus | null = null
  let desktopStatusRevision = 0

  const emitStatus = (): void => {
    let state: HomeRailBrowserToolsRuntimeState
    if (!totalEnabled) {
      state = 'disabled'
    } else if (directState === 'connected' && nativeState === 'registered') {
      state = 'direct-native'
    } else if (directState === 'connected') {
      state = 'direct'
    } else if (directState === 'starting' || nativeState === 'registering') {
      state = 'starting'
    } else if (nativeState === 'registered') {
      state = 'native-only'
    } else if (directState === 'error' || nativeState === 'error') {
      state = 'error'
    } else {
      state = 'unavailable'
    }
    const error = state === 'error' || state === 'unavailable'
      ? directError || nativeError || undefined
      : undefined
    dependencies.onStatus?.({
      state,
      directConnected: directState === 'connected',
      nativeRegistered: nativeState === 'registered',
      ...(error ? { error } : {}),
    })
  }

  const clearRetry = (): void => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  const startDirect = (): void => {
    if (stopped || lifecycleSuspended || !totalEnabled) return
    if (!directBridge) {
      const onDirectStatus = (status: BrowserRendererBridgeStatus): void => {
        if (stopped) return
        directState = status.state
        directError = status.error ?? ''
        if (status.state === 'connected') {
          retryAttempt = 0
          clearRetry()
        } else if (
          totalEnabled
          && !lifecycleSuspended
          && (status.state === 'error' || status.state === 'unavailable')
          && !retryTimer
        ) {
          const retryIndex = Math.min(retryAttempt, retryDelaysMs.length - 1)
          const delay = retryDelaysMs[retryIndex]
          retryAttempt = Math.min(retryAttempt + 1, retryDelaysMs.length - 1)
          retryTimer = setTimeout(() => {
            retryTimer = null
            startDirect()
          }, delay)
        }
        emitStatus()
      }
      directBridge = dependencies.createDirectBridge?.(onDirectStatus)
        ?? new HomeRailBrowserRendererBridge(controller, { onStatus: onDirectStatus })
    }
    directState = 'starting'
    directError = ''
    emitStatus()
    void directBridge.start().catch(() => {
      // The bridge publishes the precise error and bounded retry state.
    })
  }

  const stopDirect = (
    reason: 'navigation' | 'reload' | 'feature_disabled' | 'window_closed',
  ): void => {
    clearRetry()
    directBridge?.stop(reason)
    directState = 'disabled'
    directError = ''
  }

  const applyNative = (): void => {
    const desired = totalEnabled && nativeDesired && !lifecycleSuspended
    if (!desired || !modelContext) {
      nativeGeneration += 1
      nativeRegistration?.abort()
      nativeRegistration = null
      nativeState = desired ? 'unavailable' : 'disabled'
      nativeError = ''
      emitStatus()
      return
    }
    if (nativeRegistration) return
    const generation = ++nativeGeneration
    const registration = new AbortController()
    nativeRegistration = registration
    nativeState = 'registering'
    nativeError = ''
    emitStatus()
    void registerTools(modelContext, controller, registration.signal).then(() => {
      if (
        stopped
        || generation !== nativeGeneration
        || registration.signal.aborted
      ) return
      nativeState = 'registered'
      emitStatus()
    }).catch((error) => {
      if (generation !== nativeGeneration || registration.signal.aborted) return
      registration.abort()
      nativeRegistration = null
      nativeState = 'error'
      nativeError = error instanceof Error ? error.message : String(error)
      emitStatus()
    })
  }

  const setTotalEnabled = (enabled: boolean): void => {
    if (totalEnabled === enabled) {
      applyNative()
      return
    }
    totalEnabled = enabled
    if (!enabled) {
      retryAttempt = 0
      stopDirect('feature_disabled')
      applyNative()
      setDesktopBrowserToolsTransportAvailable(false)
      emitStatus()
      return
    }
    startDirect()
    applyNative()
  }

  const applyDesktopStatus = (status: DesktopBrowserToolsStatus): void => {
    latestDesktopStatus = status
    nativeDesired = Boolean(
      status.enabled
      && status.supported
      && status.runtimeEnabled,
    )
    setDesktopBrowserToolsTransportAvailable(
      Boolean(status.enabled && status.supported && status.state === 'connected'),
    )
    setTotalEnabled(status.enabled)
    applyNative()
  }

  const initialDesktopStatusRevision = desktopStatusRevision
  const removeStatusListener = bridge?.onBrowserToolsStatus?.((status) => {
    desktopStatusRevision += 1
    applyDesktopStatus(status)
  }) ?? null

  let stopWebWatch: (() => void) | null = null
  if (isDesktop) {
    try {
      const status = await bridge?.browserToolsStatus?.()
      if (desktopStatusRevision === initialDesktopStatusRevision) {
        if (status) applyDesktopStatus(status)
        else emitStatus()
      }
    } catch (error) {
      if (desktopStatusRevision === initialDesktopStatusRevision) {
        directState = 'unavailable'
        directError = error instanceof Error ? error.message : String(error)
        emitStatus()
      }
    }
  } else if (dependencies.webEnabled) {
    nativeDesired = Boolean(modelContext)
    stopWebWatch = watch(
      dependencies.webEnabled,
      enabled => setTotalEnabled(enabled),
      { immediate: true },
    )
  } else {
    emitStatus()
  }

  const onPageHide = (event: PageTransitionEvent): void => {
    if (!totalEnabled) return
    lifecycleSuspended = true
    stopDirect(event.persisted ? 'navigation' : 'reload')
    applyNative()
    setDesktopBrowserToolsTransportAvailable(false)
  }
  const onPageShow = (): void => {
    if (!lifecycleSuspended || !totalEnabled) return
    lifecycleSuspended = false
    if (latestDesktopStatus) applyDesktopStatus(latestDesktopStatus)
    startDirect()
    applyNative()
  }
  hostWindow?.addEventListener('pagehide', onPageHide)
  hostWindow?.addEventListener('pageshow', onPageShow)

  return () => {
    if (stopped) return
    stopped = true
    stopWebWatch?.()
    stopWebWatch = null
    removeStatusListener?.()
    hostWindow?.removeEventListener('pagehide', onPageHide)
    hostWindow?.removeEventListener('pageshow', onPageShow)
    stopDirect('window_closed')
    nativeGeneration += 1
    nativeRegistration?.abort()
    nativeRegistration = null
    setDesktopBrowserToolsTransportAvailable(false)
  }
}

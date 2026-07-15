<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { GenerativeUiPreviewRequestV1 } from '@/generative-ui/types'
import {
  getDagLiveSurfaces,
  type DagLiveSurfaceSnapshot,
} from '@/api/agent'
import { voiceWs } from '@/api/clients/events-ws'
import { resolveGenerativeUiDeviceContext } from '@/generative-ui/device-context'
import { GenerativeUiRendererRegistry } from '@/generative-ui/renderer-registry'
import {
  createDagTaskCanvasComposition,
  dagTaskCanvasSelectionStorageKey,
  dagTaskCanvasSnapshotVersion,
  projectorFocusedSurface,
  resolveDagTaskCanvasSelection,
} from '@/generative-ui/dag-task-canvas'
import A2uiRenderer from './A2uiRenderer.vue'
import GenerativeUiSurfaceHost from './GenerativeUiSurfaceHost.vue'

const props = withDefaults(defineProps<{
  runId: string
  refreshToken?: string | number | null
  pollIntervalMs?: number
  autoRefresh?: boolean
  embedded?: boolean
}>(), {
  refreshToken: null,
  pollIntervalMs: 1000,
  autoRefresh: true,
  embedded: false,
})

const emit = defineEmits<{
  (event: 'availability', payload: {
    available: boolean
    node_ids: string[]
    loading?: boolean
    stale?: boolean
  }): void
  (event: 'select-node', payload: { node_id: string }): void
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
}>()

const snapshot = ref<DagLiveSurfaceSnapshot | null>(null)
const snapshotVersion = ref('')
const selectedNodeId = ref('')
const resolved = ref(false)
const loading = ref(true)
const stale = ref(false)
const clock = ref(Date.now())
const viewportRevision = ref(0)
let mounted = false
let requestGeneration = 0
let refreshRequested = false
let refreshLoop: Promise<void> | null = null
let pollTimer = 0
let eventRefreshTimer = 0
let unsubscribeEvents: (() => void) | null = null
let unsubscribeState: (() => void) | null = null

const context = computed(() => {
  void viewportRevision.value
  return resolveGenerativeUiDeviceContext({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
    activeRunId: props.runId,
  })
})
const documentValue = computed(() => snapshot.value?.document ?? null)
const composition = computed(() => snapshot.value
  ? createDagTaskCanvasComposition(snapshot.value, context.value)
  : null)
const nodeIds = computed(() => composition.value?.items.map(item => item.node_id) ?? [])
const available = computed(() => Boolean(documentValue.value && composition.value?.items.length))
const initialLoading = computed(() => loading.value && !snapshot.value)
const focusedSurface = computed(() => {
  void clock.value
  return snapshot.value ? projectorFocusedSurface(snapshot.value) : null
})
const rendererRegistry = computed(() => {
  const seen = new Set<string>()
  return new GenerativeUiRendererRegistry((documentValue.value?.nodes ?? []).flatMap((node) => {
    const key = `${node.owner.version}:${node.surface}:${context.value.device}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{
      renderer_api_version: 1 as const,
      plugin_id: node.owner.id,
      plugin_version: node.owner.version,
      renderer_id: `dag-task-canvas:${node.owner.version}:${node.surface}:${context.value.device}`,
      kind: node.kind,
      kind_version: node.kind_version,
      surface: node.surface,
      device: context.value.device,
      mode: 'core_projection' as const,
      component: A2uiRenderer,
    }]
  }))
})

function storedSelection(runId: string): string {
  try {
    return sessionStorage.getItem(dagTaskCanvasSelectionStorageKey(runId)) ?? ''
  } catch {
    return ''
  }
}

function persistSelection(nodeId: string): void {
  try {
    if (nodeId) sessionStorage.setItem(dagTaskCanvasSelectionStorageKey(props.runId), nodeId)
    else sessionStorage.removeItem(dagTaskCanvasSelectionStorageKey(props.runId))
  } catch {
    // Storage can be unavailable in hardened or private browser contexts.
  }
}

function publishAvailability(): void {
  emit('availability', {
    available: available.value,
    node_ids: [...nodeIds.value],
    ...(initialLoading.value ? { loading: true } : {}),
    ...(stale.value ? { stale: true } : {}),
  })
}

function acceptSelection(nodeId: string): void {
  if (!nodeIds.value.includes(nodeId)) return
  selectedNodeId.value = nodeId
  persistSelection(nodeId)
  emit('select-node', { node_id: nodeId })
}

async function performRefresh(): Promise<void> {
  const runId = props.runId
  if (!runId) return
  const generation = ++requestGeneration
  if (!snapshot.value) {
    loading.value = true
    publishAvailability()
  }
  try {
    const response = await getDagLiveSurfaces(runId)
    if (!mounted || generation !== requestGeneration || props.runId !== runId) return
    clock.value = Date.now()
    const nextVersion = dagTaskCanvasSnapshotVersion(response.data)
    if (nextVersion !== snapshotVersion.value) {
      snapshot.value = response.data
      snapshotVersion.value = nextVersion
    }
    selectedNodeId.value = resolveDagTaskCanvasSelection(
      response.data,
      selectedNodeId.value,
      storedSelection(runId),
    )
    persistSelection(selectedNodeId.value)
    resolved.value = true
    loading.value = false
    stale.value = false
    publishAvailability()
  } catch {
    if (!mounted || generation !== requestGeneration || props.runId !== runId) return
    resolved.value = true
    loading.value = false
    stale.value = Boolean(snapshot.value)
    publishAvailability()
  }
}

async function drainRefreshQueue(): Promise<void> {
  try {
    while (mounted && refreshRequested) {
      refreshRequested = false
      await performRefresh()
    }
  } finally {
    refreshLoop = null
  }
}

function refresh(): Promise<void> {
  refreshRequested = true
  refreshLoop ??= drainRefreshQueue()
  return refreshLoop
}

function scheduleRefresh(): void {
  if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer)
  eventRefreshTimer = window.setTimeout(() => {
    eventRefreshTimer = 0
    void refresh()
  }, 80)
}

function resetRun(): void {
  requestGeneration += 1
  refreshRequested = false
  snapshot.value = null
  snapshotVersion.value = ''
  selectedNodeId.value = ''
  resolved.value = false
  loading.value = true
  stale.value = false
  publishAvailability()
  if (mounted) void refresh()
}

function configurePolling(): void {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = 0
  if (!mounted || !props.autoRefresh) return
  pollTimer = window.setInterval(() => void refresh(), Math.max(250, props.pollIntervalMs))
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') scheduleRefresh()
}

function onResize(): void {
  viewportRevision.value += 1
}

watch(() => props.runId, resetRun)
watch(() => props.refreshToken, () => mounted && scheduleRefresh())
watch(() => [props.autoRefresh, props.pollIntervalMs] as const, configurePolling)

onMounted(() => {
  mounted = true
  window.addEventListener('resize', onResize)
  window.addEventListener('online', scheduleRefresh)
  document.addEventListener('visibilitychange', onVisibilityChange)
  unsubscribeEvents = voiceWs.on('*', message => {
    if (message.type.startsWith('DAG_') || message.type.startsWith('dag:')) scheduleRefresh()
  })
  unsubscribeState = voiceWs.onStateChange(state => {
    if (state === 'connected') scheduleRefresh()
  })
  configurePolling()
  resetRun()
})

onUnmounted(() => {
  mounted = false
  requestGeneration += 1
  if (pollTimer) window.clearInterval(pollTimer)
  if (eventRefreshTimer) window.clearTimeout(eventRefreshTimer)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('online', scheduleRefresh)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  unsubscribeEvents?.()
  unsubscribeState?.()
})

defineExpose({ refresh })
</script>

<template>
  <section
    v-if="initialLoading || available"
    class="dag-task-canvas"
    :class="{
      'dag-task-canvas--stale': stale,
      'dag-task-canvas--embedded': embedded,
    }"
    data-testid="dag-task-canvas"
    :data-state="initialLoading ? 'loading' : stale ? 'stale' : 'ready'"
    :data-resolved="resolved ? 'true' : 'false'"
    :aria-busy="initialLoading"
  >
    <div v-if="initialLoading" class="dag-task-canvas__skeleton" aria-hidden="true">
      <div v-for="index in 3" :key="index" class="dag-task-canvas__skeleton-block">
        <span />
        <span />
        <span />
      </div>
    </div>
    <GenerativeUiSurfaceHost
      v-else-if="documentValue && composition"
      :document="documentValue"
      :composition="composition"
      :registry="rendererRegistry"
      :interactive="false"
      action-mode="disabled"
      :selected-node-id="selectedNodeId"
      :focused-node-id="focusedSurface?.nodeId"
      :focused-until="focusedSurface?.focusedUntil"
      :embedded="embedded"
      @select-node="acceptSelection($event.node_id)"
      @open-preview="emit('open-preview', $event)"
    />
  </section>
</template>

<style scoped>
.dag-task-canvas {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.dag-task-canvas--stale {
  opacity: 0.9;
}

.dag-task-canvas--embedded,
.dag-task-canvas--embedded .dag-task-canvas__skeleton {
  display: contents;
}

.dag-task-canvas--embedded .dag-task-canvas__skeleton-block {
  height: 100%;
  grid-column: auto / span 1;
  grid-row: 1 / span 2;
  scroll-snap-align: start;
}

.dag-task-canvas__skeleton {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 28px) / 3);
  gap: 14px;
  overflow-x: auto;
  overflow-y: hidden;
}

.dag-task-canvas__skeleton-block {
  display: grid;
  min-width: 0;
  min-height: 0;
  align-content: start;
  gap: 14px;
  border: 1px solid rgba(116, 228, 227, 0.12);
  border-radius: 8px;
  background: rgba(10, 20, 23, 0.88);
  padding: 64px 20px 20px;
}

.dag-task-canvas__skeleton-block span {
  height: 10px;
  border-radius: 3px;
  background: rgba(208, 235, 232, 0.08);
}

.dag-task-canvas__skeleton-block span:nth-child(1) { width: 58%; }
.dag-task-canvas__skeleton-block span:nth-child(2) { width: 84%; }
.dag-task-canvas__skeleton-block span:nth-child(3) { width: 70%; }

@media (max-width: 640px) {
  .dag-task-canvas__skeleton {
    grid-auto-columns: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dag-task-canvas,
  .dag-task-canvas * {
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}
</style>

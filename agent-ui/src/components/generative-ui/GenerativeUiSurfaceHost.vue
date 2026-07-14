<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type {
  GenerativeUiCompositionV1,
  GenerativeUiDocumentV1,
  GenerativeUiPlacement,
  GenerativeUiSurface,
} from 'homerail-protocol'
import {
  emptyGenerativeUiActionRegistry,
  GenerativeUiActionRegistry,
} from '@/generative-ui/action-registry'
import { resolveGenerativeUiFocusIndex, type GenerativeUiFocusDirection } from '@/generative-ui/focus-navigation'
import {
  emptyGenerativeUiRendererRegistry,
  GenerativeUiRendererRegistry,
} from '@/generative-ui/renderer-registry'
import type {
  GenerativeUiActionMode,
  GenerativeUiActionRequestV1,
  GenerativeUiPreviewRequestV1,
} from '@/generative-ui/types'
import GenerativeUiNodeHost from './GenerativeUiNodeHost.vue'
import type { PluginActionResponse } from '@/api/agent'
import { canvasColumnCount, canvasRowCount, resolveCanvasSize } from '@/generative-ui/canvas-layout'
import { resolveGenerativeUiMotionProfile } from '@/generative-ui/motion-profiles'

const props = withDefaults(defineProps<{
  document: GenerativeUiDocumentV1
  composition: GenerativeUiCompositionV1
  registry?: GenerativeUiRendererRegistry
  actionRegistry?: GenerativeUiActionRegistry
  surface?: GenerativeUiSurface
  placement?: GenerativeUiPlacement | 'all'
  interactive?: boolean
  actionMode?: GenerativeUiActionMode
  selectedNodeId?: string | null
}>(), {
  surface: undefined,
  placement: 'all',
  interactive: true,
  actionMode: 'emit',
})

const emit = defineEmits<{
  (event: 'action', payload: GenerativeUiActionRequestV1): void
  (event: 'action-status', payload: {
    node_id: string
    action_id: string
    response: PluginActionResponse
  }): void
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
  (event: 'renderer-error', payload: { node_id: string; message: string }): void
  (event: 'focus-node', payload: { node_id: string }): void
  (event: 'select-node', payload: { node_id: string }): void
}>()

const root = ref<HTMLElement | null>(null)
const registry = computed(() => props.registry ?? emptyGenerativeUiRendererRegistry)
const actionRegistry = computed(() => props.actionRegistry ?? emptyGenerativeUiActionRegistry)
const nodesById = computed(() => new Map(props.document.nodes.map(node => [node.id, node])))
const rendered = computed(() => props.composition.items
  .filter(item => !props.surface || item.surface === props.surface)
  .filter(item => props.placement === 'all' || item.placement === props.placement)
  .map(item => ({ item, node: nodesById.value.get(item.node_id) }))
  .filter((entry): entry is { item: typeof entry.item; node: NonNullable<typeof entry.node> } => Boolean(entry.node)))
const renderedWithLayout = computed(() => rendered.value.map(entry => ({
  ...entry,
  canvasSize: resolveCanvasSize(
    entry.node.presentation?.canvas_size,
    entry.item.variant,
    props.composition.context,
  ),
  motionProfile: resolveGenerativeUiMotionProfile(entry.node.presentation?.motion_profile),
})))
const canvasColumns = computed(() => canvasColumnCount(props.composition.context))
const canvasRows = computed(() => canvasRowCount(renderedWithLayout.value.map(entry => entry.canvasSize)))
const contentLayout = computed(() => renderedWithLayout.value.length === 1 ? 'single' : 'flow')
const attentionNodeId = ref<string | null>(null)
let attentionTimer = 0

function showAttention(nodeId: string): void {
  const profile = renderedWithLayout.value.find(entry => entry.node.id === nodeId)?.motionProfile
  if (!profile) return
  attentionNodeId.value = nodeId
  if (attentionTimer) window.clearTimeout(attentionTimer)
  attentionTimer = window.setTimeout(() => {
    if (attentionNodeId.value === nodeId) attentionNodeId.value = null
    attentionTimer = 0
  }, profile.attentionDurationMs)
}

function focusableNodes(): HTMLElement[] {
  return Array.from(root.value?.querySelectorAll<HTMLElement>('[data-generative-ui-node]') ?? [])
}

function focus(direction: GenerativeUiFocusDirection): void {
  const elements = focusableNodes()
  const currentIndex = elements.findIndex(element => element === document.activeElement)
  const index = resolveGenerativeUiFocusIndex(currentIndex, elements.length, direction)
  if (index < 0) return
  elements[index].focus()
  emit('focus-node', { node_id: elements[index].dataset.generativeUiNode || '' })
}

function focusNode(nodeId: string): boolean {
  const target = focusableNodes().find(element => element.dataset.generativeUiNode === nodeId)
  if (!target) return false
  showAttention(nodeId)
  target.focus({ preventScroll: true })
  target.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'start' })
  emit('focus-node', { node_id: nodeId })
  return true
}

let renderedRevisions = new Map<string, number>()
watch(
  renderedWithLayout,
  async (entries) => {
    const changed = entries.filter(entry => renderedRevisions.get(entry.node.id) !== entry.node.revision)
    renderedRevisions = new Map(entries.map(entry => [entry.node.id, entry.node.revision]))
    if (!changed.length) return
    await nextTick()
    const latest = [...changed].sort((left, right) => (
      right.node.updated_at.localeCompare(left.node.updated_at)
      || right.item.rank - left.item.rank
    ))[0]!
    focusNode(latest.node.id)
  },
  { immediate: true, flush: 'post' },
)

onUnmounted(() => {
  if (attentionTimer) window.clearTimeout(attentionTimer)
})

function onKeydown(event: KeyboardEvent): void {
  const direction: GenerativeUiFocusDirection | null =
    event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 'next'
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 'previous'
        : event.key === 'Home' ? 'first'
          : event.key === 'End' ? 'last'
            : null
  if (!direction) return
  event.preventDefault()
  focus(direction)
}

defineExpose({ focus, focusNode })
</script>

<template>
  <section
    ref="root"
    class="generative-ui-surface-host"
    :data-device="composition.context.device"
    :data-viewport="composition.context.viewport"
    :data-surface="surface || 'all'"
    :data-canvas-columns="canvasColumns"
    :data-canvas-rows="canvasRows"
    :data-content-layout="contentLayout"
    @keydown="onKeydown"
  >
    <TransitionGroup
      name="generative-ui-node"
      :duration="{ enter: 300, leave: 300 }"
    >
      <GenerativeUiNodeHost
        v-for="entry in renderedWithLayout"
        :key="entry.node.id"
        :document-id="document.document_id"
        :document-revision="document.revision"
        :document-scope="document.scope"
        :node="entry.node"
        :placement="entry.item"
        :canvas-size="entry.canvasSize"
        :context="composition.context"
        :registry="registry"
        :action-registry="actionRegistry"
        :interactive="interactive"
        :action-mode="actionMode"
        :selected="entry.node.id === selectedNodeId"
        :attention="entry.node.id === attentionNodeId"
        :motion-profile="entry.motionProfile.id"
        :attention-duration-ms="entry.motionProfile.attentionDurationMs"
        @action="emit('action', $event)"
        @action-status="emit('action-status', $event)"
        @open-preview="emit('open-preview', $event)"
        @renderer-error="emit('renderer-error', $event)"
        @select="emit('select-node', $event)"
      />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.generative-ui-surface-host {
  display: grid;
  height: 100%;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 28px) / 3);
  grid-template-columns: none;
  grid-template-rows: repeat(var(--generative-ui-canvas-rows, 2), minmax(0, 1fr));
  align-items: stretch;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
}

.generative-ui-surface-host[data-canvas-rows='3'] {
  --generative-ui-canvas-rows: 3;
}

.generative-ui-surface-host[data-canvas-columns='1'] {
  grid-auto-columns: 100%;
  grid-template-columns: none;
}

.generative-ui-surface-host[data-canvas-columns='2'] {
  grid-auto-columns: calc((100% - 20px) / 2);
  grid-template-columns: none;
  gap: 20px;
}

.generative-ui-surface-host[data-content-layout='single'] {
  justify-content: center;
}

.generative-ui-surface-host :deep(.generative-ui-node-host) {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  scroll-snap-align: start;
}

.generative-ui-surface-host :deep([data-motion-profile='standard'].generative-ui-node-enter-active),
.generative-ui-surface-host :deep([data-motion-profile='standard'].generative-ui-node-leave-active),
.generative-ui-surface-host :deep([data-motion-profile='standard'].generative-ui-node-move) {
  transition:
    opacity 240ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 300ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 240ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.generative-ui-surface-host :deep([data-motion-profile='standard'].generative-ui-node-enter-from) {
  opacity: 0;
  transform: translateY(18px) scale(0.985);
  filter: blur(3px);
}

.generative-ui-surface-host :deep([data-motion-profile='standard'].generative-ui-node-leave-to) {
  opacity: 0;
  transform: translateY(-12px) scale(0.975);
  filter: blur(4px);
}

.generative-ui-surface-host :deep([data-canvas-size='1x1']) {
  grid-column: auto / span 1;
  grid-row: auto / span 1;
}

.generative-ui-surface-host :deep([data-canvas-size='1x2']) {
  grid-column: auto / span 1;
  grid-row: 1 / span 2;
}

.generative-ui-surface-host :deep([data-canvas-size='2x2']) {
  grid-column: auto / span 2;
  grid-row: 1 / span 2;
}

.generative-ui-surface-host :deep([data-canvas-size='3x3']) {
  grid-column: auto / span 3;
  grid-row: 1 / span 3;
}

.generative-ui-surface-host :deep([data-placement='overflow']) {
  opacity: 0.82;
}

.generative-ui-surface-host :deep(.generative-ui-node-host--glance) {
  min-height: 150px;
}

.generative-ui-surface-host :deep(.generative-ui-node-host--summary) {
  min-height: 220px;
}

.generative-ui-surface-host[data-device='phone'] :deep([data-canvas-size]),
.generative-ui-surface-host[data-viewport='compact'] :deep([data-canvas-size]) {
  grid-column: auto / span 1;
}

@media (prefers-reduced-motion: reduce) {
  .generative-ui-surface-host :deep([data-motion-profile].generative-ui-node-enter-active),
  .generative-ui-surface-host :deep([data-motion-profile].generative-ui-node-leave-active),
  .generative-ui-surface-host :deep([data-motion-profile].generative-ui-node-move) {
    transition-duration: 1ms;
  }
}
</style>

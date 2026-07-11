<script setup lang="ts">
import { computed } from 'vue'
import type {
  GenerativeUiCompositionItemV1,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'
import {
  emptyGenerativeUiActionRegistry,
  GenerativeUiActionRegistry,
} from '@/generative-ui/action-registry'
import {
  emptyGenerativeUiRendererRegistry,
  GenerativeUiRendererRegistry,
} from '@/generative-ui/renderer-registry'
import type {
  GenerativeUiActionRequestV1,
  GenerativeUiPreviewRequestV1,
} from '@/generative-ui/types'
import GenerativeUiFallbackRenderer from './GenerativeUiFallbackRenderer.vue'
import DeclarativeRenderer from './DeclarativeRenderer.vue'
import RendererErrorBoundary from './RendererErrorBoundary.vue'

const props = withDefaults(defineProps<{
  documentId: string
  node: GenerativeUiStoredNodeV1
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
  registry?: GenerativeUiRendererRegistry
  actionRegistry?: GenerativeUiActionRegistry
  interactive?: boolean
}>(), {
  interactive: true,
})

const emit = defineEmits<{
  (event: 'action', payload: GenerativeUiActionRequestV1): void
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
  (event: 'renderer-error', payload: { node_id: string; message: string }): void
}>()

const registry = computed(() => props.registry ?? emptyGenerativeUiRendererRegistry)
const actionRegistry = computed(() => props.actionRegistry ?? emptyGenerativeUiActionRegistry)
const availableActions = computed(() => actionRegistry.value.availableFor(props.node))
const resolution = computed(() => registry.value.resolve(
  props.node,
  props.placement.surface,
  props.context.device,
))
const registeredComponent = computed(() => (
  resolution.value.mode === 'specialized' || resolution.value.mode === 'core_projection'
    ? resolution.value.component
    : null
))
const declarativeDocument = computed(() => (
  resolution.value.mode === 'declarative' ? resolution.value.document : null
))
const unavailable = computed(() => resolution.value.mode === 'unavailable')
const fallbackReason = computed(() => (
  resolution.value.mode === 'fallback' || resolution.value.mode === 'unavailable'
    ? resolution.value.reason
    : undefined
))
const resolutionName = computed(() => resolution.value.mode)
const resetKey = computed(() => `${props.node.id}:${props.node.revision}:${resolutionName.value}`)

function requestAction(action: NonNullable<GenerativeUiStoredNodeV1['actions']>[number]): void {
  emit('action', {
    document_id: props.documentId,
    node_id: props.node.id,
    node_revision: props.node.revision,
    action: structuredClone(action),
  })
}

function reportRendererError(payload: { message: string }): void {
  emit('renderer-error', { node_id: props.node.id, message: payload.message })
}
</script>

<template>
  <article
    class="generative-ui-node-host"
    :class="`generative-ui-node-host--${placement.variant}`"
    :data-generative-ui-node="node.id"
    :data-kind="node.kind"
    :data-renderer-resolution="resolutionName"
    :data-placement="placement.placement"
    tabindex="0"
  >
    <RendererErrorBoundary
      v-if="registeredComponent"
      :reset-key="resetKey"
      @renderer-error="reportRendererError"
    >
      <component
        :is="registeredComponent"
        :node="node"
        :placement="placement"
        :context="context"
        @open-preview="emit('open-preview', $event)"
      />
      <template #fallback="{ error }">
        <GenerativeUiFallbackRenderer :node="node" unavailable :reason="error" />
      </template>
    </RendererErrorBoundary>
    <RendererErrorBoundary
      v-else-if="declarativeDocument"
      :reset-key="resetKey"
      @renderer-error="reportRendererError"
    >
      <DeclarativeRenderer :node="node" :document="declarativeDocument" />
      <template #fallback="{ error }">
        <GenerativeUiFallbackRenderer :node="node" unavailable :reason="error" />
      </template>
    </RendererErrorBoundary>
    <GenerativeUiFallbackRenderer
      v-else
      :node="node"
      :unavailable="unavailable"
      :reason="fallbackReason"
    />

    <nav v-if="interactive !== false && availableActions.length" class="generative-ui-node-host__actions" aria-label="Actions">
      <button
        v-for="action in availableActions"
        :key="action.id"
        type="button"
        :data-style="action.style || 'secondary'"
        @click="requestAction(action)"
      >
        {{ action.label }}
      </button>
    </nav>
  </article>
</template>

<style scoped>
.generative-ui-node-host {
  display: grid;
  min-width: 0;
  min-height: 0;
  outline: none;
}

.generative-ui-node-host:focus-visible {
  border-radius: 16px;
  box-shadow: 0 0 0 2px rgba(116, 228, 227, 0.8);
}

.generative-ui-node-host__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 10px;
}

.generative-ui-node-host__actions button {
  border: 1px solid rgba(116, 228, 227, 0.25);
  border-radius: 999px;
  background: rgba(116, 228, 227, 0.09);
  padding: 7px 12px;
  color: rgba(233, 255, 253, 0.9);
  font: inherit;
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
}

.generative-ui-node-host__actions button[data-style='primary'] {
  background: rgba(116, 228, 227, 0.2);
}

.generative-ui-node-host__actions button[data-style='danger'] {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.12);
}
</style>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  GenerativeUiCanvasSize,
  GenerativeUiCompositionItemV1,
  GenerativeUiDocumentScopeV1,
  GenerativeUiMotionProfile,
  GenerativeUiStoredNodeV1,
  GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from 'lucide-vue-next'
import {
  confirmPluginAction,
  invokePluginAction,
  type InvokePluginActionRequest,
  type PluginActionResponse,
  type PluginActionStatus,
} from '@/api/agent'
import {
  emptyGenerativeUiActionRegistry,
  GenerativeUiActionRegistry,
} from '@/generative-ui/action-registry'
import { scanA2uiActionNames } from '@/generative-ui/a2ui'
import {
  emptyGenerativeUiRendererRegistry,
  GenerativeUiRendererRegistry,
} from '@/generative-ui/renderer-registry'
import type {
  GenerativeUiActionMode,
  GenerativeUiActionRequestV1,
  GenerativeUiPreviewRequestV1,
} from '@/generative-ui/types'
import type { GenerativeUiLifecycleMotion } from '@/generative-ui/motion-profiles'
import type { GenerativeUiGenerationContext } from '@/generative-ui/generation-history'
import GenerativeUiFallbackRenderer from './GenerativeUiFallbackRenderer.vue'
import DeclarativeRenderer from './DeclarativeRenderer.vue'
import CustomRendererSandbox from './CustomRendererSandbox.vue'
import RendererErrorBoundary from './RendererErrorBoundary.vue'

type ActionDisplayStatus = PluginActionStatus | 'submitting' | 'status_unknown'

interface ActionUiState {
  status: ActionDisplayStatus
  request?: InvokePluginActionRequest
  response?: PluginActionResponse
  error_message?: string
  retry_operation?: 'invoke' | 'approved' | 'denied'
}

let fallbackRequestSequence = 0
const ACTION_STATUS_POLL_INTERVAL_MS = 500
const ACTION_STATUS_POLL_MAX_ATTEMPTS = 60
const POLLABLE_ACTION_STATUSES = new Set<PluginActionStatus>(['authorized', 'running'])

const props = withDefaults(defineProps<{
  documentId: string
  documentRevision?: number
  documentScope?: GenerativeUiDocumentScopeV1
  node: GenerativeUiStoredNodeV1
  placement: GenerativeUiCompositionItemV1
  context: GenerativeUiSurfaceContextV1
  canvasSize?: GenerativeUiCanvasSize
  registry?: GenerativeUiRendererRegistry
  actionRegistry?: GenerativeUiActionRegistry
  interactive?: boolean
  actionMode?: GenerativeUiActionMode
  selected?: boolean
  attention?: boolean
  motionProfile?: GenerativeUiMotionProfile
  attentionDurationMs?: number
  lifecycleMotion?: GenerativeUiLifecycleMotion
  generation?: GenerativeUiGenerationContext
}>(), {
  interactive: true,
  actionMode: 'emit',
  selected: false,
  attention: false,
  motionProfile: 'standard',
  attentionDurationMs: 2400,
  lifecycleMotion: 'idle',
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
  (event: 'select', payload: { node_id: string }): void
  (event: 'request-generation-history', payload: { node_id: string }): void
}>()

const { t } = useI18n()
const registry = computed(() => props.registry ?? emptyGenerativeUiRendererRegistry)
const actionRegistry = computed(() => props.actionRegistry ?? emptyGenerativeUiActionRegistry)
const selectedHistoryKey = ref<string | null>(null)
const selectedHistory = computed(() => (
  props.generation?.history.find(entry => entry.key === selectedHistoryKey.value)
))
const viewingHistory = computed(() => Boolean(selectedHistory.value))
const displayNode = computed(() => selectedHistory.value?.node ?? props.node)
const availableActions = computed(() => (
  viewingHistory.value ? [] : actionRegistry.value.availableFor(props.node)
))
const resolution = computed(() => registry.value.resolve(
  displayNode.value,
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
const customRenderer = computed(() => (
  resolution.value.mode === 'custom' ? resolution.value : null
))
interface InlineRendererActionState {
  ready: boolean
  names: ReadonlySet<string>
}
function initialInlineRendererActionState(): InlineRendererActionState {
  if (resolution.value.mode === 'custom') return { ready: false, names: new Set() }
  return {
    ready: true,
    names: displayNode.value.a2ui ? scanA2uiActionNames(displayNode.value.a2ui) : new Set(),
  }
}
const inlineRendererActions = ref<InlineRendererActionState>(initialInlineRendererActionState())
const supplementaryActions = computed(() => inlineRendererActions.value.ready
  ? availableActions.value.filter(action => !inlineRendererActions.value.names.has(action.id))
  : [])
const customRendererFailure = ref<string>()
const expanded = ref(false)
const collapsed = ref(false)
const bodyElement = ref<HTMLElement | null>(null)
const unavailable = computed(() => resolution.value.mode === 'unavailable' || Boolean(customRendererFailure.value))
const fallbackReason = computed(() => (
  customRendererFailure.value
    ? customRendererFailure.value
    : resolution.value.mode === 'fallback' || resolution.value.mode === 'unavailable'
    ? resolution.value.reason
    : undefined
))
const resolutionName = computed(() => resolution.value.mode)
const resetKey = computed(() => `${displayNode.value.id}:${displayNode.value.revision}:${resolutionName.value}`)
const actionStates = ref<Record<string, ActionUiState>>({})
const actionPollGenerations = new Map<string, number>()
let unmounted = false

watch(resetKey, () => {
  customRendererFailure.value = undefined
  inlineRendererActions.value = initialInlineRendererActionState()
})
watch(expanded, value => {
  document.body.classList.toggle('generative-ui-node-expanded', value)
  if (!value) {
    selectedHistoryKey.value = null
    return
  }
  if (props.generation?.superseded_count) {
    emit('request-generation-history', { node_id: props.node.id })
  }
})

watch(
  () => props.generation?.superseded_count ?? 0,
  (count, previous) => {
    if (expanded.value && count > previous) {
      emit('request-generation-history', { node_id: props.node.id })
    }
  },
)

watch(
  () => props.generation?.history.map(entry => entry.key).join('|') ?? '',
  () => {
    if (selectedHistoryKey.value && !selectedHistory.value) selectedHistoryKey.value = null
  },
)

function interventionOperationLabel(): string {
  const operation = props.generation?.latest_intervention?.operation
  return operation ? t(`voice.generativeUi.generations.operations.${operation}`) : ''
}

function interventionStatusLabel(): string {
  const status = props.generation?.latest_intervention?.status
  return status ? t(`voice.generativeUi.generations.statuses.${status}`) : ''
}

function requestHistory(): void {
  emit('request-generation-history', { node_id: props.node.id })
}

function selectHistory(key: string | null): void {
  selectedHistoryKey.value = key
  void nextTick(() => {
    const body = bodyElement.value
    if (!body) return
    if (typeof body.scrollTo === 'function') body.scrollTo({ top: 0, behavior: 'auto' })
    else body.scrollTop = 0
  })
}

function toggleExpanded(): void {
  if (!expanded.value && collapsed.value) collapsed.value = false
  expanded.value = !expanded.value
}

function toggleCollapsed(): void {
  if (!collapsed.value && expanded.value) expanded.value = false
  collapsed.value = !collapsed.value
}

function createActionRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ui:${crypto.randomUUID()}`
  }
  fallbackRequestSequence += 1
  return `ui:${Date.now().toString(36)}:${fallbackRequestSequence.toString(36).padStart(8, '0')}`
}

function errorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message)
  }
  return t('voice.generativeUi.actions.failed')
}

function isRetryableTransportFailure(cause: unknown): boolean {
  return Boolean(
    cause
    && typeof cause === 'object'
    && 'code' in cause
    && (cause as { code?: unknown }).code === 0,
  )
}

function setActionState(actionId: string, state: ActionUiState): void {
  actionStates.value = { ...actionStates.value, [actionId]: state }
}

function cancelActionStatusPoll(actionId: string): void {
  actionPollGenerations.set(actionId, (actionPollGenerations.get(actionId) ?? 0) + 1)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function startActionStatusPoll(actionId: string, request: InvokePluginActionRequest): void {
  const generation = (actionPollGenerations.get(actionId) ?? 0) + 1
  actionPollGenerations.set(actionId, generation)
  void (async () => {
    for (let attempt = 0; attempt < ACTION_STATUS_POLL_MAX_ATTEMPTS; attempt += 1) {
      await delay(ACTION_STATUS_POLL_INTERVAL_MS)
      if (unmounted || actionPollGenerations.get(actionId) !== generation) return
      try {
        // Repeating the exact immutable request is the Manager's idempotent
        // status read. It cannot create a second execution.
        const response = await invokePluginAction(request)
        if (unmounted || actionPollGenerations.get(actionId) !== generation) return
        acceptActionResponse(actionId, request, response.data)
        if (!POLLABLE_ACTION_STATUSES.has(response.data.status)) return
      } catch (cause) {
        if (unmounted || actionPollGenerations.get(actionId) !== generation) return
        setActionState(actionId, {
          status: 'failed',
          request,
          error_message: errorMessage(cause),
          retry_operation: 'invoke',
        })
        return
      }
    }
    if (unmounted || actionPollGenerations.get(actionId) !== generation) return
    setActionState(actionId, {
      status: 'status_unknown',
      request,
      error_message: t('voice.generativeUi.actions.statusPollTimeout'),
      retry_operation: 'invoke',
    })
  })()
}

function actionRequest(
  action: NonNullable<GenerativeUiStoredNodeV1['actions']>[number],
): InvokePluginActionRequest {
  if (!props.documentScope || !Number.isSafeInteger(props.documentRevision) || props.documentRevision! < 0) {
    throw new Error(t('voice.generativeUi.actions.missingDocumentBinding'))
  }
  const requestId = createActionRequestId()
  return {
    request_id: requestId,
    idempotency_key: requestId,
    scope: structuredClone(props.documentScope),
    document_id: props.documentId,
    document_revision: props.documentRevision!,
    node_id: props.node.id,
    node_revision: props.node.revision,
    action_id: action.id,
    // A click carries no user-authored form input. Fixed Action arguments are
    // resolved again from the Manager-owned document revision.
    input: {},
  }
}

function renewActionRequest(request: InvokePluginActionRequest): InvokePluginActionRequest {
  const requestId = createActionRequestId()
  return {
    ...toRaw(request),
    request_id: requestId,
    idempotency_key: requestId,
    scope: structuredClone(toRaw(request.scope)),
    input: structuredClone(toRaw(request.input)),
  }
}

function acceptActionResponse(
  actionId: string,
  request: InvokePluginActionRequest,
  response: PluginActionResponse,
): void {
  if (response.request_id !== request.request_id) {
    throw new Error('Manager plugin Action response request binding mismatch')
  }
  setActionState(actionId, { status: response.status, request, response })
  emit('action-status', { node_id: props.node.id, action_id: actionId, response })
}

async function invokeManagerAction(
  actionId: string,
  request: InvokePluginActionRequest,
): Promise<void> {
  cancelActionStatusPoll(actionId)
  setActionState(actionId, { status: 'submitting', request })
  try {
    const response = await invokePluginAction(request)
    if (unmounted) return
    acceptActionResponse(actionId, request, response.data)
    if (POLLABLE_ACTION_STATUSES.has(response.data.status)) {
      startActionStatusPoll(actionId, request)
    }
  } catch (cause) {
    if (unmounted) return
    setActionState(actionId, {
      status: 'failed',
      request,
      error_message: errorMessage(cause),
      ...(isRetryableTransportFailure(cause) ? { retry_operation: 'invoke' as const } : {}),
    })
  }
}

async function decideAction(
  actionId: string,
  decision: 'approved' | 'denied',
): Promise<void> {
  const current = actionStates.value[actionId]
  const challenge = current?.response?.challenge
  if (!current || !current.request || current.status !== 'awaiting_confirmation' || !challenge) return
  cancelActionStatusPoll(actionId)
  setActionState(actionId, {
    ...current,
    status: 'submitting',
  })
  try {
    const response = await confirmPluginAction(current.request.request_id, {
      challenge_id: challenge.challenge_id,
      decision,
    })
    if (unmounted) return
    acceptActionResponse(actionId, current.request, response.data)
    if (POLLABLE_ACTION_STATUSES.has(response.data.status)) {
      startActionStatusPoll(actionId, current.request)
    }
  } catch (cause) {
    if (unmounted) return
    setActionState(actionId, {
      ...current,
      status: 'failed',
      error_message: errorMessage(cause),
      ...(isRetryableTransportFailure(cause) ? { retry_operation: decision } : { retry_operation: undefined }),
    })
  }
}

function retryAction(actionId: string): void {
  const current = actionStates.value[actionId]
  if (!current?.request || (!current.retry_operation && current.status !== 'needs_grant')) return
  if (current.status === 'needs_grant') {
    void invokeManagerAction(actionId, renewActionRequest(current.request))
    return
  }
  if (current.retry_operation === 'approved' || current.retry_operation === 'denied') {
    setActionState(actionId, {
      ...current,
      status: 'awaiting_confirmation',
      retry_operation: undefined,
      error_message: undefined,
    })
    void decideAction(actionId, current.retry_operation)
    return
  }
  void invokeManagerAction(actionId, current.request)
}

function actionBusy(actionId: string): boolean {
  const state = actionStates.value[actionId]
  return state?.status === 'submitting'
    || state?.status === 'authorized'
    || state?.status === 'running'
    || state?.status === 'awaiting_confirmation'
    || state?.status === 'needs_grant'
    || state?.response?.error_code === 'runtime_indeterminate'
    || Boolean(state?.retry_operation)
}

function actionStatusLabel(status: ActionDisplayStatus): string {
  const labels: Record<ActionDisplayStatus, string> = {
    submitting: 'submitting',
    status_unknown: 'statusUnknown',
    needs_grant: 'needsGrant',
    awaiting_confirmation: 'awaitingConfirmation',
    authorized: 'authorized',
    running: 'running',
    committed: 'committed',
    denied: 'denied',
    failed: 'failed',
    cancelled: 'cancelled',
  }
  return t(`voice.generativeUi.actions.${labels[status]}`)
}

onUnmounted(() => {
  unmounted = true
  document.body.classList.remove('generative-ui-node-expanded')
  for (const actionId of actionPollGenerations.keys()) cancelActionStatusPoll(actionId)
})

function requestAction(action: NonNullable<GenerativeUiStoredNodeV1['actions']>[number]): void {
  if (props.interactive === false || props.actionMode === 'disabled') return
  if (props.actionMode === 'emit') {
    emit('action', {
      document_id: props.documentId,
      node_id: props.node.id,
      node_revision: props.node.revision,
      action: structuredClone(action),
    })
    return
  }
  try {
    void invokeManagerAction(action.id, actionRequest(action))
  } catch (cause) {
    setActionState(action.id, {
      status: 'failed',
      error_message: errorMessage(cause),
    })
  }
}

function reportRendererError(payload: { message: string }): void {
  if (resolution.value.mode === 'custom') customRendererFailure.value = payload.message
  emit('renderer-error', { node_id: props.node.id, message: payload.message })
}

function requestRendererAction(name: string): void {
  const action = availableActions.value.find(candidate => candidate.id === name)
  if (action) requestAction(action)
}

function acceptInlineRendererActions(names: string[]): void {
  inlineRendererActions.value = { ready: true, names: new Set(names) }
}
</script>

<template>
  <article
    class="generative-ui-node-host"
    :class="[
      `generative-ui-node-host--${placement.variant}`,
      {
        'generative-ui-node-host--expanded': expanded,
        'generative-ui-node-host--selected': selected,
        'generative-ui-node-host--attention': attention,
        'generative-ui-node-host--collapsed': collapsed,
      },
    ]"
    :data-generative-ui-node="node.id"
    :data-kind="node.kind"
    :data-renderer-resolution="resolutionName"
    :data-placement="placement.placement"
    :data-canvas-size="canvasSize"
    :data-motion-profile="motionProfile"
    :data-attention="attention ? 'true' : 'false'"
    :data-expanded="expanded ? 'true' : 'false'"
    :data-collapsed="collapsed ? 'true' : 'false'"
    :data-lifecycle-motion="lifecycleMotion"
    :data-status-phase="node.status?.phase || 'unknown'"
    :data-generation-state="viewingHistory ? 'superseded' : generation ? 'current' : undefined"
    :data-superseded-count="generation?.superseded_count"
    :style="{ '--generative-ui-attention-duration': `${attentionDurationMs}ms` }"
    :aria-selected="selected"
    tabindex="0"
    @click="emit('select', { node_id: node.id })"
    @keydown.enter.self="emit('select', { node_id: node.id })"
    @keydown.esc.stop="expanded = false"
  >
    <div class="generative-ui-node-host__toolbar">
      <div v-if="generation" class="generative-ui-node-host__generation-badges" aria-live="polite">
        <span data-generation-badge="current">{{ t('voice.generativeUi.generations.current') }}</span>
        <span v-if="generation.superseded_count" data-generation-badge="superseded">
          {{ t('voice.generativeUi.generations.supersededCount', { count: generation.superseded_count }) }}
        </span>
        <span v-if="generation.latest_intervention" data-generation-badge="intervention">
          {{ interventionOperationLabel() }} · {{ interventionStatusLabel() }}
        </span>
      </div>
      <button
        type="button"
        class="generative-ui-node-host__tool generative-ui-node-host__minimize"
        :title="collapsed ? t('voice.generativeUi.restore') : t('voice.generativeUi.minimize')"
        :aria-label="collapsed ? t('voice.generativeUi.restore') : t('voice.generativeUi.minimize')"
        :aria-pressed="collapsed"
        @click.stop="toggleCollapsed"
      >
        <ChevronUp v-if="collapsed" :size="18" aria-hidden="true" />
        <ChevronDown v-else :size="18" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="generative-ui-node-host__tool generative-ui-node-host__expand"
        :title="expanded ? t('voice.generativeUi.collapse') : t('voice.generativeUi.expand')"
        :aria-label="expanded ? t('voice.generativeUi.collapse') : t('voice.generativeUi.expand')"
        :aria-pressed="expanded"
        @click.stop="toggleExpanded"
      >
        <Minimize2 v-if="expanded" :size="18" aria-hidden="true" />
        <Maximize2 v-else :size="18" aria-hidden="true" />
      </button>
    </div>
    <div v-if="!collapsed" ref="bodyElement" class="generative-ui-node-host__body">
      <div
        v-if="expanded && generation?.superseded_count"
        class="generative-ui-node-host__history-switcher"
        data-generation-history
        @click.stop
      >
        <div class="generative-ui-node-host__history-tabs" role="tablist" :aria-label="t('voice.generativeUi.generations.history')">
          <button
            type="button"
            role="tab"
            :aria-selected="!viewingHistory"
            :data-history-selected="!viewingHistory ? 'true' : 'false'"
            @click="selectHistory(null)"
          >
            {{ t('voice.generativeUi.generations.current') }}
          </button>
          <button
            v-for="(entry, index) in generation.history"
            :key="entry.key"
            type="button"
            role="tab"
            :aria-selected="selectedHistoryKey === entry.key"
            :data-history-selected="selectedHistoryKey === entry.key ? 'true' : 'false'"
            @click="selectHistory(entry.key)"
          >
            {{ t('voice.generativeUi.generations.supersededItem', { index: index + 1 }) }}
          </button>
        </div>
        <span v-if="generation.history_loading" class="generative-ui-node-host__history-status" role="status">
          {{ t('voice.generativeUi.generations.loading') }}
        </span>
        <button
          v-else-if="generation.history_error"
          type="button"
          class="generative-ui-node-host__history-retry"
          @click="requestHistory"
        >
          {{ t('voice.generativeUi.generations.retry') }}
        </button>
      </div>
      <div v-if="viewingHistory" class="generative-ui-node-host__historical-banner" role="status">
        <strong>{{ t('voice.generativeUi.generations.superseded') }}</strong>
        <span>{{ t('voice.generativeUi.generations.readOnly') }}</span>
      </div>
      <RendererErrorBoundary
      v-if="registeredComponent"
      :reset-key="resetKey"
      @renderer-error="reportRendererError"
    >
      <component
        :is="registeredComponent"
        :node="displayNode"
        :placement="placement"
        :context="context"
        :expanded="expanded"
        @open-preview="emit('open-preview', $event)"
        @request-action="requestRendererAction"
        @surface-actions="acceptInlineRendererActions"
      />
      <template #fallback="{ error }">
        <GenerativeUiFallbackRenderer :node="displayNode" unavailable :reason="error" />
      </template>
    </RendererErrorBoundary>
      <RendererErrorBoundary
      v-else-if="declarativeDocument"
      :reset-key="resetKey"
      @renderer-error="reportRendererError"
    >
      <DeclarativeRenderer :node="displayNode" :document="declarativeDocument" />
      <template #fallback="{ error }">
        <GenerativeUiFallbackRenderer :node="displayNode" unavailable :reason="error" />
      </template>
    </RendererErrorBoundary>
      <RendererErrorBoundary
      v-else-if="customRenderer && !customRendererFailure"
      :reset-key="resetKey"
      @renderer-error="reportRendererError"
    >
      <CustomRendererSandbox
        :node="displayNode"
        :placement="placement"
        :context="context"
        :expanded="expanded"
        :registration="customRenderer.registration"
        :source="customRenderer.source"
        :action-ids="availableActions.map(action => action.id)"
        @action="requestRendererAction"
        @open-preview="emit('open-preview', $event)"
        @surface-actions="acceptInlineRendererActions"
        @renderer-error="reportRendererError"
      />
      <template #fallback="{ error }">
        <GenerativeUiFallbackRenderer :node="displayNode" unavailable :reason="error" />
      </template>
    </RendererErrorBoundary>
      <GenerativeUiFallbackRenderer
      v-else
      :node="displayNode"
      :unavailable="unavailable"
      :reason="fallbackReason"
    />

      <nav
      v-if="!viewingHistory && interactive !== false && actionMode !== 'disabled' && supplementaryActions.length"
      class="generative-ui-node-host__actions"
      aria-label="Actions"
    >
      <button
        v-for="action in supplementaryActions"
        :key="action.id"
        type="button"
        :data-style="action.style || 'secondary'"
        :disabled="actionBusy(action.id)"
        @click="requestAction(action)"
      >
        {{ action.label }}
      </button>
    </nav>
      <template v-for="action in availableActions" :key="`status:${action.id}`">
      <div
        v-if="actionStates[action.id]"
        class="generative-ui-node-host__action-state"
        :class="`generative-ui-node-host__action-state--${actionStates[action.id]!.status}`"
        :data-action-id="action.id"
        :data-action-status="actionStates[action.id]!.status"
        :aria-busy="actionStates[action.id]!.status === 'submitting'"
        role="status"
      >
        <strong>{{ actionStatusLabel(actionStates[action.id]!.status) }}</strong>
        <p v-if="actionStates[action.id]!.error_message">
          {{ actionStates[action.id]!.error_message }}
        </p>
        <p v-else-if="actionStates[action.id]!.response?.error_message">
          {{ actionStates[action.id]!.response?.error_message }}
        </p>
        <p v-if="actionStates[action.id]!.response?.missing_permissions?.length">
          {{ t('voice.generativeUi.actions.missingPermissions', {
            permissions: actionStates[action.id]!.response?.missing_permissions?.join(', '),
          }) }}
        </p>
        <p v-if="actionStates[action.id]!.status === 'awaiting_confirmation'">
          {{ actionStates[action.id]!.response?.challenge?.message }}
        </p>
        <dl
          v-if="actionStates[action.id]!.status === 'awaiting_confirmation'"
          class="generative-ui-node-host__authority"
          data-action-authority
        >
          <dt>{{ t('voice.generativeUi.actions.effect') }}</dt>
          <dd>{{ actionStates[action.id]!.response?.challenge?.effect }}</dd>
          <dt>{{ t('voice.generativeUi.actions.permissions') }}</dt>
          <dd>
            {{ actionStates[action.id]!.response?.challenge?.permissions.length
              ? actionStates[action.id]!.response?.challenge?.permissions.join(', ')
              : t('voice.generativeUi.actions.noPermissions') }}
          </dd>
          <template
            v-for="grant in actionStates[action.id]!.response?.challenge?.effective_grants || []"
            :key="grant.permission"
          >
            <dt>{{ grant.permission }}</dt>
            <dd>
              <span v-if="grant.paths?.length">
                {{ t('voice.generativeUi.actions.paths') }}: {{ grant.paths.join(', ') }}
              </span>
              <span v-if="grant.hosts?.length">
                {{ t('voice.generativeUi.actions.hosts') }}: {{ grant.hosts.join(', ') }}
              </span>
            </dd>
          </template>
        </dl>
        <div
          v-if="actionStates[action.id]!.status === 'awaiting_confirmation'"
          class="generative-ui-node-host__confirmation"
        >
          <button type="button" data-action-confirm="approved" @click="decideAction(action.id, 'approved')">
            {{ t('voice.generativeUi.actions.approve') }}
          </button>
          <button type="button" data-action-confirm="denied" @click="decideAction(action.id, 'denied')">
            {{ t('voice.generativeUi.actions.deny') }}
          </button>
        </div>
        <button
          v-else-if="actionStates[action.id]!.status === 'needs_grant' || actionStates[action.id]!.retry_operation"
          type="button"
          data-action-retry
          @click="retryAction(action.id)"
        >
          {{ actionStates[action.id]!.status === 'needs_grant'
            ? t('voice.generativeUi.actions.retryAfterGrant')
            : t('voice.generativeUi.actions.retry') }}
        </button>
      </div>
      </template>
    </div>
    <div v-else class="generative-ui-node-host__minimal" aria-live="polite">
      <strong>{{ node.fallback.title }}</strong>
      <span>{{ node.status?.label || node.fallback.summary }}</span>
      <progress
        v-if="node.status?.progress !== undefined"
        :value="node.status.progress"
        max="100"
      />
    </div>
  </article>
</template>

<style scoped>
.generative-ui-node-host {
  position: relative;
  display: grid;
  grid-template-rows: 50px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  align-content: stretch;
  border: 1px solid rgba(116, 228, 227, 0.16);
  border-radius: 8px;
  background: rgba(10, 20, 23, 0.88);
  overflow: hidden;
  outline: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  container-name: generative-ui-block;
  container-type: size;
}

.generative-ui-node-host:hover,
.generative-ui-node-host:focus-within {
  border-color: rgba(116, 228, 227, 0.36);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.generative-ui-node-host:focus-visible {
  box-shadow: 0 0 0 2px rgba(116, 228, 227, 0.8);
}

.generative-ui-node-host--selected {
  border-color: rgba(116, 228, 227, 0.82);
  box-shadow: 0 0 0 2px rgba(68, 209, 199, 0.22), 0 18px 48px rgba(0, 0, 0, 0.28);
}

.generative-ui-node-host--selected::before {
  position: absolute;
  top: 12px;
  left: 12px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #74e4df;
  box-shadow: 0 0 12px rgba(116, 228, 223, 0.72);
  content: '';
}

[data-motion-profile='standard'].generative-ui-node-host--attention {
  animation: generative-ui-standard-attention var(--generative-ui-attention-duration) ease-out both;
}

[data-motion-profile='standard'].generative-ui-node-host--attention::after {
  position: absolute;
  inset: 0;
  z-index: 2;
  border: 1px solid rgba(116, 228, 223, 0.75);
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(116, 228, 223, 0.12);
  content: '';
  pointer-events: none;
  animation: generative-ui-standard-attention-frame var(--generative-ui-attention-duration) ease-out both;
}

@keyframes generative-ui-standard-attention {
  0% { border-color: rgba(116, 228, 227, 0.16); }
  14% { border-color: rgba(116, 228, 227, 0.92); box-shadow: 0 0 0 3px rgba(68, 209, 199, 0.2), 0 18px 56px rgba(18, 184, 170, 0.2); }
  48% { border-color: rgba(116, 228, 227, 0.58); box-shadow: 0 0 0 1px rgba(68, 209, 199, 0.12), 0 14px 44px rgba(18, 184, 170, 0.1); }
  100% { border-color: rgba(116, 228, 227, 0.16); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035); }
}

@keyframes generative-ui-standard-attention-frame {
  0% { opacity: 0; transform: scale(0.985); }
  14% { opacity: 1; transform: scale(1); }
  65% { opacity: 0.42; }
  100% { opacity: 0; transform: scale(1.006); }
}

@media (prefers-reduced-motion: reduce) {
  [data-motion-profile].generative-ui-node-host--attention,
  [data-motion-profile].generative-ui-node-host--attention::after {
    animation: none;
  }

  [data-motion-profile].generative-ui-node-host--attention {
    border-color: rgba(116, 228, 227, 0.76);
    box-shadow: 0 0 0 2px rgba(68, 209, 199, 0.18);
  }
}

.generative-ui-node-host__toolbar {
  position: relative;
  z-index: 3;
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 8px 10px 4px;
}

.generative-ui-node-host__generation-badges {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  overflow: hidden;
}

.generative-ui-node-host__generation-badges span {
  max-width: min(220px, 34cqw);
  flex: 0 1 auto;
  overflow: hidden;
  border: 1px solid rgba(116, 228, 227, 0.18);
  border-radius: 999px;
  padding: 4px 8px;
  color: rgba(218, 245, 243, 0.68);
  background: rgba(10, 31, 33, 0.72);
  font-size: 11px;
  font-weight: 720;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generative-ui-node-host__generation-badges span[data-generation-badge='current'] {
  border-color: rgba(74, 222, 128, 0.26);
  color: rgba(187, 247, 208, 0.9);
  background: rgba(22, 101, 52, 0.16);
}

.generative-ui-node-host__generation-badges span[data-generation-badge='superseded'] {
  border-color: rgba(250, 204, 21, 0.24);
  color: rgba(254, 240, 138, 0.82);
  background: rgba(113, 63, 18, 0.14);
}

.generative-ui-node-host__history-switcher {
  position: sticky;
  top: -4px;
  z-index: 4;
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: -4px 0 14px;
  border-bottom: 1px solid rgba(116, 228, 227, 0.13);
  background: rgba(9, 19, 22, 0.96);
  padding: 8px 0 10px;
}

.generative-ui-node-host__history-tabs {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.generative-ui-node-host__history-tabs button,
.generative-ui-node-host__history-retry {
  min-height: 32px;
  border: 1px solid rgba(116, 228, 227, 0.18);
  border-radius: 6px;
  padding: 6px 10px;
  color: rgba(218, 245, 243, 0.7);
  background: rgba(8, 28, 31, 0.7);
  font: inherit;
  font-size: 12px;
  font-weight: 720;
  cursor: pointer;
}

.generative-ui-node-host__history-tabs button[data-history-selected='true'] {
  border-color: rgba(116, 228, 227, 0.52);
  color: #efffff;
  background: rgba(38, 151, 145, 0.2);
}

.generative-ui-node-host__history-status {
  flex: 0 0 auto;
  color: rgba(218, 245, 243, 0.58);
  font-size: 12px;
}

.generative-ui-node-host__historical-banner {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  border-left: 3px solid rgba(250, 204, 21, 0.64);
  background: rgba(113, 63, 18, 0.12);
  padding: 8px 10px;
  color: rgba(254, 240, 138, 0.74);
  font-size: 12px;
}

.generative-ui-node-host__historical-banner strong {
  color: rgba(254, 249, 195, 0.94);
}

.generative-ui-node-host__tool {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border: 1px solid rgba(116, 228, 227, 0.22);
  border-radius: 7px;
  color: rgba(225, 255, 252, 0.76);
  background: rgba(7, 18, 21, 0.88);
  cursor: pointer;
}

.generative-ui-node-host__tool:hover,
.generative-ui-node-host__tool:focus-visible {
  border-color: rgba(116, 228, 227, 0.58);
  color: #f5fffe;
  outline: none;
}

.generative-ui-node-host__body {
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 20px 20px;
  scrollbar-gutter: stable;
}

.generative-ui-node-host__minimal {
  display: grid;
  min-width: 0;
  min-height: 0;
  align-content: center;
  gap: 8px;
  overflow: hidden;
  padding: 12px 20px 20px;
  color: rgba(224, 248, 246, 0.76);
}

.generative-ui-node-host__minimal strong,
.generative-ui-node-host__minimal span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.generative-ui-node-host__minimal strong {
  color: #f1fffe;
  font-size: 14px;
}

.generative-ui-node-host__minimal span {
  font-size: 12px;
}

.generative-ui-node-host__minimal progress {
  width: min(100%, 320px);
  height: 5px;
  accent-color: #74e4df;
}

.generative-ui-node-host[data-status-phase='succeeded'] {
  border-color: rgba(74, 222, 128, 0.38);
}

.generative-ui-node-host[data-status-phase='failed'] {
  border-color: rgba(248, 113, 113, 0.5);
}

.generative-ui-node-host[data-status-phase='blocked'] {
  border-color: rgba(250, 204, 21, 0.42);
}

[data-motion-profile='standard'][data-lifecycle-motion='update'] .generative-ui-node-host__body,
[data-motion-profile='standard'][data-lifecycle-motion='update'] .generative-ui-node-host__minimal {
  animation: generative-ui-standard-update 700ms ease-out both;
}

[data-motion-profile='standard'][data-lifecycle-motion='complete'] .generative-ui-node-host__body,
[data-motion-profile='standard'][data-lifecycle-motion='complete'] .generative-ui-node-host__minimal {
  animation: generative-ui-standard-complete 1000ms ease-out both;
}

[data-motion-profile='standard'][data-lifecycle-motion='fail'] .generative-ui-node-host__body,
[data-motion-profile='standard'][data-lifecycle-motion='fail'] .generative-ui-node-host__minimal {
  animation: generative-ui-standard-fail 1000ms ease-out both;
}

@keyframes generative-ui-standard-update {
  0% { background-color: rgba(116, 228, 223, 0.2); }
  100% { background-color: transparent; }
}

@keyframes generative-ui-standard-complete {
  0% { background-color: rgba(74, 222, 128, 0.24); }
  45% { background-color: rgba(74, 222, 128, 0.1); }
  100% { background-color: transparent; }
}

@keyframes generative-ui-standard-fail {
  0% { background-color: rgba(248, 113, 113, 0.28); }
  45% { background-color: rgba(248, 113, 113, 0.1); }
  100% { background-color: transparent; }
}

.generative-ui-node-host--expanded {
  position: fixed !important;
  inset: 18px !important;
  z-index: 180;
  width: auto !important;
  height: auto !important;
  max-width: none !important;
  max-height: none !important;
  grid-column: auto !important;
  grid-row: auto !important;
  overflow-x: hidden;
  overflow-y: hidden;
  border-color: rgba(116, 228, 227, 0.46);
  background: #091316;
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.72);
}

:global(body.generative-ui-node-expanded) {
  overflow: hidden;
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

.generative-ui-node-host__actions button:disabled,
.generative-ui-node-host__action-state button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.generative-ui-node-host__action-state {
  display: grid;
  justify-items: start;
  gap: 6px;
  margin-top: 8px;
  border: 1px solid rgba(116, 228, 227, 0.18);
  border-radius: 12px;
  background: rgba(8, 26, 29, 0.72);
  padding: 9px 11px;
  color: rgba(220, 243, 242, 0.76);
  font-size: 12px;
}

.generative-ui-node-host__action-state strong,
.generative-ui-node-host__action-state p {
  margin: 0;
}

.generative-ui-node-host__action-state--committed {
  border-color: rgba(74, 222, 128, 0.32);
  color: rgba(187, 247, 208, 0.9);
}

.generative-ui-node-host__action-state--failed,
.generative-ui-node-host__action-state--denied,
.generative-ui-node-host__action-state--cancelled {
  border-color: rgba(248, 113, 113, 0.32);
  color: rgba(254, 202, 202, 0.9);
}

.generative-ui-node-host__confirmation {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.generative-ui-node-host__authority {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 10px;
  margin: 8px 0;
  font-size: 12px;
}

.generative-ui-node-host__authority dt {
  color: rgba(233, 255, 253, 0.62);
  font-weight: 700;
}

.generative-ui-node-host__authority dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.generative-ui-node-host__authority dd span {
  display: block;
}

.generative-ui-node-host__action-state button {
  border: 1px solid rgba(116, 228, 227, 0.25);
  border-radius: 999px;
  background: rgba(116, 228, 227, 0.09);
  padding: 6px 10px;
  color: inherit;
  font: inherit;
  font-weight: 750;
  cursor: pointer;
}

@media (pointer: coarse) {
  .generative-ui-node-host__tool {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
  }
}

@media (max-width: 640px) {
  .generative-ui-node-host--expanded {
    inset: 8px !important;
  }

  .generative-ui-node-host__body {
    padding: 2px 14px 16px;
  }

  .generative-ui-node-host__toolbar {
    padding-inline: 8px;
  }

  .generative-ui-node-host__generation-badges span[data-generation-badge='intervention'] {
    display: none;
  }

  .generative-ui-node-host__history-switcher {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-motion-profile][data-lifecycle-motion] .generative-ui-node-host__body,
  [data-motion-profile][data-lifecycle-motion] .generative-ui-node-host__minimal {
    animation: none;
  }
}
</style>

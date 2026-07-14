<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  confirmPluginAgentTool,
  getVoiceGenerativeUiProjection,
  type AgentToolResponseV1,
  type GenerativeUiCanonicalProjectionV1,
  type GenerativeUiPreviewRequestV1,
  type PendingAgentToolConfirmationV1,
  type PluginActionResponse,
} from '@/api/agent'
import { resolveGenerativeUiDeviceContext } from '@/generative-ui/device-context'
import { GenerativeUiProjectionCache } from '@/generative-ui/document-store'
import { buildProjectedGenerativeUiRegistry } from '@/generative-ui/projected-registry'
import GenerativeUiSurfaceHost from './GenerativeUiSurfaceHost.vue'

const props = defineProps<{
  sessionId: string
  refreshToken?: string | number | null
  activeRunId?: string | null
  selectedNodeId?: string | null
}>()

const emit = defineEmits<{
  (event: 'availability', payload: { available: boolean; node_ids: string[]; loading?: boolean }): void
  (event: 'action-status', payload: {
    node_id: string
    action_id: string
    response: PluginActionResponse
  }): void
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
  (event: 'select-node', payload: { node_id: string }): void
}>()

const cache = new GenerativeUiProjectionCache()
const { t } = useI18n()
const projection = shallowRef<GenerativeUiCanonicalProjectionV1 | null>(null)
const toolDecisionStates = ref<Record<string, { busy: boolean; error?: string }>>({})
const runtimeRegistry = computed(() => (
  projection.value ? buildProjectedGenerativeUiRegistry(projection.value.ui_registry) : null
))
const pendingToolConfirmations = computed(() => projection.value?.pending_tool_confirmations ?? [])
let requestGeneration = 0
let disposed = false

function currentContext() {
  return resolveGenerativeUiDeviceContext({
    width: window.innerWidth,
    height: window.innerHeight,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    activeRunId: props.activeRunId,
  })
}

async function refreshProjection(): Promise<boolean> {
  const generation = ++requestGeneration
  let authorityRejected = false
  try {
    const response = await getVoiceGenerativeUiProjection(props.sessionId, currentContext())
    if (generation !== requestGeneration) return false
    try {
      if (
        response.data.mode !== 'prefer'
        || response.data.authoritative !== true
        || response.data.purpose !== 'canonical'
        || response.data.document.scope.type !== 'voice_session'
        || response.data.document.scope.id !== props.sessionId
      ) throw new Error('Manager did not return a session-bound authoritative canonical Generative UI projection')
      cache.acceptProjection(response.data)
      const accepted = cache.current() as GenerativeUiCanonicalProjectionV1
      if (accepted.document.nodes.length === 0 && accepted.pending_tool_confirmations.length === 0) {
        cache.clear()
        projection.value = null
        emit('availability', { available: false, node_ids: [] })
        return true
      }
      projection.value = accepted
    } catch (cause) {
      authorityRejected = true
      throw cause
    }
    emit('availability', {
      available: true,
      node_ids: projection.value.document.nodes.map(node => node.id),
    })
    return true
  } catch (cause) {
    if (generation !== requestGeneration) return false
    const status = cause && typeof cause === 'object' && 'code' in cause
      ? Number((cause as { code?: unknown }).code)
      : undefined
    if (authorityRejected || status === 404) {
      cache.clear()
      projection.value = null
      emit('availability', { available: false, node_ids: [] })
      return status === 404
    }
    const current = cache.current()
    if (current?.mode === 'prefer') {
      projection.value = current
      emit('availability', {
        available: true,
        node_ids: projection.value.document.nodes.map(node => node.id),
      })
      return false
    }
    projection.value = null
    emit('availability', { available: false, node_ids: [] })
    return false
  }
}

async function refresh(): Promise<void> {
  await refreshProjection()
}

function toolErrorMessage(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message?: unknown }).message)
  }
  return t('voice.generativeUi.toolConfirmations.failed')
}

function setToolDecisionState(requestId: string, state: { busy: boolean; error?: string }): void {
  toolDecisionStates.value = { ...toolDecisionStates.value, [requestId]: state }
}

function clearToolDecisionState(requestId: string): void {
  const next = { ...toolDecisionStates.value }
  delete next[requestId]
  toolDecisionStates.value = next
}

function assertToolResponseBinding(
  pending: PendingAgentToolConfirmationV1,
  response: AgentToolResponseV1,
): void {
  if (
    response.request_id !== pending.request_id
    || response.request_digest !== pending.request_digest
    || response.tool.local_id !== pending.tool.local_id
    || response.tool.qualified_id !== pending.tool.qualified_id
    || response.tool.wire_id !== pending.tool.wire_id
  ) throw new Error(t('voice.generativeUi.toolConfirmations.bindingMismatch'))
}

async function decideToolConfirmation(
  pending: PendingAgentToolConfirmationV1,
  decision: 'approved' | 'denied',
): Promise<void> {
  if (toolDecisionStates.value[pending.request_id]?.busy) return
  setToolDecisionState(pending.request_id, { busy: true })
  try {
    const response = await confirmPluginAgentTool(pending.request_id, {
      challenge_id: pending.challenge.challenge_id,
      decision,
    })
    if (disposed) return
    assertToolResponseBinding(pending, response.data)
    const refreshed = await refreshProjection()
    if (disposed) return
    if (refreshed) clearToolDecisionState(pending.request_id)
    else setToolDecisionState(pending.request_id, {
      busy: false,
      error: t('voice.generativeUi.toolConfirmations.refreshFailed'),
    })
  } catch (cause) {
    if (disposed) return
    setToolDecisionState(pending.request_id, { busy: false, error: toolErrorMessage(cause) })
  }
}

async function refreshToolConfirmations(requestId: string): Promise<void> {
  if (toolDecisionStates.value[requestId]?.busy) return
  setToolDecisionState(requestId, { busy: true })
  const refreshed = await refreshProjection()
  if (disposed) return
  if (refreshed) clearToolDecisionState(requestId)
  else setToolDecisionState(requestId, {
    busy: false,
    error: t('voice.generativeUi.toolConfirmations.refreshFailed'),
  })
}

function formattedExpiry(value: string): string {
  return new Date(value).toLocaleString()
}

async function onActionStatus(payload: {
  node_id: string
  action_id: string
  response: PluginActionResponse
}): Promise<void> {
  emit('action-status', payload)
  if (payload.response.status === 'committed') await refresh()
}

function resetAndRefresh(): void {
  requestGeneration += 1
  cache.clear()
  projection.value = null
  toolDecisionStates.value = {}
  emit('availability', { available: false, node_ids: [], loading: true })
  void refresh()
}

function onResize(): void {
  void refresh()
}

watch(() => props.sessionId, resetAndRefresh)
watch(
  () => [props.refreshToken, props.activeRunId],
  () => { void refresh() },
)

onMounted(() => {
  disposed = false
  window.addEventListener('resize', onResize)
  emit('availability', { available: false, node_ids: [], loading: true })
  void refresh()
})

onUnmounted(() => {
  disposed = true
  requestGeneration += 1
  window.removeEventListener('resize', onResize)
})

defineExpose({ refresh })
</script>

<template>
  <section
    v-if="projection"
    class="generative-ui-canonical-surface"
    data-generative-ui-mode="prefer"
    data-generative-ui-authoritative="true"
  >
    <section
      v-if="pendingToolConfirmations.length"
      class="generative-ui-canonical-surface__tool-confirmations"
      data-agent-tool-confirmations
      data-manager-owned="true"
      :aria-label="t('voice.generativeUi.toolConfirmations.title')"
    >
      <header>
        <strong>{{ t('voice.generativeUi.toolConfirmations.title') }}</strong>
        <span>{{ t('voice.generativeUi.toolConfirmations.managerOwned') }}</span>
      </header>
      <article
        v-for="pending in pendingToolConfirmations"
        :key="pending.request_id"
        class="generative-ui-canonical-surface__tool-confirmation"
        :data-tool-confirmation-request="pending.request_id"
        :aria-busy="toolDecisionStates[pending.request_id]?.busy === true"
      >
        <h3>{{ pending.tool.qualified_id }}</h3>
        <p>{{ pending.challenge.message }}</p>
        <dl data-agent-tool-authority>
          <dt>{{ t('voice.generativeUi.actions.effect') }}</dt>
          <dd>{{ pending.challenge.effect }}</dd>
          <dt>{{ t('voice.generativeUi.actions.permissions') }}</dt>
          <dd>
            {{ pending.challenge.permissions.length
              ? pending.challenge.permissions.join(', ')
              : t('voice.generativeUi.actions.noPermissions') }}
          </dd>
          <template v-for="grant in pending.challenge.effective_grants" :key="grant.permission">
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
          <dt>{{ t('voice.generativeUi.toolConfirmations.expires') }}</dt>
          <dd><time :datetime="pending.challenge.expires_at">{{ formattedExpiry(pending.challenge.expires_at) }}</time></dd>
        </dl>
        <p
          v-if="toolDecisionStates[pending.request_id]?.error"
          class="generative-ui-canonical-surface__tool-error"
          data-agent-tool-confirmation-error
          role="alert"
        >
          {{ toolDecisionStates[pending.request_id]?.error }}
        </p>
        <p
          v-if="toolDecisionStates[pending.request_id]?.busy"
          class="generative-ui-canonical-surface__tool-busy"
          data-agent-tool-confirmation-busy
          role="status"
        >
          {{ t('voice.generativeUi.toolConfirmations.busy') }}
        </p>
        <div class="generative-ui-canonical-surface__tool-controls">
          <button
            type="button"
            data-agent-tool-confirm="approved"
            :disabled="toolDecisionStates[pending.request_id]?.busy === true || Boolean(toolDecisionStates[pending.request_id]?.error)"
            @click="decideToolConfirmation(pending, 'approved')"
          >
            {{ t('voice.generativeUi.actions.approve') }}
          </button>
          <button
            type="button"
            data-agent-tool-confirm="denied"
            :disabled="toolDecisionStates[pending.request_id]?.busy === true || Boolean(toolDecisionStates[pending.request_id]?.error)"
            @click="decideToolConfirmation(pending, 'denied')"
          >
            {{ t('voice.generativeUi.actions.deny') }}
          </button>
          <button
            v-if="toolDecisionStates[pending.request_id]?.error"
            type="button"
            data-agent-tool-confirmation-refresh
            :disabled="toolDecisionStates[pending.request_id]?.busy === true"
            @click="refreshToolConfirmations(pending.request_id)"
          >
            {{ t('voice.generativeUi.toolConfirmations.refresh') }}
          </button>
        </div>
      </article>
    </section>
    <GenerativeUiSurfaceHost
      v-if="projection.document.nodes.length"
      :document="projection.document"
      :composition="projection.composition"
      :registry="runtimeRegistry?.renderers"
      :action-registry="runtimeRegistry?.actions"
      :interactive="true"
      :selected-node-id="selectedNodeId"
      action-mode="manager"
      @action-status="onActionStatus"
      @open-preview="emit('open-preview', $event)"
      @select-node="emit('select-node', $event)"
    />
  </section>
</template>

<style scoped>
.generative-ui-canonical-surface {
  height: 100%;
  min-height: 0;
  min-width: 0;
  grid-row: 1 / -1;
  overflow: hidden;
  scroll-snap-align: start;
}

.generative-ui-canonical-surface__tool-confirmations {
  display: grid;
  gap: 12px;
  margin: 12px;
  padding: 14px;
  border: 1px solid rgba(116, 228, 227, 0.5);
  border-radius: 14px;
  background: rgba(8, 23, 35, 0.92);
}

.generative-ui-canonical-surface__tool-confirmations > header,
.generative-ui-canonical-surface__tool-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.generative-ui-canonical-surface__tool-confirmations > header span {
  color: rgba(190, 244, 243, 0.72);
  font-size: 12px;
}

.generative-ui-canonical-surface__tool-confirmation {
  display: grid;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
}

.generative-ui-canonical-surface__tool-confirmation h3,
.generative-ui-canonical-surface__tool-confirmation p {
  margin: 0;
}

.generative-ui-canonical-surface__tool-confirmation dl {
  display: grid;
  grid-template-columns: minmax(88px, auto) 1fr;
  gap: 6px 12px;
  margin: 0;
}

.generative-ui-canonical-surface__tool-confirmation dt {
  color: rgba(190, 244, 243, 0.72);
}

.generative-ui-canonical-surface__tool-confirmation dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.generative-ui-canonical-surface__tool-controls {
  justify-content: flex-start;
}

.generative-ui-canonical-surface__tool-controls button {
  padding: 6px 12px;
  border: 1px solid rgba(116, 228, 227, 0.55);
  border-radius: 999px;
  color: inherit;
  background: rgba(116, 228, 227, 0.12);
  cursor: pointer;
}

.generative-ui-canonical-surface__tool-controls button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.generative-ui-canonical-surface__tool-error {
  color: #ffb4ab;
}

.generative-ui-canonical-surface__tool-busy {
  color: rgba(190, 244, 243, 0.82);
}
</style>

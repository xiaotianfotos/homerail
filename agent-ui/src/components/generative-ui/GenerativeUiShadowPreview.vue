<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getVoiceGenerativeUiProjection,
  type GenerativeUiPreviewRequestV1,
  type GenerativeUiProjectionV1,
  type GenerativeUiStreamEventV1,
} from '@/api/agent'
import { resolveGenerativeUiDeviceContext } from '@/generative-ui/device-context'
import { GenerativeUiProjectionCache } from '@/generative-ui/document-store'
import { buildProjectedGenerativeUiRegistry } from '@/generative-ui/projected-registry'
import GenerativeUiSurfaceHost from './GenerativeUiSurfaceHost.vue'

const props = defineProps<{
  sessionId: string
  refreshToken?: string | number | null
  activeRunId?: string | null
}>()

const emit = defineEmits<{
  (event: 'open-preview', payload: GenerativeUiPreviewRequestV1): void
}>()

const { t } = useI18n()
const cache = new GenerativeUiProjectionCache()
const projection = shallowRef<GenerativeUiProjectionV1 | null>(null)
const loading = ref(false)
const error = ref('')
const runtimeRegistry = computed(() => (
  projection.value ? buildProjectedGenerativeUiRegistry(projection.value.ui_registry) : null
))
let requestGeneration = 0

function currentContext() {
  return resolveGenerativeUiDeviceContext({
    width: window.innerWidth,
    height: window.innerHeight,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    activeRunId: props.activeRunId,
  })
}

async function refresh(): Promise<void> {
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  try {
    const response = await getVoiceGenerativeUiProjection(props.sessionId, currentContext())
    if (generation !== requestGeneration) return
    if (
      response.data.mode !== 'shadow'
      || response.data.authoritative !== false
      || response.data.purpose !== 'legacy_widget_shadow'
    ) throw new Error('Manager did not return a read-only shadow Generative UI projection')
    cache.acceptProjection(response.data)
    projection.value = cache.current()
  } catch (cause) {
    if (generation !== requestGeneration) return
    projection.value = cache.current()
    error.value = cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : t('voice.generativeUi.previewUnavailable')
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

async function acceptStreamEvent(event: GenerativeUiStreamEventV1): Promise<void> {
  const result = cache.acceptStreamEvent(event)
  projection.value = cache.current()
  if (result === 'refresh_required') await refresh()
}

function onResize(): void {
  void refresh()
}

watch(
  () => [props.sessionId, props.refreshToken, props.activeRunId],
  () => { cache.clear(); void refresh() },
)

onMounted(() => {
  window.addEventListener('resize', onResize)
  void refresh()
})

onUnmounted(() => {
  requestGeneration += 1
  window.removeEventListener('resize', onResize)
})

defineExpose({ acceptStreamEvent, refresh })
</script>

<template>
  <section class="generative-ui-shadow-preview" aria-live="polite">
    <header>
      <span>{{ t('voice.generativeUi.shadowPreview') }}</span>
      <em>{{ t('voice.generativeUi.nonInteractive') }}</em>
    </header>
    <p v-if="loading && !projection" class="generative-ui-shadow-preview__state">
      {{ t('voice.generativeUi.loading') }}
    </p>
    <p v-else-if="error && !projection" class="generative-ui-shadow-preview__state generative-ui-shadow-preview__state--error">
      {{ error }}
    </p>
    <GenerativeUiSurfaceHost
      v-else-if="projection"
      :document="projection.document"
      :composition="projection.composition"
      :registry="runtimeRegistry?.renderers"
      :action-registry="runtimeRegistry?.actions"
      :interactive="false"
      action-mode="disabled"
      @open-preview="emit('open-preview', $event)"
    />
  </section>
</template>

<style scoped>
.generative-ui-shadow-preview {
  display: grid;
  align-content: start;
  gap: 12px;
  height: 100%;
  overflow: auto;
}

.generative-ui-shadow-preview > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.generative-ui-shadow-preview > header span,
.generative-ui-shadow-preview > header em {
  border-radius: 999px;
  padding: 5px 9px;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}

.generative-ui-shadow-preview > header span {
  background: rgba(116, 228, 227, 0.12);
  color: #8df4ef;
}

.generative-ui-shadow-preview > header em {
  background: rgba(251, 191, 36, 0.1);
  color: rgba(253, 230, 138, 0.8);
}

.generative-ui-shadow-preview__state {
  margin: auto;
  color: rgba(220, 243, 242, 0.6);
}

.generative-ui-shadow-preview__state--error {
  color: rgba(253, 186, 186, 0.8);
}
</style>

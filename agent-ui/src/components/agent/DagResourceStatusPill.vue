<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Hammer, Loader2 } from 'lucide-vue-next'
import { getManagerAgentReadiness, type ManagerAgentReadiness } from '@/api/services/voice-agent-api'
import { cn } from '@/lib/utils'

type WorkerImage = NonNullable<ManagerAgentReadiness['checks']['dag_resources']>['worker_image']

const { t } = useI18n()

const workerImage = ref<WorkerImage | null>(null)
const open = ref(false)
let timer: number | undefined

const visible = computed(() => {
  const status = workerImage.value?.status
  return status === 'checking' || status === 'building' || status === 'error' || status === 'skipped'
})

const preparing = computed(() => {
  const status = workerImage.value?.status
  return status === 'checking' || status === 'building'
})

const label = computed(() => {
  if (preparing.value) return t('dag.resources.preparingShort')
  if (workerImage.value?.status === 'error') return t('dag.resources.resources')
  return t('dag.resources.preparation')
})

const title = computed(() => {
  if (!workerImage.value) return t('dag.resources.preparing')
  if (preparing.value) return t('dag.resources.preparingDescription')
  if (workerImage.value.status === 'error') return workerImage.value.error || workerImage.value.message
  if (workerImage.value.status === 'skipped') return t('dag.resources.skipped')
  return workerImage.value.message
})

async function refresh(): Promise<void> {
  try {
    const readiness = await getManagerAgentReadiness()
    workerImage.value = readiness.checks.dag_resources?.worker_image ?? null
    if (!visible.value) open.value = false
  } catch {
    workerImage.value = null
    open.value = false
  }
}

function toggle(): void {
  if (!visible.value) return
  open.value = !open.value
}

onMounted(() => {
  void refresh()
  timer = window.setInterval(() => void refresh(), 2500)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})
</script>

<template>
  <div v-if="visible" class="dag-resource-status">
    <button
      type="button"
      class="dag-resource-status__button"
      :class="cn(workerImage?.status === 'error' && 'dag-resource-status__button--error')"
      :title="title"
      @click="toggle"
    >
      <Loader2 v-if="preparing" class="h-4 w-4 animate-spin" />
      <AlertTriangle v-else-if="workerImage?.status === 'error'" class="h-4 w-4" />
      <Hammer v-else class="h-4 w-4" />
      <span>{{ label }}</span>
    </button>
    <div v-if="open" class="dag-resource-status__tooltip">
      <strong>{{ preparing ? t('dag.resources.preparing') : t('dag.resources.status') }}</strong>
      <span>{{ title }}</span>
      <em v-if="workerImage?.image">{{ workerImage.image }}</em>
    </div>
  </div>
</template>

<style scoped>
.dag-resource-status {
  position: relative;
}

.dag-resource-status__button {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 2.25rem;
  padding: 0 0.75rem;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.22);
  background: rgba(34, 211, 238, 0.08);
  color: rgba(207, 250, 254, 0.95);
  font-size: 0.82rem;
  transition: background 160ms ease, border-color 160ms ease;
}

.dag-resource-status__button:hover {
  border-color: rgba(103, 232, 249, 0.45);
  background: rgba(34, 211, 238, 0.13);
}

.dag-resource-status__button--error {
  border-color: rgba(251, 191, 36, 0.34);
  background: rgba(251, 191, 36, 0.08);
  color: rgba(254, 243, 199, 0.95);
}

.dag-resource-status__tooltip {
  position: absolute;
  top: calc(100% + 0.55rem);
  right: 0;
  z-index: 80;
  display: grid;
  gap: 0.28rem;
  width: min(21rem, 76vw);
  padding: 0.75rem 0.85rem;
  border-radius: 0.65rem;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(8, 13, 18, 0.96);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.76);
}

.dag-resource-status__tooltip strong {
  color: rgba(255, 255, 255, 0.92);
  font-size: 0.82rem;
}

.dag-resource-status__tooltip span {
  font-size: 0.76rem;
  line-height: 1.45;
}

.dag-resource-status__tooltip em {
  font-size: 0.7rem;
  font-style: normal;
  color: rgba(255, 255, 255, 0.42);
  overflow-wrap: anywhere;
}
</style>

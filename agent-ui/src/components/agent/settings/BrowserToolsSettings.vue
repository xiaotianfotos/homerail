<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Bot, Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '@/stores/ui-store'

const { t } = useI18n()
const uiStore = useUiStore()
const status = ref<DesktopBrowserToolsStatus | null>(null)
const desktopManaged = ref(false)
const switching = ref(false)
const localError = ref('')
let removeListener: (() => void) | null = null
let desktopStatusRevision = 0

const statusKey = computed(() => {
  if (localError.value || uiStore.browserToolsRuntimeStatus.error) return 'error'
  return uiStore.browserToolsRuntimeStatus.state
})

const enabled = computed(() => desktopManaged.value
  ? Boolean(status.value?.enabled)
  : uiStore.webBrowserToolsEnabled)

const nativeStatusKey = computed(() => {
  if (!desktopManaged.value || !status.value?.enabled) return null
  if (!status.value.supported || status.value.state === 'unavailable') return 'native-unavailable'
  if (status.value.error || status.value.state === 'error') return 'native-error'
  if (status.value.state === 'restart-required') return 'restart-required'
  if (status.value.state === 'starting') return 'native-starting'
  if (status.value.state === 'connected') return 'native-connected'
  return null
})

function desktopBridge(): HomeRailDesktopBridge | null {
  return typeof window === 'undefined' ? null : window.homerailDesktop ?? null
}

async function toggle(): Promise<void> {
  const bridge = desktopBridge()
  if (switching.value) return
  if (!desktopManaged.value) {
    uiStore.setWebBrowserToolsEnabled(!uiStore.webBrowserToolsEnabled)
    return
  }
  if (!bridge?.setBrowserToolsEnabled || !status.value) return
  switching.value = true
  localError.value = ''
  try {
    status.value = await bridge.setBrowserToolsEnabled(!enabled.value)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    switching.value = false
  }
}

onMounted(() => {
  const bridge = desktopBridge()
  desktopManaged.value = Boolean(
    bridge?.browserToolsStatus && bridge?.setBrowserToolsEnabled,
  )
  if (!desktopManaged.value || !bridge?.browserToolsStatus) return
  const initialStatusRevision = desktopStatusRevision
  removeListener = bridge.onBrowserToolsStatus?.((nextStatus) => {
    desktopStatusRevision += 1
    status.value = nextStatus
  }) ?? null
  void bridge.browserToolsStatus()
    .then((nextStatus) => {
      if (desktopStatusRevision === initialStatusRevision) status.value = nextStatus
    })
    .catch((error) => {
      if (desktopStatusRevision === initialStatusRevision) {
        localError.value = error instanceof Error ? error.message : String(error)
      }
    })
})

onBeforeUnmount(() => {
  desktopStatusRevision += 1
  removeListener?.()
  removeListener = null
})
</script>

<template>
  <div
    class="rounded-2xl border border-[var(--hr-settings-divider)] bg-[var(--hr-settings-card)] p-5"
    data-testid="desktop-browser-tools-settings"
  >
    <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-start gap-3">
        <div
          class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-accent)]"
        >
          <Loader2 v-if="switching" class="h-5 w-5 animate-spin" />
          <Bot v-else class="h-5 w-5" />
        </div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-semibold text-[var(--hr-text-1)]">
              {{ t('settings.experimental.browserTools.title') }}
            </h3>
            <span
              class="rounded-full border border-[var(--hr-warning-border)] bg-[var(--hr-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--hr-warning)]"
            >
              {{ t('settings.experimental.badge') }}
            </span>
          </div>
          <p class="mt-1 max-w-2xl text-sm leading-6 text-[var(--hr-text-3)]">
            {{ t('settings.experimental.browserTools.description') }}
          </p>
          <p
            class="mt-2 text-xs leading-5"
            :class="statusKey === 'error' || statusKey === 'unavailable'
              ? 'text-[var(--hr-danger)]'
              : ['direct', 'direct-native', 'native-only'].includes(statusKey)
                ? 'text-[var(--hr-success)]'
                : 'text-[var(--hr-text-3)]'"
            data-testid="desktop-browser-tools-state"
          >
            {{ t(`settings.experimental.browserTools.state.${statusKey}`) }}
            <span v-if="localError || uiStore.browserToolsRuntimeStatus.error">：{{ localError || uiStore.browserToolsRuntimeStatus.error }}</span>
          </p>
          <p
            v-if="nativeStatusKey"
            class="mt-1 text-xs leading-5 text-[var(--hr-text-3)]"
            data-testid="desktop-browser-tools-native-state"
          >
            {{ t(`settings.experimental.browserTools.state.${nativeStatusKey}`) }}
          </p>
        </div>
      </div>

      <div class="inline-flex flex-shrink-0 items-center gap-3 sm:pl-4">
        <span
          class="text-xs font-medium"
          :class="enabled ? 'text-[var(--hr-info)]' : 'text-[var(--hr-text-3)]'"
        >
          {{ enabled ? t('settings.actions.enabled') : t('settings.actions.disabled') }}
        </span>
        <button
          data-testid="desktop-browser-tools-toggle"
          type="button"
          role="switch"
          class="relative h-7 w-12 rounded-full border transition disabled:cursor-not-allowed disabled:opacity-60"
          :class="enabled
            ? 'border-[var(--hr-info-border)] bg-[var(--hr-info)]'
            : 'border-[var(--hr-border-strong)] bg-[var(--hr-surface-2)]'"
          :aria-checked="enabled"
          :aria-label="t('settings.experimental.browserTools.title')"
          :disabled="switching || (desktopManaged && !status)"
          @click="toggle"
        >
          <span
            class="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform"
            :class="enabled ? 'translate-x-5' : 'translate-x-0'"
          />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, FlaskConical, Loader2, ShieldCheck } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const status = ref<DesktopUpdateStatus | null>(null)
const bridgeAvailable = ref(false)
const switching = ref(false)
const localError = ref('')
let removeListener: (() => void) | null = null

const channelBusy = computed(() => {
  if (switching.value) return true
  return ['checking', 'available', 'downloading', 'downloaded'].includes(status.value?.state ?? '')
})

const statusText = computed(() => {
  if (!status.value) return ''
  return t(`settings.general.updates.state.${status.value.state}`)
})

function desktopBridge(): HomeRailDesktopBridge | null {
  return typeof window === 'undefined' ? null : window.homerailDesktop ?? null
}

async function selectChannel(channel: DesktopUpdateChannel): Promise<void> {
  const bridge = desktopBridge()
  if (!bridge?.setUpdateChannel || channelBusy.value || status.value?.channel === channel) return
  switching.value = true
  localError.value = ''
  try {
    status.value = await bridge.setUpdateChannel(channel)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    switching.value = false
  }
}

onMounted(() => {
  const bridge = desktopBridge()
  bridgeAvailable.value = Boolean(bridge?.updateStatus && bridge?.setUpdateChannel)
  if (!bridgeAvailable.value || !bridge?.updateStatus) return
  removeListener = bridge.onUpdateStatus?.((nextStatus) => {
    status.value = nextStatus
  }) ?? null
  void bridge.updateStatus()
    .then((nextStatus) => {
      status.value = nextStatus
    })
    .catch((error) => {
      localError.value = error instanceof Error ? error.message : String(error)
    })
})

onBeforeUnmount(() => {
  removeListener?.()
  removeListener = null
})
</script>

<template>
  <div
    v-if="bridgeAvailable"
    class="border-b border-[var(--hr-border)] pb-6"
    data-testid="desktop-update-settings"
  >
    <div class="flex items-start gap-3">
      <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--hr-border)] bg-[var(--hr-surface-1)] text-[var(--hr-text-2)]">
        <Loader2 v-if="switching" class="h-4 w-4 animate-spin" />
        <FlaskConical v-else class="h-4 w-4" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-[var(--hr-text-1)]">{{ t('settings.general.updates.title') }}</div>
        <div class="mt-1 text-sm text-[var(--hr-text-3)]">{{ t('settings.general.updates.description') }}</div>

        <div
          class="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2"
          role="radiogroup"
          :aria-label="t('settings.general.updates.title')"
        >
          <button
            v-for="channel in (['stable', 'early-access'] as DesktopUpdateChannel[])"
            :key="channel"
            class="flex min-h-24 items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            :class="status?.channel === channel
              ? 'border-[var(--hr-settings-active-border)] bg-[var(--hr-settings-active)] text-[var(--hr-text-1)]'
              : 'border-[var(--hr-settings-divider)] bg-[var(--hr-settings-card)] text-[var(--hr-text-2)] hover:border-[var(--hr-border-strong)] hover:bg-[var(--hr-settings-card-hover)]'"
            :data-testid="`desktop-update-channel-${channel}`"
            type="button"
            role="radio"
            :aria-checked="status?.channel === channel"
            :disabled="channelBusy"
            @click="selectChannel(channel)"
          >
            <ShieldCheck v-if="channel === 'stable'" class="mt-0.5 h-4 w-4 flex-shrink-0" />
            <FlaskConical v-else class="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold">{{ t(`settings.general.updates.channels.${channel}.label`) }}</span>
              <span class="mt-1 block text-xs leading-5 text-[var(--hr-text-3)]">
                {{ t(`settings.general.updates.channels.${channel}.description`) }}
              </span>
            </span>
            <Check v-if="status?.channel === channel" class="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--hr-accent)]" />
          </button>
        </div>

        <p v-if="status" class="mt-3 text-xs text-[var(--hr-text-3)]" data-testid="desktop-update-state">
          {{ t('settings.general.updates.currentVersion', { version: status.currentVersion }) }}
          · {{ statusText }}
        </p>
        <p
          v-if="status?.channelNotice === 'waiting-for-newer-stable'"
          class="mt-2 text-xs leading-5 text-[var(--hr-warning)]"
          data-testid="desktop-update-channel-notice"
        >
          {{ t('settings.general.updates.waitingForStable') }}
        </p>
        <p
          v-if="localError || status?.error"
          class="mt-2 break-words text-xs leading-5 text-[var(--hr-danger)]"
          data-testid="desktop-update-error"
        >
          {{ t('settings.general.updates.error', { message: localError || status?.error }) }}
        </p>
      </div>
    </div>
  </div>
</template>

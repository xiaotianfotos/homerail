<!-- src/App.vue -->
<template>
  <NConfigProvider
    :theme="uiStore.isDarkMode ? darkTheme : null"
    :locale="uiStore.naiveLocale"
    :date-locale="uiStore.naiveDateLocale"
  >
    <div
      id="app"
      class="h-screen w-full font-sans overflow-hidden"
      :style="{ background: 'var(--hr-bg)', color: 'var(--hr-text-1)' }"
    >
      <router-view />
      <Toast />
    </div>
  </NConfigProvider>
</template>

<script lang="ts" setup>
import { watch, onMounted, onUnmounted } from 'vue'
import { NConfigProvider, darkTheme } from 'naive-ui'
import { useUiStore } from '@/stores/ui-store'
import { useI18n } from 'vue-i18n'
import Toast from '@/components/controls/Toast.vue'
import { provideToast } from '@/components/controls/useToast'

// ============================================================================
// GLOBAL TOAST NOTIFICATION
// ============================================================================
const toast = provideToast()
const uiStore = useUiStore()
const { locale: i18nLocale, t } = useI18n()

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return String(err || t('common.messages.unknownError'))
}

function notifyGlobalError(message: string): void {
  toast.showToast(message, 'error', 7000)
}

function handleUnhandledRejection(event: PromiseRejectionEvent): void {
  notifyGlobalError(messageOf(event.reason))
}

function handleWindowError(event: ErrorEvent): void {
  notifyGlobalError(messageOf(event.error || event.message))
}

// ============================================================================
// UI STORE & i18n (needed by all routes)
// ============================================================================
onMounted(async () => {
  uiStore.initialize()

  window.addEventListener('unhandledrejection', handleUnhandledRejection)
  window.addEventListener('error', handleWindowError)
})

onUnmounted(() => {
  window.removeEventListener('unhandledrejection', handleUnhandledRejection)
  window.removeEventListener('error', handleWindowError)
})

// 同步 ui-store locale 变化到 i18n
watch(
  () => uiStore.locale,
  (newLocale) => {
    i18nLocale.value = newLocale
  },
  { immediate: true },
)
</script>

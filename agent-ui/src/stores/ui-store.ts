/**
 * ============================================================================
 * UI Store - UI状态管理
 * ============================================================================
 *
 * 管理全局UI状态，包括：
 * - 主题设置
 * - 侧边栏展开/收起
 * - 加载状态
 * - 通知消息
 * - 模态框状态
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useStorage } from '@vueuse/core'
import {
  zhCN as naiveZhHans,
  zhTW as naiveZhHant,
  enUS as naiveEnUS,
  dateZhCN as naiveDateZhHans,
  dateZhTW as naiveDateZhHant,
  dateEnUS as naiveDateEnUS,
} from 'naive-ui'
import type { NLocale, NDateLocale } from 'naive-ui'
import {
  applyLocaleToDocument,
  LOCALE_STORAGE_KEY,
  normalizeAppLocale,
  resolveInitialLocale,
  type AppLocale,
} from '@/i18n/locales'
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  getAppearancePlugin,
  normalizeAppearanceId,
  resolveStoredAppearance,
} from '@/appearance/appearance-registry'

export type NotificationType = 'success' | 'error' | 'warning' | 'info'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  message?: string
  duration?: number
  timestamp: number
}

// ============================================================================
// Main Store
// ============================================================================

export const useUiStore = defineStore('ui', () => {
  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  const appearanceId = useStorage<string>(
    APPEARANCE_STORAGE_KEY,
    resolveStoredAppearance(
      typeof window !== 'undefined' ? window.localStorage : undefined,
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia.bind(window)
        : undefined,
    ),
  )
  const sidebarCollapsed = ref(false)
  const isLoading = ref(false)
  const loadingMessage = ref<string>('')
  const notifications = ref<Notification[]>([])

  const locale = useStorage<AppLocale>(LOCALE_STORAGE_KEY, resolveInitialLocale())

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  const appearance = computed(() => getAppearancePlugin(appearanceId.value))
  const isDarkMode = computed(() => appearance.value.colorScheme === 'dark')

  const unreadNotificationsCount = computed(() => {
    return notifications.value.length
  })

  const latestNotifications = computed(() => {
    return notifications.value.slice(0, 5)
  })

  // Naive UI 的语言环境
  const naiveLocale = computed<NLocale>(() => {
    if (locale.value === 'zh-Hans') return naiveZhHans
    if (locale.value === 'zh-Hant') return naiveZhHant
    return naiveEnUS
  })

  const naiveDateLocale = computed<NDateLocale>(() => {
    if (locale.value === 'zh-Hans') return naiveDateZhHans
    if (locale.value === 'zh-Hant') return naiveDateZhHant
    return naiveDateEnUS
  })

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  function setAppearance(newAppearanceId: string) {
    appearanceId.value = normalizeAppearanceId(newAppearanceId)
    if (typeof document !== 'undefined') {
      applyAppearanceToDocument(appearanceId.value)
    }
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
    if (typeof window !== 'undefined') {
      localStorage.setItem('omni_sidebar_collapsed', String(sidebarCollapsed.value))
    }
  }

  function setSidebarCollapsed(collapsed: boolean) {
    sidebarCollapsed.value = collapsed
    if (typeof window !== 'undefined') {
      localStorage.setItem('omni_sidebar_collapsed', String(collapsed))
    }
  }

  function setLoading(loading: boolean, message = '') {
    isLoading.value = loading
    loadingMessage.value = message
  }

  function addNotification(notification: Omit<Notification, 'id' | 'timestamp'>) {
    const id = `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const newNotification: Notification = {
      ...notification,
      id,
      timestamp: Date.now(),
      duration: notification.duration ?? 5000
    }

    notifications.value.unshift(newNotification)

    // Auto remove notification after duration
    if (newNotification.duration && newNotification.duration > 0) {
      setTimeout(() => {
        removeNotification(id)
      }, newNotification.duration)
    }

    return id
  }

  function removeNotification(id: string) {
    const index = notifications.value.findIndex(n => n.id === id)
    if (index !== -1) {
      notifications.value.splice(index, 1)
    }
  }

  function clearAllNotifications() {
    notifications.value = []
  }

  function showSuccess(title: string, message?: string, duration?: number) {
    return addNotification({ type: 'success', title, message, duration })
  }

  function showError(title: string, message?: string, duration?: number) {
    return addNotification({ type: 'error', title, message, duration })
  }

  function showWarning(title: string, message?: string, duration?: number) {
    return addNotification({ type: 'warning', title, message, duration })
  }

  function showInfo(title: string, message?: string, duration?: number) {
    return addNotification({ type: 'info', title, message, duration })
  }

  function setLocale(newLocale: AppLocale | string) {
    const normalized = normalizeAppLocale(newLocale)
    if (!normalized) return
    locale.value = normalized
    applyLocaleToDocument(normalized)
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  function initialize() {
    if (typeof window !== 'undefined') {
      // Load sidebar state from localStorage
      const savedSidebarState = localStorage.getItem('omni_sidebar_collapsed')
      if (savedSidebarState !== null) {
        sidebarCollapsed.value = savedSidebarState === 'true'
      }

      // One appearance controls CSS tokens, native controls, Tailwind dark
      // variants, and Naive UI through isDarkMode.
      setAppearance(appearanceId.value)

      const normalizedLocale = normalizeAppLocale(locale.value) ?? resolveInitialLocale()
      locale.value = normalizedLocale
      applyLocaleToDocument(normalizedLocale)
    }
  }

  return {
    // State
    appearanceId,
    appearance,
    sidebarCollapsed,
    isLoading,
    loadingMessage,
    notifications,
    locale,

    // Getters
    isDarkMode,
    unreadNotificationsCount,
    latestNotifications,
    naiveLocale,
    naiveDateLocale,

    // Actions
    setAppearance,
    toggleSidebar,
    setSidebarCollapsed,
    setLoading,
    addNotification,
    removeNotification,
    clearAllNotifications,
    showSuccess,
    showError,
    showWarning,
    showInfo,
    setLocale,
    initialize
  }
})

export default useUiStore

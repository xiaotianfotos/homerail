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

export type Theme = 'light' | 'dark' | 'system'
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

  const theme = ref<Theme>('system')
  const sidebarCollapsed = ref(false)
  const isLoading = ref(false)
  const loadingMessage = ref<string>('')
  const notifications = ref<Notification[]>([])

  const locale = useStorage<AppLocale>(LOCALE_STORAGE_KEY, resolveInitialLocale())

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  const isDarkMode = computed(() => {
    if (theme.value === 'dark') return true
    if (theme.value === 'light') return false
    // System theme
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

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

  function setTheme(newTheme: Theme) {
    theme.value = newTheme
    if (typeof window !== 'undefined') {
      localStorage.setItem('omni_theme', newTheme)
      updateHtmlClass()
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
      // Load theme from localStorage
      const savedTheme = localStorage.getItem('omni_theme') as Theme | null
      if (savedTheme && ['light', 'dark', 'system'].includes(savedTheme)) {
        theme.value = savedTheme
      }

      // Load sidebar state from localStorage
      const savedSidebarState = localStorage.getItem('omni_sidebar_collapsed')
      if (savedSidebarState !== null) {
        sidebarCollapsed.value = savedSidebarState === 'true'
      }

      // Apply theme to HTML
      updateHtmlClass()

      const normalizedLocale = normalizeAppLocale(locale.value) ?? resolveInitialLocale()
      locale.value = normalizedLocale
      applyLocaleToDocument(normalizedLocale)

      // Listen for system theme changes
      if (theme.value === 'system') {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        mediaQuery.addEventListener('change', updateHtmlClass)
      }
    }
  }

  function updateHtmlClass() {
    if (typeof document !== 'undefined') {
      const html = document.documentElement
      if (isDarkMode.value) {
        html.classList.add('dark')
      } else {
        html.classList.remove('dark')
      }
    }
  }

  return {
    // State
    theme,
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
    setTheme,
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

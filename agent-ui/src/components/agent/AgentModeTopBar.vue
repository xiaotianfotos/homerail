<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, Loader2, Network, RotateCcw, Settings } from 'lucide-vue-next'
import { http } from '@/api/clients/http-client'

const props = defineProps<{
  activeMode: 'text' | 'voice'
  showSettings?: boolean
  showDetails?: boolean
  detailsOpen?: boolean
  voiceOnly?: boolean
  showRuntime?: boolean
}>()

const emit = defineEmits<{
  selectText: []
  selectVoice: []
  openSettings: []
  toggleDetails: []
  openRuntime: []
}>()

function modeClass(mode: 'text' | 'voice'): string {
  return props.activeMode === mode
    ? 'bg-cyan-300 text-black shadow-[0_0_20px_rgba(103,232,249,0.18)]'
    : 'text-white/58 hover:bg-white/10 hover:text-white'
}

interface ActiveRunsResponse {
  runs?: Array<{ runId: string; status: string }>
  total?: number
}

const activeRunCount = ref(0)
let activeRunTimer: ReturnType<typeof setInterval> | null = null

const hasActiveRuns = computed(() => activeRunCount.value > 0)
const desktopUpdateStatus = ref<DesktopUpdateStatus | null>(null)
const updateInstalling = ref(false)
let removeUpdateListener: (() => void) | null = null

const runtimeTitle = computed(() =>
  hasActiveRuns.value
    ? `DAG dashboard: ${activeRunCount.value} run${activeRunCount.value === 1 ? '' : 's'} running`
    : 'DAG dashboard',
)
const downloadedUpdate = computed(() =>
  Boolean(desktopUpdateStatus.value?.supported && desktopUpdateStatus.value.state === 'downloaded'),
)
const updateButtonTitle = computed(() => {
  const version = desktopUpdateStatus.value?.update?.version
  return version ? `HomeRail ${version} 已下载，重启后安装` : '新版本已下载，重启后安装'
})

async function refreshActiveRuns(): Promise<void> {
  if (!props.showRuntime) {
    activeRunCount.value = 0
    return
  }
  try {
    const res = await http.get<ActiveRunsResponse>('/api/runs/active/list')
    const data = (res.data ?? res) as ActiveRunsResponse
    activeRunCount.value = Number(data.total ?? data.runs?.length ?? 0)
  } catch {
    activeRunCount.value = 0
  }
}

function startActiveRunPolling(): void {
  if (activeRunTimer) return
  void refreshActiveRuns()
  activeRunTimer = setInterval(() => {
    void refreshActiveRuns()
  }, 5000)
}

function stopActiveRunPolling(): void {
  if (!activeRunTimer) return
  clearInterval(activeRunTimer)
  activeRunTimer = null
}

function desktopBridge(): HomeRailDesktopBridge | null {
  return typeof window === 'undefined' ? null : window.homerailDesktop ?? null
}

function startDesktopUpdateWatcher(): void {
  const bridge = desktopBridge()
  if (!bridge?.updateStatus) return

  void bridge.updateStatus()
    .then((status) => {
      desktopUpdateStatus.value = status
    })
    .catch(() => {
      desktopUpdateStatus.value = null
    })

  removeUpdateListener = bridge.onUpdateStatus?.((status) => {
    desktopUpdateStatus.value = status
  }) ?? null

  void bridge.checkForUpdates?.().catch(() => undefined)
}

function stopDesktopUpdateWatcher(): void {
  removeUpdateListener?.()
  removeUpdateListener = null
}

async function installDesktopUpdate(): Promise<void> {
  const bridge = desktopBridge()
  if (!bridge?.installUpdate || updateInstalling.value) return
  updateInstalling.value = true
  try {
    const status = await bridge.installUpdate()
    if (status.state !== 'downloaded') {
      updateInstalling.value = false
    }
  } catch {
    updateInstalling.value = false
  }
}

onMounted(() => {
  if (props.showRuntime) startActiveRunPolling()
  startDesktopUpdateWatcher()
})

watch(() => props.showRuntime, (showRuntime) => {
  if (showRuntime) {
    startActiveRunPolling()
  } else {
    stopActiveRunPolling()
    activeRunCount.value = 0
  }
})

onBeforeUnmount(() => {
  stopActiveRunPolling()
  stopDesktopUpdateWatcher()
})
</script>

<template>
  <header class="agent-mode-topbar flex h-14 flex-shrink-0 items-center justify-between rounded-full border border-cyan-200/14 bg-black/30 px-3 shadow-2xl backdrop-blur-xl">
    <div class="agent-mode-topbar__left flex min-w-0 items-center gap-3 overflow-x-auto">
      <div class="agent-mode-topbar__brand hidden px-2 text-[11px] font-medium tracking-[0.22em] text-cyan-200/48 sm:block">
        HomeRail
      </div>
      <div v-if="!voiceOnly" class="agent-mode-topbar__mode flex h-10 items-center rounded-full border border-cyan-200/14 bg-white/[0.035] p-1">
        <button
          class="h-8 rounded-full px-3 text-xs font-medium transition-colors"
          :class="modeClass('text')"
          type="button"
          @click="emit('selectText')"
        >
          文字模式
        </button>
        <button
          class="h-8 rounded-full px-3 text-xs font-medium transition-colors"
          :class="modeClass('voice')"
          type="button"
          @click="emit('selectVoice')"
        >
          语音模式
        </button>
      </div>
      <slot />
    </div>

    <div class="agent-mode-topbar__right flex flex-shrink-0 items-center gap-2">
      <slot name="right" />
      <button
        v-if="downloadedUpdate"
        class="flex h-9 items-center gap-2 rounded-full border border-cyan-200/35 bg-cyan-300/14 px-3 text-sm font-medium text-cyan-50 shadow-[0_0_18px_rgba(103,232,249,0.18)] transition-colors hover:bg-cyan-300/20"
        :title="updateButtonTitle"
        type="button"
        @click="installDesktopUpdate"
      >
        <RotateCcw class="h-4 w-4" :class="updateInstalling ? 'animate-spin' : ''" />
        重启更新
      </button>
      <button
        v-if="showRuntime"
        class="flex h-9 items-center gap-2 rounded-full border px-3 text-sm transition-colors hover:bg-cyan-200/10 hover:text-white"
        :class="hasActiveRuns ? 'border-emerald-300/45 bg-emerald-300/10 text-emerald-100 shadow-[0_0_18px_rgba(52,211,153,0.16)]' : 'border-cyan-200/14 text-white/60'"
        :title="runtimeTitle"
        type="button"
        @click="emit('openRuntime')"
      >
        <Loader2 v-if="hasActiveRuns" class="h-4 w-4 animate-spin" />
        <Network v-else class="h-4 w-4" />
        仪表盘
        <span
          v-if="hasActiveRuns"
          class="min-w-5 rounded-full border border-emerald-200/35 bg-emerald-300/15 px-1.5 text-center text-[11px] font-semibold leading-5 text-emerald-50"
        >
          {{ activeRunCount }}
        </span>
      </button>
      <button
        v-if="showDetails"
        class="flex h-9 items-center gap-2 rounded-full border border-cyan-200/14 px-3 text-sm text-white/60 transition-colors hover:bg-cyan-200/10 hover:text-white"
        :title="detailsOpen ? '隐藏详情' : '显示详情'"
        type="button"
        @click="emit('toggleDetails')"
      >
        <EyeOff v-if="detailsOpen" class="h-4 w-4" />
        <Eye v-else class="h-4 w-4" />
        详情
      </button>
      <button
        v-if="showSettings"
        class="flex h-9 items-center gap-2 rounded-full border border-cyan-200/14 px-3 text-sm text-white/60 transition-colors hover:bg-cyan-200/10 hover:text-white"
        data-testid="agent-mode-settings-button"
        type="button"
        @click="emit('openSettings')"
      >
        <Settings class="h-4 w-4" />
        设置
      </button>
    </div>
  </header>
</template>

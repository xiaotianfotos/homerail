<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAgentStore } from '@/stores/agent-store'
import AgentChatPanel from '@/components/agent/AgentChatPanel.vue'
import AgentWorkspace from '@/components/agent/AgentWorkspace.vue'
import AgentSessionSidebar from '@/components/agent/AgentSessionSidebar.vue'
import AgentSettingsPage from '@/components/agent/AgentSettingsPage.vue'
import AgentVoiceCockpit from '@/components/agent/AgentVoiceCockpit.vue'
import AgentModeTopBar from '@/components/agent/AgentModeTopBar.vue'
import DagResourceStatusPill from '@/components/agent/DagResourceStatusPill.vue'
import DagRuntimeOverlay from '@/components/agent/dag-runtime/DagRuntimeOverlay.vue'
import OnboardingWizard from '@/components/agent/onboarding/OnboardingWizard.vue'
import { useOnboardingStatus } from '@/composables/useOnboardingStatus'
import { PanelRightClose, PanelRightOpen } from 'lucide-vue-next'

const store = useAgentStore()
const route = useRoute()
const textModeEnabled = flagEnabled(import.meta.env.VITE_HOMERAIL_ENABLE_TEXT_MODE)
const voiceOnlyMode = !textModeEnabled
const { status: onboardingStatus, refresh: refreshOnboarding } = useOnboardingStatus()

const captureRunId = computed(() => {
  const raw = route.query.captureRun
  if (typeof raw !== 'string') return null
  const runId = raw.trim()
  return /^[A-Za-z0-9._-]{1,128}$/.test(runId) ? runId : null
})
const captureMode = computed(() => route.query.capture === '1' || Boolean(captureRunId.value))

store.initialize()

function flagEnabled(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function isMobileVoiceEntry(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const uaLooksMobile = /Android|iPhone|iPad|iPod|Mobile|MiuiBrowser|XiaoMi|HarmonyOS/i.test(navigator.userAgent)
  const touchLooksPhone = navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) <= 620
  return uaLooksMobile || touchLooksPhone
}

onMounted(async () => {
  if (voiceOnlyMode || isMobileVoiceEntry()) store.voiceCockpitOpen = true
  // 检测配置状态，缺配则弹出新手引导
  await refreshOnboarding()
  if (!captureMode.value && onboardingStatus.value.needsOnboarding && !store.onboardingDismissed) {
    store.openOnboarding()
  }
})

async function closeOnboarding(): Promise<void> {
  store.closeOnboarding()
  await refreshOnboarding()
}

watch(
  () => route.query.runId,
  (runId) => {
    if (typeof runId !== 'string' || !runId) return
    store.hasStarted = true
    const tab = route.query.tab
    if (tab === 'topology' || tab === 'artifacts' || tab === 'evidence' || tab === 'logs') {
      store.inspectorTab = tab
    }
    void store.switchToRun(runId)
  },
  { immediate: true },
)

watch(
  captureRunId,
  (runId) => {
    if (!runId) return
    store.closeOnboarding()
    store.runtimeOverlayOpen = true
  },
  { immediate: true },
)
</script>

<template>
  <AgentSettingsPage v-if="store.settingsPageOpen" />

  <DagRuntimeOverlay
    v-else-if="store.runtimeOverlayOpen"
    :initial-run-id="captureRunId ?? undefined"
    :capture-mode="captureMode"
    @close="store.runtimeOverlayOpen = false"
  />

  <div v-else-if="textModeEnabled" class="agent-shell relative flex h-screen overflow-hidden bg-[var(--hr-bg)] p-4 text-[var(--hr-text-1)]">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_12%,color-mix(in_srgb,var(--hr-accent)_14%,transparent),transparent_34%),radial-gradient(circle_at_78%_20%,color-mix(in_srgb,var(--hr-accent)_10%,transparent),transparent_31%),linear-gradient(180deg,var(--hr-surface-1),transparent_24%)]" />
    <div class="relative z-10 flex min-h-0 flex-1 flex-col gap-3">
      <AgentModeTopBar
        active-mode="text"
        show-settings
        show-runtime
        @select-voice="store.voiceCockpitOpen = true"
        @open-settings="store.settingsPageOpen = true"
        @open-runtime="store.runtimeOverlayOpen = true"
      >
        <template #right>
          <DagResourceStatusPill />
        </template>
      </AgentModeTopBar>
      <div class="relative flex min-h-0 flex-1 overflow-hidden rounded-[30px] border border-[var(--hr-border)] bg-[var(--hr-panel)] shadow-[var(--hr-shadow-floating)] backdrop-blur-xl">
      <!-- Left: session sidebar (collapsible w-56/w-10) -->
      <AgentSessionSidebar />

      <!-- Center: compact manager runtime conversation -->
      <div class="min-w-0 flex-1 flex flex-col border-r border-[var(--hr-border)] bg-[var(--hr-bg)]">
        <AgentChatPanel />
      </div>

      <!-- Right: DAG/workspace inspector, kept as a real split pane -->
      <div
        class="min-w-0 flex flex-col transition-all duration-200"
        :class="store.rightPanelCollapsed ? 'w-10 flex-shrink-0' : 'w-[min(34vw,620px)] min-w-[460px] flex-shrink-0'"
      >
        <!-- Collapse toggle -->
        <div class="flex h-14 items-center justify-start px-3 flex-shrink-0 border-b border-[var(--hr-border)] bg-[var(--hr-surface-1)]">
          <button
            class="rounded-full border border-[var(--hr-border)] p-2 text-[var(--hr-text-3)] transition-colors hover:bg-[var(--hr-surface-2)] hover:text-[var(--hr-text-1)]"
            @click="store.rightPanelCollapsed = !store.rightPanelCollapsed"
          >
            <PanelRightClose v-if="!store.rightPanelCollapsed" class="h-3.5 w-3.5" />
            <PanelRightOpen v-else class="h-3.5 w-3.5" />
          </button>
        </div>

        <!-- Inspector content (hidden when collapsed) -->
        <div v-if="!store.rightPanelCollapsed" class="flex-1 min-h-0 overflow-hidden">
          <AgentWorkspace />
        </div>
      </div>
      </div>
    </div>
  </div>

  <AgentVoiceCockpit
    v-if="!store.settingsPageOpen && !store.runtimeOverlayOpen && (voiceOnlyMode || store.voiceCockpitOpen)"
    :voice-only="voiceOnlyMode"
  />

  <!-- 新手引导横版小窗（悬浮 overlay，不替换 voice cockpit） -->
  <OnboardingWizard
    v-if="store.onboardingOpen"
    :manual-debug="store.onboardingManualDebug"
    @close="closeOnboarding"
  />
</template>

<script setup lang="ts">
/**
 * OnboardingWizard — 新手引导横版小窗（悬浮在 voice agent 之上）。
 *
 * 与旧 OnboardingGuide 的区别：
 *   - 不再全屏替换 voice cockpit，而是 z-[200] overlay 叠在 cockpit 上层；
 *   - 不再"显示状态 + 跳设置页"，而是在小窗内内联完成最小配置；
 *   - 三阶段：主 Agent / Codex → ASR → TTS（可跳过），完成一阶段进下一阶段。
 *
 * 完成前 cockpit 麦克风由 AgentVoiceCockpit 的 voiceInputLocked 锁定
 * （其判断已并入 needsOnboarding），所以这里不需要直接操作麦克风。
 */

import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Sparkles, ArrowRight, Terminal, Mic, Volume2, X, FolderCheck, RefreshCw } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent-store'
import { useOnboardingStatus } from '@/composables/useOnboardingStatus'
import { listProviders, agentSettingsApi } from '@/api/agent'
import { probeDockerWorkspaceMount, type DockerWorkspaceProbeResult } from '@/api/services/voice-agent-api'
import { cn } from '@/lib/utils'
import { isKimiProviderId } from '@/lib/model-runtime'
import type { Provider } from '@/api/types/orchestration-v2.types'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import OnboardingStepForm from './OnboardingStepForm.vue'

const props = withDefaults(defineProps<{
  manualDebug?: boolean
}>(), {
  manualDebug: false,
})

const emit = defineEmits<{
  close: []
}>()

const store = useAgentStore()
const { t } = useI18n()
const { status, refresh } = useOnboardingStatus()

const providers = ref<Provider[]>([])
const existingSettings = ref<LLMSetting[]>([])
const providersLoading = ref(true)
const dockerProbeRunning = ref(false)
const dockerProbeResult = ref<DockerWorkspaceProbeResult | null>(null)
const applyingExistingAgentId = ref<string | null>(null)

onMounted(async () => {
  await Promise.all([
    refresh(),
    loadProviders(),
    loadExistingSettings(),
  ])
  // 初始推进到第一个未完成阶段（例如 Codex 已可用时直接跳到 ASR）
  if (!props.manualDebug) advanceIfDone()
})

async function loadProviders(): Promise<void> {
  providersLoading.value = true
  try {
    const res = await listProviders()
    providers.value = res.data?.providers ?? []
  } catch {
    providers.value = []
  } finally {
    providersLoading.value = false
  }
}

async function loadExistingSettings(): Promise<void> {
  try {
    const res = await agentSettingsApi.listLLMSettings()
    existingSettings.value = res.data?.settings ?? []
  } catch {
    existingSettings.value = []
  }
}

// ── 阶段定义 ──────────────────────────────────────────────────
type StepId = 'agent' | 'asr' | 'tts'
type OnboardingPane = 'models' | 'environment'

interface StepDef {
  id: StepId
  title: string
  subtitle: string
  icon: typeof Terminal
  capability: 'supports_llm' | 'supports_asr' | 'supports_tts'
  optional: boolean
}

const steps = computed<StepDef[]>(() => [
  { id: 'agent', title: t('onboarding.steps.agent'), subtitle: t('onboarding.steps.agentSubtitle'), icon: Terminal, capability: 'supports_llm', optional: false },
  { id: 'asr', title: t('onboarding.steps.asr'), subtitle: t('onboarding.steps.asrSubtitle'), icon: Mic, capability: 'supports_asr', optional: false },
  { id: 'tts', title: t('onboarding.steps.tts'), subtitle: t('onboarding.steps.ttsSubtitle'), icon: Volume2, capability: 'supports_tts', optional: true },
])

const currentIdx = ref(0)
const activePane = ref<OnboardingPane>('models')
const currentStep = computed<StepDef>(() => steps.value[currentIdx.value])

// ── 每阶段状态 ────────────────────────────────────────────────
// agent 阶段：后端 Manager Agent runtime readiness 为准
// asr 阶段：hasAsr 即 done
// tts 阶段：hasTts 或用户主动跳过即 done
const ttsSkipped = ref(false)

function stepStatus(id: StepId): 'done' | 'pending' | 'loading' {
  if (status.value.loading) return 'loading'
  if (id === 'agent') {
    if (status.value.managerAgentReady) return 'done'
    return 'pending'
  }
  if (id === 'asr') return status.value.hasAsr ? 'done' : 'pending'
  // tts
  if (status.value.hasTts || ttsSkipped.value) return 'done'
  return 'pending'
}

// 自动跟随真实状态推进当前阶段：若当前阶段已是 done，跳到下一个 pending
// （仅在初次加载或刚完成保存后触发，避免和用户手动点击冲突）
function advanceIfDone(): void {
  if (props.manualDebug) return
  for (let i = currentIdx.value; i < steps.value.length; i++) {
    if (stepStatus(steps.value[i].id) !== 'done') {
      currentIdx.value = i
      return
    }
  }
  // 全部 done
  currentIdx.value = steps.value.length - 1
  maybeFinish()
}

// ── 完成 ──────────────────────────────────────────────────────
function maybeFinish(): void {
  if (props.manualDebug) return
  const allDone = steps.value.every(s => stepStatus(s.id) === 'done')
  if (allDone && !status.value.loading) {
    store.completeOnboarding()
    emit('close')
  }
}

// ── 交互 ──────────────────────────────────────────────────────
async function onCreated(setting?: LLMSetting): Promise<void> {
  await applyCreatedManagerAgentSetting(setting)
  await Promise.all([
    refresh(),
    loadExistingSettings(),
  ])
  await store.loadManagerRuntimeOptions()
  advanceIfDone()
}

function next(): void {
  if (currentIdx.value < steps.value.length - 1) {
    currentIdx.value += 1
  } else {
    maybeFinish()
  }
}

function skipTts(): void {
  ttsSkipped.value = true
  void next()
}

function gotoStep(idx: number): void {
  if (idx < 0 || idx >= steps.value.length) return
  // 允许跳到任意已完成或当前未完成阶段
  currentIdx.value = idx
}

function dismiss(): void {
  store.dismissOnboarding()
  emit('close')
}

// 是否显示主 Agent runtime 就绪提示
const agentRuntimeReady = computed(() => status.value.managerAgentReady)
const hostShellRequired = computed(() => status.value.hostShell?.required === true || status.value.managerAgentRuntimePlacement === 'host_shell')
const hostShellReady = computed(() => !hostShellRequired.value || status.value.hostShell?.available === true)
const hostShellMessage = computed(() => {
  if (!hostShellRequired.value) return t('onboarding.environmentCheck.hostNotRequired')
  if (status.value.hostShell?.available) {
    return status.value.hostShell.shellPath
      ? t('onboarding.environmentCheck.gitBashReadyPath', { path: status.value.hostShell.shellPath })
      : t('onboarding.environmentCheck.gitBashReady')
  }
  if (status.value.hostShell?.error) return status.value.hostShell.error
  return t('onboarding.environmentCheck.gitBashRequired')
})
const dockerWorkspaceHostPath = computed(() => status.value.dockerWorkspace?.hostPath || '')
const dockerWorkspaceReady = computed(() => dockerProbeResult.value?.available === true)
const dockerWorkspaceRequired = computed(() => status.value.dockerWorkspace?.required === true)
const environmentNeedsAttention = computed(() => !hostShellReady.value || (dockerWorkspaceRequired.value && !dockerWorkspaceReady.value))
const dockerWorkspaceMessage = computed(() => {
  if (dockerProbeRunning.value) return t('onboarding.environmentCheck.checkingDocker')
  if (dockerProbeResult.value?.available) return t('onboarding.environmentCheck.dockerReady')
  if (dockerProbeResult.value?.error) return dockerProbeResult.value.error
  return dockerWorkspaceHostPath.value
    ? t('onboarding.environmentCheck.dockerSharePath', { path: dockerWorkspaceHostPath.value })
    : t('onboarding.environmentCheck.dockerShareHomeRail')
})

function isDedicatedManagerAgentSetting(setting: LLMSetting | undefined): setting is LLMSetting {
  return Boolean(setting?.id && setting.supports_llm && !setting.supports_asr && !setting.supports_tts)
}

const existingManagerAgentSettings = computed(() => existingSettings.value.filter(isDedicatedManagerAgentSetting))

function harnessForManagerAgentSetting(setting: LLMSetting): 'kimi_code' | 'claude_agent_sdk' {
  return isKimiProviderId(setting.provider_id) ? 'kimi_code' : 'claude_agent_sdk'
}

async function applyCreatedManagerAgentSetting(setting: LLMSetting | undefined): Promise<void> {
  if (currentStep.value.id !== 'agent' || !isDedicatedManagerAgentSetting(setting)) return
  await applyExistingManagerAgentSetting(setting)
}

async function applyExistingManagerAgentSetting(setting: LLMSetting): Promise<void> {
  applyingExistingAgentId.value = setting.id
  try {
    const harness = harnessForManagerAgentSetting(setting)
    await agentSettingsApi.updateVoiceAgentConfig({
      harness,
      llm_setting_id: setting.id,
      provider_name: setting.provider_id,
      model_name: setting.model_name,
    })
    await Promise.all([
      refresh(),
      loadExistingSettings(),
    ])
    await store.loadManagerRuntimeOptions()
    advanceIfDone()
  } finally {
    applyingExistingAgentId.value = null
  }
}

async function checkDockerWorkspace(): Promise<void> {
  if (dockerProbeRunning.value) return
  dockerProbeRunning.value = true
  try {
    dockerProbeResult.value = await probeDockerWorkspaceMount()
  } catch (err) {
    dockerProbeResult.value = {
      available: false,
      host_path: dockerWorkspaceHostPath.value,
      error: err instanceof Error ? err.message : String(err),
      code: 'docker_workspace_probe_request_failed',
    }
  } finally {
    dockerProbeRunning.value = false
  }
}
</script>

<template>
  <transition name="wizard-fade">
    <div class="onboarding-wizard-overlay">
      <!-- 背景暗化（cockpit 可见但置灰） -->
      <div class="onboarding-wizard-overlay__scrim" @click="dismiss" />

      <!-- 横版小窗 -->
      <div class="onboarding-wizard" role="dialog" aria-modal="true">
        <!-- 顶部标题 + 关闭 -->
        <header class="onboarding-wizard__header">
          <div class="onboarding-wizard__title">
            <span class="onboarding-wizard__title-icon">
              <Sparkles class="h-4 w-4" />
            </span>
            <div>
              <h2>{{ t('onboarding.title') }}</h2>
              <p>{{ t('onboarding.subtitle') }}</p>
            </div>
          </div>
          <button class="onboarding-wizard__close" :title="t('onboarding.later')" @click="dismiss">
            <X class="h-4 w-4" />
          </button>
        </header>

        <nav class="onboarding-wizard__tabs" role="tablist" :aria-label="t('onboarding.categories')">
          <button
            type="button"
            role="tab"
            :aria-selected="activePane === 'models'"
            :class="cn('onboarding-wizard__tab', activePane === 'models' && 'onboarding-wizard__tab--active')"
            @click="activePane = 'models'"
          >
            {{ t('onboarding.models') }}
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activePane === 'environment'"
            :class="cn('onboarding-wizard__tab', activePane === 'environment' && 'onboarding-wizard__tab--active')"
            @click="activePane = 'environment'"
          >
            {{ t('onboarding.environment') }}
            <span v-if="environmentNeedsAttention" class="onboarding-wizard__tab-dot" />
          </button>
        </nav>

        <!-- Stepper -->
        <nav v-if="activePane === 'models'" class="onboarding-wizard__stepper">
          <button
            v-for="(step, idx) in steps"
            :key="step.id"
            type="button"
            :class="cn(
              'onboarding-wizard__step',
              idx === currentIdx && 'onboarding-wizard__step--active',
              stepStatus(step.id) === 'done' && 'onboarding-wizard__step--done'
            )"
            @click="gotoStep(idx)"
          >
            <span class="onboarding-wizard__step-index">
              <Check v-if="stepStatus(step.id) === 'done'" class="h-3.5 w-3.5" />
              <span v-else>{{ idx + 1 }}</span>
            </span>
            <span class="onboarding-wizard__step-text">
              <strong>{{ step.title }}</strong>
              <em v-if="step.optional" class="onboarding-wizard__step-optional">{{ t('onboarding.optional') }}</em>
            </span>
          </button>
        </nav>

        <!-- 当前阶段内容 -->
        <section v-if="activePane === 'models'" class="onboarding-wizard__body">
          <div class="onboarding-wizard__body-title">
            <component :is="currentStep.icon" class="h-4 w-4 text-cyan-300" />
            <span>{{ currentStep.title }}</span>
            <em>{{ currentStep.subtitle }}</em>
          </div>

          <div v-if="currentStep.id === 'agent' && agentRuntimeReady" class="onboarding-wizard__ready">
            <Check class="h-5 w-5 text-emerald-400" />
            <div>
              <div class="onboarding-wizard__ready-title">{{ t('onboarding.runtime.ready') }}</div>
              <div class="onboarding-wizard__ready-hint">{{ t('onboarding.runtime.currentHarness', { harness: status.managerAgentHarness || 'manager_agent' }) }}</div>
            </div>
          </div>

          <!-- Agent 阶段：runtime 未就绪，需要建 LLM 或修复运行环境 -->
          <template v-else-if="currentStep.id === 'agent' && !agentRuntimeReady">
            <div class="onboarding-wizard__codex-hint">
              {{ t('onboarding.runtime.notReady') }}
            </div>
            <div v-if="existingManagerAgentSettings.length" class="onboarding-wizard__existing-agents">
              <div class="onboarding-wizard__existing-title">{{ t('onboarding.runtime.existing') }}</div>
              <button
                v-for="setting in existingManagerAgentSettings"
                :key="setting.id"
                type="button"
                class="onboarding-wizard__existing-agent"
                :disabled="applyingExistingAgentId !== null"
                @click="applyExistingManagerAgentSetting(setting)"
              >
                <span>
                  <strong>{{ setting.display_name || setting.model_name }}</strong>
                  <em>{{ harnessForManagerAgentSetting(setting) === 'kimi_code' ? 'Kimi Code' : 'Claude Code' }} · {{ setting.model_name }}</em>
                </span>
                <span class="onboarding-wizard__existing-action">
                  {{ applyingExistingAgentId === setting.id ? t('onboarding.runtime.switching') : t('onboarding.runtime.use') }}
                </span>
              </button>
            </div>
            <OnboardingStepForm
              :capability="currentStep.capability"
              :providers="providers"
              :existing-settings="existingSettings"
              @created="onCreated"
            />
          </template>

          <!-- ASR / TTS 阶段：已完成 -->
          <div v-else-if="stepStatus(currentStep.id) === 'done'" class="onboarding-wizard__ready">
            <Check class="h-5 w-5 text-emerald-400" />
            <div>
              <div class="onboarding-wizard__ready-title">{{ t('onboarding.runtime.stepReady', { step: currentStep.title }) }}</div>
              <div class="onboarding-wizard__ready-hint">{{ t('onboarding.runtime.nextAvailable') }}</div>
            </div>
          </div>

          <!-- ASR / TTS 阶段：待配置 -->
          <template v-else>
            <OnboardingStepForm
              :capability="currentStep.capability"
              :providers="providers"
              :existing-settings="existingSettings"
              @created="onCreated"
            />
          </template>
        </section>

        <section v-else class="onboarding-wizard__body">
          <div class="onboarding-wizard__body-title">
            <Terminal class="h-4 w-4 text-cyan-300" />
            <span>{{ t('onboarding.environment') }}</span>
            <em>{{ t('onboarding.environmentCheck.description') }}</em>
          </div>

          <div class="onboarding-wizard__docker-check">
            <Terminal :class="cn('h-5 w-5', hostShellReady ? 'text-emerald-400' : 'text-cyan-300')" />
            <div class="onboarding-wizard__docker-check-copy">
              <div class="onboarding-wizard__docker-check-title">Git Bash / host-shell</div>
              <div class="onboarding-wizard__docker-check-hint">{{ hostShellMessage }}</div>
            </div>
            <span :class="cn('onboarding-wizard__check-pill', hostShellReady && 'onboarding-wizard__check-pill--ready')">
              {{ hostShellReady ? t('onboarding.environmentCheck.passed') : t('onboarding.environmentCheck.needsAttention') }}
            </span>
          </div>

          <div class="onboarding-wizard__docker-check">
            <FolderCheck :class="cn('h-5 w-5', dockerWorkspaceReady ? 'text-emerald-400' : 'text-cyan-300')" />
            <div class="onboarding-wizard__docker-check-copy">
              <div class="onboarding-wizard__docker-check-title">{{ t('onboarding.environmentCheck.dockerTitle') }}</div>
              <div class="onboarding-wizard__docker-check-hint">{{ dockerWorkspaceMessage }}</div>
            </div>
            <button
              type="button"
              class="onboarding-wizard__docker-check-button"
              :disabled="dockerProbeRunning"
              :title="t('onboarding.environmentCheck.checkTitle')"
              @click="checkDockerWorkspace"
            >
              <RefreshCw :class="cn('h-3.5 w-3.5', dockerProbeRunning && 'animate-spin')" />
              <span>{{ dockerProbeRunning ? t('onboarding.environmentCheck.checking') : t('onboarding.environmentCheck.check') }}</span>
            </button>
          </div>

          <div v-if="status.managerAgentBlockers.length" class="onboarding-wizard__blockers">
            <div
              v-for="blocker in status.managerAgentBlockers"
              :key="blocker.code"
              class="onboarding-wizard__blocker"
            >
              <span>{{ blocker.message }}</span>
              <code>{{ blocker.code }}</code>
            </div>
          </div>
        </section>

        <!-- 底部操作 -->
        <footer class="onboarding-wizard__footer">
          <button class="onboarding-wizard__ghost" @click="dismiss">
            {{ t('onboarding.later') }}
          </button>
          <div class="onboarding-wizard__footer-right">
            <button
              v-if="activePane === 'models' && currentStep.optional && stepStatus(currentStep.id) !== 'done'"
              class="onboarding-wizard__ghost"
              @click="skipTts"
            >
              {{ t('onboarding.actions.skipTts') }}
            </button>
            <button
              v-if="activePane === 'environment'"
              class="onboarding-wizard__primary"
              @click="activePane = 'models'"
            >
              <span>{{ t('onboarding.actions.backToModels') }}</span>
              <ArrowRight class="h-3.5 w-3.5" />
            </button>
            <button
              v-else
              :disabled="stepStatus(currentStep.id) !== 'done'"
              :class="cn(
                'onboarding-wizard__primary',
                stepStatus(currentStep.id) !== 'done' && 'onboarding-wizard__primary--disabled'
              )"
              @click="next"
            >
              <span>{{ currentIdx === steps.length - 1 ? t('onboarding.actions.finish') : t('onboarding.actions.next') }}</span>
              <ArrowRight class="h-3.5 w-3.5" />
            </button>
          </div>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.onboarding-wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.onboarding-wizard-overlay__scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.onboarding-wizard {
  position: relative;
  z-index: 1;
  width: min(720px, 92vw);
  aspect-ratio: 4 / 3;
  max-height: 84vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: 22px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(7, 13, 18, 0.94);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.03), 0 30px 90px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

/* Header */
.onboarding-wizard__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.onboarding-wizard__title {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.onboarding-wizard__title-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 2rem;
  width: 2rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(103, 232, 249, 0.25);
  background: rgba(103, 232, 249, 0.1);
  color: rgba(103, 232, 249, 0.95);
}

.onboarding-wizard__title h2 {
  font-size: 0.95rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}

.onboarding-wizard__title p {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.42);
  margin-top: 0.1rem;
}

.onboarding-wizard__close {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 2rem;
  width: 2rem;
  border-radius: 0.5rem;
  color: rgba(255, 255, 255, 0.4);
  transition: color 160ms ease, background 160ms ease;
}

.onboarding-wizard__close:hover {
  color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.06);
}

.onboarding-wizard__tabs {
  display: flex;
  gap: 0.45rem;
  padding: 0.7rem 1.25rem 0;
}

.onboarding-wizard__tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-width: 6.5rem;
  padding: 0.42rem 0.85rem;
  border-radius: 0.55rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.58);
  font-size: 0.76rem;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
}

.onboarding-wizard__tab--active {
  border-color: rgba(103, 232, 249, 0.36);
  background: rgba(103, 232, 249, 0.08);
  color: rgba(255, 255, 255, 0.9);
}

.onboarding-wizard__tab-dot {
  height: 0.42rem;
  width: 0.42rem;
  border-radius: 9999px;
  background: rgb(251, 191, 36);
  box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.14);
}

/* Stepper */
.onboarding-wizard__stepper {
  display: flex;
  align-items: stretch;
  gap: 0.4rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.onboarding-wizard__step {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.7rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.02);
  transition: border-color 160ms ease, background 160ms ease;
  text-align: left;
}

.onboarding-wizard__step--active {
  border-color: rgba(103, 232, 249, 0.45);
  background: rgba(103, 232, 249, 0.08);
}

.onboarding-wizard__step--done {
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.06);
}

.onboarding-wizard__step-index {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 1.4rem;
  width: 1.4rem;
  flex-shrink: 0;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.6);
}

.onboarding-wizard__step--active .onboarding-wizard__step-index {
  background: rgba(103, 232, 249, 0.2);
  color: rgba(207, 250, 254, 0.95);
}

.onboarding-wizard__step--done .onboarding-wizard__step-index {
  background: rgba(52, 211, 153, 0.2);
  color: rgba(167, 243, 208, 0.95);
}

.onboarding-wizard__step-text {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}

.onboarding-wizard__step-text strong {
  font-size: 0.8rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
}

.onboarding-wizard__step-optional {
  font-size: 0.62rem;
  font-style: normal;
  padding: 0.05rem 0.35rem;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.4);
}

/* Body */
.onboarding-wizard__body {
  flex: 1;
  overflow-y: auto;
  padding: 1.1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.onboarding-wizard__body-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
}

.onboarding-wizard__body-title em {
  font-size: 0.72rem;
  font-weight: 400;
  font-style: normal;
  color: rgba(255, 255, 255, 0.4);
  margin-left: 0.2rem;
}

.onboarding-wizard__codex-hint {
  padding: 0.6rem 0.75rem;
  border-radius: 0.6rem;
  background: rgba(251, 191, 36, 0.06);
  border: 1px solid rgba(251, 191, 36, 0.18);
  color: rgba(254, 243, 199, 0.8);
  font-size: 0.75rem;
  line-height: 1.5;
}

.onboarding-wizard__existing-agents {
  display: grid;
  gap: 0.55rem;
}

.onboarding-wizard__existing-title {
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.72rem;
  font-weight: 700;
}

.onboarding-wizard__existing-agent {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  width: 100%;
  padding: 0.65rem 0.72rem;
  border-radius: 0.6rem;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(34, 211, 238, 0.06);
  color: rgba(255, 255, 255, 0.9);
  text-align: left;
}

.onboarding-wizard__existing-agent:not(:disabled):hover {
  border-color: rgba(103, 232, 249, 0.36);
  background: rgba(34, 211, 238, 0.1);
}

.onboarding-wizard__existing-agent:disabled {
  cursor: progress;
  opacity: 0.72;
}

.onboarding-wizard__existing-agent span:first-child {
  display: grid;
  gap: 0.16rem;
  min-width: 0;
}

.onboarding-wizard__existing-agent strong,
.onboarding-wizard__existing-agent em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.onboarding-wizard__existing-agent strong {
  font-size: 0.82rem;
}

.onboarding-wizard__existing-agent em {
  color: rgba(255, 255, 255, 0.48);
  font-size: 0.68rem;
  font-style: normal;
}

.onboarding-wizard__existing-action {
  flex: 0 0 auto;
  color: #67e8f9;
  font-size: 0.72rem;
  font-weight: 800;
}

.onboarding-wizard__blockers {
  display: grid;
  gap: 0.45rem;
}

.onboarding-wizard__blocker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.55rem;
  align-items: center;
  padding: 0.55rem 0.65rem;
  border-radius: 0.55rem;
  border: 1px solid rgba(251, 191, 36, 0.16);
  background: rgba(251, 191, 36, 0.05);
  font-size: 0.72rem;
  color: rgba(254, 243, 199, 0.82);
}

.onboarding-wizard__blocker span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.onboarding-wizard__blocker code {
  color: rgba(255, 255, 255, 0.42);
  font-size: 0.66rem;
}

.onboarding-wizard__docker-check {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.7rem 0.8rem;
  border-radius: 0.7rem;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(34, 211, 238, 0.05);
}

.onboarding-wizard__docker-check-copy {
  min-width: 0;
}

.onboarding-wizard__docker-check-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.88);
}

.onboarding-wizard__docker-check-hint {
  margin-top: 0.15rem;
  overflow-wrap: anywhere;
  font-size: 0.7rem;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.52);
}

.onboarding-wizard__docker-check-button {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 4.8rem;
  justify-content: center;
  padding: 0.42rem 0.65rem;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.22);
  color: rgba(207, 250, 254, 0.92);
  font-size: 0.72rem;
  transition: background 160ms ease, border-color 160ms ease;
}

.onboarding-wizard__docker-check-button:not(:disabled):hover {
  border-color: rgba(103, 232, 249, 0.45);
  background: rgba(103, 232, 249, 0.1);
}

.onboarding-wizard__docker-check-button:disabled {
  cursor: default;
  opacity: 0.7;
}

.onboarding-wizard__check-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.7rem;
  padding: 0.28rem 0.55rem;
  border-radius: 9999px;
  border: 1px solid rgba(251, 191, 36, 0.25);
  color: rgba(254, 243, 199, 0.85);
  font-size: 0.7rem;
  background: rgba(251, 191, 36, 0.06);
}

.onboarding-wizard__check-pill--ready {
  border-color: rgba(52, 211, 153, 0.28);
  color: rgba(167, 243, 208, 0.92);
  background: rgba(52, 211, 153, 0.07);
}

.onboarding-wizard__ready {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.8rem 0.9rem;
  border-radius: 0.7rem;
  border: 1px solid rgba(52, 211, 153, 0.2);
  background: rgba(52, 211, 153, 0.05);
}

.onboarding-wizard__ready-title {
  font-size: 0.82rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
}

.onboarding-wizard__ready-hint {
  font-size: 0.72rem;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 0.15rem;
}

/* Footer */
.onboarding-wizard__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.onboarding-wizard__footer-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.onboarding-wizard__ghost {
  padding: 0.45rem 0.9rem;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.55);
  font-size: 0.78rem;
  transition: background 160ms ease, color 160ms ease;
}

.onboarding-wizard__ghost:hover {
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.85);
}

.onboarding-wizard__primary {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 1rem;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.4);
  background: rgba(103, 232, 249, 0.14);
  color: rgba(207, 250, 254, 0.95);
  font-size: 0.78rem;
  font-weight: 500;
  transition: background 160ms ease, transform 160ms ease;
}

.onboarding-wizard__primary:not(.onboarding-wizard__primary--disabled):hover {
  background: rgba(103, 232, 249, 0.24);
  transform: translateY(-1px);
}

.onboarding-wizard__primary--disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: rgba(255, 255, 255, 0.5);
}

/* Transition */
.wizard-fade-enter-active {
  transition: opacity 200ms ease;
}
.wizard-fade-enter-active .onboarding-wizard {
  transition: opacity 240ms ease, transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wizard-fade-leave-active {
  transition: opacity 160ms ease;
}
.wizard-fade-enter-from {
  opacity: 0;
}
.wizard-fade-enter-from .onboarding-wizard {
  transform: translateY(-12px);
}
.wizard-fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .onboarding-wizard-overlay {
    padding: 12px;
  }
  .onboarding-wizard {
    width: 100%;
    aspect-ratio: auto;
    max-height: 92vh;
  }
  .onboarding-wizard__stepper {
    overflow-x: auto;
  }
  .onboarding-wizard__step {
    flex: 0 0 auto;
    min-width: 8rem;
  }
}
</style>

/**
 * useOnboardingStatus — 检测当前配置状态，判断是否需要新手引导。
 *
 * 并行调用：
 *  - listLLMSettings（检查 ASR/TTS 模型配置）
 *  - getManagerAgentReadiness（检查真实 Manager Agent runtime readiness）
 *
 * 判断逻辑：
 *  - managerAgentReady = 后端当前 Manager Agent harness/runtime 可执行
 *  - hasAsr = 有 active 且 supports_asr 的 setting
 *  - hasTts = 有 active 且 supports_tts 的 setting
 *  - needsOnboarding = !managerAgentReady || !hasAsr
 *    （TTS 可跳过，不强制）
 */

import { ref, type Ref } from 'vue'
import { listLLMSettings } from '@/api/services/llm-settings-api'
import {
  getManagerAgentReadiness,
  type CodexLiveVoiceV3Voice,
  type ManagerAgentReadiness
} from '@/api/services/voice-agent-api'

function flagEnabled(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export interface OnboardingStatus {
  codexAvailable: boolean
  codexVersion?: string
  managerAgentReady: boolean
  managerAgentHarness?: string
  managerAgentRuntimePlacement?: 'host' | 'host_shell' | 'container' | null
  managerAgentBlockers: Array<{ code: string; message: string; detail?: string }>
  liveVoiceSupported: boolean
  liveVoiceMinimumVersion?: string
  liveVoiceVoices?: CodexLiveVoiceV3Voice[]
  liveVoiceDefaultVoice?: CodexLiveVoiceV3Voice
  liveVoiceEffective: boolean
  dockerWorkspace?: {
    required: boolean
    hostPath: string
    probeEndpoint: string
  }
  hostShell?: {
    required: boolean
    available: boolean
    shellPath?: string
    workerEntry?: string
    error?: string
  }
  hasLlm: boolean
  hasAsr: boolean
  hasTts: boolean
  needsOnboarding: boolean
  loading: boolean
}

export function useOnboardingStatus(): {
  status: Ref<OnboardingStatus>
  refresh: () => Promise<void>
} {
  const status = ref<OnboardingStatus>({
    codexAvailable: false,
    managerAgentReady: false,
    managerAgentBlockers: [],
    liveVoiceSupported: false,
    liveVoiceEffective: false,
    hasLlm: false,
    hasAsr: false,
    hasTts: false,
    needsOnboarding: true,
    loading: true,
  })

  async function refresh(): Promise<void> {
    status.value.loading = true
    try {
      const readinessUnavailable: ManagerAgentReadiness = {
        ready: false,
        status: 'blocked',
        harness: 'claude_agent_sdk',
        runtime_placement: null,
        agent_type: null,
        provider_name: null,
        model_name: null,
        live_voice_enabled: false,
        live_voice_effective: false,
        blockers: [{ code: 'readiness_unavailable', message: 'Manager Agent readiness endpoint unavailable' }],
        checks: { config: false },
      }
      const [llmRes, managerReadiness] = await Promise.all([
        listLLMSettings(),
        getManagerAgentReadiness().catch(() => readinessUnavailable),
      ])

      const settings = llmRes.data?.settings ?? []
      const active = settings.filter(s => s.is_active)
      const hasLlm = active.some(s => s.supports_llm)
      const hasAsr = active.some(s => s.supports_asr)
      const hasTts = active.some(s => s.supports_tts)
      const codex = managerReadiness.checks.codex
      const codexAvailable = Boolean(codex?.available && codex.logged_in)
      const managerAgentReady = managerReadiness.ready
      const liveVoiceSupported = codex?.live_voice?.supported === true
      const liveVoiceEffective = managerReadiness.live_voice_effective

      // 调试开关：VITE_HOMERAIL_FORCE_ONBOARDING=1 时强制触发新手引导
      const forceOnboarding = flagEnabled(import.meta.env.VITE_HOMERAIL_FORCE_ONBOARDING)
      status.value = {
        codexAvailable,
        codexVersion: codex?.version,
        managerAgentReady,
        managerAgentHarness: managerReadiness.harness,
        managerAgentRuntimePlacement: managerReadiness.runtime_placement,
        managerAgentBlockers: managerReadiness.blockers,
        liveVoiceSupported,
        liveVoiceMinimumVersion: codex?.live_voice?.minimum_version,
        liveVoiceVoices: codex?.live_voice?.voices,
        liveVoiceDefaultVoice: codex?.live_voice?.default_voice,
        liveVoiceEffective,
        dockerWorkspace: managerReadiness.checks.docker_workspace
          ? {
              required: managerReadiness.checks.docker_workspace.required,
              hostPath: managerReadiness.checks.docker_workspace.host_path,
              probeEndpoint: managerReadiness.checks.docker_workspace.probe_endpoint,
          }
          : undefined,
        hostShell: managerReadiness.checks.host_shell
          ? {
              required: managerReadiness.checks.host_shell.required,
              available: managerReadiness.checks.host_shell.available,
              shellPath: managerReadiness.checks.host_shell.shell_path,
              workerEntry: managerReadiness.checks.host_shell.worker_entry,
              error: managerReadiness.checks.host_shell.error,
          }
          : undefined,
        hasLlm,
        hasAsr,
        hasTts,
        needsOnboarding: forceOnboarding || (!managerAgentReady || (!liveVoiceEffective && !hasAsr)),
        loading: false,
      }
    } catch {
      status.value = {
        codexAvailable: false,
        managerAgentReady: false,
        managerAgentBlockers: [{ code: 'onboarding_status_error', message: 'Failed to load onboarding status' }],
        liveVoiceSupported: false,
        liveVoiceEffective: false,
        hasLlm: false,
        hasAsr: false,
        hasTts: false,
        needsOnboarding: true,
        loading: false,
      }
    }
  }

  return { status, refresh }
}

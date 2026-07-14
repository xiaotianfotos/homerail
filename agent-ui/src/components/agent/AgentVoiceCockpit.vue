<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent-store'
import {
  closeVoiceSession,
  createVoiceSession,
  getCurrentVoiceSession,
  getCodexModels,
  getVoiceAgentConfig,
  getVoiceSession,
  listVoiceSessions,
  refreshVoiceManagerStatus,
  setCurrentVoiceSession,
  streamConfirmVoiceTask,
  streamVoiceTurn,
  stopVoiceMonitor,
  updateVoiceAgentConfig,
  type CodexModel,
  type GenerativeUiStreamEventV1,
  type VoiceAgentConfig,
  type VoiceConversationMessage,
  type VoiceDebugEvent,
  type VoiceSpeechEvent,
  type VoiceSessionItem,
  type VoiceStreamEvent,
  type VoiceWidget,
  type VoiceWorkspace
} from '@/api/agent'
import VoiceSessionProjectSidebar from '@/components/agent/VoiceSessionProjectSidebar.vue'
import AgentModeTopBar from '@/components/agent/AgentModeTopBar.vue'
import DagResourceStatusPill from '@/components/agent/DagResourceStatusPill.vue'
import VoiceDynamicWidget from '@/components/agent/VoiceDynamicWidget.vue'
import {
  resolveVoiceSessionProjectRestore,
  VoiceSessionTransitionGuard,
} from '@/agent/voice-session-restore'
import GenerativeUiCanonicalSurface from '@/components/generative-ui/GenerativeUiCanonicalSurface.vue'
import GenerativeUiShadowPreview from '@/components/generative-ui/GenerativeUiShadowPreview.vue'
import {
  resolveVoiceGenerativeUiPresentation,
  showLegacyWidgetAlongsideCanonical,
} from '@/generative-ui/production-mode'
import {
  isCodexModelUnavailable,
  resolveCodexModelOptions,
  resolveSelectedCodexModel,
  resolveCodexReasoningEffortForModel,
  resolveCodexReasoningEffortOptions,
  resolveCodexServiceTierForModel,
  resolveCodexServiceTierOptions
} from '@/components/agent/codex-model-selection'
import { voiceWs } from '@/api/clients/events-ws'
import { useOnboardingStatus } from '@/composables/useOnboardingStatus'
import {
  VOICE_GAMEPAD_BUTTON,
  resolveVoiceGamepadButtonIntent,
  resolveVoiceGamepadContext,
  resolveVoiceGamepadDirectionIntent,
  type VoiceGamepadDirection,
  type VoiceGamepadFocusMode,
  type VoiceGamepadInputContext
} from '@/components/agent/voice-gamepad-router'
import {
  createAsrRealtimeSocket,
  getVoiceSettings,
  speechStream,
  transcribeVoice,
  updateVoiceSettings,
  type UpdateVoiceSettingsRequest,
  type VoiceSettings
} from '@/api/services/voice-api'
import {
  getHidApi,
  hidDeviceMatchesBinding,
  hidReportMatchesBinding,
  keyboardEventMatchesBinding,
  loadVoiceHidButtonBinding,
  loadVoiceKeyboardButtonBinding,
  loadVoiceVadSilenceMs,
  type VoiceHidButtonBinding,
  type VoiceKeyboardButtonBinding
} from '@/utils/voice-hid-control'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import { formatRuntimeModelSettingLabel, isKimiProviderId } from '@/lib/model-runtime'
import { createProtocolLabels } from '@/lib/protocol-labels'
import {
  cleanVoiceTranscript,
  isRecentDuplicateVoiceTranscript,
  normalizeVoiceTranscriptForDuplicate
} from '@/utils/voice-transcript'
import {
  createVoiceSpeechEventKey,
  hasRecentVoiceSpeechEvent,
  isVoiceConversationMessageSpeakable,
  rememberVoiceSpeechEvent,
  voiceConversationMessageSpeechText
} from '@/utils/voice-speech-queue'
import {
  isAndroidTvCompactViewport,
  isAndroidTvShell,
  isMobileVoiceUserAgent
} from '@/utils/voice-host-platform'
import { createVoiceMediaStream } from '@/utils/voice-audio-input'
import {
  NATIVE_GAMEPAD_ANALOG_EVENT,
  NATIVE_GAMEPAD_BUTTON_EVENT,
  nativeGamepadEventDetail,
  type NativeGamepadAnalogDetail,
  type NativeGamepadButtonDetail
} from '@/utils/native-gamepad-events'
import {
  nativeVoiceCaptureAvailable,
  nativeTtsPlaybackAvailable,
  playNativeTtsBlob,
  startNativeVoiceCapture,
  stopNativeTtsPlayback,
  type NativeVoiceCaptureSession,
  type NativeVoiceStatus
} from '@/utils/android-tv-native-voice'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  EyeOff,
  Gamepad2,
  Mic,
  MessageSquareText,
  PanelLeftOpen,
  Plus,
  SendHorizontal,
  SlidersHorizontal,
  Sparkles,
  Volume2,
  X
} from 'lucide-vue-next'

const store = useAgentStore()
const { t, te } = useI18n()
const { planLabel } = createProtocolLabels(t)
// 新手引导配置状态检测（用于"模型配置"按钮的缺配提示）
const { status: onboardingStatus, refresh: refreshOnboarding } = useOnboardingStatus()
const needsOnboardingHint = computed(() => onboardingStatus.value.needsOnboarding)
const modelConfigButtonLabel = computed(() =>
  needsOnboardingHint.value ? t('voice.model.incomplete') : t('voice.model.configuration')
)
const devOnboardingEntryVisible =
  import.meta.env.DEV && flagEnabled(import.meta.env.VITE_HOMERAIL_DEV_ONBOARDING_ENTRY)
const generativeUiShadowPreviewRequested =
  import.meta.env.DEV && flagEnabled(import.meta.env.VITE_HOMERAIL_GENERATIVE_UI_SHADOW_PREVIEW)
const props = withDefaults(
  defineProps<{
    voiceOnly?: boolean
  }>(),
  {
    voiceOnly: false
  }
)
const VOICE_LEFT_PANE_KEY = 'omni.voiceCockpit.leftPaneOpen'
const VOICE_DETAILS_PANE_KEY = 'omni.voiceCockpit.detailsOpen'
type ArtifactPreviewKind = 'html' | 'image' | 'gallery'
type ArtifactPreviewLayout = 'fluid' | 'portrait'
type CodexReasoningEffort = NonNullable<VoiceAgentConfig['reasoning_effort']>
type WidgetPreviewRequest = {
  title?: string
  url: string
  kind?: ArtifactPreviewKind
  layout?: ArtifactPreviewLayout
  images?: string[]
}
type VoiceGamepadWidgetRef = {
  id: string
  kind: 'task' | 'dynamic' | 'artifact' | 'execution'
  widget?: VoiceWidget
}
type VoiceSessionSidebarGamepadControls = {
  focusNextGamepadItem: (delta: number) => void
  confirmFocusedGamepadItem: () => void
  toggleFocusedProjectSessions: () => void
  ensureGamepadFocus: () => void
  refresh: () => Promise<void>
}
type GenerativeUiShadowPreviewControls = {
  acceptStreamEvent: (event: GenerativeUiStreamEventV1) => Promise<void>
  refresh: () => Promise<void>
}
type GenerativeUiCanonicalSurfaceControls = {
  refresh: () => Promise<void>
}

const workspace = ref<VoiceWorkspace | null>(null)
const generativeUiCanonicalAvailable = ref(false)
const generativeUiCanonicalResolved = ref(false)
const generativeUiCanonicalNodeIds = ref<Set<string>>(new Set())
const selectedGenerativeUiNodeId = ref('')
const sessionTransitioning = ref(true)
const voiceSessionTransitions = new VoiceSessionTransitionGuard()
const generativeUiPresentation = computed(() => resolveVoiceGenerativeUiPresentation({
  mode: workspace.value?.generative_ui_mode,
  canonical_available: generativeUiCanonicalAvailable.value,
  shadow_preview_requested: generativeUiShadowPreviewRequested,
}))
const generativeUiShadowPreviewActive = computed(() => generativeUiPresentation.value.show_shadow)
const loading = ref(false)
const speaking = ref(false)
const listening = ref(false)
const detailsOpen = ref(loadBooleanSetting(VOICE_DETAILS_PANE_KEY, true))
const voiceSidebarOpen = ref(
  startsInTvCompactViewport() ? false : loadBooleanSetting(VOICE_LEFT_PANE_KEY, true)
)
const voiceSettings = ref<VoiceSettings | null>(null)
const voiceAgentConfig = ref<VoiceAgentConfig | null>(null)
const codexModels = ref<CodexModel[]>([])
const codexModelsLoading = ref(false)
const codexModelsLoaded = ref(false)
const codexModelsError = ref('')
const asrLoading = ref(false)
const asrSaving = ref(false)
const ttsSaving = ref(false)
const voiceAgentSaving = ref(false)
const error = ref('')
const voiceConfigError = ref('')
const voiceHidStatus = ref('')
const modelMenuOpen = ref(false)
const voiceHidBinding = ref<VoiceHidButtonBinding | null>(null)
const voiceKeyboardBinding = ref<VoiceKeyboardButtonBinding | null>(null)
const voiceVadSilenceMs = ref(loadVoiceVadSilenceMs())
const voiceGamepadStatus = ref('')
const voiceGamepadConnected = ref(false)
const voiceGamepadNoticeVisible = ref(false)
const voiceGamepadNoticeName = ref(t('voice.gamepad.generic'))
const voiceGamepadFocusMode = ref<VoiceGamepadFocusMode>('widgets')
const voiceGamepadLiveVisible = ref(false)
const voiceGamepadPressedButtonIds = ref<Set<number>>(new Set())
const selectedWidgetId = ref('')
const spokenText = ref('')
const liveTranscript = ref('')
const lastUserTranscript = ref('')
const optimisticConversationItems = ref<VoiceConversationMessage[]>([])
const voiceSessionShortcuts = ref<VoiceSessionItem[]>([])
const spokenAssistantMessageIds = ref<Set<string>>(new Set())
const highlightedWidgetIds = ref<Set<string>>(new Set())
const artifactPreviewModal = ref<{
  title: string
  url: string
  kind: ArtifactPreviewKind
  layout: ArtifactPreviewLayout
  images?: string[]
} | null>(null)
const artifactPreviewImageIndex = ref(0)
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const viewportHeight = ref(typeof window === 'undefined' ? 900 : window.innerHeight)
const voiceLevel = ref(0)
const waveformBars = ref<number[]>(Array.from({ length: 46 }, () => 0.1))
const waveformSamples = ref<number[]>(Array.from({ length: 72 }, () => 0))
const voiceBusy = ref(false)
const managerSubmitting = ref(false)
const codexTextDraft = ref('')
const codexTextSubmitting = ref(false)
// 辅助输入模式：ASR 转写结果填入输入框等待手动发送，而非 VAD 后自动提交。
// 'realtime' = VAD 检测静音后整段转写并自动提交（原 omni 体验）。
// 'assist' = ASR 流式转写填入 composer，由用户改完手动发送。
const VOICE_INPUT_ASSIST_KEY = 'homerail.voice.input-assist'
const voiceInputAssist = ref(loadBooleanSetting(VOICE_INPUT_ASSIST_KEY, false))
const composerRef = ref<HTMLTextAreaElement | null>(null)
const fullscreenPromptVisible = ref(false)
const fullscreenPromptDismissed = ref(false)
const cockpitRoot = ref<HTMLElement | null>(null)
const modelMenuRef = ref<HTMLElement | null>(null)
const voiceSidebarRef = ref<VoiceSessionSidebarGamepadControls | null>(null)
const voiceCardGridRef = ref<HTMLElement | null>(null)
const generativeUiShadowPreviewRef = ref<GenerativeUiShadowPreviewControls | null>(null)
const generativeUiCanonicalSurfaceRef = ref<GenerativeUiCanonicalSurfaceControls | null>(null)
const conversationThreadRef = ref<HTMLElement | null>(null)
const noSleepVideo = ref<HTMLVideoElement | null>(null)
const ttsAudioElement = ref<HTMLAudioElement | null>(null)

watch(
  [
    () => workspace.value?.session_id,
    () => workspace.value?.generative_ui_mode,
  ],
  () => {
    generativeUiCanonicalAvailable.value = false
    generativeUiCanonicalResolved.value = false
    generativeUiCanonicalNodeIds.value = new Set()
    selectedGenerativeUiNodeId.value = ''
  },
)

function onGenerativeUiCanonicalAvailability(payload: {
  available: boolean
  node_ids: string[]
  loading?: boolean
}): void {
  if (payload.loading) {
    generativeUiCanonicalResolved.value = false
    generativeUiCanonicalAvailable.value = false
    generativeUiCanonicalNodeIds.value = new Set()
    return
  }
  generativeUiCanonicalResolved.value = true
  generativeUiCanonicalAvailable.value = payload.available
  generativeUiCanonicalNodeIds.value = new Set(payload.node_ids)
  if (selectedGenerativeUiNodeId.value && !generativeUiCanonicalNodeIds.value.has(selectedGenerativeUiNodeId.value)) {
    selectedGenerativeUiNodeId.value = ''
  }
}

function beginVoiceSessionTransition(): number {
  const generation = voiceSessionTransitions.begin()
  sessionTransitioning.value = true
  generativeUiCanonicalResolved.value = false
  generativeUiCanonicalAvailable.value = false
  generativeUiCanonicalNodeIds.value = new Set()
  selectedGenerativeUiNodeId.value = ''
  workspace.value = null
  return generation
}

function completeVoiceSessionTransition(generation: number): void {
  if (voiceSessionTransitions.isCurrent(generation)) sessionTransitioning.value = false
}

function selectGenerativeUiNode(payload: { node_id: string }): void {
  selectedGenerativeUiNodeId.value = payload.node_id
}

let mediaStream: MediaStream | null = null
let nativeVoiceCaptureSession: NativeVoiceCaptureSession | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let processor: ScriptProcessorNode | null = null
let micSource: MediaStreamAudioSourceNode | null = null
let silentGain: GainNode | null = null
let rafId = 0
let transcriptClearPending = false
let transcriptSubmittedAssistantIds = new Set<string>()
let speechActive = false
let lastVoiceAt = 0
let pcmChunks: Float32Array[] = []
let currentVoiceSampleRate = 48000
let voiceAbort: AbortController | null = null
// 对话流的 abort 控制器：切换 session 时 abort 旧 turn 的 stream fetch，
// 避免旧 turn 的 handleVoiceStreamEvent 回调往不相关的 workspace 写数据。
let voiceTurnAbort: AbortController | null = null
let voiceSessionToken = 0
let voiceHidDevice: any | null = null
let voiceHidPressed = false
let voiceGamepadFrame = 0
let voiceGamepadPressedButtons = new Set<number>()
let voiceGamepadAxisLocks = new Set<VoiceGamepadDirection>()
let voiceGamepadNoticeTimer = 0
let nativeGamepadAnalogAt = 0
let asrSocket: WebSocket | null = null
let asrTranscriptRaw = ''
let asrFinalResolve: ((text: string) => void) | null = null
let asrFinalReject: ((error: Error) => void) | null = null
let asrFinalTimer = 0
let asrClosing = false
let lastSubmittedVoiceTranscriptKey = ''
let lastSubmittedVoiceTranscriptAt = 0
let managerStatusTimer = 0
let voiceStatusUnsub: (() => void) | null = null
let pluginRegistryUnsub: (() => void) | null = null
let pluginRegistryStateUnsub: (() => void) | null = null
let statusFocusApplied = false
let fullscreenRetryHandler: (() => void) | null = null
let widgetHighlightTimer = 0
let widgetFingerprintCache = new Map<string, string>()
let widgetIdCache = new Set<string>()
let ttsAudioContext: AudioContext | null = null
let ttsPlaybackUnlocked = false
let ttsDomPlaybackUnlocked = false
let backgroundSpeechQueue = Promise.resolve()
let speechEventQueue: VoiceSpeechEvent[] = []
let speechEventKeySeenAt = new Map<string, number>()
let speechQueueRunning = false
let ttsBroadcastChannel: BroadcastChannel | null = null
let currentTtsSource: AudioBufferSourceNode | null = null
let currentTtsAudioReject: ((error: Error) => void) | null = null
let ttsPlaybackGeneration = 0
let screenWakeLock: { release: () => Promise<void> } | null = null
let noSleepPlayerActive = false
let fullscreenRequesting = false

const CLEAR_COMMANDS = [
  '删除',
  '刪除',
  '清空',
  '清除',
  '重新来',
  '重新來',
  '重来',
  '重來',
  '撤销',
  '撤銷',
  'delete',
  'clear',
  'reset',
  'start over',
  'undo',
]
const VOICE_ROOT_LOCK_CLASS = 'voice-cockpit-root-active'
const VOICE_TTS_CHANNEL = 'homerail.voice.tts.v1'
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
const voiceInstanceId = createVoiceInstanceId()

function flagEnabled(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const taskDraft = computed(() => workspace.value?.task_draft)
const confirmation = computed(() => workspace.value?.pending_confirmations?.[0])
const conversationItems = computed(() => {
  const persisted = workspace.value?.conversation ?? []
  const pending = optimisticConversationItems.value.filter(
    item => !persisted.some(existing => existing.role === item.role && existing.text === item.text)
  )
  return [...persisted, ...pending]
})
const localDebugEvents = ref<VoiceDebugEvent[]>([])
const displayWidgets = computed<VoiceWidget[]>(() => {
  return (workspace.value?.widgets ?? []).filter(
    widget =>
      !['task_draft', 'confirmation', 'memory_refs'].includes(widget.type) &&
      ![
        'manager-status',
        'manager-progress',
        'dag-progress',
        'manager-run',
        'manager-agent-blocker'
      ].includes(widget.id) &&
      !isDuplicateTaskDraftWidget(widget) &&
      widgetUiState(widget) !== 'hidden' &&
      showLegacyWidgetAlongsideCanonical(
        widget.id,
        generativeUiPresentation.value,
        generativeUiCanonicalNodeIds.value,
      )
  )
})
const minimizedWidgets = computed(() => displayWidgets.value.filter(isWidgetMinimized))
const canvasWidgets = computed(() =>
  dedupeXiaohongshuWidgets(displayWidgets.value.filter(widget => !isWidgetMinimized(widget)))
)
const deckPreviewFocusActive = computed(() => canvasWidgets.value.some(isSlideDeckWidget))
const canvasWidgetFocusSignature = computed(() =>
  canvasWidgets.value.map(widgetFingerprint).join('||')
)
const managerStatusWidget = computed(() =>
  (workspace.value?.widgets ?? []).find(widget => widget.id === 'manager-status')
)
const dagProgressWidget = computed(() =>
  (workspace.value?.widgets ?? []).find(widget => widget.id === 'dag-progress')
)
const omniModelOptions = computed(() => store.omniRuntimeModels)
const llmModelOptions = computed(() => store.llmRuntimeModels)
const asrModelOptions = computed(() => store.asrRuntimeModels)
const ttsModelOptions = computed(() => store.ttsRuntimeModels)
const voiceAgentHarness = computed<VoiceAgentConfig['harness']>(
  () => voiceAgentConfig.value?.harness || 'claude_agent_sdk'
)
const codexHarnessActive = computed(() => voiceAgentHarness.value === 'codex_appserver')
const kimiHarnessActive = computed(() => voiceAgentHarness.value === 'kimi_code')
const configuredCodexModel = computed(() =>
  codexHarnessActive.value ? voiceAgentConfig.value?.model_name : null
)
const codexModelOptions = computed<CodexModel[]>(() => resolveCodexModelOptions(
  codexModels.value,
  configuredCodexModel.value,
  codexModelsLoaded.value
))
const selectedCodexModel = computed(() => resolveSelectedCodexModel(
  codexModelOptions.value,
  configuredCodexModel.value
))
const configuredCodexModelUnavailable = computed(() => isCodexModelUnavailable(
  codexModels.value,
  configuredCodexModel.value,
  codexModelsLoaded.value
))
const managerAgentModelOptions = computed(() => {
  if (kimiHarnessActive.value) {
    return llmModelOptions.value.filter(isKimiCodeCompatibleSetting)
  }
  return llmModelOptions.value
})
const selectedManagerAgentModelId = computed(() => {
  const current = voiceAgentConfig.value?.llm_setting_id || selectedLlmModelId.value
  if (current && managerAgentModelOptions.value.some(setting => setting.id === current)) return current
  return managerAgentModelOptions.value[0]?.id ?? ''
})
const codexReasoningEffort = computed(() => voiceAgentConfig.value?.reasoning_effort || 'low')
const codexReasoningEffortOptions = computed(() =>
  resolveCodexReasoningEffortOptions(
    codexModels.value,
    selectedCodexModel.value,
    codexReasoningEffort.value
  ).map(option => {
    const descriptionKey = `voice.model.reasoningDescriptions.${option.value}`
    return {
      ...option,
      description: te(descriptionKey) ? t(descriptionKey) : option.description
    }
  })
)
const codexServiceTier = computed(() => voiceAgentConfig.value?.service_tier || '')
const codexServiceTierOptions = computed(() =>
  resolveCodexServiceTierOptions(
    codexModels.value,
    selectedCodexModel.value
  ).map(option => option.value
    ? option
    : {
        ...option,
        label: t('voice.model.standardServiceTier'),
        description: t('voice.model.standardServiceTierDescription')
      })
)
const recognitionMode = computed<'omni' | 'asr'>(() =>
  voiceSettings.value?.recognition_mode === 'asr' ? 'asr' : 'omni'
)
const selectedOmniModelId = computed(() => {
  if (!voiceSettings.value) return ''
  if (voiceSettings.value.omni_llm_setting_id) return voiceSettings.value.omni_llm_setting_id
  return (
    omniModelOptions.value.find(setting => setting.model_name === voiceSettings.value?.omni_model)
      ?.id ?? ''
  )
})
const selectedLlmModelId = computed(() => {
  if (!voiceSettings.value) return ''
  if (voiceSettings.value.llm_setting_id) return voiceSettings.value.llm_setting_id
  return (
    llmModelOptions.value.find(setting => setting.model_name === voiceSettings.value?.llm_model)
      ?.id ?? ''
  )
})
const selectedAsrModelId = computed(() => {
  if (!voiceSettings.value) return ''
  if (voiceSettings.value.asr_llm_setting_id) return voiceSettings.value.asr_llm_setting_id
  return (
    asrModelOptions.value.find(setting => setting.model_name === voiceSettings.value?.asr_model)
      ?.id ?? ''
  )
})
const selectedTtsModelId = computed(() => {
  if (!voiceSettings.value) return ''
  if (voiceSettings.value.tts_llm_setting_id) return voiceSettings.value.tts_llm_setting_id
  return (
    ttsModelOptions.value.find(setting => setting.model_name === voiceSettings.value?.tts_model)
      ?.id ?? ''
  )
})
const monitorRunning = computed(() => workspace.value?.codex_monitor_status === 'running')
const agentRunning = computed(
  () => managerSubmitting.value || (loading.value && !speaking.value) || monitorRunning.value
)
const agentActivityActive = computed(() => agentRunning.value || speaking.value)
const agentRunStateText = computed(() => {
  if (speaking.value) return t('voice.state.aiSpeaking')
  return agentRunning.value ? t('voice.state.agentRunning') : t('voice.state.agentIdle')
})
const agentRunButtonText = computed(() =>
  speaking.value ? t('voice.state.speaking') : t('voice.state.agentRunning')
)
const agentRunButtonHint = computed(() =>
  speaking.value ? t('voice.state.narrating') : t('voice.state.tapToStop')
)
const terminalProgressStatuses = new Set(['done', 'blocked', 'failed', 'error', 'cancelled'])
const workspaceTerminal = computed(() => {
  const status = workspace.value?.progress_brief?.status?.trim()
  return Boolean(
    status &&
    terminalProgressStatuses.has(status) &&
    !monitorRunning.value &&
    !loading.value &&
    !managerSubmitting.value
  )
})
const voiceRuntimeLoading = computed(() => asrLoading.value || !voiceSettings.value)
const voiceInputLocked = computed(
  () =>
    speaking.value ||
    loading.value ||
    voiceBusy.value ||
    managerSubmitting.value ||
    voiceRuntimeLoading.value ||
    onboardingStatus.value.needsOnboarding
)
const voiceState = computed(() => {
  if (speaking.value) return 'speaking'
  if (listening.value) return 'listening'
  if (voiceRuntimeLoading.value) return 'thinking'
  if (voiceBusy.value || loading.value || managerSubmitting.value) return 'thinking'
  return 'idle'
})
const voiceStateText = computed(() => {
  if (onboardingStatus.value.needsOnboarding) return t('voice.state.onboardingRequired')
  if (voiceState.value === 'speaking') return t('voice.state.aiSpeakingWait')
  if (voiceState.value === 'listening') {
    return speechActive ? t('voice.state.listeningToYou') : t('voice.state.waitingForSpeech')
  }
  if (voiceState.value === 'thinking') return processingText.value || t('voice.state.processing')
  return t('voice.state.tapToSpeak')
})
const composerSubmitDisabled = computed(
  () => !codexTextDraft.value.trim() || codexTextSubmitting.value || loading.value
)
const activeVoiceModelOptions = computed(() =>
  recognitionMode.value === 'asr' ? asrModelOptions.value : omniModelOptions.value
)
const selectedVoiceModelId = computed(() =>
  recognitionMode.value === 'asr' ? selectedAsrModelId.value : selectedOmniModelId.value
)
const voiceModelTitle = computed(() =>
  recognitionMode.value === 'asr' ? t('voice.model.asr') : t('voice.model.omni')
)
const voiceModelFallback = computed(() =>
  recognitionMode.value === 'asr'
    ? voiceSettings.value?.asr_model || t('voice.model.asrModelUnconfigured')
    : voiceSettings.value?.omni_model || t('voice.model.omniUnconfigured')
)
const asrModelLabel = computed(() => {
  const setting = asrModelOptions.value.find(item => item.id === selectedAsrModelId.value)
  return modelSettingLabel(setting, asrModelOptions.value) || voiceSettings.value?.asr_model || t('voice.model.asrUnconfigured')
})
const ttsModelLabel = computed(() => {
  const setting = ttsModelOptions.value.find(item => item.id === selectedTtsModelId.value)
  return modelSettingLabel(setting, ttsModelOptions.value) || voiceSettings.value?.tts_model || t('voice.model.ttsUnconfigured')
})
const selectedTtsSetting = computed(
  () => ttsModelOptions.value.find(item => item.id === selectedTtsModelId.value) ?? null
)
function isArkVoiceSetting(
  setting?: { protocol?: string; voice_adapter?: string } | null
): boolean {
  return (
    setting?.protocol === 'volcengine_doubao_voice' ||
    setting?.protocol === 'volcengine_ark_voice' ||
    setting?.protocol === 'volcengine_openspeech' ||
    setting?.voice_adapter === 'volcengine_doubao_voice' ||
    setting?.voice_adapter === 'volcengine_ark_voice' ||
    setting?.voice_adapter === 'volcengine_openspeech'
  )
}
const arkTtsDetails = computed(() => {
  const setting = selectedTtsSetting.value
  if (!setting || !isArkVoiceSetting(setting)) return ''
  const speaker =
    voiceSettings.value?.tts_voice || setting.tts_voice || 'zh_female_vv_uranus_bigtts'
  const format = setting.tts_format || 'mp3'
  const sampleRate = setting.tts_sample_rate || 24000
  return `${speaker} · ${format} · ${sampleRate}Hz`
})
const voiceButtonBars = computed(() => {
  const level = Math.max(0.06, voiceLevel.value)
  const baseline = [0.36, 0.58, 0.82, 0.58, 0.36]
  return [0.45, 0.72, 1, 0.68, 0.5].map((weight, index) => {
    const movement = waveformBars.value[index * 5] ?? 0.2
    return Math.min(1, Math.max(baseline[index], level * weight * 1.7 + movement * 0.32))
  })
})
const voiceWavePaths = computed(() => {
  const source = listening.value
    ? waveformSamples.value
    : waveformSamples.value.map((_, index) => Math.sin(index * 0.34) * 0.025)
  const energy = listening.value ? Math.max(0.05, voiceLevel.value) : 0.03
  return [
    {
      id: 'main',
      d: buildVoiceWavePath(source, energy, 0, 1.45, 0),
      className: 'voice-wave-line voice-wave-line--main'
    },
    {
      id: 'upper',
      d: buildVoiceWavePath(source, energy, -8, 0.9, 11),
      className: 'voice-wave-line voice-wave-line--upper'
    },
    {
      id: 'lower',
      d: buildVoiceWavePath(source, energy, 8, 0.82, 23),
      className: 'voice-wave-line voice-wave-line--lower'
    }
  ]
})
const processingText = computed(() => {
  if (onboardingStatus.value.needsOnboarding) return t('voice.state.onboardingRequired')
  if (speaking.value) return t('voice.state.aiSpeakingWait')
  if (asrLoading.value) return t('voice.state.settingsLoading')
  if (!voiceSettings.value) return t('voice.state.settingsUnavailable')
  if (managerSubmitting.value) return workspaceExecutionProgressText.value || t('voice.state.processing')
  if (voiceBusy.value) {
    return recognitionMode.value === 'asr' ? t('voice.state.asrTranscribing') : t('voice.state.omniUnderstanding')
  }
  if (loading.value) return t('voice.state.aiProcessing')
  return ''
})
const taskCardTitle = computed(() => taskDraft.value?.title || t('voice.task.title'))
const taskCardBody = computed(() =>
  summarizeTask(taskDraft.value?.request || t('voice.task.prompt'))
)
const taskSubmitTitle = computed(() => confirmation.value?.summary || t('voice.task.confirmation'))
const xiaohongshuArtifactKeys = computed(
  () =>
    new Set(canvasWidgets.value.filter(isXiaohongshuWidget).map(widgetArtifactKey).filter(Boolean))
)
const artifactWidgets = computed(() =>
  dedupeArtifactWidgets(
    canvasWidgets.value.filter(
      widget =>
        isArtifactWidget(widget) && !xiaohongshuArtifactKeys.value.has(widgetArtifactKey(widget))
    )
  )
)
const taskContextWidgets = computed(() =>
  canvasWidgets.value.filter(
    widget => !isArtifactWidget(widget) && widgetSurface(widget) === 'task'
  )
)
const agentDagSignalWidgets = computed(() =>
  canvasWidgets.value.filter(isAgentDagSignalWidget).slice(0, 4)
)
const executionWidgets = computed(() =>
  canvasWidgets.value.filter(
    widget =>
      !isArtifactWidget(widget) &&
      widgetSurface(widget) === 'execution' &&
      !isAgentDagSignalWidget(widget)
  )
)
const gamepadWidgetRefs = computed<VoiceGamepadWidgetRef[]>(() => {
  const refs: VoiceGamepadWidgetRef[] = []
  if (taskDraft.value) refs.push({ id: 'task-draft', kind: 'task' })
  refs.push(
    ...taskContextWidgets.value.map(widget => ({ id: widget.id, kind: 'dynamic' as const, widget }))
  )
  refs.push(
    ...artifactWidgets.value.map(widget => ({ id: widget.id, kind: 'artifact' as const, widget }))
  )
  if (executionCardVisible.value) refs.push({ id: 'execution-status', kind: 'execution' })
  refs.push(
    ...executionWidgets.value.map(widget => ({ id: widget.id, kind: 'dynamic' as const, widget }))
  )
  return refs
})
const primaryExecutionWidget = computed(() => dagProgressWidget.value)
const workspaceProgressText = computed(
  () => workspace.value?.progress_brief?.short_text?.trim() || ''
)
const workspaceProgressStatus = computed(
  () => workspace.value?.progress_brief?.status?.trim() || ''
)
const workspaceExecutionProgressText = computed(() => {
  if (!workspaceProgressText.value) return ''
  if (['idle', 'clarifying', 'waiting_for_confirmation'].includes(workspaceProgressStatus.value))
    return ''
  return workspaceProgressText.value
})
const executionCardVisible = computed(() =>
  Boolean(primaryExecutionWidget.value || workspace.value?.manager_run_id)
)
const canonicalOwnsCanvasScroll = computed(() =>
  generativeUiPresentation.value.show_canonical
  && !taskDraft.value
  && canvasWidgets.value.length === 0
  && !executionCardVisible.value
)
const executionCardTitle = computed(() => primaryExecutionWidget.value?.title || t('voice.canvas.status'))
const executionCardStatus = computed(
  () =>
    primaryExecutionWidget.value?.status ||
    workspaceExecutionProgressText.value ||
    (primaryExecutionWidget.value ? workspaceProgressStatus.value : '')
)
const executionCardBody = computed(() => {
  return primaryExecutionWidget.value?.body || workspaceExecutionProgressText.value
})
const managerMessages = computed(() => {
  const raw = managerStatusWidget.value?.data?.messages
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => ({
      type: typeof item?.type === 'string' ? item.type : 'text',
      text: typeof item?.text === 'string' ? item.text : ''
    }))
    .filter(item => item.text)
    .slice(-6)
})
const dagNodeRows = computed(() => {
  const raw = dagProgressWidget.value?.data?.nodes
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => ({
      id: String(item?.node_id || item?.id || ''),
      name: String(item?.name || item?.node_id || ''),
      status: String(item?.status_label || item?.status || t('voice.canvas.unknown')),
      rawStatus: String(item?.status || ''),
      isCurrent: Boolean(item?.is_current),
      tokens: Number(item?.tokens_total || 0),
      toolSuccess: Number(item?.tool_calls_success || 0),
      toolFailed: Number(item?.tool_calls_failed || 0),
      toolPending: Number(item?.tool_calls_pending || 0),
      contextPct: typeof item?.context_usage_pct === 'number' ? item.context_usage_pct : null
    }))
    .filter(item => item.id)
})
const dagTelemetryTotals = computed(() => {
  const raw = dagProgressWidget.value?.data?.totals as Record<string, unknown> | undefined
  return {
    tokens: Number(
      raw?.tokens_total || dagNodeRows.value.reduce((total, node) => total + node.tokens, 0)
    ),
    toolSuccess: Number(
      raw?.tool_calls_success ||
        dagNodeRows.value.reduce((total, node) => total + node.toolSuccess, 0)
    ),
    toolFailed: Number(
      raw?.tool_calls_failed ||
        dagNodeRows.value.reduce((total, node) => total + node.toolFailed, 0)
    )
  }
})
const dagContextRemainingText = computed(() => {
  const usages = dagNodeRows.value
    .map(node => node.contextPct)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  if (!usages.length) return ''
  const maxUsage = Math.max(...usages)
  return t('voice.canvas.contextRemaining', { percent: Math.max(0, Math.round(100 - maxUsage)) })
})
const dagSignalRows = computed(() =>
  agentDagSignalWidgets.value
    .map(widget => {
      const data = widget.data ?? {}
      const evidence = Array.isArray(data.evidence)
        ? data.evidence
            .map(item => cleanInlineText(item, 96))
            .filter(Boolean)
            .slice(0, 2)
        : []
      return {
        id: widget.id,
        title: cleanInlineText(widget.title || widget.type, 42),
        status: cleanInlineText(widget.status || data.current_node || '', 32),
        body: cleanInlineText(widget.body || data.next_action || '', 140),
        evidence
      }
    })
    .filter(item => item.title || item.body || item.evidence.length)
)
const statusFocusActive = computed(() => executionCardVisible.value)
const isTouchDevice = computed(
  () => typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
)
const isAndroidTvHost = computed(() => isAndroidTvShell())
const isMobileUserAgent = computed(() => {
  if (typeof navigator === 'undefined') return false
  return isMobileVoiceUserAgent(navigator.userAgent, isAndroidTvHost.value)
})
const isNativeShell = computed(() => {
  if (typeof navigator === 'undefined') return false
  return /HomeRailShell/i.test(navigator.userAgent)
})
const isIosDevice = computed(() => {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
})
const isStandaloneDisplay = computed(() => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    Boolean((navigator as any).standalone)
  )
})
const isMobileDevice = computed(
  () =>
    !isAndroidTvHost.value &&
    (isMobileUserAgent.value ||
      (isTouchDevice.value && Math.min(viewportWidth.value, viewportHeight.value) <= 620))
)
const isPhonePortrait = computed(
  () =>
    isMobileDevice.value &&
    viewportWidth.value <= 820 &&
    viewportHeight.value >= viewportWidth.value
)
const isCompactPhoneLandscape = computed(
  () =>
    isMobileDevice.value &&
    viewportWidth.value > viewportHeight.value &&
    viewportHeight.value <= 620
)
const isTvCompactViewport = computed(() =>
  isAndroidTvCompactViewport({
    androidTv: isAndroidTvHost.value,
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value
  })
)
const effectiveDetailsOpen = computed(() => (isPhonePortrait.value ? false : detailsOpen.value))
const effectiveSidebarOpen = computed(() =>
  isPhonePortrait.value ? false : voiceSidebarOpen.value
)
const tvCompactSidebarDrawerOpen = computed(
  () => isTvCompactViewport.value && effectiveSidebarOpen.value
)
const topbarAuxControlsVisible = computed(() => !isPhonePortrait.value)
const topbarVoiceOnly = computed(() => props.voiceOnly || isMobileDevice.value)
const landscapeDesktopScale = computed(() => {
  if (!isCompactPhoneLandscape.value) return 1
  return Math.max(0.38, Math.min(0.62, viewportWidth.value / 1920))
})
const voiceCockpitClasses = computed(() => [
  `voice-cockpit--${voiceState.value}`,
  {
    'voice-cockpit--native-shell': isNativeShell.value,
    'voice-cockpit--mobile': isMobileDevice.value,
    'voice-cockpit--phone-portrait': isPhonePortrait.value,
    'voice-cockpit--phone-landscape': isCompactPhoneLandscape.value,
    'voice-cockpit--tv-compact': isTvCompactViewport.value
  }
])
const artifactPreviewModalStyle = computed(() => {
  if (artifactPreviewModal.value?.layout !== 'portrait') return {}
  const chromeHeight = isPhonePortrait.value ? 118 : 104
  const sidePadding = isPhonePortrait.value ? 24 : 68
  const availableWidth = Math.max(280, viewportWidth.value - sidePadding)
  const availableHeight = Math.max(360, viewportHeight.value * 0.94 - chromeHeight)
  const width = Math.min(760, availableWidth, availableHeight * 0.75)
  const height = (width * 4) / 3
  return {
    '--artifact-preview-width': `${Math.round(width)}px`,
    '--artifact-preview-height': `${Math.round(height)}px`,
    '--artifact-preview-scale': `${width / 1080}`
  }
})
const artifactPreviewImages = computed(
  () => artifactPreviewModal.value?.images?.filter(Boolean) ?? []
)
const artifactPreviewCurrentImage = computed(() => {
  if (artifactPreviewImages.value.length > 0) {
    return artifactPreviewImages.value[
      Math.min(artifactPreviewImageIndex.value, artifactPreviewImages.value.length - 1)
    ]
  }
  return artifactPreviewModal.value?.url || ''
})
const canPreviewPrevImage = computed(() => artifactPreviewImageIndex.value > 0)
const canPreviewNextImage = computed(
  () => artifactPreviewImageIndex.value < artifactPreviewImages.value.length - 1
)
const hasVoiceStageContent = computed(() =>
  Boolean(
    taskDraft.value ||
    artifactWidgets.value.length ||
    executionCardVisible.value ||
    taskContextWidgets.value.length ||
    executionWidgets.value.length
  )
)
const mobilePanelFocusKey = computed(() =>
  [
    taskDraft.value?.title || '',
    taskDraft.value?.status || '',
    taskContextWidgets.value
      .map(widget => `${widget.id}:${widget.status || ''}:${widgetUiState(widget)}`)
      .join('|'),
    artifactWidgets.value
      .map(widget => `${widget.id}:${widget.status || ''}:${artifactPreviewUrl(widget)}`)
      .join('|'),
    executionWidgets.value
      .map(widget => `${widget.id}:${widget.status || ''}:${widgetUiState(widget)}`)
      .join('|'),
    executionCardVisible.value
      ? `${executionCardTitle.value}:${executionCardStatus.value}:${workspace.value?.manager_run_id || workspace.value?.source_issue_number || ''}`
      : ''
  ].join('::')
)
const captionText = computed(() => {
  if (liveTranscript.value) return liveTranscript.value
  if (lastUserTranscript.value) return lastUserTranscript.value
  if (speaking.value) return voiceStateText.value
  if (voiceInputLocked.value) return processingText.value || voiceStateText.value
  return liveTranscript.value || spokenText.value || voiceStateText.value
})
const voiceInputStatusVisible = computed(() => voiceStateText.value !== captionText.value)
const composerPlaceholder = computed(() => {
  if (listening.value) {
    return voiceInputAssist.value ? t('voice.state.listeningEditable') : t('voice.state.listening')
  }
  return t('voice.composer.placeholder')
})
const captionKind = computed(() => {
  if (liveTranscript.value && ![t('voice.state.listening'), t('voice.state.omniProcessing')].includes(liveTranscript.value))
    return 'user'
  if (lastUserTranscript.value) return 'user'
  if (voiceInputLocked.value) return 'state'
  if (spokenText.value) return 'assistant'
  return 'state'
})
const voiceMainGridStyle = computed(() => ({
  gridTemplateColumns: isPhonePortrait.value
    ? 'minmax(0, 1fr)'
    : `${sidebarColumnWidth()} minmax(0, 1fr) ${detailsColumnWidth()}`
}))
const voiceShellStyle = computed(() => {
  if (!isCompactPhoneLandscape.value) return {}
  const scale = landscapeDesktopScale.value
  return {
    width: `${viewportWidth.value / scale}px`,
    height: `${viewportHeight.value / scale}px`,
    transform: `scale(${scale})`
  }
})
const canRequestElementFullscreen = computed(() => {
  if (isIosDevice.value || typeof document === 'undefined') return false
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void
  }
  return Boolean(root.requestFullscreen || root.webkitRequestFullscreen)
})
const fullscreenGateTitle = computed(() =>
  canRequestElementFullscreen.value ? t('voice.fullscreen.enterMode') : t('voice.fullscreen.homeScreenRequired')
)
const fullscreenGateHint = computed(() =>
  canRequestElementFullscreen.value
    ? t('voice.fullscreen.confirmation')
    : t('voice.fullscreen.iosHint')
)
const fullscreenGateAction = computed(() =>
  canRequestElementFullscreen.value ? t('voice.fullscreen.enter') : t('voice.fullscreen.continue')
)

function modelSettingLabel(setting: LLMSetting | null | undefined, siblings: LLMSetting[]): string {
  return formatRuntimeModelSettingLabel(setting, siblings, planLabel)
}

function isCustomModelSetting(setting: LLMSetting): boolean {
  if (setting.provider_source === 'builtin') return false
  if (setting.provider_source === 'custom') return true
  return (
    setting.plan_type === 'custom' ||
    setting.protocol === 'custom' ||
    setting.endpoint_id === 'custom' ||
    setting.endpoint_name === 'custom'
  )
}

function isKimiCodeCompatibleSetting(setting: LLMSetting): boolean {
  return isKimiProviderId(setting.provider_id) || isCustomModelSetting(setting)
}

function toggleModelMenu(): void {
  if (needsOnboardingHint.value) {
    modelMenuOpen.value = false
    store.openOnboarding()
    return
  }
  modelMenuOpen.value = !modelMenuOpen.value
  if (modelMenuOpen.value) {
    void loadCodexModelCatalog()
  }
}

function closeModelMenuOnOutside(event: PointerEvent): void {
  if (!modelMenuOpen.value) return
  const root = modelMenuRef.value
  const target = event.target
  if (root && target instanceof Node && root.contains(target)) return
  modelMenuOpen.value = false
}

function closeModelMenuOnEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') modelMenuOpen.value = false
}

onMounted(() => {
  voiceVadSilenceMs.value = loadVoiceVadSilenceMs()
  setupTtsCoordination()
  setVoiceRootLock(true)
  void refreshOnboarding() // 刷新配置状态用于模型配置按钮的提示效果
  updateViewportSize()
  if (effectiveSidebarOpen.value) {
    voiceGamepadFocusMode.value = 'sessions'
    void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
  }
  window.addEventListener('resize', updateViewportSize)
  window.addEventListener('orientationchange', updateViewportSize)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  document.addEventListener('pointerdown', closeModelMenuOnOutside)
  window.addEventListener('keydown', handleVoiceKeyboardButton, true)
  window.addEventListener('keydown', closeModelMenuOnEscape)
  window.addEventListener('gamepadconnected', handleVoiceGamepadConnected)
  window.addEventListener('gamepaddisconnected', handleVoiceGamepadDisconnected)
  window.addEventListener(NATIVE_GAMEPAD_BUTTON_EVENT, handleNativeVoiceGamepadButton)
  window.addEventListener(NATIVE_GAMEPAD_ANALOG_EVENT, handleNativeVoiceGamepadAnalog)
  ensureMobileFullscreen()
  void acquireScreenWakeLock()
  void startSession()
  void loadVoiceRuntime()
  void setupVoiceHidControl()
  startVoiceGamepadControl()
  void loadVoiceSessionShortcuts()
  installCodexVoiceTextBridge()
  managerStatusTimer = window.setInterval(() => {
    void refreshManagerStatus()
    // 同时刷新 sidebar 会话列表，让用户在当前 session 时也能看到其他 session 的运行状态。
    void loadVoiceSessionShortcuts()
  }, 5000)
  // 订阅 voice session 状态事件（WebSocket 实时推送），收到任意 session 状态变化时刷新 sidebar。
  // 这样不用纯靠 5s 轮询，其他 session 的 running/done 状态能秒级反映。
  setupVoiceStatusSubscription()
})

watch(
  () => store.onboardingOpen,
  (open, previous) => {
    if (!open && previous) void refreshOnboarding()
  },
)

watch(
  () => store.managerProjectId,
  () => {
    void loadVoiceSessionShortcuts()
  }
)

watch(detailsOpen, value => saveBooleanSetting(VOICE_DETAILS_PANE_KEY, value))
watch(voiceSidebarOpen, value => {
  saveBooleanSetting(VOICE_LEFT_PANE_KEY, value)
  if (value && !isPhonePortrait.value) {
    voiceGamepadFocusMode.value = 'sessions'
    void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
  } else if (!value && voiceGamepadFocusMode.value === 'sessions') {
    voiceGamepadFocusMode.value = 'widgets'
  }
})
watch(
  () =>
    conversationItems.value
      .map(item => `${item.id}:${item.role}:${item.channel || 'final'}:${item.text}`)
      .join('|'),
  () => {
    void scrollConversationToLatest()
  },
  { flush: 'post' }
)
watch(
  canvasWidgetFocusSignature,
  () => {
    void focusUpdatedWidgets()
  },
  { flush: 'post' }
)
watch(
  () => gamepadWidgetRefs.value.map(widget => widget.id).join('|'),
  () => {
    if (!selectedWidgetId.value) return
    if (!gamepadWidgetRefs.value.some(widget => widget.id === selectedWidgetId.value)) {
      selectedWidgetId.value = ''
    }
  }
)
watch(
  mobilePanelFocusKey,
  () => {
    if (!isPhonePortrait.value) return
    void focusLatestMobilePanel()
  },
  { flush: 'post' }
)

onUnmounted(() => {
  if (managerStatusTimer) window.clearInterval(managerStatusTimer)
  voiceTurnAbort?.abort()
  voiceTurnAbort = null
  if (voiceStatusUnsub) {
    voiceStatusUnsub()
    voiceStatusUnsub = null
  }
  if (pluginRegistryUnsub) {
    pluginRegistryUnsub()
    pluginRegistryUnsub = null
  }
  if (pluginRegistryStateUnsub) {
    pluginRegistryStateUnsub()
    pluginRegistryStateUnsub = null
  }
  voiceWs.disconnect()
  if (widgetHighlightTimer) window.clearTimeout(widgetHighlightTimer)
  window.removeEventListener('resize', updateViewportSize)
  window.removeEventListener('orientationchange', updateViewportSize)
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  document.removeEventListener('pointerdown', closeModelMenuOnOutside)
  window.removeEventListener('keydown', handleVoiceKeyboardButton, true)
  window.removeEventListener('keydown', closeModelMenuOnEscape)
  window.removeEventListener('gamepadconnected', handleVoiceGamepadConnected)
  window.removeEventListener('gamepaddisconnected', handleVoiceGamepadDisconnected)
  window.removeEventListener(NATIVE_GAMEPAD_BUTTON_EVENT, handleNativeVoiceGamepadButton)
  window.removeEventListener(NATIVE_GAMEPAD_ANALOG_EVENT, handleNativeVoiceGamepadAnalog)
  removeFullscreenRetry()
  teardownVoiceHidControl()
  teardownVoiceGamepadControl()
  stopVoiceCapture()
  teardownTtsCoordination()
  cancelLocalSpeech('unmount')
  stopNoSleepPlayer()
  void releaseScreenWakeLock()
  ttsAudioContext?.close().catch(() => {})
  ttsAudioContext = null
  ttsPlaybackUnlocked = false
  ttsDomPlaybackUnlocked = false
  resetTtsAudioElement()
  setVoiceRootLock(false)
  uninstallCodexVoiceTextBridge()
})

function installCodexVoiceTextBridge(): void {
  if (typeof window === 'undefined') return
  ;(window as any).__HOMERAIL_VOICE_AGENT_SEND__ = async (text: string) => {
    const clean = String(text || '').trim()
    if (!clean) throw new Error('Voice Agent text is empty')
    await submitCodexTextDraft(clean)
  }
}

function uninstallCodexVoiceTextBridge(): void {
  if (typeof window === 'undefined') return
  delete (window as any).__HOMERAIL_VOICE_AGENT_SEND__
}

async function startSession(): Promise<void> {
  const previousWorkspace = workspace.value
  const generation = beginVoiceSessionTransition()
  loading.value = true
  error.value = ''
  try {
    const restored = await restoreLatestSession()
    if (!voiceSessionTransitions.isCurrent(generation)) return
    if (restored) {
      workspace.value = restored
    } else {
      const res = await createVoiceSession(store.managerProjectId)
      if (!voiceSessionTransitions.isCurrent(generation)) return
      workspace.value = res.data
      // 新建的会话成为当前会话，更新服务端指针。
      void setCurrentVoiceSession(workspace.value?.session_id ?? null)
    }
    rememberSpokenAssistantMessages(workspace.value)
    optimisticConversationItems.value = []
    lastUserTranscript.value = ''
    resetSubmittedTranscriptClear()
    statusFocusApplied = false
    completeVoiceSessionTransition(generation)
    await loadVoiceSessionShortcuts()
    void voiceSidebarRef.value?.refresh()
  } catch (err: any) {
    if (voiceSessionTransitions.isCurrent(generation)) {
      workspace.value = previousWorkspace
      completeVoiceSessionTransition(generation)
      error.value = err?.message || t('voice.errors.sessionStart')
    }
  } finally {
    if (voiceSessionTransitions.isCurrent(generation)) loading.value = false
  }
}

async function createFreshVoiceSession(): Promise<void> {
  const previousWorkspace = workspace.value
  const generation = beginVoiceSessionTransition()
  loading.value = true
  error.value = ''
  try {
    const reusableSessionId = await findReusableEmptyVoiceSessionId(previousWorkspace)
    if (!voiceSessionTransitions.isCurrent(generation)) return
    if (reusableSessionId) {
      const nextWorkspace = previousWorkspace?.session_id === reusableSessionId
        ? previousWorkspace
        : (await getVoiceSession(reusableSessionId)).data
      if (!voiceSessionTransitions.isCurrent(generation)) return
      workspace.value = nextWorkspace
      rememberSpokenAssistantMessages(workspace.value)
      optimisticConversationItems.value = []
      liveTranscript.value = ''
      lastUserTranscript.value = ''
      spokenText.value = ''
      resetSubmittedTranscriptClear()
      statusFocusApplied = false
      completeVoiceSessionTransition(generation)
      void setCurrentVoiceSession(reusableSessionId)
      await loadVoiceSessionShortcuts()
      void voiceSidebarRef.value?.refresh()
      void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
      return
    }
    const res = await createVoiceSession(store.managerProjectId)
    if (!voiceSessionTransitions.isCurrent(generation)) return
    workspace.value = res.data
    rememberSpokenAssistantMessages(workspace.value)
    optimisticConversationItems.value = []
    liveTranscript.value = ''
    lastUserTranscript.value = ''
    spokenText.value = ''
    resetSubmittedTranscriptClear()
    statusFocusApplied = false
    completeVoiceSessionTransition(generation)
    void setCurrentVoiceSession(workspace.value?.session_id ?? null)
    await loadVoiceSessionShortcuts()
    void voiceSidebarRef.value?.refresh()
    void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
  } catch (err: any) {
    if (voiceSessionTransitions.isCurrent(generation)) {
      workspace.value = previousWorkspace
      completeVoiceSessionTransition(generation)
      error.value = err?.message || t('voice.errors.sessionCreate')
    }
  } finally {
    if (voiceSessionTransitions.isCurrent(generation)) loading.value = false
  }
}

async function findReusableEmptyVoiceSessionId(currentWorkspace = workspace.value): Promise<string | null> {
  if (currentWorkspace && workspaceBelongsToCurrentProject(currentWorkspace) && isUnusedVoiceWorkspace(currentWorkspace)) {
    return currentWorkspace.session_id
  }
  try {
    const res = await listVoiceSessions(store.managerProjectId, 50)
    const reusable = (res.data?.sessions ?? []).find(isUnusedVoiceSessionItem)
    return reusable?.session_id ?? null
  } catch {
    return null
  }
}

function workspaceBelongsToCurrentProject(item: VoiceWorkspace): boolean {
  return (item.project_id || null) === (store.managerProjectId || null)
}

function isUnusedVoiceWorkspace(item: VoiceWorkspace): boolean {
  return (
    !item.conversation.some(message => message.role === 'user' && message.text.trim())
    && !String(item.session_title || '').trim()
    && !String(item.session_slate || '').trim()
    && !String(item.active_objective || '').trim()
    && !item.manager_run_id
  )
}

function isUnusedVoiceSessionItem(item: VoiceSessionItem): boolean {
  const reusableStatuses = new Set(['idle', 'created', 'pending'])
  return (
    reusableStatuses.has(String(item.status || 'idle'))
    && Number(item.message_count || 0) === 0
    && !String(item.title || '').trim()
    && !String(item.prompt || '').trim()
    && !(item.run_ids || []).length
  )
}

async function handleVoiceProjectSelected(_projectId: string): Promise<void> {
  liveTranscript.value = ''
  lastUserTranscript.value = ''
  resetSubmittedTranscriptClear()
  optimisticConversationItems.value = []
  statusFocusApplied = false
  workspace.value = null
  await startSession()
}

async function handleVoiceSessionSelected(sessionId: string): Promise<void> {
  if (workspace.value?.session_id === sessionId) {
    void setCurrentVoiceSession(sessionId)
    return
  }
  const previousWorkspace = workspace.value
  // 切换 session 时停掉当前 session 的 TTS、语音采集和对话流，
  // 只对当前选中 session 发声，避免旧 turn 的回调污染新 workspace。
  cancelLocalSpeech('session_switch')
  if (listening.value) stopVoiceCapture()
  voiceTurnAbort?.abort()
  voiceTurnAbort = null
  loading.value = false
  liveTranscript.value = ''
  lastUserTranscript.value = ''
  resetSubmittedTranscriptClear()
  optimisticConversationItems.value = []
  statusFocusApplied = false
  const generation = beginVoiceSessionTransition()
  loading.value = true
  try {
    const res = await getVoiceSession(sessionId)
    if (!voiceSessionTransitions.isCurrent(generation)) return
    workspace.value = res.data
    rememberSpokenAssistantMessages(workspace.value)
    const runId = workspace.value?.manager_run_id
    if (runId) store.setRunId(runId)
    completeVoiceSessionTransition(generation)
    // 更新服务端当前 session 指针，让其他设备刷新后看到同一个 session。
    void setCurrentVoiceSession(sessionId)
  } catch (err: any) {
    if (voiceSessionTransitions.isCurrent(generation)) {
      workspace.value = previousWorkspace
      completeVoiceSessionTransition(generation)
      error.value = err?.message || t('voice.errors.sessionRead')
    }
  } finally {
    if (voiceSessionTransitions.isCurrent(generation)) loading.value = false
  }
}

// 删除会话后：如果删的恰好是当前活动会话，新建一个空会话；否则只刷新侧栏列表。
async function handleVoiceSessionDeleted(sessionId: string): Promise<void> {
  await loadVoiceSessionShortcuts()
  if (workspace.value?.session_id === sessionId) {
    await createFreshVoiceSession()
  }
}

async function endSession(): Promise<void> {
  const sessionId = workspace.value?.session_id
  if (!sessionId) return
  workspace.value = null
  try {
    await closeVoiceSession(sessionId)
  } catch {}
}

async function stopAgentLoop(): Promise<void> {
  const sessionId = workspace.value?.session_id
  if (!sessionId) return
  try {
    const res = await stopVoiceMonitor(sessionId)
    workspace.value = res.data.workspace
  } catch (err: any) {
    recordDebug('monitor_stop_failed', err?.message || '停止 Agent 监控失败', 'warning')
  }
}

async function restoreLatestSession(): Promise<VoiceWorkspace | null> {
  const projectId = store.managerProjectId || null
  const acceptWorkspace = (restored: VoiceWorkspace): VoiceWorkspace | null => {
    const decision = resolveVoiceSessionProjectRestore(projectId, restored.project_id)
    if (!decision.accepted) return null
    if (!projectId && decision.projectId) store.setManagerProjectId(decision.projectId)
    return restored
  }
  try {
    // 单用户系统：当前 session 指针是服务端真相源。优先读它。
    const pointerRes = await getCurrentVoiceSession()
    const pointerId = pointerRes.data?.session_id ?? null
    if (pointerId) {
      const res = await getVoiceSession(pointerId)
      const restored = res.data
      const accepted = acceptWorkspace(restored)
      if (accepted) return accepted
    }
  } catch {
    // 指针端点不可用时 fallback 到最近会话。
  }
  try {
    const listRes = await listVoiceSessions(store.managerProjectId, 1)
    const sessionId = listRes.data?.sessions?.[0]?.session_id
    if (!sessionId) return null
    const res = await getVoiceSession(sessionId)
    const restored = res.data
    return acceptWorkspace(restored)
  } catch {
    return null
  }
}

async function loadVoiceSessionShortcuts(): Promise<void> {
  try {
    const res = await listVoiceSessions(store.managerProjectId, 10)
    voiceSessionShortcuts.value = res.data?.sessions ?? []
  } catch {
    voiceSessionShortcuts.value = []
  }
}

// 订阅 voice session 状态事件（后端通过 events WebSocket 实时推送）。
// 收到任意 session 的 running/done/error 等状态变化时刷新 sidebar 列表，
// 这样多 session 并行时不用纯靠 5s 轮询，状态能秒级反映。
function setupVoiceStatusSubscription(): void {
  if (voiceStatusUnsub) return
  try {
    voiceWs.connect()
    voiceStatusUnsub = voiceWs.on<unknown>('voice:session_status', () => {
      void loadVoiceSessionShortcuts()
    })
    pluginRegistryUnsub = voiceWs.on<unknown>('plugin:registry_changed', () => {
      if (generativeUiShadowPreviewActive.value) {
        void generativeUiShadowPreviewRef.value?.refresh()
      }
      if (generativeUiPresentation.value.request_canonical) {
        void generativeUiCanonicalSurfaceRef.value?.refresh()
      }
    })
    pluginRegistryStateUnsub = voiceWs.onStateChange((state) => {
      if (state === 'connected' && generativeUiShadowPreviewActive.value) {
        void generativeUiShadowPreviewRef.value?.refresh()
      }
      if (state === 'connected' && generativeUiPresentation.value.request_canonical) {
        void generativeUiCanonicalSurfaceRef.value?.refresh()
      }
    })
  } catch {
    // WebSocket 不可用时降级到纯轮询，不影响功能。
  }
}

function recordDebug(
  code: string,
  message: string,
  level: VoiceDebugEvent['level'] = 'error'
): void {
  localDebugEvents.value.push({
    id: `local-${Date.now()}-${localDebugEvents.value.length}`,
    level,
    code,
    message,
    created_at: new Date().toISOString()
  })
  localDebugEvents.value = localDebugEvents.value.slice(-60)
}

function recordTtsDebug(
  code: string,
  message: string,
  level: VoiceDebugEvent['level'] = 'debug'
): void {
  recordDebug(code, message, level)
  if (import.meta.env.DEV || isAndroidTvShell()) console.info('[HomeRailVoiceTts]', code, message)
}

function previewSpeechText(text: string, maxLength = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function appendOptimisticUserMessage(text: string): VoiceConversationMessage {
  const item: VoiceConversationMessage = {
    id: `local-user-${Date.now()}-${optimisticConversationItems.value.length}`,
    role: 'user',
    text,
    created_at: new Date().toISOString()
  }
  optimisticConversationItems.value = [...optimisticConversationItems.value, item].slice(-6)
  return item
}

function loadBooleanSetting(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const value = window.localStorage.getItem(key)
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function startsInTvCompactViewport(): boolean {
  if (typeof window === 'undefined') return false
  return isAndroidTvCompactViewport({
    androidTv: isAndroidTvShell(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight
  })
}

function saveBooleanSetting(key: string, value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, String(value))
}

function createVoiceInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function tabCanUseVoiceOutput(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function setupTtsCoordination(): void {
  if (typeof BroadcastChannel === 'undefined') return
  ttsBroadcastChannel = new BroadcastChannel(VOICE_TTS_CHANNEL)
  ttsBroadcastChannel.onmessage = event => {
    const message = event.data as { type?: string; owner?: string } | null
    if (!message || message.owner === voiceInstanceId) return
    if (message.type === 'speaking' || message.type === 'listening') {
      cancelLocalSpeech('other_voice_tab')
    }
    if (message.type === 'listening') stopVoiceCapture()
  }
}

function teardownTtsCoordination(): void {
  ttsBroadcastChannel?.close()
  ttsBroadcastChannel = null
}

function broadcastVoiceActivity(type: 'speaking' | 'listening'): void {
  ttsBroadcastChannel?.postMessage({ type, owner: voiceInstanceId, at: Date.now() })
}

function setVoiceRootLock(active: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(VOICE_ROOT_LOCK_CLASS, active)
  document.body.classList.toggle(VOICE_ROOT_LOCK_CLASS, active)
  document.getElementById('app')?.classList.toggle(VOICE_ROOT_LOCK_CLASS, active)
}

function updateViewportSize(): void {
  if (typeof window === 'undefined') return
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
  hideMobileBrowserChrome()
  ensureMobileFullscreen()
}

function sidebarColumnWidth(): string {
  if (isTvCompactViewport.value) return '44px'
  if (isCompactPhoneLandscape.value) return effectiveSidebarOpen.value ? '292px' : '56px'
  if (viewportWidth.value <= 1280) return effectiveSidebarOpen.value ? '250px' : '52px'
  return effectiveSidebarOpen.value ? '292px' : '56px'
}

function detailsColumnWidth(): string {
  if (!effectiveDetailsOpen.value) return '0px'
  if (isTvCompactViewport.value) return '220px'
  if (isCompactPhoneLandscape.value) return '340px'
  if (viewportWidth.value <= 1280) return '300px'
  return '340px'
}

function removeFullscreenRetry(): void {
  if (!fullscreenRetryHandler || typeof window === 'undefined') return
  window.removeEventListener('pointerdown', fullscreenRetryHandler)
  window.removeEventListener('touchend', fullscreenRetryHandler)
  fullscreenRetryHandler = null
}

function hideMobileBrowserChrome(): void {
  if (!isMobileDevice.value || typeof window === 'undefined') return
  window.setTimeout(
    () => window.scrollTo({ top: 1, left: 0, behavior: 'instant' as ScrollBehavior }),
    80
  )
}

async function ensureMobileFullscreen(): Promise<void> {
  if (!isMobileDevice.value || typeof document === 'undefined' || typeof window === 'undefined')
    return
  if (isStandaloneDisplay.value || document.fullscreenElement) {
    fullscreenPromptVisible.value = false
    return
  }
  if (!canRequestElementFullscreen.value) {
    fullscreenPromptVisible.value = !fullscreenPromptDismissed.value
    hideMobileBrowserChrome()
    return
  }
  fullscreenPromptVisible.value = true
  hideMobileBrowserChrome()
}

async function enterMobileFullscreen(): Promise<void> {
  if (fullscreenRequesting) return
  fullscreenRequesting = true
  if (!canRequestElementFullscreen.value) {
    activateNoSleepPlayer()
    fullscreenPromptDismissed.value = true
    fullscreenPromptVisible.value = false
    hideMobileBrowserChrome()
    fullscreenRequesting = false
    return
  }
  try {
    const entered = await requestMobileFullscreen()
    fullscreenPromptVisible.value = !entered && !document.fullscreenElement
    activateNoSleepPlayer()
    hideMobileBrowserChrome()
  } finally {
    fullscreenRequesting = false
  }
}

async function requestMobileFullscreen(): Promise<boolean> {
  hideMobileBrowserChrome()
  if (typeof document === 'undefined' || document.fullscreenElement) return true
  if (!canRequestElementFullscreen.value) return false
  const targets = [cockpitRoot.value, document.documentElement].filter(Boolean) as Array<
    HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
  >
  for (const target of targets) {
    const request =
      target.requestFullscreen?.bind(target) || target.webkitRequestFullscreen?.bind(target)
    if (!request) continue
    try {
      await request({ navigationUI: 'hide' } as FullscreenOptions)
      fullscreenPromptVisible.value = false
      return true
    } catch {
      // Some mobile browsers accept fullscreen only on documentElement; try the next target.
    }
  }
  return false
}

function handleFullscreenChange(): void {
  if (!isMobileDevice.value || typeof document === 'undefined') return
  fullscreenPromptVisible.value =
    !document.fullscreenElement && !isStandaloneDisplay.value && canRequestElementFullscreen.value
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    void acquireScreenWakeLock()
    activateNoSleepPlayer()
    hideMobileBrowserChrome()
    return
  }
  stopVoiceCapture()
  cancelLocalSpeech('hidden_tab')
}

async function acquireScreenWakeLock(): Promise<void> {
  if (isAndroidTvHost.value) return
  if (typeof navigator === 'undefined' || document.visibilityState !== 'visible') return
  const wakeLock = (navigator as any).wakeLock
  if (!wakeLock?.request || screenWakeLock) return
  try {
    screenWakeLock = await wakeLock.request('screen')
  } catch {
    screenWakeLock = null
  }
}

async function releaseScreenWakeLock(): Promise<void> {
  const lock = screenWakeLock
  screenWakeLock = null
  await lock?.release().catch(() => {})
}

function activateNoSleepPlayer(): void {
  if (isAndroidTvHost.value) return
  if (!isMobileDevice.value) return
  void acquireScreenWakeLock()
  const video = noSleepVideo.value
  if (!video || (noSleepPlayerActive && !video.paused)) return
  video.muted = true
  video.loop = true
  video.setAttribute('playsinline', '')
  video.setAttribute('webkit-playsinline', '')
  video.disablePictureInPicture = true
  video
    .play()
    .then(() => {
      noSleepPlayerActive = true
    })
    .catch(err => {
      noSleepPlayerActive = false
      recordDebug('nosleep_player_failed', err?.message || '防息屏播放器启动失败', 'warning')
    })
}

function stopNoSleepPlayer(): void {
  const video = noSleepVideo.value
  if (!video) return
  video.pause()
  noSleepPlayerActive = false
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

function buildVoiceWavePath(
  values: number[],
  energy: number,
  verticalOffset: number,
  scale: number,
  shift: number
): string {
  const width = 360
  const centerY = 38 + verticalOffset
  const usable = Math.max(2, values.length - 1)
  const points = values.map((value, index) => {
    const x = (index / usable) * width
    const sample = values[(index + shift) % values.length] ?? value
    const sample2 = values[(index + shift + 5) % values.length] ?? value
    const signed = Math.max(-1, Math.min(1, sample * 0.82 + sample2 * 0.18))
    const envelope = 0.28 + Math.sin((index / usable) * Math.PI) * 0.72
    const amplitude = (18 + energy * 92) * envelope * scale
    return { x, y: centerY + signed * amplitude }
  })
  if (!points.length) return `M 0 ${centerY} L ${width} ${centerY}`
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const midX = (previous.x + current.x) / 2
    const midY = (previous.y + current.y) / 2
    d += ` Q ${previous.x.toFixed(1)} ${previous.y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`
  }
  const last = points[points.length - 1]
  d += ` T ${last.x.toFixed(1)} ${last.y.toFixed(1)}`
  return d
}

function dagNodeDisplayName(node: { id: string; name: string }, index: number): string {
  const raw = String(node.name || node.id || '').trim()
  const normalized = raw.toLowerCase()
  const internalNames = new Set([
    '代码实现',
    '代碼實現',
    '前端代码实现',
    '前端代碼實現',
    'coding',
    'testing',
    'coder',
    'tester',
    'codex appserver smoke worker',
    'kimi smoke worker'
  ])
  if (!raw || internalNames.has(normalized)) return t('voice.canvas.nodeFallback', { index: index + 1 })
  return raw
}

function isDuplicateTaskDraftWidget(widget: VoiceWidget): boolean {
  const marker = `${widget.id} ${widget.title}`.toLowerCase()
  return (
    marker.includes('task-draft') ||
    marker.includes('task_draft') ||
    widget.title.trim() === '任务草稿' ||
    widget.title.trim() === '任務草稿'
  )
}

function widgetUiState(widget: VoiceWidget): string {
  const value = widget.data?.ui_state
  return typeof value === 'string' ? value : 'visible'
}

function isWidgetMinimized(widget: VoiceWidget): boolean {
  return widgetUiState(widget) === 'minimized'
}

function isArtifactWidget(widget: VoiceWidget): boolean {
  return widget.type === 'artifact'
}

function dedupeArtifactWidgets(widgets: VoiceWidget[]): VoiceWidget[] {
  const byIdentity = new Map<string, VoiceWidget>()
  for (const widget of widgets) {
    const identity = artifactWidgetIdentity(widget)
    const existing = byIdentity.get(identity)
    if (!existing || artifactWidgetQuality(widget) > artifactWidgetQuality(existing)) {
      byIdentity.set(identity, widget)
    }
  }
  return Array.from(byIdentity.values())
}

function dedupeXiaohongshuWidgets(widgets: VoiceWidget[]): VoiceWidget[] {
  const result: VoiceWidget[] = []
  const byIdentity = new Map<string, number>()
  for (const widget of widgets) {
    if (!isXiaohongshuWidget(widget)) {
      result.push(widget)
      continue
    }
    const identity = xiaohongshuWidgetIdentity(widget)
    const existingIndex = byIdentity.get(identity)
    if (existingIndex === undefined) {
      byIdentity.set(identity, result.length)
      result.push(widget)
      continue
    }
    if (xiaohongshuWidgetQuality(widget) > xiaohongshuWidgetQuality(result[existingIndex])) {
      result[existingIndex] = widget
    }
  }
  return result
}

function xiaohongshuWidgetIdentity(widget: VoiceWidget): string {
  return widgetArtifactKey(widget) || `widget:${widget.id}`
}

function xiaohongshuWidgetQuality(widget: VoiceWidget): number {
  const title = cleanInlineText(widget.data?.title || widget.title, 120)
  const body = cleanInlineText(widget.data?.body || widget.body, 320)
  const author =
    widget.data?.author && typeof widget.data.author === 'object'
      ? cleanInlineText((widget.data.author as Record<string, unknown>).nickname, 80)
      : ''
  const tags = Array.isArray(widget.data?.tags) ? widget.data.tags.length : 0
  const genericTitle = /^(小红书图文产物|小紅書圖文產物|小红书笔记|小紅書筆記|artifact)$/i.test(title)
  return (
    (genericTitle ? 0 : 100) +
    Math.min(body.length, 160) +
    Math.min(tags * 3, 15) +
    (author && author !== 'AI 助手' ? 8 : 0)
  )
}

function widgetArtifactKey(widget: VoiceWidget): string {
  const runId = widgetDataString(widget, 'run_id')
  const artifactId = widgetDataString(widget, 'artifact_id')
  if (runId && artifactId) return `${runId}:${artifactId}`
  const previewUrl = widgetDataString(widget, 'preview_url') || artifactPreviewUrl(widget)
  const previewKey = artifactKeyFromPath(previewUrl)
  if (previewKey) return previewKey
  return artifactKeyFromPath(
    widgetDataString(widget, 'path') || widgetDataString(widget, 'artifact_path')
  )
}

function artifactKeyFromPath(value: string): string {
  const match = value.match(/\/artifacts\/([^/]+)\/([^/]+)/)
  if (!match) return ''
  return `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}`
}

function artifactWidgetIdentity(widget: VoiceWidget): string {
  const localPath = artifactLocalPath(widget)
  if (localPath) return `path:${localPath}`
  const previewUrl = artifactPreviewUrl(widget)
  if (previewUrl) return `url:${previewUrl}`
  const artifactId = widgetDataString(widget, 'artifact_id') || widgetDataString(widget, 'id')
  if (artifactId) return `artifact:${artifactId}`
  return `widget:${widget.id}`
}

function artifactWidgetQuality(widget: VoiceWidget): number {
  const title = widget.title.trim().toLowerCase()
  const body = widget.body?.trim() || ''
  let score = 0
  if (title && title !== 'artifact') score += 10
  if (artifactPreviewUrl(widget)) score += 4
  if (body && !body.startsWith('/') && !body.includes('/voice_agent_sdk/')) score += 3
  if (widget.status && widget.status !== 'available') score += 1
  return score
}

function widgetDataString(widget: VoiceWidget, key: string): string {
  const value = widget.data?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function cleanInlineText(value: unknown, limit = 120): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function widgetLayoutHeight(
  widget: VoiceWidget,
  fallback: 'full' | 'half' = 'full'
): 'full' | 'half' {
  const value = (
    widgetDataString(widget, 'height') ||
    widgetDataString(widget, 'layout') ||
    widgetDataString(widget, 'size')
  ).toLowerCase()
  if (['half', 'compact', 'top', 'bottom'].includes(value)) return 'half'
  if (['full', 'tall', 'large', 'span2'].includes(value)) return 'full'
  return fallback
}

function widgetLayoutSlot(widget: VoiceWidget): 'top' | 'bottom' | 'auto' {
  const value = (
    widgetDataString(widget, 'slot') ||
    widgetDataString(widget, 'row') ||
    widgetDataString(widget, 'position')
  ).toLowerCase()
  if (['top', 'upper', '1', 'row1'].includes(value)) return 'top'
  if (['bottom', 'lower', '2', 'row2'].includes(value)) return 'bottom'
  return 'auto'
}

function widgetLayoutWidth(widget: VoiceWidget): 1 | 2 | 3 {
  const value = (
    widgetDataString(widget, 'width') ||
    widgetDataString(widget, 'columns') ||
    widgetDataString(widget, 'span')
  ).toLowerCase()
  if (['3', 'full', 'wide3', 'triple'].includes(value)) return 3
  if (['2', 'wide', 'double', 'span2'].includes(value)) return 2
  return 1
}

function voiceGridItemStyle(
  widget: VoiceWidget,
  fallback: 'full' | 'half' = 'full'
): Record<string, string> {
  const width = widgetLayoutWidth(widget)
  if (isSlideDeckWidget(widget) && !isPhonePortrait.value && !isCompactPhoneLandscape.value)
    return { gridRow: '1 / span 3', gridColumn: '1 / span 3' }
  if (isXiaohongshuWidget(widget) && !isPhonePortrait.value && !isCompactPhoneLandscape.value)
    return { gridRow: '1 / span 2', gridColumn: 'auto / span 1' }
  if (widget.type === 'topic_outline' && !isPhonePortrait.value && !isCompactPhoneLandscape.value)
    return { gridRow: '1 / span 2', gridColumn: 'auto / span 2' }
  if (
    width > 1 &&
    !isPhonePortrait.value &&
    !isCompactPhoneLandscape.value
  ) {
    return { gridRow: '1 / span 2', gridColumn: `auto / span ${width}` }
  }
  if (widgetLayoutHeight(widget, fallback) === 'full') return { gridRow: '1 / span 2' }
  const slot = widgetLayoutSlot(widget)
  if (slot === 'top') return { gridRow: '1 / span 1' }
  if (slot === 'bottom') return { gridRow: '2 / span 1' }
  return { gridRow: 'span 1' }
}

function fullGridItemStyle(): Record<string, string> {
  return { gridRow: '1 / span 2' }
}

function executionGridItemStyle(): Record<string, string> {
  if (isPhonePortrait.value || isCompactPhoneLandscape.value) return fullGridItemStyle()
  return { gridRow: '1 / span 2', gridColumn: 'auto / span 1' }
}

function isWidgetHighlighted(widgetId: string): boolean {
  return highlightedWidgetIds.value.has(widgetId)
}

function artifactPreviewUrl(widget: VoiceWidget): string {
  const explicit = widgetDataString(widget, 'preview_url') || widgetDataString(widget, 'url')
  const localPath = artifactLocalPath(widget)
  const localPreview = voiceAgentArtifactPreviewUrl(localPath)
  if (explicit && !isArtifactUrlAbsolute(explicit)) {
    return artifactUrlFromValue(explicit, localPath)
  }
  if (
    localPreview &&
    looksLikeImageArtifact(localPath) &&
    explicit &&
    !looksLikeImageArtifact(explicit)
  ) {
    return localPreview
  }
  if (
    explicit.startsWith('http://') ||
    explicit.startsWith('https://') ||
    explicit.startsWith('/api/') ||
    explicit.startsWith('/artifacts/')
  )
    return explicit
  if (localPreview) return localPreview
  const sessionId = workspace.value?.session_id || ''
  if (sessionId && localPath) {
    const marker = `/voice_agent_sdk/${sessionId}/`
    const markerIndex = localPath.indexOf(marker)
    if (markerIndex >= 0) {
      const relative = localPath.slice(markerIndex + marker.length).replace(/^\/+/, '')
      if (relative === 'index.html')
        return `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/artifacts/preview`
      if (relative) {
        const encoded = relative
          .split('/')
          .map(part => encodeURIComponent(part))
          .join('/')
        return `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/artifacts/${encoded}`
      }
    }
  }
  if (localPath) {
    const runMarker = '/manager/runs/'
    const runMarkerIndex = localPath.indexOf(runMarker)
    if (runMarkerIndex >= 0) {
      const parts = localPath
        .slice(runMarkerIndex + runMarker.length)
        .replace(/^\/+/, '')
        .split('/')
      if (parts.length >= 3 && parts[1] === 'artifacts') {
        return `/artifacts/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[2])}/preview`
      }
    }
  }
  const runId = widgetDataString(widget, 'run_id') || workspace.value?.manager_run_id || ''
  const artifactId = widgetDataString(widget, 'artifact_id') || widgetDataString(widget, 'id')
  if (!runId || !artifactId) return ''
  return `/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(artifactId)}/preview`
}

function artifactUrlFromValue(value: string, basePath = ''): string {
  const clean = value.trim()
  if (!clean) return ''
  if (isArtifactUrlAbsolute(clean)) return clean
  if (!clean.startsWith('/')) {
    const relative = artifactRelativePath(clean, basePath)
    if (relative) return voiceAgentArtifactRelativeUrl(relative)
  }
  return voiceAgentArtifactPreviewUrl(clean) || clean
}

function isArtifactUrlAbsolute(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/api/') ||
    value.startsWith('/artifacts/')
  )
}

function artifactRelativePath(value: string, basePath: string): string {
  const clean = value.replace(/^\.?\//, '').replace(/^\/+/, '')
  if (!clean) return ''
  const sessionId = workspace.value?.session_id || ''
  if (!sessionId) return ''
  const baseRelative = voiceAgentArtifactRelativePath(basePath)
  if (!baseRelative) return clean
  const baseName = baseRelative.split('/').filter(Boolean).pop() || ''
  if (baseName && clean === baseName) return clean
  if (baseName && clean.startsWith(`${baseName}/`)) return clean
  if (looksLikeImageArtifact(basePath)) {
    const parent = baseRelative.split('/').slice(0, -1).join('/')
    return parent ? `${parent}/${clean}` : clean
  }
  return `${baseRelative.replace(/\/+$/, '')}/${clean}`
}

function artifactLocalPath(widget: VoiceWidget): string {
  return (
    widgetDataString(widget, 'path') ||
    widgetDataString(widget, 'artifact_path') ||
    widget.body?.trim() ||
    ''
  )
}

function artifactGalleryImages(widget: VoiceWidget): string[] {
  const raw = widget.data?.gallery_images || widget.data?.images
  if (!Array.isArray(raw)) return []
  const basePath = artifactLocalPath(widget)
  return raw
    .map(item => (typeof item === 'string' ? artifactUrlFromValue(item, basePath) : ''))
    .filter(Boolean)
}

function voiceAgentArtifactPreviewUrl(localPath: string): string {
  const relative = voiceAgentArtifactRelativePath(localPath)
  if (relative === 'index.html')
    return `/api/voice-agent/sessions/${encodeURIComponent(workspace.value?.session_id || '')}/artifacts/preview`
  if (relative) return voiceAgentArtifactRelativeUrl(relative)
  return ''
}

function voiceAgentArtifactRelativePath(localPath: string): string {
  const sessionId = workspace.value?.session_id || ''
  if (sessionId && localPath) {
    const marker = `/voice_agent_sdk/${sessionId}/`
    const markerIndex = localPath.indexOf(marker)
    if (markerIndex >= 0) {
      return localPath.slice(markerIndex + marker.length).replace(/^\/+/, '')
    }
  }
  return ''
}

function voiceAgentArtifactRelativeUrl(relative: string): string {
  const sessionId = workspace.value?.session_id || ''
  if (!sessionId || !relative) return ''
  const encoded = relative
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/')
  return `/api/voice-agent/sessions/${encodeURIComponent(sessionId)}/artifacts/${encoded}`
}

function artifactPreviewKind(widget: VoiceWidget): ArtifactPreviewKind {
  const explicitKind = String(widget.data?.preview_kind || '').toLowerCase()
  if (explicitKind === 'gallery' || explicitKind === 'image' || explicitKind === 'html')
    return explicitKind
  if (artifactGalleryImages(widget).length > 1) return 'gallery'
  const mediaHints = [
    widgetDataString(widget, 'media_type'),
    widgetDataString(widget, 'mime_type'),
    widgetDataString(widget, 'content_type'),
    widgetDataString(widget, 'artifact_type'),
    widgetDataString(widget, 'kind'),
    widgetDataString(widget, 'file_type')
  ].map(value => value.toLowerCase())
  if (mediaHints.some(value => value === 'image' || value.startsWith('image/'))) return 'image'
  if (looksLikeImageArtifact(artifactPreviewUrl(widget))) return 'image'
  if (looksLikeImageArtifact(widgetDataString(widget, 'path'))) return 'image'
  if (looksLikeImageArtifact(widgetDataString(widget, 'artifact_path'))) return 'image'
  if (looksLikeImageArtifact(widget.body || '')) return 'image'
  return 'html'
}

function artifactDisplayBody(widget: VoiceWidget): string {
  const label = widgetDataString(widget, 'label') || widgetDataString(widget, 'description')
  if (label) return label
  const raw =
    widget.body?.trim() ||
    widgetDataString(widget, 'path') ||
    widgetDataString(widget, 'artifact_path')
  if (!raw) return ''
  const looksLocal =
    raw.startsWith('/home/') ||
    raw.startsWith('~/.homerail/') ||
    raw.startsWith('~/.omni/') ||
    raw.startsWith('file:') ||
    raw.startsWith('/') ||
    raw.includes('/voice_agent_sdk/') ||
    raw.includes('/.homerail/') ||
    raw.includes('/.omni/')
  if (looksLocal) {
    const preview = artifactPreviewUrl(widget)
    if (preview) return preview
    return ''
  }
  return raw
}

function looksLikeImageArtifact(value: string): boolean {
  const clean = value.trim().split(/[?#]/)[0].toLowerCase()
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)$/.test(clean)
}

function artifactPreviewLayout(widget: VoiceWidget, url: string): ArtifactPreviewLayout {
  const explicit = String(widget.data?.preview_layout || widget.data?.layout || '').toLowerCase()
  if (explicit === 'portrait' || explicit === 'fluid') return explicit
  if (isXiaohongshuWidget(widget) || /\/xhs-[^/]+\/|xiaohongshu|rednote/i.test(url))
    return 'portrait'
  return 'fluid'
}

function openArtifactPreview(widget: VoiceWidget): void {
  const url = artifactPreviewUrl(widget)
  if (!url) return
  const images = artifactGalleryImages(widget)
  const kind = images.length > 1 ? 'gallery' : artifactPreviewKind(widget)
  artifactPreviewImageIndex.value = 0
  artifactPreviewModal.value = {
    title: widget.title || 'Artifact',
    url,
    kind,
    layout: artifactPreviewLayout(widget, url),
    images: images.length ? images : undefined
  }
}

function openWidgetPreview(payload: WidgetPreviewRequest): void {
  const url = payload.url.trim()
  if (!url) return
  const kind = payload.kind || (looksLikeImageArtifact(url) ? 'image' : 'html')
  const images = (payload.images || []).map(image => image.trim()).filter(Boolean)
  artifactPreviewImageIndex.value = Math.max(0, images.indexOf(url))
  artifactPreviewModal.value = {
    title: payload.title?.trim() || 'Artifact',
    url,
    kind,
    layout:
      payload.layout || (/\/xhs-[^/]+\/|xiaohongshu|rednote/i.test(url) ? 'portrait' : 'fluid'),
    images
  }
}

function closeArtifactPreview(): void {
  artifactPreviewModal.value = null
  artifactPreviewImageIndex.value = 0
}

function showArtifactPreviewImage(index: number): void {
  if (!artifactPreviewImages.value.length) return
  artifactPreviewImageIndex.value = Math.min(
    Math.max(index, 0),
    artifactPreviewImages.value.length - 1
  )
}

function prevArtifactPreviewImage(): void {
  showArtifactPreviewImage(artifactPreviewImageIndex.value - 1)
}

function nextArtifactPreviewImage(): void {
  showArtifactPreviewImage(artifactPreviewImageIndex.value + 1)
}

function widgetSurface(widget: VoiceWidget): 'task' | 'execution' {
  if (isArtifactWidget(widget)) return 'execution'
  const explicit = widget.data?.surface
  if (explicit === 'task' || explicit === 'execution') return explicit
  const marker = `${widget.id} ${widget.title} ${widget.type}`.toLowerCase()
  if (
    marker.includes('dag') ||
    marker.includes('run') ||
    marker.includes('issue') ||
    marker.includes('orchestrator') ||
    marker.includes('提交') ||
    marker.includes('执行') ||
    marker.includes('執行')
  ) {
    return 'execution'
  }
  return 'task'
}

function isAgentDagSignalWidget(widget: VoiceWidget): boolean {
  if (
    widget.id === 'dag-progress' ||
    widget.id === 'manager-status' ||
    widget.id === 'manager-progress'
  )
    return false
  const data = widget.data ?? {}
  const visual = String(data.visual || '').toLowerCase()
  const surface = String(data.surface || '').toLowerCase()
  const runId = widgetDataString(widget, 'run_id')
  const sameRun =
    !runId || !workspace.value?.manager_run_id || runId === workspace.value.manager_run_id
  if (!sameRun) return false
  const marker = `${widget.id} ${widget.type} ${widget.title}`.toLowerCase()
  return (
    widget.type === 'dag_flow' ||
    visual === 'dag_flow' ||
    (surface === 'execution' && (marker.includes('dag') || marker.includes('run')))
  )
}

function isSlideDeckWidget(widget: VoiceWidget): boolean {
  return (
    widget.type === 'slide_deck' || String(widget.data?.visual || '').toLowerCase() === 'slide_deck'
  )
}

function isXiaohongshuWidget(widget: VoiceWidget): boolean {
  return (
    widget.type === 'xiaohongshu_note' ||
    String(widget.data?.visual || '').toLowerCase() === 'xiaohongshu_note'
  )
}

function resetSubmittedTranscriptClear(): void {
  transcriptClearPending = false
  transcriptSubmittedAssistantIds = new Set()
}

function markTranscriptSubmitted(): void {
  transcriptClearPending = true
  transcriptSubmittedAssistantIds = new Set(
    (workspace.value?.conversation ?? [])
      .filter(item => item.role === 'assistant')
      .map(item => item.id)
  )
  spokenText.value = ''
}

function clearSubmittedTranscript(): void {
  if (!transcriptClearPending) return
  liveTranscript.value = ''
  lastUserTranscript.value = ''
  resetSubmittedTranscriptClear()
}

function clearSubmittedTranscriptOnAssistant(
  nextWorkspace: VoiceWorkspace | null | undefined
): void {
  if (!transcriptClearPending) return
  const hasNewAssistant = (nextWorkspace?.conversation ?? []).some(
    item =>
      item.role === 'assistant' && item.text.trim() && !transcriptSubmittedAssistantIds.has(item.id)
  )
  if (hasNewAssistant) clearSubmittedTranscript()
}

async function refreshWorkspace(): Promise<void> {
  const sessionId = workspace.value?.session_id
  if (!sessionId) return
  try {
    const res = await getVoiceSession(sessionId)
    workspace.value = res.data
    clearSubmittedTranscriptOnAssistant(workspace.value)
    rememberSpokenAssistantMessages(workspace.value)
  } catch {}
}

function applyStatusFocus(): void {
  if (statusFocusApplied) return
  const hasStatusSurface = Boolean(dagProgressWidget.value || workspace.value?.manager_run_id)
  if (!hasStatusSurface) return
  detailsOpen.value = false
  statusFocusApplied = true
}

async function refreshManagerStatus(): Promise<void> {
  const sessionId = workspace.value?.session_id
  if (!sessionId || !workspace.value) return
  if (workspaceTerminal.value) return
  if (!workspace.value.manager_session_id && !workspace.value.manager_run_id) {
    const shouldRefreshWorkspace = Boolean(dagProgressWidget.value)
    if (!shouldRefreshWorkspace) return
    await refreshWorkspace()
    applyStatusFocus()
    if (!workspace.value?.manager_session_id && !workspace.value?.manager_run_id) return
  }
  try {
    const res = await refreshVoiceManagerStatus(sessionId)
    workspace.value = res.data.workspace
    clearSubmittedTranscriptOnAssistant(workspace.value)
    queueNewAssistantSpeech(workspace.value)
    const runId = res.data.manager_status?.manager_run_id || workspace.value.manager_run_id
    if (runId) store.setRunId(runId)
    applyStatusFocus()
  } catch (err: any) {
    recordDebug('manager_status_refresh_failed', err?.message || 'Manager 状态刷新失败', 'warning')
  }
}

async function loadCodexModelCatalog(): Promise<void> {
  codexModelsLoading.value = true
  codexModelsError.value = ''
  try {
    const response = await getCodexModels()
    codexModels.value = response.data?.models ?? []
    codexModelsLoaded.value = true
    if (!codexModels.value.length) {
      codexModelsError.value = 'No Codex models are available for the current account'
    }
  } catch (err: any) {
    codexModelsLoaded.value = false
    codexModelsError.value = err?.message || 'Codex models unavailable'
  } finally {
    codexModelsLoading.value = false
  }
}

async function loadVoiceRuntime(): Promise<void> {
  asrLoading.value = true
  voiceConfigError.value = ''
  try {
    await store.loadManagerRuntimeOptions()
    const [settingsRes, voiceAgentRes] = await Promise.all([
      getVoiceSettings(),
      getVoiceAgentConfig().catch(() => null),
      loadCodexModelCatalog()
    ])
    voiceSettings.value = settingsRes.data
    voiceAgentConfig.value = voiceAgentRes?.data ?? null
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.errors.settingsLoad')
  } finally {
    asrLoading.value = false
  }
}

function voiceSettingsPayload(
  overrides: Partial<UpdateVoiceSettingsRequest> = {}
): UpdateVoiceSettingsRequest | null {
  if (!voiceSettings.value) return null
  return {
    recognition_mode: recognitionMode.value,
    omni_base_url: voiceSettings.value.omni_base_url,
    omni_model: voiceSettings.value.omni_model,
    omni_llm_setting_id: voiceSettings.value.omni_llm_setting_id || null,
    omni_token: null,
    llm_base_url: voiceSettings.value.llm_base_url,
    llm_model: voiceSettings.value.llm_model,
    llm_setting_id: voiceSettings.value.llm_setting_id || null,
    llm_token: null,
    asr_base_url: voiceSettings.value.asr_base_url,
    asr_realtime_url: voiceSettings.value.asr_realtime_url,
    asr_model: voiceSettings.value.asr_model,
    asr_llm_setting_id: voiceSettings.value.asr_llm_setting_id || null,
    asr_token: null,
    tts_base_url: voiceSettings.value.tts_base_url,
    tts_model: voiceSettings.value.tts_model,
    tts_llm_setting_id: voiceSettings.value.tts_llm_setting_id || null,
    tts_voice: voiceSettings.value.tts_voice,
    tts_speed: voiceSettings.value.tts_speed,
    tts_token: null,
    tts_stream: voiceSettings.value.tts_stream,
    tts_output_channels: voiceSettings.value.tts_output_channels?.length
      ? voiceSettings.value.tts_output_channels
      : ['commentary', 'final'],
    ...overrides
  }
}

function isMimoTts(model: string, baseUrl = ''): boolean {
  return (
    model.startsWith('mimo-v2.5-tts') ||
    (baseUrl.includes('xiaomimimo.com') && model.includes('tts'))
  )
}

function isQwen3Tts(model: string): boolean {
  return model === 'qwen3-tts'
}

function ttsDefaultsFor(setting: {
  model_name: string
  provider_base_url?: string | null
  protocol?: string
  voice_adapter?: string
  tts_voice?: string | null
}): Partial<UpdateVoiceSettingsRequest> {
  const baseUrl = setting.provider_base_url || voiceSettings.value?.tts_base_url || ''
  if (isArkVoiceSetting(setting)) {
    return {
      tts_voice: setting.tts_voice || 'zh_female_vv_uranus_bigtts',
      tts_speed: null,
      tts_stream: false
    }
  }
  if (isMimoTts(setting.model_name, baseUrl)) {
    return { tts_voice: 'mimo_default', tts_speed: null, tts_stream: false }
  }
  if (isQwen3Tts(setting.model_name)) {
    return { tts_voice: 'serena', tts_speed: null, tts_stream: false }
  }
  return {}
}

async function changeOmniModel(event: Event): Promise<void> {
  const settingId = (event.target as HTMLSelectElement).value
  const setting = omniModelOptions.value.find(item => item.id === settingId)
  if (!setting || settingId === selectedOmniModelId.value) return
  const payload = voiceSettingsPayload({
    recognition_mode: 'omni',
    omni_base_url: setting.provider_base_url || voiceSettings.value?.omni_base_url || '',
    omni_model: setting.model_name,
    omni_llm_setting_id: setting.id
  })
  if (!payload) return
  asrSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceSettings(payload)
    voiceSettings.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.saveFailed')
  } finally {
    asrSaving.value = false
  }
}

async function changeLlmModel(event: Event): Promise<void> {
  const settingId = (event.target as HTMLSelectElement).value
  const setting = llmModelOptions.value.find(item => item.id === settingId)
  if (!voiceSettings.value || !setting || settingId === selectedLlmModelId.value) return
  asrSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceSettings(
      voiceSettingsPayload({
        llm_base_url: setting.provider_base_url || voiceSettings.value.llm_base_url,
        llm_model: setting.model_name,
        llm_setting_id: setting.id
      })!
    )
    voiceSettings.value = res.data
    await syncVoiceAgentLlmConfig(setting.id, setting.provider_id, setting.model_name)
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.saveFailed')
  } finally {
    asrSaving.value = false
  }
}

async function setVoiceAgentHarness(harness: VoiceAgentConfig['harness']): Promise<void> {
  if (voiceAgentConfig.value?.harness === harness) return
  if (harness === 'codex_appserver' && !selectedCodexModel.value) {
    voiceConfigError.value = t('voice.model.noAvailableCodex')
    return
  }
  voiceAgentSaving.value = true
  voiceConfigError.value = ''
  try {
    const selectableSettings =
      harness === 'kimi_code'
        ? llmModelOptions.value.filter(isKimiCodeCompatibleSetting)
        : harness === 'claude_agent_sdk'
          ? llmModelOptions.value
          : []
    const llmSetting =
      selectableSettings.find(item => item.id === selectedLlmModelId.value) ??
      selectableSettings.find(item => item.id === voiceAgentConfig.value?.llm_setting_id) ??
      selectableSettings[0]
    const res = await updateVoiceAgentConfig({
      harness,
      llm_setting_id:
        harness === 'codex_appserver'
          ? null
          : harness === 'claude_agent_sdk' || harness === 'kimi_code'
            ? llmSetting?.id || null
            : voiceAgentConfig.value?.llm_setting_id || null,
      provider_name:
        harness === 'codex_appserver'
          ? null
          : harness === 'claude_agent_sdk' || harness === 'kimi_code'
            ? llmSetting?.provider_id || (harness === 'kimi_code' ? 'kimi' : null)
            : voiceAgentConfig.value?.provider_name || null,
      model_name:
        harness === 'codex_appserver'
          ? selectedCodexModel.value
          : llmSetting?.model_name ||
            voiceAgentConfig.value?.model_name ||
            null,
      reasoning_effort:
        harness === 'codex_appserver'
          ? resolveCodexReasoningEffortForModel(
              codexModels.value,
              selectedCodexModel.value,
              codexReasoningEffort.value
            )
          : voiceAgentConfig.value?.reasoning_effort,
      service_tier:
        harness === 'codex_appserver'
          ? resolveCodexServiceTierForModel(
              codexModels.value,
              selectedCodexModel.value,
              codexServiceTier.value
            )
          : voiceAgentConfig.value?.service_tier,
      session_policy:
        harness === 'codex_appserver'
          ? {
              ...(voiceAgentConfig.value?.session_policy ?? {}),
              persist_sdk_client: false,
              repair_attempts: 0
            }
          : (voiceAgentConfig.value?.session_policy ?? {})
    })
    voiceAgentConfig.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.managerSaveFailed')
  } finally {
    voiceAgentSaving.value = false
  }
}

function changeVoiceAgentHarness(event: Event): void {
  void setVoiceAgentHarness(
    (event.target as HTMLSelectElement).value as VoiceAgentConfig['harness']
  )
}

async function setCodexReasoningEffort(reasoningEffort: CodexReasoningEffort): Promise<void> {
  if (!selectedCodexModel.value || configuredCodexModelUnavailable.value) return
  voiceAgentSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceAgentConfig({
      harness: 'codex_appserver',
      model_name: selectedCodexModel.value,
      reasoning_effort: reasoningEffort
    })
    voiceAgentConfig.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.reasoningSaveFailed')
  } finally {
    voiceAgentSaving.value = false
  }
}

function handleCodexReasoningEffortChange(event: Event): void {
  void setCodexReasoningEffort((event.target as HTMLSelectElement).value as CodexReasoningEffort)
}

async function setCodexServiceTier(serviceTier: string): Promise<void> {
  if (!selectedCodexModel.value || configuredCodexModelUnavailable.value) return
  voiceAgentSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceAgentConfig({
      harness: 'codex_appserver',
      model_name: selectedCodexModel.value,
      service_tier: serviceTier || null
    })
    voiceAgentConfig.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.serviceTierSaveFailed')
  } finally {
    voiceAgentSaving.value = false
  }
}

function handleCodexServiceTierChange(event: Event): void {
  void setCodexServiceTier((event.target as HTMLSelectElement).value)
}

async function setCodexModel(model: string): Promise<void> {
  if (!model || voiceAgentConfig.value?.model_name === model) return
  voiceAgentSaving.value = true
  voiceConfigError.value = ''
  try {
    const reasoningEffort = resolveCodexReasoningEffortForModel(
      codexModels.value,
      model,
      codexReasoningEffort.value
    )
    const serviceTier = resolveCodexServiceTierForModel(
      codexModels.value,
      model,
      codexServiceTier.value
    )
    const response = await updateVoiceAgentConfig({
      harness: 'codex_appserver',
      llm_setting_id: null,
      provider_name: null,
      model_name: model,
      reasoning_effort: reasoningEffort,
      service_tier: serviceTier
    })
    voiceAgentConfig.value = response.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.saveFailed')
  } finally {
    voiceAgentSaving.value = false
  }
}

function handleCodexModelChange(event: Event): void {
  void setCodexModel((event.target as HTMLSelectElement).value)
}

async function syncVoiceAgentLlmConfig(
  settingId: string,
  providerId: string,
  modelName: string
): Promise<void> {
  if (
    voiceAgentConfig.value?.harness !== 'claude_agent_sdk' &&
    voiceAgentConfig.value?.harness !== 'kimi_code'
  ) return
  const setting = llmModelOptions.value.find(item => item.id === settingId)
  if (voiceAgentConfig.value?.harness === 'kimi_code' && (!setting || !isKimiCodeCompatibleSetting(setting))) return
  const current = voiceAgentConfig.value
  if (
    current.llm_setting_id === settingId &&
    current.provider_name === providerId &&
    current.model_name === modelName
  )
    return
  const res = await updateVoiceAgentConfig({
    harness: voiceAgentConfig.value.harness,
    llm_setting_id: settingId,
    provider_name: providerId,
    model_name: modelName
  })
  voiceAgentConfig.value = res.data
}

async function changeAsrModel(event: Event): Promise<void> {
  const settingId = (event.target as HTMLSelectElement).value
  const setting = asrModelOptions.value.find(item => item.id === settingId)
  if (!voiceSettings.value || !setting || settingId === selectedAsrModelId.value) return
  asrSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceSettings(
      voiceSettingsPayload({
        recognition_mode: 'asr',
        asr_base_url: setting.provider_base_url || voiceSettings.value.asr_base_url,
        asr_model: setting.model_name,
        asr_llm_setting_id: setting.id
      })!
    )
    voiceSettings.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.saveFailed')
  } finally {
    asrSaving.value = false
  }
}

async function changeTtsModel(event: Event): Promise<void> {
  const settingId = (event.target as HTMLSelectElement).value
  const setting = ttsModelOptions.value.find(item => item.id === settingId)
  if (!voiceSettings.value || !setting || settingId === selectedTtsModelId.value) return
  ttsSaving.value = true
  voiceConfigError.value = ''
  try {
    const res = await updateVoiceSettings(
      voiceSettingsPayload({
        tts_base_url: setting.provider_base_url || voiceSettings.value.tts_base_url,
        tts_model: setting.model_name,
        tts_llm_setting_id: setting.id,
        ...ttsDefaultsFor(setting)
      })!
    )
    voiceSettings.value = res.data
  } catch (err: any) {
    voiceConfigError.value = err?.message || t('voice.model.saveFailed')
  } finally {
    ttsSaving.value = false
  }
}

async function changeVoiceModel(event: Event): Promise<void> {
  if (recognitionMode.value === 'asr') await changeAsrModel(event)
  else await changeOmniModel(event)
}

function applyStreamWorkspace(
  nextWorkspace: VoiceWorkspace | undefined,
  // optimisticId 历史上用于按 id 移除 optimistic 消息，现已废弃：
  // conversationItems 的 computed 已通过 role+text 去重保证 persisted
  // 追上后 optimistic 自动消失。提前按 id 移除会在 persisted 尚未包含
  // 该消息时造成列表闪烁（先消失再出现）。参数保留只为兼容调用链。
  _optimisticId?: string
): void {
  if (!nextWorkspace) return
  workspace.value = nextWorkspace
  clearSubmittedTranscriptOnAssistant(workspace.value)
  const runId = workspace.value.manager_run_id
  if (runId) store.setRunId(runId)
  applyStatusFocus()
}

async function handleVoiceStreamEvent(
  event: VoiceStreamEvent,
  optimisticId?: string
): Promise<'confirm' | null> {
  if (event.type === 'generative_ui') {
    await generativeUiShadowPreviewRef.value?.acceptStreamEvent(event as GenerativeUiStreamEventV1)
    return null
  }
  if (event.type === 'workspace') {
    applyStreamWorkspace((event as { workspace?: VoiceWorkspace }).workspace, optimisticId)
    return null
  }
  if (event.type === 'speech') {
    const payload = event as { workspace?: VoiceWorkspace; event?: VoiceSpeechEvent }
    applyStreamWorkspace(payload.workspace, optimisticId)
    if (payload.event) {
      if (payload.event.text?.trim()) clearSubmittedTranscript()
      rememberSpeechEvents([payload.event])
      enqueueSpeechEvent(payload.event)
    }
    return null
  }
  if (event.type === 'done') {
    const payload = event as {
      workspace?: VoiceWorkspace
      spoken_text?: string
      voice_events?: VoiceSpeechEvent[]
      suggested_action?: 'confirm' | null
    }
    applyStreamWorkspace(payload.workspace, optimisticId)
    const explicitVoiceEvents = (payload.voice_events || []).filter(speechEvent =>
      speechEvent.text?.trim()
    )
    if (
      payload.spoken_text?.trim() ||
      explicitVoiceEvents.length ||
      payload.workspace?.conversation?.some(
        item =>
          item.role === 'assistant' &&
          item.text.trim() &&
          !spokenAssistantMessageIds.value.has(item.id)
      )
    ) {
      clearSubmittedTranscript()
    }
    spokenText.value = payload.spoken_text || spokenText.value
    if (explicitVoiceEvents.length) {
      rememberSpeechEvents(explicitVoiceEvents)
      for (const speechEvent of explicitVoiceEvents) enqueueSpeechEvent(speechEvent)
    } else {
      queueNewAssistantSpeech(payload.workspace)
    }
    if (
      managerStatusWidget.value ||
      dagProgressWidget.value ||
      workspace.value?.manager_session_id ||
      workspace.value?.manager_run_id
    ) {
      void refreshManagerStatus()
    }
    return payload.suggested_action === 'confirm' ? 'confirm' : null
  }
  if (event.type === 'error') {
    const payload = event as { workspace?: VoiceWorkspace; message?: string }
    applyStreamWorkspace(payload.workspace, optimisticId)
    throw new Error(payload.message || t('voice.errors.assistant'))
  }
  return null
}

async function sendText(text: string, optimisticItemId?: string): Promise<void> {
  if (!workspace.value || !text || loading.value) return
  const selectedNodeId = selectedGenerativeUiNodeId.value || null
  if (listening.value) closeVoiceInputAfterSubmit()
  // 若调用方已提前 append 了 optimistic 消息（如文字输入为追求即时反馈），
  // 直接复用其 id；否则在这里补一条。
  const optimisticId =
    optimisticItemId ?? appendOptimisticUserMessage(text).id
  lastUserTranscript.value = text
  markTranscriptSubmitted()
  loading.value = true
  error.value = ''
  speechEventKeySeenAt = new Map()
  let suggestedAction: 'confirm' | null = null
  voiceTurnAbort?.abort()
  voiceTurnAbort = new AbortController()
  const turnSignal = voiceTurnAbort.signal
  try {
    await streamVoiceTurn(workspace.value.session_id, text, store.managerProjectId, async event => {
      suggestedAction = (await handleVoiceStreamEvent(event, optimisticId)) || suggestedAction
    }, turnSignal, selectedNodeId)
    if (suggestedAction === 'confirm') {
      loading.value = false
      await submitDraft(true)
    }
  } catch (err: any) {
    // 切换 session 时主动 abort 旧 turn 的 stream，这不是错误，静默退出。
    if (turnSignal.aborted || err?.name === 'AbortError') return
    const message = err?.message || t('voice.errors.assistant')
    error.value = message
    recordDebug('voice_turn_failed', message)
    resetSubmittedTranscriptClear()
    await refreshWorkspace()
  } finally {
    loading.value = false
  }
}

async function submitCodexTextDraft(text = codexTextDraft.value): Promise<void> {
  const clean = text.trim()
  if (!clean || codexTextSubmitting.value) return
  codexTextSubmitting.value = true
  // 提前清空输入框并立刻把消息塞进右侧记录列表，让用户得到即时反馈，
  // 而不是卡在 waitForCodexTextBridgeReady 的轮询里干等。
  codexTextDraft.value = ''
  const optimisticItem = appendOptimisticUserMessage(clean)
  try {
    await waitForCodexTextBridgeReady()
    if (!workspace.value || loading.value) throw new Error('Voice Agent workspace is not ready')
    await sendText(clean, optimisticItem.id)
  } catch (err: any) {
    // workspace 未就绪或发送失败，回滚这条 optimistic 消息，把文本还给输入框。
    optimisticConversationItems.value = optimisticConversationItems.value.filter(
      item => item.id !== optimisticItem.id
    )
    codexTextDraft.value = clean
    throw err
  } finally {
    codexTextSubmitting.value = false
  }
}

function toggleVoiceInputAssist(): void {
  voiceInputAssist.value = !voiceInputAssist.value
  saveBooleanSetting(VOICE_INPUT_ASSIST_KEY, voiceInputAssist.value)
}

function submitComposerDraft(): void {
  if (composerSubmitDisabled.value) return
  void submitCodexTextDraft()
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitComposerDraft()
  }
}

// 辅助模式下，ASR 转写结果以「追加」方式填入 composer：让用户能连说多句再统一编辑发送。
function appendAssistTranscript(text: string): void {
  const clean = text.trim()
  if (!clean) return
  const existing = codexTextDraft.value.trim()
  codexTextDraft.value = existing ? `${existing} ${clean}` : clean
}

async function waitForCodexTextBridgeReady(timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now()
  while ((!workspace.value || loading.value) && Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => window.setTimeout(resolve, 120))
  }
}

function normalizedVoiceCommand(text: string): string {
  return text.replace(/[\s，,。.!！?？；;：:]+/g, '').trim()
}

function clearCommandMatched(text: string): boolean {
  const normalized = normalizedVoiceCommand(text)
  return CLEAR_COMMANDS.some(
    command =>
      normalized === command ||
      normalized.endsWith(`当前输入${command}`) ||
      normalized.endsWith(`${command}当前输入`)
  )
}

function clearVoiceDraft(): void {
  liveTranscript.value = t('voice.composer.cleared')
  lastUserTranscript.value = ''
  spokenText.value = ''
  resetSubmittedTranscriptClear()
}

async function handleFinalTranscript(text: string): Promise<void> {
  const clean = cleanVoiceTranscript(text)
  if (!clean) return
  const now = Date.now()
  if (
    isRecentDuplicateVoiceTranscript(
      clean,
      lastSubmittedVoiceTranscriptKey,
      lastSubmittedVoiceTranscriptAt,
      now
    )
  ) {
    liveTranscript.value = clean
    lastUserTranscript.value = clean
    return
  }
  lastSubmittedVoiceTranscriptKey = normalizeVoiceTranscriptForDuplicate(clean)
  lastSubmittedVoiceTranscriptAt = now
  liveTranscript.value = clean
  lastUserTranscript.value = clean
  if (clearCommandMatched(clean)) {
    clearVoiceDraft()
    return
  }
  // 辅助输入模式：转写结果填入 composer 等待手动发送，不自动提交。
  // 与实时模式（omni）整段提交不同，asr final 到达后停在输入框，用户可修正再发。
  if (voiceInputAssist.value && recognitionMode.value === 'asr') {
    appendAssistTranscript(clean)
    stopVoiceCapture()
    return
  }
  closeVoiceInputAfterSubmit()
  await sendText(clean)
}

async function cancelDraft(): Promise<void> {
  if (!workspace.value || loading.value) return
  await sendText('取消')
}

async function submitDraft(force = false): Promise<void> {
  if (!workspace.value || !taskDraft.value || (loading.value && !force)) return
  loading.value = true
  managerSubmitting.value = true
  error.value = ''
  speechEventKeySeenAt = new Map()
  try {
    voiceTurnAbort?.abort()
    voiceTurnAbort = new AbortController()
    const turnSignal = voiceTurnAbort.signal
    await streamConfirmVoiceTask(
      workspace.value.session_id,
      confirmation.value?.id,
      store.managerProviderName,
      store.managerModelName,
      async event => {
        await handleVoiceStreamEvent(event)
      },
      turnSignal
    )
    store.hasStarted = true
    detailsOpen.value = false
    statusFocusApplied = true
    void store.fetchManagerSessions()
    void refreshManagerStatus()
  } catch (err: any) {
    // 切换 session 时主动 abort，静默退出。
    if (voiceTurnAbort?.signal.aborted || err?.name === 'AbortError') return
    recordDebug('manager_submit_failed', err?.message || '执行确认失败')
    await refreshWorkspace()
  } finally {
    managerSubmitting.value = false
    loading.value = false
  }
}

async function speak(text: string): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  if (!tabCanUseVoiceOutput()) {
    recordTtsDebug('tts_tab_inactive', `跳过不可见标签页语音输出：${previewSpeechText(clean)}`, 'warning')
    return
  }
  const playbackToken = ++ttsPlaybackGeneration
  broadcastVoiceActivity('speaking')
  speechActive = false
  pcmChunks = []
  spokenText.value = clean
  speaking.value = true
  try {
    recordTtsDebug(
      'tts_speech_request',
      `generation=${playbackToken} text="${previewSpeechText(clean)}"`
    )
    const response = await speechStream(clean, undefined, false)
    recordTtsDebug(
      'tts_speech_response',
      `generation=${playbackToken} status=${response.status} content-type=${response.headers.get('content-type') || ''}`
    )
    const blob = await response.blob()
    recordTtsDebug(
      'tts_blob_ready',
      `generation=${playbackToken} current=${ttsPlaybackGeneration} type=${blob.type || 'unknown'} bytes=${blob.size}`
    )
    if (playbackToken !== ttsPlaybackGeneration) {
      recordTtsDebug(
        'tts_generation_mismatch',
        `skip playback generation=${playbackToken} current=${ttsPlaybackGeneration} bytes=${blob.size}`,
        'warning'
      )
      return
    }
    recordTtsDebug(
      'tts_playback_dispatch',
      `generation=${playbackToken} native=${nativeTtsPlaybackAvailable()} bytes=${blob.size}`
    )
    await playTtsBlob(blob)
    recordTtsDebug('tts_playback_complete', `generation=${playbackToken}`)
  } catch (err: any) {
    if (err?.message === 'TTS playback cancelled') {
      recordTtsDebug('tts_speak_cancelled', `generation=${playbackToken}`, 'warning')
      return
    }
    recordTtsDebug(
      'tts_speak_failed',
      `generation=${playbackToken} ${err?.message || 'unknown error'}`,
      'warning'
    )
    voiceConfigError.value = `${t('voice.errors.tts')}: ${err?.message || t('voice.errors.unknown')}`
    throw err
  } finally {
    if (playbackToken === ttsPlaybackGeneration) speaking.value = false
  }
}

async function speakText(text: string): Promise<void> {
  await speak(text)
}

function enqueueSpeechEvent(event: VoiceSpeechEvent, source = 'stream'): boolean {
  const text = event.text?.trim()
  if (!text) return false
  if (!tabCanUseVoiceOutput()) {
    recordTtsDebug(
      'tts_enqueue_skipped',
      `source=${source} reason=tab_inactive channel=${event.channel} text="${previewSpeechText(text)}"`,
      'warning'
    )
    return false
  }
  const currentVoiceSettings = voiceSettings.value
  const enabledChannels = currentVoiceSettings?.tts_output_channels?.length
    ? currentVoiceSettings.tts_output_channels
    : ['commentary', 'final']
  if (!enabledChannels.includes(event.channel)) {
    recordTtsDebug(
      'tts_enqueue_skipped',
      `source=${source} reason=channel_disabled channel=${event.channel} text="${previewSpeechText(text)}"`
    )
    return false
  }
  const queued = { ...event, text }
  if (hasRecentVoiceSpeechEvent(speechEventKeySeenAt, queued)) {
    recordTtsDebug(
      'tts_enqueue_deduped',
      `source=${source} channel=${queued.channel} id=${queued.id || '-'} key=${createVoiceSpeechEventKey(queued)}`
    )
    return false
  }
  if (queued.channel === 'final') {
    speechEventQueue = speechEventQueue.filter(item => item.channel !== 'commentary')
  }
  const key = rememberVoiceSpeechEvent(speechEventKeySeenAt, queued)
  speechEventQueue.push(queued)
  recordTtsDebug(
    'tts_enqueue',
    `source=${source} channel=${queued.channel} id=${queued.id || '-'} key=${key} queue=${speechEventQueue.length} running=${speechQueueRunning}`
  )
  void drainSpeechQueue()
  return true
}

async function drainSpeechQueue(): Promise<void> {
  if (speechQueueRunning) {
    recordTtsDebug('tts_drain_skip', `already_running queue=${speechEventQueue.length}`)
    return
  }
  speechQueueRunning = true
  recordTtsDebug('tts_drain_start', `queue=${speechEventQueue.length}`)
  try {
    while (speechEventQueue.length) {
      const event = speechEventQueue.shift()!
      recordTtsDebug(
        'tts_drain_event',
        `channel=${event.channel} id=${event.id || '-'} remaining=${speechEventQueue.length} text="${previewSpeechText(event.text)}"`
      )
      try {
        await speakText(event.text)
      } catch (err: any) {
        recordTtsDebug(
          'tts_event_failed',
          `channel=${event.channel} id=${event.id || '-'} ${err?.message || 'TTS 输出失败'}`,
          'warning'
        )
        recordDebug(`${event.channel}_tts_failed`, err?.message || 'TTS 输出失败', 'warning')
      }
    }
  } finally {
    speechQueueRunning = false
    recordTtsDebug('tts_drain_done', `queue=${speechEventQueue.length}`)
    if (speechEventQueue.length) void drainSpeechQueue()
  }
}

function rememberSpokenAssistantMessages(nextWorkspace: VoiceWorkspace | null | undefined): void {
  const next = new Set(spokenAssistantMessageIds.value)
  for (const item of nextWorkspace?.conversation ?? []) {
    if (item.role === 'assistant') next.add(item.id)
  }
  spokenAssistantMessageIds.value = next
}

function rememberSpeechEvents(events: VoiceSpeechEvent[]): void {
  const next = new Set(spokenAssistantMessageIds.value)
  for (const event of events) {
    if (event.id) next.add(event.id)
  }
  spokenAssistantMessageIds.value = next
}

function queueNewAssistantSpeech(nextWorkspace: VoiceWorkspace | null | undefined): void {
  const candidates = (nextWorkspace?.conversation ?? []).filter(
    item =>
      isVoiceConversationMessageSpeakable(item) &&
      !spokenAssistantMessageIds.value.has(item.id) &&
      voiceConversationMessageSpeechText(item)
  )
  if (!candidates.length) return
  const next = new Set(spokenAssistantMessageIds.value)
  for (const item of candidates) next.add(item.id)
  spokenAssistantMessageIds.value = next
  const messages = candidates.filter(item => {
    const speechText = voiceConversationMessageSpeechText(item)
    const event = { channel: item.channel || 'final', text: speechText }
    if (!hasRecentVoiceSpeechEvent(speechEventKeySeenAt, event)) return true
    recordTtsDebug(
      'tts_workspace_fallback_deduped',
      `id=${item.id} key=${createVoiceSpeechEventKey(event)} text="${previewSpeechText(speechText)}"`
    )
    return false
  })
  if (!messages.length) return
  backgroundSpeechQueue = backgroundSpeechQueue
    .then(async () => {
      for (const item of messages) {
        enqueueSpeechEvent(
          {
            id: item.id,
            channel: item.channel || 'final',
            text: voiceConversationMessageSpeechText(item)
          },
          'workspace'
        )
      }
    })
    .catch((err: any) => {
      recordDebug('monitor_tts_failed', err?.message || '监控播报失败', 'warning')
    })
}

async function ensureTtsAudioContext(): Promise<AudioContext> {
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioContextCtor) throw new Error(t('voice.errors.webAudioUnsupported'))
  if (!ttsAudioContext || ttsAudioContext.state === 'closed') {
    ttsAudioContext = new AudioContextCtor()
  }
  if (ttsAudioContext.state === 'suspended') await ttsAudioContext.resume()
  return ttsAudioContext
}

async function unlockTtsPlayback(): Promise<void> {
  if (ttsPlaybackUnlocked) return
  if (isIosDevice.value) {
    await unlockTtsDomPlayback()
    ttsPlaybackUnlocked = true
    return
  }
  const ctx = await ensureTtsAudioContext()
  const source = ctx.createBufferSource()
  source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
  source.connect(ctx.destination)
  source.start(0)
  ttsPlaybackUnlocked = true
}

function prepareTtsAudioElement(): HTMLAudioElement {
  let audio = ttsAudioElement.value
  if (!audio) {
    audio = new Audio()
    ttsAudioElement.value = audio
  }
  audio.setAttribute('playsinline', '')
  audio.setAttribute('webkit-playsinline', '')
  audio.preload = 'auto'
  audio.controls = false
  audio.muted = false
  audio.volume = 1
  return audio
}

function resetTtsAudioElement(): void {
  const audio = ttsAudioElement.value
  if (!audio) return
  audio.pause()
  audio.onended = null
  audio.onerror = null
  audio.onstalled = null
  audio.removeAttribute('src')
  audio.load()
}

function cancelLocalSpeech(reason: string): void {
  const previousGeneration = ttsPlaybackGeneration
  const dropped = speechEventQueue.length
  ttsPlaybackGeneration += 1
  speechEventQueue = []
  speaking.value = false
  recordTtsDebug(
    'tts_cancelled',
    `reason=${reason} generation=${previousGeneration}->${ttsPlaybackGeneration} dropped=${dropped} running=${speechQueueRunning}`,
    reason === 'unmount' ? 'debug' : 'warning'
  )
  stopNativeTtsPlayback()
  try {
    currentTtsSource?.stop(0)
  } catch {}
  currentTtsSource = null
  const rejectAudio = currentTtsAudioReject
  currentTtsAudioReject = null
  rejectAudio?.(new Error('TTS playback cancelled'))
  resetTtsAudioElement()
}

async function unlockTtsDomPlayback(): Promise<void> {
  if (ttsDomPlaybackUnlocked) return
  const audio = prepareTtsAudioElement()
  const previousVolume = audio.volume
  try {
    audio.src = SILENT_WAV_DATA_URI
    audio.volume = 0
    audio.load()
    await audio.play()
    audio.pause()
    audio.currentTime = 0
    ttsDomPlaybackUnlocked = true
  } finally {
    audio.volume = previousVolume || 1
    audio.removeAttribute('src')
    audio.load()
  }
}

async function playTtsBlobWithAudioElement(blob: Blob): Promise<void> {
  const audio = prepareTtsAudioElement()
  const url = URL.createObjectURL(blob)
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        if (currentTtsAudioReject === fail) currentTtsAudioReject = null
        audio.onended = null
        audio.onerror = null
        audio.onstalled = null
      }
      currentTtsAudioReject = fail
      audio.onended = () => {
        cleanup()
        resolve()
      }
      audio.onerror = () => {
        fail(new Error('HTMLAudioElement playback failed'))
      }
      audio.onstalled = () => {
        fail(new Error('HTMLAudioElement playback stalled'))
      }
      audio.src = url
      audio.load()
      audio.play().catch(err => {
        fail(err)
      })
    })
  } finally {
    URL.revokeObjectURL(url)
    audio.removeAttribute('src')
    audio.load()
  }
}

async function playTtsBlob(blob: Blob): Promise<void> {
  if (nativeTtsPlaybackAvailable()) {
    recordTtsDebug(
      'native_tts_playback_start',
      `Android TV 原生 TTS 播放：${blob.type || 'audio/wav'} · ${blob.size} bytes`,
      'info'
    )
    await playNativeTtsBlob(blob)
    recordTtsDebug('native_tts_playback_done', 'Android TV 原生 TTS 播放完成', 'info')
    return
  }
  if (isIosDevice.value) {
    try {
      await playTtsBlobWithAudioElement(blob)
      return
    } catch (err: any) {
      recordDebug(
        'ios_tts_audio_failed',
        err?.message || 'iOS HTMLAudioElement 播放失败，回退 WebAudio',
        'warning'
      )
    }
  }
  try {
    const ctx = await ensureTtsAudioContext()
    const buffer = await blob.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(buffer.slice(0))
    await new Promise<void>((resolve, reject) => {
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      currentTtsSource = source
      source.onended = () => {
        if (currentTtsSource === source) currentTtsSource = null
        resolve()
      }
      try {
        source.start(0)
      } catch (err) {
        if (currentTtsSource === source) currentTtsSource = null
        reject(err)
      }
    })
    return
  } catch (err) {
    await playTtsBlobWithAudioElement(blob)
  }
}

async function toggleListening(): Promise<void> {
  if (voiceInputLocked.value) return
  if (!tabCanUseVoiceOutput()) return
  activateNoSleepPlayer()
  await unlockTtsPlayback().catch(err => {
    recordDebug('tts_playback_unlock_failed', err?.message || 'TTS 播放解锁失败', 'warning')
  })
  if (listening.value) stopVoiceCapture()
  else void startVoiceCapture()
}

async function setupVoiceHidControl(): Promise<void> {
  const binding = loadVoiceHidButtonBinding()
  voiceKeyboardBinding.value = loadVoiceKeyboardButtonBinding()
  voiceHidBinding.value = binding
  if (!binding && voiceKeyboardBinding.value) {
    voiceHidStatus.value = t('voice.hid.bound')
    return
  }
  if (!binding) {
    voiceHidStatus.value = ''
    return
  }
  if (!window.isSecureContext) {
    voiceHidStatus.value = t('voice.hid.secureRequired')
    return
  }
  const hid = getHidApi()
  if (!hid) {
    voiceHidStatus.value = t('voice.hid.unsupported')
    return
  }
  try {
    const devices = await hid.getDevices()
    const device = devices.find((item: any) => hidDeviceMatchesBinding(binding, item))
    if (!device) {
      voiceHidStatus.value = t('voice.hid.authorizationRequired')
      return
    }
    if (!device.opened) await device.open()
    voiceHidDevice = device
    voiceHidPressed = false
    device.removeEventListener('inputreport', handleVoiceHidReport)
    device.addEventListener('inputreport', handleVoiceHidReport)
    voiceHidStatus.value = t('voice.hid.connected')
  } catch (err: any) {
    voiceHidStatus.value = err?.message || t('voice.hid.connectionFailed')
  }
}

function handleVoiceKeyboardButton(event: KeyboardEvent): void {
  const binding = voiceKeyboardBinding.value
  if (!binding) return
  const target = event.target as HTMLElement | null
  const tag = target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return
  if (!keyboardEventMatchesBinding(binding, event)) return
  event.preventDefault()
  event.stopPropagation()
  void toggleListening()
}

function teardownVoiceHidControl(): void {
  voiceHidDevice?.removeEventListener('inputreport', handleVoiceHidReport)
  voiceHidDevice = null
  voiceHidPressed = false
}

function handleVoiceHidReport(event: any): void {
  const binding = voiceHidBinding.value
  if (!binding) return
  if (event.reportId !== binding.reportId) return
  const pressed = hidReportMatchesBinding(binding, event)
  if (pressed && !voiceHidPressed) {
    voiceHidPressed = true
    toggleListening()
    return
  }
  if (!pressed) voiceHidPressed = false
}

function startVoiceGamepadControl(): void {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return
  if (!navigator.getGamepads) {
    voiceGamepadStatus.value = t('voice.gamepad.unsupported')
    return
  }
  const gamepad = currentVoiceGamepad()
  updateVoiceGamepadConnection(gamepad)
  if (gamepad) showVoiceGamepadNotice(gamepad)
  if (!voiceGamepadFrame) {
    voiceGamepadFrame = window.requestAnimationFrame(pollVoiceGamepad)
  }
}

function teardownVoiceGamepadControl(): void {
  if (voiceGamepadFrame) window.cancelAnimationFrame(voiceGamepadFrame)
  voiceGamepadFrame = 0
  voiceGamepadPressedButtons = new Set()
  voiceGamepadAxisLocks = new Set()
  voiceGamepadPressedButtonIds.value = new Set()
  if (voiceGamepadNoticeTimer) window.clearTimeout(voiceGamepadNoticeTimer)
  voiceGamepadNoticeTimer = 0
}

function handleVoiceGamepadConnected(event: GamepadEvent): void {
  updateVoiceGamepadConnection(event.gamepad)
  showVoiceGamepadNotice(event.gamepad, true)
}

function handleVoiceGamepadDisconnected(): void {
  updateVoiceGamepadConnection(null)
}

const GAMEPAD_NOTICE_SESSION_KEY = 'homerail_gamepad_notice_shown'

function showVoiceGamepadNotice(gamepad: Gamepad, fromHotplug = false): void {
  // 组件挂载时探测到"已连接"是常态（手柄一直连着），不该每次进主界面都弹。
  // 用 sessionStorage 守卫：首次 poll 路径本次会话只弹一次；
  // 但真正的热插拔事件（fromHotplug）绕过守卫，用户中途插上手柄仍会提示。
  if (!fromHotplug) {
    try {
      if (sessionStorage.getItem(GAMEPAD_NOTICE_SESSION_KEY)) return
      sessionStorage.setItem(GAMEPAD_NOTICE_SESSION_KEY, '1')
    } catch {
      // sessionStorage 不可用时退化为每次提示（不阻断功能）
    }
  }
  voiceGamepadNoticeName.value = friendlyGamepadName(gamepad)
  voiceGamepadNoticeVisible.value = false
  if (voiceGamepadNoticeTimer) window.clearTimeout(voiceGamepadNoticeTimer)
  window.setTimeout(() => {
    voiceGamepadNoticeVisible.value = true
  }, 0)
  voiceGamepadNoticeTimer = window.setTimeout(() => {
    voiceGamepadNoticeVisible.value = false
    voiceGamepadNoticeTimer = 0
  }, 3600)
}

function updateVoiceGamepadConnection(preferred?: Gamepad | null): void {
  const gamepad = preferred || currentVoiceGamepad()
  voiceGamepadConnected.value = Boolean(gamepad)
  voiceGamepadStatus.value = gamepad
    ? `${friendlyGamepadName(gamepad)} ${t('voice.gamepad.connected')}`
    : t('voice.gamepad.disconnected')
}

function currentVoiceGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
  const gamepads = Array.from(navigator.getGamepads()).filter((gamepad): gamepad is Gamepad =>
    Boolean(gamepad)
  )
  return (
    gamepads.find(gamepad =>
      /dualsense|dualshock|wireless controller|playstation|ps5/i.test(gamepad.id)
    ) ||
    gamepads.find(gamepad => gamepad.mapping === 'standard') ||
    gamepads[0] ||
    null
  )
}

function friendlyGamepadName(_gamepad: Gamepad): string {
  return t('voice.gamepad.generic')
}

function pollVoiceGamepad(): void {
  const gamepad = currentVoiceGamepad()
  if (gamepad) {
    if (!voiceGamepadConnected.value) {
      updateVoiceGamepadConnection(gamepad)
      showVoiceGamepadNotice(gamepad)
    }
    handleVoiceGamepadButtons(gamepad)
    handleVoiceGamepadAxes(gamepad)
  } else if (voiceGamepadConnected.value) {
    updateVoiceGamepadConnection(null)
    voiceGamepadPressedButtons = new Set()
    voiceGamepadPressedButtonIds.value = new Set()
    voiceGamepadAxisLocks = new Set()
  }
  voiceGamepadFrame = window.requestAnimationFrame(pollVoiceGamepad)
}

function handleVoiceGamepadButtons(gamepad: Gamepad): void {
  const nextPressed = new Set<number>()
  gamepad.buttons.forEach((button, index) => {
    if (!button.pressed) return
    nextPressed.add(index)
    if (!voiceGamepadPressedButtons.has(index)) handleVoiceGamepadButton(index)
  })
  voiceGamepadPressedButtons = nextPressed
  voiceGamepadPressedButtonIds.value = nextPressed
}

function gamepadButtonActive(index: number): boolean {
  return voiceGamepadPressedButtonIds.value.has(index)
}

function markNativeGamepadConnected(): void {
  voiceGamepadConnected.value = true
  voiceGamepadStatus.value = `${t('voice.gamepad.generic')}${t('voice.gamepad.connected')}`
}

function handleNativeVoiceGamepadButton(event: Event): void {
  const detail = nativeGamepadEventDetail<NativeGamepadButtonDetail>(event)
  if (!detail || !Number.isFinite(detail.index)) return
  markNativeGamepadConnected()
  if (!detail.pressed) {
    voiceGamepadPressedButtons.delete(detail.index)
    voiceGamepadPressedButtonIds.value = new Set(voiceGamepadPressedButtons)
    return
  }
  if (detail.repeat || voiceGamepadPressedButtons.has(detail.index)) return
  voiceGamepadPressedButtons.add(detail.index)
  voiceGamepadPressedButtonIds.value = new Set(voiceGamepadPressedButtons)
  handleVoiceGamepadButton(detail.index)
}

function handleNativeVoiceGamepadAnalog(event: Event): void {
  const detail = nativeGamepadEventDetail<NativeGamepadAnalogDetail>(event)
  if (!detail) return
  markNativeGamepadConnected()
  nativeGamepadAnalogAt = performance.now()
  handleVoiceGamepadAxisDirection(detail.hatX ?? 0, 'left', 'right')
  handleVoiceGamepadAxisDirection(detail.hatY ?? 0, 'up', 'down')
  scrollConversationBy(applyVoiceGamepadDeadzone(detail.scrollY ?? 0) * VOICE_THREAD_SCROLL_SPEED)
}

function toggleVoiceGamepadLiveView(): void {
  voiceGamepadLiveVisible.value = !voiceGamepadLiveVisible.value
  if (voiceGamepadLiveVisible.value) {
    const gamepad = currentVoiceGamepad()
    if (gamepad) updateVoiceGamepadConnection(gamepad)
  }
}

function currentVoiceGamepadInputContext(): VoiceGamepadInputContext {
  return resolveVoiceGamepadContext({
    artifactPreviewOpen: Boolean(artifactPreviewModal.value),
    sessionPanelOpen: voiceGamepadFocusMode.value === 'sessions',
    sessionFocusActive: voiceGamepadFocusMode.value === 'sessions'
  })
}

function handleVoiceGamepadAxes(gamepad: Gamepad): void {
  handleVoiceGamepadAxisDirection(gamepad.axes[0] ?? 0, 'left', 'right')
  handleVoiceGamepadAxisDirection(gamepad.axes[1] ?? 0, 'up', 'down')
  if (performance.now() - nativeGamepadAnalogAt > 80) {
    scrollConversationBy(
      applyVoiceGamepadDeadzone(gamepad.axes[3] ?? 0) * VOICE_THREAD_SCROLL_SPEED
    )
  }
}

const VOICE_GAMEPAD_ANALOG_DEADZONE = 0.12
const VOICE_THREAD_SCROLL_SPEED = 28

function applyVoiceGamepadDeadzone(value: number): number {
  if (Math.abs(value) < VOICE_GAMEPAD_ANALOG_DEADZONE) return 0
  return Math.sign(value) * (Math.abs(value) - VOICE_GAMEPAD_ANALOG_DEADZONE) / (1 - VOICE_GAMEPAD_ANALOG_DEADZONE)
}

function scrollConversationBy(delta: number): void {
  if (!effectiveDetailsOpen.value || delta === 0) return
  conversationThreadRef.value?.scrollBy({ top: delta, behavior: 'auto' })
}

function handleVoiceGamepadAxisDirection(
  value: number,
  negative: VoiceGamepadDirection,
  positive: VoiceGamepadDirection
): void {
  const threshold = 0.65
  const release = 0.35
  if (value <= -threshold) {
    if (!voiceGamepadAxisLocks.has(negative)) {
      voiceGamepadAxisLocks.add(negative)
      handleVoiceGamepadDirection(negative)
    }
    return
  }
  if (value >= threshold) {
    if (!voiceGamepadAxisLocks.has(positive)) {
      voiceGamepadAxisLocks.add(positive)
      handleVoiceGamepadDirection(positive)
    }
    return
  }
  if (Math.abs(value) < release) {
    voiceGamepadAxisLocks.delete(negative)
    voiceGamepadAxisLocks.delete(positive)
  }
}

function handleVoiceGamepadButton(index: number): void {
  const context = currentVoiceGamepadInputContext()
  const intent = resolveVoiceGamepadButtonIntent(context, index)
  if (intent !== 'none') {
    handleVoiceGamepadButtonIntent(intent)
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.dpadUp) handleVoiceGamepadDirection('up')
  else if (index === VOICE_GAMEPAD_BUTTON.dpadDown) handleVoiceGamepadDirection('down')
  else if (index === VOICE_GAMEPAD_BUTTON.dpadLeft) handleVoiceGamepadDirection('left')
  else if (index === VOICE_GAMEPAD_BUTTON.dpadRight) handleVoiceGamepadDirection('right')
}

function handleVoiceGamepadButtonIntent(
  intent: ReturnType<typeof resolveVoiceGamepadButtonIntent>
): void {
  if (intent === 'system_preview') openSelectedWidgetPreview()
  else if (intent === 'system_cancel') handleVoiceGamepadCancel()
  else if (intent === 'voice_toggle') void toggleListening()
  else if (intent === 'widget_previous') selectAdjacentWidget(-1)
  else if (intent === 'widget_next') selectAdjacentWidget(1)
  else if (intent === 'session_panel_toggle') toggleSessionSidebarFromGamepad()
  else if (intent === 'details_panel_toggle') toggleDetails()
  else if (intent === 'preview_previous') prevArtifactPreviewImage()
  else if (intent === 'preview_next') nextArtifactPreviewImage()
  else if (intent === 'widget_confirm') confirmSelectedWidgetControl()
  else if (intent === 'session_up') selectAdjacentSessionItem(-1)
  else if (intent === 'session_down') selectAdjacentSessionItem(1)
  else if (intent === 'session_confirm') confirmFocusedSessionItem()
  else if (intent === 'session_toggle_project_sessions') toggleFocusedProjectSessions()
  else if (intent === 'open_runtime') openRuntimeOverlay()
  else if (intent === 'open_settings') openSettings()
}

function handleVoiceGamepadDirection(direction: VoiceGamepadDirection): void {
  const context = currentVoiceGamepadInputContext()
  const intent = resolveVoiceGamepadDirectionIntent(context, direction)
  if (intent === 'preview_previous') prevArtifactPreviewImage()
  else if (intent === 'preview_next') nextArtifactPreviewImage()
  else if (intent === 'session_up') selectAdjacentSessionItem(-1)
  else if (intent === 'session_down') selectAdjacentSessionItem(1)
  else moveWidgetSelection(direction)
}

function handleVoiceGamepadCancel(): void {
  if (artifactPreviewModal.value) {
    closeArtifactPreview()
    return
  }
  if (voiceGamepadFocusMode.value === 'sessions') {
    if (isTvCompactViewport.value && voiceSidebarOpen.value) {
      voiceSidebarOpen.value = false
    }
    voiceGamepadFocusMode.value = 'widgets'
    return
  }
  if (voiceSidebarOpen.value && isPhonePortrait.value) {
    voiceSidebarOpen.value = false
    return
  }
  if (effectiveDetailsOpen.value) toggleDetails()
}

function toggleSessionSidebarFromGamepad(): void {
  if (artifactPreviewModal.value) return
  voiceSidebarOpen.value = !voiceSidebarOpen.value
  voiceGamepadFocusMode.value = voiceSidebarOpen.value ? 'sessions' : 'widgets'
  if (voiceSidebarOpen.value) {
    void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
  }
}

function openSessionSidebar(): void {
  voiceSidebarOpen.value = true
  voiceGamepadFocusMode.value = 'sessions'
  void nextTick(() => voiceSidebarRef.value?.ensureGamepadFocus())
}

function selectAdjacentSessionItem(delta: number): void {
  if (!voiceSidebarOpen.value && !isPhonePortrait.value) voiceSidebarOpen.value = true
  voiceGamepadFocusMode.value = 'sessions'
  void nextTick(() => voiceSidebarRef.value?.focusNextGamepadItem(delta))
}

function confirmFocusedSessionItem(): void {
  if (!voiceSidebarOpen.value && !isPhonePortrait.value) voiceSidebarOpen.value = true
  voiceGamepadFocusMode.value = 'sessions'
  void nextTick(() => voiceSidebarRef.value?.confirmFocusedGamepadItem())
}

function toggleFocusedProjectSessions(): void {
  if (!voiceSidebarOpen.value && !isPhonePortrait.value) voiceSidebarOpen.value = true
  voiceGamepadFocusMode.value = 'sessions'
  void nextTick(() => voiceSidebarRef.value?.toggleFocusedProjectSessions())
}

function selectAdjacentWidget(delta: number): void {
  const refs = gamepadWidgetRefs.value
  if (!refs.length) return
  const currentIndex = Math.max(
    0,
    refs.findIndex(widget => widget.id === selectedWidgetId.value)
  )
  const nextIndex = selectedWidgetId.value
    ? (currentIndex + delta + refs.length) % refs.length
    : delta < 0
      ? refs.length - 1
      : 0
  selectWidgetById(refs[nextIndex]?.id || '')
}

function moveWidgetSelection(direction: VoiceGamepadDirection): void {
  if (direction === 'left' || direction === 'up') selectAdjacentWidget(-1)
  else selectAdjacentWidget(1)
}

function selectWidgetById(widgetId: string): void {
  if (!widgetId) return
  selectedWidgetId.value = widgetId
  void scrollCardGridToWidget(widgetId)
}

function selectedGamepadWidget(): VoiceGamepadWidgetRef | null {
  if (!selectedWidgetId.value) {
    const first = gamepadWidgetRefs.value[0]
    if (!first) return null
    selectedWidgetId.value = first.id
    return first
  }
  return gamepadWidgetRefs.value.find(widget => widget.id === selectedWidgetId.value) || null
}

function selectedWidgetElement(): HTMLElement | null {
  const selected = selectedGamepadWidget()
  if (!selected) return null
  return (
    voiceCardGridRef.value?.querySelector<HTMLElement>(
      `[data-widget-id="${cssEscape(selected.id)}"]`
    ) || null
  )
}

function openSelectedWidgetPreview(): void {
  const selected = selectedGamepadWidget()
  if (!selected) return
  if (selected.kind === 'artifact' && selected.widget) {
    openArtifactPreview(selected.widget)
    return
  }
  const root = selectedWidgetElement()
  const previewButton = Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    button => !button.disabled && /预览|預覽|打开|打開/.test(button.textContent || button.title || '')
  )
  previewButton?.click()
}

function confirmSelectedWidgetControl(): void {
  const root = selectedWidgetElement()
  const control = Array.from(
    root?.querySelectorAll<HTMLElement>('button, a, [role="button"], input, select, textarea') ?? []
  ).find(element => {
    if (element.getAttribute('aria-hidden') === 'true') return false
    if ('disabled' in element && (element as HTMLButtonElement).disabled) return false
    return true
  })
  control?.click()
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

async function startVoiceCapture(): Promise<void> {
  if (!tabCanUseVoiceOutput()) return
  stopVoiceCapture()
  voiceSessionToken += 1
  broadcastVoiceActivity('listening')
  error.value = ''
  liveTranscript.value = ''
  listening.value = true
  voiceBusy.value = false
  waveformBars.value = waveformBars.value.map(() => 0.1)
  waveformSamples.value = waveformSamples.value.map(() => 0)

  try {
    if (nativeVoiceCaptureAvailable()) {
      await startNativeVoiceCaptureMode()
      return
    }

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) {
      throw new Error(t('voice.errors.liveCaptureUnsupported'))
    }
    mediaStream = await createVoiceMediaStream()
    audioContext = new AudioContextCtor()
    currentVoiceSampleRate = audioContext.sampleRate || 48000
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    micSource = audioContext.createMediaStreamSource(mediaStream)
    processor = audioContext.createScriptProcessor(4096, 1, 1)
    silentGain = audioContext.createGain()
    silentGain.gain.value = 0
    micSource.connect(analyser)
    micSource.connect(processor)
    processor.connect(silentGain)
    silentGain.connect(audioContext.destination)
    processor.onaudioprocess = event => {
      if (!speechActive || voiceInputLocked.value) return
      const samples = new Float32Array(event.inputBuffer.getChannelData(0))
      if (recognitionMode.value === 'asr') sendAsrAudio(samples, audioContext?.sampleRate || 48000)
      else pcmChunks.push(samples)
    }
    if (recognitionMode.value === 'asr') await connectAsrRealtime()
    rafId = window.requestAnimationFrame(updateVoiceWaveform)
  } catch (err: any) {
    error.value = err?.message || t('voice.errors.microphoneUnavailable')
    stopVoiceCapture()
  }
}

async function startNativeVoiceCaptureMode(): Promise<void> {
  currentVoiceSampleRate = 16000
  if (recognitionMode.value === 'asr') await connectAsrRealtime()
  nativeVoiceCaptureSession = startNativeVoiceCapture({
    sampleRate: 16000,
    onSamples: handleNativeVoiceSamples,
    onStatus: handleNativeVoiceStatus,
    onError: err => {
      error.value = err.message || t('voice.errors.microphoneUnavailable')
    }
  })
  liveTranscript.value = t('voice.state.listening')
}

function handleNativeVoiceStatus(status: NativeVoiceStatus): void {
  if (status.sampleRate) currentVoiceSampleRate = status.sampleRate
  if (status.ok === false && status.message) error.value = status.message
  if (status.event === 'started' && status.selectedDeviceName) {
    console.info('[HomeRailNativeVoice] started', JSON.stringify(status))
  }
}

function handleNativeVoiceSamples(samples: Float32Array, sampleRate: number): void {
  currentVoiceSampleRate = sampleRate || currentVoiceSampleRate
  updateNativeVoiceWaveform(samples)
  if (voiceInputLocked.value) {
    speechActive = false
    pcmChunks = []
    return
  }

  const now = performance.now()
  const isUserSpeaking = voiceLevel.value > 0.16
  if (isUserSpeaking) {
    lastVoiceAt = now
    if (!speechActive && !voiceBusy.value) {
      speechActive = true
      pcmChunks = []
      liveTranscript.value = ''
      spokenText.value = ''
      asrTranscriptRaw = ''
      liveTranscript.value = t('voice.state.listening')
    }
  }

  if (speechActive && !voiceBusy.value) {
    if (recognitionMode.value === 'asr') sendAsrAudio(samples, currentVoiceSampleRate)
    else pcmChunks.push(samples)
  }

  if (!isUserSpeaking && speechActive && now - lastVoiceAt > voiceVadSilenceMs.value) {
    void finishUtterance()
  }
}

function updateNativeVoiceWaveform(samples: Float32Array): void {
  if (!samples.length) return
  let sum = 0
  for (const sample of samples) sum += sample * sample
  const rms = Math.sqrt(sum / samples.length)
  voiceLevel.value = Math.min(1, rms * 10)
  waveformBars.value = waveformBars.value.map((_, index) => {
    const sample = samples[Math.floor((index * samples.length) / waveformBars.value.length)] ?? 0
    return Math.max(0.08, Math.min(1, Math.abs(sample) + voiceLevel.value * 0.48))
  })
  waveformSamples.value = waveformSamples.value.map((previous, index) => {
    const start = Math.floor((index * samples.length) / waveformSamples.value.length)
    const width = Math.max(1, Math.floor(samples.length / waveformSamples.value.length))
    let total = 0
    for (let offset = 0; offset < width; offset += 1) total += samples[start + offset] ?? 0
    const sample = total / width
    return previous * 0.35 + sample * 0.65
  })
}

function stopVoiceCapture(): void {
  voiceSessionToken += 1
  voiceAbort?.abort()
  voiceAbort = null
  closeVoiceInputAfterSubmit()
  voiceBusy.value = false
}

function closeVoiceInputAfterSubmit(): void {
  nativeVoiceCaptureSession?.stop()
  nativeVoiceCaptureSession = null
  disconnectAsrRealtime()
  speechActive = false
  pcmChunks = []
  listening.value = false
  if (rafId) window.cancelAnimationFrame(rafId)
  rafId = 0
  processor?.disconnect()
  analyser?.disconnect()
  micSource?.disconnect()
  silentGain?.disconnect()
  mediaStream?.getTracks().forEach(track => track.stop())
  audioContext?.close().catch(() => {})
  processor = null
  analyser = null
  micSource = null
  silentGain = null
  mediaStream = null
  audioContext = null
  voiceLevel.value = 0
  waveformBars.value = waveformBars.value.map(() => 0.1)
  waveformSamples.value = waveformSamples.value.map(() => 0)
}

function updateVoiceWaveform(now: number): void {
  if (!listening.value || !analyser) return
  const data = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(data)
  let sum = 0
  for (const value of data) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  const rms = Math.sqrt(sum / data.length)
  voiceLevel.value = Math.min(1, rms * 10)
  waveformBars.value = waveformBars.value.map((_, index) => {
    const sample = data[Math.floor((index * data.length) / waveformBars.value.length)] ?? 128
    return Math.max(0.08, Math.min(1, Math.abs(sample - 128) / 62 + voiceLevel.value * 0.48))
  })
  waveformSamples.value = waveformSamples.value.map((previous, index) => {
    const start = Math.floor((index * data.length) / waveformSamples.value.length)
    const width = Math.max(2, Math.floor(data.length / waveformSamples.value.length))
    let total = 0
    for (let offset = 0; offset < width; offset += 1) {
      total += ((data[start + offset] ?? 128) - 128) / 128
    }
    const sample = total / width
    return previous * 0.35 + sample * 0.65
  })
  if (voiceInputLocked.value) {
    speechActive = false
    pcmChunks = []
    rafId = window.requestAnimationFrame(updateVoiceWaveform)
    return
  }

  const isUserSpeaking = voiceLevel.value > 0.16
  if (isUserSpeaking) {
    lastVoiceAt = now
    if (!speechActive && !voiceBusy.value) {
      speechActive = true
      pcmChunks = []
      liveTranscript.value = ''
      spokenText.value = ''
      asrTranscriptRaw = ''
      liveTranscript.value = t('voice.state.listening')
    }
  } else if (speechActive && now - lastVoiceAt > voiceVadSilenceMs.value) {
    void finishUtterance()
  }
  rafId = window.requestAnimationFrame(updateVoiceWaveform)
}

async function finishUtterance(): Promise<void> {
  if (!speechActive || voiceBusy.value) return
  const token = voiceSessionToken
  speechActive = false
  if (recognitionMode.value === 'asr') {
    pcmChunks = []
    voiceBusy.value = true
    try {
      const text = (await finishAsrUtterance()).trim()
      if (token !== voiceSessionToken) return
      if (!text) throw new Error(t('voice.errors.noTranscript'))
      liveTranscript.value = text
      voiceBusy.value = false
      await handleFinalTranscript(text)
    } catch (err: any) {
      if (token !== voiceSessionToken) return
      error.value = err?.message || t('voice.errors.asrFailed')
      liveTranscript.value = ''
    } finally {
      if (token === voiceSessionToken) voiceBusy.value = false
    }
    return
  }

  const chunks = pcmChunks
  pcmChunks = []
  if (chunks.reduce((total, chunk) => total + chunk.length, 0) < 2400) {
    if (token === voiceSessionToken) liveTranscript.value = ''
    return
  }
  voiceBusy.value = true
  liveTranscript.value = t('voice.state.omniProcessing')
  voiceAbort?.abort()
  voiceAbort = new AbortController()
  const signal = voiceAbort.signal
  try {
    const sampleRate = currentVoiceSampleRate || audioContext?.sampleRate || 48000
    const wav = encodeWav(chunks, sampleRate)
    const dataUrl = await blobToDataUrl(wav)
    if (token !== voiceSessionToken || signal.aborted) return
    const result = await transcribeVoice(dataUrl, signal, 'omni')
    if (token !== voiceSessionToken || signal.aborted) return
    const text = (result.data?.text || '').trim()
    if (!text) throw new Error(t('voice.errors.noTranscript'))
    liveTranscript.value = text
    voiceBusy.value = false
    await handleFinalTranscript(text)
  } catch (err: any) {
    if (
      err?.name === 'CanceledError' ||
      err?.name === 'AbortError' ||
      signal.aborted ||
      token !== voiceSessionToken
    )
      return
    error.value = err?.message || t('voice.errors.voiceFailed')
    liveTranscript.value = t('voice.state.notHeard')
  } finally {
    if (token === voiceSessionToken) {
      voiceBusy.value = false
      voiceAbort = null
    }
  }
}

async function connectAsrRealtime(): Promise<void> {
  disconnectAsrRealtime()
  await new Promise<void>((resolve, reject) => {
    asrClosing = false
    const socket = createAsrRealtimeSocket()
    const timer = window.setTimeout(() => {
      socket.close()
      reject(new Error(t('voice.errors.asrTimeout')))
    }, 5000)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      window.clearTimeout(timer)
      asrSocket = socket
      resolve()
    }
    socket.onerror = () => {
      window.clearTimeout(timer)
      reject(new Error(t('voice.errors.asrConnectionFailed')))
    }
    socket.onclose = () => {
      const wasActiveSocket = asrSocket === socket
      if (wasActiveSocket) asrSocket = null
      if (wasActiveSocket && !asrClosing && listening.value) {
        rejectAsrFinal(new Error(t('voice.errors.asrDisconnected')))
        error.value = t('voice.errors.asrDisconnected')
      }
    }
    socket.onmessage = event => handleAsrRealtimeMessage(event.data)
  })
}

function disconnectAsrRealtime(): void {
  asrClosing = true
  if (asrFinalTimer) window.clearTimeout(asrFinalTimer)
  asrFinalTimer = 0
  asrFinalResolve = null
  asrFinalReject = null
  if (asrSocket) asrSocket.close()
  asrSocket = null
}

function sendAsrAudio(samples: Float32Array, sampleRate: number): void {
  if (!asrSocket || asrSocket.readyState !== WebSocket.OPEN) {
    error.value = t('voice.errors.asrNotConnected')
    return
  }
  const pcm = encodePcm16(samples, sampleRate, 16000)
  if (pcm.byteLength) asrSocket.send(pcm)
}

function finishAsrUtterance(): Promise<string> {
  if (!asrSocket || asrSocket.readyState !== WebSocket.OPEN) {
    throw new Error(t('voice.errors.asrNotConnected'))
  }
  return new Promise((resolve, reject) => {
    asrFinalResolve = resolve
    asrFinalReject = reject
    asrFinalTimer = window.setTimeout(() => rejectAsrFinal(new Error(t('voice.errors.asrTranscriptionTimeout'))), 9000)
    asrSocket?.send(JSON.stringify({ type: 'finish' }))
  })
}

function handleAsrRealtimeMessage(payload: unknown): void {
  if (typeof payload !== 'string') return
  let event: Record<string, unknown>
  try {
    event = JSON.parse(payload)
  } catch {
    return
  }
  if (event.type === 'error') {
    const message = asrTextField(event, ['error', 'message']) || t('voice.errors.asrResponse')
    rejectAsrFinal(new Error(message))
    error.value = message
    return
  }
  const finalText = asrFinalText(event)
  if (finalText !== null) {
    const text = cleanAsrTranscript(finalText || asrTranscriptRaw)
    liveTranscript.value = text
    resolveAsrFinal(text)
    return
  }
  const partial = asrPartialText(event)
  if (partial !== null) {
    if (isAsrDeltaEvent(event)) asrTranscriptRaw += partial
    else asrTranscriptRaw = partial
    const display = cleanAsrTranscript(asrTranscriptRaw)
    liveTranscript.value = display
    // 辅助模式下同步把当前流式识别结果写进 composer，用户能边说边看到字落到输入框。
    if (voiceInputAssist.value) codexTextDraft.value = display
    return
  }
}

function resolveAsrFinal(text: string): void {
  if (asrFinalTimer) window.clearTimeout(asrFinalTimer)
  asrFinalTimer = 0
  const resolve = asrFinalResolve
  asrFinalResolve = null
  asrFinalReject = null
  asrTranscriptRaw = ''
  resolve?.(text)
}

function rejectAsrFinal(error: Error): void {
  if (asrFinalTimer) window.clearTimeout(asrFinalTimer)
  asrFinalTimer = 0
  const reject = asrFinalReject
  asrFinalResolve = null
  asrFinalReject = null
  asrTranscriptRaw = ''
  reject?.(error)
}

function cleanAsrTranscript(text: string): string {
  return cleanVoiceTranscript(text)
}

function asrEventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type.toLowerCase() : ''
}

function isAsrDeltaEvent(event: Record<string, unknown>): boolean {
  const type = asrEventType(event)
  return (
    type.includes('delta') ||
    typeof event.delta === 'string' ||
    typeof event.text_delta === 'string'
  )
}

function isAsrFinalEvent(event: Record<string, unknown>): boolean {
  const type = asrEventType(event)
  return (
    type.includes('done') ||
    type.includes('final') ||
    type.includes('completed') ||
    event.is_final === true ||
    event.final === true
  )
}

function asrTextField(event: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = event[field]
    if (typeof value === 'string') return value
  }
  for (const field of ['data', 'result']) {
    const nested = event[field]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const value = asrTextField(nested as Record<string, unknown>, fields)
      if (value) return value
    }
  }
  return ''
}

function asrPartialText(event: Record<string, unknown>): string | null {
  const type = asrEventType(event)
  const text = asrTextField(event, ['delta', 'text_delta', 'partial', 'transcript', 'text'])
  if (!text) return null
  if (isAsrFinalEvent(event)) return null
  if (
    type.includes('transcription') ||
    type.includes('transcript') ||
    type.includes('partial') ||
    type.includes('delta') ||
    type.includes('asr')
  ) {
    return text
  }
  return typeof event.partial === 'string' || typeof event.delta === 'string' ? text : null
}

function asrFinalText(event: Record<string, unknown>): string | null {
  if (!isAsrFinalEvent(event)) return null
  return asrTextField(event, ['text', 'transcript', 'final', 'result', 'partial'])
}

function encodePcm16(samples: Float32Array, inputRate: number, outputRate: number): ArrayBuffer {
  const ratio = inputRate / outputRate
  const length = Math.max(0, Math.floor(samples.length / ratio))
  const buffer = new ArrayBuffer(length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < length; i += 1) {
    const sample = samples[Math.min(samples.length - 1, Math.floor(i * ratio))] || 0
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, length * 2, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function toggleDetails(): void {
  detailsOpen.value = !detailsOpen.value
}

async function scrollConversationToLatest(): Promise<void> {
  await nextTick()
  const thread = conversationThreadRef.value
  if (!thread) return
  window.requestAnimationFrame(() => {
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  })
}

async function focusLatestMobilePanel(): Promise<void> {
  await nextTick()
  const grid = voiceCardGridRef.value
  if (!grid) return
  window.requestAnimationFrame(() => {
    grid.scrollTo({ left: 0, behavior: 'smooth' })
  })
}

function widgetFingerprint(widget: VoiceWidget): string {
  const data = (() => {
    try {
      return JSON.stringify(widget.data ?? {})
    } catch {
      return ''
    }
  })()
  return [
    widget.id,
    widget.type,
    widget.title,
    widget.status || '',
    widget.body || '',
    widget.items?.join('\u001f') || '',
    widget.steps?.join('\u001f') || '',
    String(widget.active_step ?? ''),
    data.slice(0, 4000)
  ].join('\u001e')
}

async function focusUpdatedWidgets(): Promise<void> {
  const widgets = canvasWidgets.value
  const hadVisibleWidgets = widgetIdCache.size > 0
  const nextFingerprints = new Map(widgets.map(widget => [widget.id, widgetFingerprint(widget)]))
  const nextWidgetIds = new Set(widgets.map(widget => widget.id))
  const changedIds = widgets
    .filter(widget => widgetFingerprintCache.get(widget.id) !== nextFingerprints.get(widget.id))
    .map(widget => widget.id)
  const newWidgetIds = widgets
    .filter(widget => !widgetIdCache.has(widget.id))
    .map(widget => widget.id)
  widgetFingerprintCache = nextFingerprints
  widgetIdCache = nextWidgetIds
  if (!changedIds.length) return
  highlightedWidgetIds.value = new Set(changedIds)
  if (widgetHighlightTimer) window.clearTimeout(widgetHighlightTimer)
  widgetHighlightTimer = window.setTimeout(() => {
    highlightedWidgetIds.value = new Set()
  }, 4200)
  const newestWidgetId = newWidgetIds[newWidgetIds.length - 1]
  if (hadVisibleWidgets && newestWidgetId) {
    await scrollCardGridToWidget(newestWidgetId)
  }
}

async function scrollCardGridToWidget(widgetId?: string): Promise<void> {
  await nextTick()
  const grid = voiceCardGridRef.value
  if (!grid) return
  window.requestAnimationFrame(() => {
    const target = widgetId
      ? Array.from(grid.querySelectorAll<HTMLElement>('[data-widget-id]')).find(
          element => element.dataset.widgetId === widgetId
        )
      : null
    const left = target ? Math.max(0, target.offsetLeft - grid.offsetLeft) : 0
    grid.scrollTo({ left, behavior: 'smooth' })
  })
}

function openSettings(): void {
  store.settingsPageOpen = true
  store.voiceCockpitOpen = false
}

function openRuntimeOverlay(): void {
  store.runtimeOverlayOpen = true
}

function openDevOnboarding(): void {
  store.openOnboarding({ manualDebug: true })
}

function close(): void {
  if (props.voiceOnly) return
  void endSession()
  store.voiceCockpitOpen = false
}

function summarizeTask(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > 92 ? `${text.slice(0, 91)}…` : text
}
</script>

<template>
  <div
    ref="cockpitRoot"
    class="voice-cockpit fixed inset-0 z-50 bg-[#090b0d] text-white"
    :class="voiceCockpitClasses"
  >
    <div class="voice-cockpit__ambient" />
    <video
      ref="noSleepVideo"
      class="voice-nosleep-video"
      muted
      loop
      playsinline
      webkit-playsinline
      preload="auto"
      aria-hidden="true"
    >
      <source src="/no-sleep.mp4" type="video/mp4" />
    </video>
    <audio
      ref="ttsAudioElement"
      class="voice-tts-audio"
      playsinline
      webkit-playsinline
      preload="auto"
      aria-hidden="true"
    />
    <button
      v-if="fullscreenPromptVisible && isMobileDevice"
      class="voice-fullscreen-gate"
      type="button"
      @pointerup.prevent="enterMobileFullscreen"
      @touchend.prevent="enterMobileFullscreen"
      @click="enterMobileFullscreen"
    >
      <span>{{ fullscreenGateTitle }}</span>
      <em>{{ fullscreenGateHint }}</em>
      <strong>{{ fullscreenGateAction }}</strong>
    </button>
    <div class="voice-shell relative flex h-full min-h-0 flex-col p-4" :style="voiceShellStyle">
      <AgentModeTopBar
        active-mode="voice"
        :show-details="topbarAuxControlsVisible"
        :show-settings="topbarAuxControlsVisible"
        :show-runtime="topbarAuxControlsVisible"
        :details-open="effectiveDetailsOpen"
        :voice-only="topbarVoiceOnly"
        @select-text="close"
        @open-settings="openSettings"
        @toggle-details="toggleDetails"
        @open-runtime="openRuntimeOverlay"
      >
        <template #right>
          <DagResourceStatusPill />
        </template>
        <div ref="modelMenuRef" class="voice-model-menu">
          <button
            class="voice-model-menu__button"
            :class="{
              'voice-model-menu__button--alert': needsOnboardingHint
            }"
            type="button"
            data-testid="voice-model-config-button"
            :aria-expanded="modelMenuOpen"
            aria-haspopup="menu"
            @click="toggleModelMenu"
          >
            <AlertTriangle v-if="needsOnboardingHint" class="h-4 w-4" />
            <SlidersHorizontal v-else class="h-4 w-4" />
            <span>{{ modelConfigButtonLabel }}</span>
            <ChevronDown
              v-if="!needsOnboardingHint"
              class="h-4 w-4 transition-transform"
              :class="modelMenuOpen ? 'rotate-180' : ''"
            />
          </button>
          <div
            v-if="modelMenuOpen"
            class="voice-model-menu__popover"
            data-testid="voice-model-config-menu"
            role="menu"
          >
            <div class="voice-model-menu__header">
              <span>{{ t('voice.model.configuration') }}</span>
              <em>{{ t('voice.model.summary') }}</em>
            </div>

            <div class="voice-model-menu__row">
              <span class="voice-model-menu__label">
                <strong>{{ t('voice.model.manager') }}</strong>
                <em>{{ t('voice.model.managerDescription') }}</em>
              </span>
              <div class="voice-model-menu__controls">
                <select
                  :value="voiceAgentHarness"
                  :disabled="asrLoading || voiceAgentSaving"
                  :title="t('voice.model.managerHarness')"
                  data-testid="voice-model-agent-harness-select"
                  @change="changeVoiceAgentHarness"
                >
                  <option value="codex_appserver" class="bg-[#111315] text-white">Codex</option>
                  <option value="kimi_code" class="bg-[#111315] text-white">Kimi Code</option>
                  <option value="claude_agent_sdk" class="bg-[#111315] text-white">
                    Claude Code
                  </option>
                </select>
                <select
                  v-if="codexHarnessActive"
                  :value="selectedCodexModel"
                  :disabled="asrLoading || voiceAgentSaving || codexModelsLoading || !codexModelOptions.length"
                  :title="codexModelsError || 'Codex model'"
                  data-testid="voice-model-agent-model-select"
                  @change="handleCodexModelChange"
                >
                  <option
                    v-if="configuredCodexModelUnavailable"
                    :value="configuredCodexModel"
                    disabled
                    class="bg-[#111315] text-white"
                  >
                    {{ configuredCodexModel }} ({{ t('voice.model.accountUnavailable') }})
                  </option>
                  <option
                    v-if="!codexModelOptions.length && !configuredCodexModelUnavailable"
                    value=""
                    disabled
                  >
                    {{ t('voice.model.noCodexModels') }}
                  </option>
                  <option
                    v-for="model in codexModelOptions"
                    :key="model.id"
                    :value="model.model"
                    class="bg-[#111315] text-white"
                  >
                    {{ model.display_name }}
                  </option>
                </select>
                <select
                  v-else
                  :value="selectedManagerAgentModelId"
                  :disabled="
                    asrLoading ||
                    asrSaving ||
                    voiceAgentSaving ||
                    !voiceSettings ||
                    !managerAgentModelOptions.length
                  "
                  :title="t('voice.model.managerModel', { harness: kimiHarnessActive ? 'Kimi Code' : 'Claude Code' })"
                  data-testid="voice-model-agent-model-select"
                  @change="changeLlmModel"
                >
                  <option v-if="!managerAgentModelOptions.length" value="" class="bg-[#111315] text-white">
                    {{ voiceSettings?.llm_model || t('voice.model.managerUnconfigured') }}
                  </option>
                  <option
                    v-for="setting in managerAgentModelOptions"
                    :key="setting.id"
                    :value="setting.id"
                    class="bg-[#111315] text-white"
                  >
                    {{ modelSettingLabel(setting, managerAgentModelOptions) }}
                  </option>
                </select>
              </div>
            </div>

            <label v-if="codexHarnessActive" class="voice-model-menu__row">
              <span class="voice-model-menu__label">
                <strong>{{ t('voice.model.reasoning') }}</strong>
                <em>{{
                  codexReasoningEffortOptions.find(option => option.value === codexReasoningEffort)
                    ?.description
                }}</em>
              </span>
              <select
                :value="codexReasoningEffort"
                :disabled="voiceAgentSaving || !selectedCodexModel || configuredCodexModelUnavailable"
                :title="t('voice.model.reasoning')"
                data-testid="voice-model-agent-reasoning-select"
                @change="handleCodexReasoningEffortChange"
              >
                <option
                  v-for="option in codexReasoningEffortOptions"
                  :key="option.value"
                  :value="option.value"
                  class="bg-[#111315] text-white"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label v-if="codexHarnessActive" class="voice-model-menu__row">
              <span class="voice-model-menu__label">
                <strong>{{ t('voice.model.serviceTier') }}</strong>
                <em>{{
                  codexServiceTierOptions.find(option => option.value === codexServiceTier)
                    ?.description
                }}</em>
              </span>
              <select
                :value="codexServiceTier"
                :disabled="voiceAgentSaving || !selectedCodexModel || configuredCodexModelUnavailable"
                :title="t('voice.model.serviceTier')"
                data-testid="voice-model-agent-service-tier-select"
                @change="handleCodexServiceTierChange"
              >
                <option
                  v-for="option in codexServiceTierOptions"
                  :key="option.value || 'standard'"
                  :value="option.value"
                  class="bg-[#111315] text-white"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <label class="voice-model-menu__row">
              <span class="voice-model-menu__label">
                <strong>ASR</strong>
                <em>{{ asrModelLabel }}</em>
              </span>
              <select
                :value="selectedAsrModelId"
                :disabled="asrLoading || asrSaving || !voiceSettings || !asrModelOptions.length"
                :title="t('voice.model.asr')"
                @change="changeAsrModel"
              >
                <option v-if="!asrModelOptions.length" value="" class="bg-[#111315] text-white">
                  {{ voiceSettings?.asr_model || t('voice.model.asrUnconfigured') }}
                </option>
                <option
                  v-for="setting in asrModelOptions"
                  :key="setting.id"
                  :value="setting.id"
                  class="bg-[#111315] text-white"
                >
                  {{ modelSettingLabel(setting, asrModelOptions) }}
                </option>
              </select>
            </label>

            <label class="voice-model-menu__row">
              <span class="voice-model-menu__label">
                <strong>TTS</strong>
                <em>{{ arkTtsDetails || ttsModelLabel }}</em>
              </span>
              <select
                :value="selectedTtsModelId"
                :disabled="asrLoading || ttsSaving || !voiceSettings || !ttsModelOptions.length"
                :title="t('voice.model.tts')"
                @change="changeTtsModel"
              >
                <option v-if="!ttsModelOptions.length" value="" class="bg-[#111315] text-white">
                  {{ voiceSettings?.tts_model || t('voice.model.ttsUnconfigured') }}
                </option>
                <option
                  v-for="setting in ttsModelOptions"
                  :key="setting.id"
                  :value="setting.id"
                  class="bg-[#111315] text-white"
                >
                  {{ modelSettingLabel(setting, ttsModelOptions) }}
                </option>
              </select>
            </label>

            <div
              v-if="asrSaving || ttsSaving || voiceAgentSaving || voiceConfigError"
              class="voice-model-menu__footer"
            >
              <span v-if="asrSaving || ttsSaving || voiceAgentSaving">{{ t('voice.model.saving') }}</span>
              <span v-else>{{ voiceConfigError }}</span>
            </div>
          </div>
        </div>
        <button
          v-if="devOnboardingEntryVisible"
          class="voice-runtime-pill voice-runtime-pill--dev-onboarding flex h-9 items-center gap-2 rounded-full border border-amber-300/24 bg-amber-300/10 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-300/16 hover:text-white"
          :title="t('voice.onboarding.devTitle')"
          type="button"
          data-testid="voice-dev-onboarding-button"
          @click="openDevOnboarding"
        >
          <Sparkles class="h-4 w-4" />
          <span>{{ t('voice.onboarding.button') }}</span>
        </button>
        <button
          class="voice-runtime-pill voice-runtime-pill--gamepad flex h-9 items-center rounded-full border px-3 text-xs"
          :class="{
            'border-emerald-300/30 bg-emerald-300/10 text-emerald-100': voiceGamepadConnected,
            'border-white/10 bg-white/[0.035] text-white/35': !voiceGamepadConnected,
            'voice-runtime-pill--gamepad-live': voiceGamepadLiveVisible
          }"
          :title="
            voiceGamepadLiveVisible ? t('voice.gamepad.hideMonitor') : voiceGamepadStatus || t('voice.gamepad.showMonitor')
          "
          type="button"
          data-testid="voice-gamepad-toggle"
          @click="toggleVoiceGamepadLiveView"
        >
          <Gamepad2 class="h-4 w-4" />
        </button>
      </AgentModeTopBar>

      <main
        class="voice-main mt-3 grid min-h-0 flex-1 transition-[grid-template-columns] duration-300"
        :style="voiceMainGridStyle"
      >
        <div
          v-if="!isPhonePortrait"
          class="voice-sidebar-slot min-w-0"
          :class="{ 'voice-sidebar-slot--drawer': tvCompactSidebarDrawerOpen }"
        >
          <VoiceSessionProjectSidebar
            v-if="effectiveSidebarOpen"
            ref="voiceSidebarRef"
            :active-session-id="workspace?.session_id ?? null"
            @collapse="voiceSidebarOpen = false"
            @new-session="createFreshVoiceSession"
            @project-selected="handleVoiceProjectSelected"
            @session-selected="handleVoiceSessionSelected"
            @session-deleted="handleVoiceSessionDeleted"
          />
          <aside
            v-else
            class="flex h-full w-14 flex-col items-center border-r border-cyan-200/10 bg-black/20 py-4"
          >
            <button
              class="rounded-full border border-cyan-200/14 p-2 text-cyan-100/55 transition-colors hover:bg-cyan-200/10 hover:text-white"
              :title="t('voice.sidebar.expand')"
              @click="openSessionSidebar"
            >
              <PanelLeftOpen class="h-4 w-4" />
            </button>
            <div class="mt-4 flex flex-1 flex-col items-center gap-2 overflow-hidden">
              <button
                class="rounded-full p-2 text-cyan-100/45 transition-colors hover:bg-cyan-200/10 hover:text-white"
                :title="t('voice.sidebar.newSession')"
                @click="createFreshVoiceSession"
              >
                <Plus class="h-4 w-4" />
              </button>
              <button
                v-for="session in voiceSessionShortcuts"
                :key="session.session_id"
                class="rounded-full p-2 text-cyan-100/35 transition-colors hover:bg-cyan-200/10 hover:text-white"
                :title="session.title || session.prompt || t('voice.sidebar.newSession')"
                @click="handleVoiceSessionSelected(session.session_id)"
              >
                <MessageSquareText class="h-4 w-4" />
              </button>
            </div>
          </aside>
        </div>
        <section
          class="voice-stage relative m-6 flex min-h-0 flex-col overflow-hidden rounded-[28px] p-6"
          :class="{ 'voice-stage--status-active': Boolean(processingText) }"
        >
          <div
            v-if="processingText"
            class="voice-stage__status pointer-events-none absolute right-5 top-5 z-10 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-xs text-white/60 backdrop-blur"
          >
            {{ processingText }}
          </div>
          <div v-if="minimizedWidgets.length && generativeUiPresentation.show_legacy" class="voice-widget-shelf">
            <div
              v-for="widget in minimizedWidgets"
              :key="widget.id"
              class="voice-widget-shelf__item"
              :title="widget.title"
            >
              <span>{{ widget.title }}</span>
              <em>{{ widget.status || widget.type }}</em>
            </div>
          </div>

          <div class="voice-stage__content min-h-0 flex-1">
            <GenerativeUiShadowPreview
              v-if="generativeUiShadowPreviewActive && workspace"
              ref="generativeUiShadowPreviewRef"
              :session-id="workspace.session_id"
              :refresh-token="workspace.updated_at"
              :active-run-id="workspace.manager_run_id"
              @open-preview="openWidgetPreview"
            />
            <div
              v-if="generativeUiPresentation.show_legacy"
              ref="voiceCardGridRef"
              class="voice-card-grid"
              :class="{
                'voice-card-grid--status-active': statusFocusActive,
                'voice-card-grid--deck-active': deckPreviewFocusActive,
                'voice-card-grid--canonical-active': generativeUiPresentation.show_canonical,
                'voice-card-grid--canonical-scroll-owner': canonicalOwnsCanvasScroll
              }"
            >
              <GenerativeUiCanonicalSurface
                v-if="generativeUiPresentation.request_canonical && workspace"
                ref="generativeUiCanonicalSurfaceRef"
                :session-id="workspace.session_id"
                :refresh-token="workspace.updated_at"
                :active-run-id="workspace.manager_run_id"
                :selected-node-id="selectedGenerativeUiNodeId"
                @availability="onGenerativeUiCanonicalAvailability"
                @open-preview="openWidgetPreview"
                @select-node="selectGenerativeUiNode"
              />
              <div
                v-if="
                  !sessionTransitioning
                  && !hasVoiceStageContent
                  && !generativeUiPresentation.show_canonical
                  && (!generativeUiPresentation.request_canonical || generativeUiCanonicalResolved)
                "
                class="voice-empty-state"
              >
                <div class="voice-empty-state__kicker">{{ t('voice.canvas.dynamicCanvas') }}</div>
                <h1>{{ t('voice.canvas.emptyTitle') }}</h1>
                <p>{{ t('voice.canvas.emptyDescription') }}</p>
              </div>
              <article
                v-if="taskDraft"
                class="voice-task-card"
                :class="{ 'voice-widget--gamepad-selected': selectedWidgetId === 'task-draft' }"
                data-widget-id="task-draft"
                :style="fullGridItemStyle()"
              >
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="voice-card-kicker">{{ t('voice.task.title') }}</div>
                    <h1 class="voice-task-title">
                      {{ taskCardTitle }}
                    </h1>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <button
                      class="voice-card-tool"
                      :title="t('voice.task.cancel')"
                      :disabled="!taskDraft"
                      @click="cancelDraft"
                    >
                      <X class="h-4 w-4" />
                    </button>
                    <button
                      class="voice-card-tool voice-card-tool--primary"
                      :title="taskSubmitTitle"
                      data-testid="voice-submit-draft"
                      :disabled="
                        !taskDraft ||
                        loading ||
                        taskDraft.status === 'submitted' ||
                        taskDraft.status === 'clarifying'
                      "
                      @click="() => submitDraft()"
                    >
                      <Check class="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <p class="voice-task-body">
                  {{ taskCardBody }}
                </p>
                <ul v-if="taskDraft?.acceptance?.length" class="voice-task-checks">
                  <li v-for="item in taskDraft.acceptance.slice(0, 4)" :key="item">
                    {{ item }}
                  </li>
                </ul>
                <div v-if="taskDraft" class="voice-task-meta">
                  <span>{{
                    taskDraft.status === 'submitted'
                      ? t('voice.task.submitted')
                      : taskDraft.status === 'clarifying'
                        ? t('voice.task.clarifying')
                        : t('voice.task.waitingConfirmation')
                  }}</span>
                  <span v-if="taskDraft.acceptance?.length"
                    >{{ t('voice.task.acceptanceCount', { count: taskDraft.acceptance.length }) }}</span
                  >
                  <span v-if="taskDraft.constraints?.length"
                    >{{ t('voice.task.constraintCount', { count: taskDraft.constraints.length }) }}</span
                  >
                </div>
              </article>
              <VoiceDynamicWidget
                v-for="widget in taskContextWidgets"
                :key="widget.id"
                :widget="widget"
                class="voice-status-card"
                :class="{
                  'voice-status-card--new': isWidgetHighlighted(widget.id),
                  'voice-status-card--deck': isSlideDeckWidget(widget),
                  'voice-status-card--xhs': isXiaohongshuWidget(widget),
                  'voice-widget--gamepad-selected': selectedWidgetId === widget.id
                }"
                :data-widget-id="widget.id"
                :style="voiceGridItemStyle(widget, 'full')"
                @open-preview="openWidgetPreview"
              />
              <article
                v-for="widget in artifactWidgets"
                :key="widget.id"
                class="voice-status-card voice-status-card--artifact voice-artifact-card"
                :class="{
                  'voice-status-card--new': isWidgetHighlighted(widget.id),
                  'voice-widget--gamepad-selected': selectedWidgetId === widget.id
                }"
                :data-widget-id="widget.id"
                :style="voiceGridItemStyle(widget, 'full')"
              >
                <div class="voice-card-kicker">artifact</div>
                <div class="voice-status-row">
                  <h2>{{ widget.title }}</h2>
                  <span v-if="widget.status">{{ widget.status }}</span>
                </div>
                <p v-if="artifactDisplayBody(widget) && !isWidgetMinimized(widget)">
                  {{ artifactDisplayBody(widget) }}
                </p>
                <div
                  v-if="artifactPreviewUrl(widget) && !isWidgetMinimized(widget)"
                  class="voice-artifact-preview"
                  :class="
                    artifactPreviewKind(widget) === 'image' ||
                    artifactPreviewKind(widget) === 'gallery'
                      ? 'voice-artifact-preview--image'
                      : 'voice-artifact-preview--html'
                  "
                >
                  <img
                    v-if="
                      artifactPreviewKind(widget) === 'image' ||
                      artifactPreviewKind(widget) === 'gallery'
                    "
                    class="voice-artifact-image"
                    :src="artifactPreviewUrl(widget)"
                    :alt="widget.title || 'Artifact image'"
                    loading="lazy"
                  />
                  <iframe
                    v-else
                    class="voice-artifact-frame"
                    :src="artifactPreviewUrl(widget)"
                    sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
                    loading="lazy"
                    title="Artifact preview"
                  />
                </div>
                <div v-else class="voice-artifact-empty">{{ t('voice.canvas.artifactUnavailable') }}</div>
                <button
                  v-if="artifactPreviewUrl(widget)"
                  class="voice-card-link"
                  type="button"
                  @click="openArtifactPreview(widget)"
                >
                  {{ t('voice.canvas.openPreview') }}
                </button>
              </article>
              <article
                v-if="executionCardVisible"
                class="voice-status-card voice-status-card--dag voice-execution-card"
                :class="{
                  'voice-widget--gamepad-selected': selectedWidgetId === 'execution-status'
                }"
                data-widget-id="execution-status"
                :style="executionGridItemStyle()"
              >
                <div class="voice-card-kicker">
                  {{ codexHarnessActive ? 'Codex / DAG' : kimiHarnessActive ? 'Kimi Code / DAG' : 'Manager / DAG' }}
                </div>
                <div class="voice-status-row">
                  <h2>{{ executionCardTitle }}</h2>
                  <span v-if="executionCardStatus">{{ executionCardStatus }}</span>
                </div>
                <p v-if="executionCardBody">{{ executionCardBody }}</p>
                <div v-if="workspace?.source_issue_url" class="voice-source-issue">
                  <span>Source Issue</span>
                  <a :href="workspace.source_issue_url" target="_blank" rel="noreferrer">
                    #{{ workspace.source_issue_number || '-' }}
                  </a>
                </div>
                <div v-if="managerMessages.length" class="voice-manager-stream">
                  <div
                    v-for="message in managerMessages"
                    :key="`${message.type}-${message.text}`"
                    class="voice-manager-stream__line"
                    :class="`voice-manager-stream__line--${message.type}`"
                  >
                    {{ message.text }}
                  </div>
                </div>
                <div v-if="workspace?.manager_session_id" class="voice-card-id">
                  {{ workspace.manager_session_id }}
                </div>
                <div v-if="dagNodeRows.length" class="voice-dag-panel">
                  <div class="voice-dag-summary">
                    <span>{{ t('voice.canvas.nodes', { count: dagNodeRows.length }) }}</span>
                    <span
                      >{{ dagTelemetryTotals.toolSuccess }}/{{
                        dagTelemetryTotals.toolFailed
                      }}
                      {{ t('voice.canvas.tools') }}</span
                    >
                    <span>{{ formatTokenCount(dagTelemetryTotals.tokens) }} tok</span>
                    <span v-if="dagContextRemainingText">{{ dagContextRemainingText }}</span>
                  </div>
                  <div class="voice-dag-node-list">
                    <div
                      v-for="(node, index) in dagNodeRows"
                      :key="node.id"
                      class="voice-dag-node"
                      :class="{
                        'voice-dag-node--current': node.isCurrent,
                        'voice-dag-node--failed': node.rawStatus === 'failed',
                        'voice-dag-node--done': node.rawStatus === 'completed'
                      }"
                    >
                      <div class="voice-dag-node__main">
                        <span class="voice-dag-node__name">{{
                          dagNodeDisplayName(node, index)
                        }}</span>
                        <span class="voice-dag-node__status">{{ node.status }}</span>
                      </div>
                      <div class="voice-dag-node__metrics">
                        <span>{{ t('voice.canvas.toolMetrics', { success: node.toolSuccess, failed: node.toolFailed }) }}</span>
                        <span>{{ formatTokenCount(node.tokens) }} tok</span>
                        <span v-if="node.contextPct !== null"
                          >{{ Math.round(node.contextPct) }}%</span
                        >
                      </div>
                    </div>
                  </div>
                </div>
                <div v-if="dagSignalRows.length" class="voice-dag-signal-list">
                  <div v-for="signal in dagSignalRows" :key="signal.id" class="voice-dag-signal">
                    <div class="voice-dag-signal__head">
                      <span>{{ signal.title }}</span>
                      <em v-if="signal.status">{{ signal.status }}</em>
                    </div>
                    <p v-if="signal.body">{{ signal.body }}</p>
                    <ul v-if="signal.evidence.length">
                      <li v-for="item in signal.evidence" :key="item">{{ item }}</li>
                    </ul>
                  </div>
                </div>
                <button
                  v-if="workspace?.manager_run_id"
                  class="voice-card-link"
                  :title="t('voice.canvas.viewDag')"
                  @click="
                    store.switchToRun(workspace.manager_run_id, workspace.project_id ?? undefined)
                  "
                >
                  {{ t('voice.canvas.openRun') }}
                </button>
              </article>
              <VoiceDynamicWidget
                v-for="widget in executionWidgets"
                :key="widget.id"
                :widget="widget"
                class="voice-status-card"
                :class="{
                  'voice-status-card--new': isWidgetHighlighted(widget.id),
                  'voice-status-card--deck': isSlideDeckWidget(widget),
                  'voice-widget--gamepad-selected': selectedWidgetId === widget.id
                }"
                :data-widget-id="widget.id"
                :style="voiceGridItemStyle(widget, 'full')"
                @open-preview="openWidgetPreview"
              />
            </div>
          </div>

          <div class="voice-control mt-5 border-t border-white/10 pt-4">
            <button
              v-if="agentActivityActive"
              class="voice-agent-run-button voice-agent-run-button--running"
              :title="speaking ? agentRunStateText : `${agentRunStateText}. ${t('voice.state.tapToStop')}`"
              @click="speaking ? undefined : stopAgentLoop"
            >
              <span class="voice-agent-run-button__ring" aria-hidden="true">
                <span class="voice-agent-run-button__square" />
              </span>
              <span class="voice-agent-run-button__text">{{ agentRunButtonText }}</span>
              <span class="voice-agent-run-button__hint">{{ agentRunButtonHint }}</span>
            </button>

            <div
              v-if="isTvCompactViewport"
              class="voice-input-dock voice-input-dock--voice-only"
              data-testid="voice-input-dock"
            >
              <button
                class="voice-input-zone"
                :class="{
                  'voice-input-zone--active': listening && !voiceInputLocked,
                  'voice-input-zone--speaking': speaking,
                  'voice-input-zone--locked': voiceInputLocked,
                  'voice-input-zone--agent-running': agentActivityActive && !listening
                }"
                :title="voiceInputLocked ? processingText || voiceStateText : t('voice.composer.toggleVoice')"
                :disabled="voiceInputLocked"
                @click="toggleListening"
              >
                <span class="voice-input-zone__mic" aria-hidden="true">
                  <span v-if="speaking" class="voice-button-speaking">
                    <Volume2 class="h-5 w-5" />
                  </span>
                  <span v-else-if="listening" class="voice-button-meter">
                    <span
                      v-for="(bar, index) in voiceButtonBars"
                      :key="index"
                      :style="{ transform: `scaleY(${bar})` }"
                    />
                  </span>
                  <Mic v-else class="h-5 w-5" />
                </span>
                <span class="voice-input-zone__wave" aria-hidden="true">
                  <svg class="voice-wave-svg" viewBox="0 0 360 76" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="voiceWaveMainGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="rgba(103,232,249,0.12)" />
                        <stop offset="30%" stop-color="rgba(103,232,249,0.82)" />
                        <stop offset="62%" stop-color="rgba(45,212,191,0.74)" />
                        <stop offset="100%" stop-color="rgba(125,211,252,0.14)" />
                      </linearGradient>
                      <linearGradient id="voiceWaveUpperGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="rgba(134,239,172,0.08)" />
                        <stop offset="50%" stop-color="rgba(134,239,172,0.46)" />
                        <stop offset="100%" stop-color="rgba(45,212,191,0.08)" />
                      </linearGradient>
                      <linearGradient id="voiceWaveLowerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="rgba(45,212,191,0.1)" />
                        <stop offset="44%" stop-color="rgba(56,189,248,0.48)" />
                        <stop offset="100%" stop-color="rgba(34,211,238,0.08)" />
                      </linearGradient>
                    </defs>
                    <path
                      v-for="path in voiceWavePaths"
                      :key="path.id"
                      :class="path.className"
                      :d="path.d"
                    />
                  </svg>
                </span>
                <span class="voice-input-zone__transcript">
                  <span v-if="voiceInputStatusVisible" class="voice-input-zone__status">
                    {{ voiceStateText }}
                  </span>
                  <span class="voice-input-zone__text" :class="`voice-caption-text--${captionKind}`">
                    {{ captionText }}
                  </span>
                </span>
              </button>
            </div>
            <form
              v-else
              class="voice-composer"
              data-testid="voice-composer"
              @submit.prevent="submitComposerDraft"
            >
              <div class="voice-composer__mode" role="group" :aria-label="t('voice.composer.modeLabel')">
                <button
                  type="button"
                  class="voice-composer__mode-btn"
                  :class="{ 'voice-composer__mode-btn--active': !voiceInputAssist }"
                  :disabled="!voiceInputAssist"
                  :title="t('voice.composer.realtimeTitle')"
                  @click="voiceInputAssist ? toggleVoiceInputAssist() : undefined"
                >
                  {{ t('voice.composer.realtime') }}
                </button>
                <button
                  type="button"
                  class="voice-composer__mode-btn"
                  :class="{ 'voice-composer__mode-btn--active': voiceInputAssist }"
                  :disabled="voiceInputAssist"
                  :title="t('voice.composer.assistTitle')"
                  @click="voiceInputAssist ? undefined : toggleVoiceInputAssist()"
                >
                  {{ t('voice.composer.assist') }}
                </button>
              </div>
              <div class="voice-composer__row">
                <button
                  class="voice-composer__mic"
                  :class="{
                    'voice-composer__mic--active': listening && !voiceInputLocked,
                    'voice-composer__mic--speaking': speaking,
                    'voice-composer__mic--locked': voiceInputLocked
                  }"
                  type="button"
                  :title="voiceInputLocked ? processingText || voiceStateText : t('voice.composer.toggleVoice')"
                  :disabled="voiceInputLocked"
                  :aria-label="t('voice.composer.voiceInput')"
                  @click="toggleListening"
                >
                  <Volume2 v-if="speaking" class="h-5 w-5" />
                  <span v-else-if="listening" class="voice-composer__meter">
                    <span
                      v-for="(bar, index) in voiceButtonBars"
                      :key="index"
                      :style="{ transform: `scaleY(${bar})` }"
                    />
                  </span>
                  <Mic v-else class="h-5 w-5" />
                </button>
                <textarea
                  ref="composerRef"
                  v-model="codexTextDraft"
                  class="voice-composer__field"
                  data-testid="voice-codex-text-input"
                  :placeholder="composerPlaceholder"
                  autocomplete="off"
                  spellcheck="false"
                  rows="1"
                  @keydown="handleComposerKeydown"
                />
                <button
                  class="voice-composer__send"
                  type="submit"
                  data-testid="voice-codex-text-submit"
                  :disabled="composerSubmitDisabled"
                  :title="t('voice.composer.send')"
                  :aria-label="t('voice.composer.send')"
                >
                  <SendHorizontal class="h-5 w-5" />
                </button>
              </div>
            </form>
          </div>
          <div v-if="error" class="mt-2 text-sm text-red-300">{{ error }}</div>
        </section>

        <aside
          v-if="!isPhonePortrait"
          class="min-w-0 overflow-hidden py-6 pr-6 transition-opacity duration-300"
          :class="effectiveDetailsOpen ? 'opacity-100' : 'pointer-events-none opacity-0'"
        >
          <section
            class="flex h-full min-h-0 flex-col rounded-3xl border border-white/10 bg-white/[0.045] p-5"
          >
            <div class="mb-4 flex items-center justify-between">
              <div class="flex items-center gap-2 text-sm text-white/50">
                <MessageSquareText class="h-4 w-4" />
                {{ t('voice.sidebar.records') }}
              </div>
              <button
                class="rounded-full p-1.5 text-white/35 transition hover:bg-white/10 hover:text-white/80"
                :title="t('voice.sidebar.hideDetails')"
                @click="toggleDetails"
              >
                <EyeOff class="h-4 w-4" />
              </button>
            </div>
            <div
              ref="conversationThreadRef"
              class="voice-thread min-h-0 flex-1 overflow-y-auto pr-1"
            >
              <div
                v-for="item in conversationItems"
                :key="item.id"
                class="voice-thread-item"
                :class="[
                  item.role === 'user' ? 'voice-thread-item--user' : 'voice-thread-item--assistant',
                  item.channel === 'commentary' ? 'voice-thread-item--commentary' : '',
                  item.kind === 'error' ? 'voice-thread-item--error' : ''
                ]"
                :title="item.text"
              >
                <span v-if="item.kind === 'error'" class="voice-thread-item__error-label">
                  <AlertTriangle class="h-3.5 w-3.5" />
                  {{ t('voice.sidebar.executionError') }}
                </span>
                <span v-if="item.channel === 'commentary'" class="voice-thread-item__channel"
                  >commentary</span
                >
                {{ item.text }}
              </div>
              <div
                v-if="!conversationItems.length"
                class="px-1 py-2 text-sm leading-6 text-white/35"
              >
                {{ t('voice.sidebar.emptyRecords') }}
              </div>
            </div>
          </section>
        </aside>
      </main>

      <div
        v-if="artifactPreviewModal"
        class="voice-artifact-modal"
        :class="{ 'voice-artifact-modal--portrait': artifactPreviewModal.layout === 'portrait' }"
        role="dialog"
        aria-modal="true"
        @click.self="closeArtifactPreview"
      >
        <section class="voice-artifact-modal__panel" :style="artifactPreviewModalStyle">
          <header class="voice-artifact-modal__head">
            <div>
              <span>artifact preview</span>
              <h2>{{ artifactPreviewModal.title }}</h2>
            </div>
            <button
              class="voice-card-tool"
              type="button"
              :title="t('voice.preview.close')"
              @click="closeArtifactPreview"
            >
              <X class="h-4 w-4" />
            </button>
          </header>
          <div
            v-if="artifactPreviewModal.kind === 'image' || artifactPreviewModal.kind === 'gallery'"
            class="voice-artifact-modal__image-stage"
          >
            <img
              class="voice-artifact-modal__image"
              :src="artifactPreviewCurrentImage"
              :alt="artifactPreviewModal.title"
            />
            <div
              v-if="artifactPreviewModal.kind === 'gallery' && artifactPreviewImages.length > 1"
              class="voice-artifact-modal__counter"
            >
              {{ artifactPreviewImageIndex + 1 }} / {{ artifactPreviewImages.length }}
            </div>
            <button
              v-if="artifactPreviewModal.kind === 'gallery' && artifactPreviewImages.length > 1"
              class="voice-artifact-modal__nav voice-artifact-modal__nav--prev"
              type="button"
              :title="t('voice.preview.previous')"
              :disabled="!canPreviewPrevImage"
              @click="prevArtifactPreviewImage"
            >
              <ChevronLeft class="h-5 w-5" />
            </button>
            <button
              v-if="artifactPreviewModal.kind === 'gallery' && artifactPreviewImages.length > 1"
              class="voice-artifact-modal__nav voice-artifact-modal__nav--next"
              type="button"
              :title="t('voice.preview.next')"
              :disabled="!canPreviewNextImage"
              @click="nextArtifactPreviewImage"
            >
              <ChevronRight class="h-5 w-5" />
            </button>
            <div
              v-if="artifactPreviewModal.kind === 'gallery' && artifactPreviewImages.length > 1"
              class="voice-artifact-modal__dots"
              :aria-label="t('voice.preview.pagination')"
            >
              <button
                v-for="(_, index) in artifactPreviewImages"
                :key="index"
                class="voice-artifact-modal__dot"
                :class="{
                  'voice-artifact-modal__dot--active': index === artifactPreviewImageIndex
                }"
                type="button"
                :aria-label="t('voice.preview.goToPage', { page: index + 1 })"
                @click="showArtifactPreviewImage(index)"
              />
            </div>
          </div>
          <div v-else class="voice-artifact-modal__frame-stage">
            <iframe
              class="voice-artifact-modal__frame"
              :src="artifactPreviewModal.url"
              sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
              title="Artifact preview"
            />
          </div>
        </section>
      </div>

      <div
        v-if="voiceGamepadNoticeVisible || voiceGamepadLiveVisible"
        class="voice-gamepad-connect"
        :class="{ 'voice-gamepad-connect--live': voiceGamepadLiveVisible }"
        aria-live="polite"
      >
        <div class="voice-gamepad-connect__glow" />
        <svg
          class="voice-gamepad-connect__svg"
          viewBox="0 0 420 260"
          role="img"
          :aria-label="t('voice.gamepad.buttonStatus')"
        >
          <g class="voice-gamepad-connect__shoulders">
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(6) }"
              x="74"
              y="26"
              width="72"
              height="24"
              rx="12"
            />
            <text x="110" y="43">L2</text>
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(7) }"
              x="274"
              y="26"
              width="72"
              height="24"
              rx="12"
            />
            <text x="310" y="43">R2</text>
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(4) }"
              x="84"
              y="54"
              width="82"
              height="26"
              rx="13"
            />
            <text x="125" y="73">L1</text>
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(5) }"
              x="254"
              y="54"
              width="82"
              height="26"
              rx="13"
            />
            <text x="295" y="73">R1</text>
          </g>
          <path
            class="voice-gamepad-connect__body"
            d="M84 92c28-28 70-41 126-41s98 13 126 41c27 28 47 73 57 128 4 22-13 40-35 40-24 0-40-22-57-51-12-19-26-27-47-27h-88c-21 0-35 8-47 27-17 29-33 51-57 51-22 0-39-18-35-40 10-55 30-100 57-128Z"
          />
          <path
            class="voice-gamepad-connect__touch"
            :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(17) }"
            d="M158 84h104c10 0 17 7 17 17v31c0 10-7 17-17 17H158c-10 0-17-7-17-17v-31c0-10 7-17 17-17Z"
          />
          <g class="voice-gamepad-connect__center">
            <circle
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(8) }"
              cx="173"
              cy="161"
              r="8"
            />
            <text x="173" y="183">SH</text>
            <circle
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(16) }"
              cx="210"
              cy="168"
              r="9"
            />
            <text x="210" y="191">PS</text>
            <circle
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(9) }"
              cx="247"
              cy="161"
              r="8"
            />
            <text x="247" y="183">OP</text>
          </g>
          <g class="voice-gamepad-connect__sticks">
            <circle
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(10) }"
              cx="135"
              cy="174"
              r="23"
            />
            <text x="135" y="179">L3</text>
            <circle
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(11) }"
              cx="285"
              cy="174"
              r="23"
            />
            <text x="285" y="179">R3</text>
          </g>
          <g class="voice-gamepad-connect__dpad">
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(12) }"
              x="99"
              y="110"
              width="20"
              height="20"
              rx="4"
            />
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(13) }"
              x="99"
              y="150"
              width="20"
              height="20"
              rx="4"
            />
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(14) }"
              x="79"
              y="130"
              width="20"
              height="20"
              rx="4"
            />
            <rect
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(15) }"
              x="119"
              y="130"
              width="20"
              height="20"
              rx="4"
            />
          </g>
          <g class="voice-gamepad-connect__face">
            <circle
              class="voice-gamepad-connect__button--triangle"
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(3) }"
              cx="318"
              cy="111"
              r="11"
            />
            <text x="318" y="115">△</text>
            <circle
              class="voice-gamepad-connect__button--circle"
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(1) }"
              cx="344"
              cy="137"
              r="11"
            />
            <text x="344" y="141">○</text>
            <circle
              class="voice-gamepad-connect__button--cross"
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(0) }"
              cx="318"
              cy="163"
              r="11"
            />
            <text x="318" y="167">×</text>
            <circle
              class="voice-gamepad-connect__button--square"
              :class="{ 'voice-gamepad-connect__part--active': gamepadButtonActive(2) }"
              cx="292"
              cy="137"
              r="11"
            />
            <text x="292" y="141">□</text>
          </g>
        </svg>
        <div class="voice-gamepad-connect__copy">
          <strong>{{ voiceGamepadNoticeName }}</strong>
          <span>{{ voiceGamepadLiveVisible ? t('voice.gamepad.monitoring') : t('voice.gamepad.connected') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.voice-cockpit {
  --ambient-a: rgba(34, 211, 238, 0.14);
  --ambient-b: rgba(59, 130, 246, 0.1);
  width: 100vw;
  height: 100vh;
  height: 100svh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100svh;
  min-height: 100dvh;
  overflow: hidden;
}

:global(html.voice-cockpit-root-active),
:global(body.voice-cockpit-root-active),
:global(#app.voice-cockpit-root-active) {
  background: #031313 !important;
}

:global(html.voice-cockpit-root-active),
:global(body.voice-cockpit-root-active) {
  min-height: 100%;
  overflow: hidden;
}

.voice-cockpit--listening {
  --ambient-a: rgba(45, 212, 191, 0.25);
  --ambient-b: rgba(14, 165, 233, 0.16);
}

.voice-cockpit--speaking {
  --ambient-a: rgba(217, 70, 239, 0.2);
  --ambient-b: rgba(99, 102, 241, 0.16);
}

.voice-cockpit--thinking {
  --ambient-a: rgba(250, 204, 21, 0.14);
  --ambient-b: rgba(20, 184, 166, 0.12);
}

.voice-shell {
  height: 100vh;
  height: 100svh;
  height: 100dvh;
  min-height: 0;
}

.voice-cockpit :deep(.agent-mode-topbar) {
  position: relative;
  z-index: 140;
  overflow: visible;
}

.voice-cockpit :deep(.agent-mode-topbar__left) {
  overflow: visible;
}

.voice-cockpit--native-shell :deep(.agent-mode-topbar) {
  padding-left: 76px;
}

.voice-model-menu {
  position: relative;
  z-index: 160;
  flex: 0 0 auto;
}

.voice-model-menu__button {
  display: inline-flex;
  height: 36px;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.035);
  padding: 0 12px;
  color: rgba(236, 254, 255, 0.78);
  font-size: 13px;
  font-weight: 720;
  letter-spacing: 0;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    color 160ms ease;
}

.voice-model-menu__button:hover,
.voice-model-menu__button[aria-expanded='true'] {
  border-color: rgba(103, 232, 249, 0.28);
  background: rgba(103, 232, 249, 0.1);
  color: rgba(255, 255, 255, 0.94);
}

.voice-model-menu__button--alert {
  border-color: rgba(251, 191, 36, 0.42);
  background: rgba(251, 191, 36, 0.13);
  color: rgba(254, 243, 199, 0.96);
  box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.08) inset;
}

.voice-model-menu__button--alert:hover {
  border-color: rgba(251, 191, 36, 0.58);
  background: rgba(251, 191, 36, 0.18);
  color: rgba(255, 251, 235, 1);
}

.voice-model-menu__popover {
  position: absolute;
  z-index: 170;
  top: calc(100% + 10px);
  left: 0;
  width: min(460px, calc(100vw - 32px));
  pointer-events: auto;
  border: 1px solid rgba(103, 232, 249, 0.18);
  border-radius: 18px;
  background: rgba(5, 12, 14, 0.96);
  padding: 12px;
  box-shadow:
    0 24px 72px rgba(0, 0, 0, 0.45),
    0 0 0 1px rgba(255, 255, 255, 0.035) inset;
  backdrop-filter: blur(18px);
}

.voice-model-menu__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 4px 10px;
}

.voice-model-menu__header span {
  color: rgba(255, 255, 255, 0.9);
  font-size: 14px;
  font-weight: 760;
}

.voice-model-menu__header em,
.voice-model-menu__label em {
  min-width: 0;
  overflow: hidden;
  color: rgba(207, 250, 254, 0.46);
  font-size: 12px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-model-menu__row {
  display: grid;
  grid-template-columns: minmax(132px, 0.86fr) minmax(210px, 1.14fr);
  gap: 12px;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding: 11px 4px;
}

.voice-model-menu__row--disabled {
  opacity: 0.62;
}

.voice-model-menu__label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.voice-model-menu__label strong {
  color: rgba(236, 254, 255, 0.86);
  font-size: 13px;
  font-weight: 760;
}

.voice-model-menu__controls {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(92px, 0.72fr) minmax(0, 1.28fr);
  gap: 8px;
}

.voice-model-menu__row select,
.voice-model-menu__controls select {
  min-width: 0;
  width: 100%;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
  padding: 0 12px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 13px;
  outline: none;
}

.voice-model-menu__row select:disabled {
  color: rgba(255, 255, 255, 0.42);
}

.voice-model-menu__footer {
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding: 10px 4px 2px;
  color: rgba(252, 165, 165, 0.9);
  font-size: 12px;
}

.voice-stage {
  --stage-glow: rgba(34, 211, 238, 0);
  border: 0;
  background: transparent;
  box-shadow: none;
  transition: background 260ms ease;
}

.voice-widget-shelf {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
  min-height: 34px;
  margin-bottom: 10px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.voice-widget-shelf::-webkit-scrollbar {
  display: none;
}

.voice-widget-shelf__item {
  display: inline-flex;
  flex: 0 0 auto;
  max-width: 220px;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(103, 232, 249, 0.16);
  border-radius: 999px;
  background: rgba(6, 24, 28, 0.72);
  padding: 7px 10px;
  color: rgba(228, 255, 255, 0.82);
  box-shadow: 0 0 18px rgba(20, 184, 166, 0.08);
}

.voice-widget-shelf__item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 760;
}

.voice-widget-shelf__item em {
  flex: 0 0 auto;
  color: rgba(125, 230, 224, 0.72);
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}

.voice-cockpit--listening .voice-stage {
  --stage-glow: rgba(45, 212, 191, 0.12);
  animation: voice-stage-listening 1.35s ease-in-out infinite;
}

.voice-cockpit--thinking .voice-stage {
  --stage-glow: rgba(250, 204, 21, 0.08);
  animation: voice-stage-thinking 1.45s ease-in-out infinite;
}

.voice-cockpit--speaking .voice-stage {
  --stage-glow: rgba(217, 70, 239, 0.1);
  animation: voice-stage-speaking 1.5s ease-in-out infinite;
}

@media (max-width: 1280px), (max-height: 760px) {
  .voice-shell {
    padding: 10px;
  }

  :deep(.agent-mode-topbar) {
    height: 50px;
  }

  .voice-stage {
    margin: 12px;
    padding: 18px;
    border-radius: 22px;
  }

  .voice-card-grid {
    gap: 12px;
  }

  .voice-task-card,
  .voice-status-card {
    padding: 18px;
  }

  .voice-task-title,
  .voice-status-row h2 {
    font-size: 24px;
  }

  .voice-task-body {
    font-size: 15px;
  }

  .voice-control {
    min-height: 68px;
    margin-top: 12px;
    padding-top: 12px;
  }
}

.voice-sidebar-slot {
  overflow: hidden;
}

/* Android TV exposes 1920x1080 as a 960x540 CSS viewport on Box R 4K Plus. */
.voice-cockpit--tv-compact .voice-shell {
  padding: 8px;
}

.voice-cockpit--tv-compact :deep(.agent-mode-topbar) {
  height: 42px;
  min-height: 42px;
  padding: 4px 8px;
}

.voice-cockpit--tv-compact :deep(.agent-mode-topbar__brand),
.voice-cockpit--tv-compact :deep(.agent-mode-topbar__mode) {
  display: none;
}

.voice-cockpit--tv-compact :deep(.agent-mode-topbar__left),
.voice-cockpit--tv-compact :deep(.agent-mode-topbar__right) {
  gap: 6px;
}

.voice-cockpit--tv-compact .voice-main {
  margin-top: 6px;
}

.voice-cockpit--tv-compact .voice-sidebar-slot {
  position: relative;
  z-index: 40;
  overflow: visible;
}

.voice-cockpit--tv-compact .voice-sidebar-slot--drawer {
  z-index: 160;
}

.voice-cockpit--tv-compact .voice-sidebar-slot--drawer :deep(.voice-left-rail) {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: min(292px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  border: 1px solid rgb(103 232 249 / 16%);
  border-radius: 18px;
  background: rgb(3 14 18 / 94%);
  box-shadow: 18px 0 44px rgb(0 0 0 / 45%);
  backdrop-filter: blur(18px);
}

.voice-cockpit--tv-compact .voice-sidebar-slot > aside {
  width: 44px;
  padding-top: 10px;
  padding-bottom: 10px;
}

.voice-cockpit--tv-compact .voice-sidebar-slot > aside button {
  padding: 7px;
}

.voice-cockpit--tv-compact .voice-stage {
  margin: 8px;
  padding: 14px;
  border-radius: 20px;
}

.voice-cockpit--tv-compact .voice-stage__status {
  right: 12px;
  top: 12px;
  max-width: min(260px, 62%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-cockpit--tv-compact .voice-card-grid {
  gap: 10px;
}

.voice-cockpit--tv-compact .voice-empty-state h1 {
  font-size: 26px;
}

.voice-cockpit--tv-compact .voice-empty-state p {
  max-width: 360px;
  font-size: 14px;
  line-height: 1.55;
}

.voice-cockpit--tv-compact .voice-task-card,
.voice-cockpit--tv-compact .voice-status-card {
  padding: 14px;
  border-radius: 16px;
}

.voice-cockpit--tv-compact .voice-task-title,
.voice-cockpit--tv-compact .voice-status-row h2 {
  font-size: 21px;
}

.voice-cockpit--tv-compact .voice-task-body {
  font-size: 13px;
}

.voice-cockpit--tv-compact .voice-control {
  min-height: 58px;
  margin-top: 10px;
  padding-top: 10px;
}

.voice-cockpit--tv-compact .voice-input-zone {
  min-height: 56px;
  grid-template-columns: 40px minmax(0, 1fr) minmax(88px, 28%);
  gap: 8px;
  padding: 8px;
  border-radius: 18px;
}

.voice-cockpit--tv-compact .voice-input-zone__mic {
  height: 40px;
  width: 40px;
}

.voice-cockpit--tv-compact .voice-input-zone__wave {
  height: 34px;
}

.voice-cockpit--tv-compact .voice-input-zone__transcript {
  min-width: 0;
  overflow: hidden;
  padding-left: 8px;
}

.voice-cockpit--tv-compact .voice-input-zone__status {
  display: none;
}

.voice-cockpit--tv-compact .voice-input-zone__text {
  min-height: 0;
  -webkit-line-clamp: 2;
  font-size: 13px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.voice-cockpit--tv-compact .voice-main > aside:last-child {
  padding-top: 8px;
  padding-right: 8px;
  padding-bottom: 8px;
}

.voice-cockpit--tv-compact .voice-main > aside:last-child > section {
  padding: 12px;
  border-radius: 18px;
}

.voice-cockpit--tv-compact .voice-thread {
  gap: 8px;
}

.voice-cockpit--tv-compact .voice-thread-item {
  max-width: 100%;
  padding: 8px 9px;
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.45;
}

.voice-cockpit--mobile {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  height: 100svh;
  height: 100dvh;
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
}

.voice-nosleep-video,
.voice-tts-audio {
  position: fixed;
  left: -1px;
  top: -1px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.voice-cockpit--mobile .voice-shell {
  padding-top: max(10px, env(safe-area-inset-top));
  padding-right: max(10px, env(safe-area-inset-right));
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  padding-left: max(10px, env(safe-area-inset-left));
}

.voice-cockpit--mobile :deep(.agent-mode-topbar__brand),
.voice-cockpit--mobile :deep(.agent-mode-topbar__mode) {
  display: none;
}

.voice-fullscreen-gate {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 0;
  background:
    radial-gradient(circle at 50% 38%, rgba(34, 211, 238, 0.22), transparent 30%),
    rgba(4, 7, 10, 0.92);
  color: rgba(255, 255, 255, 0.92);
  text-align: center;
  backdrop-filter: blur(16px);
}

.voice-fullscreen-gate span {
  font-size: 22px;
  font-weight: 720;
  letter-spacing: 0;
}

.voice-fullscreen-gate em {
  color: rgba(207, 250, 254, 0.6);
  font-size: 13px;
  font-style: normal;
}

.voice-fullscreen-gate strong {
  margin-top: 8px;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.28);
  background: rgba(103, 232, 249, 0.12);
  padding: 8px 14px;
  color: rgba(236, 254, 255, 0.92);
  font-size: 13px;
  font-weight: 700;
}

.voice-cockpit--phone-portrait {
  background: #031313;
}

.voice-cockpit--phone-portrait .voice-cockpit__ambient {
  background:
    radial-gradient(circle at 50% 34%, var(--ambient-a), transparent 34%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.018), transparent 36%),
    linear-gradient(180deg, rgba(3, 19, 19, 0) 58%, #031313 100%);
}

.voice-cockpit--phone-portrait .voice-shell {
  padding-bottom: 0;
}

.voice-cockpit--phone-portrait :deep(.agent-mode-topbar) {
  min-height: 48px;
  height: auto;
  border-radius: 20px;
  padding: 6px;
}

.voice-cockpit--phone-portrait :deep(.agent-mode-topbar__left) {
  gap: 8px;
}

.voice-cockpit--phone-portrait :deep(.agent-mode-topbar select) {
  max-width: 128px;
  font-size: 12px;
}

.voice-cockpit--phone-portrait .voice-main {
  margin-top: 8px;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) !important;
  grid-template-rows: minmax(0, 1fr);
}

.voice-cockpit--phone-portrait .voice-stage {
  margin: 0;
  min-height: 0;
  height: 100%;
  background:
    radial-gradient(circle at 50% 30%, rgba(20, 184, 166, 0.14), transparent 34%),
    linear-gradient(180deg, rgba(5, 24, 24, 0.82) 0%, rgba(5, 16, 17, 0.96) 58%, #031313 100%);
  padding: 14px 14px max(14px, env(safe-area-inset-bottom));
  border-radius: 20px 20px 0 0;
}

.voice-cockpit--phone-portrait .voice-stage__status {
  top: 12px;
  right: 12px;
  max-width: calc(100% - 28px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-cockpit--phone-portrait .voice-stage--status-active .voice-stage__content {
  padding-top: 44px;
}

.voice-cockpit--phone-portrait .voice-stage__content {
  display: flex;
  min-height: 0;
  overflow: hidden;
  padding-bottom: 112px;
}

.voice-cockpit--phone-portrait .voice-card-grid,
.voice-cockpit--phone-portrait .voice-card-grid--status-active {
  min-height: 0;
  height: 100%;
  flex: 1;
  grid-auto-flow: column;
  grid-auto-columns: minmax(100%, 100%);
  grid-template-columns: none;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  align-content: stretch;
  gap: 14px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
  scroll-padding-inline: 0;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.voice-cockpit--phone-portrait .voice-card-grid::-webkit-scrollbar {
  display: none;
}

.voice-cockpit--phone-portrait .voice-empty-state {
  grid-row: 1 / -1;
  min-height: 100%;
  padding: 24px 8px;
  scroll-snap-align: start;
}

.voice-cockpit--phone-portrait .voice-empty-state h1 {
  font-size: 28px;
}

.voice-cockpit--phone-portrait .voice-empty-state p {
  font-size: 14px;
}

.voice-cockpit--phone-portrait .voice-task-card,
.voice-cockpit--phone-portrait .voice-status-card {
  height: 100%;
  min-height: 0;
  border-radius: 16px;
  padding: 16px;
  overflow-y: auto;
  scroll-snap-align: start;
}

.voice-cockpit--phone-portrait .voice-task-card,
.voice-cockpit--phone-portrait .voice-status-card,
.voice-cockpit--phone-portrait .voice-execution-card,
.voice-cockpit--phone-portrait .voice-artifact-card {
  grid-row: 1 / -1;
}

.voice-cockpit--phone-portrait .voice-task-title,
.voice-cockpit--phone-portrait .voice-status-row h2 {
  max-height: none;
  white-space: normal;
  font-size: 24px;
  line-height: 1.2;
}

.voice-cockpit--phone-portrait .voice-task-body,
.voice-cockpit--phone-portrait .voice-status-card p {
  max-height: none;
  font-size: 14px;
}

.voice-cockpit--phone-portrait .voice-task-checks li,
.voice-cockpit--phone-portrait .voice-card-insight li,
.voice-cockpit--phone-portrait .voice-manager-stream__line {
  white-space: normal;
}

.voice-cockpit--phone-portrait .voice-dag-node-list {
  max-height: 28dvh;
}

.voice-cockpit--phone-portrait .voice-control {
  position: absolute;
  right: 14px;
  bottom: max(8px, env(safe-area-inset-bottom));
  left: 14px;
  min-height: 78px;
  margin-top: 0;
  gap: 8px;
  padding-top: 10px;
  padding-bottom: 0;
}

.voice-cockpit--phone-portrait .voice-caption-bar {
  min-height: 54px;
  border-radius: 20px;
  padding: 8px 14px;
}

.voice-cockpit--phone-portrait .voice-caption-text {
  display: -webkit-box;
  min-height: 20px;
  overflow: hidden;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 15px;
  line-height: 1.35;
}

.voice-cockpit--phone-portrait .voice-agent-run-button {
  height: 34px;
  padding: 0 10px;
  font-size: 12px;
}

.voice-cockpit--phone-portrait .voice-agent-run-button__hint {
  display: none;
}

.voice-cockpit--phone-portrait .voice-composer__row {
  min-height: 64px;
  grid-template-columns: 48px minmax(0, 1fr) 48px;
  gap: 8px;
  border-radius: 22px;
  padding: 8px;
}

.voice-cockpit--phone-portrait .voice-composer__field {
  min-height: 46px;
  max-height: 92px;
  border-radius: 16px;
  padding: 10px 12px;
  font-size: 14px;
}

.voice-cockpit--phone-portrait .voice-composer__mic,
.voice-cockpit--phone-portrait .voice-composer__send {
  border-radius: 18px;
}

.voice-cockpit--phone-landscape .voice-shell {
  height: auto;
  min-height: 0;
  transform-origin: top left;
  padding: 16px;
}

.voice-cockpit--phone-landscape :deep(.agent-mode-topbar) {
  height: 56px;
  border-radius: 9999px;
  padding-inline: 12px;
}

.voice-cockpit--phone-landscape :deep(.agent-mode-topbar__left) {
  overflow: visible;
  gap: 12px;
}

.voice-cockpit--phone-landscape :deep(.agent-mode-topbar select) {
  max-width: 220px;
  font-size: 14px;
}

.voice-cockpit--phone-landscape .voice-main {
  margin-top: 12px;
}

.voice-cockpit--phone-landscape .voice-stage {
  margin: 24px;
  padding: 24px;
  border-radius: 28px;
}

.voice-cockpit--phone-landscape .voice-card-grid {
  min-height: 100%;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 32px) / 3);
  grid-template-columns: none !important;
  grid-template-rows: repeat(2, minmax(0, 1fr)) !important;
  align-content: stretch;
  gap: 16px;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}

.voice-cockpit--phone-landscape .voice-card-grid::-webkit-scrollbar {
  height: 0;
}

.voice-cockpit--phone-landscape .voice-task-card,
.voice-cockpit--phone-landscape .voice-status-card {
  height: 100%;
  padding: 22px;
  overflow-y: auto;
  scroll-snap-align: start;
}

.voice-cockpit--phone-landscape .voice-task-card,
.voice-cockpit--phone-landscape .voice-status-card,
.voice-cockpit--phone-landscape .voice-execution-card,
.voice-cockpit--phone-landscape .voice-artifact-card {
  grid-row: 1 / -1;
}

.voice-cockpit--phone-landscape .voice-task-title,
.voice-cockpit--phone-landscape .voice-status-row h2 {
  max-height: 112px;
  font-size: clamp(25px, 2.05vw, 34px);
}

.voice-cockpit--phone-landscape .voice-task-body {
  max-height: 132px;
  font-size: clamp(15px, 1.1vw, 18px);
}

.voice-cockpit--phone-landscape .voice-control {
  min-height: 68px;
  margin-top: 12px;
  padding-top: 12px;
}

.voice-cockpit--phone-landscape .voice-caption-bar {
  min-height: 56px;
  padding: 10px 24px;
}

.voice-cockpit--phone-landscape .voice-agent-run-button {
  height: 34px;
}

.voice-card-grid {
  display: grid;
  height: 100%;
  min-height: 100%;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 32px) / 3);
  grid-template-columns: none;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  align-items: stretch;
  gap: 16px;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}

.voice-card-grid > :deep(.generative-ui-canonical-surface) {
  grid-column: span 3;
}

.voice-cockpit--phone-portrait .voice-card-grid > :deep(.generative-ui-canonical-surface) {
  grid-column: span 1;
}

.voice-card-grid--status-active {
  grid-template-columns: none;
}

.voice-card-grid--deck-active {
  grid-template-rows: repeat(3, minmax(0, 1fr));
}

.voice-card-grid--canonical-scroll-owner {
  overflow-x: clip;
  scroll-snap-type: none;
}

.voice-card-grid--canonical-active:not(.voice-card-grid--canonical-scroll-owner) {
  scrollbar-width: none;
}

.voice-card-grid--canonical-active:not(.voice-card-grid--canonical-scroll-owner)::-webkit-scrollbar {
  display: none;
}

.voice-card-grid--status-active .voice-task-card {
  order: -1;
  grid-row: auto;
}

.voice-card-grid--status-active .voice-status-card--dag {
  min-height: 220px;
}

.voice-task-card,
.voice-status-card {
  height: 100%;
  min-height: 0;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  scroll-snap-align: start;
}

.voice-status-card--new {
  animation: voice-widget-new-pulse 4.2s ease-out;
}

.voice-task-card {
  border-color: rgba(103, 232, 249, 0.16);
  background:
    radial-gradient(circle at 82% 0%, rgba(103, 232, 249, 0.11), transparent 34%),
    rgba(6, 182, 212, 0.055);
  padding: 22px;
  overflow: hidden;
}

.voice-empty-state {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
  display: flex;
  min-height: 0;
  flex-direction: column;
  justify-content: center;
  padding: 40px;
  color: rgba(255, 255, 255, 0.58);
}

.voice-empty-state__kicker {
  color: rgba(103, 232, 249, 0.58);
  font-size: 12px;
  font-weight: 680;
  letter-spacing: 0;
}

.voice-empty-state h1 {
  margin-top: 12px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 34px;
  font-weight: 720;
  letter-spacing: 0;
  line-height: 1.15;
}

.voice-empty-state p {
  margin-top: 14px;
  max-width: 520px;
  color: rgba(255, 255, 255, 0.52);
  font-size: 15px;
  line-height: 1.7;
}

.voice-card-kicker {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0;
  color: rgba(207, 250, 254, 0.5);
}

.voice-task-title {
  margin-top: 14px;
  max-height: 112px;
  overflow: hidden;
  color: white;
  font-size: clamp(25px, 2.05vw, 34px);
  font-weight: 720;
  line-height: 1.18;
  letter-spacing: 0;
}

.voice-task-body {
  margin-top: 22px;
  max-height: 132px;
  overflow: hidden;
  white-space: pre-wrap;
  color: rgba(255, 255, 255, 0.68);
  font-size: clamp(15px, 1.1vw, 18px);
  font-weight: 520;
  line-height: 1.7;
}

.voice-task-checks {
  margin-top: 16px;
  display: grid;
  gap: 8px;
}

.voice-task-checks li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.055);
  padding: 7px 9px;
  color: rgba(236, 254, 255, 0.68);
  font-size: 13px;
  line-height: 1.25;
}

.voice-task-meta {
  margin-top: 22px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.voice-task-meta span {
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.16);
  background: rgba(103, 232, 249, 0.07);
  padding: 5px 9px;
  color: rgba(207, 250, 254, 0.62);
  font-size: 12px;
  font-weight: 620;
}

.voice-status-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
  overflow: hidden;
  padding: 20px;
}

.voice-status-card--tall {
  grid-row: span 2;
}

.voice-status-card--manager {
  border-color: rgba(110, 231, 183, 0.16);
  background:
    radial-gradient(circle at 90% 0%, rgba(110, 231, 183, 0.1), transparent 38%),
    rgba(16, 185, 129, 0.045);
}

.voice-status-card--dag {
  border-color: rgba(147, 197, 253, 0.16);
  background:
    radial-gradient(circle at 90% 0%, rgba(147, 197, 253, 0.11), transparent 38%),
    rgba(59, 130, 246, 0.045);
}

.voice-status-card--status,
.voice-status-card--notification {
  border-color: rgba(251, 191, 36, 0.18);
  background:
    radial-gradient(circle at 90% 0%, rgba(251, 191, 36, 0.1), transparent 38%),
    rgba(251, 191, 36, 0.045);
}

.voice-status-card--list,
.voice-status-card--note {
  border-color: rgba(196, 181, 253, 0.17);
  background:
    radial-gradient(circle at 90% 0%, rgba(196, 181, 253, 0.1), transparent 38%),
    rgba(139, 92, 246, 0.045);
}

.voice-status-card--progress {
  border-color: rgba(45, 212, 191, 0.18);
  background:
    radial-gradient(circle at 90% 0%, rgba(45, 212, 191, 0.1), transparent 38%),
    rgba(20, 184, 166, 0.045);
}

.voice-status-card--artifact {
  border-color: rgba(103, 232, 249, 0.18);
  background:
    radial-gradient(circle at 90% 0%, rgba(103, 232, 249, 0.12), transparent 38%),
    rgba(14, 116, 144, 0.06);
}

.voice-status-card--deck {
  border-color: rgba(101, 247, 232, 0.2);
  background:
    radial-gradient(circle at 88% 0%, rgba(101, 247, 232, 0.12), transparent 34%),
    rgba(5, 23, 30, 0.72);
}

.voice-status-card--xhs {
  padding: 14px;
  border-color: rgba(255, 123, 143, 0.22);
  background:
    radial-gradient(circle at 88% 0%, rgba(255, 123, 143, 0.1), transparent 34%),
    rgba(7, 24, 28, 0.72);
}

.voice-status-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.voice-status-row h2 {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.92);
  font-size: 24px;
  font-weight: 720;
  letter-spacing: 0;
}

.voice-status-row span {
  flex: 0 0 auto;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  padding: 5px 9px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 12px;
  font-weight: 650;
}

.voice-status-card p {
  max-height: 92px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.58);
  font-size: 14px;
  line-height: 1.55;
}

.voice-execution-card {
  min-height: 0;
  overflow-y: auto;
}

.voice-artifact-card {
  min-height: 280px;
}

.voice-artifact-preview {
  min-height: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  background: #020617;
}

.voice-artifact-preview--image {
  background: radial-gradient(circle at 50% 40%, rgba(34, 211, 238, 0.1), transparent 48%), #020617;
}

.voice-artifact-image {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  object-position: center;
}

.voice-artifact-frame {
  min-height: 0;
  flex: 1;
  width: 100%;
  height: 100%;
  border: 0;
  background: #020617;
}

.voice-artifact-empty {
  display: flex;
  min-height: 140px;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px dashed rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.42);
  font-size: 13px;
}

.voice-artifact-modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
  padding: 34px;
  backdrop-filter: blur(18px);
}

.voice-artifact-modal__panel {
  display: flex;
  width: min(1320px, 94vw);
  height: min(840px, 88vh);
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-radius: 24px;
  border: 1px solid rgba(103, 232, 249, 0.22);
  background:
    radial-gradient(circle at 78% 0%, rgba(34, 211, 238, 0.12), transparent 34%),
    rgba(3, 13, 18, 0.98);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.56);
}

.voice-artifact-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 16px 18px 14px 22px;
}

.voice-artifact-modal__head span {
  color: rgba(103, 232, 249, 0.56);
  font-size: 11px;
  font-weight: 760;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.voice-artifact-modal__head h2 {
  margin-top: 4px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 20px;
  font-weight: 720;
  letter-spacing: 0;
}

.voice-artifact-modal__frame-stage {
  min-height: 0;
  flex: 1;
  width: 100%;
  overflow: hidden;
  background: #020617;
}

.voice-artifact-modal__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #020617;
}

.voice-artifact-modal--portrait {
  padding: 18px;
}

.voice-artifact-modal--portrait .voice-artifact-modal__panel {
  width: var(--artifact-preview-width);
  height: auto;
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
}

.voice-artifact-modal--portrait .voice-artifact-modal__head {
  flex: 0 0 auto;
  padding: 14px 16px;
}

.voice-artifact-modal--portrait .voice-artifact-modal__head h2 {
  display: -webkit-box;
  max-height: 2.35em;
  overflow: hidden;
  font-size: clamp(18px, 3vw, 24px);
  line-height: 1.15;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.voice-artifact-modal--portrait .voice-artifact-modal__frame-stage {
  flex: 0 0 auto;
  width: var(--artifact-preview-width);
  height: var(--artifact-preview-height);
  max-width: 100%;
  align-self: center;
}

.voice-artifact-modal--portrait .voice-artifact-modal__frame {
  width: 1080px;
  height: 1440px;
  transform: scale(var(--artifact-preview-scale));
  transform-origin: top left;
}

.voice-artifact-modal__image-stage {
  position: relative;
  min-height: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 40%, rgba(34, 211, 238, 0.08), transparent 44%), #020617;
}

.voice-artifact-modal__image {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  object-position: center;
}

.voice-artifact-modal--portrait .voice-artifact-modal__image-stage {
  flex: 0 0 auto;
  width: var(--artifact-preview-width);
  height: var(--artifact-preview-height);
  max-width: 100%;
  align-self: center;
}

.voice-artifact-modal__counter {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(2, 6, 23, 0.62);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 720;
}

.voice-artifact-modal__nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  transform: translateY(-50%);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(2, 6, 23, 0.54);
  color: rgba(255, 255, 255, 0.9);
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    opacity 0.18s ease;
}

.voice-artifact-modal__nav:hover:not(:disabled) {
  border-color: rgba(122, 255, 238, 0.36);
  background: rgba(8, 31, 35, 0.72);
}

.voice-artifact-modal__nav:disabled {
  cursor: not-allowed;
  opacity: 0.34;
}

.voice-artifact-modal__nav--prev {
  left: 12px;
}

.voice-artifact-modal__nav--next {
  right: 12px;
}

.voice-artifact-modal__dots {
  position: absolute;
  right: 0;
  bottom: 13px;
  left: 0;
  z-index: 2;
  display: flex;
  justify-content: center;
  gap: 8px;
}

.voice-artifact-modal__dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.34);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.24);
}

.voice-artifact-modal__dot--active {
  width: 20px;
  background: #ff3b58;
  box-shadow: none;
}

.voice-source-issue {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-radius: 12px;
  border: 1px solid rgba(147, 197, 253, 0.16);
  background: rgba(147, 197, 253, 0.06);
  padding: 10px 12px;
}

.voice-source-issue span {
  color: rgba(219, 234, 254, 0.54);
  font-size: 12px;
  font-weight: 650;
}

.voice-source-issue a {
  color: rgba(224, 242, 254, 0.9);
  font-size: 13px;
  font-weight: 720;
}

.voice-card-insights {
  margin-top: 14px;
  display: grid;
  gap: 10px;
}

.voice-card-insights--execution {
  margin-top: 0;
}

.voice-card-insight {
  min-width: 0;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.045);
  padding: 11px 12px;
}

.voice-card-insight--minimized {
  padding-block: 8px;
}

.voice-card-insight__head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.voice-card-insight__head span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.78);
  font-size: 13px;
  font-weight: 690;
}

.voice-card-insight__head em {
  flex: 0 0 auto;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.08);
  padding: 3px 7px;
  color: rgba(255, 255, 255, 0.58);
  font-size: 11px;
  font-style: normal;
  font-weight: 650;
}

.voice-card-insight p {
  margin-top: 8px;
  max-height: 54px;
  color: rgba(255, 255, 255, 0.56);
  font-size: 12px;
  line-height: 1.5;
}

.voice-card-insight ul,
.voice-card-insight ol {
  margin-top: 8px;
  display: grid;
  gap: 5px;
  color: rgba(255, 255, 255, 0.58);
  font-size: 12px;
  line-height: 1.35;
}

.voice-card-insight li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-card-insight ul li::before {
  content: '';
  display: inline-block;
  height: 5px;
  width: 5px;
  margin-right: 8px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.34);
  vertical-align: 2px;
}

.voice-manager-stream {
  margin-top: 16px;
  display: grid;
  max-height: 138px;
  gap: 6px;
  overflow-y: auto;
  padding-right: 3px;
}

.voice-manager-stream__line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-left: 2px solid rgba(110, 231, 183, 0.28);
  padding-left: 9px;
  color: rgba(236, 253, 245, 0.68);
  font-size: 12px;
  line-height: 1.35;
}

.voice-manager-stream__line--error {
  border-left-color: rgba(248, 113, 113, 0.55);
  color: rgba(254, 202, 202, 0.78);
}

.voice-dag-panel {
  margin-top: 16px;
  min-height: 0;
}

.voice-dag-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.voice-dag-summary span {
  border-radius: 9999px;
  border: 1px solid rgba(147, 197, 253, 0.16);
  background: rgba(147, 197, 253, 0.07);
  padding: 4px 8px;
  color: rgba(219, 234, 254, 0.68);
  font-size: 11px;
  font-weight: 650;
}

.voice-dag-node-list {
  margin-top: 10px;
  display: grid;
  max-height: min(34dvh, 280px);
  gap: 7px;
  overflow-y: auto;
  padding-right: 3px;
}

.voice-dag-node {
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(255, 255, 255, 0.035);
  padding: 9px 10px;
}

.voice-dag-node--current {
  border-color: rgba(34, 211, 238, 0.36);
  background: rgba(34, 211, 238, 0.08);
}

.voice-dag-node--failed {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.06);
}

.voice-dag-node--done {
  border-color: rgba(74, 222, 128, 0.26);
  background: rgba(74, 222, 128, 0.055);
}

.voice-dag-node__main,
.voice-dag-node__metrics {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.voice-dag-node__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.84);
  font-size: 13px;
  font-weight: 680;
}

.voice-dag-node__status {
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.56);
  font-size: 11px;
  font-weight: 650;
}

.voice-dag-node__metrics {
  margin-top: 5px;
  justify-content: flex-start;
  color: rgba(255, 255, 255, 0.45);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}

.voice-dag-signal-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.voice-dag-signal {
  border-radius: 12px;
  border: 1px solid rgba(45, 212, 191, 0.12);
  background: rgba(3, 18, 22, 0.58);
  padding: 10px 11px;
}

.voice-dag-signal__head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.voice-dag-signal__head span {
  min-width: 0;
  overflow: hidden;
  color: rgba(224, 255, 252, 0.8);
  font-size: 12px;
  font-weight: 760;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-dag-signal__head em {
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(45, 212, 191, 0.1);
  padding: 3px 7px;
  color: rgba(153, 246, 228, 0.72);
  font-size: 10px;
  font-style: normal;
  font-weight: 760;
}

.voice-dag-signal p {
  max-height: none;
  margin-top: 7px;
  color: rgba(226, 247, 247, 0.62);
  font-size: 12px;
  line-height: 1.45;
}

.voice-dag-signal ul {
  display: grid;
  gap: 4px;
  margin-top: 7px;
}

.voice-dag-signal li {
  overflow: hidden;
  color: rgba(197, 230, 230, 0.48);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-card-id {
  margin-top: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.38);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.voice-card-link {
  margin-top: 18px;
  align-self: flex-start;
  border-radius: 9999px;
  border: 1px solid rgba(147, 197, 253, 0.2);
  background: rgba(147, 197, 253, 0.08);
  padding: 7px 11px;
  color: rgba(219, 234, 254, 0.78);
  font-size: 12px;
  font-weight: 650;
  transition:
    background 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}

.voice-card-link:hover {
  border-color: rgba(147, 197, 253, 0.34);
  background: rgba(147, 197, 253, 0.14);
  color: rgba(239, 246, 255, 0.94);
}

.voice-widget-list,
.voice-widget-steps {
  margin-top: 14px;
  display: grid;
  gap: 7px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 13px;
  line-height: 1.35;
}

.voice-widget-list li,
.voice-widget-steps li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-widget-list li::before {
  content: '';
  display: inline-block;
  height: 5px;
  width: 5px;
  margin-right: 8px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.38);
  vertical-align: 2px;
}

.voice-widget-steps {
  list-style-position: inside;
}

.voice-widget-steps__item--active {
  color: rgba(204, 251, 241, 0.92);
  font-weight: 680;
}

.voice-card-tool {
  display: inline-flex;
  height: 34px;
  width: 34px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  color: rgba(255, 255, 255, 0.58);
  transition:
    background 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    opacity 160ms ease;
}

.voice-card-tool:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.86);
}

.voice-card-tool:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.voice-card-tool--primary {
  border-color: rgba(110, 231, 183, 0.32);
  background: rgba(110, 231, 183, 0.14);
  color: rgba(209, 250, 229, 0.94);
}

.voice-caption-bar {
  display: flex;
  min-height: 56px;
  flex-direction: column;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.24);
  padding: 10px 24px;
}

.voice-cockpit--speaking .voice-caption-bar {
  border-color: rgba(110, 231, 183, 0.28);
  background: rgba(16, 185, 129, 0.1);
}

.voice-caption-text {
  min-height: 22px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 16px;
  font-weight: 620;
  letter-spacing: 0;
}

.voice-caption-text--state {
  color: rgba(255, 255, 255, 0.68);
}

.voice-caption-text--user {
  color: rgba(255, 255, 255, 0.92);
}

.voice-caption-text--assistant {
  color: rgba(190, 242, 255, 0.86);
}

.voice-control {
  display: flex;
  min-height: 88px;
  flex-direction: column;
  gap: 10px;
}

.voice-pending-send {
  margin-top: 8px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border-radius: 14px;
  border: 1px solid rgba(103, 232, 249, 0.14);
  background: rgba(103, 232, 249, 0.06);
  padding: 7px 8px 7px 12px;
}

.voice-pending-send__label {
  color: rgba(207, 250, 254, 0.5);
  font-size: 12px;
  font-weight: 680;
}

.voice-pending-send__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(236, 254, 255, 0.86);
  font-size: 13px;
  font-weight: 560;
}

.voice-pending-send__button {
  display: inline-flex;
  height: 26px;
  width: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.58);
  transition:
    background 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    opacity 160ms ease;
}

.voice-pending-send__button:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
}

.voice-pending-send__button--primary {
  border-color: rgba(110, 231, 183, 0.3);
  background: rgba(110, 231, 183, 0.12);
  color: rgba(209, 250, 229, 0.92);
}

.voice-pending-send__button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.voice-mode-button,
.voice-agent-run-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  transition:
    background 160ms ease,
    color 160ms ease,
    opacity 160ms ease;
}

.voice-mode-button {
  height: 40px;
  width: 40px;
  color: rgba(255, 255, 255, 0.48);
}

.voice-mode-button--active {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.86);
}

.voice-agent-run-button {
  align-self: flex-end;
  height: 36px;
  width: auto;
  flex: 0 0 auto;
  gap: 9px;
  border: 1px solid rgba(34, 211, 238, 0.22);
  background: rgba(34, 211, 238, 0.08);
  padding: 0 13px 0 10px;
  color: rgba(207, 250, 254, 0.92);
  font-size: 13px;
  font-weight: 720;
  letter-spacing: 0;
}

.voice-agent-run-button:hover {
  border-color: rgba(103, 232, 249, 0.4);
  background: rgba(34, 211, 238, 0.14);
}

.voice-agent-run-button__text {
  white-space: nowrap;
}

.voice-agent-run-button__hint {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
  padding-left: 9px;
  color: rgba(207, 250, 254, 0.54);
  font-weight: 620;
}

.voice-agent-run-button:disabled {
  cursor: default;
}

.voice-agent-run-button__ring {
  position: relative;
  display: inline-flex;
  height: 18px;
  width: 18px;
  align-items: center;
  justify-content: center;
  border: 2px solid rgba(207, 250, 254, 0.22);
  border-top-color: currentColor;
  border-radius: 9999px;
  animation: voice-agent-run-spin 0.9s linear infinite;
}

.voice-agent-run-button__square {
  height: 6px;
  width: 6px;
  border-radius: 2px;
  background: currentColor;
  box-shadow: 0 0 18px rgba(34, 211, 238, 0.34);
}

.voice-input-dock {
  display: grid;
  width: 100%;
  align-items: stretch;
  gap: 10px;
}

.voice-input-dock--voice-only {
  grid-template-columns: minmax(0, 1fr);
}

.voice-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.voice-composer__mode {
  display: inline-flex;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  border-radius: 16px;
  border: 1px solid rgba(103, 232, 249, 0.12);
  background: rgba(255, 255, 255, 0.04);
}

.voice-composer__mode-btn {
  min-width: 56px;
  padding: 5px 14px;
  border-radius: 13px;
  border: none;
  background: transparent;
  color: rgba(236, 254, 255, 0.56);
  font-size: 12px;
  font-weight: 720;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition:
    background 160ms ease,
    color 160ms ease;
}

.voice-composer__mode-btn--active {
  background: rgba(13, 148, 136, 0.32);
  color: rgba(236, 254, 255, 0.96);
}

.voice-composer__mode-btn:disabled {
  cursor: default;
}

.voice-composer__row {
  display: grid;
  min-height: 72px;
  width: 100%;
  grid-template-columns: 52px minmax(0, 1fr) 52px;
  align-items: stretch;
  gap: 10px;
  border-radius: 24px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background:
    linear-gradient(90deg, rgba(8, 47, 45, 0.66), rgba(4, 12, 18, 0.68)), rgba(0, 0, 0, 0.26);
  padding: 10px;
  box-shadow:
    inset 0 0 0 1px rgba(103, 232, 249, 0.025),
    0 16px 38px rgba(8, 47, 73, 0.12);
}

.voice-composer__mic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(236, 254, 255, 0.82);
  transition:
    border-color 160ms ease,
    background 160ms ease,
    color 160ms ease,
    box-shadow 160ms ease;
}

.voice-composer__mic:hover:not(:disabled),
.voice-composer__mic:focus-visible {
  border-color: rgba(103, 232, 249, 0.4);
  background: rgba(13, 148, 136, 0.18);
  color: rgba(236, 254, 255, 0.96);
}

.voice-composer__mic--active {
  border-color: rgba(103, 232, 249, 0.5);
  background: rgba(13, 148, 136, 0.26);
  box-shadow: 0 0 0 1px rgba(103, 232, 249, 0.18) inset;
}

.voice-composer__mic--speaking {
  border-color: rgba(45, 212, 191, 0.5);
  color: rgba(94, 234, 212, 0.96);
}

.voice-composer__mic:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.voice-composer__meter {
  display: inline-flex;
  align-items: flex-end;
  gap: 3px;
  height: 22px;
}

.voice-composer__meter > span {
  display: block;
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(180deg, rgba(103, 232, 249, 0.9), rgba(45, 212, 191, 0.5));
  transform-origin: bottom center;
}

.voice-composer__field {
  min-height: 50px;
  max-height: 116px;
  min-width: 0;
  resize: vertical;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: rgba(0, 0, 0, 0.24);
  padding: 13px 15px;
  color: rgba(236, 254, 255, 0.94);
  font-size: 15px;
  font-weight: 620;
  line-height: 1.45;
  letter-spacing: 0;
  outline: none;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.voice-composer__field::placeholder {
  color: rgba(148, 163, 184, 0.64);
}

.voice-composer__field:focus {
  border-color: rgba(103, 232, 249, 0.36);
  box-shadow: inset 0 0 0 1px rgba(103, 232, 249, 0.1);
}

.voice-composer__send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid rgba(45, 212, 191, 0.24);
  background: rgba(13, 148, 136, 0.28);
  color: rgba(236, 254, 255, 0.96);
  transition:
    background 160ms ease,
    opacity 160ms ease;
}

.voice-composer__send:hover:not(:disabled),
.voice-composer__send:focus-visible {
  background: rgba(13, 148, 136, 0.46);
}

.voice-composer__send:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.voice-input-zone {
  position: relative;
  display: grid;
  min-height: 72px;
  width: 100%;
  grid-template-columns: 56px minmax(160px, 1fr) minmax(220px, 34%);
  align-items: center;
  gap: 18px;
  overflow: hidden;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background:
    linear-gradient(90deg, rgba(8, 47, 45, 0.7), rgba(4, 12, 18, 0.62)), rgba(0, 0, 0, 0.24);
  padding: 10px 18px;
  color: rgba(236, 254, 255, 0.82);
  text-align: left;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease,
    opacity 160ms ease;
}

.voice-input-zone:hover:not(:disabled),
.voice-input-zone--active {
  border-color: rgba(103, 232, 249, 0.32);
  background:
    linear-gradient(90deg, rgba(13, 148, 136, 0.16), rgba(8, 47, 73, 0.18)), rgba(0, 0, 0, 0.3);
  box-shadow:
    inset 0 0 0 1px rgba(103, 232, 249, 0.04),
    0 16px 38px rgba(8, 47, 73, 0.18);
}

.voice-input-zone--speaking {
  border-color: rgba(110, 231, 183, 0.3);
  background:
    linear-gradient(90deg, rgba(16, 185, 129, 0.12), rgba(6, 78, 59, 0.14)), rgba(0, 0, 0, 0.3);
}

.voice-input-zone--locked {
  cursor: not-allowed;
  opacity: 0.62;
}

.voice-input-zone--agent-running {
  border-color: rgba(45, 212, 191, 0.2);
}

.voice-input-zone__mic {
  display: inline-flex;
  height: 50px;
  width: 50px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgba(103, 232, 249, 0.18);
  background: rgba(255, 255, 255, 0.055);
  color: rgba(236, 254, 255, 0.82);
  box-shadow: inset 0 0 18px rgba(45, 212, 191, 0.04);
}

.voice-input-zone--active .voice-input-zone__mic {
  border-color: rgba(103, 232, 249, 0.42);
  background: rgba(34, 211, 238, 0.14);
  color: rgba(236, 254, 255, 0.98);
  box-shadow:
    0 0 0 8px rgba(34, 211, 238, 0.06),
    inset 0 0 24px rgba(45, 212, 191, 0.14);
}

.voice-input-zone__wave {
  position: relative;
  display: block;
  min-width: 0;
  height: 46px;
  opacity: 0.62;
}

.voice-wave-svg {
  display: block;
  height: 100%;
  width: 100%;
  overflow: visible;
}

.voice-wave-line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  transition:
    d 80ms linear,
    opacity 120ms ease;
}

.voice-wave-line--main {
  stroke: url(#voiceWaveMainGradient);
  stroke-width: 1.25;
  opacity: 0.82;
  filter: drop-shadow(0 0 5px rgba(34, 211, 238, 0.14));
}

.voice-wave-line--upper {
  stroke: url(#voiceWaveUpperGradient);
  stroke-width: 0.9;
  opacity: 0.38;
}

.voice-wave-line--lower {
  stroke: url(#voiceWaveLowerGradient);
  stroke-width: 0.9;
  opacity: 0.34;
}

.voice-input-zone--active .voice-input-zone__wave {
  opacity: 1;
}

.voice-input-zone--active .voice-wave-line--upper,
.voice-input-zone--active .voice-wave-line--lower {
  opacity: 0.52;
}

.voice-input-zone__transcript {
  min-width: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.09);
  padding-left: 18px;
}

.voice-input-zone__status {
  display: block;
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(103, 232, 249, 0.6);
  font-size: 12px;
  font-weight: 760;
}

.voice-input-zone__text {
  display: -webkit-box;
  min-height: 22px;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  font-size: 16px;
  font-weight: 660;
  line-height: 1.38;
  letter-spacing: 0;
}

.voice-button-meter {
  display: inline-flex;
  height: 24px;
  width: 28px;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.voice-button-meter span {
  height: 22px;
  width: 3px;
  border-radius: 9999px;
  background: currentColor;
  opacity: 0.9;
  transform-origin: 50% 100%;
  transition: transform 80ms linear;
}

.voice-button-speaking {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  animation: voice-button-speaking 1.1s ease-in-out infinite;
}

.voice-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.voice-thread-item {
  max-width: 92%;
  border-radius: 18px;
  padding: 10px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.55;
}

.voice-thread-item--user {
  align-self: flex-end;
  background: rgba(255, 255, 255, 0.085);
  color: rgba(255, 255, 255, 0.72);
}

.voice-thread-item--assistant {
  align-self: flex-start;
  background: rgba(20, 184, 166, 0.16);
  color: rgba(236, 253, 245, 0.86);
}

.voice-thread-item--error {
  max-width: 100%;
  border: 1px solid rgba(248, 113, 113, 0.34);
  background: rgba(127, 29, 29, 0.22);
  color: rgba(254, 226, 226, 0.92);
}

.voice-thread-item__error-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: rgba(252, 165, 165, 0.95);
  font-size: 11px;
  font-weight: 700;
}

.voice-thread-item--commentary {
  border: 1px solid rgba(20, 184, 166, 0.2);
  background: rgba(20, 184, 166, 0.16);
  color: rgba(236, 253, 245, 0.86);
}

.voice-thread-item__channel {
  margin-right: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(153, 246, 228, 0.72);
}

.voice-debug-item {
  margin-top: 6px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  padding: 8px 9px;
  color: rgba(255, 255, 255, 0.48);
  font-size: 12px;
  line-height: 1.45;
}

.voice-debug-item span {
  margin-right: 6px;
  color: rgba(255, 255, 255, 0.32);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.voice-debug-item--error {
  border-color: rgba(248, 113, 113, 0.16);
  color: rgba(254, 202, 202, 0.72);
}

.voice-debug-item--warning {
  border-color: rgba(251, 191, 36, 0.16);
  color: rgba(253, 230, 138, 0.72);
}

.voice-control__mic {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
}

.voice-control__mic--active {
  border-color: rgba(103, 232, 249, 0.34);
  background: rgba(34, 211, 238, 0.13);
  color: rgba(236, 254, 255, 0.92);
}

.voice-cockpit__ambient {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 34%, var(--ambient-a), transparent 34%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.025), transparent 36%),
    radial-gradient(circle at 50% 112%, var(--ambient-b), transparent 42%);
  transition:
    background 420ms ease,
    opacity 420ms ease;
}

.voice-cockpit--listening .voice-cockpit__ambient,
.voice-cockpit--speaking .voice-cockpit__ambient {
  animation: voice-bg-pulse 1.55s ease-in-out infinite;
}

.voice-widget--gamepad-selected {
  border-color: rgba(125, 255, 231, 0.72) !important;
  box-shadow:
    0 0 0 1px rgba(125, 255, 231, 0.44),
    0 0 38px rgba(20, 184, 166, 0.24) !important;
}

.voice-widget--gamepad-selected
  :is(button, a, input, select, textarea, [role='button'], [tabindex]):focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.94);
  outline-offset: 3px;
}

.voice-runtime-pill--gamepad {
  min-width: 42px;
  justify-content: center;
}

.voice-runtime-pill--gamepad.text-emerald-100 {
  box-shadow: 0 0 22px rgba(52, 211, 153, 0.18);
}

.voice-runtime-pill--gamepad-live {
  box-shadow:
    0 0 0 1px rgba(125, 255, 231, 0.24),
    0 0 26px rgba(45, 212, 191, 0.22);
}

.voice-gamepad-connect {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 100;
  display: flex;
  width: min(360px, calc(100vw - 40px));
  min-height: 168px;
  overflow: hidden;
  align-items: center;
  gap: 18px;
  border: 1px solid rgba(125, 255, 231, 0.2);
  border-radius: 26px;
  background: rgba(5, 15, 18, 0.86);
  padding: 18px 20px;
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.46),
    0 0 42px rgba(45, 212, 191, 0.15);
  backdrop-filter: blur(22px);
  animation: voice-gamepad-pop 3.6s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.voice-gamepad-connect--live {
  z-index: 120;
  animation: voice-gamepad-live-in 220ms ease-out both;
}

.voice-gamepad-connect--live .voice-gamepad-connect__glow,
.voice-gamepad-connect--live .voice-gamepad-connect__svg {
  animation: none;
}

.voice-gamepad-connect__glow {
  position: absolute;
  inset: -40%;
  background:
    radial-gradient(circle at 24% 46%, rgba(125, 255, 231, 0.24), transparent 24%),
    radial-gradient(circle at 70% 24%, rgba(147, 197, 253, 0.2), transparent 28%);
  animation: voice-gamepad-glow 3.6s ease both;
}

.voice-gamepad-connect__svg {
  position: relative;
  z-index: 1;
  flex: 0 0 210px;
  height: 130px;
  filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.35));
  animation: voice-gamepad-float 3.6s ease both;
}

.voice-gamepad-connect__body {
  fill: rgba(237, 255, 252, 0.95);
}

.voice-gamepad-connect__touch {
  fill: rgba(9, 23, 27, 0.72);
}

.voice-gamepad-connect__shoulders rect,
.voice-gamepad-connect__center circle,
.voice-gamepad-connect__sticks circle,
.voice-gamepad-connect__dpad rect,
.voice-gamepad-connect__face circle,
.voice-gamepad-connect__touch {
  fill: rgba(13, 28, 33, 0.88);
  stroke: rgba(125, 255, 231, 0.34);
  stroke-width: 2;
  transition:
    fill 120ms ease,
    stroke 120ms ease,
    filter 120ms ease;
}

.voice-gamepad-connect__shoulders text,
.voice-gamepad-connect__center text,
.voice-gamepad-connect__sticks text,
.voice-gamepad-connect__face text {
  fill: rgba(237, 255, 252, 0.78);
  font-size: 13px;
  font-weight: 760;
  text-anchor: middle;
  pointer-events: none;
}

.voice-gamepad-connect__part--active {
  fill: rgba(45, 212, 191, 0.95) !important;
  stroke: rgba(236, 254, 255, 0.96) !important;
  filter: drop-shadow(0 0 8px rgba(45, 212, 191, 0.72));
}

.voice-gamepad-connect__button--triangle {
  stroke: #67e8f9;
}
.voice-gamepad-connect__button--circle {
  stroke: #fda4af;
}
.voice-gamepad-connect__button--cross {
  stroke: #93c5fd;
}
.voice-gamepad-connect__button--square {
  stroke: #c4b5fd;
}

.voice-gamepad-connect__copy {
  position: relative;
  z-index: 1;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.voice-gamepad-connect__copy strong {
  color: #effffd;
  font-size: 18px;
  font-weight: 820;
}

.voice-gamepad-connect__copy span {
  color: rgba(198, 255, 246, 0.74);
  font-size: 13px;
}

@keyframes voice-bg-pulse {
  0%,
  100% {
    opacity: 0.72;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.03);
  }
}

@keyframes voice-stage-listening {
  0%,
  100% {
    box-shadow:
      0 0 0 0 rgba(45, 212, 191, 0.08),
      0 28px 80px rgba(0, 0, 0, 0.38);
  }
  50% {
    box-shadow:
      0 0 0 5px rgba(45, 212, 191, 0.1),
      0 32px 90px rgba(20, 184, 166, 0.08);
  }
}

@keyframes voice-stage-thinking {
  0%,
  100% {
    box-shadow:
      0 0 0 0 rgba(250, 204, 21, 0.06),
      0 28px 80px rgba(0, 0, 0, 0.38);
  }
  50% {
    box-shadow:
      0 0 0 5px rgba(250, 204, 21, 0.075),
      0 32px 90px rgba(20, 184, 166, 0.07);
  }
}

@keyframes voice-stage-speaking {
  0% {
    box-shadow:
      0 0 0 0 rgba(217, 70, 239, 0.06),
      0 28px 80px rgba(0, 0, 0, 0.38);
  }
  50% {
    box-shadow:
      0 0 0 5px rgba(217, 70, 239, 0.09),
      0 32px 90px rgba(99, 102, 241, 0.08);
  }
  100% {
    box-shadow:
      0 0 0 0 rgba(217, 70, 239, 0.06),
      0 28px 80px rgba(0, 0, 0, 0.38);
  }
}

@keyframes voice-button-speaking {
  0%,
  100% {
    transform: scale(0.96);
    opacity: 0.72;
  }
  50% {
    transform: scale(1.08);
    opacity: 1;
  }
}

@keyframes voice-agent-run-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes voice-widget-new-pulse {
  0% {
    border-color: rgba(103, 232, 249, 0.7);
    box-shadow:
      0 0 0 1px rgba(103, 232, 249, 0.5),
      0 0 52px rgba(45, 212, 191, 0.32);
  }

  48% {
    border-color: rgba(103, 232, 249, 0.42);
  }

  100% {
    border-color: rgba(255, 255, 255, 0.1);
    box-shadow: none;
  }
}

@keyframes voice-gamepad-pop {
  0% {
    transform: translateY(26px) scale(0.92);
    opacity: 0;
  }
  14% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  88% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
  100% {
    transform: translateY(18px) scale(0.98);
    opacity: 0;
  }
}

@keyframes voice-gamepad-float {
  0% {
    transform: translateY(10px) rotate(-4deg);
  }
  18%,
  88% {
    transform: translateY(0) rotate(0deg);
  }
  100% {
    transform: translateY(6px) rotate(2deg);
  }
}

@keyframes voice-gamepad-glow {
  0% {
    transform: translateX(-14px);
    opacity: 0;
  }
  18%,
  88% {
    transform: translateX(0);
    opacity: 1;
  }
  100% {
    transform: translateX(12px);
    opacity: 0;
  }
}

@keyframes voice-gamepad-live-in {
  from {
    transform: translateY(12px) scale(0.97);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

@media (max-width: 1024px) {
  .voice-cockpit:not(.voice-cockpit--phone-landscape):not(.voice-cockpit--phone-portrait)
    .voice-card-grid > :deep(.generative-ui-canonical-surface) {
    grid-column: span 1;
  }

  .voice-cockpit:not(.voice-cockpit--phone-landscape):not(.voice-cockpit--phone-portrait)
    .voice-card-grid {
    grid-template-columns: 1fr;
    grid-template-rows: repeat(2, minmax(0, 1fr));
    grid-auto-columns: minmax(100%, 100%);
  }

  .voice-cockpit:not(.voice-cockpit--phone-landscape):not(.voice-cockpit--phone-portrait)
    .voice-card-grid--deck-active {
    grid-template-rows: repeat(3, minmax(0, 1fr));
  }

  .voice-cockpit:not(.voice-cockpit--phone-landscape):not(.voice-cockpit--phone-portrait)
    .voice-task-card {
    grid-row: auto;
  }
}
</style>

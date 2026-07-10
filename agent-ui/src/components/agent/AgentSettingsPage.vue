<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  FolderTree,
  GitBranch,
  Loader2,
  Mic,
  Network,
  Package,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Trash2,
  Volume2,
  X,
  XCircle,
} from 'lucide-vue-next'
import ModelSettings from './settings/ModelSettings.vue'
import {
  listProjects,
  listProjectStorages,
  listNodes,
  agentSettingsApi,
  type AgentRuntimeStatus,
  type AgentWorkspaceSettings,
  type AgentStorageRetentionInfo,
  type LLMSetting,
  type GitServer,
  type MCPServer,
  type MCPServerType,
  type VoiceAgentConfig,
  listMemories,
  getMemoryStats,
  createMemory,
  deleteMemory,
  deleteSkill,
  listSkills,
  uploadSkill,
  listVoiceModels,
  testVoiceConnection,
  getExperienceGraphSummary,
  getAssetDiagnostics,
  getOrchestrationTemplates,
  getCodexModels,
  type VoiceSettings,
  type VoiceTtsOutputChannel,
  type CodexModel,
  type ExperienceGraphSummary,
  type AssetDiagnostics,
  type OrchestrationTemplate,
} from '@/api/agent'
import {
  clearVoiceHidButtonBinding,
  clearVoiceKeyboardButtonBinding,
  findPressedByte,
  formatVoiceHidBinding,
  formatVoiceKeyboardBinding,
  getHidApi,
  keyboardBindingFromEvent,
  loadVoiceHidButtonBinding,
  loadVoiceKeyboardButtonBinding,
  loadVoiceVadSilenceMs,
  saveVoiceVadSilenceMs,
  saveVoiceHidButtonBinding,
  saveVoiceKeyboardButtonBinding,
  voiceHidSupported,
  type VoiceHidButtonBinding,
  type VoiceKeyboardButtonBinding,
} from '@/utils/voice-hid-control'
import {
  clearVoiceAudioInputDeviceId,
  listVoiceAudioInputDevices,
  loadVoiceAudioInputDeviceId,
  saveVoiceAudioInputDeviceId,
  type VoiceAudioInputDevice,
} from '@/utils/voice-audio-input'
import {
  androidTvWireGuardAvailable,
  clearAndroidTvWireGuardConfig,
  connectAndroidTvWireGuard,
  createEmptyWireGuardConfig,
  createEmptyWireGuardStatus,
  disconnectAndroidTvWireGuard,
  getAndroidTvWireGuardConfig,
  getAndroidTvWireGuardStatus,
  parseWireGuardRawConfig,
  saveAndroidTvWireGuardConfig,
  type AndroidTvWireGuardConfig,
  type AndroidTvWireGuardStatus,
} from '@/utils/android-tv-wireguard'
import { isAndroidTvShell } from '@/utils/voice-host-platform'
import { VOICE_GAMEPAD_BUTTON } from './voice-gamepad-router'
import {
  NATIVE_GAMEPAD_ANALOG_EVENT,
  NATIVE_GAMEPAD_BUTTON_EVENT,
  nativeGamepadEventDetail,
  type NativeGamepadAnalogDetail,
  type NativeGamepadButtonDetail,
} from '@/utils/native-gamepad-events'
import { useAgentStore } from '@/stores/agent-store'
import { useToast } from '@/components/controls/useToast'
import type { MemoryItem, MemoryStats } from '@/api/types/memory.types'
import type { Node } from '@/api/types/node.types'
import type { Project, ProjectStorage } from '@/api/types/project.types'
import type { Provider, Skill } from '@/api/types/orchestration-v2.types'

type SettingsTab =
  | 'workspace'
  | 'nodes'
  | 'git'
  | 'providers'
  | 'voice'
  | 'device'
  | 'skills'
  | 'mcp'
  | 'memory'

const store = useAgentStore()
const router = useRouter()
const { showToast: showGlobalToast } = useToast()
let settingsGamepadFrame = 0
let settingsGamepadPressedButtons = new Set<number>()
let settingsGamepadAxisLocks = new Set<string>()
let nativeSettingsGamepadAnalogAt = 0
const activeTab = ref<SettingsTab>('git')
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref<string | null>(null)

const projects = ref<Project[]>([])
const selectedProjectId = ref<string | null>(null)
const projectStorages = ref<ProjectStorage[]>([])
const nodes = ref<Node[]>([])
const gitServers = ref<GitServer[]>([])
const providers = ref<Provider[]>([])
const llmSettings = ref<LLMSetting[]>([])
const skills = ref<Skill[]>([])
const mcpServers = ref<MCPServer[]>([])
const memories = ref<MemoryItem[]>([])
const memoryStats = ref<MemoryStats | null>(null)
const experienceGraph = ref<ExperienceGraphSummary | null>(null)
const experienceGraphError = ref<string | null>(null)
const assetDiagnostics = ref<AssetDiagnostics | null>(null)
const assetDiagnosticsError = ref<string | null>(null)
const orchestrationTemplates = ref<OrchestrationTemplate[]>([])
const orchestrationTemplatesError = ref<string | null>(null)
const runtimeStatus = ref<AgentRuntimeStatus | null>(null)
const workspaceSettings = ref<AgentWorkspaceSettings | null>(null)
const storageInfo = ref<AgentStorageRetentionInfo | null>(null)
const voiceSettings = ref<VoiceSettings | null>(null)
const voiceAgentConfig = ref<VoiceAgentConfig | null>(null)
const codexModels = ref<CodexModel[]>([])
const voiceForm = ref({
  recognition_mode: 'asr' as 'omni' | 'asr',
  omni_base_url: '',
  omni_model: '',
  omni_llm_setting_id: '',
  omni_token: '',
  llm_base_url: '',
  llm_model: '',
  llm_setting_id: '',
  llm_token: '',
  asr_base_url: '',
  asr_realtime_url: '',
  asr_model: '',
  asr_llm_setting_id: '',
  asr_token: '',
  tts_base_url: '',
  tts_model: '',
  tts_llm_setting_id: '',
  tts_voice: '',
  tts_speed: null as number | null,
  tts_token: '',
  tts_stream: false,
  tts_output_channels: ['commentary', 'final'] as VoiceTtsOutputChannel[],
})
const asrModels = ref<string[]>([])
const ttsModels = ref<string[]>([])
const omniModels = ref<string[]>([])
const llmModels = ref<string[]>([])
const voiceTestStatus = ref<{ omni?: string; llm?: string; asr?: string; tts?: string }>({})
const voiceHidBinding = ref<VoiceHidButtonBinding | null>(loadVoiceHidButtonBinding())
const voiceKeyboardBinding = ref<VoiceKeyboardButtonBinding | null>(loadVoiceKeyboardButtonBinding())
const voiceVadSilenceSeconds = ref(loadVoiceVadSilenceMs() / 1000)
const voiceHidBindingStatus = ref('')
const voiceHidBindingActive = ref(false)
const voiceAudioInputDevices = ref<VoiceAudioInputDevice[]>([])
const voiceAudioInputStatus = ref('')
const selectedVoiceAudioInputDeviceId = ref(loadVoiceAudioInputDeviceId())
const voiceAudioInputLoading = ref(false)
const wireGuardForm = ref<AndroidTvWireGuardConfig>(createEmptyWireGuardConfig())
const wireGuardStatus = ref<AndroidTvWireGuardStatus>(createEmptyWireGuardStatus())
const wireGuardProfileName = ref(createEmptyWireGuardConfig().name)
const wireGuardConfigured = ref(false)
const wireGuardError = ref('')
const wireGuardLoading = ref(false)
const voiceHidSecureContext = computed(() => typeof window !== 'undefined' && window.isSecureContext)
const voiceSettingsMobileDevice = computed(() => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const uaLooksMobile = /Android|iPhone|iPad|iPod|Mobile|MiuiBrowser|XiaoMi|HarmonyOS/i.test(navigator.userAgent)
  const touchLooksPhone = navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) <= 620
  return uaLooksMobile || touchLooksPhone
})
const voiceButtonBindingMode = computed<'hid' | 'keyboard'>(() => voiceSettingsMobileDevice.value || !voiceHidSupported() ? 'keyboard' : 'hid')
const voiceAudioInputSelectorVisible = computed(() => voiceAudioInputDevices.value.length > 1)
const singleVoiceAudioInputDevice = computed(() => voiceAudioInputDevices.value.length === 1 ? voiceAudioInputDevices.value[0] : null)
const commentaryNarrationEnabled = computed(() => voiceForm.value.tts_output_channels.includes('commentary'))
const androidTvLocalSettingsVisible = computed(() => androidTvWireGuardAvailable())
const wireGuardProfileOptions = computed(() => {
  const names = new Set(
    [
      wireGuardProfileName.value,
      wireGuardForm.value.name,
      wireGuardStatus.value.profileName,
      wireGuardStatus.value.tunnelName,
    ]
      .map(name => name.trim())
      .filter(Boolean)
  )
  return names.size ? [...names] : [createEmptyWireGuardConfig().name]
})
const wireGuardConnectionLabel = computed(() => {
  if (!wireGuardConfigured.value && !wireGuardStatus.value.configured) return '未配置'
  if (wireGuardStatus.value.connected) return '已连接'
  if (wireGuardStatus.value.event === 'authorization_requested') return '等待授权'
  if (wireGuardStatus.value.lastError) return '连接错误'
  return '未连接'
})

function normalizeTtsOutputChannels(channels: VoiceTtsOutputChannel[] | undefined): VoiceTtsOutputChannel[] {
  const selected = new Set(channels || [])
  const ordered: VoiceTtsOutputChannel[] = []
  if (selected.has('commentary')) ordered.push('commentary')
  if (selected.has('final')) ordered.push('final')
  return ordered.length ? ordered : ['final']
}

async function setCommentaryNarration(enabled: boolean): Promise<void> {
  const selected = new Set(voiceForm.value.tts_output_channels)
  selected.add('final')
  if (enabled) selected.add('commentary')
  else selected.delete('commentary')
  voiceForm.value.tts_output_channels = normalizeTtsOutputChannels([...selected])
  await saveVoiceSettings()
}

const omniSettingOptions = computed(() => llmSettings.value.filter(setting => setting.is_active && setting.supports_audio_input))
const llmSettingOptions = computed(() => llmSettings.value.filter(setting => setting.is_active && setting.supports_llm))
const asrSettingOptions = computed(() => llmSettings.value.filter(setting => setting.is_active && setting.supports_asr))
const ttsSettingOptions = computed(() => llmSettings.value.filter(setting => setting.is_active && setting.supports_tts))

const gitDrawerOpen = ref(false)
const newGitServer = ref({
  name: '',
  platform_type: 'gitea' as 'github' | 'gitlab' | 'gitea',
  api_endpoint: '',
  token: '',
  git_user_name: '',
  git_user_email: '',
  description: '',
})
const gitPlatformOptions: Array<{ value: 'github' | 'gitlab' | 'gitea'; label: string }> = [
  { value: 'gitea', label: 'Gitea' },
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
]
const skillFile = ref<File | null>(null)
const newMcp = ref({
  name: '',
  type: 'STDIO' as MCPServerType,
  url: '',
  command: '',
  arguments: '',
  environment_variables: '',
  enabled: true,
})
const memoryQuery = ref('')
const memoryKind = ref('')
const newMemory = ref({ content: '', kind: 'note', topic: '' })

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
  { id: 'workspace', label: '工作区', icon: FolderTree },
  { id: 'nodes', label: 'Node 节点', icon: Server },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'providers', label: '供应商与模型', icon: Settings },
  { id: 'voice', label: '语音', icon: Volume2 },
  { id: 'device', label: 'Wireguard', icon: Network },
  { id: 'skills', label: 'Skills', icon: Package },
  { id: 'mcp', label: 'MCP 服务器', icon: Network },
  { id: 'memory', label: '记忆', icon: Brain },
]
const hiddenSettingsTabs = new Set<SettingsTab>(['workspace', 'nodes', 'skills', 'mcp', 'memory'])
const visibleTabs = computed(() =>
  tabs.filter(tab => !hiddenSettingsTabs.has(tab.id) && (tab.id !== 'device' || androidTvLocalSettingsVisible.value))
)
const activeTabLabel = computed(() => tabs.find(tab => tab.id === activeTab.value)?.label || '设置')
const activeTabDescription = computed(() => {
  if (activeTab.value === 'git') return '管理 Git Server token。项目和仓库在新增目录时关联。'
  if (activeTab.value === 'providers') return '维护供应商、模型能力和本地加密保存的模型配置。'
  if (activeTab.value === 'voice') return '配置语音播报和按键控制。'
  if (activeTab.value === 'device') return ''
  return '配置 HomeRail Agent UI 使用的本地能力。'
})

const apiBaseUrl = computed(() => agentSettingsApi.getApiBaseUrl())
const selectedProject = computed(() => projects.value.find(project => project.id === selectedProjectId.value) ?? null)
const connectedNodes = computed(() => nodes.value.filter(node => node.status === 'connected' || node.is_alive))
const validGitServerCount = computed(() => gitServers.value.filter(server => server.token_valid).length)
const nodesRuntimeStatus = computed<'healthy' | 'degraded' | 'unavailable'>(() => {
  if (!runtimeStatus.value) return 'unavailable'
  const { connected_nodes, connected_workers } = runtimeStatus.value
  if (connected_nodes > 0 && connected_workers > 0) return 'healthy'
  if (connected_nodes > 0) return 'degraded'
  return 'unavailable'
})

watch(selectedProject, project => {
  if (!project) return
  void loadProjectStorages(project.id)
}, { immediate: false })

watch(activeTab, tab => {
  if (tab === 'voice') void refreshVoiceAudioInputs()
  if (tab === 'device') void refreshWireGuardSettings()
})

function back(): void {
  store.settingsPageOpen = false
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function handleSettingsBackKey(event: KeyboardEvent): void {
  if (voiceHidBindingActive.value) return
  if (event.key !== 'Escape' && event.key !== 'BrowserBack') return
  if (isEditableTarget(event.target)) return
  event.preventDefault()
  event.stopPropagation()
  if (gitDrawerOpen.value) {
    closeGitDrawer()
    return
  }
  back()
}

function currentSettingsGamepad(): Gamepad | null {
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

type SettingsGamepadDirection = 'up' | 'down' | 'left' | 'right'

const SETTINGS_GAMEPAD_AXIS_PRESS = 0.65
const SETTINGS_GAMEPAD_AXIS_RELEASE = 0.35
const SETTINGS_GAMEPAD_SCROLL_DEADZONE = 0.12
const SETTINGS_FOCUS_SELECTOR = [
  'button:not([disabled])',
  'select:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function settingsRootElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('.agent-settings-shell')
}

function settingsScrollElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('.agent-settings-shell main')
}

function isVisibleFocusable(element: HTMLElement): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function settingsFocusableElements(): HTMLElement[] {
  const root = settingsRootElement()
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(SETTINGS_FOCUS_SELECTOR)).filter(isVisibleFocusable)
}

function focusSettingsElement(element: HTMLElement | null): void {
  if (!element) return
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function activeSettingsElement(elements = settingsFocusableElements()): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement && elements.includes(active)) return active
  return null
}

function preferredInitialSettingsFocus(elements = settingsFocusableElements()): HTMLElement | null {
  const activeTabButton = document.querySelector<HTMLElement>(`[data-testid="agent-settings-tab-${activeTab.value}"]`)
  if (activeTabButton && elements.includes(activeTabButton)) return activeTabButton
  return elements[0] ?? null
}

function moveSettingsFocus(direction: SettingsGamepadDirection): void {
  const elements = settingsFocusableElements()
  if (!elements.length) return
  const current = activeSettingsElement(elements) ?? preferredInitialSettingsFocus(elements)
  if (!current) return

  const currentRect = current.getBoundingClientRect()
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2,
  }
  const vertical = direction === 'up' || direction === 'down'
  const candidates = elements
    .filter(element => element !== current)
    .map(element => {
      const rect = element.getBoundingClientRect()
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }
      const dx = center.x - currentCenter.x
      const dy = center.y - currentCenter.y
      const forward =
        direction === 'left' ? dx < -8 :
          direction === 'right' ? dx > 8 :
            direction === 'up' ? dy < -8 :
              dy > 8
      if (!forward) return null
      const primary = vertical ? Math.abs(dy) : Math.abs(dx)
      const secondary = vertical ? Math.abs(dx) : Math.abs(dy)
      return { element, score: primary * 1000 + secondary }
    })
    .filter((item): item is { element: HTMLElement; score: number } => Boolean(item))
    .sort((a, b) => a.score - b.score)

  if (candidates[0]) {
    focusSettingsElement(candidates[0].element)
    return
  }

  const currentIndex = elements.indexOf(current)
  const delta = direction === 'up' || direction === 'left' ? -1 : 1
  const nextIndex = (currentIndex + delta + elements.length) % elements.length
  focusSettingsElement(elements[nextIndex])
}

function confirmSettingsFocus(): void {
  const elements = settingsFocusableElements()
  const current = activeSettingsElement(elements) ?? preferredInitialSettingsFocus(elements)
  if (!current) return
  focusSettingsElement(current)
  current.click()
}

function selectAdjacentSettingsTab(delta: number): void {
  const tabs = visibleTabs.value
  if (!tabs.length) return
  const currentIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeTab.value))
  const next = tabs[(currentIndex + delta + tabs.length) % tabs.length]
  if (!next) return
  activeTab.value = next.id
  void nextTick(() => {
    const tabButton = document.querySelector<HTMLElement>(`[data-testid="agent-settings-tab-${next.id}"]`)
    focusSettingsElement(tabButton)
  })
}

function handleSettingsGamepadCircle(): void {
  if (voiceHidBindingActive.value) return
  back()
}

function handleSettingsGamepadButton(index: number): void {
  if (voiceHidBindingActive.value) return
  if (index === VOICE_GAMEPAD_BUTTON.circle) {
    handleSettingsGamepadCircle()
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.cross) {
    confirmSettingsFocus()
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.dpadUp) {
    moveSettingsFocus('up')
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.dpadDown) {
    moveSettingsFocus('down')
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.dpadLeft) {
    moveSettingsFocus('left')
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.dpadRight) {
    moveSettingsFocus('right')
    return
  }
  if (index === VOICE_GAMEPAD_BUTTON.l1) selectAdjacentSettingsTab(-1)
  else if (index === VOICE_GAMEPAD_BUTTON.r1) selectAdjacentSettingsTab(1)
}

function handleSettingsGamepadAxis(
  value: number,
  axisId: string,
  negative: SettingsGamepadDirection,
  positive: SettingsGamepadDirection
): void {
  if (value <= -SETTINGS_GAMEPAD_AXIS_PRESS && !settingsGamepadAxisLocks.has(axisId)) {
    settingsGamepadAxisLocks.add(axisId)
    moveSettingsFocus(negative)
    return
  }
  if (value >= SETTINGS_GAMEPAD_AXIS_PRESS && !settingsGamepadAxisLocks.has(axisId)) {
    settingsGamepadAxisLocks.add(axisId)
    moveSettingsFocus(positive)
    return
  }
  if (Math.abs(value) < SETTINGS_GAMEPAD_AXIS_RELEASE) settingsGamepadAxisLocks.delete(axisId)
}

function scrollSettingsBy(value: number): void {
  if (Math.abs(value) < SETTINGS_GAMEPAD_SCROLL_DEADZONE) return
  settingsScrollElement()?.scrollBy({ top: value * 42, behavior: 'auto' })
}

function pollSettingsGamepad(): void {
  const gamepad = currentSettingsGamepad()
  if (gamepad) {
    const next = new Set<number>()
    gamepad.buttons.forEach((button, index) => {
      if (!button.pressed) return
      next.add(index)
      if (!settingsGamepadPressedButtons.has(index)) handleSettingsGamepadButton(index)
    })
    settingsGamepadPressedButtons = next
    if (performance.now() - nativeSettingsGamepadAnalogAt > 80) {
      handleSettingsGamepadAxis(gamepad.axes[0] ?? 0, 'left-x', 'left', 'right')
      handleSettingsGamepadAxis(gamepad.axes[1] ?? 0, 'left-y', 'up', 'down')
      scrollSettingsBy(gamepad.axes[3] ?? 0)
    }
  } else {
    settingsGamepadPressedButtons = new Set()
    settingsGamepadAxisLocks = new Set()
  }
  settingsGamepadFrame = window.requestAnimationFrame(pollSettingsGamepad)
}

function handleNativeSettingsGamepadButton(event: Event): void {
  const detail = nativeGamepadEventDetail<NativeGamepadButtonDetail>(event)
  if (!detail || !Number.isFinite(detail.index)) return
  if (!detail.pressed) {
    settingsGamepadPressedButtons.delete(detail.index)
    return
  }
  if (detail.repeat || settingsGamepadPressedButtons.has(detail.index)) return
  settingsGamepadPressedButtons.add(detail.index)
  handleSettingsGamepadButton(detail.index)
}

function handleNativeSettingsGamepadAnalog(event: Event): void {
  const detail = nativeGamepadEventDetail<NativeGamepadAnalogDetail>(event)
  if (!detail) return
  nativeSettingsGamepadAnalogAt = performance.now()
  handleSettingsGamepadAxis(detail.hatX ?? 0, 'hat-x', 'left', 'right')
  handleSettingsGamepadAxis(detail.hatY ?? 0, 'hat-y', 'up', 'down')
  handleSettingsGamepadAxis(detail.panX ?? 0, 'pan-x', 'left', 'right')
  handleSettingsGamepadAxis(detail.panY ?? 0, 'pan-y', 'up', 'down')
  scrollSettingsBy(detail.scrollY ?? 0)
}

function startSettingsGamepadControl(): void {
  if (typeof window === 'undefined') return
  if (!settingsGamepadFrame) settingsGamepadFrame = window.requestAnimationFrame(pollSettingsGamepad)
}

function stopSettingsGamepadControl(): void {
  if (settingsGamepadFrame) window.cancelAnimationFrame(settingsGamepadFrame)
  settingsGamepadFrame = 0
  settingsGamepadPressedButtons = new Set()
  settingsGamepadAxisLocks = new Set()
}

function setNotice(message: string): void {
  showGlobalToast(message, 'success', 2600)
}

function setError(message: string): void {
  error.value = message
  showGlobalToast(message, 'error', 3600)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String((err as { message?: string })?.message || err)
}

function formatDate(value?: string | null): string {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  if (Array.isArray(value)) return value.join(' ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

async function loadExperienceGraph(limit = 12): Promise<ExperienceGraphSummary | null> {
  try {
    const res = await getExperienceGraphSummary(limit)
    experienceGraphError.value = null
    return res.data ?? null
  } catch (err) {
    experienceGraphError.value = messageOf(err)
    return null
  }
}

async function loadAssetDiagnostics(): Promise<AssetDiagnostics | null> {
  try {
    const res = await getAssetDiagnostics()
    assetDiagnosticsError.value = null
    return res.data ?? null
  } catch (err) {
    assetDiagnosticsError.value = messageOf(err)
    return null
  }
}

async function loadOrchestrationTemplates(): Promise<OrchestrationTemplate[]> {
  try {
    const res = await getOrchestrationTemplates(false)
    orchestrationTemplatesError.value = null
    return res.data?.orchestrations ?? []
  } catch (err) {
    orchestrationTemplatesError.value = messageOf(err)
    return []
  }
}

function isMimoTts(model: string, baseUrl = ''): boolean {
  return model.startsWith('mimo-v2.5-tts') || (baseUrl.includes('xiaomimimo.com') && model.includes('tts'))
}

function isQwen3Tts(model: string): boolean {
  return model === 'qwen3-tts'
}

function applyTtsDefaultsFor(model: string, baseUrl: string): void {
  if (isMimoTts(model, baseUrl)) {
    voiceForm.value.tts_voice = 'mimo_default'
    voiceForm.value.tts_speed = null
    voiceForm.value.tts_stream = false
    return
  }
  if (isQwen3Tts(model)) {
    voiceForm.value.tts_voice = 'serena'
    voiceForm.value.tts_speed = null
    voiceForm.value.tts_stream = false
  }
}

function setTtsSpeed(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  voiceForm.value.tts_speed = raw ? Number(raw) : null
}

function splitRepo(repoName?: string | null): string {
  return repoName || '未绑定仓库'
}

function skillRuntimeStatus(skill: Skill): string {
  if (skill.upload_status !== 'installed') return '未安装完成'
  if (skill.runtime_status === 'runtime_available') return 'runtime 可用'
  if (skill.runtime_status === 'unavailable_with_reason') return skill.runtime_message || 'runtime 不可用'
  return 'runtime 可用性未验证'
}

function skillRuntimeStatusLabel(skill: Skill): string {
  if (skill.upload_status !== 'installed') return skill.upload_status
  if (skill.runtime_status === 'runtime_available') return 'runtime_available'
  if (skill.runtime_status === 'unavailable_with_reason') return 'unavailable_with_reason'
  return 'installed'
}

function skillRuntimeStatusClass(skill: Skill): string {
  if (skill.upload_status === 'error') return 'bg-red-500/10 text-red-300'
  if (skill.upload_status === 'installing') return 'bg-yellow-500/10 text-yellow-200'
  if (skill.runtime_status === 'runtime_available') return 'bg-emerald-500/10 text-emerald-200'
  if (skill.runtime_status === 'unavailable_with_reason') return 'bg-red-500/10 text-red-300'
  return 'bg-yellow-500/10 text-yellow-200'
}

function mcpRuntimeStatusClass(server: MCPServer): string {
  const status = server.runtime_status ?? 'unknown'
  if (status === 'runtime_available') return 'bg-emerald-500/10 text-emerald-200'
  if (status === 'configured') return 'bg-gray-500/10 text-gray-300'
  if (status === 'enabled') return 'bg-blue-500/10 text-blue-200'
  if (status === 'unavailable_with_reason') return 'bg-red-500/10 text-red-300'
  return 'bg-yellow-500/10 text-yellow-200'
}

function selectProject(projectId: string): void {
  selectedProjectId.value = projectId
  store.setManagerProjectId(projectId)
}

async function loadProjectStorages(projectId: string): Promise<void> {
  try {
    const res = await listProjectStorages(projectId)
    projectStorages.value = res.data?.storages ?? []
  } catch {
    projectStorages.value = []
  }
}

async function refreshAll(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    await store.loadManagerRuntimeOptions()
    const [
      projectRes,
      nodeRes,
      gitRes,
      providerRes,
      modelRes,
      skillRes,
      mcpRes,
      memoryRes,
      statsRes,
      experienceRes,
      voiceRes,
      voiceAgentRes,
      codexModelRes,
      assetDiagRes,
      orchestrationTemplateRes,
      runtimeStatusRes,
      workspaceSettingsRes,
      storageInfoRes,
    ] = await Promise.all([
      listProjects({ limit: 200 }).catch(() => null),
      hiddenSettingsTabs.has('nodes') ? Promise.resolve(null) : listNodes().catch(() => null),
      agentSettingsApi.listGitServers(true).catch(() => null),
      agentSettingsApi.listProviders().catch(() => null),
      agentSettingsApi.listLLMSettings().catch(() => null),
      hiddenSettingsTabs.has('skills') ? Promise.resolve(null) : listSkills({ limit: 200 }).catch(() => null),
      hiddenSettingsTabs.has('mcp') ? Promise.resolve(null) : agentSettingsApi.listMCPServers().catch(() => null),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : listMemories({ top_k: 100, query: memoryQuery.value || undefined, kind: memoryKind.value || undefined }).catch(() => null),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : getMemoryStats().catch(() => null),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : loadExperienceGraph(12),
      agentSettingsApi.getVoiceSettings().catch(() => null),
      agentSettingsApi.getVoiceAgentConfig().catch(() => null),
      getCodexModels().catch(() => null),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : loadAssetDiagnostics(),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : loadOrchestrationTemplates(),
      agentSettingsApi.getRuntimeStatus().catch(() => null),
      agentSettingsApi.getWorkspaceSettings().catch(() => null),
      hiddenSettingsTabs.has('memory') ? Promise.resolve(null) : agentSettingsApi.getStorageInfo().catch(() => null),
    ])

    projects.value = projectRes?.data?.projects ?? []
    nodes.value = nodeRes?.data?.nodes ?? []
    gitServers.value = gitRes?.data?.servers ?? []
    providers.value = providerRes?.data?.providers ?? []
    llmSettings.value = modelRes?.data?.settings ?? []
    skills.value = skillRes?.data?.skills ?? []
    mcpServers.value = mcpRes?.data?.servers ?? []
    memories.value = memoryRes?.data?.memories ?? []
    memoryStats.value = statsRes?.data ?? null
    experienceGraph.value = experienceRes ?? null
    assetDiagnostics.value = assetDiagRes ?? null
    orchestrationTemplates.value = orchestrationTemplateRes ?? []
    voiceAgentConfig.value = voiceAgentRes?.data ?? null
    codexModels.value = codexModelRes?.data?.models ?? []
    runtimeStatus.value = runtimeStatusRes ?? null
    workspaceSettings.value = workspaceSettingsRes ?? null
    storageInfo.value = storageInfoRes ?? null
    if (voiceRes?.data) {
      voiceSettings.value = voiceRes.data
      voiceForm.value = {
        recognition_mode: voiceRes.data.recognition_mode || 'asr',
        omni_base_url: voiceRes.data.omni_base_url,
        omni_model: voiceRes.data.omni_model,
        omni_llm_setting_id: voiceRes.data.omni_llm_setting_id || '',
        omni_token: '',
        llm_base_url: voiceRes.data.llm_base_url,
        llm_model: voiceRes.data.llm_model,
        llm_setting_id: voiceRes.data.llm_setting_id || '',
        llm_token: '',
        asr_base_url: voiceRes.data.asr_base_url,
        asr_realtime_url: voiceRes.data.asr_realtime_url,
        asr_model: voiceRes.data.asr_model,
        asr_llm_setting_id: voiceRes.data.asr_llm_setting_id || '',
        asr_token: '',
        tts_base_url: voiceRes.data.tts_base_url,
        tts_model: voiceRes.data.tts_model,
        tts_llm_setting_id: voiceRes.data.tts_llm_setting_id || '',
        tts_voice: voiceRes.data.tts_voice,
        tts_speed: voiceRes.data.tts_speed,
        tts_token: '',
        tts_stream: voiceRes.data.tts_stream,
        tts_output_channels: voiceRes.data.tts_output_channels?.length ? voiceRes.data.tts_output_channels : ['commentary', 'final'],
      }
    }

    if (!selectedProjectId.value) {
      selectedProjectId.value = store.managerProjectId || projects.value[0]?.id || null
    }
  } catch (err) {
    setError(messageOf(err))
  } finally {
    loading.value = false
  }
}

async function runAction(key: string, action: () => Promise<void>): Promise<void> {
  saving.value = key
  error.value = null
  try {
    await action()
  } catch (err) {
    setError(messageOf(err))
  } finally {
    saving.value = null
  }
}

function applyWireGuardResponse(configured: boolean, config: AndroidTvWireGuardConfig, endpoint = ''): void {
  const resolvedEndpoint = configured
    ? endpoint || config.endpoint || wireGuardStatus.value.endpoint
    : endpoint || config.endpoint
  wireGuardConfigured.value = configured
  wireGuardForm.value = { ...createEmptyWireGuardConfig(), ...config }
  wireGuardProfileName.value = config.name || wireGuardStatus.value.profileName || createEmptyWireGuardConfig().name
  wireGuardStatus.value = {
    ...wireGuardStatus.value,
    configured,
    endpoint: resolvedEndpoint,
    profileName: config.name || wireGuardStatus.value.profileName,
    tunnelName: config.name || wireGuardStatus.value.tunnelName,
  }
}

function refreshWireGuardStatus(): void {
  wireGuardStatus.value = getAndroidTvWireGuardStatus()
  if (wireGuardStatus.value.profileName || wireGuardStatus.value.tunnelName) {
    wireGuardProfileName.value = wireGuardStatus.value.profileName || wireGuardStatus.value.tunnelName
  }
}

async function refreshWireGuardSettings(): Promise<void> {
  if (!androidTvLocalSettingsVisible.value) return
  wireGuardLoading.value = true
  wireGuardError.value = ''
  try {
    const response = getAndroidTvWireGuardConfig()
    applyWireGuardResponse(response.configured, response.config, response.endpoint)
    refreshWireGuardStatus()
  } catch (err) {
    wireGuardError.value = messageOf(err)
  } finally {
    wireGuardLoading.value = false
  }
}

async function runWireGuardAction(key: string, action: () => Promise<void>): Promise<void> {
  saving.value = key
  error.value = null
  wireGuardError.value = ''
  try {
    await action()
  } catch (err) {
    const message = messageOf(err)
    wireGuardError.value = message
    setError(message)
  } finally {
    saving.value = null
  }
}

async function saveWireGuardSettings(): Promise<void> {
  await runWireGuardAction('wireguard-save', async () => {
    const response = saveAndroidTvWireGuardConfig({
      ...wireGuardForm.value,
      name: wireGuardProfileName.value || wireGuardForm.value.name
    })
    applyWireGuardResponse(response.configured, response.config, response.endpoint)
    refreshWireGuardStatus()
    setNotice('WireGuard 配置已保存到本机 Android TV')
  })
}

async function connectWireGuardSettings(): Promise<void> {
  await runWireGuardAction('wireguard-connect', async () => {
    const profileName = wireGuardProfileName.value || wireGuardForm.value.name || createEmptyWireGuardConfig().name
    const response = saveAndroidTvWireGuardConfig({
      ...wireGuardForm.value,
      name: profileName,
    })
    applyWireGuardResponse(response.configured, response.config, response.endpoint)
    const status = connectAndroidTvWireGuard(profileName)
    wireGuardStatus.value = status
    if (status.profileName || status.tunnelName) {
      wireGuardProfileName.value = status.profileName || status.tunnelName
    }
    if (status.code === 'vpn_authorization_requested') {
      setNotice('请在电视上确认 Android VPN 授权，授权后会自动连接')
    } else {
      setNotice('WireGuard 隧道已连接')
    }
  })
}

async function disconnectWireGuardSettings(): Promise<void> {
  await runWireGuardAction('wireguard-disconnect', async () => {
    wireGuardStatus.value = disconnectAndroidTvWireGuard()
    if (wireGuardStatus.value.profileName || wireGuardStatus.value.tunnelName) {
      wireGuardProfileName.value = wireGuardStatus.value.profileName || wireGuardStatus.value.tunnelName
    }
    setNotice('WireGuard 隧道已断开')
  })
}

async function clearWireGuardSettings(): Promise<void> {
  if (!window.confirm('清除本机 Android TV 保存的 WireGuard 配置？')) return
  await runWireGuardAction('wireguard-clear', async () => {
    const response = clearAndroidTvWireGuardConfig()
    applyWireGuardResponse(response.configured, response.config, response.endpoint)
    refreshWireGuardStatus()
    setNotice('WireGuard 本机配置已清除')
  })
}

function importWireGuardRawConfig(): void {
  try {
    wireGuardForm.value = parseWireGuardRawConfig(
      wireGuardForm.value.rawConfig,
      wireGuardForm.value
    )
    wireGuardProfileName.value = wireGuardForm.value.name
    wireGuardError.value = ''
    setNotice('已从 wg 配置文本填充字段')
  } catch (err) {
    const message = messageOf(err)
    wireGuardError.value = message
    setError(message)
  }
}

function wireGuardStatusClass(): string {
  if (wireGuardStatus.value.connected) return 'bg-emerald-500/10 text-emerald-200'
  if (wireGuardStatus.value.lastError) return 'bg-red-500/10 text-red-200'
  if (wireGuardConfigured.value || wireGuardStatus.value.configured) return 'bg-yellow-500/10 text-yellow-200'
  return 'bg-white/10 text-white/55'
}

function formatWireGuardBytes(value: number): string {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatWireGuardHandshake(value: number): string {
  if (!value) return '从未'
  return new Date(value).toLocaleString()
}

function resetNewGitServer(): void {
  newGitServer.value = {
    name: '',
    platform_type: 'gitea',
    api_endpoint: '',
    token: '',
    git_user_name: '',
    git_user_email: '',
    description: '',
  }
}

function openGitDrawer(): void {
  gitDrawerOpen.value = true
}

function closeGitDrawer(): void {
  if (saving.value === 'create-git') return
  gitDrawerOpen.value = false
  resetNewGitServer()
}

async function createGit(): Promise<void> {
  if (!newGitServer.value.name.trim() || !newGitServer.value.api_endpoint.trim() || !newGitServer.value.token.trim()) return
  await runAction('create-git', async () => {
    await agentSettingsApi.createGitServer({
      ...newGitServer.value,
      name: newGitServer.value.name.trim(),
      api_endpoint: newGitServer.value.api_endpoint.trim(),
      token: newGitServer.value.token.trim(),
      git_user_name: newGitServer.value.git_user_name.trim() || undefined,
      git_user_email: newGitServer.value.git_user_email.trim() || undefined,
      description: newGitServer.value.description.trim() || undefined,
    })
    resetNewGitServer()
    gitDrawerOpen.value = false
    await refreshAll()
    setNotice('Git Server 已添加')
  })
}

async function verifyGit(server: GitServer): Promise<void> {
  await runAction(`verify-git-${server.server_id}`, async () => {
    await agentSettingsApi.verifyGitServer(server.server_id)
    await refreshAll()
    setNotice(`${server.name} 已验证`)
  })
}

async function removeGit(server: GitServer): Promise<void> {
  if (!window.confirm(`删除 Git Server ${server.name}？`)) return
  await runAction(`delete-git-${server.server_id}`, async () => {
    await agentSettingsApi.deleteGitServer(server.server_id, false)
    await refreshAll()
  })
}

async function uploadSelectedSkill(): Promise<void> {
  if (!skillFile.value) return
  await runAction('upload-skill', async () => {
    await uploadSkill(skillFile.value!)
    skillFile.value = null
    await refreshAll()
    setNotice('Skill 已上传')
  })
}

async function removeSkill(skill: Skill): Promise<void> {
  if (!window.confirm(`删除 Skill ${skill.name}？`)) return
  await runAction(`delete-skill-${skill.id}`, async () => {
    await deleteSkill(skill.id)
    await refreshAll()
  })
}

async function createMcpServer(): Promise<void> {
  if (!newMcp.value.name) return
  await runAction('create-mcp', async () => {
    await agentSettingsApi.addMCPServer({
      ...newMcp.value,
      url: newMcp.value.url || undefined,
      command: newMcp.value.command || undefined,
      arguments: newMcp.value.arguments || undefined,
      environment_variables: newMcp.value.environment_variables || undefined,
    })
    newMcp.value = { name: '', type: 'STDIO', url: '', command: '', arguments: '', environment_variables: '', enabled: true }
    await refreshAll()
    setNotice('MCP Server 已添加')
  })
}

async function toggleMcp(server: MCPServer): Promise<void> {
  await runAction(`mcp-${server.id}`, async () => {
    await agentSettingsApi.updateMCPServer({ id: server.id, enabled: !server.enabled })
    await refreshAll()
  })
}

async function refreshMcpRuntime(server: MCPServer): Promise<void> {
  await runAction(`refresh-mcp-${server.id}`, async () => {
    const res = await agentSettingsApi.refreshMCPServerRuntime(server.id)
    mcpServers.value = mcpServers.value.map((item) => (item.id === server.id ? res.data : item))
    setNotice(`MCP Server ${server.name} runtime 状态已刷新`)
  })
}

async function removeMcp(server: MCPServer): Promise<void> {
  if (!window.confirm(`删除 MCP Server ${server.name}？`)) return
  await runAction(`delete-mcp-${server.id}`, async () => {
    await agentSettingsApi.deleteMCPServer(server.id)
    await refreshAll()
  })
}

async function saveVoiceSettings(): Promise<void> {
  await runAction('voice-save', async () => {
    const res = await agentSettingsApi.updateVoiceSettings({
      ...voiceForm.value,
      omni_token: voiceForm.value.omni_token || null,
      llm_token: voiceForm.value.llm_token || null,
      asr_token: voiceForm.value.asr_token || null,
      tts_token: voiceForm.value.tts_token || null,
      tts_output_channels: normalizeTtsOutputChannels(voiceForm.value.tts_output_channels),
    })
    voiceSettings.value = res.data
    voiceForm.value.omni_token = ''
    voiceForm.value.llm_token = ''
    voiceForm.value.asr_token = ''
    voiceForm.value.tts_token = ''
    await syncVoiceAgentLlmConfig(res.data)
    setNotice('语音设置已保存')
  })
}

async function syncVoiceAgentLlmConfig(settings: VoiceSettings): Promise<void> {
  if (voiceAgentConfig.value?.harness !== 'claude_agent_sdk') return
  const settingId = settings.llm_setting_id || ''
  if (!settingId) return
  const setting = llmSettingOptions.value.find(item => item.id === settingId)
  const providerName = setting?.provider_name || voiceAgentConfig.value.provider_name || null
  const modelName = settings.llm_model || setting?.model_name || voiceAgentConfig.value.model_name || null
  if (
    voiceAgentConfig.value.llm_setting_id === settingId
    && voiceAgentConfig.value.provider_name === providerName
    && voiceAgentConfig.value.model_name === modelName
  ) return
  const res = await agentSettingsApi.updateVoiceAgentConfig({
    harness: 'claude_agent_sdk',
    llm_setting_id: settingId,
    provider_name: providerName,
    model_name: modelName,
  })
  voiceAgentConfig.value = res.data
}

function saveVoiceVadSilenceSetting(): void {
  const savedMs = saveVoiceVadSilenceMs(voiceVadSilenceSeconds.value * 1000)
  voiceVadSilenceSeconds.value = savedMs / 1000
  setNotice(`VAD 静音结束时间已保存为 ${voiceVadSilenceSeconds.value.toFixed(1)} 秒`)
}

async function refreshVoiceAudioInputs(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    voiceAudioInputDevices.value = []
    voiceAudioInputStatus.value = '当前浏览器不支持麦克风设备列表。'
    return
  }
  voiceAudioInputLoading.value = true
  try {
    const devices = await listVoiceAudioInputDevices({ ensurePermission: isAndroidTvShell() })
    voiceAudioInputDevices.value = devices
    const savedDeviceId = loadVoiceAudioInputDeviceId()
    const savedExists = savedDeviceId && devices.some(device => device.deviceId === savedDeviceId)
    if (savedDeviceId && !savedExists) {
      clearVoiceAudioInputDeviceId()
      selectedVoiceAudioInputDeviceId.value = ''
    } else {
      selectedVoiceAudioInputDeviceId.value = savedDeviceId
    }
    if (devices.length === 0) voiceAudioInputStatus.value = '未检测到可用麦克风。'
    else if (devices.length === 1) voiceAudioInputStatus.value = `当前麦克风：${devices[0].label}`
    else voiceAudioInputStatus.value = `${devices.length} 个麦克风可用`
  } catch (err) {
    voiceAudioInputStatus.value = messageOf(err)
  } finally {
    voiceAudioInputLoading.value = false
  }
}

function selectVoiceAudioInput(event: Event): void {
  const deviceId = (event.target as HTMLSelectElement).value
  selectedVoiceAudioInputDeviceId.value = deviceId
  saveVoiceAudioInputDeviceId(deviceId)
  voiceAudioInputDevices.value = voiceAudioInputDevices.value.map(device => ({
    ...device,
    isSelected: Boolean(deviceId && device.deviceId === deviceId),
  }))
  setNotice(deviceId ? '麦克风输入已保存' : '麦克风输入已切回自动选择')
}

async function bindVoiceHidButton(): Promise<void> {
  if (!window.isSecureContext) {
    voiceHidBindingStatus.value = '当前页面不是 secure context，WebHID 不可用。请使用 HTTPS 或 localhost。'
    return
  }
  const hid = getHidApi()
  if (!hid) {
    voiceHidBindingStatus.value = '当前浏览器不支持 WebHID。请使用 Chrome 或 Edge。'
    return
  }

  voiceHidBindingActive.value = true
  voiceHidBindingStatus.value = '请选择 DJI Mic 接收器，然后按一下要绑定的按键。'
  try {
    const devices = await hid.requestDevice({ filters: [] })
    const device = devices[0]
    if (!device) {
      voiceHidBindingStatus.value = '未选择 HID 设备。'
      return
    }
    if (!device.opened) await device.open()

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        device.removeEventListener('inputreport', onReport)
        reject(new Error('等待按键超时，请重新绑定。'))
      }, 15000)

      function onReport(event: any): void {
        const bytes = Array.from(new Uint8Array(event.data.buffer)) as number[]
        const pressed = findPressedByte(bytes)
        if (!pressed) return
        window.clearTimeout(timeout)
        device.removeEventListener('inputreport', onReport)
        const binding: VoiceHidButtonBinding = {
          enabled: true,
          productName: device.productName || 'HID device',
          vendorId: device.vendorId,
          productId: device.productId,
          reportId: event.reportId,
          byteIndex: pressed.index,
          pressedValue: pressed.value,
          action: 'toggle_listening',
          updatedAt: new Date().toISOString(),
        }
        saveVoiceHidButtonBinding(binding)
        voiceHidBinding.value = binding
        voiceHidBindingStatus.value = `已绑定：${formatVoiceHidBinding(binding)}`
        resolve()
      }

      device.addEventListener('inputreport', onReport)
    })
  } catch (err: any) {
    voiceHidBindingStatus.value = err?.message || '绑定失败'
  } finally {
    voiceHidBindingActive.value = false
  }
}

function clearVoiceHidBinding(): void {
  clearVoiceHidButtonBinding()
  clearVoiceKeyboardButtonBinding()
  voiceHidBinding.value = null
  voiceKeyboardBinding.value = null
  voiceHidBindingStatus.value = '已清除按键绑定。'
}

function bindVoiceKeyboardButton(): void {
  if (typeof window === 'undefined') return
  voiceHidBindingActive.value = true
  voiceHidBindingStatus.value = '请按一下智能眼镜/蓝牙遥控器要绑定的按键。'
  window.addEventListener('keydown', captureVoiceKeyboardButton, true)
}

function captureVoiceKeyboardButton(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const binding = keyboardBindingFromEvent(event)
  saveVoiceKeyboardButtonBinding(binding)
  voiceKeyboardBinding.value = binding
  voiceHidBindingStatus.value = `已绑定键盘按键：${formatVoiceKeyboardBinding(binding)}`
  voiceHidBindingActive.value = false
  window.removeEventListener('keydown', captureVoiceKeyboardButton, true)
}

function bindVoiceControlButton(): void {
  if (voiceButtonBindingMode.value === 'hid') void bindVoiceHidButton()
  else bindVoiceKeyboardButton()
}

function selectVoiceModelSetting(service: 'omni' | 'llm' | 'asr' | 'tts', event: Event): void {
  const settingId = (event.target as HTMLSelectElement).value
  if (!settingId) {
    if (service === 'omni') voiceForm.value.omni_llm_setting_id = ''
    else if (service === 'llm') voiceForm.value.llm_setting_id = ''
    else if (service === 'asr') voiceForm.value.asr_llm_setting_id = ''
    else voiceForm.value.tts_llm_setting_id = ''
    return
  }
  const options = service === 'omni'
    ? omniSettingOptions.value
    : service === 'llm'
      ? llmSettingOptions.value
      : service === 'asr'
        ? asrSettingOptions.value
        : ttsSettingOptions.value
  const setting = options.find(item => item.id === settingId)
  if (!setting) return
  if (service === 'omni') {
    voiceForm.value.omni_llm_setting_id = setting.id
    voiceForm.value.omni_model = setting.model_name
    voiceForm.value.omni_base_url = setting.provider_base_url || voiceForm.value.omni_base_url
    voiceForm.value.recognition_mode = 'omni'
    return
  }
  if (service === 'llm') {
    voiceForm.value.llm_setting_id = setting.id
    voiceForm.value.llm_model = setting.model_name
    voiceForm.value.llm_base_url = setting.provider_base_url || voiceForm.value.llm_base_url
    return
  }
  if (service === 'asr') {
    voiceForm.value.recognition_mode = 'asr'
    voiceForm.value.asr_llm_setting_id = setting.id
    voiceForm.value.asr_model = setting.model_name
    voiceForm.value.asr_base_url = setting.provider_base_url || voiceForm.value.asr_base_url
    return
  }
  voiceForm.value.tts_llm_setting_id = setting.id
  voiceForm.value.tts_model = setting.model_name
  voiceForm.value.tts_base_url = setting.provider_base_url || voiceForm.value.tts_base_url
  applyTtsDefaultsFor(voiceForm.value.tts_model, voiceForm.value.tts_base_url)
}

async function fetchVoiceModels(service: 'omni' | 'llm' | 'asr' | 'tts'): Promise<void> {
  await runAction(`voice-models-${service}`, async () => {
    const isAsr = service === 'asr'
    const isOmni = service === 'omni'
    const isLlm = service === 'llm'
    const res = await listVoiceModels(
      service,
      isOmni ? voiceForm.value.omni_base_url : isLlm ? voiceForm.value.llm_base_url : isAsr ? voiceForm.value.asr_base_url : voiceForm.value.tts_base_url,
      isOmni ? voiceForm.value.omni_token : isLlm ? voiceForm.value.llm_token : isAsr ? voiceForm.value.asr_token : voiceForm.value.tts_token,
      isOmni ? voiceForm.value.omni_llm_setting_id : isLlm ? voiceForm.value.llm_setting_id : isAsr ? voiceForm.value.asr_llm_setting_id : voiceForm.value.tts_llm_setting_id,
    )
    const models = res.data?.models ?? []
    if (isOmni) {
      omniModels.value = models
      if (models.length && !models.includes(voiceForm.value.omni_model)) voiceForm.value.omni_model = models[0]
    } else if (isLlm) {
      llmModels.value = models
      if (models.length && !models.includes(voiceForm.value.llm_model)) voiceForm.value.llm_model = models[0]
    } else if (isAsr) {
      asrModels.value = models
      if (models.length && !models.includes(voiceForm.value.asr_model)) voiceForm.value.asr_model = models[0]
    } else {
      ttsModels.value = models
      if (models.length && !models.includes(voiceForm.value.tts_model)) voiceForm.value.tts_model = models[0]
    }
    setNotice(`${service.toUpperCase()} 模型列表已更新`)
  })
}

async function testVoice(service: 'omni' | 'llm' | 'asr' | 'tts'): Promise<void> {
  await runAction(`voice-test-${service}`, async () => {
    const isAsr = service === 'asr'
    const isOmni = service === 'omni'
    const isLlm = service === 'llm'
    const res = await testVoiceConnection(
      service,
      isOmni ? voiceForm.value.omni_base_url : isLlm ? voiceForm.value.llm_base_url : isAsr ? voiceForm.value.asr_base_url : voiceForm.value.tts_base_url,
      isOmni ? voiceForm.value.omni_token : isLlm ? voiceForm.value.llm_token : isAsr ? voiceForm.value.asr_token : voiceForm.value.tts_token,
      isOmni ? voiceForm.value.omni_llm_setting_id : isLlm ? voiceForm.value.llm_setting_id : isAsr ? voiceForm.value.asr_llm_setting_id : voiceForm.value.tts_llm_setting_id,
    )
    const models = res.data?.models ?? []
    const modelText = models.join(', ') || '无模型'
    const statusText = res.data?.verified === false
      ? res.data.warning || `内置模型列表已加载：${modelText}；密钥将在实际调用时验证`
      : `连接成功：${modelText}`
    voiceTestStatus.value = {
      ...voiceTestStatus.value,
      [service]: statusText,
    }
  })
}

async function refreshMemory(): Promise<void> {
  await runAction('memory-refresh', async () => {
    const [memoryRes, statsRes, experienceRes, assetDiagRes, orchestrationTemplateRes] = await Promise.all([
      listMemories({ top_k: 100, query: memoryQuery.value || undefined, kind: memoryKind.value || undefined }),
      getMemoryStats(),
      loadExperienceGraph(12),
      loadAssetDiagnostics(),
      loadOrchestrationTemplates(),
    ])
    memories.value = memoryRes.data?.memories ?? []
    memoryStats.value = statsRes.data ?? null
    experienceGraph.value = experienceRes ?? null
    assetDiagnostics.value = assetDiagRes ?? null
    orchestrationTemplates.value = orchestrationTemplateRes ?? []
  })
}

function percent(value?: number): string {
  return `${Math.round((value ?? 0) * 100)}%`
}

function boolLabel(value: boolean): string {
  return value ? '已记录' : '缺失'
}

function coverageLabel(name: string): string {
  return ({
    runs: '运行',
    templates: '模板',
    run_to_template: '运行-模板关系',
    scorecards: '评分',
    failures: '失败根因',
    lessons: '经验',
  } as Record<string, string>)[name] || name
}

async function addMemory(): Promise<void> {
  if (!newMemory.value.content.trim()) return
  await runAction('memory-create', async () => {
    await createMemory({
      content: newMemory.value.content,
      kind: newMemory.value.kind,
      topic: newMemory.value.topic || undefined,
    })
    newMemory.value.content = ''
    newMemory.value.topic = ''
    await refreshMemory()
  })
}

async function removeMemory(memory: MemoryItem): Promise<void> {
  if (!window.confirm(`删除记忆 #${memory.id}？`)) return
  await runAction(`memory-delete-${memory.id}`, async () => {
    await deleteMemory(memory.id)
    await refreshMemory()
  })
}

function onSkillFileChange(event: Event): void {
  skillFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

onMounted(() => {
  voiceHidBinding.value = loadVoiceHidButtonBinding()
  voiceKeyboardBinding.value = loadVoiceKeyboardButtonBinding()
  voiceVadSilenceSeconds.value = loadVoiceVadSilenceMs() / 1000
  window.addEventListener('keydown', handleSettingsBackKey, true)
  window.addEventListener(NATIVE_GAMEPAD_BUTTON_EVENT, handleNativeSettingsGamepadButton)
  window.addEventListener(NATIVE_GAMEPAD_ANALOG_EVENT, handleNativeSettingsGamepadAnalog)
  startSettingsGamepadControl()
  if (activeTab.value === 'voice') void refreshVoiceAudioInputs()
  void refreshAll()
})

onUnmounted(() => {
  window.removeEventListener('keydown', captureVoiceKeyboardButton, true)
  window.removeEventListener('keydown', handleSettingsBackKey, true)
  window.removeEventListener(NATIVE_GAMEPAD_BUTTON_EVENT, handleNativeSettingsGamepadButton)
  window.removeEventListener(NATIVE_GAMEPAD_ANALOG_EVENT, handleNativeSettingsGamepadAnalog)
  stopSettingsGamepadControl()
})
</script>

<template>
  <div class="agent-settings-shell relative flex h-screen overflow-hidden bg-[#080b0d] p-4 text-gray-100">
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_24%_12%,rgba(32,160,150,0.18),transparent_32%),radial-gradient(circle_at_82%_4%,rgba(84,201,216,0.12),transparent_28%)]" />
    <aside class="relative z-10 flex w-[224px] flex-shrink-0 flex-col rounded-l-[30px] border border-r-0 border-cyan-200/14 bg-black/26 shadow-2xl backdrop-blur-xl xl:w-[338px]">
      <div class="h-10 flex-shrink-0" />
      <div class="px-4">
        <button class="flex h-11 w-full items-center gap-2 rounded-full border border-cyan-200/14 bg-cyan-200/[0.055] px-3 text-left text-base text-cyan-50 hover:bg-cyan-200/10 hover:text-white" @click="back">
          <ArrowLeft class="h-4 w-4" />
          返回应用
        </button>
      </div>
      <nav class="mt-6 flex-1 overflow-y-auto px-4 text-[15px]">
        <div class="mb-3 px-1 text-[11px] tracking-[0.22em] text-cyan-200/45">HomeRail</div>
        <button
          v-for="tab in visibleTabs"
          :key="tab.id"
          :data-testid="`agent-settings-tab-${tab.id}`"
          class="mb-1 flex h-11 w-full items-center gap-3 rounded-2xl px-3 text-left"
          :class="activeTab === tab.id ? 'border border-cyan-200/20 bg-cyan-200/12 text-white' : 'border border-transparent text-white/66 hover:border-white/10 hover:bg-white/[0.055] hover:text-white'"
          @click="activeTab = tab.id"
        >
          <component :is="tab.icon" class="h-4 w-4" />
          {{ tab.label }}
        </button>
      </nav>
      <div class="border-t border-cyan-200/10 px-4 py-4 text-xs text-cyan-100/45">
        API {{ apiBaseUrl }}
      </div>
    </aside>

    <main class="relative z-10 min-w-0 flex-1 overflow-y-auto rounded-r-[30px] border border-cyan-200/14 bg-[#071012]/76 shadow-2xl backdrop-blur-xl">
      <div class="mx-auto w-full max-w-[1040px] px-5 py-7 xl:px-10 xl:py-12">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h1 class="text-3xl font-semibold tracking-normal text-white">{{ activeTabLabel }}</h1>
            <p v-if="activeTabDescription" class="mt-3 text-sm text-white/42">{{ activeTabDescription }}</p>
          </div>
          <button class="flex h-11 items-center gap-2 rounded-full border border-cyan-200/14 px-4 text-sm text-cyan-50 hover:bg-cyan-200/10" @click="refreshAll">
            <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
            刷新
          </button>
        </div>

        <section v-if="activeTab === 'workspace'" data-testid="agent-settings-section-workspace" class="mt-10 space-y-6">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Workspace Path</div>
              <div class="mt-2 break-all font-mono text-sm" data-testid="agent-settings-workspace-path">{{ workspaceSettings?.workspace_path ?? '-' }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Connected Nodes</div>
              <div class="mt-2 text-2xl font-semibold">{{ runtimeStatus?.connected_nodes ?? 0 }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Active Runs</div>
              <div class="mt-2 text-2xl font-semibold">{{ runtimeStatus?.active_runs ?? 0 }}</div>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525]">
            <div class="border-b border-white/10 px-4 py-3">
              <div class="font-semibold">当前项目 / 工作区</div>
              <div class="mt-1 text-sm text-gray-400">当前后端没有本地目录导入 API，这里显示现有 Project、Storage 和 Git 绑定状态。</div>
            </div>
            <div class="grid gap-4 p-4 md:grid-cols-[300px_1fr]">
              <div class="space-y-2">
                <button
                  v-for="project in projects"
                  :key="project.id"
                  class="w-full rounded-md border px-3 py-2 text-left"
                  :class="selectedProjectId === project.id ? 'border-blue-400 bg-blue-500/10' : 'border-white/10 bg-black/20 hover:bg-white/5'"
                  @click="selectProject(project.id)"
                >
                  <div class="truncate text-sm font-medium">{{ project.name }}</div>
                  <div class="mt-1 text-xs text-gray-500">{{ project.active_changes }} active changes</div>
                </button>
                <div v-if="!projects.length" data-testid="agent-settings-workspace-projects-empty" class="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-gray-500">暂无 Project。</div>
                <div class="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-100/80" data-testid="workspace-directory-import-tracked-unsupported">
                  本地目录导入 (directory import) 为后端 tracked unsupported 状态 — 未伪装为已实现。后端跟进: {{ workspaceSettings?.directory_import_next_action || 'Implement directory import/select API in TS Manager backend' }}
                </div>
              </div>
              <div v-if="selectedProject" class="space-y-4">
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="rounded-md bg-black/20 p-3">
                    <div class="text-xs text-gray-500">Project ID</div>
                    <div class="mt-1 break-all font-mono text-sm">{{ selectedProject.id }}</div>
                  </div>
                  <div class="rounded-md bg-black/20 p-3">
                    <div class="text-xs text-gray-500">Git</div>
                    <div class="mt-1 text-sm">{{ splitRepo(selectedProject.git_repo_name) }}</div>
                  </div>
                  <div class="rounded-md bg-black/20 p-3">
                    <div class="text-xs text-gray-500">Storage</div>
                    <div class="mt-1 text-sm">{{ projectStorages.length }} 个挂载配置</div>
                  </div>
                  <div class="rounded-md bg-black/20 p-3">
                    <div class="text-xs text-gray-500">Updated</div>
                    <div class="mt-1 text-sm">{{ formatDate(selectedProject.updated_at) }}</div>
                  </div>
                </div>
                <div class="space-y-2">
                  <div v-for="storage in projectStorages" :key="storage.id" class="rounded-md border border-white/10 bg-black/20 p-3 text-sm">
                    <div class="font-medium">{{ storage.name }}</div>
                    <div class="mt-1 text-gray-500">{{ storage.storage_type }} · {{ storage.mount_point || storage.storage_path }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-if="activeTab === 'nodes'" data-testid="agent-settings-section-nodes" class="mt-10 space-y-4">
          <div class="grid gap-3 sm:grid-cols-4">
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Registered Nodes</div>
              <div class="mt-2 text-2xl font-semibold">{{ nodes.length }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Connected (Runtime)</div>
              <div class="mt-2 text-2xl font-semibold text-emerald-300">{{ runtimeStatus?.connected_nodes ?? 0 }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Workers</div>
              <div class="mt-2 text-2xl font-semibold">{{ runtimeStatus?.connected_workers ?? 0 }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Runtime Status</div>
              <div class="mt-2 text-sm" :class="nodesRuntimeStatus === 'healthy' ? 'text-emerald-300' : nodesRuntimeStatus === 'degraded' ? 'text-yellow-300' : 'text-gray-500'">{{ nodesRuntimeStatus }}</div>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">Active Runs</div>
              <div class="mt-2 text-2xl font-semibold">{{ runtimeStatus?.active_runs ?? 0 }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4">
              <div class="text-sm text-gray-500">DAG 可用性</div>
              <div class="mt-2 text-sm">{{ (runtimeStatus?.connected_nodes ?? 0) > 0 ? '可调度' : '无在线 Node' }}</div>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525]">
            <div v-for="node in nodes" :key="node.node_id" class="grid gap-3 border-b border-white/10 px-4 py-3 last:border-0 md:grid-cols-[1fr_120px_1fr]">
              <div>
                <div class="font-medium">{{ node.name }}</div>
                <div class="mt-1 font-mono text-xs text-gray-500">{{ node.node_id }}</div>
              </div>
              <div class="text-sm" :class="node.status === 'connected' ? 'text-emerald-300' : 'text-gray-500'">{{ node.status }}</div>
              <div class="text-sm text-gray-400">{{ node.resources?.cpu_cores ?? '-' }} CPU · {{ node.resources?.memory_gb ?? '-' }} GB · {{ node.docker_host || '-' }}</div>
            </div>
            <div v-if="!nodes.length" data-testid="agent-settings-nodes-empty-state" class="p-4 text-sm text-gray-500">暂无 Node。</div>
          </div>
        </section>

        <section v-if="activeTab === 'git'" data-testid="agent-settings-section-git" class="mt-8 space-y-5">
          <div class="grid gap-3 md:grid-cols-3">
            <div class="rounded-md border border-white/10 bg-white/[0.045] p-4">
              <div class="text-xs text-white/42">Git Servers</div>
              <div class="mt-2 text-2xl font-semibold text-white">{{ gitServers.length }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-white/[0.045] p-4">
              <div class="text-xs text-white/42">Token 状态</div>
              <div class="mt-2 text-2xl font-semibold text-emerald-200">{{ validGitServerCount }}/{{ gitServers.length }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-white/[0.045] p-4">
              <div class="text-xs text-white/42">项目关联</div>
              <div class="mt-2 text-sm font-medium text-white">新增目录时选择</div>
              <div class="mt-1 text-xs text-white/42">此页只维护 token，不做目录绑定。</div>
            </div>
          </div>

          <section class="overflow-hidden rounded-lg border border-white/10 bg-white/[0.045]">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5">
              <div>
                <h2 class="text-base font-semibold text-white/88">已保存的 Git Server</h2>
                <p class="mt-1 text-sm text-white/42">{{ gitServers.length }} 个 token 配置 · Token 加密保存</p>
              </div>
              <button
                class="inline-flex h-10 items-center gap-2 rounded-md bg-blue-500 px-4 text-sm text-white hover:bg-blue-400 disabled:opacity-40"
                :disabled="loading"
                @click="openGitDrawer"
                data-testid="agent-settings-git-open-create"
              >
                <Plus class="h-4 w-4" />
                添加 Git Server
              </button>
            </div>
            <div v-if="gitServers.length" class="divide-y divide-white/10">
              <div v-for="server in gitServers" :key="server.server_id" :data-testid="`agent-settings-git-server-item-${server.server_id}`" class="grid gap-3 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_150px_150px] md:items-center">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <div class="truncate font-medium text-white">{{ server.name }}</div>
                    <span class="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] uppercase tracking-wide text-white/55">{{ server.platform_type }}</span>
                  </div>
                  <div class="mt-1 truncate font-mono text-xs text-white/42">{{ server.api_endpoint }}</div>
                  <div class="mt-1 text-xs text-white/35">
                    {{ server.git_user_name || '未设置 Git user' }} · {{ server.git_user_email || '未设置 Git email' }}
                  </div>
                </div>
                <div class="flex items-center gap-1.5 text-sm" :class="server.token_valid ? 'text-emerald-300' : 'text-red-300'" :data-testid="`agent-settings-git-validity-${server.server_id}`">
                  <CheckCircle2 v-if="server.token_valid" class="h-4 w-4" />
                  <XCircle v-else class="h-4 w-4" />
                  {{ server.token_valid ? '已验证' : '未验证' }}
                </div>
                <div class="flex justify-start gap-2 md:justify-end">
                  <button class="inline-flex h-9 items-center rounded-md border border-white/10 px-3 text-sm text-white/70 hover:bg-white/5 disabled:opacity-40" :disabled="saving === `verify-git-${server.server_id}`" @click="verifyGit(server)" :data-testid="`agent-settings-git-verify-${server.server_id}`">
                    <Loader2 v-if="saving === `verify-git-${server.server_id}`" class="mr-2 h-4 w-4 animate-spin" />
                    验证
                  </button>
                  <button class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40" :disabled="saving === `delete-git-${server.server_id}`" @click="removeGit(server)" :data-testid="`agent-settings-git-delete-${server.server_id}`"><Trash2 class="h-4 w-4" /></button>
                </div>
              </div>
            </div>
            <div v-else class="px-4 py-8 text-sm text-white/45">
              还没有 Git Server。点击右上角添加 Gitea、GitHub 或 GitLab token。
            </div>
          </section>
        </section>

        <ModelSettings
          v-if="activeTab === 'providers'"
          :providers="providers"
          :llm-settings="llmSettings"
          :manager-config="voiceAgentConfig"
          :codex-models="codexModels"
          :loading="loading"
          @refresh="refreshAll"
          @set-notice="setNotice"
        />

        <section
          v-if="activeTab === 'device' && androidTvLocalSettingsVisible"
          data-testid="agent-settings-section-wireguard"
          class="mt-7 max-w-none space-y-5"
        >
          <section class="space-y-4">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 class="text-base font-semibold text-white/88">连接</h2>
              </div>
              <span
                data-testid="agent-settings-wireguard-status"
                class="rounded-full px-3 py-1.5 text-sm"
                :class="wireGuardStatusClass()"
              >
                {{ wireGuardConnectionLabel }}
              </span>
            </div>

            <div class="overflow-hidden rounded-lg border border-white/10 bg-[#252525]">
              <div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3.5">
                <div class="grid min-w-[240px] gap-1.5 text-sm text-white/55">
                  <label class="text-gray-400" for="agent-settings-wireguard-profile-select">Profile</label>
                  <select
                    id="agent-settings-wireguard-profile-select"
                    v-model="wireGuardProfileName"
                    data-testid="agent-settings-wireguard-profile-select"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                  >
                    <option v-for="name in wireGuardProfileOptions" :key="name" :value="name">{{ name }}</option>
                  </select>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="inline-flex h-10 items-center rounded-md bg-blue-500 px-3 py-2 text-sm text-white hover:bg-blue-400 disabled:opacity-40"
                    :disabled="saving === 'wireguard-connect' || wireGuardLoading"
                    data-testid="agent-settings-wireguard-connect"
                    @click="connectWireGuardSettings"
                  >
                    <Loader2 v-if="saving === 'wireguard-connect'" class="mr-2 inline h-4 w-4 animate-spin" />
                    <Network v-else class="mr-2 inline h-4 w-4" />
                    连接
                  </button>
                  <button
                    class="inline-flex h-10 items-center rounded-md border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-40"
                    :disabled="saving === 'wireguard-disconnect' || wireGuardLoading || !wireGuardStatus.connected"
                    data-testid="agent-settings-wireguard-disconnect"
                    @click="disconnectWireGuardSettings"
                  >
                    <Loader2 v-if="saving === 'wireguard-disconnect'" class="mr-2 inline h-4 w-4 animate-spin" />
                    <XCircle v-else class="mr-2 inline h-4 w-4" />
                    断开
                  </button>
                  <button
                    class="inline-flex h-10 items-center rounded-md border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5 disabled:opacity-40"
                    :disabled="wireGuardLoading"
                    data-testid="agent-settings-wireguard-refresh"
                    @click="refreshWireGuardSettings"
                  >
                    <Loader2 v-if="wireGuardLoading" class="mr-2 inline h-4 w-4 animate-spin" />
                    刷新
                  </button>
                  <button
                    class="inline-flex h-10 items-center rounded-md bg-blue-500 px-3 py-2 text-sm text-white hover:bg-blue-400 disabled:opacity-40"
                    :disabled="saving === 'wireguard-save'"
                    data-testid="agent-settings-wireguard-save"
                    @click="saveWireGuardSettings"
                  >
                    <Loader2 v-if="saving === 'wireguard-save'" class="mr-2 inline h-4 w-4 animate-spin" />
                    保存
                  </button>
                </div>
              </div>
              <div class="grid gap-2 border-b border-white/10 px-4 py-3 text-xs text-white/45 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  endpoint:
                  <span class="font-mono text-white/66">{{ wireGuardStatus.endpoint || wireGuardForm.endpoint || '-' }}</span>
                </div>
                <div>
                  tunnel:
                  <span class="font-mono text-white/66">{{ wireGuardStatus.tunnelName || wireGuardProfileName || '-' }}</span>
                </div>
                <div>
                  rx/tx:
                  <span class="font-mono text-white/66">
                    {{ formatWireGuardBytes(wireGuardStatus.rxBytes) }} / {{ formatWireGuardBytes(wireGuardStatus.txBytes) }}
                  </span>
                </div>
                <div>
                  last handshake:
                  <span class="font-mono text-white/66">{{ formatWireGuardHandshake(wireGuardStatus.latestHandshakeEpochMillis) }}</span>
                </div>
                <div v-if="wireGuardStatus.lastError" class="sm:col-span-2 xl:col-span-4">
                  error:
                  <span class="font-mono text-red-200">{{ wireGuardStatus.lastError }}</span>
                </div>
              </div>
              <div class="grid gap-3 px-4 py-4 xl:grid-cols-2">
                <label class="grid gap-2 text-sm text-gray-400">
                  配置名称
                  <input
                    v-model="wireGuardForm.name"
                    data-testid="agent-settings-wireguard-name"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="wg0"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400">
                  Endpoint
                  <input
                    v-model="wireGuardForm.endpoint"
                    data-testid="agent-settings-wireguard-endpoint"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="host:51820"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  Allowed IPs
                  <input
                    v-model="wireGuardForm.allowedIps"
                    data-testid="agent-settings-wireguard-allowed-ips"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="0.0.0.0/0, ::/0"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400">
                  Persistent Keepalive
                  <input
                    v-model="wireGuardForm.persistentKeepalive"
                    data-testid="agent-settings-wireguard-keepalive"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="25"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400">
                  Interface Address
                  <input
                    v-model="wireGuardForm.interfaceAddress"
                    data-testid="agent-settings-wireguard-interface-address"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="10.0.0.2/32"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  DNS
                  <input
                    v-model="wireGuardForm.dns"
                    data-testid="agent-settings-wireguard-dns"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="223.5.5.5"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  Interface Private Key
                  <input
                    v-model="wireGuardForm.interfacePrivateKey"
                    data-testid="agent-settings-wireguard-private-key"
                    type="password"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="private key"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  Peer Public Key
                  <input
                    v-model="wireGuardForm.peerPublicKey"
                    data-testid="agent-settings-wireguard-peer-public-key"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="peer public key"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  Peer Pre-shared Key
                  <input
                    v-model="wireGuardForm.peerPreSharedKey"
                    data-testid="agent-settings-wireguard-peer-psk"
                    type="password"
                    class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm text-white outline-none"
                    placeholder="optional pre-shared key"
                  />
                </label>
                <label class="grid gap-2 text-sm text-gray-400 xl:col-span-2">
                  wg0.conf
                  <textarea
                    v-model="wireGuardForm.rawConfig"
                    data-testid="agent-settings-wireguard-raw"
                    class="min-h-[320px] resize-y rounded-md border border-white/10 bg-[#181818] px-3 py-2 font-mono text-sm leading-6 text-white outline-none"
                    style="min-height: 320px"
                    placeholder="[Interface]&#10;PrivateKey = ...&#10;Address = ...&#10;&#10;[Peer]&#10;PublicKey = ...&#10;Endpoint = ..."
                  />
                </label>
              </div>

              <div class="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3.5">
                <button
                  class="inline-flex h-10 items-center rounded-md border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5"
                  data-testid="agent-settings-wireguard-import-raw"
                  @click="importWireGuardRawConfig"
                >
                  从 wg0.conf 填充
                </button>
                <button
                  class="inline-flex h-10 items-center rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                  :disabled="saving === 'wireguard-clear'"
                  data-testid="agent-settings-wireguard-clear"
                  @click="clearWireGuardSettings"
                >
                  清除
                </button>
              </div>
              <div
                v-if="wireGuardError"
                data-testid="agent-settings-wireguard-error"
                class="border-t border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200"
              >
                {{ wireGuardError }}
              </div>
            </div>
          </section>
        </section>

        <section v-if="activeTab === 'voice'" data-testid="agent-settings-section-voice" class="mt-10 space-y-8">
          <section class="space-y-3">
            <div>
              <h2 class="text-base font-semibold text-white/88">播报</h2>
              <p class="mt-1 text-sm text-white/42">控制 Codex Voice Agent 的 TTS 播报范围。</p>
            </div>
            <div class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.045]">
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 px-4 py-3.5">
                <div class="min-w-0">
                  <div class="font-medium text-white/88">进度旁白</div>
                  <div class="mt-1 text-sm leading-6 text-white/44">
                    播报 commentary 进度；最终答复仍会正常播报。仅适用 Codex。
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  data-testid="agent-settings-voice-commentary-toggle"
                  class="relative h-7 w-12 rounded-full border transition disabled:opacity-45"
                  :class="commentaryNarrationEnabled ? 'border-blue-400 bg-blue-500' : 'border-white/15 bg-white/10'"
                  :aria-checked="commentaryNarrationEnabled"
                  :disabled="saving === 'voice-save'"
                  @click="setCommentaryNarration(!commentaryNarrationEnabled)"
                >
                  <span
                    class="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform"
                    :class="commentaryNarrationEnabled ? 'translate-x-5' : 'translate-x-0'"
                  />
                </button>
              </div>
            </div>
          </section>

          <section class="space-y-3">
            <div>
              <h2 class="text-base font-semibold text-white/88">控制</h2>
              <p class="mt-1 text-sm text-white/40">绑定外部按键，并调整语音结束自动发送时间。</p>
            </div>
            <div class="overflow-hidden rounded-xl border border-white/10 bg-white/[0.045]">
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 px-4 py-3.5">
                <div>
                  <div class="font-medium text-white/88">输入按键</div>
                  <div class="mt-1 text-sm leading-6 text-white/44">
                    桌面使用 WebHID；其他设备可使用键盘/遥控器按键。
                  </div>
                </div>
                <span
                  class="rounded-full px-3 py-1.5 text-sm"
                  :class="voiceButtonBindingMode === 'hid' ? 'bg-cyan-500/10 text-cyan-100' : 'bg-emerald-500/10 text-emerald-100'"
                >
                  {{ voiceButtonBindingMode === 'hid' ? 'WebHID' : '键盘按键' }}
                </span>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-white/10 px-4 py-3.5">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 font-medium text-white/88">
                    <Mic class="h-4 w-4 text-cyan-200/70" />
                    麦克风输入
                  </div>
                  <div class="mt-1 text-sm leading-6 text-white/44">
                    Android TV 会自动优先使用 USB / headset / 外置麦克风；多设备时可手动选择。
                  </div>
                  <div v-if="voiceAudioInputStatus" class="mt-1 text-xs text-cyan-100/70">{{ voiceAudioInputStatus }}</div>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <select
                    v-if="voiceAudioInputSelectorVisible"
                    :value="selectedVoiceAudioInputDeviceId"
                    data-testid="agent-settings-voice-audio-input-select"
                    class="h-10 min-w-[260px] rounded-lg border border-white/10 bg-black/[0.24] px-3 text-sm text-white/82 outline-none"
                    @change="selectVoiceAudioInput"
                  >
                    <option value="">自动选择</option>
                    <option
                      v-for="device in voiceAudioInputDevices"
                      :key="device.deviceId || device.label"
                      :value="device.deviceId"
                    >
                      {{ device.label }}{{ device.isPreferredExternal ? ' · 外置优先' : '' }}
                    </option>
                  </select>
                  <div
                    v-else-if="singleVoiceAudioInputDevice"
                    class="max-w-[260px] truncate rounded-lg border border-white/10 bg-black/[0.18] px-3 py-2 text-sm text-white/66"
                    :title="singleVoiceAudioInputDevice.label"
                    data-testid="agent-settings-voice-audio-input-single"
                  >
                    {{ singleVoiceAudioInputDevice.label }}
                  </div>
                  <button
                    class="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/66 transition hover:bg-white/[0.08] disabled:opacity-40"
                    :disabled="voiceAudioInputLoading"
                    data-testid="agent-settings-voice-audio-input-refresh"
                    @click="refreshVoiceAudioInputs"
                  >
                    <Loader2 v-if="voiceAudioInputLoading" class="h-4 w-4 animate-spin" />
                    <RefreshCw v-else class="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-white/10 px-4 py-3.5">
                <div>
                  <div class="font-medium text-white/88">WebHID 绑定</div>
                  <div class="mt-1 text-sm text-white/42">已绑定的 HID 设备和报告字节。</div>
                </div>
                <div class="min-w-0 max-w-[360px] truncate font-mono text-sm text-white/70" :title="formatVoiceHidBinding(voiceHidBinding)">
                  {{ formatVoiceHidBinding(voiceHidBinding) }}
                </div>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-white/10 px-4 py-3.5">
                <div>
                  <div class="font-medium text-white/88">键盘绑定</div>
                  <div class="mt-1 text-sm text-white/42">蓝牙键盘或遥控器按键。</div>
                </div>
                <div class="min-w-0 max-w-[260px] truncate font-mono text-sm text-white/70" :title="formatVoiceKeyboardBinding(voiceKeyboardBinding)">
                  {{ formatVoiceKeyboardBinding(voiceKeyboardBinding) }}
                </div>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-white/10 px-4 py-3.5">
                <div>
                  <div class="font-medium text-white/88">状态</div>
                  <div class="mt-1 text-sm" :class="voiceHidSecureContext ? 'text-emerald-300/90' : 'text-yellow-200/90'">
                    {{ voiceButtonBindingMode === 'hid'
                      ? (voiceHidSecureContext ? 'Secure context，可使用 WebHID。' : 'WebHID 需要 HTTPS 或 localhost。')
                      : '可捕获键盘类输入设备。' }}
                  </div>
                  <div v-if="voiceHidBindingStatus" class="mt-1 text-xs text-cyan-100/70">{{ voiceHidBindingStatus }}</div>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    class="rounded-lg bg-white/14 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-white/20 disabled:opacity-40"
                    :disabled="voiceHidBindingActive"
                    @click="bindVoiceControlButton"
                  >
                    <Loader2 v-if="voiceHidBindingActive" class="mr-2 inline h-4 w-4 animate-spin" />
                    {{ voiceHidBindingActive ? '等待按键...' : '绑定按键' }}
                  </button>
                  <button
                    class="rounded-lg border border-white/10 px-3.5 py-2 text-sm text-white/66 transition hover:bg-white/[0.08] disabled:opacity-40"
                    :disabled="!voiceHidBinding && !voiceKeyboardBinding"
                    @click="clearVoiceHidBinding"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 border-t border-white/10 px-4 py-3.5">
                <div>
                  <label class="font-medium text-white/88" for="voice-vad-silence-seconds">自动发送等待</label>
                  <div class="mt-1 text-sm text-white/42">检测到静音后等待多久提交语音。</div>
                </div>
                <div class="flex items-center gap-2">
                  <input
                    id="voice-vad-silence-seconds"
                    v-model.number="voiceVadSilenceSeconds"
                    type="number"
                    min="0.5"
                    max="6"
                    step="0.1"
                    class="h-9 w-24 rounded-lg border border-white/10 bg-black/[0.24] px-3 text-sm text-white/82 outline-none"
                    @change="saveVoiceVadSilenceSetting"
                    @blur="saveVoiceVadSilenceSetting"
                  />
                  <span class="text-sm text-white/42">秒</span>
                </div>
              </div>
            </div>
          </section>
        </section>

        <section v-if="activeTab === 'skills'" data-testid="agent-settings-section-skills" class="mt-10 space-y-6">
          <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
            <h2 class="font-semibold">导入 Skill</h2>
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <input data-testid="agent-settings-skill-upload-input" type="file" accept=".zip,.tar.gz,.tgz" class="text-sm text-gray-300 disabled:opacity-40" disabled @change="onSkillFileChange" />
              <button data-testid="agent-settings-skill-upload-submit" class="rounded-md bg-blue-500 px-3 py-2 text-sm text-white disabled:opacity-40" disabled @click="uploadSelectedSkill">上传</button>
            </div>
            <div data-testid="agent-settings-skills-upload-tracked-gap" class="mt-3 rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-100/80">
              Skill 上传在 TS Manager 中仍是 tracked unsupported；不要把未实现的 POST /api/skills 暴露成可点击操作。
            </div>
          </div>
          <div class="grid gap-3 md:grid-cols-2">
            <div v-for="skill in skills" :key="skill.id" class="rounded-lg border border-white/10 bg-[#252525] p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="font-medium">{{ skill.name }}</div>
                  <div class="mt-1 text-sm text-gray-500">{{ skill.description || '无描述' }}</div>
                </div>
                <button class="rounded-md border border-red-500/30 px-2 py-1.5 text-red-300 hover:bg-red-500/10" @click="removeSkill(skill)"><Trash2 class="h-4 w-4" /></button>
              </div>
              <div class="mt-3 flex flex-wrap gap-2 text-xs">
                <span class="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-300">{{ skill.upload_status }}</span>
                <span :data-testid="`agent-settings-skill-runtime-status-${skill.id}`" class="rounded-full px-2 py-1" :class="skillRuntimeStatusClass(skill)">{{ skillRuntimeStatusLabel(skill) }}</span>
              </div>
              <div v-if="skill.upload_status === 'installed' && skill.runtime_status === 'unavailable_with_reason'" :data-testid="`agent-settings-skill-availability-diagnostic-${skill.id}`" class="mt-2 rounded border border-red-500/20 bg-red-500/5 px-2 py-1 text-xs text-red-300">
                {{ skillRuntimeStatus(skill) }}
              </div>
            </div>
          </div>
          <div v-if="!skills.length" data-testid="agent-settings-skills-empty-state" class="rounded-md border border-white/10 bg-[#252525] p-4 text-sm text-gray-500">暂无 Skill。</div>
        </section>

        <section v-if="activeTab === 'mcp'" data-testid="agent-settings-section-mcp" class="mt-10 space-y-6">
          <div class="rounded-lg border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-asset-diagnostics">
            <h2 class="font-semibold">新增 MCP Server</h2>
            <div class="mt-4 grid gap-3 md:grid-cols-2">
              <input v-model="newMcp.name" data-testid="agent-settings-mcp-create-name" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="名称" />
              <select v-model="newMcp.type" data-testid="agent-settings-mcp-create-type" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none">
                <option value="STDIO">STDIO</option>
                <option value="SSE">SSE</option>
              </select>
              <input v-model="newMcp.command" data-testid="agent-settings-mcp-create-command" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="STDIO command" />
              <input v-model="newMcp.url" data-testid="agent-settings-mcp-create-url" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="SSE URL" />
              <input v-model="newMcp.arguments" data-testid="agent-settings-mcp-create-arguments" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="arguments" />
              <input v-model="newMcp.environment_variables" data-testid="agent-settings-mcp-create-env" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="env JSON / string" />
            </div>
            <button data-testid="agent-settings-mcp-create-submit" class="mt-3 rounded-md bg-blue-500 px-3 py-2 text-sm text-white" @click="createMcpServer">添加 MCP</button>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525]">
            <div v-for="server in mcpServers" :key="server.id" :data-testid="`agent-settings-mcp-server-item-${server.id}`" class="grid gap-3 border-b border-white/10 px-4 py-3 last:border-0 md:grid-cols-[1fr_100px_120px]">
              <div>
                <div class="font-medium">{{ server.name }}</div>
                <div class="mt-1 text-xs text-gray-500">{{ server.type }} · {{ server.url || server.command || '-' }} · {{ formatValue(server.arguments) }}</div>
                <div class="mt-1 text-xs text-gray-600">
                  <span :data-testid="`agent-settings-mcp-runtime-status-${server.id}`" class="rounded-full px-2 py-0.5" :class="mcpRuntimeStatusClass(server)">{{ server.runtime_status ?? 'unknown' }}</span>
                  <span v-if="server.runtime_message" :data-testid="`agent-settings-mcp-runtime-message-${server.id}`" class="ml-1">— {{ server.runtime_message }}</span>
                </div>
                <div v-if="server.runtime_status === 'unavailable_with_reason'" :data-testid="`agent-settings-mcp-availability-diagnostic-${server.id}`" class="mt-1 rounded border border-red-500/20 bg-red-500/5 px-2 py-1 text-xs text-red-300">
                  {{ server.runtime_message }}
                </div>
              </div>
              <button :data-testid="`agent-settings-mcp-toggle-${server.id}`" class="rounded-md border border-white/10 px-3 py-1.5 text-sm" @click="toggleMcp(server)">{{ server.enabled ? '停用' : '启用' }}</button>
              <div class="flex items-center justify-end gap-2">
                <button
                  :data-testid="`agent-settings-mcp-refresh-runtime-${server.id}`"
                  class="rounded-md border border-white/10 px-2 py-1.5 text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                  title="刷新 runtime 可用性"
                  :disabled="saving === `refresh-mcp-${server.id}`"
                  @click="refreshMcpRuntime(server)"
                >
                  <Loader2 v-if="saving === `refresh-mcp-${server.id}`" class="h-4 w-4 animate-spin" />
                  <RefreshCw v-else class="h-4 w-4" />
                </button>
                <button :data-testid="`agent-settings-mcp-delete-${server.id}`" class="rounded-md border border-red-500/30 px-2 py-1.5 text-red-300 hover:bg-red-500/10" @click="removeMcp(server)"><Trash2 class="h-4 w-4" /></button>
              </div>
            </div>
            <div v-if="!mcpServers.length" data-testid="agent-settings-mcp-empty-state" class="p-4 text-sm text-gray-500">暂无 MCP Server。</div>
          </div>
          <div class="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-100/80">
            MCP Server 已配置于 TS Manager；worker 运行时加载尚未验证/追踪。
          </div>
        </section>

        <section v-if="activeTab === 'memory'" data-testid="agent-settings-section-memory" class="mt-10 space-y-6">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-md border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-memory-stats-total">
              <div class="text-sm text-gray-500">总记忆</div>
              <div class="mt-2 text-2xl font-semibold">{{ memoryStats?.total_memories ?? memories.length }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-memory-stats-weight">
              <div class="text-sm text-gray-500">平均权重</div>
              <div class="mt-2 text-2xl font-semibold">{{ memoryStats?.avg_weight ?? 0 }}</div>
            </div>
            <div class="rounded-md border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-experience-graph-summary">
              <div class="text-sm text-gray-500">Run experience KG</div>
              <div class="mt-2 flex items-center gap-2 text-sm" :class="experienceGraph?.available ? 'text-emerald-200' : 'text-yellow-200'">
                <CheckCircle2 v-if="experienceGraph?.available" class="h-4 w-4" />
                <XCircle v-else class="h-4 w-4" />
                {{ experienceGraphError ? '读取失败' : experienceGraph?.available ? `${experienceGraph.run_count} runs · ${percent(experienceGraph.success_rate)} 成功率` : '暂无可读图谱' }}
              </div>
              <div v-if="!experienceGraph?.available" class="mt-1" data-testid="agent-settings-experience-graph-tracked-gap">
                <span class="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200">tracked_gap: 经验图谱数据依赖后台 ingest</span>
              </div>
              <div class="mt-2 text-xs" :class="experienceGraphError ? 'text-red-300' : 'text-gray-500'">{{ experienceGraphError || (experienceGraph?.updated_at ? `更新于 ${formatDate(experienceGraph.updated_at)}` : experienceGraph?.reason || '等待自动 ingest') }}</div>
              <button class="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 text-sm text-cyan-100 hover:bg-cyan-400/15" @click="router.push('/agent/experience')">
                <Network class="h-4 w-4" />
                打开完整图谱
              </button>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-storage-info">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="font-semibold">Storage & Retention</h2>
                <p class="mt-1 text-xs text-gray-500">持久化运行数据、会话和证据的存储位置与保留状态。</p>
              </div>
              <span v-if="storageInfo" class="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">已连接</span>
              <span v-else class="rounded-full bg-yellow-500/10 px-2 py-1 text-xs text-yellow-200">加载中...</span>
            </div>
            <div v-if="storageInfo" class="mt-4 space-y-3">
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">Data Root</div>
                  <div class="mt-1 break-all font-mono text-sm">{{ storageInfo.data_root }}</div>
                </div>
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">Runs</div>
                  <div class="mt-1 text-lg font-semibold">{{ storageInfo.runs_count }}</div>
                </div>
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">Sessions Dir</div>
                  <div class="mt-1 break-all font-mono text-sm">{{ storageInfo.sessions_dir }}</div>
                </div>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span v-if="storageInfo.retention_supported" class="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-200">retention: supported</span>
                <span v-if="storageInfo.cleanup_tracked_gap" class="rounded-full bg-yellow-500/10 px-2 py-1 text-yellow-200" data-testid="agent-settings-storage-tracked-gap-cleanup">{{ storageInfo.cleanup_next_action }}</span>
                <span v-if="storageInfo.export_tracked_gap" class="rounded-full bg-yellow-500/10 px-2 py-1 text-yellow-200" data-testid="agent-settings-storage-tracked-gap-export">{{ storageInfo.export_next_action }}</span>
              </div>
            </div>
          </div>
          <div class="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div class="rounded-lg border border-white/10 bg-[#252525] p-4" data-testid="agent-settings-section-decorative-marker">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h2 class="font-semibold">经验图谱结构</h2>
                  <div class="mt-1 text-xs text-gray-500">{{ experienceGraph?.structure_coverage?.message || '尚未读取图谱状态。' }}</div>
                </div>
                <button class="rounded-md border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5" title="刷新经验图谱" aria-label="刷新经验图谱" @click="refreshMemory">
                  <RefreshCw class="h-4 w-4" />
                </button>
              </div>
              <div class="mt-3 rounded-md border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-100/80">
                这里展示的是运行经验图谱：Run 与模板、评分、失败根因和经验的关系。单次 DAG 原始拓扑仍在 DAG 运行页面查看。
              </div>
              <div class="mt-4 grid gap-2 sm:grid-cols-2">
                <div v-for="(ok, name) in experienceGraph?.structure_coverage?.checks || {}" :key="name" class="flex items-center justify-between rounded-md border border-white/10 bg-[#1e1e1e] px-3 py-2 text-sm">
                  <span class="text-gray-300">{{ coverageLabel(String(name)) }}</span>
                  <span :class="ok ? 'text-emerald-300' : 'text-yellow-300'">{{ boolLabel(ok) }}</span>
                </div>
              </div>
              <div class="mt-4 grid grid-cols-3 gap-2 text-sm">
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">节点</div>
                  <div class="mt-1 font-semibold">{{ experienceGraph?.node_count ?? 0 }}</div>
                </div>
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">关系</div>
                  <div class="mt-1 font-semibold">{{ experienceGraph?.relationship_count ?? 0 }}</div>
                </div>
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">失败运行</div>
                  <div class="mt-1 font-semibold">{{ experienceGraph?.failed_runs ?? 0 }}</div>
                </div>
              </div>
            </div>
            <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
              <h2 class="font-semibold">DAG 模板成功率</h2>
              <div class="mt-3 space-y-3">
                <div v-for="item in experienceGraph?.template_stats || []" :key="item.template" class="rounded-md border border-white/10 bg-[#1e1e1e] p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0 truncate text-sm font-medium">{{ item.template }}</div>
                    <div class="text-sm" :class="item.success_rate >= 0.8 ? 'text-emerald-300' : item.success_rate >= 0.5 ? 'text-yellow-300' : 'text-red-300'">{{ percent(item.success_rate) }}</div>
                  </div>
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div class="h-full rounded-full bg-emerald-400" :style="{ width: percent(item.success_rate) }"></div>
                  </div>
                  <div class="mt-2 text-xs text-gray-500">{{ item.runs }} runs · {{ item.failures }} failures · scorecard pass {{ item.scorecard_passes }}</div>
                  <div v-if="item.problem_categories.length" class="mt-2 flex flex-wrap gap-1">
                    <span v-for="category in item.problem_categories" :key="category" class="rounded bg-red-500/10 px-2 py-0.5 text-xs text-red-200">{{ category }}</span>
                  </div>
                </div>
                <div v-if="!(experienceGraph?.template_stats?.length)" class="text-sm text-gray-500">暂无模板运行统计。</div>
              </div>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h2 class="font-semibold">Shared Asset Root 诊断</h2>
                <p class="mt-1 text-xs text-gray-500">展示当前 asset 解析路径、symlink 状态和子目录可用性。</p>
              </div>
              <span
                class="rounded-full px-2 py-1 text-xs"
                :class="assetDiagnostics?.exists ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200'"
              >
                {{ assetDiagnostics?.env_source || '...' }}
              </span>
            </div>
            <div v-if="assetDiagnosticsError" class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{{ assetDiagnosticsError }}</div>
            <div v-if="assetDiagnostics" class="mt-4 space-y-3">
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">Asset Root</div>
                  <div class="mt-1 break-all font-mono text-sm" data-testid="agent-settings-asset-root">{{ assetDiagnostics.asset_root }}</div>
                </div>
                <div class="rounded-md bg-[#1e1e1e] p-3">
                  <div class="text-xs text-gray-500">Repo Seed</div>
                  <div class="mt-1 break-all font-mono text-sm">{{ assetDiagnostics.repo_seed_path }}</div>
                </div>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="rounded-full px-2 py-1" :class="assetDiagnostics.exists ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200'">
                  {{ assetDiagnostics.exists ? '目录存在' : '目录缺失' }}
                </span>
                <span v-if="assetDiagnostics.is_symlink" class="rounded-full bg-cyan-500/10 px-2 py-1 text-cyan-200">
                  symlink → {{ assetDiagnostics.symlink_target }}
                </span>
                <span v-if="assetDiagnostics.catalog_path" class="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-200">catalog.yaml</span>
                <span v-if="assetDiagnostics.experience_graph_path" class="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-200">db/graph.json</span>
              </div>
              <div class="grid gap-2 sm:grid-cols-3">
                <div
                  v-for="(status, name) in assetDiagnostics.subdirs"
                  :key="name"
                  class="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                  :class="status.exists ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'"
                >
                  <span class="text-gray-300">{{ name }}</span>
                  <CheckCircle2 v-if="status.exists" class="h-3.5 w-3.5 text-emerald-300" />
                  <XCircle v-else class="h-3.5 w-3.5 text-red-300" />
                </div>
              </div>
              <div class="rounded-md border border-white/10 bg-[#1e1e1e] p-3" data-testid="agent-settings-orchestration-templates">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-sm font-medium text-gray-200">DAG 模板目录</div>
                    <div class="mt-1 text-xs text-gray-500">默认只展示 catalog primary 模板；legacy/compat 不进入主要入口。</div>
                  </div>
                  <span class="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200">{{ orchestrationTemplates.length }} primary</span>
                </div>
                <div v-if="orchestrationTemplatesError" class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{{ orchestrationTemplatesError }}</div>
                <div class="mt-3 grid gap-2">
                  <div
                    v-for="template in orchestrationTemplates"
                    :key="template.id"
                    :data-testid="`agent-settings-orchestration-template-${template.id}`"
                    class="rounded-md border border-white/10 bg-black/20 px-3 py-2"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="truncate text-sm font-medium text-white">{{ template.name || template.id }}</div>
                        <div class="mt-1 truncate font-mono text-xs text-gray-500">{{ template.id }}</div>
                      </div>
                      <div class="flex flex-shrink-0 items-center gap-1 text-xs">
                        <span class="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-200">{{ template.category }}</span>
                        <span class="rounded bg-white/10 px-2 py-0.5 text-gray-200">{{ template.node_count }} nodes</span>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-1 text-xs">
                      <span
                        v-for="profile in template.supported_profiles || []"
                        :key="profile"
                        class="rounded bg-blue-500/10 px-2 py-0.5 text-blue-200"
                      >
                        {{ profile }}
                      </span>
                      <span v-if="!(template.supported_profiles?.length)" class="rounded bg-yellow-500/10 px-2 py-0.5 text-yellow-200">profile 未声明</span>
                    </div>
                    <div class="mt-2 break-all font-mono text-[11px] text-gray-500">{{ template.path }}</div>
                  </div>
                  <div v-if="!orchestrationTemplates.length && !orchestrationTemplatesError" class="text-sm text-gray-500">暂无 primary DAG 模板。</div>
                </div>
              </div>
            </div>
          </div>
          <div class="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
              <h2 class="font-semibold">主要问题</h2>
              <div class="mt-3 space-y-3">
                <div v-for="problem in experienceGraph?.problems || []" :key="problem.category" class="rounded-md border border-white/10 bg-[#1e1e1e] p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm font-medium">{{ problem.category }}</div>
                    <div class="text-xs text-gray-500">{{ problem.count }} 次 · {{ problem.severity || 'unknown' }}</div>
                  </div>
                  <div class="mt-1 text-sm text-gray-400">{{ problem.description || '无描述' }}</div>
                  <div v-if="problem.lesson_actions.length" class="mt-2 text-xs text-emerald-200">{{ problem.lesson_actions[0] }}</div>
                </div>
                <div v-if="!(experienceGraph?.problems?.length)" class="text-sm text-gray-500">暂无失败根因记录。</div>
              </div>
            </div>
            <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
              <h2 class="font-semibold">最近经验</h2>
              <div class="mt-3 space-y-3">
                <div v-for="lesson in experienceGraph?.lessons || []" :key="lesson.id" class="rounded-md border border-white/10 bg-[#1e1e1e] p-3">
                  <div class="text-sm font-medium">{{ lesson.summary || lesson.id }}</div>
                  <div class="mt-1 text-sm text-gray-400">{{ lesson.action || '无行动项' }}</div>
                </div>
                <div v-if="!(experienceGraph?.lessons?.length)" class="text-sm text-gray-500">暂无可复用经验。</div>
              </div>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525] p-4">
            <div class="grid gap-3 md:grid-cols-[1fr_160px_100px]">
              <input v-model="memoryQuery" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="搜索记忆" data-testid="agent-settings-memory-search" />
              <select v-model="memoryKind" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none">
                <option value="">全部类型</option>
                <option value="preference">preference</option>
                <option value="fact">fact</option>
                <option value="decision">decision</option>
                <option value="note">note</option>
              </select>
              <button class="rounded-md border border-white/10 px-3 py-2 text-sm hover:bg-white/5" @click="refreshMemory">搜索</button>
            </div>
            <div class="mt-4 grid gap-3 md:grid-cols-[1fr_150px_150px_80px]">
              <input v-model="newMemory.content" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="新增记忆" />
              <input v-model="newMemory.kind" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="kind" />
              <input v-model="newMemory.topic" class="h-10 rounded-md border border-white/10 bg-[#343434] px-3 text-sm outline-none" placeholder="topic" />
              <button class="rounded-md bg-blue-500 px-3 py-2 text-sm text-white" @click="addMemory" data-testid="agent-settings-memory-create-button">添加</button>
            </div>
          </div>
          <div class="rounded-lg border border-white/10 bg-[#252525]">
            <div v-for="memory in memories" :key="memory.id" class="grid gap-3 border-b border-white/10 px-4 py-3 last:border-0 md:grid-cols-[80px_1fr_110px_80px]" :data-testid="`agent-settings-memory-item-${memory.id}`">
              <div class="font-mono text-xs text-gray-500">#{{ memory.id }}</div>
              <div>
                <div class="text-sm">{{ memory.content }}</div>
                <div class="mt-1 text-xs text-gray-500">{{ formatDate(memory.created_at) }}</div>
              </div>
              <div class="text-sm text-gray-400">{{ memory.kind }} · {{ memory.weight.toFixed(2) }}</div>
              <button class="justify-self-end rounded-md border border-red-500/30 px-2 py-1.5 text-red-300 hover:bg-red-500/10" @click="removeMemory(memory)" :data-testid="`agent-settings-memory-delete-${memory.id}`"><Trash2 class="h-4 w-4" /></button>
            </div>
            <div v-if="!memories.length" data-testid="agent-settings-memory-empty-state" class="p-4 text-sm text-gray-500">暂无记忆。</div>
          </div>
        </section>
      </div>
    </main>

    <teleport to="body">
      <transition name="settings-git-overlay">
        <div v-if="gitDrawerOpen" class="settings-git-overlay" @click="closeGitDrawer" />
      </transition>
      <transition name="settings-git-panel">
        <aside v-if="gitDrawerOpen" class="settings-git-panel" data-testid="agent-settings-git-create-drawer" @click.stop>
          <form class="flex h-full flex-col" @submit.prevent="createGit">
            <header class="flex shrink-0 items-center justify-between border-b border-cyan-200/10 px-5 py-4">
              <div>
                <div class="text-xs tracking-[0.18em] text-cyan-200/45">Git Server</div>
                <h2 class="mt-1 text-base font-semibold text-cyan-50">添加 Token</h2>
              </div>
              <button
                type="button"
                class="inline-flex h-9 w-9 items-center justify-center border border-cyan-200/14 text-gray-400 transition-colors hover:bg-cyan-200/10 hover:text-white"
                @click="closeGitDrawer"
                title="关闭"
              >
                <X class="h-4 w-4" />
              </button>
            </header>

            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div class="grid gap-4">
                <label class="grid gap-2 text-sm text-white/60">
                  名称
                  <input
                    v-model.trim="newGitServer.name"
                    class="h-10 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none"
                    placeholder="HomeRail Gitea"
                    data-testid="agent-settings-git-create-name"
                  />
                </label>
                <label class="grid gap-2 text-sm text-white/60">
                  平台
                  <select
                    v-model="newGitServer.platform_type"
                    class="h-10 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none"
                    data-testid="agent-settings-git-create-platform"
                  >
                    <option v-for="platform in gitPlatformOptions" :key="platform.value" :value="platform.value">{{ platform.label }}</option>
                  </select>
                </label>
                <label class="grid gap-2 text-sm text-white/60">
                  API endpoint
                  <input
                    v-model.trim="newGitServer.api_endpoint"
                    class="h-10 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none"
                    placeholder="http://host:3000/api/v1"
                    data-testid="agent-settings-git-create-endpoint"
                  />
                </label>
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="grid min-w-0 gap-2 text-sm text-white/60">
                    Git user
                    <input v-model.trim="newGitServer.git_user_name" class="h-10 min-w-0 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none" placeholder="可选" />
                  </label>
                  <label class="grid min-w-0 gap-2 text-sm text-white/60">
                    Git email
                    <input v-model.trim="newGitServer.git_user_email" class="h-10 min-w-0 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none" placeholder="可选" />
                  </label>
                </div>
                <label class="grid gap-2 text-sm text-white/60">
                  Token
                  <input
                    v-model.trim="newGitServer.token"
                    type="password"
                    class="h-10 rounded-md border border-white/10 bg-[#202728] px-3 text-sm text-white outline-none"
                    placeholder="Access token"
                    data-testid="agent-settings-git-create-token"
                    autocomplete="off"
                  />
                </label>
                <label class="grid gap-2 text-sm text-white/60">
                  备注
                  <textarea
                    v-model.trim="newGitServer.description"
                    class="min-h-[86px] resize-none rounded-md border border-white/10 bg-[#202728] px-3 py-2 text-sm text-white outline-none"
                    placeholder="可选"
                  />
                </label>
              </div>
            </div>

            <footer class="flex shrink-0 justify-end gap-2 border-t border-cyan-200/10 px-5 py-4">
              <button
                type="button"
                class="h-10 border border-white/10 px-4 text-sm text-white/60 hover:bg-white/5 hover:text-white"
                @click="closeGitDrawer"
              >
                取消
              </button>
              <button
                type="submit"
                class="inline-flex h-10 items-center justify-center gap-2 bg-blue-500 px-4 text-sm text-white hover:bg-blue-400 disabled:opacity-40"
                :disabled="saving === 'create-git' || !newGitServer.name.trim() || !newGitServer.api_endpoint.trim() || !newGitServer.token.trim()"
                data-testid="agent-settings-git-create-submit"
              >
                <Loader2 v-if="saving === 'create-git'" class="h-4 w-4 animate-spin" />
                <Plus v-else class="h-4 w-4" />
                添加
              </button>
            </footer>
          </form>
        </aside>
      </transition>
    </teleport>

  </div>
</template>

<style scoped>
.agent-settings-shell {
  --settings-card-radius: 24px;
  --settings-control-radius: 18px;
  --settings-field-bg: rgba(255, 255, 255, 0.045);
  --settings-border: rgba(103, 232, 249, 0.14);
}

.agent-settings-shell :deep(section) {
  margin-top: 36px;
}

.agent-settings-shell :deep(.rounded-md),
.agent-settings-shell :deep(.rounded-lg) {
  border-radius: var(--settings-card-radius);
}

.agent-settings-shell :deep(input),
.agent-settings-shell :deep(select),
.agent-settings-shell :deep(textarea) {
  min-height: 42px;
  border-color: var(--settings-border);
  border-radius: var(--settings-control-radius);
  background: var(--settings-field-bg);
  color: rgba(255, 255, 255, 0.84);
}

.agent-settings-shell :deep(input::placeholder),
.agent-settings-shell :deep(textarea::placeholder) {
  color: rgba(255, 255, 255, 0.32);
}

.agent-settings-shell :deep(button) {
  border-radius: 999px;
}

.agent-settings-shell :deep(button:focus-visible),
.agent-settings-shell :deep(select:focus-visible),
.agent-settings-shell :deep(input:focus-visible),
.agent-settings-shell :deep(textarea:focus-visible),
.agent-settings-shell :deep(a:focus-visible),
.agent-settings-shell :deep([tabindex]:focus-visible) {
  outline: 2px solid rgba(103, 232, 249, 0.9);
  outline-offset: 3px;
  box-shadow: 0 0 0 6px rgba(103, 232, 249, 0.12);
}

.agent-settings-shell :deep(section > div),
.agent-settings-shell :deep(.grid > div),
.agent-settings-shell :deep(label) {
  border-color: var(--settings-border);
}

.agent-settings-shell :deep(section > .bg-\[\#252525\]),
.agent-settings-shell :deep(.grid > .bg-\[\#252525\]),
.agent-settings-shell :deep(.bg-\[\#343434\]) {
  background: rgba(255, 255, 255, 0.042);
}

.settings-git-overlay {
  position: fixed;
  inset: 0;
  z-index: 79;
  background: rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(2px);
}

.settings-git-panel {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 80;
  width: min(560px, 94vw);
  border-left: 1px solid rgba(103, 232, 249, 0.14);
  background: rgba(7, 16, 18, 0.97);
  color: rgba(255, 255, 255, 0.88);
  box-shadow: -24px 0 80px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(24px);
}

.settings-git-overlay-enter-active,
.settings-git-overlay-leave-active {
  transition: opacity 200ms ease;
}

.settings-git-overlay-enter-from,
.settings-git-overlay-leave-to {
  opacity: 0;
}

.settings-git-panel-enter-active {
  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}

.settings-git-panel-leave-active {
  transition: transform 180ms cubic-bezier(0.4, 0, 1, 1);
}

.settings-git-panel-enter-from,
.settings-git-panel-leave-to {
  transform: translateX(100%);
}

</style>

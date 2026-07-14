import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DAGTaskNode, DAGEdge, DAGExecution, DAGNodeStatus } from '@/api/types/dag.types'
import { bindAgentDagEvents } from './agent/dag-events'
import { mapManagerSessionMessages } from './agent/message-mapper'
import { clearAgentSession, loadAgentSession, saveAgentSession } from './agent/persistence'
import type { AgentChatMessage, AgentInspectorTab, ManagerSessionItem } from './agent/types'
import type { LLMSetting } from '@/api/services/llm-settings-api'
import { isKimiProviderId } from '@/lib/model-runtime'
import {
  deleteManagerSession,
  getManagerAgentConfig,
  getManagerSessionMessages,
  listManagerSessions,
  updateManagerAgentConfig,
} from '@/api/agent'

export type { AgentChatMessage, AgentInspectorTab, ManagerSessionItem } from './agent/types'

function loadOnboardingDismissed(): boolean {
  return false
}

function saveOnboardingDismissed(value: boolean): void {
  void value
}

function isDedicatedManagerAgentSetting(setting: LLMSetting): boolean {
  return Boolean(setting.supports_llm && !setting.supports_asr && !setting.supports_tts)
}

export const useAgentStore = defineStore('agent', () => {
  const currentRunId = ref<string | null>(null)
  const managerSessionId = ref<string | null>(null)
  const managerProjectId = ref<string | null>(null)
  const dagExecution = ref<DAGExecution | null>(null)
  const nodes = ref<DAGTaskNode[]>([])
  const edges = ref<DAGEdge[]>([])
  const selectedNodeId = ref<string | null>(null)
  const chatMessages = ref<AgentChatMessage[]>([])
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const sidebarCollapsed = ref(false)
  const rightPanelCollapsed = ref(false)
  const settingsPageOpen = ref(false)
  const voiceCockpitOpen = ref(false)
  const runtimeOverlayOpen = ref(false)
  const onboardingOpen = ref(false)
  const onboardingManualDebug = ref(false)
  const onboardingDismissed = ref(loadOnboardingDismissed())
  const inspectorTab = ref<AgentInspectorTab>('progress')
  const hasStarted = ref(true)
  const wsStreamedCount = ref(0)
  const managerResponding = ref(false)
  const managerSessions = ref<ManagerSessionItem[]>([])
  const sessionStatusOverrides = ref<Record<string, { status: string; end_time?: string | null; run_ids?: string[] }>>({})
  const sessionsLoading = ref(false)
  const sidebarSearch = ref('')
  const managerProviderName = ref('')
  const managerModelName = ref('')
  const managerSettingId = ref<string | null>(null)
  const managerRuntimeOptions = ref<LLMSetting[]>([])
  const managerRuntimeLoading = ref(false)

  const selectedNode = computed<DAGTaskNode | null>(() => {
    if (!selectedNodeId.value) return null
    return nodes.value.find(n => n.id === selectedNodeId.value) ?? null
  })

  const selectedNodeIsManager = computed(() => {
    if (!selectedNodeId.value) return false
    const node = nodes.value.find(n => n.id === selectedNodeId.value)
    return node?.agent_name?.toLowerCase().includes('manager') ?? false
  })

  const statusSummary = computed(() => {
    const counts: Record<DAGNodeStatus, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    }
    for (const node of nodes.value) {
      counts[node.status] += 1
    }
    return counts
  })

  const isRunning = computed(() => {
    return dagExecution.value?.status === 'running'
  })

  const isCompleted = computed(() => {
    return dagExecution.value?.status === 'completed'
  })

  const isFailed = computed(() => {
    return dagExecution.value?.status === 'failed'
  })

  const selectedSessionInfo = computed<ManagerSessionItem | null>(() => {
    if (!managerSessionId.value) return null
    return managerSessions.value.find(s => s.session_id === managerSessionId.value) ?? null
  })

  const filteredSessions = computed(() => {
    const q = sidebarSearch.value.toLowerCase().trim()
    if (!q) return managerSessions.value
    return managerSessions.value.filter(s => {
      const label = (s.prompt || s.session_id).toLowerCase()
      return label.includes(q)
    })
  })

  const activeManagerModels = computed(() => {
    return managerRuntimeOptions.value.filter(setting => setting.is_active)
  })

  const llmRuntimeModels = computed(() => {
    return activeManagerModels.value.filter(isDedicatedManagerAgentSetting)
  })

  const asrRuntimeModels = computed(() => {
    return activeManagerModels.value.filter(setting => setting.supports_asr)
  })

  const omniRuntimeModels = computed(() => {
    return activeManagerModels.value.filter(setting => setting.supports_audio_input)
  })

  const ttsRuntimeModels = computed(() => {
    return activeManagerModels.value.filter(setting => setting.supports_tts)
  })

  const managerProviderOptions = computed(() => {
    return Array.from(new Set(llmRuntimeModels.value.map(setting => setting.provider_id))).sort()
  })

  const managerModelOptions = computed(() => {
    return llmRuntimeModels.value
      .filter(setting => setting.provider_id === managerProviderName.value)
      .map(setting => setting.model_name)
  })

  function managerProviderLabel(providerId: string): string {
    return llmRuntimeModels.value.find(setting => setting.provider_id === providerId)?.provider_name || providerId
  }

  function managerModelLabel(providerId: string, modelName: string): string {
    const setting = llmRuntimeModels.value.find(item => item.provider_id === providerId && item.model_name === modelName)
    if (!setting) return modelName
    const alias = setting.display_name && setting.display_name !== setting.model_name ? `${setting.display_name} · ` : ''
    const plan = setting.plan_type ? ` · ${setting.plan_type}` : ''
    return `${alias}${setting.model_name}${plan}`
  }

  const managerRuntimeLabel = computed(() => {
    return `${managerProviderLabel(managerProviderName.value) || '-'} / ${managerModelLabel(managerProviderName.value, managerModelName.value) || '-'}`
  })

  function persist(): void {
    saveAgentSession({
      runId: currentRunId.value,
      sessionId: managerSessionId.value,
      projectId: managerProjectId.value,
      managerProviderName: managerProviderName.value || null,
      managerModelName: managerModelName.value || null,
    })
  }

  function saveManagerRuntimeSetting(setting: LLMSetting): void {
    void updateManagerAgentConfig({
      llm_setting_id: setting.id,
      provider_name: setting.provider_id,
      model_name: setting.model_name,
    }).catch(() => { /* backend validation will surface on next turn */ })
  }

  function chooseDefaultRuntime(saveToBackend = false): void {
    const active = llmRuntimeModels.value
    if (!active.length) return
    const current = active.find(
      setting => setting.provider_id === managerProviderName.value && setting.model_name === managerModelName.value,
    )
    const legacyDefault = isKimiProviderId(managerProviderName.value) && managerModelName.value === 'K2.6'
    if (current && !legacyDefault) return
    const preferred = active.find(setting => setting.is_default)
      ?? active.find(setting => setting.provider_id === 'kimi_cn' && setting.model_name === 'kimi-k2.7-code')
      ?? active.find(setting => setting.provider_id === 'kimi' && setting.model_name === 'kimi-k2.7-code')
      ?? active.find(setting => setting.provider_id === 'kimi_cn' && setting.model_name === 'K2.6')
      ?? active.find(setting => setting.provider_id === 'kimi' && setting.model_name === 'K2.6')
      ?? active[0]
    managerProviderName.value = preferred.provider_id
    managerModelName.value = preferred.model_name
    managerSettingId.value = preferred.id ?? null
    persist()
    if (saveToBackend && preferred.id) saveManagerRuntimeSetting(preferred)
  }

  function applyManagerAgentConfig(config: Record<string, any> | null | undefined): boolean {
    if (!config) return false
    if (config.harness === 'codex_appserver') {
      managerSettingId.value = null
      managerProviderName.value = 'codex'
      managerModelName.value = typeof config.model_name === 'string' ? config.model_name : ''
      persist()
      return true
    }
    const settingId = typeof config.llm_setting_id === 'string' ? config.llm_setting_id : ''
    const setting = settingId
      ? llmRuntimeModels.value.find(item => item.id === settingId)
      : llmRuntimeModels.value.find(item =>
        item.provider_id === config.provider_name && item.model_name === config.model_name
      )
    if (!setting) return false
    managerSettingId.value = setting.id ?? null
    managerProviderName.value = setting.provider_id
    managerModelName.value = setting.model_name
    persist()
    return true
  }

  async function loadManagerAgentRuntimeConfig(): Promise<boolean> {
    try {
      const res = await getManagerAgentConfig()
      return applyManagerAgentConfig((res as any).data ?? res)
    } catch {
      return false
    }
  }

  async function loadManagerRuntimeOptions(): Promise<void> {
    managerRuntimeLoading.value = true
    try {
      const { listLLMSettings } = await import('@/api/services/llm-settings-api')
      const res = await listLLMSettings()
      managerRuntimeOptions.value = res.data?.settings ?? []
      const loaded = await loadManagerAgentRuntimeConfig()
      if (!loaded) chooseDefaultRuntime(true)
    } catch {
      managerRuntimeOptions.value = []
    } finally {
      managerRuntimeLoading.value = false
    }
  }

  function setManagerRuntime(provider: string, model?: string): void {
    managerProviderName.value = provider
    if (model) {
      managerModelName.value = model
    } else {
      const firstModel = llmRuntimeModels.value.find(setting => setting.provider_id === provider)?.model_name
      if (firstModel) managerModelName.value = firstModel
    }
    const setting = llmRuntimeModels.value.find(item =>
      item.provider_id === managerProviderName.value && item.model_name === managerModelName.value
    )
    managerSettingId.value = setting?.id ?? null
    persist()
    if (setting?.id) {
      saveManagerRuntimeSetting(setting)
    }
  }

  function setRunId(runId: string): void {
    currentRunId.value = runId
    persist()
  }

  function clearRunId(): void {
    currentRunId.value = null
  }

  function setDagExecution(execution: DAGExecution): void {
    dagExecution.value = execution
    nodes.value = execution.nodes
    edges.value = execution.edges
  }

  function updateNodeStatus(nodeId: string, status: DAGNodeStatus): void {
    const node = nodes.value.find(n => n.id === nodeId)
    if (node) {
      node.status = status
    }
  }

  function selectNode(nodeId: string | null): void {
    selectedNodeId.value = nodeId
  }

  function addChatMessage(message: AgentChatMessage): void {
    chatMessages.value.push(message)
    persist()
  }

  function clearChatMessages(): void {
    chatMessages.value = []
  }

  function setOnboardingDismissed(value: boolean): void {
    onboardingDismissed.value = value
    saveOnboardingDismissed(value)
  }

  function openOnboarding(options: { manualDebug?: boolean } = {}): void {
    onboardingManualDebug.value = Boolean(options.manualDebug)
    onboardingOpen.value = true
  }

  function closeOnboarding(): void {
    onboardingManualDebug.value = false
    onboardingOpen.value = false
  }

  function dismissOnboarding(): void {
    onboardingManualDebug.value = false
    onboardingOpen.value = false
    setOnboardingDismissed(true)
  }

  function completeOnboarding(): void {
    onboardingManualDebug.value = false
    onboardingOpen.value = false
    setOnboardingDismissed(false)
  }

  function reset(): void {
    const provider = managerProviderName.value
    const model = managerModelName.value
    const settingId = managerSettingId.value
    const options = managerRuntimeOptions.value
    currentRunId.value = null
    managerSessionId.value = null
    managerProjectId.value = null
    dagExecution.value = null
    nodes.value = []
    edges.value = []
    selectedNodeId.value = null
    chatMessages.value = []
    isLoading.value = false
    error.value = null
    rightPanelCollapsed.value = false
    settingsPageOpen.value = false
    voiceCockpitOpen.value = false
    runtimeOverlayOpen.value = false
    inspectorTab.value = 'progress'
    hasStarted.value = true
    managerResponding.value = false
    managerSessions.value = []
    sessionStatusOverrides.value = {}
    sidebarSearch.value = ''
    managerProviderName.value = provider
    managerModelName.value = model
    managerSettingId.value = settingId
    managerRuntimeOptions.value = options
    clearAgentSession()
    persist()
  }

  function setManagerProjectId(projectId: string | null): void {
    if (managerProjectId.value === projectId) return
    const isInitialProject = managerProjectId.value === null
    managerProjectId.value = projectId
    if (isInitialProject) {
      persist()
      if (projectId) void fetchManagerSessions()
      return
    }
    managerSessionId.value = null
    currentRunId.value = null
    chatMessages.value = []
    dagExecution.value = null
    nodes.value = []
    edges.value = []
    selectedNodeId.value = null
    sidebarSearch.value = ''
    persist()
  }

  function startNewSession(): void {
    const projectId = managerProjectId.value
    reset()
    managerProjectId.value = projectId
    persist()
    if (projectId) void fetchManagerSessions()
  }

  async function switchToRun(runId: string, projectId?: string): Promise<void> {
    currentRunId.value = runId
    if (projectId) managerProjectId.value = projectId
    managerSessionId.value = null
    chatMessages.value = []
    dagExecution.value = null
    nodes.value = []
    edges.value = []
    selectedNodeId.value = null
    persist()
    try {
      const { getDagStatus } = await import('@/api/services/dag-api')
      const dag = await getDagStatus(runId)
      if (dag) setDagExecution(dag)
    } catch { /* ignore */ }
  }

  async function fetchManagerSessions(): Promise<void> {
    if (!managerProjectId.value) return
    sessionsLoading.value = true
    try {
      const res = await listManagerSessions(managerProjectId.value)
      managerSessions.value = ((res.data as any)?.sessions ?? []).map((session: ManagerSessionItem) => {
        const override = sessionStatusOverrides.value[session.session_id]
        if (!override) return session
        return {
          ...session,
          ...override,
          run_ids: override.run_ids ? Array.from(new Set([...session.run_ids, ...override.run_ids])) : session.run_ids,
        }
      })
    } catch {
      managerSessions.value = []
    } finally {
      sessionsLoading.value = false
    }
  }

  function updateManagerSessionStatus(sessionId: string | null | undefined, status: string, runId?: string | null): void {
    if (!sessionId) return
    const override = {
      status,
      end_time: (status === 'completed' || status === 'failed') ? new Date().toISOString() : null,
      run_ids: runId ? [runId] : undefined,
    }
    sessionStatusOverrides.value[sessionId] = override
    const session = managerSessions.value.find(s => s.session_id === sessionId)
    if (!session) return
    session.status = status
    if (status === 'completed' || status === 'failed') {
      session.end_time = override.end_time ?? session.end_time
    }
    if (runId && !session.run_ids.includes(runId)) {
      session.run_ids.push(runId)
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    managerSessionId.value = sessionId
    currentRunId.value = null
    chatMessages.value = []
    dagExecution.value = null
    nodes.value = []
    edges.value = []
    selectedNodeId.value = null
    persist()

    // Load messages from DB
    try {
      const res = await getManagerSessionMessages(sessionId)
      const msgs = (res.data as any)?.messages ?? []
      chatMessages.value = mapManagerSessionMessages(msgs, sessionId)
    } catch { /* ignore */ }

    // Load last run's DAG if session has run_ids
    const session = managerSessions.value.find(s => s.session_id === sessionId)
    if (session?.manager_provider_name && session?.manager_model_name) {
      managerProviderName.value = session.manager_provider_name
      managerModelName.value = session.manager_model_name
      managerSettingId.value = managerRuntimeOptions.value.find(item =>
        item.provider_id === session.manager_provider_name && item.model_name === session.manager_model_name
      )?.id ?? managerSettingId.value
      persist()
    }
    if (session?.run_ids?.length) {
      const lastRunId = session.run_ids[session.run_ids.length - 1]
      currentRunId.value = lastRunId
      try {
        const { getDagStatus } = await import('@/api/services/dag-api')
        const dag = await getDagStatus(lastRunId)
        if (dag) setDagExecution(dag)
      } catch { /* run might be expired */ }
    }
  }

  async function deleteSession(sessionId: string): Promise<void> {
    try {
      await deleteManagerSession(sessionId)
      managerSessions.value = managerSessions.value.filter(s => s.session_id !== sessionId)
      if (managerSessionId.value === sessionId) {
        reset()
      }
    } catch { /* ignore */ }
  }

  async function restoreSession(): Promise<boolean> {
    const saved = loadAgentSession()
    if (!saved) return false

    managerSessionId.value = saved.sessionId
    managerProjectId.value = saved.projectId
    managerProviderName.value = saved.managerProviderName ?? managerProviderName.value
    managerModelName.value = saved.managerModelName ?? managerModelName.value
    chatMessages.value = []
    hasStarted.value = true

    if (saved.sessionId) {
      try {
        const res = await getManagerSessionMessages(saved.sessionId)
        const msgs = (res.data as any)?.messages ?? []
        chatMessages.value = mapManagerSessionMessages(msgs, saved.sessionId)
      } catch { /* ignore */ }
    }

    if (saved.runId) {
      currentRunId.value = saved.runId
      try {
        const { getDagStatus } = await import('@/api/services/dag-api')
        const dag = await getDagStatus(saved.runId)
        if (dag) {
          setDagExecution(dag)
          return true
        }
      } catch { /* run might be expired */ }
      return true
    }

    return saved.sessionId != null
  }

  function hasWsStreamed(): boolean {
    return wsStreamedCount.value > 0
  }

  function resetWsStreamed(): void {
    wsStreamedCount.value = 0
  }

  const initialize = bindAgentDagEvents({
    currentRunId,
    dagExecution,
    nodes,
    edges,
    selectedNodeId,
    chatMessages,
    wsStreamedCount,
    persist,
    setDagExecution,
    selectNode,
  })

  return {
    // State
    currentRunId,
    managerSessionId,
    managerProjectId,
    dagExecution,
    nodes,
    edges,
    selectedNodeId,
    chatMessages,
    isLoading,
    error,
    sidebarCollapsed,
    rightPanelCollapsed,
    settingsPageOpen,
    voiceCockpitOpen,
    runtimeOverlayOpen,
    onboardingOpen,
    onboardingManualDebug,
    onboardingDismissed,
    inspectorTab,
    hasStarted,
    managerResponding,
    managerSessions,
    sessionsLoading,
    sidebarSearch,
    managerProviderName,
    managerModelName,
    managerSettingId,
    managerRuntimeOptions,
    llmRuntimeModels,
    omniRuntimeModels,
    asrRuntimeModels,
    ttsRuntimeModels,
    managerRuntimeLoading,
    // Computed
    selectedNode,
    selectedNodeIsManager,
    statusSummary,
    isRunning,
    isCompleted,
    isFailed,
    selectedSessionInfo,
    filteredSessions,
    activeManagerModels,
    managerProviderOptions,
    managerModelOptions,
    managerRuntimeLabel,
    managerProviderLabel,
    managerModelLabel,
    // Actions
    setRunId,
    clearRunId,
    setDagExecution,
    updateNodeStatus,
    selectNode,
    addChatMessage,
    clearChatMessages,
    reset,
    setOnboardingDismissed,
    openOnboarding,
    closeOnboarding,
    dismissOnboarding,
    completeOnboarding,
    setManagerProjectId,
    startNewSession,
    restoreSession,
    switchToRun,
    initialize,
    hasWsStreamed,
    resetWsStreamed,
    fetchManagerSessions,
    updateManagerSessionStatus,
    selectSession,
    deleteSession,
    loadManagerRuntimeOptions,
    setManagerRuntime,
  }
})

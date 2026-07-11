const STORAGE_KEY = 'omni-agent-session'

export interface PersistedAgentSession {
  runId: string | null
  sessionId: string | null
  projectId: string | null
  managerProviderName?: string | null
  managerModelName?: string | null
}

export function saveAgentSession(state: PersistedAgentSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      runId: state.runId ?? null,
      sessionId: state.sessionId ?? null,
      projectId: state.projectId ?? null,
      managerProviderName: state.managerProviderName ?? null,
      managerModelName: state.managerModelName ?? null,
    }))
  } catch { /* ignore quota errors */ }
}

export function loadAgentSession(): PersistedAgentSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const state: PersistedAgentSession = {
      runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      managerProviderName: typeof parsed.managerProviderName === 'string' ? parsed.managerProviderName : null,
      managerModelName: typeof parsed.managerModelName === 'string' ? parsed.managerModelName : null,
    }
    if ('messages' in parsed) saveAgentSession(state)
    return state
  } catch {
    return null
  }
}

export function clearAgentSession(): void {
  localStorage.removeItem(STORAGE_KEY)
}

const ONBOARDING_DISMISSED_KEY = 'omni-agent-onboarding-dismissed'

export function saveOnboardingDismissed(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1')
    } else {
      localStorage.removeItem(ONBOARDING_DISMISSED_KEY)
    }
  } catch { /* ignore quota errors */ }
}

export function loadOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

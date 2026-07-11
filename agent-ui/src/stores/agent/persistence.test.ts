import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearAgentSession, loadAgentSession, loadOnboardingDismissed, saveAgentSession, saveOnboardingDismissed } from './persistence'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('Agent session persistence', () => {
  it('saves and loads the current run, session, project, and Manager model', () => {
    saveAgentSession({
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      managerProviderName: 'openrouter',
      managerModelName: 'hy3:free'
    })

    expect(loadAgentSession()).toEqual({
      runId: 'run-1',
      sessionId: 'session-1',
      projectId: 'project-1',
      managerProviderName: 'openrouter',
      managerModelName: 'hy3:free'
    })
  })

  it('normalizes invalid persisted fields and removes legacy messages', () => {
    localStorage.setItem(
      'omni-agent-session',
      JSON.stringify({
        runId: 42,
        sessionId: 'session-1',
        projectId: null,
        managerProviderName: false,
        managerModelName: 'model-1',
        messages: [{ content: 'legacy payload' }]
      })
    )

    expect(loadAgentSession()).toEqual({
      runId: null,
      sessionId: 'session-1',
      projectId: null,
      managerProviderName: null,
      managerModelName: 'model-1'
    })
    expect(JSON.parse(localStorage.getItem('omni-agent-session') || '{}')).not.toHaveProperty(
      'messages'
    )
  })

  it('returns null for missing or corrupt storage', () => {
    expect(loadAgentSession()).toBeNull()
    localStorage.setItem('omni-agent-session', '{invalid json')
    expect(loadAgentSession()).toBeNull()
  })

  it('ignores storage quota failures and clears persisted state', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    expect(() => saveAgentSession({ runId: null, sessionId: null, projectId: null })).not.toThrow()

    vi.restoreAllMocks()
    localStorage.setItem('omni-agent-session', '{}')
    clearAgentSession()
    expect(localStorage.getItem('omni-agent-session')).toBeNull()
  })
})

describe('Onboarding dismissal persistence', () => {
  it('persists dismissal across reloads', () => {
    expect(loadOnboardingDismissed()).toBe(false)

    saveOnboardingDismissed(true)

    expect(localStorage.getItem('omni-agent-onboarding-dismissed')).toBe('1')
    expect(loadOnboardingDismissed()).toBe(true)
  })

  it('clears the flag when dismissal is reset', () => {
    saveOnboardingDismissed(true)

    saveOnboardingDismissed(false)

    expect(localStorage.getItem('omni-agent-onboarding-dismissed')).toBeNull()
    expect(loadOnboardingDismissed()).toBe(false)
  })

  it('ignores storage failures', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })
    expect(() => saveOnboardingDismissed(true)).not.toThrow()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(loadOnboardingDismissed()).toBe(false)
  })
})

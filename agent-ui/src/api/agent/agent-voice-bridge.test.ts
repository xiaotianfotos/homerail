import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentSessionApi } from './agent-session-api'
import { createVoiceModeSession, runVoiceTextTurn, submitVoiceTextTurn } from './agent-voice-bridge'

const session = {
  id: 'session-1',
  project_id: '',
  status: 'active',
  created_at: 'created',
  updated_at: 'updated'
}

const turn = {
  session_id: 'session-1',
  run_id: 'run-1',
  turn_id: 'turn-1',
  user_message: { role: 'user', content: 'Review' },
  assistant_message: { role: 'assistant', content: 'Done' }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Agent voice-text bridge', () => {
  it('creates a native session and merges caller-provided voice metadata', async () => {
    const create = vi.spyOn(agentSessionApi, 'createNativeSession').mockResolvedValue(session)

    await expect(
      createVoiceModeSession({ source: 'attempted-override', locale: 'zh-Hans' })
    ).resolves.toBe(session)
    expect(create).toHaveBeenCalledWith({
      metadata: {
        voice_mode: true,
        source: 'attempted-override',
        locale: 'zh-Hans'
      }
    })
  })

  it('submits voice text through the native session turn endpoint', async () => {
    const submit = vi.spyOn(agentSessionApi, 'submitNativeTextTurn').mockResolvedValue(turn)

    await expect(submitVoiceTextTurn('session-1', 'Review')).resolves.toBe(turn)
    expect(submit).toHaveBeenCalledWith('session-1', { message: 'Review' })
  })

  it('creates a session before submitting the convenience text turn', async () => {
    const create = vi.spyOn(agentSessionApi, 'createNativeSession').mockResolvedValue(session)
    const submit = vi.spyOn(agentSessionApi, 'submitNativeTextTurn').mockResolvedValue(turn)

    await expect(runVoiceTextTurn('Review')).resolves.toEqual({ session, turn })
    expect(create).toHaveBeenCalledBefore(submit)
    expect(submit).toHaveBeenCalledWith('session-1', { message: 'Review' })
  })
})

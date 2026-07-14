import { describe, expect, it } from 'vitest'
import {
  resolveVoiceSessionProjectRestore,
  VoiceSessionTransitionGuard,
} from './voice-session-restore'

describe('voice session project restore', () => {
  it('adopts the current session project while the store is not initialized', () => {
    expect(resolveVoiceSessionProjectRestore(null, 'project-one')).toEqual({
      accepted: true,
      projectId: 'project-one',
    })
  })

  it('accepts an unscoped session while the store is not initialized', () => {
    expect(resolveVoiceSessionProjectRestore(null, null)).toEqual({
      accepted: true,
      projectId: null,
    })
  })

  it('accepts the selected project and rejects a different project', () => {
    expect(resolveVoiceSessionProjectRestore('project-one', 'project-one').accepted).toBe(true)
    expect(resolveVoiceSessionProjectRestore('project-one', 'project-two').accepted).toBe(false)
  })

  it('rejects stale async session transitions after a newer selection begins', () => {
    const guard = new VoiceSessionTransitionGuard()
    const initialRestore = guard.begin()
    const explicitSelection = guard.begin()

    expect(guard.isCurrent(initialRestore)).toBe(false)
    expect(guard.isCurrent(explicitSelection)).toBe(true)
  })
})

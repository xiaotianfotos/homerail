import { describe, expect, it } from 'vitest'
import {
  shouldReplaceVoiceWorkspaceForProject,
  voiceProjectSelectionChanged,
} from './voice-project-selection'

describe('shouldReplaceVoiceWorkspaceForProject', () => {
  it('leaves initial session restoration in charge before a workspace exists', () => {
    expect(shouldReplaceVoiceWorkspaceForProject(null, 'project-b')).toBe(false)
  })

  it('preserves a workspace that belongs to the selected project', () => {
    expect(
      shouldReplaceVoiceWorkspaceForProject({ project_id: 'project-a' }, 'project-a'),
    ).toBe(false)
    expect(shouldReplaceVoiceWorkspaceForProject({ project_id: null }, null)).toBe(false)
  })

  it('replaces stale workspaces for direct Settings and sidebar project changes', () => {
    expect(
      shouldReplaceVoiceWorkspaceForProject({ project_id: 'project-a' }, 'project-b'),
    ).toBe(true)
    expect(shouldReplaceVoiceWorkspaceForProject({ project_id: 'project-a' }, null)).toBe(true)
  })

  it('detects project changes while a session request is in flight', () => {
    expect(voiceProjectSelectionChanged('project-a', 'project-b')).toBe(true)
    expect(voiceProjectSelectionChanged(null, 'project-b')).toBe(true)
    expect(voiceProjectSelectionChanged('project-a', 'project-a')).toBe(false)
    expect(voiceProjectSelectionChanged(null, null)).toBe(false)
  })
})

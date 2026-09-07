export interface VoiceProjectWorkspace {
  project_id?: string | null
}

function normalizeVoiceProjectId(projectId?: string | null): string | null {
  return projectId || null
}

/**
 * A mounted voice cockpit must replace an existing workspace when the global
 * project selection moves to a different project. With no workspace yet,
 * startSession already owns initial project restoration and creation.
 */
export function shouldReplaceVoiceWorkspaceForProject(
  workspace: VoiceProjectWorkspace | null | undefined,
  managerProjectId: string | null,
): boolean {
  if (!workspace) return false
  return normalizeVoiceProjectId(workspace.project_id) !== normalizeVoiceProjectId(managerProjectId)
}

/** Detect a project change while an asynchronous session start is in flight. */
export function voiceProjectSelectionChanged(
  requestedProjectId: string | null,
  managerProjectId: string | null,
): boolean {
  return normalizeVoiceProjectId(requestedProjectId) !== normalizeVoiceProjectId(managerProjectId)
}

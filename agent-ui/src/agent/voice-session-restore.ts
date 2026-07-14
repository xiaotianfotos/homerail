export interface VoiceSessionProjectRestoreDecision {
  accepted: boolean
  projectId: string | null
}

export class VoiceSessionTransitionGuard {
  private generation = 0

  begin(): number {
    this.generation += 1
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}

export function resolveVoiceSessionProjectRestore(
  currentProjectId?: string | null,
  sessionProjectId?: string | null,
): VoiceSessionProjectRestoreDecision {
  const current = currentProjectId || null
  const session = sessionProjectId || null
  if (!current) return { accepted: true, projectId: session }
  return { accepted: current === session, projectId: current }
}

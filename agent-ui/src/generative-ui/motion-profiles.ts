import type { GenerativeUiMotionProfile } from 'homerail-protocol'

export type GenerativeUiLifecycleMotion = 'idle' | 'update' | 'complete' | 'fail'

export interface GenerativeUiMotionProfileDefinition {
  id: GenerativeUiMotionProfile
  attentionDurationMs: number
  updateDurationMs: number
  completeDurationMs: number
  failDurationMs: number
}

const STANDARD_MOTION_PROFILE: GenerativeUiMotionProfileDefinition = Object.freeze({
  id: 'standard',
  attentionDurationMs: 2400,
  updateDurationMs: 700,
  completeDurationMs: 1000,
  failDurationMs: 1000,
})

const MOTION_PROFILES: Readonly<Record<GenerativeUiMotionProfile, GenerativeUiMotionProfileDefinition>> = {
  standard: STANDARD_MOTION_PROFILE,
}

export function resolveGenerativeUiMotionProfile(
  requested?: GenerativeUiMotionProfile,
): GenerativeUiMotionProfileDefinition {
  return requested && MOTION_PROFILES[requested]
    ? MOTION_PROFILES[requested]
    : STANDARD_MOTION_PROFILE
}

import type { GenerativeUiMotionProfile } from 'homerail-protocol'

export interface GenerativeUiMotionProfileDefinition {
  id: GenerativeUiMotionProfile
  attentionDurationMs: number
}

const STANDARD_MOTION_PROFILE: GenerativeUiMotionProfileDefinition = Object.freeze({
  id: 'standard',
  attentionDurationMs: 2400,
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

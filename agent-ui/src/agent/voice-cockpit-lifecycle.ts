export interface VoiceCockpitLifecycleInput {
  voiceOnlyMode: boolean
  voiceCockpitOpen: boolean
  settingsPageOpen: boolean
  runtimeOverlayOpen: boolean
}

export interface VoiceCockpitLifecycle {
  mounted: boolean
  visible: boolean
  suspended: boolean
}

/**
 * Keep the voice cockpit mounted while a temporary full-screen surface is open.
 * The cockpit owns the browser-side Live Voice transport, so unmounting it is
 * equivalent to explicitly ending the realtime session.
 */
export function resolveVoiceCockpitLifecycle(
  input: VoiceCockpitLifecycleInput,
): VoiceCockpitLifecycle {
  const mounted = input.voiceOnlyMode || input.voiceCockpitOpen
  const suspended = mounted && (input.settingsPageOpen || input.runtimeOverlayOpen)
  return {
    mounted,
    visible: mounted && !suspended,
    suspended,
  }
}

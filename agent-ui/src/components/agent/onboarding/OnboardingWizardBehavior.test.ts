import { describe, expect, it } from 'vitest'
import wizardSource from './OnboardingWizard.vue?raw'

describe('OnboardingWizard environment checks', () => {
  it('automatically probes Docker and keeps manual interaction as retry only', () => {
    expect(wizardSource).toContain('const dockerProbePromise = status.value.dockerWorkspace?.required')
    expect(wizardSource).toContain('? checkDockerWorkspace()')
    expect(wizardSource).toContain("if (pane === 'environment') ensureDockerWorkspaceChecked()")
    expect(wizardSource).toContain("t('onboarding.environmentCheck.recheck')")
    expect(wizardSource).toContain('v-if="dockerWorkspaceReady"')
  })

  it('renders the Git Bash host-shell check only when the runtime requires it', () => {
    expect(wizardSource).toContain('v-if="hostShellRequired" class="onboarding-wizard__docker-check"')
  })
})

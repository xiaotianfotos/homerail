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

describe('OnboardingWizard Manager Agent activation', () => {
  it('uses the detected harness and keeps Anthropic-compatible settings on Claude', () => {
    expect(wizardSource).toContain('if (detectedHarness) return detectedHarness')
    expect(wizardSource).toContain("setting.protocol === 'anthropic_compatible'")
    expect(wizardSource).toContain("return 'claude_agent_sdk'")
  })

  it('lets the form await runtime activation before it reports success', () => {
    expect(wizardSource).toContain(':activate-setting="activateCreatedManagerAgentSetting"')
    expect(wizardSource).toContain('await configureManagerAgentSetting(setting, detectedHarness)')
  })
})

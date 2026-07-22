import { describe, expect, it } from 'vitest'
import wizardSource from './OnboardingWizard.vue?raw'

describe('OnboardingWizard environment checks', () => {
  it('automatically probes Docker and keeps manual interaction as retry only', () => {
    expect(wizardSource).toContain('const dockerProbePromise = status.value.dockerWorkspace')
    expect(wizardSource).toContain('? checkDockerWorkspace()')
    expect(wizardSource).toContain("if (pane === 'environment') ensureDockerWorkspaceChecked()")
    expect(wizardSource).toContain("t('onboarding.environmentCheck.recheck')")
    expect(wizardSource).toContain('v-if="dockerWorkspaceReady"')
    expect(wizardSource).toContain('const environmentNeedsAttention = computed(() => !hostShellReady.value)')
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

describe('OnboardingWizard built-in TTS completion', () => {
  it('treats the keyless Edge TTS selection as a completed TTS step', () => {
    expect(wizardSource).toContain("completion?: 'builtin_edge_tts'")
    expect(wizardSource).toContain("if (completion === 'builtin_edge_tts') builtinEdgeTtsConfigured.value = true")
    expect(wizardSource).toContain('status.value.hasTts || ttsSkipped.value || builtinEdgeTtsConfigured.value')
  })
})

import { describe, expect, it } from 'vitest'
import cockpitSource from './AgentVoiceCockpit.vue?raw'

describe('AgentVoiceCockpit responsive layout', () => {
  it('keeps the phone status message from covering canvas actions', () => {
    expect(cockpitSource).toContain("'voice-stage--status-active': Boolean(processingText)")
    expect(cockpitSource).toContain('voice-stage__status pointer-events-none')
    expect(cockpitSource).toContain(
      '.voice-cockpit--phone-portrait .voice-stage--status-active .voice-stage__content'
    )
    expect(cockpitSource).toContain('padding-top: 44px;')
  })

  it('keeps model selection independent from incomplete onboarding status', () => {
    expect(cockpitSource).toContain('data-testid="voice-model-config-button"')
    expect(cockpitSource).toContain('data-testid="voice-onboarding-status-button"')
    expect(cockpitSource).toContain("<span>{{ t('voice.model.configuration') }}</span>")
    expect(cockpitSource).toContain('@click="openRequiredOnboarding"')

    const toggleModelMenu = cockpitSource.match(
      /function toggleModelMenu\(\): void \{([\s\S]*?)\n\}/,
    )?.[1]
    expect(toggleModelMenu).toContain('modelMenuOpen.value = !modelMenuOpen.value')
    expect(toggleModelMenu).not.toContain('needsOnboardingHint')
    expect(toggleModelMenu).not.toContain('openOnboarding')
  })

  it('keeps voice output independently controllable and disabled before TTS requests', () => {
    expect(cockpitSource).toContain("const VOICE_OUTPUT_ENABLED_KEY = 'homerail.voice.output-enabled'")
    expect(cockpitSource).toContain('data-testid="voice-output-toggle"')
    expect(cockpitSource).toContain("cancelLocalSpeech('voice_output_disabled')")

    const speak = cockpitSource.slice(
      cockpitSource.indexOf('async function speak(text: string)'),
      cockpitSource.indexOf('async function speakText(text: string)'),
    )
    expect(speak).toContain('if (!voiceOutputEnabled.value)')
    expect(speak.indexOf('if (!voiceOutputEnabled.value)')).toBeLessThan(
      speak.indexOf('speechStream(clean'),
    )

    const enqueue = cockpitSource.slice(
      cockpitSource.indexOf('function enqueueSpeechEvent('),
      cockpitSource.indexOf('async function drainSpeechQueue()'),
    )
    expect(enqueue).toContain('if (!voiceOutputEnabled.value)')
    expect(enqueue).toContain('reason=output_disabled')
  })
})

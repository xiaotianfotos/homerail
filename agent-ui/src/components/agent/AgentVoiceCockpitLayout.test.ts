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

  it('aligns the desktop stage and records panel with the sidebar rail', () => {
    expect(cockpitSource).toContain(
      'class="voice-stage relative mx-6 my-0 flex min-h-0 flex-col overflow-hidden rounded-[28px] p-6"'
    )
    expect(cockpitSource).toContain(
      'class="min-w-0 overflow-hidden py-0 pr-6 transition-opacity duration-300"'
    )
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

  it('uses the appearance accent rather than danger colors for the active Agent state', () => {
    const activeButtonStyles = cockpitSource.slice(
      cockpitSource.indexOf('.voice-agent-run-button {'),
      cockpitSource.indexOf('/* Caption strip'),
    )
    expect(activeButtonStyles).toContain('border: 1px solid var(--vc-accent-border);')
    expect(activeButtonStyles).toContain('background: var(--vc-accent-soft);')
    expect(activeButtonStyles).toContain('color: var(--vc-accent);')
    expect(activeButtonStyles).not.toContain('var(--vc-danger')
  })

  it('renders Claude progress as a non-speech conversation channel', () => {
    expect(cockpitSource).toContain("if (event.type === 'progress')")
    expect(cockpitSource).toContain("item.channel !== 'progress'")
    expect(cockpitSource).toContain("item.channel === 'progress' ? 'voice-thread-item--progress' : ''")
    expect(cockpitSource).toContain('>progress</span')
  })
})

import { describe, expect, it } from 'vitest'
import cockpitSource from './AgentVoiceCockpit.vue?raw'
import sidebarSource from './VoiceSessionProjectSidebar.vue?raw'

describe('AgentVoiceCockpit responsive layout', () => {
  it('keeps the phone status message from covering canvas actions', () => {
    expect(cockpitSource).toContain(
      'Boolean(processingText) && !codexLiveVoiceConnecting'
    )
    expect(cockpitSource).toContain('v-if="processingText && !codexLiveVoiceConnecting"')
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
      'class="voice-records-slot min-w-0 overflow-hidden py-0 pr-6"'
    )
  })

  it('keeps the sidebar touch controls inside the responsive grid column', () => {
    expect(cockpitSource).toContain(
      "if (viewportWidth.value <= 1280) return effectiveSidebarOpen.value ? '250px' : '52px'"
    )
    expect(sidebarSource).toContain(
      'voice-left-rail flex h-full min-h-0 w-full'
    )
    expect(sidebarSource).not.toContain(
      'voice-left-rail flex h-full min-h-0 w-[292px]'
    )
    expect(sidebarSource).toContain('data-testid="voice-sidebar-add-directory"')
    expect(sidebarSource.match(/h-11 w-11 shrink-0 touch-manipulation/g)).toHaveLength(2)
    expect(sidebarSource.match(/voice-left-rail__header-button/g)).toHaveLength(2)
    const headerButtonRule = cockpitSource.match(
      /\.voice-cockpit--phone-landscape :deep\(\.voice-left-rail__header-button\) \{([\s\S]*?)\n\}/,
    )?.[1]
    expect(headerButtonRule).toContain('height: 116px;')
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

  it('offers the supported Codex Live Voice switch in the quick model menu', () => {
    expect(cockpitSource).toContain('data-testid="voice-model-live-toggle-row"')
    expect(cockpitSource).toContain('data-testid="voice-model-live-toggle"')
    expect(cockpitSource).toContain('role="switch"')
    expect(cockpitSource).toContain(':aria-checked="codexLiveVoiceEnabled"')
    expect(cockpitSource).toContain('@click="setCodexLiveVoiceEnabled(!codexLiveVoiceEnabled)"')
    expect(cockpitSource).toContain('v-if="codexLiveVoiceSupported"')
    expect(cockpitSource).toContain('data-testid="codex-live-voice-input-meter"')
    expect(cockpitSource).toContain('v-for="path in codexLiveVoiceWavePaths"')
    expect(cockpitSource).toContain('v-if="codexLiveVoiceConnecting"')
    expect(cockpitSource).toContain(
      "codexLiveVoiceState.value !== 'assistant-speaking'"
    )
    expect(cockpitSource).toContain(
      "'codex-live-voice-meter--active': codexLiveVoiceHumanInputActive"
    )
    expect(cockpitSource).toContain('getFloatTimeDomainData(data)')
    expect(cockpitSource).toContain('startCodexLiveVoiceMeter(stream)')
    expect(cockpitSource).toContain('createMediaStreamSource(stream)')
    expect(cockpitSource).toContain('data-testid="voice-model-live-voice-select"')
    expect(cockpitSource).toContain('@change="handleCodexLiveVoiceVoiceChange"')
    expect(cockpitSource).toContain("class=\"voice-live-button-glyph\"")
    const toggleListening = cockpitSource.slice(
      cockpitSource.indexOf('async function toggleListening(): Promise<void>'),
      cockpitSource.indexOf('async function setupVoiceHidControl()'),
    )
    const activeStopGuard =
      'if (codexLiveVoiceEffective.value && codexLiveVoiceSessionActive.value)'
    expect(toggleListening).toContain(activeStopGuard)
    expect(toggleListening).toContain('await stopCodexLiveVoice()')
    expect(toggleListening.indexOf(activeStopGuard)).toBeLessThan(
      toggleListening.indexOf('if (voiceInputActionLocked.value)')
    )
    expect(toggleListening).not.toContain('toggleMuted()')
    expect(cockpitSource).toContain(
      'v-if="!codexLiveVoiceEffective && !isTvCompactViewport && (listening || speaking)"'
    )
    expect(cockpitSource).toContain('await refreshOnboarding()')
  })

  it('gives active Live Voice exclusive ownership of audio output', () => {
    expect(cockpitSource).toContain(
      '() => codexLiveVoiceOwnsAudio(codexLiveVoiceState.value)'
    )

    const speak = cockpitSource.slice(
      cockpitSource.indexOf('async function speak(text: string)'),
      cockpitSource.indexOf('async function speakText(text: string)'),
    )
    expect(speak).toContain('if (codexLiveVoiceSessionActive.value)')
    expect(speak).toContain('reason=codex_live_voice_active')
    expect(speak.indexOf('if (codexLiveVoiceSessionActive.value)')).toBeLessThan(
      speak.indexOf('speechStream(clean'),
    )
    expect(speak).toContain('requestAbort.signal')

    const enqueue = cockpitSource.slice(
      cockpitSource.indexOf('function enqueueSpeechEvent('),
      cockpitSource.indexOf('async function drainSpeechQueue()'),
    )
    expect(enqueue).toContain('if (codexLiveVoiceSessionActive.value)')
    expect(enqueue).toContain('reason=codex_live_voice_active')

    const cancel = cockpitSource.slice(
      cockpitSource.indexOf('function cancelLocalSpeech('),
      cockpitSource.indexOf('async function unlockTtsDomPlayback()'),
    )
    expect(cancel).toContain('ttsSpeechAbort?.abort()')
    expect(cancel).toContain('speechEventQueue = []')

    const applyState = cockpitSource.slice(
      cockpitSource.indexOf('function applyCodexLiveVoiceState('),
      cockpitSource.indexOf('function handleCodexLiveVoiceEvent('),
    )
    expect(applyState).toContain('if (active && !wasActive)')
    expect(applyState).toContain("cancelLocalSpeech('codex_live_voice_audio_owner')")
    expect(applyState).toContain("broadcastVoiceActivity('listening')")
  })

  it('uses the main voice button as the only Live Voice start and stop control', () => {
    expect(cockpitSource).not.toContain('data-testid="codex-live-voice-managed"')
    expect(cockpitSource).not.toContain('data-testid="codex-live-voice-end"')
    expect(cockpitSource).toContain(':aria-label="voiceInputButtonLabel"')
    expect(cockpitSource).toContain('@click="toggleListening"')
    expect(cockpitSource.match(/:disabled="voiceInputActionLocked"/g)).toHaveLength(2)
    expect(cockpitSource.match(
      /v-if="codexLiveVoiceEffective && codexLiveVoiceSessionActive"/g
    )).toHaveLength(2)
    expect(cockpitSource).toContain(
      "if (codexLiveVoiceSessionActive.value) return t('voice.liveVoice.end')"
    )
    expect(cockpitSource).toContain(
      'if (codexLiveVoiceClient === client) startCodexLiveVoiceMeter(stream)'
    )
    expect(cockpitSource).toContain('if (codexLiveVoiceClient !== client) return')
  })

  it('suspends hidden cockpit interactions without ending Live Voice', () => {
    expect(cockpitSource).toContain('suspended?: boolean')
    expect(cockpitSource).toContain(':inert="interactionSuspended"')
    expect(cockpitSource).toContain('if (interactionSuspended.value) return')

    const openSettings = cockpitSource.slice(
      cockpitSource.indexOf('function openSettings(): void'),
      cockpitSource.indexOf('function openRuntimeOverlay(): void'),
    )
    expect(openSettings).toContain('store.settingsPageOpen = true')
    expect(openSettings).not.toContain('store.voiceCockpitOpen = false')
  })

  it('only stops Live Voice for explicit actions or session and project changes', () => {
    const projectWatcherStart = cockpitSource.indexOf('() => store.managerProjectId')
    const projectWatcher = cockpitSource.slice(
      projectWatcherStart,
      cockpitSource.indexOf('watch(', projectWatcherStart + 1),
    )
    expect(projectWatcher).toContain('void reconcileVoiceProjectSelection()')

    const reconcileProject = cockpitSource.slice(
      cockpitSource.indexOf('async function reconcileVoiceProjectSelection('),
      cockpitSource.indexOf('async function handleVoiceSessionSelected('),
    )
    expect(reconcileProject).toContain(
      'shouldReplaceVoiceWorkspaceForProject(workspace.value, store.managerProjectId)',
    )
    expect(reconcileProject).toContain("cancelLocalSpeech('project_switch')")
    expect(reconcileProject).toContain('await stopCodexLiveVoice()')
    expect(reconcileProject).toContain('voiceTurnAbort?.abort()')
    expect(reconcileProject).toContain('workspace.value = null')
    expect(reconcileProject).toContain('await startSession()')
    expect(cockpitSource).not.toContain('@project-selected="handleVoiceProjectSelected"')

    const startSession = cockpitSource.slice(
      cockpitSource.indexOf('async function startSession('),
      cockpitSource.indexOf('async function createFreshVoiceSession('),
    )
    expect(startSession).toContain('const requestedProjectId = store.managerProjectId || null')
    expect(startSession).toContain(
      'voiceProjectSelectionChanged(requestedProjectId, store.managerProjectId)',
    )
    expect(cockpitSource).not.toContain('watch(codexLiveVoiceEffective')

    const stopLegacyCapture = cockpitSource.slice(
      cockpitSource.indexOf('function stopVoiceCapture(): void'),
      cockpitSource.indexOf('function closeVoiceInputAfterSubmit(): void'),
    )
    expect(stopLegacyCapture).not.toContain('stopCodexLiveVoice')

    const disableLiveVoice = cockpitSource.slice(
      cockpitSource.indexOf('async function setCodexLiveVoiceEnabled('),
      cockpitSource.indexOf('async function setCodexLiveVoiceVoice('),
    )
    expect(disableLiveVoice).toContain(
      'if (!enabled && codexLiveVoiceClient) await stopCodexLiveVoice()',
    )
  })

  it('uses a dense glass model popover with an opaque fallback', () => {
    expect(cockpitSource).toContain('background: var(--hr-bg-raised);')
    expect(cockpitSource).toContain(
      'color-mix(in srgb, var(--hr-accent) 3%, transparent)'
    )
    expect(cockpitSource).toContain('backdrop-filter: blur(36px) saturate(145%);')
    expect(cockpitSource).toContain(
      '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))'
    )
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

  it('keeps the gamepad monitor behind a console-only debug command', () => {
    expect(cockpitSource).not.toContain('data-testid="voice-gamepad-toggle"')
    expect(cockpitSource).not.toContain('toggleVoiceGamepadLiveView')
    expect(cockpitSource).toContain('installGamepadMonitorDebugApi(')
    expect(cockpitSource).toContain('setVoiceGamepadMonitorVisible')
    expect(cockpitSource).toContain('uninstallGamepadMonitorDebugApi?.()')
  })

  it('automatically presents a waveform-only canvas for Codex Live Voice', () => {
    expect(cockpitSource).toContain('const immersiveMode = ref(false)')
    expect(cockpitSource).toContain('const immersiveSuspended = ref(false)')
    expect(cockpitSource).toContain('codexLiveVoiceSessionActive.value &&')
    expect(cockpitSource).toContain('!codexLiveVoiceConnecting.value')
    expect(cockpitSource).toContain('uiStore.liveVoiceImmersiveEnabled')
    expect(cockpitSource).toContain('activateLiveVoiceImmersiveMode()')
    expect(cockpitSource).not.toContain('data-testid="voice-immersive-enter"')
    expect(cockpitSource).toContain('data-testid="voice-immersive-exit-zone"')
    expect(cockpitSource).toContain("'voice-immersive-exit-zone--visible': immersiveExitVisible")
    expect(cockpitSource).toContain(
      "window.addEventListener('pointermove', handleImmersivePointerMove"
    )
    expect(cockpitSource).toContain("'voice-cockpit--immersive': immersiveMode.value")
    expect(cockpitSource).toContain("? '0 minmax(0, 1fr) 0'")
    expect(cockpitSource).toContain("voiceGamepadFocusMode.value = 'widgets'")
    expect(cockpitSource).toContain('if (immersiveMode.value) {')
    expect(cockpitSource).toContain('exitImmersiveMode()')
    expect(cockpitSource).toContain('@click="suspendLiveVoiceImmersiveMode"')
    expect(cockpitSource).toContain("'voice-topbar--immersive-hidden': immersiveMode")
    expect(cockpitSource).toContain("'voice-sidebar-slot--immersive-hidden': immersiveMode")
    expect(cockpitSource).toContain("immersiveMode ? 'voice-records-slot--immersive-hidden' : ''")
    expect(cockpitSource).toContain("'voice-composer--immersive-hidden': immersiveMode")
    expect(cockpitSource).toContain(
      '.voice-cockpit--immersive .codex-live-voice-meter--active'
    )
  })

  it('reveals the immersive exit control from direct touch and pen input', () => {
    expect(cockpitSource).toContain(
      'function handleImmersiveTouchPointerDown(event: PointerEvent): void'
    )
    expect(cockpitSource).toContain(
      "event.pointerType !== 'touch' && event.pointerType !== 'pen'"
    )
    expect(cockpitSource).toContain(
      "window.addEventListener('pointerdown', handleImmersiveTouchPointerDown"
    )
    expect(cockpitSource).toContain(
      "window.removeEventListener('pointerdown', handleImmersiveTouchPointerDown)"
    )
    expect(cockpitSource).toContain('handleImmersivePointerMove()')
  })

  it('temporarily reveals Live Voice controls and returns after interaction becomes idle', () => {
    expect(cockpitSource).toContain('const IMMERSIVE_RETURN_IDLE_MS = 3200')
    expect(cockpitSource).toContain('function suspendLiveVoiceImmersiveMode(): void')
    expect(cockpitSource).toContain('function scheduleImmersiveReturn(): void')
    expect(cockpitSource).toContain('function noteLiveVoiceImmersiveInteraction(): void')
    expect(cockpitSource).toContain(
      'immersiveSuspended.value && liveVoiceImmersiveActive.value'
    )
    expect(cockpitSource).toContain('}, IMMERSIVE_RETURN_IDLE_MS)')
    expect(cockpitSource).toContain('noteLiveVoiceImmersiveInteraction()')
    expect(cockpitSource).toContain('max-height 380ms cubic-bezier(0.22, 1, 0.36, 1)')
    expect(cockpitSource).toContain(
      '--voice-immersive-waveform-gutter: clamp(12px, 1.4vh, 16px)'
    )
    expect(cockpitSource).toContain(
      'padding-bottom: var(--voice-immersive-waveform-gutter)'
    )
    expect(cockpitSource).toContain(
      'margin-top: var(--voice-immersive-waveform-gutter)'
    )
    expect(cockpitSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(cockpitSource).not.toContain('v-if="!immersiveMode && !isPhonePortrait"')
  })
})

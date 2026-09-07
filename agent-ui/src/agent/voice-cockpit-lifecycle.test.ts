import { describe, expect, it } from 'vitest'
import appSource from '@/App.vue?raw'
import agentViewSource from '@/views/agent/index.vue?raw'
import { resolveVoiceCockpitLifecycle } from './voice-cockpit-lifecycle'

describe('resolveVoiceCockpitLifecycle', () => {
  it.each([
    ['settings', true, false],
    ['DAG runtime', false, true],
  ])('keeps Live Voice mounted and suspended behind %s', (_name, settingsPageOpen, runtimeOverlayOpen) => {
    expect(resolveVoiceCockpitLifecycle({
      voiceOnlyMode: false,
      voiceCockpitOpen: true,
      settingsPageOpen,
      runtimeOverlayOpen,
    })).toEqual({
      mounted: true,
      visible: false,
      suspended: true,
    })
  })

  it('restores the same mounted cockpit after the temporary surface closes', () => {
    expect(resolveVoiceCockpitLifecycle({
      voiceOnlyMode: false,
      voiceCockpitOpen: true,
      settingsPageOpen: false,
      runtimeOverlayOpen: false,
    })).toEqual({
      mounted: true,
      visible: true,
      suspended: false,
    })
  })

  it('still unmounts the cockpit when voice mode is explicitly closed', () => {
    expect(resolveVoiceCockpitLifecycle({
      voiceOnlyMode: false,
      voiceCockpitOpen: false,
      settingsPageOpen: false,
      runtimeOverlayOpen: false,
    })).toEqual({
      mounted: false,
      visible: false,
      suspended: false,
    })
  })

  it('keeps the cockpit mounted in voice-only mode', () => {
    expect(resolveVoiceCockpitLifecycle({
      voiceOnlyMode: true,
      voiceCockpitOpen: false,
      settingsPageOpen: true,
      runtimeOverlayOpen: false,
    })).toEqual({
      mounted: true,
      visible: false,
      suspended: true,
    })
  })

  it('wires temporary surfaces to visibility and suspension rather than unmounting', () => {
    expect(agentViewSource).toContain('v-if="voiceCockpitLifecycle.mounted"')
    expect(agentViewSource).toContain('v-show="voiceCockpitLifecycle.visible"')
    expect(agentViewSource).toContain(':suspended="voiceCockpitLifecycle.suspended"')
    expect(agentViewSource).not.toContain(
      'v-if="!store.settingsPageOpen && !store.runtimeOverlayOpen',
    )
  })

  it('keeps the Agent root alive across ordinary route navigation', () => {
    expect(appSource).toContain('<KeepAlive include="AgentRootView">')
    expect(agentViewSource).toContain("defineOptions({ name: 'AgentRootView' })")
  })

  it('deactivates browser UI tools while the cached Agent root is hidden', () => {
    expect(agentViewSource).toContain('onActivated(startBrowserTools)')
    expect(agentViewSource).toContain('onDeactivated(stopBrowserTools)')
    expect(agentViewSource).toContain('onUnmounted(stopBrowserTools)')
    expect(agentViewSource).toContain('browserToolsLifecycle?.dispose()')
  })
})

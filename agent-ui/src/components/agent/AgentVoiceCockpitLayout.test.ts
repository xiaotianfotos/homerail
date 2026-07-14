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
})

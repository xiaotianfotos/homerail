import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({
  getBaseURL: vi.fn(),
}))

vi.mock('@/api/clients/http-client', () => ({ http }))

import { codexLiveVoiceWebSocketUrl } from './voice-agent-api'

describe('codexLiveVoiceWebSocketUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses a secure WebSocket, trims trailing slashes, and encodes the session id', () => {
    http.getBaseURL.mockReturnValue('https://manager.example.test///')

    expect(codexLiveVoiceWebSocketUrl('voice / 中文')).toBe(
      'wss://manager.example.test/api/voice-agent/sessions/voice%20%2F%20%E4%B8%AD%E6%96%87/live',
    )
  })

  it('uses ws for an HTTP manager', () => {
    http.getBaseURL.mockReturnValue('http://127.0.0.1:19191/')

    expect(codexLiveVoiceWebSocketUrl('voice-1')).toBe(
      'ws://127.0.0.1:19191/api/voice-agent/sessions/voice-1/live',
    )
  })

  it('falls back to the current browser origin when no API base is configured', () => {
    http.getBaseURL.mockReturnValue('')

    expect(codexLiveVoiceWebSocketUrl('voice-1')).toBe(
      'ws://localhost:3000/api/voice-agent/sessions/voice-1/live',
    )
  })
})

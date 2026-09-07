import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  getBaseURL: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/api/clients/http-client', () => ({ http }))

import { setDesktopBrowserToolsTransportAvailable } from '@/browser-tools/browser-renderer-bridge'
import {
  closeVoiceSession,
  codexLiveVoiceWebSocketUrl,
  confirmVoiceTask,
  getVoiceSession,
  notifyVoiceSession,
  refreshVoiceManagerStatus,
  sendVoiceTurn,
  stopVoiceMonitor,
  streamConfirmVoiceTask,
  streamVoiceTurn,
} from './voice-agent-api'

describe('codexLiveVoiceWebSocketUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setDesktopBrowserToolsTransportAvailable(false)
  })

  afterEach(() => {
    setDesktopBrowserToolsTransportAvailable(false)
    vi.unstubAllGlobals()
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

  it('encodes reserved characters in every non-streaming voice-session path', async () => {
    const sessionId = 'voice / 中文'
    const base = '/api/voice-agent/sessions/voice%20%2F%20%E4%B8%AD%E6%96%87'
    http.get.mockResolvedValue({ success: true, data: {} })
    http.post.mockResolvedValue({ success: true, data: {} })
    http.delete.mockResolvedValue({ success: true, data: {} })

    await getVoiceSession(sessionId)
    await refreshVoiceManagerStatus(sessionId)
    await closeVoiceSession(sessionId)
    await stopVoiceMonitor(sessionId)
    await notifyVoiceSession(sessionId, 'title', 'body')

    expect(http.get).toHaveBeenCalledWith(base)
    expect(http.delete).toHaveBeenCalledWith(base)
    expect(http.post).toHaveBeenCalledWith(`${base}/manager-status`, {})
    expect(http.post).toHaveBeenCalledWith(`${base}/monitor/stop`, {})
    expect(http.post).toHaveBeenCalledWith(`${base}/notifications`, {
      title: 'title',
      body: 'body',
      priority: 'normal',
      spoken_text: undefined,
    })
  })

  it('falls back to the current browser origin when no API base is configured', () => {
    http.getBaseURL.mockReturnValue('')

    expect(codexLiveVoiceWebSocketUrl('voice-1')).toBe(
      'ws://localhost:3000/api/voice-agent/sessions/voice-1/live',
    )
  })

  it('stamps both regular and streaming voice turns with an explicit transport', async () => {
    setDesktopBrowserToolsTransportAvailable(true)
    http.post.mockResolvedValue({ success: true, data: {} })
    await sendVoiceTurn('voice / 中文', 'hello', 'project-1', 'node-1')
    expect(http.post).toHaveBeenCalledWith(
      '/api/voice-agent/sessions/voice%20%2F%20%E4%B8%AD%E6%96%87/turn',
      {
        text: 'hello',
        project_id: 'project-1',
        selected_node_id: 'node-1',
        browser_tools_transport: 'desktop',
      },
      { timeout: 0 },
    )

    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await streamVoiceTurn('voice-1', 'stream this', 'project-1', async () => undefined)
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({
      text: 'stream this',
      project_id: 'project-1',
      selected_node_id: null,
      browser_tools_transport: 'desktop',
    })
  })

  it('stamps both regular and streaming confirmations with the current browser-tools binding', async () => {
    setDesktopBrowserToolsTransportAvailable(true)
    http.post.mockResolvedValue({ success: true, data: {} })

    await confirmVoiceTask('voice / 中文', 'confirmation-1')
    expect(http.post).toHaveBeenCalledWith(
      '/api/voice-agent/sessions/voice%20%2F%20%E4%B8%AD%E6%96%87/confirm',
      {
        confirmation_id: 'confirmation-1',
        browser_tools_transport: 'desktop',
      },
      { timeout: 0 },
    )

    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await streamConfirmVoiceTask(
      'voice-1',
      'confirmation-1',
      null,
      null,
      async () => undefined,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/voice-agent/sessions/voice-1/confirm/stream')
    expect(JSON.parse(String(request.body))).toEqual({
      confirmation_id: 'confirmation-1',
      browser_tools_transport: 'desktop',
    })
  })
})

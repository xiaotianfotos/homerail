import { afterEach, describe, expect, it, vi } from 'vitest'

import { http } from '../clients/http-client'
import { setDesktopBrowserToolsTransportAvailable } from '@/browser-tools/browser-renderer-bridge'
import {
  agentRuntimeApi,
  getManagerAgentConfig,
  getRunAuditSummary,
  invokeManagerAgent,
  managerChat,
  updateManagerAgentConfig
} from './agent-runtime-api'

afterEach(() => {
  setDesktopBrowserToolsTransportAvailable(false)
  vi.restoreAllMocks()
})

describe('agent runtime API', () => {
  it('routes raw runtime operations and preserves abort signals', async () => {
    const get = vi.spyOn(http, 'get').mockResolvedValue({ success: true, data: {} })
    const post = vi.spyOn(http, 'post').mockResolvedValue({ success: true, data: {} })
    const put = vi.spyOn(http, 'put').mockResolvedValue({ success: true, data: {} })
    const controller = new AbortController()

    await managerChat({ message: 'hello' }, controller.signal)
    await managerChat({ message: 'without signal' })
    await getManagerAgentConfig()
    await updateManagerAgentConfig({ model_name: 'test-model' })
    await invokeManagerAgent('run/a b', { prompt: 'review' })
    await getRunAuditSummary('run/a b')

    expect(post).toHaveBeenNthCalledWith(
      1,
      '/api/manager/chat',
      { message: 'hello', browser_tools_transport: 'none' },
      { signal: controller.signal }
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/api/manager/chat',
      { message: 'without signal', browser_tools_transport: 'none' },
      undefined
    )
    expect(get).toHaveBeenNthCalledWith(1, '/api/manager-agent/config')
    expect(put).toHaveBeenCalledWith('/api/manager-agent/config', { model_name: 'test-model' })
    expect(post).toHaveBeenNthCalledWith(3, '/api/runs/run%2Fa%20b/invoke', { prompt: 'review' })
    expect(get).toHaveBeenNthCalledWith(2, '/api/runs/run%2Fa%20b/audit/summary')
  })

  it('normalizes Manager chat request and response fields', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({
      success: true,
      data: { text: 'done', session_id: 'session-1' }
    })
    const controller = new AbortController()

    await expect(
      agentRuntimeApi.agentChat(
        {
          project_id: 'project-1',
          message: 'review this',
          session_id: 'session-1',
          context: { harness: 'codex_appserver' }
        },
        controller.signal
      )
    ).resolves.toEqual({
      reply: 'done',
      session_id: 'session-1',
      status: 'ok'
    })
    expect(post).toHaveBeenCalledWith(
      '/api/manager/chat',
      {
        message: 'review this',
        project_id: 'project-1',
        session_id: 'session-1',
        manager_agent_config: { harness: 'codex_appserver' },
        browser_tools_transport: 'none'
      },
      { signal: controller.signal }
    )
  })

  it('overwrites caller-supplied routing with the current trusted transport', async () => {
    const post = vi.spyOn(http, 'post').mockResolvedValue({ success: true, data: {} })
    setDesktopBrowserToolsTransportAvailable(true)

    await managerChat({
      message: 'route safely',
      browser_tools_transport: 'renderer',
      browser_tools_target: { connection_id: 'spoofed' },
    })

    expect(post).toHaveBeenCalledWith('/api/manager/chat', {
      message: 'route safely',
      browser_tools_transport: 'desktop',
    }, undefined)
  })

  it('marks unsuccessful Manager chat responses as errors', async () => {
    vi.spyOn(http, 'post').mockResolvedValue({
      success: false,
      data: { text: 'failed', session_id: 'session-2' }
    })

    await expect(
      agentRuntimeApi.agentChat({
        project_id: 'project-1',
        message: 'fail'
      })
    ).resolves.toEqual({
      reply: 'failed',
      session_id: 'session-2',
      status: 'error'
    })
  })

  it('normalizes invoked Agent responses and defaults unknown status', async () => {
    const post = vi
      .spyOn(http, 'post')
      .mockResolvedValueOnce({
        success: true,
        data: { prompt: 'implemented', instance_id: 'agent-1', status: 'completed' }
      })
      .mockResolvedValueOnce({
        success: true,
        data: { prompt: 'queued', instance_id: 'agent-2' }
      })

    await expect(agentRuntimeApi.invokeAgent('run-1', { prompt: 'implement' })).resolves.toEqual({
      reply: 'implemented',
      session_id: 'agent-1',
      status: 'completed'
    })
    await expect(agentRuntimeApi.invokeAgent('run-2', { prompt: 'queue' })).resolves.toEqual({
      reply: 'queued',
      session_id: 'agent-2',
      status: 'unknown'
    })
  })

  it('normalizes string and object audit summaries', async () => {
    const get = vi
      .spyOn(http, 'get')
      .mockResolvedValueOnce({ success: true, data: 'plain summary' })
      .mockResolvedValueOnce({ success: true, data: { summary: 'detailed', findings: 2 } })

    await expect(agentRuntimeApi.getAuditSummary('run-1')).resolves.toEqual({
      run_id: 'run-1',
      summary: 'plain summary',
      details: {}
    })
    await expect(agentRuntimeApi.getAuditSummary('run-2')).resolves.toEqual({
      run_id: 'run-2',
      summary: 'detailed',
      details: { summary: 'detailed', findings: 2 }
    })
  })
})

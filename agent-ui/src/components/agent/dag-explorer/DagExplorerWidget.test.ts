import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import type { DAGExecution, DAGNodeResult, DAGRunMetrics } from '@/api/types/dag.types'
import type { VoiceWidget } from '@/api/services/voice-agent-api'

// Node 25 的全局 localStorage（无方法 stub）会让 @/i18n/locales 的
// resolveInitialLocale 崩溃；CI（Node 20/24）无此问题。这里固定 locale
// 解析结果，绕开环境差异，不影响真实 messages。
vi.mock('@/i18n/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/locales')>()
  return {
    ...actual,
    resolveInitialLocale: () => 'en-US',
    applyLocaleToDocument: () => {},
  }
})

import { i18n } from '@/plugins/i18n'
import { eventBus } from '@/utils/eventBus'
import DagExplorerWidget from './DagExplorerWidget.vue'

const api = vi.hoisted(() => ({
  getDagStatus: vi.fn(),
  getDagRunMetrics: vi.fn(),
  getDagNodeResult: vi.fn(),
}))

vi.mock('@/api/services/dag-api', () => ({
  dagApi: {
    getDagStatus: api.getDagStatus,
    getDagRunMetrics: api.getDagRunMetrics,
    getDagNodeResult: api.getDagNodeResult,
  },
}))

const storeState = vi.hoisted(() => ({
  runtimeOverlayOpen: false,
}))

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => storeState,
}))

function makeExecution(): DAGExecution {
  return {
    dag_run_id: 'run-1',
    status: 'running',
    nodes: [
      {
        id: 'collect', name: 'collect', node_type: 'join_gateway', status: 'pending',
        agent_id: 'a', agent_name: 'collect', dependencies: ['normalize'],
        retry_count: 0, pool_count: 0, iteration: 0,
      },
      {
        id: 'prepare', name: 'prepare', node_type: 'command_gateway', status: 'completed',
        agent_id: 'a', agent_name: 'prepare', dependencies: [],
        retry_count: 0, pool_count: 0, iteration: 0,
      },
      {
        id: 'review', name: 'review', node_type: 'agent', status: 'failed',
        agent_id: 'a', agent_name: 'review', dependencies: ['prepare'],
        retry_count: 0, pool_count: 0, iteration: 0,
      },
      {
        id: 'normalize', name: 'normalize', node_type: 'command_gateway', status: 'completed',
        agent_id: 'a', agent_name: 'normalize', dependencies: ['review'],
        retry_count: 0, pool_count: 0, iteration: 0,
      },
    ],
    edges: [
      { id: 'e1', source: 'prepare', target: 'review', condition: 'always' },
      { id: 'e2', source: 'review', target: 'normalize', condition: 'always' },
      { id: 'e3', source: 'normalize', target: 'collect', condition: 'always' },
    ],
  }
}

function makeMetrics(): DAGRunMetrics {
  return {
    run_id: 'run-1',
    status: 'running',
    nodes: {
      review: {
        node_id: 'review',
        node_name: 'review',
        agent_name: 'review',
        status: 'failed',
        tool_calls: 40,
        tool_failures: 2,
        tokens: { input: 1200, output: 340, cache_read: 5600000, cache_creation: 0, total: 5601540 },
        execution: { model_display_name: 'GLM-4.6', provider_display_name: 'Zhipu' },
        usage_scope: 'node_cumulative',
        usage_available: true,
        duration_ms: 62000,
        num_turns: 3,
        started_at: null,
        completed_at: null,
      },
    },
    totals: {
      tool_calls: 40,
      tool_failures: 2,
      tokens: { input: 1200, output: 340, cache_read: 5600000, cache_creation: 0, total: 5601540 },
      usage_available: true,
      cost_usd: null,
    },
  }
}

function makeNodeResult(nodeId: string, kind: string): DAGNodeResult {
  return {
    node_id: nodeId,
    node_name: nodeId,
    node_type: `${kind}_gateway`,
    result_kind: kind,
    status: 'completed',
    latest: { port: 'passed', content: { verdict: 'pass' }, timestamp: '2026-01-01T00:00:00Z' },
    handoffs: [{ port: 'passed', content: { verdict: 'pass' }, timestamp: '2026-01-01T00:00:00Z' }],
  }
}

function makeWidget(data: Record<string, unknown> = { run_id: 'run-1' }): VoiceWidget {
  return {
    id: 'widget-dag-explorer',
    type: 'dag_explorer',
    title: 'DAG Explorer',
    body: '',
    priority: 'normal',
    items: [],
    steps: [],
    data,
  }
}

describe('DagExplorerWidget', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    api.getDagStatus.mockReset()
    api.getDagRunMetrics.mockReset()
    api.getDagNodeResult.mockReset()
    api.getDagStatus.mockResolvedValue(makeExecution())
    api.getDagRunMetrics.mockResolvedValue(makeMetrics())
    api.getDagNodeResult.mockImplementation((runId: string, nodeId: string) =>
      Promise.resolve(makeNodeResult(nodeId, nodeId === 'collect' ? 'join' : 'command')))
    storeState.runtimeOverlayOpen = false
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  async function mount(widget: VoiceWidget): Promise<HTMLElement> {
    const Harness = defineComponent({
      setup() {
        return () => h(DagExplorerWidget, { widget })
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)
    await vi.waitFor(() => {
      expect(root!.querySelector('[data-testid="dag-explorer-node-prepare"]')).not.toBeNull()
    })
    await nextTick()
    return root
  }

  it('lists nodes in topological order and defaults selection to the failed node', async () => {
    const el = await mount(makeWidget())
    const ids = Array.from(el.querySelectorAll('[data-testid^="dag-explorer-node-"]'))
      .map(node => node.getAttribute('data-testid'))
    expect(ids).toEqual([
      'dag-explorer-node-prepare',
      'dag-explorer-node-review',
      'dag-explorer-node-normalize',
      'dag-explorer-node-collect',
    ])
    expect(el.querySelector('[data-testid="dag-explorer-node-review"]')?.className)
      .toContain('dag-explorer__node--active')
    // worker 节点：只显示关键指标，不显示聊天日志
    const worker = el.querySelector('[data-testid="dag-explorer-worker"]')
    expect(worker).not.toBeNull()
    expect(worker!.textContent).toContain('40')
    expect(el.querySelector('[data-testid="dag-explorer-total-tokens"]')?.textContent).toContain('5.6M')
    expect(worker!.textContent).toContain('GLM-4.6')
    expect(el.textContent).not.toContain('Chat logs')
  })

  it('shows the structured result for a non-worker node after clicking it', async () => {
    const el = await mount(makeWidget())
    el.querySelector<HTMLElement>('[data-testid="dag-explorer-node-collect"]')!.click()
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="dag-explorer-result"]')).not.toBeNull()
    })
    await nextTick()
    expect(api.getDagNodeResult).toHaveBeenCalledWith('run-1', 'collect')
    expect(el.querySelector('[data-testid="dag-explorer-worker"]')).toBeNull()
  })

  it('preselects focus_node_id from widget data', async () => {
    const el = await mount(makeWidget({ run_id: 'run-1', focus_node_id: 'collect' }))
    expect(el.querySelector('[data-testid="dag-explorer-node-collect"]')?.className)
      .toContain('dag-explorer__node--active')
    await vi.waitFor(() => {
      expect(api.getDagNodeResult).toHaveBeenCalledWith('run-1', 'collect')
    })
  })

  it('keeps the manual selection across event-driven refreshes when focus_node_id is set', async () => {
    const el = await mount(makeWidget({ run_id: 'run-1', focus_node_id: 'collect' }))
    expect(el.querySelector('[data-testid="dag-explorer-node-collect"]')?.className)
      .toContain('dag-explorer__node--active')

    el.querySelector<HTMLElement>('[data-testid="dag-explorer-node-prepare"]')!.click()
    await nextTick()
    expect(el.querySelector('[data-testid="dag-explorer-node-prepare"]')?.className)
      .toContain('dag-explorer__node--active')

    // 同一 run 的事件触发一次节流快照刷新；手动选择必须存活
    api.getDagStatus.mockClear()
    eventBus.emit('dag:node_state_changed', { runId: 'run-1', nodeId: 'review', status: 'failed' })
    await vi.waitFor(() => expect(api.getDagStatus).toHaveBeenCalled(), { timeout: 3000 })
    await vi.waitFor(() => {
      expect(el.querySelector('[data-testid="dag-explorer-node-prepare"]')?.className)
        .toContain('dag-explorer__node--active')
    })
    expect(el.querySelector('[data-testid="dag-explorer-node-collect"]')?.className)
      .not.toContain('dag-explorer__node--active')
  })

  it('re-focuses when focus_node_id itself changes', async () => {
    const widgetRef = ref(makeWidget({ run_id: 'run-1', focus_node_id: 'collect' }))
    const Harness = defineComponent({
      setup() {
        return () => h(DagExplorerWidget, { widget: widgetRef.value })
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)
    await vi.waitFor(() => {
      expect(root!.querySelector('[data-testid="dag-explorer-node-collect"]')?.className)
        .toContain('dag-explorer__node--active')
    })

    // 用户浏览到其他节点后，manager agent 更新 widget 聚焦另一个出错节点
    root.querySelector<HTMLElement>('[data-testid="dag-explorer-node-prepare"]')!.click()
    await nextTick()
    widgetRef.value = makeWidget({ run_id: 'run-1', focus_node_id: 'normalize' })
    await nextTick()
    expect(root.querySelector('[data-testid="dag-explorer-node-normalize"]')?.className)
      .toContain('dag-explorer__node--active')
  })

  it('shows an empty hint when run_id is missing', async () => {
    const Harness = defineComponent({
      setup() {
        return () => h(DagExplorerWidget, { widget: makeWidget({}) })
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toContain('No run_id provided')
    expect(api.getDagStatus).not.toHaveBeenCalled()
  })

  it('surfaces the fetch error instead of a bare not-found message', async () => {
    api.getDagStatus.mockRejectedValue(new Error('manager unreachable'))
    const Harness = defineComponent({
      setup() {
        return () => h(DagExplorerWidget, { widget: makeWidget() })
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)
    await vi.waitFor(() => {
      expect(root!.querySelector('[data-testid="dag-explorer-error"]')?.textContent)
        .toContain('manager unreachable')
    })
  })

  it('opens the runtime overlay from the expand button', async () => {
    const el = await mount(makeWidget())
    el.querySelector<HTMLElement>('[data-testid="dag-explorer-expand"]')!.click()
    expect(storeState.runtimeOverlayOpen).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import type { DAGRunMetrics } from '@/api/types/dag.types'

// Node 25 的全局 localStorage stub 会让 @/i18n/locales 初始化崩溃（CI 无此问题），
// 固定 locale 解析结果以保证测试与环境无关。
vi.mock('@/i18n/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/locales')>()
  return {
    ...actual,
    resolveInitialLocale: () => 'en-US',
    applyLocaleToDocument: () => {},
  }
})

import { i18n } from '@/plugins/i18n'
import DagNodeDetailDrawer from './DagNodeDetailDrawer.vue'

const close = vi.fn()

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => ({
    currentRunId: 'run-1',
    selectedNodeIsManager: false,
    nodes: [{
      id: 'prepare_repository',
      name: 'prepare_repository',
      agent_name: 'prepare_repository',
      node_type: 'agent',
      status: 'completed',
    }, {
      id: 'verification_quorum',
      name: 'verification_quorum',
      agent_name: 'verification_quorum',
      node_type: 'join_gateway',
      gateway_config: { mode: 'n_of_m', threshold: 2 },
      status: 'completed',
    }],
  }),
}))

vi.mock('@/composables/useDagNodeMessages', async () => {
  const { ref } = await import('vue')
  return {
    useDagNodeMessages: () => ({ messages: ref([]), loading: ref(false) }),
  }
})

vi.mock('@/api/clients/http-client', () => ({
  http: { get: vi.fn().mockResolvedValue({ data: { messages: [] } }) },
}))

describe('DagNodeDetailDrawer', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    close.mockReset()
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  it('expands task details without closing the drawer', async () => {
    const Harness = defineComponent({
      setup() {
        const panelFocus = ref<'task' | 'logs'>('logs')
        const expandedPanels = ref(new Set<'task' | 'logs'>(['logs']))

        function togglePanel(panel: 'task' | 'logs'): void {
          panelFocus.value = panel
          const next = new Set(expandedPanels.value)
          if (next.has(panel)) next.delete(panel)
          else next.add(panel)
          expandedPanels.value = next
        }

        return () => h(DagNodeDetailDrawer, {
          metrics: null,
          selectedNodeId: 'prepare_repository',
          open: true,
          panelFocus: panelFocus.value,
          expandedPanels: expandedPanels.value,
          onClose: close,
          onTogglePanel: togglePanel,
        })
      },
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)

    const taskButton = Array.from(root.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Task details'))
    expect(taskButton).toBeDefined()
    expect(root.querySelector('.dag-task-detail')).toBeNull()

    taskButton!.click()
    await nextTick()

    expect(close).not.toHaveBeenCalled()
    expect(root.querySelector('.dag-detail-drawer')).not.toBeNull()
    expect(root.querySelector('.dag-detail-drawer')?.className).toContain('top-[88px]')
    expect(root.querySelector('.dag-task-detail')).not.toBeNull()
    expect(taskButton!.textContent).toContain('Collapse')

    taskButton!.click()
    await nextTick()

    expect(close).not.toHaveBeenCalled()
    expect(root.querySelector('.dag-detail-drawer')).not.toBeNull()
    expect(root.querySelector('.dag-task-detail')).toBeNull()
    expect(taskButton!.textContent).not.toContain('Collapse')
  })

  it('toggles chat logs without closing the drawer', async () => {
    const Harness = defineComponent({
      setup() {
        const panelFocus = ref<'task' | 'logs'>('logs')
        const expandedPanels = ref(new Set<'task' | 'logs'>(['logs']))

        function togglePanel(panel: 'task' | 'logs'): void {
          panelFocus.value = panel
          const next = new Set(expandedPanels.value)
          if (next.has(panel)) next.delete(panel)
          else next.add(panel)
          expandedPanels.value = next
        }

        return () => h(DagNodeDetailDrawer, {
          metrics: null,
          selectedNodeId: 'prepare_repository',
          open: true,
          panelFocus: panelFocus.value,
          expandedPanels: expandedPanels.value,
          onClose: close,
          onTogglePanel: togglePanel,
        })
      },
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)

    const logsButton = Array.from(root.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Chat logs'))
    expect(logsButton).toBeDefined()
    expect(root.querySelector('.dag-chat-log')).not.toBeNull()
    expect(logsButton!.textContent).toContain('Collapse')

    logsButton!.click()
    await nextTick()

    expect(close).not.toHaveBeenCalled()
    expect(root.querySelector('.dag-detail-drawer')).not.toBeNull()
    expect(root.querySelector('.dag-chat-log')).toBeNull()
    expect(logsButton!.textContent).not.toContain('Collapse')

    logsButton!.click()
    await nextTick()

    expect(root.querySelector('.dag-chat-log')).not.toBeNull()
    expect(logsButton!.textContent).toContain('Collapse')
  })

  it('identifies Manager-owned control nodes without worker metrics', () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagNodeDetailDrawer, {
      metrics: {
        run_id: 'run-1',
        status: 'completed',
        nodes: {
          verification_quorum: {
            node_id: 'verification_quorum',
            node_name: 'verification_quorum',
            agent_name: '__gateway__',
            status: 'completed',
            tool_calls: 0,
            tool_failures: 0,
            tokens: null,
            execution: null,
            usage_scope: 'node_cumulative',
            usage_available: false,
            duration_ms: null,
            num_turns: null,
            started_at: null,
            completed_at: null,
          },
        },
        totals: {
          tool_calls: 0,
          tool_failures: 0,
          tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
          usage_available: false,
          cost_usd: null,
        },
      },
      selectedNodeId: 'verification_quorum',
      open: true,
      panelFocus: 'logs',
      expandedPanels: new Set(['logs']),
    })
    app.use(i18n)
    app.mount(root)

    expect(root.querySelector('[data-testid="dag-node-execution-owner"]')?.textContent)
      .toContain('Manager logic · QUORUM')
    expect(root.textContent).toContain('no worker or model is dispatched')
    expect(root.querySelector('.dag-detail-drawer')?.textContent).not.toContain('tokens')
  })

  it('shows persisted execution identity and updates cumulative token categories live', async () => {
    const metrics = ref<DAGRunMetrics>({
      run_id: 'run-1',
      status: 'completed',
      nodes: {
        prepare_repository: {
          node_id: 'prepare_repository',
          node_name: 'prepare_repository',
          agent_name: 'prepare_repository',
          status: 'completed',
          tool_calls: 3,
          tool_failures: 0,
          tokens: {
            input: 12_000,
            output: 3_000,
            cache_read: 4_000,
            cache_creation: 1_000,
            total: 20_000,
          },
          execution: {
            provider_id: 'anthropic',
            provider_display_name: 'Anthropic',
            model_name: 'claude-sonnet-4-20250514',
            model_display_name: 'Claude Sonnet 4',
            agent_backend: 'claude-sdk',
            protocol: 'anthropic_compatible',
            context_limit: 200_000,
            context_usage_pct: 10,
          },
          usage_scope: 'node_cumulative',
          usage_available: true,
          duration_ms: 2_500,
          num_turns: 2,
          started_at: null,
          completed_at: null,
        },
      },
      totals: {
        tool_calls: 3,
        tool_failures: 0,
        tokens: {
          input: 12_000,
          output: 3_000,
          cache_read: 4_000,
          cache_creation: 1_000,
          total: 20_000,
        },
        usage_available: true,
        cost_usd: null,
      },
    })
    const Harness = defineComponent({
      setup() {
        return () => h(DagNodeDetailDrawer, {
          metrics: metrics.value,
          selectedNodeId: 'prepare_repository',
          open: true,
          panelFocus: 'logs',
          expandedPanels: new Set(['logs']),
        })
      },
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)

    expect(root.querySelector('[data-testid="dag-execution-model"]')?.textContent).toContain('Claude Sonnet 4')
    expect(root.textContent).toContain('claude-sonnet-4-20250514')
    expect(root.querySelector('[data-testid="dag-execution-provider"]')?.textContent).toContain('Anthropic')
    expect(root.querySelector('[data-testid="dag-execution-backend"]')?.textContent).toContain('claude-sdk')
    expect(root.querySelector('[data-testid="dag-execution-protocol"]')?.textContent).toContain('anthropic_compatible')
    expect(root.querySelector('[data-testid="dag-execution-total-tokens"]')?.textContent).toContain('20.0K')
    expect(root.textContent).toContain('12.0K')
    expect(root.textContent).toContain('3.0K')
    expect(root.textContent).toContain('4.0K')
    expect(root.textContent).toContain('1.0K')
    expect(root.textContent).toContain('10.0%')
    expect(root.textContent).toContain('200.0K')
    expect(root.textContent).toContain('Cumulative for this node')

    metrics.value.nodes.prepare_repository.tokens = {
      input: 13_000,
      output: 4_000,
      cache_read: 4_000,
      cache_creation: 1_000,
      total: 22_000,
    }
    await nextTick()

    expect(root.querySelector('[data-testid="dag-execution-total-tokens"]')?.textContent).toContain('22.0K')
    expect(root.querySelector('.dag-detail-drawer')).not.toBeNull()
  })

  it('renders unavailable worker identity and usage as dashes instead of zeroes', () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagNodeDetailDrawer, {
      metrics: {
        run_id: 'run-1',
        status: 'running',
        nodes: {
          prepare_repository: {
            node_id: 'prepare_repository',
            node_name: 'prepare_repository',
            agent_name: 'prepare_repository',
            status: 'running',
            tool_calls: 0,
            tool_failures: 0,
            tokens: null,
            execution: null,
            usage_scope: 'node_cumulative',
            usage_available: false,
            duration_ms: null,
            num_turns: null,
            started_at: null,
            completed_at: null,
          },
        },
        totals: {
          tool_calls: 0,
          tool_failures: 0,
          tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
          usage_available: false,
          cost_usd: null,
        },
      },
      selectedNodeId: 'prepare_repository',
      open: true,
      panelFocus: 'logs',
      expandedPanels: new Set(['logs']),
    })
    app.use(i18n)
    app.mount(root)

    expect(root.querySelector('[data-testid="dag-execution-model"]')?.textContent?.trim()).toBe('—')
    expect(root.querySelector('[data-testid="dag-execution-total-tokens"]')?.textContent?.trim()).toBe('—')
    expect(root.querySelector('[data-testid="dag-node-execution"]')?.textContent).not.toContain('0 tokens')
  })
})

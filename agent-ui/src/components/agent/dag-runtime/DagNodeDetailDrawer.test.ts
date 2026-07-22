import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
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
          tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
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
})

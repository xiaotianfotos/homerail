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
})

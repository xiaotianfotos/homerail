import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import DagRuntimeToolbar from './DagRuntimeToolbar.vue'

vi.mock('@/stores/agent-store', () => ({
  useAgentStore: () => ({
    nodes: [],
    statusSummary: { completed: 0, skipped: 0 },
    isRunning: false,
    isCompleted: false,
    isFailed: false,
    dagExecution: null,
    currentRunId: null,
  }),
}))

describe('DagRuntimeToolbar', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  it('shows the run count even when no run graph is selected', () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagRuntimeToolbar, {
      metrics: null,
      view: 'run_list',
      runsCount: 23,
    })
    app.use(i18n)
    app.mount(root)

    expect(root.textContent).toContain('DAG Runs')
    expect(root.textContent).toContain('23')
    expect(root.textContent).toContain('Close')
  })
})

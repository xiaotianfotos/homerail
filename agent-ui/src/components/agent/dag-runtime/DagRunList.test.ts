import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from 'vue'
import { i18n } from '@/plugins/i18n'
import DagRunList from './DagRunList.vue'

describe('DagRunList waiting state', () => {
  let app: App<Element> | null = null
  let root: HTMLElement | null = null

  beforeEach(() => {
    i18n.global.locale.value = 'zh-Hans'
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
  })

  it('renders a waiting run as paused rather than running', () => {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(DagRunList, {
      runs: [{
        runId: 'run-waiting-for-command',
        workflowName: 'Review workflow',
        nodeCount: 2,
        status: 'waiting',
        createdAt: Date.now(),
      }],
      loading: false,
      focusedIndex: 0,
      currentRunId: 'run-waiting-for-command',
    })
    app.use(i18n)
    app.mount(root)

    expect(root.textContent).toContain('等待指令')
    expect(root.querySelector('[data-status="waiting"]')).not.toBeNull()
    expect(root.querySelector('.animate-spin')).toBeNull()
  })
})

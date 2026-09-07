import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'

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
import type { DAGNodeResult } from '@/api/types/dag.types'
import DagNodeResultView from './DagNodeResultView.vue'

function makeResult(overrides: Partial<DAGNodeResult>): DAGNodeResult {
  return {
    node_id: 'n1',
    node_name: 'n1',
    node_type: 'agent',
    result_kind: 'worker',
    status: 'completed',
    latest: null,
    handoffs: [],
    ...overrides,
  }
}

describe('DagNodeResultView', () => {
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

  function mount(result: DAGNodeResult | null, loading = false): HTMLElement {
    const Harness = defineComponent({
      setup() {
        return () => h(DagNodeResultView, { result, loading })
      },
    })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(Harness)
    app.use(i18n)
    app.mount(root)
    return root
  }

  it('shows the empty state when no result exists yet', () => {
    const el = mount(makeResult({ latest: null, handoffs: [] }))
    expect(el.textContent).toContain('No result yet for this node')
  })

  it('renders a command result with exit code, command line and parsed value', async () => {
    const el = mount(makeResult({
      node_type: 'command_gateway',
      result_kind: 'command',
      latest: { port: 'passed', content: { verdict: 'pass' }, timestamp: '2026-01-01T00:00:00Z' },
      telemetry: {
        ok: true,
        command: 'node',
        args: ['-e', 'console.log(1)'],
        exit_code: 0,
        duration_ms: 42,
        stdout: '{"verdict":"pass"}',
        stderr: '',
        value: { verdict: 'pass' },
      },
    }))
    expect(el.textContent).toContain('Passed')
    expect(el.textContent).toContain('exit 0')
    expect(el.querySelector('[data-testid="command-result-line"]')?.textContent).toBe('node -e console.log(1)')
    expect(el.querySelector('[data-testid="command-result-value"]')?.textContent).toContain('"verdict"')

    // stdout is collapsed by default and expands on click
    expect(el.textContent).not.toContain('{"verdict":"pass"}')
    el.querySelector<HTMLButtonElement>('[data-testid="command-stdout-toggle"]')?.click()
    await nextTick()
    expect(el.textContent).toContain('{"verdict":"pass"}')
  })

  it('renders a failed command result from envelope-shaped handoff content', () => {
    const el = mount(makeResult({
      node_type: 'command_gateway',
      result_kind: 'command',
      latest: {
        port: 'failed',
        content: { ok: false, command: 'node', exit_code: 1, stdout: '', stderr: 'boom', error: undefined },
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))
    expect(el.textContent).toContain('Failed')
    expect(el.textContent).toContain('exit 1')
  })

  it('renders a join result with vote statistics and values', () => {
    const el = mount(makeResult({
      node_type: 'join_gateway',
      result_kind: 'join',
      latest: {
        port: 'accepted',
        content: {
          mode: 'n_of_m',
          total: 3,
          successes: 2,
          failures: 1,
          threshold: 2,
          passed: true,
          values: [{ decision: 'approve' }, { decision: 'approve' }, { decision: 'reject' }],
        },
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))
    expect(el.textContent).toContain('Quorum passed')
    expect(el.textContent).toContain('N of M')
    expect(el.querySelector('[data-testid="join-successes"]')?.textContent).toBe('2')
    expect(el.textContent).toContain('{"decision":"reject"}')
  })

  it('renders a condition result with the chosen route', () => {
    const el = mount(makeResult({
      node_type: 'condition_gateway',
      result_kind: 'condition',
      latest: { port: 'approved', content: { status: 'pass' }, timestamp: '2026-01-01T00:00:00Z' },
    }))
    expect(el.querySelector('[data-testid="condition-port"]')?.textContent).toBe('approved')
    expect(el.textContent).toContain('"status": "pass"')
  })

  it('renders a state result with record and previous value', () => {
    const el = mount(makeResult({
      node_type: 'state_gateway',
      result_kind: 'state',
      latest: {
        port: 'done',
        content: { updated: true, operation: 'increment', record: { value: 3 }, previous: { value: 2 } },
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))
    expect(el.textContent).toContain('Updated')
    expect(el.querySelector('[data-testid="state-record"]')?.textContent).toContain('"value": 3')
    expect(el.textContent).toContain('"value": 2')
  })

  it('labels an admitted budget_admit state result as updated, not unchanged', () => {
    // budget_admit 载荷（含 operation + updated，由后端 state 网关构造）：
    // 之前缺这两个字段时被误标为 Unchanged
    const el = mount(makeResult({
      node_type: 'state_gateway',
      result_kind: 'state',
      latest: {
        port: 'admitted',
        content: {
          operation: 'budget_admit',
          updated: true,
          admitted: true,
          spent: 2,
          requested: 3,
          remaining: 5,
          limit: 10,
          record: { value: 5, version: 2 },
          input: 3,
        },
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))
    expect(el.textContent).toContain('Updated')
    expect(el.textContent).not.toContain('Unchanged')
    expect(el.textContent).toContain('budget_admit')
  })

  it('renders a while result with iteration progress', () => {
    const el = mount(makeResult({
      node_type: 'while_gateway',
      result_kind: 'while',
      latest: {
        port: 'done',
        content: { input: { score: 5 }, iteration: 2, max_iterations: 3, matched: true },
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))
    expect(el.textContent).toContain('Condition met')
    expect(el.textContent).toContain('Iteration 2/3')
  })

  it('falls back to formatted JSON for worker and unknown kinds', () => {
    const el = mount(makeResult({
      result_kind: 'worker',
      latest: { port: 'done', content: { summary: 'all good' }, timestamp: '2026-01-01T00:00:00Z' },
    }))
    expect(el.querySelector('[data-testid="fallback-content"]')?.textContent).toContain('"summary": "all good"')
    expect(el.textContent).toContain('done')
  })
})

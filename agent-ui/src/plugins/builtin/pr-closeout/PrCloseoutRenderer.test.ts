import { afterEach, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import type { GenerativeUiCompositionItemV1, GenerativeUiStoredNodeV1 } from 'homerail-protocol'
import { i18n } from '@/plugins/i18n'
import PrCloseoutRenderer from './PrCloseoutRenderer.vue'

let app: App<Element> | null = null
let root: HTMLElement | null = null

function node(content: Record<string, unknown>): GenerativeUiStoredNodeV1 {
  return {
    ir_version: 1,
    id: 'com.homerail.pr-closeout:pr-21',
    kind: 'com.homerail.pr-closeout/report',
    kind_version: 1,
    owner: { id: 'com.homerail.pr-closeout', version: '1.0.0' },
    surface: 'result',
    importance: 'primary',
    content,
    fallback: { title: 'PR closeout', summary: 'Portable result' },
    revision: 1,
    updated_at: '2026-07-12T12:00:00.000Z',
  }
}

function placement(variant: GenerativeUiCompositionItemV1['variant']): GenerativeUiCompositionItemV1 {
  return {
    node_id: 'com.homerail.pr-closeout:pr-21',
    node_revision: 1,
    surface: 'result',
    variant,
    rank: 1,
    placement: 'primary',
    pinned: false,
    visibility: 'visible',
  }
}

function mount(
  content: Record<string, unknown>,
  variant: GenerativeUiCompositionItemV1['variant'] = 'detail',
): HTMLElement {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(PrCloseoutRenderer, { node: node(content), placement: placement(variant) })
  app.use(i18n)
  app.mount(root)
  return root
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('PrCloseoutRenderer', () => {
  it('fits the default summary block and expands into the complete report', async () => {
    const mounted = mount({
      id: 'com.homerail.pr-closeout:pr-21',
      title: 'PR #21',
      repository: 'xiaotianfotos/homerail',
      pr_number: 21,
      status: 'draft',
      recommendation: 'blocked',
      checks: [{ id: 'ci', label: 'CI', status: 'passed' }],
      flow: [
        { id: 'ci', label: 'CI', status: 'passed', depends_on: [] },
        { id: 'gate', label: 'Merge gate', status: 'blocked', depends_on: ['ci'] },
      ],
      blockers: [{ id: 'gate', title: 'Windows missing', severity: 'blocking' }],
      platforms: [{ id: 'windows', label: 'Windows', status: 'pending' }],
    }, 'summary')

    expect(mounted.querySelector('.pr-closeout')?.getAttribute('data-compact')).toBe('true')
    expect(mounted.querySelector('.pr-closeout__compact-body')).not.toBeNull()
    expect(mounted.querySelector('.pr-closeout__graph')).toBeNull()

    mounted.querySelector<HTMLButtonElement>('.pr-closeout__expand')?.click()
    await nextTick()

    expect(mounted.querySelector('.pr-closeout')?.getAttribute('data-expanded')).toBe('true')
    expect(mounted.querySelector('.pr-closeout')?.getAttribute('data-compact')).toBe('false')
    expect(mounted.querySelector('.pr-closeout__graph')).not.toBeNull()
  })

  it('renders a dense evidence dashboard and a real dependency graph', () => {
    i18n.global.locale.value = 'zh-Hans'
    const mounted = mount({
      id: 'com.homerail.pr-closeout:pr-21',
      title: 'PR #21 DAG runtime patterns',
      repository: 'xiaotianfotos/homerail',
      pr_number: 21,
      pr_url: 'https://github.com/xiaotianfotos/homerail/pull/21',
      status: 'draft',
      recommendation: 'blocked',
      risk: 'medium',
      summary: 'Windows validation remains required.',
      checks: [
        { id: 'manager', label: 'Manager tests', status: 'passed', detail: '316 passed' },
        { id: 'windows', label: 'Windows Electron', status: 'pending' },
      ],
      flow: [
        { id: 'review', label: 'Review', status: 'passed', progress: 100, depends_on: [] },
        { id: 'tests', label: 'Tests', status: 'passed', progress: 100, depends_on: ['review'] },
        { id: 'mac', label: 'macOS', status: 'passed', progress: 100, depends_on: ['tests'] },
        { id: 'windows', label: 'Windows', status: 'blocked', progress: 0, depends_on: ['tests'] },
        { id: 'gate', label: 'Merge gate', status: 'blocked', progress: 75, depends_on: ['mac', 'windows'] },
      ],
      blockers: [{ id: 'win', title: 'Windows evidence missing', severity: 'blocking', owner: 'runner' }],
      reviews: [{ id: 'r1', title: 'Approval boundary', status: 'resolved' }],
      platforms: [
        { id: 'mac', label: 'macOS', status: 'passed' },
        { id: 'win', label: 'Windows', status: 'pending' },
      ],
      evidence: [{ id: 'e1', label: 'Manager suite', status: 'verified', detail: '316 passed', at: '12:00' }],
    })

    expect(mounted.querySelector('.pr-closeout')?.getAttribute('data-recommendation')).toBe('blocked')
    expect(mounted.textContent).toContain('Windows validation remains required.')
    expect(mounted.textContent).toContain('Windows evidence missing')
    expect(mounted.textContent).toContain('316 passed')
    expect(mounted.querySelectorAll('.pr-closeout__flow-node')).toHaveLength(5)
    expect(mounted.querySelectorAll('.pr-closeout__graph path[data-status]')).toHaveLength(5)
    expect(mounted.querySelectorAll('.pr-closeout__platforms > div')).toHaveLength(2)
    expect(mounted.querySelector('.pr-closeout__decision')?.textContent).toContain('受阻')
  })

  it('drops unsafe navigation and tolerates duplicate or dangling flow references', () => {
    const mounted = mount({
      id: 'com.homerail.pr-closeout:pr-19',
      title: 'PR #19',
      repository: 'xiaotianfotos/homerail',
      pr_number: 19,
      pr_url: 'javascript:alert(document.domain)',
      status: 'open',
      recommendation: 'ready',
      flow: [
        { id: 'one', label: 'One', status: 'passed', depends_on: ['missing'] },
        { id: 'one', label: 'Duplicate', status: 'failed', depends_on: [] },
        { id: 'two', label: 'Two', status: 'passed', depends_on: ['one'] },
      ],
      actions: [
        { id: 'unsafe', label: 'Unsafe', style: 'primary', url: 'javascript:alert(1)' },
        { id: 'safe', label: 'Safe', style: 'secondary', url: 'https://example.com/checks' },
      ],
    })

    const links = [...mounted.querySelectorAll<HTMLAnchorElement>('.pr-closeout__actions a')]
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toContain('Safe')
    expect(links[0].getAttribute('href')).toBe('https://example.com/checks')
    expect(mounted.querySelectorAll('.pr-closeout__flow-node')).toHaveLength(2)
    expect(mounted.querySelectorAll('.pr-closeout__graph path[data-status]')).toHaveLength(1)
  })
})

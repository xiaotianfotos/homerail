import { defineComponent, h, type CSSProperties, type PropType, type VNode } from 'vue'
import MarkdownIt from 'markdown-it'
import {
  Activity, AlertTriangle, Check, Clock3, Database, ExternalLink, File, GitBranch,
  Monitor, Pause, Play, Search, Server, Settings, Shield, Sparkles, User, X,
} from 'lucide-vue-next'
import { isSafeGenerativeUiArtifactUri, type HomerailViewModelNodeV1 } from 'homerail-protocol'
import ViewSpecDag from './ViewSpecDag.vue'

const icons = {
  activity: Activity, alert: AlertTriangle, check: Check, clock: Clock3, database: Database,
  'external-link': ExternalLink, file: File, git: GitBranch, monitor: Monitor, pause: Pause,
  play: Play, search: Search, server: Server, settings: Settings, shield: Shield,
  sparkles: Sparkles, user: User, x: X,
} as const

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true, typographer: true })
markdown.disable(['image'])
markdown.validateLink = url => isSafeGenerativeUiArtifactUri(url)
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, index, options)
}

function spanStyle(node: HomerailViewModelNodeV1): CSSProperties {
  return { gridColumn: `span ${node.span}` }
}

function children(node: HomerailViewModelNodeV1, emit: (actionId: string) => void, compact: boolean): VNode[] {
  return (node.children ?? []).map(child => h(ViewSpecNode, {
    key: child.id,
    model: child,
    compact,
    onRequestAction: emit,
  }))
}

function renderNode(node: HomerailViewModelNodeV1, emit: (actionId: string) => void, compact: boolean): VNode {
  const base = [`hr-view__node`, `hr-view__${node.type}`]
  const attrs = { class: base, 'data-tone': node.tone ?? 'neutral', style: spanStyle(node) }
  if (node.type === 'stack' || node.type === 'repeat') {
    return h('div', { ...attrs, 'data-gap': node.gap ?? 'md', 'data-align': node.align ?? 'stretch' }, children(node, emit, compact))
  }
  if (node.type === 'grid') {
    return h('div', {
      ...attrs,
      'data-gap': node.gap ?? 'md',
      'data-align': node.align ?? 'stretch',
      style: { ...spanStyle(node), '--columns': node.columns?.default ?? 1, '--compact-columns': node.columns?.compact ?? 1 },
    }, children(node, emit, compact))
  }
  if (node.type === 'section') {
    return h('section', attrs, [node.title ? h('header', node.title) : null, ...children(node, emit, compact)])
  }
  if (node.type === 'heading') {
    return h((`h${node.level ?? 2}`) as 'h1', attrs, node.text)
  }
  if (node.type === 'text') {
    return h('p', { ...attrs, style: { ...spanStyle(node), '--max-lines': node.max_lines ?? 'none' } }, node.text)
  }
  if (node.type === 'markdown') {
    return h('div', {
      ...attrs,
      style: { ...spanStyle(node), '--max-lines': node.max_lines ?? 'none' },
      innerHTML: markdown.render(node.text ?? ''),
    })
  }
  if (node.type === 'icon') {
    const Icon = node.name ? icons[node.name] : Activity
    return h('i', attrs, [h(Icon, { size: 18, 'aria-hidden': true })])
  }
  if (node.type === 'badge') return h('span', attrs, node.text)
  if (node.type === 'divider') return h('hr', attrs)
  if (node.type === 'metric') {
    return h('article', attrs, [h('span', node.label), h('strong', [node.value, node.unit ? h('small', node.unit) : null])])
  }
  if (node.type === 'progress') {
    return h('div', attrs, [
      node.label || node.value ? h('header', [h('span', node.label), h('strong', node.value)]) : null,
      h('div', { class: 'hr-view__progress-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': node.progress ?? 0 }, [
        h('i', { style: { width: `${node.progress ?? 0}%` } }),
      ]),
    ])
  }
  if (node.type === 'list') {
    return h('ul', attrs, (node.items ?? []).map(item => h('li', { key: item.id, 'data-tone': item.tone }, [
      h('i'), h('div', [h('strong', item.title), item.detail ? h('p', item.detail) : null]), item.badge ? h('span', item.badge) : null,
    ])))
  }
  if (node.type === 'table') {
    return h('div', { ...attrs, class: [...base, 'hr-view__table-scroll'] }, [h('table', { class: 'hr-view__table' }, [
      h('thead', [h('tr', (node.table_columns ?? []).map(column => h('th', { key: column.id }, column.label)))]),
      h('tbody', (node.items ?? []).map(item => h('tr', { key: item.id }, (item.cells ?? []).map(cell => h('td', { key: cell.id }, cell.value))))),
    ])])
  }
  if (node.type === 'timeline') {
    return h('ol', attrs, (node.items ?? []).map(item => h('li', { key: item.id, 'data-tone': item.tone }, [
      h('i'), item.badge ? h('time', item.badge) : null, h('div', [h('strong', item.title), item.detail ? h('p', item.detail) : null]),
    ])))
  }
  if (node.type === 'bar_chart') {
    const max = Math.max(1, ...(node.items ?? []).map(item => item.value ?? 0))
    return h('div', attrs, (node.items ?? []).map(item => h('div', { key: item.id, 'data-tone': item.tone }, [
      h('span', item.title), h('i', [h('b', { style: { width: `${Math.max(2, ((item.value ?? 0) / max) * 100)}%` } })]), h('strong', String(item.value ?? 0)),
    ])))
  }
  if (node.type === 'dag') return h(ViewSpecDag, { ...attrs, items: node.items ?? [] })
  if (node.type === 'action') {
    return h('button', { ...attrs, type: 'button', 'data-style': node.style, onClick: () => node.action_id && emit(node.action_id) }, node.label)
  }
  if (node.type === 'disclosure') {
    return h('details', { ...attrs, open: node.open }, [h('summary', node.title), h('div', children(node, emit, compact))])
  }
  if (node.type === 'link') {
    return h('a', { ...attrs, href: node.uri, target: '_blank', rel: 'noopener noreferrer' }, [node.label, h(ExternalLink, { size: 13 })])
  }
  return h('div', attrs)
}

const ViewSpecNode = defineComponent({
  name: 'ViewSpecNode',
  props: {
    model: { type: Object as PropType<HomerailViewModelNodeV1>, required: true },
    compact: { type: Boolean, default: false },
  },
  emits: { 'request-action': (actionId: string) => Boolean(actionId) },
  setup(props, { emit }) {
    return () => renderNode(props.model, actionId => emit('request-action', actionId), props.compact)
  },
})

export default ViewSpecNode

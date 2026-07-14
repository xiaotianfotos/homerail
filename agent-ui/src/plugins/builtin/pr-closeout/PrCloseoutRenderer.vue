<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleHelp,
  CircleX,
  Clock3,
  ExternalLink,
  GitPullRequest,
  GitMerge,
  LoaderCircle,
  Maximize2,
  MessagesSquare,
  Minimize2,
  MonitorCheck,
  ShieldAlert,
} from 'lucide-vue-next'
import {
  isSafeGenerativeUiArtifactUri,
  type GenerativeUiCompositionItemV1,
  type GenerativeUiStoredNodeV1,
  type GenerativeUiSurfaceContextV1,
} from 'homerail-protocol'

type Row = Record<string, unknown>
type FlowNode = {
  id: string
  label: string
  status: string
  detail: string
  progress: number
  dependsOn: string[]
}
type PositionedFlowNode = FlowNode & { x: number; y: number; width: number; height: number }
type FlowEdge = { id: string; path: string; status: string }

const props = defineProps<{
  node: GenerativeUiStoredNodeV1
  placement?: GenerativeUiCompositionItemV1
  context?: GenerativeUiSurfaceContextV1
}>()
const { t } = useI18n()
const expanded = ref(false)
const compact = computed(() => !expanded.value && (props.placement?.variant ?? 'summary') !== 'detail')

const content = computed<Row>(() => props.node.content ?? {})
const title = computed(() => text(content.value.title, 160) || t('voice.widgets.prCloseout.title'))
const repository = computed(() => text(content.value.repository, 200))
const prNumber = computed(() => integer(content.value.pr_number))
const status = computed(() => text(content.value.status, 32) || 'open')
const recommendation = computed(() => text(content.value.recommendation, 40) || 'unknown')
const risk = computed(() => text(content.value.risk, 32) || 'unknown')
const summary = computed(() => text(content.value.summary, 2000))
const headSha = computed(() => text(content.value.head_sha, 64))
const updatedAt = computed(() => text(content.value.updated_at, 80))
const prUrl = computed(() => safeUrl(content.value.pr_url))

const checks = computed(() => rows(content.value.checks, 24).map((row, index) => ({
  id: text(row.id, 120) || `check-${index}`,
  label: text(row.label, 160) || t('voice.widgets.prCloseout.unnamedCheck'),
  status: text(row.status, 32) || 'unknown',
  detail: text(row.detail, 500),
  url: safeUrl(row.url),
  duration: number(row.duration_seconds),
})))

const blockers = computed(() => rows(content.value.blockers, 12).map((row, index) => ({
  id: text(row.id, 120) || `blocker-${index}`,
  title: text(row.title, 180) || t('voice.widgets.prCloseout.unnamedBlocker'),
  severity: text(row.severity, 32) || 'warning',
  detail: text(row.detail, 800),
  owner: text(row.owner, 120),
})))

const reviews = computed(() => rows(content.value.reviews, 20).map((row, index) => ({
  id: text(row.id, 120) || `review-${index}`,
  title: text(row.title, 180) || t('voice.widgets.prCloseout.unnamedReview'),
  status: text(row.status, 32) || 'unknown',
  author: text(row.author, 120),
  detail: text(row.detail, 800),
  url: safeUrl(row.url),
})))

const platforms = computed(() => rows(content.value.platforms, 10).map((row, index) => ({
  id: text(row.id, 80) || `platform-${index}`,
  label: text(row.label, 120) || t('voice.widgets.prCloseout.unnamedPlatform'),
  status: text(row.status, 32) || 'unknown',
  detail: text(row.detail, 500),
})))

const evidence = computed(() => rows(content.value.evidence, 24).map((row, index) => ({
  id: text(row.id, 120) || `evidence-${index}`,
  label: text(row.label, 180) || t('voice.widgets.prCloseout.unnamedEvidence'),
  status: text(row.status, 32) || 'unknown',
  detail: text(row.detail, 800),
  at: text(row.at, 80),
  url: safeUrl(row.url),
})))

const actions = computed(() => {
  const seenUrls = new Set(prUrl.value ? [prUrl.value] : [])
  return rows(content.value.actions, 6).flatMap((row, index) => {
    const action = {
      id: text(row.id, 80) || `action-${index}`,
      label: text(row.label, 100),
      style: text(row.style, 20) === 'primary' ? 'primary' : 'secondary',
      url: safeUrl(row.url),
    }
    if (!action.label || !action.url || seenUrls.has(action.url)) return []
    seenUrls.add(action.url)
    return [action]
  })
})

const flow = computed<FlowNode[]>(() => {
  const seen = new Set<string>()
  return rows(content.value.flow, 12).flatMap((row, index) => {
    const id = text(row.id, 100) || `flow-${index}`
    if (seen.has(id)) return []
    seen.add(id)
    return [{
      id,
      label: text(row.label, 140) || id,
      status: text(row.status, 32) || 'unknown',
      detail: text(row.detail, 400),
      progress: clamp(row.progress),
      dependsOn: strings(row.depends_on, 8, 100),
    }]
  })
})

const graph = computed(() => layoutFlow(flow.value))
const passedChecks = computed(() => checks.value.filter(check => check.status === 'passed').length)
const failedChecks = computed(() => checks.value.filter(check => check.status === 'failed').length)
const openReviews = computed(() => reviews.value.filter(review => review.status === 'open' || review.status === 'unknown').length)
const passedPlatforms = computed(() => platforms.value.filter(platform => platform.status === 'passed').length)
const verdictIcon = computed<Component>(() => {
  if (recommendation.value === 'ready') return GitMerge
  if (recommendation.value === 'changes_requested') return CircleX
  if (recommendation.value === 'blocked') return ShieldAlert
  return CircleHelp
})

function toggleExpanded(): void {
  expanded.value = !expanded.value
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && expanded.value) expanded.value = false
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))

function rows(value: unknown, limit: number): Row[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).filter((entry): entry is Row => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
}

function strings(value: unknown, limit: number, textLimit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, limit).map(item => text(item, textLimit)).filter(Boolean)
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function integer(value: unknown): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function number(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function clamp(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!candidate || !isSafeGenerativeUiArtifactUri(candidate)) return ''
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : ''
  } catch {
    return ''
  }
}

function statusLabel(value: string): string {
  const known = new Set([
    'blocked', 'changes_requested', 'closed', 'critical', 'dismissed', 'draft', 'failed', 'high',
    'info', 'low', 'medium', 'merged', 'not_run', 'open', 'outdated', 'passed', 'pending', 'ready',
    'resolved', 'running', 'skipped', 'superseded', 'unknown', 'verified', 'warning', 'blocking',
  ])
  return known.has(value) ? t(`voice.widgets.prCloseout.status.${value}`) : value
}

function statusIcon(value: string): Component {
  if (value === 'passed' || value === 'verified' || value === 'resolved' || value === 'ready') return CheckCircle2
  if (value === 'failed' || value === 'critical' || value === 'changes_requested') return CircleX
  if (value === 'running') return LoaderCircle
  if (value === 'blocked' || value === 'blocking' || value === 'warning') return AlertTriangle
  return Clock3
}

function durationLabel(value: number | undefined): string {
  if (value === undefined) return ''
  if (value < 60) return `${Math.round(value)}s`
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`
}

function progressStyle(progress: number): CSSProperties {
  return { '--progress': `${progress}%` } as CSSProperties
}

function nodeStyle(node: PositionedFlowNode): CSSProperties {
  return {
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${node.width}px`,
    height: `${node.height}px`,
    '--progress': `${node.progress}%`,
  } as CSSProperties
}

function layoutFlow(nodes: FlowNode[]): {
  nodes: PositionedFlowNode[]
  edges: FlowEdge[]
  width: number
  height: number
} {
  if (!nodes.length) return { nodes: [], edges: [], width: 720, height: 240 }
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  for (const node of nodes) {
    const dependencies = [...new Set(node.dependsOn)].filter(id => id !== node.id && nodeById.has(id))
    node.dependsOn = dependencies
    for (const dependency of dependencies) {
      outgoing.get(dependency)?.push(node.id)
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
    }
  }
  const depth = new Map(nodes.map(node => [node.id, 0]))
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1))
      indegree.set(target, (indegree.get(target) ?? 0) - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  const fallbackDepth = Math.max(0, ...depth.values()) + 1
  nodes.forEach(node => { if (!visited.has(node.id)) depth.set(node.id, fallbackDepth) })
  const columns = new Map<number, FlowNode[]>()
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  }
  const maxDepth = Math.max(0, ...columns.keys())
  const maxRows = Math.max(1, ...[...columns.values()].map(column => column.length))
  const width = Math.max(720, 80 + (maxDepth + 1) * 220)
  const height = Math.max(260, 48 + maxRows * 104)
  const nodeWidth = 172
  const nodeHeight = 72
  const positioned = nodes.map<PositionedFlowNode>((node) => {
    const columnIndex = depth.get(node.id) ?? 0
    const column = columns.get(columnIndex) ?? [node]
    const rowIndex = column.findIndex(candidate => candidate.id === node.id)
    const available = height - nodeHeight - 40
    const y = column.length === 1 ? available / 2 + 20 : 20 + rowIndex * (available / (column.length - 1))
    return { ...node, x: 36 + columnIndex * 220, y, width: nodeWidth, height: nodeHeight }
  })
  const positionedById = new Map(positioned.map(node => [node.id, node]))
  const edges: FlowEdge[] = []
  for (const target of positioned) {
    for (const dependency of target.dependsOn) {
      const source = positionedById.get(dependency)
      if (!source) continue
      const startX = source.x + source.width
      const startY = source.y + source.height / 2
      const endX = target.x
      const endY = target.y + target.height / 2
      const bend = Math.max(28, (endX - startX) * 0.48)
      edges.push({
        id: `${source.id}->${target.id}`,
        status: target.status,
        path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
      })
    }
  }
  return { nodes: positioned, edges, width, height }
}
</script>

<template>
  <div v-if="expanded" class="pr-closeout__backdrop" aria-hidden="true" @click="expanded = false" />
  <article
    class="pr-closeout"
    :data-recommendation="recommendation"
    :data-compact="compact"
    :data-expanded="expanded"
  >
    <header class="pr-closeout__hero">
      <div class="pr-closeout__identity">
        <span class="pr-closeout__eyebrow"><GitPullRequest :size="14" />{{ repository }} · #{{ prNumber }}</span>
        <h2>{{ title }}</h2>
        <p v-if="summary">{{ summary }}</p>
        <div class="pr-closeout__meta">
          <span>{{ statusLabel(status) }}</span>
          <span v-if="headSha" class="pr-closeout__sha">{{ headSha.slice(0, 12) }}</span>
          <span v-if="updatedAt">{{ updatedAt }}</span>
        </div>
      </div>
      <div class="pr-closeout__decision" :data-status="recommendation">
        <component :is="verdictIcon" :size="24" />
        <span>{{ t('voice.widgets.prCloseout.recommendation') }}</span>
        <strong>{{ statusLabel(recommendation) }}</strong>
        <small>{{ t('voice.widgets.prCloseout.risk', { risk: statusLabel(risk) }) }}</small>
      </div>
      <nav class="pr-closeout__actions" :aria-label="t('voice.widgets.prCloseout.actions')">
        <a v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer" class="pr-closeout__action pr-closeout__action--primary">
          {{ t('voice.widgets.prCloseout.openPr') }}<ExternalLink :size="14" />
        </a>
        <a
          v-for="action in actions"
          :key="action.id"
          :href="action.url"
          target="_blank"
          rel="noopener noreferrer"
          class="pr-closeout__action"
          :class="`pr-closeout__action--${action.style}`"
        >
          {{ action.label }}<ExternalLink :size="14" />
        </a>
        <button
          type="button"
          class="pr-closeout__action pr-closeout__expand"
          :aria-label="expanded ? t('voice.widgets.prCloseout.collapse') : t('voice.widgets.prCloseout.expand')"
          @click="toggleExpanded"
        >
          <Minimize2 v-if="expanded" :size="15" />
          <Maximize2 v-else :size="15" />
          {{ expanded ? t('voice.widgets.prCloseout.collapse') : t('voice.widgets.prCloseout.expand') }}
        </button>
      </nav>
    </header>

    <section v-if="compact" class="pr-closeout__compact-body">
      <div class="pr-closeout__compact-metrics">
        <div><CheckCircle2 :size="17" /><strong>{{ passedChecks }}</strong><span>{{ t('voice.widgets.prCloseout.passedChecks') }}</span></div>
        <div :data-tone="blockers.length ? 'warning' : 'positive'"><ShieldAlert :size="17" /><strong>{{ blockers.length }}</strong><span>{{ t('voice.widgets.prCloseout.blockers') }}</span></div>
        <div><MonitorCheck :size="17" /><strong>{{ passedPlatforms }}/{{ platforms.length }}</strong><span>{{ t('voice.widgets.prCloseout.platforms') }}</span></div>
      </div>
      <div class="pr-closeout__compact-flow" :aria-label="t('voice.widgets.prCloseout.compactFlow')">
        <div v-for="(flowNode, index) in flow.slice(0, 6)" :key="flowNode.id" :data-status="flowNode.status">
          <i><component :is="statusIcon(flowNode.status)" :size="13" /></i>
          <span>{{ flowNode.label }}</span>
          <b v-if="index < Math.min(flow.length, 6) - 1" aria-hidden="true">→</b>
        </div>
      </div>
      <div class="pr-closeout__compact-footer">
        <p v-if="blockers[0]"><AlertTriangle :size="15" /><span><strong>{{ blockers[0].title }}</strong>{{ blockers[0].detail }}</span></p>
        <p v-else><Check :size="15" /><span><strong>{{ t('voice.widgets.prCloseout.noBlockingIssues') }}</strong>{{ t('voice.widgets.prCloseout.clear') }}</span></p>
        <div class="pr-closeout__compact-platforms">
          <span v-for="platform in platforms" :key="platform.id" :data-status="platform.status">
            <component :is="statusIcon(platform.status)" :size="12" />{{ platform.label }}
          </span>
        </div>
      </div>
    </section>

    <template v-else>
    <section class="pr-closeout__metrics" :aria-label="t('voice.widgets.prCloseout.summaryMetrics')">
      <div data-tone="positive"><CheckCircle2 :size="18" /><strong>{{ passedChecks }}</strong><span>{{ t('voice.widgets.prCloseout.passedChecks') }}</span></div>
      <div :data-tone="failedChecks ? 'negative' : 'neutral'"><CircleX :size="18" /><strong>{{ failedChecks }}</strong><span>{{ t('voice.widgets.prCloseout.failedChecks') }}</span></div>
      <div :data-tone="blockers.length ? 'warning' : 'neutral'"><ShieldAlert :size="18" /><strong>{{ blockers.length }}</strong><span>{{ t('voice.widgets.prCloseout.blockers') }}</span></div>
      <div :data-tone="openReviews ? 'warning' : 'neutral'"><MessagesSquare :size="18" /><strong>{{ openReviews }}</strong><span>{{ t('voice.widgets.prCloseout.openReviews') }}</span></div>
      <div data-tone="info"><MonitorCheck :size="18" /><strong>{{ passedPlatforms }}/{{ platforms.length }}</strong><span>{{ t('voice.widgets.prCloseout.platforms') }}</span></div>
    </section>

    <div class="pr-closeout__primary-grid">
      <section class="pr-closeout__section pr-closeout__flow-section">
        <header><div><span>{{ t('voice.widgets.prCloseout.verificationFlow') }}</span><h3>{{ t('voice.widgets.prCloseout.gatesAndDependencies') }}</h3></div><em>{{ flow.length }}</em></header>
        <div v-if="graph.nodes.length" class="pr-closeout__graph-scroll">
          <div
            class="pr-closeout__graph"
            role="img"
            :aria-label="t('voice.widgets.prCloseout.graphLabel')"
            :style="{ width: `${graph.width}px`, height: `${graph.height}px` }"
          >
            <svg aria-hidden="true" :viewBox="`0 0 ${graph.width} ${graph.height}`" preserveAspectRatio="none">
              <defs>
                <marker id="pr-closeout-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              </defs>
              <path
                v-for="edge in graph.edges"
                :key="edge.id"
                :d="edge.path"
                :data-status="edge.status"
                marker-end="url(#pr-closeout-arrow)"
              />
            </svg>
            <div
              v-for="flowNode in graph.nodes"
              :key="flowNode.id"
              class="pr-closeout__flow-node"
              :data-status="flowNode.status"
              :style="nodeStyle(flowNode)"
            >
              <component :is="statusIcon(flowNode.status)" :size="15" />
              <div><strong>{{ flowNode.label }}</strong><span>{{ flowNode.detail || statusLabel(flowNode.status) }}</span></div>
              <i><b /></i>
            </div>
          </div>
        </div>
        <p v-else class="pr-closeout__empty">{{ t('voice.widgets.prCloseout.noFlow') }}</p>
      </section>

      <div class="pr-closeout__side-stack">
        <section class="pr-closeout__section">
          <header><div><span>{{ t('voice.widgets.prCloseout.platformCoverage') }}</span><h3>{{ t('voice.widgets.prCloseout.realMachines') }}</h3></div><em>{{ passedPlatforms }}/{{ platforms.length }}</em></header>
          <div class="pr-closeout__platforms">
            <div v-for="platform in platforms" :key="platform.id" :data-status="platform.status">
              <component :is="statusIcon(platform.status)" :size="17" />
              <p><strong>{{ platform.label }}</strong><span>{{ platform.detail || statusLabel(platform.status) }}</span></p>
              <em>{{ statusLabel(platform.status) }}</em>
            </div>
          </div>
          <p v-if="!platforms.length" class="pr-closeout__empty">{{ t('voice.widgets.prCloseout.noPlatforms') }}</p>
        </section>

        <section class="pr-closeout__section">
          <header><div><span>{{ t('voice.widgets.prCloseout.blockingIssues') }}</span><h3>{{ blockers.length ? t('voice.widgets.prCloseout.requiresAttention') : t('voice.widgets.prCloseout.noBlockingIssues') }}</h3></div><em>{{ blockers.length }}</em></header>
          <div v-if="blockers.length" class="pr-closeout__blockers">
            <article v-for="blocker in blockers" :key="blocker.id" :data-severity="blocker.severity">
              <AlertTriangle :size="17" />
              <div><strong>{{ blocker.title }}</strong><p v-if="blocker.detail">{{ blocker.detail }}</p><small v-if="blocker.owner">{{ blocker.owner }}</small></div>
            </article>
          </div>
          <div v-else class="pr-closeout__clear"><Check :size="18" />{{ t('voice.widgets.prCloseout.clear') }}</div>
        </section>
      </div>
    </div>

    <div class="pr-closeout__detail-grid">
      <section class="pr-closeout__section">
        <header><div><span>{{ t('voice.widgets.prCloseout.checks') }}</span><h3>{{ t('voice.widgets.prCloseout.automatedEvidence') }}</h3></div><em>{{ checks.length }}</em></header>
        <div class="pr-closeout__checks">
          <div v-for="check in checks" :key="check.id" :data-status="check.status">
            <component :is="statusIcon(check.status)" :size="16" />
            <p><strong>{{ check.label }}</strong><span>{{ check.detail || statusLabel(check.status) }}</span></p>
            <small v-if="check.duration !== undefined">{{ durationLabel(check.duration) }}</small>
            <a v-if="check.url" :href="check.url" target="_blank" rel="noopener noreferrer" :aria-label="check.label"><ExternalLink :size="14" /></a>
          </div>
        </div>
        <p v-if="!checks.length" class="pr-closeout__empty">{{ t('voice.widgets.prCloseout.noChecks') }}</p>
      </section>

      <section class="pr-closeout__section">
        <header><div><span>{{ t('voice.widgets.prCloseout.reviewThreads') }}</span><h3>{{ t('voice.widgets.prCloseout.reviewDisposition') }}</h3></div><em>{{ reviews.length }}</em></header>
        <div class="pr-closeout__reviews">
          <div v-for="review in reviews" :key="review.id" :data-status="review.status">
            <component :is="statusIcon(review.status)" :size="16" />
            <p><strong>{{ review.title }}</strong><span>{{ review.detail || review.author || statusLabel(review.status) }}</span></p>
            <em>{{ statusLabel(review.status) }}</em>
            <a v-if="review.url" :href="review.url" target="_blank" rel="noopener noreferrer" :aria-label="review.title"><ExternalLink :size="14" /></a>
          </div>
        </div>
        <p v-if="!reviews.length" class="pr-closeout__empty">{{ t('voice.widgets.prCloseout.noReviews') }}</p>
      </section>

      <section class="pr-closeout__section pr-closeout__evidence-section">
        <header><div><span>{{ t('voice.widgets.prCloseout.evidenceTimeline') }}</span><h3>{{ t('voice.widgets.prCloseout.groundedClaims') }}</h3></div><em>{{ evidence.length }}</em></header>
        <ol class="pr-closeout__timeline">
          <li v-for="item in evidence" :key="item.id" :data-status="item.status">
            <i><component :is="statusIcon(item.status)" :size="14" /></i>
            <time>{{ item.at || statusLabel(item.status) }}</time>
            <div><strong>{{ item.label }}</strong><p v-if="item.detail">{{ item.detail }}</p></div>
            <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer" :aria-label="item.label"><ExternalLink :size="14" /></a>
          </li>
        </ol>
        <p v-if="!evidence.length" class="pr-closeout__empty">{{ t('voice.widgets.prCloseout.noEvidence') }}</p>
      </section>
    </div>
    </template>
  </article>
</template>

<style scoped>
.pr-closeout { display:grid; grid-auto-rows:max-content; align-content:start; gap:16px; min-width:0; color:#edf7f6; }
.pr-closeout__backdrop { position:fixed; inset:0; z-index:999; background:rgba(0,5,6,.78); backdrop-filter:blur(8px); }
.pr-closeout[data-expanded="true"] { position:fixed; inset:18px; z-index:1000; overflow:auto; border:1px solid rgba(100,231,220,.24); border-radius:8px; padding:22px; background:#081011; box-shadow:0 28px 90px rgba(0,0,0,.65); }
.pr-closeout__hero { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:18px 24px; align-items:start; border-bottom:1px solid rgba(255,255,255,.09); padding:2px 2px 18px; animation:pr-closeout-enter .28s ease-out both; }
.pr-closeout__identity { min-width:0; }
.pr-closeout__eyebrow { display:inline-flex; align-items:center; gap:7px; color:#64e7dc; font-size:12px; font-weight:800; }
.pr-closeout__identity h2 { margin:8px 0 0; color:#f8ffff; font-size:clamp(22px,2.4vw,32px); line-height:1.14; letter-spacing:0; text-wrap:balance; }
.pr-closeout__identity > p { max-width:920px; margin:9px 0 0; color:rgba(225,240,239,.7); font-size:13px; line-height:1.6; }
.pr-closeout__meta { display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; }
.pr-closeout__meta span { border:1px solid rgba(255,255,255,.09); border-radius:999px; padding:4px 8px; color:rgba(221,238,237,.62); background:rgba(255,255,255,.035); font-size:10px; font-weight:750; }
.pr-closeout__sha { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.pr-closeout__decision { display:grid; min-width:162px; grid-template-columns:auto 1fr; gap:2px 9px; align-items:center; border-left:3px solid #8ba4a2; padding:7px 12px; background:rgba(255,255,255,.035); }
.pr-closeout__decision > svg { grid-row:1 / span 3; color:#9cb2b0; }
.pr-closeout__decision span,.pr-closeout__decision small { color:rgba(215,232,230,.55); font-size:10px; }
.pr-closeout__decision strong { font-size:15px; }
.pr-closeout__decision[data-status="ready"] { border-color:#42d3a3; background:rgba(39,180,133,.09); }
.pr-closeout__decision[data-status="ready"] > svg { color:#55dfb2; }
.pr-closeout__decision[data-status="blocked"] { border-color:#f4b84d; background:rgba(213,148,39,.1); }
.pr-closeout__decision[data-status="blocked"] > svg { color:#ffc45e; }
.pr-closeout__decision[data-status="changes_requested"] { border-color:#f16f73; background:rgba(220,71,77,.1); }
.pr-closeout__decision[data-status="changes_requested"] > svg { color:#ff8589; }
.pr-closeout__actions { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:8px; }
.pr-closeout__action { display:inline-flex; min-height:36px; align-items:center; justify-content:center; gap:7px; border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:0 12px; color:#dce8e7; background:rgba(255,255,255,.04); font:inherit; font-size:12px; font-weight:800; text-decoration:none; cursor:pointer; transition:border-color .18s ease,background .18s ease,transform .18s ease; }
.pr-closeout__action:hover { border-color:rgba(100,231,220,.45); background:rgba(100,231,220,.08); transform:translateY(-1px); }
.pr-closeout__action--primary { border-color:rgba(100,231,220,.35); color:#edfffd; background:rgba(65,197,185,.14); }
.pr-closeout__expand { margin-left:auto; }
.pr-closeout[data-compact="true"] { height:100%; min-height:0; gap:10px; overflow:auto; }
.pr-closeout[data-compact="true"] .pr-closeout__hero { grid-template-columns:minmax(0,1fr) auto; gap:8px 10px; padding:0 0 10px; }
.pr-closeout[data-compact="true"] .pr-closeout__eyebrow { font-size:10px; }
.pr-closeout[data-compact="true"] .pr-closeout__identity h2 { display:-webkit-box; margin-top:5px; overflow:hidden; font-size:17px; line-height:1.18; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.pr-closeout[data-compact="true"] .pr-closeout__identity > p { display:-webkit-box; margin-top:5px; overflow:hidden; font-size:10px; line-height:1.4; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.pr-closeout[data-compact="true"] .pr-closeout__meta { gap:4px; margin-top:6px; }
.pr-closeout[data-compact="true"] .pr-closeout__meta span { padding:3px 6px; font-size:8px; }
.pr-closeout[data-compact="true"] .pr-closeout__decision { min-width:118px; padding:5px 7px; }
.pr-closeout[data-compact="true"] .pr-closeout__decision > svg { width:18px; height:18px; }
.pr-closeout[data-compact="true"] .pr-closeout__decision span,.pr-closeout[data-compact="true"] .pr-closeout__decision small { font-size:8px; }
.pr-closeout[data-compact="true"] .pr-closeout__decision strong { font-size:11px; }
.pr-closeout[data-compact="true"] .pr-closeout__actions { gap:5px; }
.pr-closeout[data-compact="true"] .pr-closeout__action { min-height:28px; padding:0 8px; font-size:9px; }
.pr-closeout[data-compact="true"] .pr-closeout__action--secondary { display:none; }
.pr-closeout__compact-body { display:grid; min-height:0; gap:9px; }
.pr-closeout__compact-metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); border:1px solid rgba(255,255,255,.08); border-radius:7px; overflow:hidden; }
.pr-closeout__compact-metrics > div { display:grid; grid-template-columns:auto 1fr; gap:1px 6px; align-items:center; min-width:0; padding:8px; border-right:1px solid rgba(255,255,255,.07); }
.pr-closeout__compact-metrics > div:last-child { border-right:0; }
.pr-closeout__compact-metrics svg { grid-row:1 / span 2; color:#54d6aa; }
.pr-closeout__compact-metrics [data-tone="warning"] svg { color:#efb452; }
.pr-closeout__compact-metrics strong { font-size:16px; line-height:1; }
.pr-closeout__compact-metrics span { overflow:hidden; color:rgba(211,231,228,.5); font-size:8px; text-overflow:ellipsis; white-space:nowrap; }
.pr-closeout__compact-flow { display:flex; min-width:0; align-items:center; gap:5px; overflow-x:auto; padding:2px 0; scrollbar-width:none; }
.pr-closeout__compact-flow::-webkit-scrollbar { display:none; }
.pr-closeout__compact-flow > div { display:flex; flex:0 0 auto; align-items:center; gap:5px; color:rgba(221,238,236,.7); font-size:9px; font-weight:750; }
.pr-closeout__compact-flow i { display:grid; place-items:center; width:22px; height:22px; border:1px solid rgba(255,255,255,.1); border-radius:999px; color:#8ca7a4; background:rgba(255,255,255,.035); }
.pr-closeout__compact-flow [data-status="passed"] i { border-color:rgba(67,212,163,.34); color:#43d4a3; }
.pr-closeout__compact-flow [data-status="running"] i { border-color:rgba(89,217,200,.4); color:#59d9c8; }
.pr-closeout__compact-flow [data-status="blocked"] i,.pr-closeout__compact-flow [data-status="failed"] i { border-color:rgba(240,180,82,.4); color:#efb452; }
.pr-closeout__compact-flow b { color:rgba(142,173,169,.35); font-size:12px; }
.pr-closeout__compact-footer { display:grid; gap:7px; border-top:1px solid rgba(255,255,255,.07); padding-top:8px; }
.pr-closeout__compact-footer > p { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px; align-items:start; margin:0; color:#efb452; }
.pr-closeout__compact-footer > p > span { display:-webkit-box; overflow:hidden; color:rgba(216,233,231,.54); font-size:8px; line-height:1.35; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.pr-closeout__compact-footer strong { display:block; margin-bottom:2px; color:#f0f9f8; font-size:9px; }
.pr-closeout__compact-platforms { display:flex; flex-wrap:wrap; gap:5px; }
.pr-closeout__compact-platforms span { display:inline-flex; align-items:center; gap:4px; border:1px solid rgba(255,255,255,.08); border-radius:999px; padding:3px 6px; color:rgba(211,230,228,.6); font-size:8px; }
.pr-closeout__compact-platforms span[data-status="passed"] { border-color:rgba(67,212,163,.28); color:#76dcb8; }
.pr-closeout__compact-platforms span[data-status="running"] { border-color:rgba(89,217,200,.3); color:#7adfd4; }
.pr-closeout__metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); border:1px solid rgba(255,255,255,.08); border-radius:8px; overflow:hidden; background:rgba(0,0,0,.14); }
.pr-closeout__metrics > div { display:grid; grid-template-columns:auto 1fr; gap:1px 8px; align-items:center; min-width:0; padding:12px; border-right:1px solid rgba(255,255,255,.07); animation:pr-closeout-enter .28s ease-out both; }
.pr-closeout__metrics > div:last-child { border-right:0; }
.pr-closeout__metrics svg { grid-row:1 / span 2; color:#90aaa7; }
.pr-closeout__metrics strong { color:#f8ffff; font-size:20px; line-height:1; }
.pr-closeout__metrics span { overflow:hidden; color:rgba(215,231,229,.56); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.pr-closeout__metrics [data-tone="positive"] svg { color:#43d4a3; }
.pr-closeout__metrics [data-tone="negative"] svg { color:#f27377; }
.pr-closeout__metrics [data-tone="warning"] svg { color:#f0b64f; }
.pr-closeout__metrics [data-tone="info"] svg { color:#66b8ef; }
.pr-closeout__primary-grid { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.72fr); gap:14px; }
.pr-closeout__side-stack { display:grid; gap:14px; align-content:start; }
.pr-closeout__section { min-width:0; border-top:1px solid rgba(255,255,255,.09); padding-top:13px; }
.pr-closeout__section > header { display:flex; align-items:start; justify-content:space-between; gap:12px; margin-bottom:11px; }
.pr-closeout__section > header span { color:#68dcd4; font-size:10px; font-weight:850; text-transform:uppercase; }
.pr-closeout__section > header h3 { margin:3px 0 0; color:#effafa; font-size:15px; letter-spacing:0; }
.pr-closeout__section > header > em { border-radius:999px; padding:3px 7px; color:rgba(213,232,230,.58); background:rgba(255,255,255,.05); font-size:10px; font-style:normal; font-weight:800; }
.pr-closeout__graph-scroll { overflow-x:auto; border:1px solid rgba(255,255,255,.07); border-radius:8px; background:linear-gradient(180deg,rgba(8,24,25,.7),rgba(5,10,11,.5)); scrollbar-color:rgba(100,231,220,.3) transparent; }
.pr-closeout__graph { position:relative; min-height:260px; background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:28px 28px; }
.pr-closeout__graph > svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.pr-closeout__graph > svg > path { fill:none; stroke:rgba(132,161,158,.34); stroke-width:1.5; stroke-dasharray:5 5; animation:pr-closeout-edge-flow 1.4s linear infinite; }
.pr-closeout__graph > svg marker path { fill:#758f8c; }
.pr-closeout__graph > svg > path[data-status="running"] { stroke:#59d9c8; stroke-width:2; }
.pr-closeout__graph > svg > path[data-status="failed"],.pr-closeout__graph > svg > path[data-status="blocked"] { stroke:#e49b46; }
.pr-closeout__graph > svg > path[data-status="passed"] { stroke:rgba(67,212,163,.52); }
.pr-closeout__flow-node { position:absolute; display:grid; grid-template-columns:auto minmax(0,1fr); gap:5px 8px; align-content:center; border:1px solid rgba(255,255,255,.13); border-radius:7px; padding:9px 10px 12px; background:rgba(16,23,24,.96); box-shadow:0 10px 24px rgba(0,0,0,.22); animation:pr-closeout-enter .3s ease-out both; }
.pr-closeout__flow-node > svg { color:#92aaa7; }
.pr-closeout__flow-node strong,.pr-closeout__flow-node span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pr-closeout__flow-node strong { color:#f3fbfa; font-size:11px; }
.pr-closeout__flow-node span { margin-top:3px; color:rgba(208,227,225,.55); font-size:9px; }
.pr-closeout__flow-node > i { position:absolute; right:9px; bottom:6px; left:9px; height:2px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.08); }
.pr-closeout__flow-node > i b { display:block; width:var(--progress); height:100%; border-radius:inherit; background:#65dace; transition:width .28s ease; }
.pr-closeout__flow-node[data-status="passed"] { border-color:rgba(67,212,163,.38); }
.pr-closeout__flow-node[data-status="passed"] > svg { color:#43d4a3; }
.pr-closeout__flow-node[data-status="running"] { border-color:rgba(89,217,200,.65); box-shadow:0 0 0 1px rgba(89,217,200,.14),0 10px 24px rgba(0,0,0,.25); animation:pr-closeout-enter .3s ease-out both,pr-closeout-pulse 1.8s ease-in-out infinite; }
.pr-closeout__flow-node[data-status="running"] > svg { color:#59d9c8; animation:pr-closeout-spin 1.2s linear infinite; }
.pr-closeout__flow-node[data-status="failed"],.pr-closeout__flow-node[data-status="blocked"] { border-color:rgba(238,165,73,.55); }
.pr-closeout__flow-node[data-status="failed"] > svg,.pr-closeout__flow-node[data-status="blocked"] > svg { color:#f1b458; }
.pr-closeout__platforms,.pr-closeout__checks,.pr-closeout__reviews { display:grid; gap:6px; }
.pr-closeout__platforms > div,.pr-closeout__checks > div,.pr-closeout__reviews > div { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px; align-items:center; min-width:0; border-bottom:1px solid rgba(255,255,255,.06); padding:8px 2px; }
.pr-closeout__platforms > div:last-child,.pr-closeout__checks > div:last-child,.pr-closeout__reviews > div:last-child { border-bottom:0; }
.pr-closeout__platforms svg,.pr-closeout__checks svg,.pr-closeout__reviews svg { color:#8ba4a1; }
.pr-closeout__platforms p,.pr-closeout__checks p,.pr-closeout__reviews p { min-width:0; margin:0; }
.pr-closeout__platforms strong,.pr-closeout__platforms span,.pr-closeout__checks strong,.pr-closeout__checks span,.pr-closeout__reviews strong,.pr-closeout__reviews span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pr-closeout__platforms strong,.pr-closeout__checks strong,.pr-closeout__reviews strong { font-size:11px; }
.pr-closeout__platforms span,.pr-closeout__checks span,.pr-closeout__reviews span { margin-top:2px; color:rgba(207,226,224,.52); font-size:9px; }
.pr-closeout__platforms em,.pr-closeout__reviews em,.pr-closeout__checks small { color:rgba(214,233,231,.58); font-size:9px; font-style:normal; }
.pr-closeout__platforms [data-status="passed"] svg,.pr-closeout__checks [data-status="passed"] svg,.pr-closeout__reviews [data-status="resolved"] svg { color:#43d4a3; }
.pr-closeout__platforms [data-status="failed"] svg,.pr-closeout__checks [data-status="failed"] svg { color:#f27377; }
.pr-closeout__platforms [data-status="running"] svg,.pr-closeout__checks [data-status="running"] svg { color:#59d9c8; animation:pr-closeout-spin 1.2s linear infinite; }
.pr-closeout__checks > div,.pr-closeout__reviews > div { grid-template-columns:auto minmax(0,1fr) auto auto; }
.pr-closeout__checks a,.pr-closeout__reviews a,.pr-closeout__timeline a { display:grid; place-items:center; width:26px; height:26px; border-radius:5px; color:#7fded7; background:rgba(100,231,220,.07); }
.pr-closeout__blockers { display:grid; gap:7px; }
.pr-closeout__blockers article { display:grid; grid-template-columns:auto minmax(0,1fr); gap:9px; border-left:3px solid #e5a24c; border-radius:6px; padding:9px; background:rgba(199,126,34,.08); animation:pr-closeout-enter .25s ease-out both; }
.pr-closeout__blockers article[data-severity="critical"] { border-color:#ef7377; background:rgba(220,71,77,.09); }
.pr-closeout__blockers svg { color:#f0b558; }
.pr-closeout__blockers strong { display:block; font-size:11px; }
.pr-closeout__blockers p { margin:4px 0 0; color:rgba(218,233,231,.62); font-size:10px; line-height:1.45; }
.pr-closeout__blockers small { display:block; margin-top:5px; color:rgba(240,190,115,.75); font-size:9px; }
.pr-closeout__clear { display:flex; align-items:center; gap:8px; min-height:48px; color:#69d9ad; font-size:11px; font-weight:800; }
.pr-closeout__detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.pr-closeout__evidence-section { grid-column:1 / -1; }
.pr-closeout__timeline { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin:0; padding:0; list-style:none; }
.pr-closeout__timeline li { position:relative; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:7px 9px; align-items:start; min-width:0; border:1px solid rgba(255,255,255,.08); border-radius:7px; padding:10px; background:rgba(255,255,255,.025); animation:pr-closeout-enter .28s ease-out both; }
.pr-closeout__timeline i { display:grid; grid-row:1 / span 2; place-items:center; width:24px; height:24px; border-radius:999px; color:#91a9a6; background:rgba(255,255,255,.06); }
.pr-closeout__timeline time { grid-column:2; color:rgba(205,226,223,.48); font-size:9px; }
.pr-closeout__timeline div { grid-column:2; min-width:0; }
.pr-closeout__timeline strong { display:block; font-size:11px; }
.pr-closeout__timeline p { margin:3px 0 0; color:rgba(211,230,228,.57); font-size:9px; line-height:1.4; }
.pr-closeout__timeline li[data-status="verified"] i { color:#43d4a3; background:rgba(67,212,163,.1); }
.pr-closeout__timeline li[data-status="failed"] i { color:#f27377; background:rgba(242,115,119,.1); }
.pr-closeout__empty { margin:0; padding:16px 0; color:rgba(208,229,226,.4); font-size:10px; }
@keyframes pr-closeout-enter { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
@keyframes pr-closeout-edge-flow { to { stroke-dashoffset:-20; } }
@keyframes pr-closeout-pulse { 50% { box-shadow:0 0 0 4px rgba(89,217,200,.08),0 10px 24px rgba(0,0,0,.25); } }
@keyframes pr-closeout-spin { to { transform:rotate(360deg); } }
@media (max-width:980px) { .pr-closeout__primary-grid { grid-template-columns:1fr; } .pr-closeout__metrics { grid-template-columns:repeat(3,minmax(0,1fr)); } .pr-closeout__metrics > div:nth-child(3) { border-right:0; } .pr-closeout__metrics > div:nth-child(-n+3) { border-bottom:1px solid rgba(255,255,255,.07); } }
@media (max-width:640px) { .pr-closeout { gap:13px; } .pr-closeout[data-expanded="true"] { inset:6px; padding:14px; } .pr-closeout:not([data-compact="true"]) .pr-closeout__hero { grid-template-columns:1fr; } .pr-closeout:not([data-compact="true"]) .pr-closeout__decision { min-width:0; } .pr-closeout__metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } .pr-closeout__metrics > div { border-right:1px solid rgba(255,255,255,.07); border-bottom:1px solid rgba(255,255,255,.07); } .pr-closeout__metrics > div:nth-child(even) { border-right:0; } .pr-closeout__metrics > div:last-child { grid-column:1 / -1; border-bottom:0; } .pr-closeout__detail-grid { grid-template-columns:1fr; } .pr-closeout__evidence-section { grid-column:auto; } .pr-closeout__timeline { grid-template-columns:1fr; } }
@media (prefers-reduced-motion:reduce) { .pr-closeout *,.pr-closeout *::before,.pr-closeout *::after { animation:none !important; scroll-behavior:auto !important; transition:none !important; } }
</style>

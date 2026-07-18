<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ArrowLeft, Database, Filter, Network, RefreshCw, Search, XCircle } from 'lucide-vue-next'
import { getExperienceGraph } from '@/api/services/experience-api'
import type { ExperienceGraphDetail, ExperienceGraphEdge, ExperienceGraphNode } from '@/api/types/experience.types'
import {
  observeCanvasAppearance,
  readCanvasAppearancePalette,
  type CanvasAppearancePalette,
} from '@/appearance/canvas-appearance'

interface CanvasNode extends ExperienceGraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

interface CanvasPoint {
  x: number
  y: number
}

const router = useRouter()
const { t } = useI18n()
const graph = ref<ExperienceGraphDetail | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasNodes = ref<CanvasNode[]>([])
const canvasEdges = ref<ExperienceGraphEdge[]>([])
const selectedNodeId = ref<string | null>(null)
const hoverNodeId = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const searchText = ref('')
const selectedTypes = ref<string[]>([])
const resultLimit = ref(500)
const includeNeighbors = ref(true)

let nodeById = new Map<string, CanvasNode>()
let rafId = 0
let zoom = 1
let panX = 0
let panY = 0
let dragNode: CanvasNode | null = null
let panDrag: CanvasPoint | null = null
let layoutEnergy = 0
let layoutCenterX = 0
let layoutCenterY = 0
let stopObservingAppearance: (() => void) | null = null
let canvasPalette: CanvasAppearancePalette = readCanvasAppearancePalette()

const selectedNode = computed(() => graph.value?.nodes.find(node => node.id === selectedNodeId.value) ?? null)
const hoverNode = computed(() => graph.value?.nodes.find(node => node.id === hoverNodeId.value) ?? null)

const nodeTypeCounts = computed(() => {
  const counts = graph.value?.node_counts ?? {}
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
})

const graphStatusLabel = computed(() => {
  if (loading.value) return 'loading graph'
  if (hoverNode.value) return `${hoverNode.value.type}: ${hoverNode.value.label || hoverNode.value.id}`
  if (!graph.value?.available && graph.value?.reason) return graph.value.reason
  return `${canvasNodes.value.length} nodes`
})

const updatedLabel = computed(() => {
  if (graph.value?.updated_at) return `updated ${new Date(graph.value.updated_at).toLocaleTimeString()}`
  return loading.value ? 'waiting for data' : 'local graph'
})

type ExperienceTone = 'accent' | 'speaking' | 'success' | 'warning' | 'danger' | 'info' | 'text2'

function nodeTone(type: string): ExperienceTone {
  const tones: Record<string, ExperienceTone> = {
    Run: 'info',
    OrchestrationTemplate: 'success',
    ScorecardResult: 'speaking',
    FailureRootCause: 'danger',
    Lesson: 'warning',
    RunSignal: 'accent',
    Provider: 'warning',
    Model: 'speaking',
    RuntimeProfile: 'accent',
    Issue: 'danger',
    PullRequest: 'success',
    WorkerAgent: 'info',
  }
  return tones[type] ?? 'text2'
}

function nodeAccent(type: string): string {
  const tone = nodeTone(type)
  return tone === 'text2' ? 'var(--hr-text-2)' : `var(--hr-${tone})`
}

function nodeCanvasAccent(type: string): string {
  return canvasPalette[nodeTone(type)]
}

function edgeColor(type: string): string {
  const tones: Record<string, ExperienceTone> = {
    UsedTemplate: 'success',
    ScoredBy: 'speaking',
    FailedWith: 'danger',
    LedTo: 'warning',
    ObservedSignal: 'accent',
    UsedProvider: 'warning',
    UsedModel: 'speaking',
    CreatedPR: 'success',
  }
  return canvasPalette[tones[type] ?? 'text2']
}

function radiusFor(node: ExperienceGraphNode): number {
  const typeBoost = node.type === 'Run' ? 4 : node.type === 'RunSignal' ? -2 : 0
  const weight = Number(node.properties?.weight ?? node.properties?.score ?? 1)
  return Math.max(7, Math.min(18, 9 + typeBoost + Math.log2(Math.max(1, weight) + 1)))
}

function rebuildCanvasGraph(fit = false): void {
  const detail = graph.value
  const previous = new Map(canvasNodes.value.map(node => [node.id, node]))
  if (!detail?.nodes.length) {
    canvasNodes.value = []
    canvasEdges.value = []
    nodeById = new Map()
    return
  }

  const rect = canvasRef.value?.getBoundingClientRect()
  const centerX = rect ? rect.width / 2 : 0
  const centerY = rect ? rect.height / 2 : 0
  const nodes = detail.nodes.map((node, index) => {
    const old = previous.get(node.id)
    const angle = index * 2.399963
    const radius = 42 + Math.sqrt(index) * 34
    return {
      ...node,
      x: old?.x ?? centerX + Math.cos(angle) * radius,
      y: old?.y ?? centerY + Math.sin(angle) * radius,
      vx: old?.vx ?? 0,
      vy: old?.vy ?? 0,
      r: radiusFor(node),
    }
  })

  canvasNodes.value = nodes
  nodeById = new Map(nodes.map(node => [node.id, node]))
  canvasEdges.value = detail.edges.filter(edge => nodeById.has(edge.source_id) && nodeById.has(edge.target_id))
  setLayoutCenter()
  wakeLayout()
  if (fit) {
    void nextTick(() => {
      resizeCanvas()
      fitCanvasGraph()
    })
  }
}

function resizeCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.floor(rect.width * ratio))
  canvas.height = Math.max(1, Math.floor(rect.height * ratio))
  const ctx = canvas.getContext('2d')
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function setLayoutCenter(): void {
  if (!canvasNodes.value.length) {
    const rect = canvasRef.value?.getBoundingClientRect()
    layoutCenterX = rect ? rect.width / 2 : 0
    layoutCenterY = rect ? rect.height / 2 : 0
    return
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of canvasNodes.value) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x)
    maxY = Math.max(maxY, node.y)
  }
  layoutCenterX = (minX + maxX) / 2
  layoutCenterY = (minY + maxY) / 2
}

function wakeLayout(): void {
  layoutEnergy = 1
}

function freezeLayout(): void {
  layoutEnergy = 0
  for (const node of canvasNodes.value) {
    node.vx = 0
    node.vy = 0
  }
}

function tickLayout(): void {
  const nodes = canvasNodes.value
  if (layoutEnergy <= 0 || panDrag || dragNode || nodes.length === 0) return
  for (const node of nodes) {
    node.vx += (layoutCenterX - node.x) * 0.00035 * layoutEnergy
    node.vy += (layoutCenterY - node.y) * 0.00035 * layoutEnergy
  }

  const repulsion = Math.max(10, 310 / Math.max(1, Math.sqrt(nodes.length)))
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d2 = Math.max(90, dx * dx + dy * dy)
      const force = (repulsion / d2) * layoutEnergy
      a.vx -= dx * force
      a.vy -= dy * force
      b.vx += dx * force
      b.vy += dy * force
    }
  }

  for (const edge of canvasEdges.value) {
    const a = nodeById.get(edge.source_id)
    const b = nodeById.get(edge.target_id)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const target = 118
    const force = (dist - target) * 0.008 * layoutEnergy
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  let maxVelocity = 0
  for (const node of nodes) {
    if (node === dragNode) continue
    node.vx *= 0.78
    node.vy *= 0.78
    maxVelocity = Math.max(maxVelocity, Math.hypot(node.vx, node.vy))
    node.x += node.vx
    node.y += node.vy
  }
  layoutEnergy = maxVelocity < 0.025 ? 0 : layoutEnergy * 0.985
}

function drawGraph(): void {
  tickLayout()
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  const rect = canvas?.getBoundingClientRect()
  if (!canvas || !ctx || !rect) {
    rafId = requestAnimationFrame(drawGraph)
    return
  }
  const ratio = window.devicePixelRatio || 1
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, rect.width, rect.height)
  ctx.save()
  ctx.translate(panX, panY)
  ctx.scale(zoom, zoom)
  drawEdges(ctx)
  drawNodes(ctx)
  ctx.restore()
  rafId = requestAnimationFrame(drawGraph)
}

function drawEdges(ctx: CanvasRenderingContext2D): void {
  ctx.lineCap = 'round'
  for (const edge of canvasEdges.value) {
    const source = nodeById.get(edge.source_id)
    const target = nodeById.get(edge.target_id)
    if (!source || !target) continue
    const active = selectedNodeId.value === edge.source_id || selectedNodeId.value === edge.target_id
    ctx.strokeStyle = active ? edgeColor(edge.type) : canvasPalette.borderStrong
    ctx.lineWidth = active ? 1.8 : 1.1
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
    if (zoom > 0.68) {
      ctx.fillStyle = active ? canvasPalette.text1 : canvasPalette.text2
      ctx.font = '650 10px Inter, ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(edge.label || edge.type, (source.x + target.x) / 2 + 5, (source.y + target.y) / 2 - 5)
    }
  }
}

function drawNodes(ctx: CanvasRenderingContext2D): void {
  for (const node of canvasNodes.value) {
    const accent = nodeCanvasAccent(node.type)
    const active = selectedNodeId.value === node.id
    const hovering = hoverNodeId.value === node.id
    ctx.shadowColor = accent
    ctx.shadowBlur = active ? 22 : 9
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.lineWidth = active || hovering ? 3 : 1.2
    ctx.strokeStyle = active ? canvasPalette.text1 : canvasPalette.onStrong
    ctx.stroke()
    if (zoom > 0.5) {
      ctx.fillStyle = active ? canvasPalette.text1 : canvasPalette.text2
      ctx.font = `${active ? 720 : 650} 11px Inter, ui-sans-serif, system-ui, sans-serif`
      ctx.fillText(compactLabel(node.label || node.id), node.x + node.r + 6, node.y + 4)
    }
  }
}

function compactLabel(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 34 ? `${text.slice(0, 33)}...` : text
}

function pointerFromEvent(event: PointerEvent | WheelEvent): CanvasPoint {
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return {
    x: (event.clientX - rect.left - panX) / zoom,
    y: (event.clientY - rect.top - panY) / zoom,
  }
}

function screenPointer(event: PointerEvent | WheelEvent): CanvasPoint {
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hitNode(point: CanvasPoint): CanvasNode | null {
  for (let index = canvasNodes.value.length - 1; index >= 0; index -= 1) {
    const node = canvasNodes.value[index]
    if (Math.hypot(node.x - point.x, node.y - point.y) <= node.r + 6) return node
  }
  return null
}

function selectCanvasNode(node: CanvasNode | null): void {
  selectedNodeId.value = node?.id ?? null
}

function onCanvasPointerDown(event: PointerEvent): void {
  freezeLayout()
  const node = hitNode(pointerFromEvent(event))
  if (node) {
    dragNode = node
    selectCanvasNode(node)
    canvasRef.value?.setPointerCapture(event.pointerId)
    return
  }
  panDrag = screenPointer(event)
  canvasRef.value?.setPointerCapture(event.pointerId)
}

function onCanvasPointerMove(event: PointerEvent): void {
  const point = pointerFromEvent(event)
  const hovered = hitNode(point)
  hoverNodeId.value = hovered?.id ?? null
  if (dragNode) {
    dragNode.x = point.x
    dragNode.y = point.y
    dragNode.vx = 0
    dragNode.vy = 0
  }
  if (panDrag && !dragNode) {
    const screen = screenPointer(event)
    panX += screen.x - panDrag.x
    panY += screen.y - panDrag.y
    panDrag = screen
  }
}

function onCanvasPointerUp(event: PointerEvent): void {
  dragNode = null
  panDrag = null
  const canvas = canvasRef.value
  if (canvas?.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId)
  }
}

function onCanvasWheel(event: WheelEvent): void {
  event.preventDefault()
  freezeLayout()
  const before = pointerFromEvent(event)
  const delta = event.deltaY > 0 ? 0.92 : 1.08
  zoom = Math.max(0.35, Math.min(2.2, zoom * delta))
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect) return
  panX = event.clientX - rect.left - before.x * zoom
  panY = event.clientY - rect.top - before.y * zoom
}

function fitCanvasGraph(): void {
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect || !canvasNodes.value.length) {
    zoom = 1
    panX = 0
    panY = 0
    return
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of canvasNodes.value) {
    minX = Math.min(minX, node.x - node.r)
    minY = Math.min(minY, node.y - node.r)
    maxX = Math.max(maxX, node.x + node.r)
    maxY = Math.max(maxY, node.y + node.r)
  }
  const graphWidth = Math.max(1, maxX - minX)
  const graphHeight = Math.max(1, maxY - minY)
  zoom = Math.max(0.35, Math.min(1.6, Math.min(rect.width / graphWidth, rect.height / graphHeight) * 0.82))
  panX = rect.width / 2 - ((minX + maxX) / 2) * zoom
  panY = rect.height / 2 - ((minY + maxY) / 2) * zoom
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String((err as { message?: string })?.message || err)
}

function toggleType(type: string): void {
  selectedTypes.value = selectedTypes.value.includes(type)
    ? selectedTypes.value.filter(item => item !== type)
    : [...selectedTypes.value, type]
}

function clearFilters(): void {
  searchText.value = ''
  selectedTypes.value = []
  includeNeighbors.value = true
  resultLimit.value = 500
  void refreshGraph()
}

async function refreshGraph(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = await getExperienceGraph({
      query: searchText.value.trim() || undefined,
      node_type: selectedTypes.value,
      limit: resultLimit.value,
      include_neighbors: includeNeighbors.value,
    })
    graph.value = res.data
    if (!selectedNodeId.value || !graph.value.nodes.some(node => node.id === selectedNodeId.value)) {
      selectedNodeId.value = graph.value.nodes[0]?.id ?? null
    }
    rebuildCanvasGraph(true)
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

function propertyPreview(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

onMounted(() => {
  canvasPalette = readCanvasAppearancePalette()
  stopObservingAppearance = observeCanvasAppearance((palette) => {
    canvasPalette = palette
  })
  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
  rafId = requestAnimationFrame(drawGraph)
  void refreshGraph()
})

onUnmounted(() => {
  stopObservingAppearance?.()
  stopObservingAppearance = null
  window.removeEventListener('resize', resizeCanvas)
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <main class="experience-graph">
    <div class="experience-graph__ambient" />
    <div class="experience-shell">
      <header class="experience-topbar">
        <div class="experience-topbar__left">
          <button class="experience-icon-button" :title="t('experience.back')" :aria-label="t('experience.back')" @click="router.push('/agent')">
            <ArrowLeft class="h-4 w-4" />
          </button>
          <div class="experience-brand">HomeRail</div>
          <div class="experience-topbar__divider" />
          <div class="experience-title-group">
            <div class="experience-title-line">
              <h1>{{ t('experience.title') }}</h1>
              <span>{{ t('experience.memory') }}</span>
            </div>
            <div class="experience-path-line" :title="graph?.graph_path || 'assets/run-experience-memory/db/graph.json'">
              <Database class="h-3.5 w-3.5" />
              <span>{{ graph?.graph_path || 'assets/run-experience-memory/db/graph.json' }}</span>
            </div>
          </div>
        </div>
        <div class="experience-topbar__metrics">
          <span>{{ t('experience.nodes', { shown: graph?.node_count ?? 0, total: graph?.total_node_count ?? 0 }) }}</span>
          <span>{{ t('experience.relationships', { shown: graph?.relationship_count ?? 0, total: graph?.total_relationship_count ?? 0 }) }}</span>
        </div>
      </header>

      <section class="experience-layout">
        <aside class="experience-panel experience-panel--filters">
          <div class="experience-panel__head">
            <div>
              <span>{{ t('experience.filter') }}</span>
              <h2>{{ t('experience.locate') }}</h2>
            </div>
            <Network class="h-4 w-4" />
          </div>

          <div class="experience-control-group">
            <label>{{ t('experience.search') }}</label>
            <div class="experience-search">
              <Search class="h-4 w-4" />
              <input v-model="searchText" :placeholder="t('experience.searchPlaceholder')" @keyup.enter="refreshGraph" />
            </div>
            <div class="experience-action-row">
              <button class="experience-primary-button" :disabled="loading" @click="refreshGraph">
                <RefreshCw class="h-4 w-4" :class="loading && 'animate-spin'" />
                {{ t('experience.refresh') }}
              </button>
              <button class="experience-icon-button experience-icon-button--soft" :title="t('experience.clearFilters')" :aria-label="t('experience.clearFilters')" @click="clearFilters">
                <XCircle class="h-4 w-4" />
              </button>
            </div>
          </div>

          <div class="experience-control-group">
            <div class="experience-filter-title">
              <div>
                <Filter class="h-4 w-4" />
                <span>{{ t('experience.nodeTypes') }}</span>
              </div>
              <button @click="selectedTypes = []">{{ t('experience.all') }}</button>
            </div>
            <button
              v-for="[type, count] in nodeTypeCounts"
              :key="type"
              class="experience-type-chip"
              :class="{ 'experience-type-chip--active': selectedTypes.includes(type) }"
              @click="toggleType(type)"
            >
              <span class="experience-type-chip__main">
                <i :style="{ background: nodeAccent(type) }" />
                <span>{{ type }}</span>
              </span>
              <em>{{ count }}</em>
            </button>
          </div>

          <div class="experience-control-group">
            <label>{{ t('experience.resultLimit') }}</label>
            <input v-model.number="resultLimit" class="experience-number-input" type="number" min="50" max="2000" step="50" />
            <label class="experience-checkbox">
              <input v-model="includeNeighbors" type="checkbox" />
              <span>{{ t('experience.includeNeighbors') }}</span>
            </label>
          </div>

          <div class="experience-stats">
            <div class="experience-stat">
              <b>{{ graph?.node_count ?? 0 }}</b>
              <span>shown nodes</span>
            </div>
            <div class="experience-stat">
              <b>{{ graph?.relationship_count ?? 0 }}</b>
              <span>shown edges</span>
            </div>
            <div class="experience-stat">
              <b>{{ graph?.total_node_count ?? 0 }}</b>
              <span>db nodes</span>
            </div>
            <div class="experience-stat">
              <b>{{ graph?.total_relationship_count ?? 0 }}</b>
              <span>db edges</span>
            </div>
          </div>
        </aside>

        <section class="experience-stage">
          <div v-if="error" class="experience-toast experience-toast--error">{{ error }}</div>
          <div v-if="graph && !graph.available" class="experience-toast experience-toast--warning">{{ graph.reason }}</div>
          <canvas
            v-if="canvasNodes.length"
            ref="canvasRef"
            class="experience-canvas"
            @dblclick="fitCanvasGraph"
            @pointercancel="onCanvasPointerUp"
            @pointerdown="onCanvasPointerDown"
            @pointerleave="hoverNodeId = null"
            @pointermove="onCanvasPointerMove"
            @pointerup="onCanvasPointerUp"
            @wheel="onCanvasWheel"
          />
          <div v-else class="experience-empty-state">
            <span>{{ t('experience.graph') }}</span>
            <h2>{{ loading ? t('experience.loading') : t('experience.empty') }}</h2>
            <p>{{ loading ? t('experience.loadingDescription') : t('experience.emptyDescription') }}</p>
          </div>
          <div class="experience-stage-toolbar">
            <div class="experience-stage-pill">{{ graphStatusLabel }}</div>
            <div class="experience-stage-pill">{{ updatedLabel }}</div>
          </div>
        </section>

        <aside class="experience-panel experience-panel--details">
          <div v-if="selectedNode" class="experience-details">
            <div class="experience-detail-head">
              <span>{{ selectedNode.type }}</span>
              <h2>{{ selectedNode.label || selectedNode.id }}</h2>
              <p v-if="selectedNode.summary">{{ selectedNode.summary }}</p>
            </div>

            <div class="experience-property-section">
              <h3>{{ t('experience.properties') }}</h3>
              <div class="experience-property-list">
                <div v-for="(value, key) in selectedNode.properties" :key="String(key)" class="experience-property">
                  <span>{{ key }}</span>
                  <pre>{{ propertyPreview(value) }}</pre>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="experience-detail-empty">{{ t('experience.selectNode') }}</div>
        </aside>
      </section>
    </div>
  </main>
</template>

<style scoped>
.experience-graph {
  position: relative;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  background: var(--hr-bg);
  color: var(--hr-text-1);
}

.experience-graph__ambient {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 18% 12%, var(--hr-accent-soft), transparent 32%),
    radial-gradient(circle at 80% 2%, var(--hr-success-soft), transparent 30%),
    linear-gradient(180deg, transparent, var(--hr-surface-1));
}

.experience-shell {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}

.experience-topbar {
  display: flex;
  min-height: 56px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  overflow: hidden;
  border: 1px solid var(--hr-border);
  border-radius: 9999px;
  background: var(--hr-panel);
  padding: 8px 12px;
  box-shadow: var(--hr-shadow-panel);
  backdrop-filter: blur(18px);
}

.experience-topbar__left,
.experience-topbar__metrics,
.experience-title-line,
.experience-path-line,
.experience-action-row,
.experience-filter-title,
.experience-filter-title div,
.experience-checkbox {
  display: flex;
  align-items: center;
}

.experience-topbar__left {
  min-width: 0;
  gap: 12px;
}

.experience-brand {
  flex: 0 0 auto;
  border: 1px solid var(--hr-border);
  border-radius: 9999px;
  background: var(--hr-surface-1);
  padding: 7px 10px;
  color: var(--hr-text-3);
  font-size: 11px;
  font-weight: 780;
  line-height: 1;
}

.experience-topbar__divider {
  width: 1px;
  height: 30px;
  flex: 0 0 auto;
  background: var(--hr-border);
}

.experience-title-group {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.experience-panel__head span,
.experience-detail-head span {
  color: var(--hr-text-3);
  font-size: 12px;
  font-weight: 650;
}

.experience-title-line {
  min-width: 0;
  gap: 9px;
}

.experience-title-line h1 {
  margin: 0;
  overflow: hidden;
  color: var(--hr-text-1);
  font-size: 15px;
  font-weight: 740;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-title-line span {
  flex: 0 0 auto;
  border: 1px solid var(--hr-accent-border);
  border-radius: 9999px;
  background: var(--hr-accent-soft);
  padding: 3px 7px;
  color: var(--hr-accent);
  font-size: 11px;
  font-weight: 720;
  line-height: 1;
}

.experience-path-line {
  min-width: 160px;
  max-width: min(46vw, 560px);
  gap: 6px;
  overflow: hidden;
  color: var(--hr-text-3);
  font-size: 11px;
  line-height: 1.2;
}

.experience-path-line span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-topbar__metrics {
  flex-shrink: 0;
  gap: 8px;
}

.experience-topbar__metrics span {
  border: 1px solid var(--hr-info-border);
  border-radius: 9999px;
  background: var(--hr-info-soft);
  padding: 6px 10px;
  color: var(--hr-info);
  font-size: 12px;
  font-weight: 650;
}

.experience-layout {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 292px minmax(0, 1fr) 360px;
  gap: 12px;
}

.experience-panel,
.experience-stage {
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--hr-border);
  border-radius: 24px;
  background: var(--hr-panel);
}

.experience-panel {
  display: flex;
  flex-direction: column;
  gap: 22px;
  overflow-y: auto;
  padding: 18px;
}

.experience-panel--filters {
  border-color: var(--hr-decorative-accent-border);
  background:
    radial-gradient(circle at 86% 0%, var(--hr-decorative-accent-soft), transparent 34%),
    var(--hr-panel);
}

.experience-panel--details {
  border-color: var(--hr-decorative-speaking-border);
  background:
    radial-gradient(circle at 86% 0%, var(--hr-decorative-speaking-soft), transparent 34%),
    var(--hr-panel);
}

.experience-panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.experience-panel__head h2,
.experience-detail-head h2 {
  margin: 5px 0 0;
  color: var(--hr-text-1);
  font-size: 20px;
  font-weight: 730;
  line-height: 1.2;
}

.experience-control-group {
  display: grid;
  gap: 10px;
}

.experience-control-group label {
  color: var(--hr-text-3);
  font-size: 12px;
  font-weight: 650;
}

.experience-search,
.experience-number-input {
  border: 1px solid var(--hr-border);
  border-radius: 14px;
  background: var(--hr-control);
}

.experience-search {
  display: flex;
  height: 42px;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  color: var(--hr-text-3);
}

.experience-search input,
.experience-number-input {
  min-width: 0;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--hr-text-1);
  font-size: 13px;
  outline: none;
}

.experience-search input::placeholder {
  color: var(--hr-text-4);
}

.experience-action-row {
  grid-template-columns: none;
  gap: 8px;
}

.experience-primary-button,
.experience-icon-button,
.experience-type-chip,
.experience-filter-title button {
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease, opacity 160ms ease;
}

.experience-primary-button {
  display: inline-flex;
  height: 38px;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--hr-accent-border);
  border-radius: 9999px;
  background: var(--hr-accent-soft);
  color: var(--hr-accent);
  font-size: 13px;
  font-weight: 720;
}

.experience-primary-button:hover:not(:disabled) {
  border-color: var(--hr-accent);
  background: var(--hr-control-hover);
}

.experience-primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.experience-icon-button {
  display: inline-flex;
  height: 40px;
  width: 40px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--hr-border);
  border-radius: 9999px;
  color: var(--hr-text-2);
}

.experience-icon-button:hover {
  border-color: var(--hr-accent-border);
  background: var(--hr-accent-soft);
  color: var(--hr-accent);
}

.experience-icon-button--soft {
  height: 38px;
  width: 48px;
}

.experience-filter-title {
  justify-content: space-between;
  gap: 10px;
}

.experience-filter-title div {
  gap: 8px;
  color: var(--hr-text-2);
  font-size: 13px;
  font-weight: 700;
}

.experience-filter-title button {
  border: 0;
  color: var(--hr-accent);
  font-size: 12px;
  font-weight: 700;
}

.experience-filter-title button:hover {
  color: var(--hr-accent-hover);
}

.experience-type-chip {
  display: flex;
  min-height: 36px;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--hr-border);
  border-radius: 12px;
  background: var(--hr-surface-1);
  padding: 8px 10px;
  text-align: left;
}

.experience-type-chip:hover {
  border-color: var(--hr-border-strong);
  background: var(--hr-surface-2);
}

.experience-type-chip--active {
  border-color: var(--hr-accent-border);
  background: var(--hr-accent-soft);
}

.experience-type-chip__main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.experience-type-chip__main i {
  display: block;
  height: 10px;
  width: 10px;
  flex: 0 0 auto;
  border-radius: 9999px;
  box-shadow: 0 0 16px currentColor;
}

.experience-type-chip__main span {
  min-width: 0;
  overflow: hidden;
  color: var(--hr-text-2);
  font-size: 13px;
  font-weight: 640;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-type-chip em {
  flex: 0 0 auto;
  color: var(--hr-text-3);
  font-size: 11px;
  font-style: normal;
  font-weight: 720;
}

.experience-number-input {
  height: 40px;
  padding: 0 12px;
}

.experience-checkbox {
  gap: 9px;
  color: var(--hr-text-2);
  font-size: 13px;
}

.experience-checkbox input {
  height: 15px;
  width: 15px;
  accent-color: var(--hr-accent);
}

.experience-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.experience-stat {
  border: 1px solid var(--hr-border);
  border-radius: 12px;
  background: var(--hr-surface-1);
  padding: 10px;
}

.experience-stat b {
  display: block;
  color: var(--hr-text-1);
  font-size: 18px;
  font-weight: 760;
  line-height: 1.1;
}

.experience-stat span {
  display: block;
  margin-top: 3px;
  color: var(--hr-text-3);
  font-size: 11px;
  font-weight: 650;
}

.experience-stage {
  position: relative;
  background:
    linear-gradient(var(--hr-border) 1px, transparent 1px),
    linear-gradient(90deg, var(--hr-border) 1px, transparent 1px),
    radial-gradient(circle at 50% 30%, var(--hr-decorative-accent-soft), transparent 34%),
    var(--hr-surface-1);
  background-size: 28px 28px, 28px 28px, auto, auto;
}

.experience-canvas {
  display: block;
  height: 100%;
  width: 100%;
  cursor: grab;
  touch-action: none;
}

.experience-canvas:active {
  cursor: grabbing;
}

.experience-stage-toolbar {
  position: absolute;
  right: 18px;
  bottom: 18px;
  left: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  pointer-events: none;
}

.experience-stage-pill {
  max-width: min(48%, 520px);
  overflow: hidden;
  border: 1px solid var(--hr-border);
  border-radius: 9999px;
  background: var(--hr-panel);
  padding: 8px 11px;
  color: var(--hr-text-3);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(14px);
}

.experience-toast {
  position: absolute;
  left: 18px;
  top: 18px;
  z-index: 10;
  max-width: min(520px, calc(100% - 36px));
  border-radius: 9999px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 650;
  backdrop-filter: blur(14px);
}

.experience-toast--error {
  border: 1px solid var(--hr-danger-border);
  background: var(--hr-danger-soft);
  color: var(--hr-danger);
}

.experience-toast--warning {
  border: 1px solid var(--hr-warning-border);
  background: var(--hr-warning-soft);
  color: var(--hr-warning);
}

.experience-empty-state {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  justify-content: center;
  padding: 44px;
}

.experience-empty-state span {
  color: var(--hr-accent);
  font-size: 12px;
  font-weight: 680;
}

.experience-empty-state h2 {
  margin: 12px 0 0;
  color: var(--hr-text-1);
  font-size: 32px;
  font-weight: 730;
  line-height: 1.16;
}

.experience-empty-state p {
  margin: 14px 0 0;
  max-width: 520px;
  color: var(--hr-text-3);
  font-size: 15px;
  line-height: 1.7;
}

.experience-details {
  display: grid;
  gap: 22px;
}

.experience-detail-head h2 {
  overflow-wrap: anywhere;
}

.experience-detail-head p {
  margin: 12px 0 0;
  color: var(--hr-text-2);
  font-size: 14px;
  line-height: 1.55;
}

.experience-property-section h3 {
  margin: 0;
  color: var(--hr-text-1);
  font-size: 14px;
  font-weight: 710;
}

.experience-property-list {
  display: grid;
  gap: 9px;
  margin-top: 12px;
}

.experience-property {
  overflow: hidden;
  border: 1px solid var(--hr-border);
  border-radius: 12px;
  background: var(--hr-code-bg);
  padding: 11px;
}

.experience-property span {
  display: block;
  overflow: hidden;
  color: var(--hr-text-3);
  font-size: 11px;
  font-weight: 720;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-property pre {
  max-height: 170px;
  margin: 6px 0 0;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--hr-text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}

.experience-detail-empty {
  color: var(--hr-text-4);
  font-size: 14px;
  line-height: 1.6;
}

@media (max-width: 1240px) {
  .experience-shell {
    padding: 12px;
  }

  .experience-layout {
    grid-template-columns: 270px minmax(0, 1fr);
  }

  .experience-panel--details {
    grid-column: 1 / -1;
    min-height: 240px;
  }
}

@media (max-width: 820px) {
  .experience-graph {
    overflow: auto;
  }

  .experience-shell {
    min-height: 100dvh;
    height: auto;
  }

  .experience-topbar {
    align-items: flex-start;
    border-radius: 24px;
  }

  .experience-topbar,
  .experience-topbar__left {
    flex-wrap: wrap;
  }

  .experience-path-line {
    max-width: 100%;
  }

  .experience-layout {
    grid-template-columns: minmax(0, 1fr);
    overflow: visible;
  }

  .experience-stage {
    min-height: 560px;
  }
}
</style>

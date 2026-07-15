<script setup lang="ts">
/**
 * DagRuntimeCanvas — 全屏 Canvas 力导向 DAG 可视化。
 *
 * 物理模型与交互参考 ExperienceGraphExplorer（中心引力 / 节点斥力 /
 * 边弹簧 / 阻尼 / 能量衰减 / pan / zoom / 拖拽 / hover / 选中），
 * 节点视觉替换为 DAG 节点：agent 角色色填充 + 状态光晕 + 工具调用 /
 * 失败 / token 徽章；边在 active 时叠加沿边流动的数据粒子。
 *
 * 数据源：useAgentStore 的 nodes/edges（实时 WS）+ useDagRuntime 的 metrics。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent-store'
import { getAgentPersona, fmtTokens } from '@/lib/agentPersonas'
import type { DAGNodeMetrics, DAGRunMetrics } from '@/api/types/dag.types'
import type { DAGTaskNode, DAGEdge } from '@/api/types/dag.types'

interface RuntimeNode {
  id: string
  label: string
  agentName: string
  status: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  metrics?: DAGNodeMetrics
}

interface CanvasPoint { x: number; y: number }

const props = defineProps<{
  metrics: DAGRunMetrics | null
  focusedNodeId: string | null
  selectedNodeId: string | null
}>()

const emit = defineEmits<{
  'select-node': [nodeId: string | null]
  'focus-node': [nodeId: string | null]
}>()

const store = useAgentStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const canvasNodes = ref<RuntimeNode[]>([])
const canvasEdges = ref<DAGEdge[]>([])

const selectedNodeId = computed(() => props.selectedNodeId)
const focusedNodeId = computed(() => props.focusedNodeId)
const hoverNodeId = ref<string | null>(null)

let nodeById = new Map<string, RuntimeNode>()
let rafId = 0
let zoom = 1
let panX = 0
let panY = 0
let dragNode: RuntimeNode | null = null
let panDrag: CanvasPoint | null = null
let layoutEnergy = 0
let layoutCenterX = 0
let layoutCenterY = 0
// 数据流动粒子：每条 active 边一个沿边运动的进度 0..1
const edgeFlow = new Map<string, number>()
let flowTick = 0

// ============================================================================
// 状态 → 视觉
// ============================================================================

function statusGlow(status: string): { color: string; pulse: boolean } {
  switch (status) {
    case 'running': return { color: '52, 211, 153', pulse: true }
    case 'waiting_for_command': return { color: '251, 191, 36', pulse: false }
    case 'completed': return { color: '96, 165, 250', pulse: false }
    case 'failed': return { color: '248, 113, 113', pulse: false }
    case 'ready': return { color: '147, 197, 253', pulse: false }
    case 'skipped': return { color: '251, 191, 36', pulse: false }
    default: return { color: '148, 163, 184', pulse: false }
  }
}

function nodeRadius(node: DAGTaskNode, metrics?: DAGNodeMetrics): number {
  // 基础半径 28（触摸目标 ≥44px 直径），按 token 消耗适度放大（对数缩放）
  const base = 28
  if (!metrics?.tokens) return base
  const total = metrics.tokens.input + metrics.tokens.output + metrics.tokens.cache_read
  if (total <= 0) return base
  return Math.min(38, base + Math.log2(total / 1000 + 1) * 2.5)
}

// ============================================================================
// 图构建（store.nodes/edges + metrics → RuntimeNode[]）
// ============================================================================

/** 计算每个节点的拓扑深度（列号）。
 *  无入边的节点（DAG 起点，如 plan）depth=0，沿后继方向递增。
 *  用于初始从左到右排列；对回环节点用 max(前驱)+1 兜底。 */
function computeTopoDepth(nodeIds: string[], edges: { source: string; target: string }[]): Map<string, number> {
  const depth = new Map<string, number>()
  // 入边表：target → [source,...]
  const incoming = new Map<string, string[]>()
  for (const id of nodeIds) incoming.set(id, [])
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target)!.push(e.source)
  }
  // 出边表：source → [target,...]
  const outgoing = new Map<string, string[]>()
  for (const id of nodeIds) outgoing.set(id, [])
  for (const e of edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    outgoing.get(e.source)!.push(e.target)
  }

  // Kahn：入度为 0 的起点 depth=0，逐层推进
  const inDegree = new Map<string, number>()
  for (const id of nodeIds) inDegree.set(id, incoming.get(id)!.length)
  const queue: string[] = nodeIds.filter(id => inDegree.get(id) === 0)
  for (const id of queue) depth.set(id, 0)

  let processed = queue.length
  while (queue.length) {
    const cur = queue.shift()!
    const curDepth = depth.get(cur) ?? 0
    for (const next of outgoing.get(cur) ?? []) {
      // 后继深度 = max(已有, 当前+1)
      depth.set(next, Math.max(depth.get(next) ?? 0, curDepth + 1))
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1)
      if (inDegree.get(next) === 0) queue.push(next)
      processed++
    }
  }
  // 兜底：环或孤立节点（Kahn 没覆盖的）按前驱 max+1 或 0
  for (const id of nodeIds) {
    if (!depth.has(id)) {
      const preds = incoming.get(id) ?? []
      depth.set(id, preds.length ? Math.max(...preds.map(p => depth.get(p) ?? 0)) + 1 : 0)
    }
  }
  return depth
}

function rebuildGraph(fit = false): void {
  const storeNodes = store.nodes
  const storeEdges = store.edges
  const metricsMap = props.metrics?.nodes ?? {}
  const previous = new Map(canvasNodes.value.map(n => [n.id, n]))

  if (!storeNodes.length) {
    canvasNodes.value = []
    canvasEdges.value = []
    nodeById = new Map()
    return
  }

  const rect = canvasRef.value?.getBoundingClientRect()
  const centerX = rect ? rect.width / 2 : 0
  const centerY = rect ? rect.height / 2 : 0

  // 按拓扑深度分列：depth=0 的节点（无入边，如 plan）在最左，
  // depth 沿后继方向递增。这样初始位置就形成从左到右的布局，
  // 力导向只需消除重叠，不会把节点打散成螺旋。
  const depthMap = computeTopoDepth(storeNodes.map(n => n.id), storeEdges)
  const COLUMN_WIDTH = 220
  const ROW_HEIGHT = 130
  // 每列已放置的节点数，用于同列竖向错开
  const placedPerDepth = new Map<number, number>()
  const maxDepth = Math.max(0, ...depthMap.values())

  const nodes = storeNodes.map((node) => {
    const old = previous.get(node.id)
    const depth = depthMap.get(node.id) ?? 0
    // 居中整列：以 centerX 为中线左右展开
    const colX = centerX + (depth - maxDepth / 2) * COLUMN_WIDTH
    // 同列节点竖向交替错开，避免完全重叠
    const placed = placedPerDepth.get(depth) ?? 0
    placedPerDepth.set(depth, placed + 1)
    const sameDepthCount = storeNodes.filter(n => (depthMap.get(n.id) ?? 0) === depth).length
    const yOffset = sameDepthCount > 1
      ? (placed - (sameDepthCount - 1) / 2) * ROW_HEIGHT
      : 0
    const m = metricsMap[node.id]
    return {
      id: node.id,
      label: node.name,
      agentName: node.agent_name,
      status: node.status,
      x: old?.x ?? colX,
      y: old?.y ?? centerY + yOffset,
      vx: old?.vx ?? 0,
      vy: old?.vy ?? 0,
      r: nodeRadius(node, m),
      metrics: m,
    }
  })

  canvasNodes.value = nodes
  nodeById = new Map(nodes.map(n => [n.id, n]))
  canvasEdges.value = storeEdges.filter(e => nodeById.has(e.source) && nodeById.has(e.target))
  setLayoutCenter()
  wakeLayout()
  if (fit) {
    void nextTick(() => {
      resizeCanvas()
      fitCanvasGraph()
    })
  }
}

function setLayoutCenter(): void {
  const nodes = canvasNodes.value
  if (!nodes.length) {
    const rect = canvasRef.value?.getBoundingClientRect()
    layoutCenterX = rect ? rect.width / 2 : 0
    layoutCenterY = rect ? rect.height / 2 : 0
    return
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y)
  }
  layoutCenterX = (minX + maxX) / 2
  layoutCenterY = (minY + maxY) / 2
}

function wakeLayout(): void { layoutEnergy = 1 }
function freezeLayout(): void {
  layoutEnergy = 0
  for (const n of canvasNodes.value) { n.vx = 0; n.vy = 0 }
}

// ============================================================================
// 物理模拟（中心引力 + 节点斥力 + 边弹簧 + 阻尼）
// ============================================================================

function tickLayout(): void {
  const nodes = canvasNodes.value
  if (layoutEnergy <= 0 || panDrag || dragNode || nodes.length === 0) return

  for (const n of nodes) {
    n.vx += (layoutCenterX - n.x) * 0.0004 * layoutEnergy
    n.vy += (layoutCenterY - n.y) * 0.0004 * layoutEnergy
  }

  const repulsion = Math.max(10, 340 / Math.max(1, Math.sqrt(nodes.length)))
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const d2 = Math.max(120, dx * dx + dy * dy)
      const force = (repulsion / d2) * layoutEnergy
      a.vx -= dx * force; a.vy -= dy * force
      b.vx += dx * force; b.vy += dy * force
    }
  }

  for (const edge of canvasEdges.value) {
    const a = nodeById.get(edge.source), b = nodeById.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const target = 150
    const force = (dist - target) * 0.009 * layoutEnergy
    const fx = (dx / dist) * force, fy = (dy / dist) * force
    a.vx += fx; a.vy += fy
    b.vx -= fx; b.vy -= fy
  }

  let maxVelocity = 0
  for (const n of nodes) {
    if (n === dragNode) continue
    n.vx *= 0.78; n.vy *= 0.78
    maxVelocity = Math.max(maxVelocity, Math.hypot(n.vx, n.vy))
    n.x += n.vx; n.y += n.vy
  }
  layoutEnergy = maxVelocity < 0.03 ? 0 : layoutEnergy * 0.985
}

// ============================================================================
// 渲染
// ============================================================================

function drawGraph(): void {
  tickLayout()
  flowTick += 1
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
  for (let i = 0; i < canvasEdges.value.length; i++) {
    const edge = canvasEdges.value[i]
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) continue
    const active = selectedNodeId.value === edge.source || selectedNodeId.value === edge.target
    const targetRunning = target.status === 'running'
    const edgeKey = `${edge.source}->${edge.target}`

    // 主边线
    ctx.strokeStyle = targetRunning
      ? 'rgba(52, 211, 153, 0.55)'
      : active ? 'rgba(103, 232, 249, 0.5)' : 'rgba(148, 163, 184, 0.22)'
    ctx.lineWidth = targetRunning ? 2 : active ? 1.8 : 1.1
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()

    // 箭头
    drawArrowHead(ctx, source.x, source.y, target.x, target.y, target.r)

    // 数据流动粒子（目标 running 时，沿边运动的发光点）
    if (targetRunning) {
      const phase = ((flowTick * 0.012) + (i * 0.31)) % 1
      const px = source.x + (target.x - source.x) * phase
      const py = source.y + (target.y - source.y) * phase
      ctx.shadowColor = 'rgba(52, 211, 153, 0.9)'
      ctx.shadowBlur = 12
      ctx.fillStyle = 'rgba(167, 243, 208, 0.95)'
      ctx.beginPath()
      ctx.arc(px, py, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }
  }
}

function drawArrowHead(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number, targetR: number): void {
  const dx = toX - fromX, dy = toY - fromY
  const dist = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / dist, uy = dy / dist
  // 箭头落在目标节点边缘
  const tipX = toX - ux * (targetR + 4)
  const tipY = toY - uy * (targetR + 4)
  const size = 7
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)'
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5)
  ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5)
  ctx.closePath()
  ctx.fill()
}

function drawNodes(ctx: CanvasRenderingContext2D): void {
  const pulse = 0.5 + 0.5 * Math.sin(flowTick * 0.08)
  for (const node of canvasNodes.value) {
    const persona = getAgentPersona(node.agentName)
    const glow = statusGlow(node.status)
    const active = selectedNodeId.value === node.id
    const focused = focusedNodeId.value === node.id
    const hovering = hoverNodeId.value === node.id
    // 焦点节点轻微放大（手柄导航反馈）
    const renderR = focused ? node.r * 1.12 : node.r

    // 焦点外圈脉冲环（青色，手柄/键盘导航的醒目标记）
    if (focused) {
      ctx.strokeStyle = `rgba(103, 232, 249, ${0.35 + pulse * 0.35})`
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(node.x, node.y, renderR + 7 + pulse * 3, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 外层光晕（running 时脉冲呼吸）
    if (glow.pulse) {
      ctx.shadowColor = `rgba(${glow.color}, ${0.4 + pulse * 0.4})`
      ctx.shadowBlur = 18 + pulse * 14
    } else {
      ctx.shadowColor = `rgba(${glow.color}, ${active || focused ? 0.5 : 0.22})`
      ctx.shadowBlur = active || focused ? 22 : 10
    }

    // 主圆（agent 角色色）
    ctx.fillStyle = persona.color
    ctx.beginPath()
    ctx.arc(node.x, node.y, renderR, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0

    // 状态描边
    ctx.lineWidth = active || focused || hovering ? 3 : 1.6
    ctx.strokeStyle = active
      ? 'rgba(236, 254, 255, 0.96)'
      : focused
        ? 'rgba(103, 232, 249, 0.95)'
        : `rgba(${glow.color}, 0.85)`
    ctx.stroke()

    if (zoom < 0.45) continue

    // 节点中心：agent 名首字
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(persona.name.slice(0, 1), node.x, node.y - 1)

    // 节点下方：标签
    if (zoom > 0.5) {
      ctx.fillStyle = active ? 'rgba(236, 254, 255, 0.92)' : 'rgba(226, 232, 240, 0.72)'
      ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif'
      ctx.fillText(persona.name, node.x, node.y + node.r + 14)
    }

    // 徽章组（右上角）：工具调用 / 失败 / token
    if (zoom > 0.6 && node.metrics) {
      drawBadges(ctx, node)
    }
  }
}

function drawBadges(ctx: CanvasRenderingContext2D, node: RuntimeNode): void {
  const m = node.metrics!
  const badges: Array<{ text: string; color: string }> = []
  if (m.tool_calls > 0) {
    badges.push({ text: `🔧${m.tool_calls}`, color: 'rgba(147, 197, 253, 0.92)' })
  }
  if (m.tool_failures > 0) {
    badges.push({ text: `✗${m.tool_failures}`, color: 'rgba(248, 113, 113, 0.95)' })
  }
  if (m.tokens) {
    const total = m.tokens.input + m.tokens.output + m.tokens.cache_read
    if (total > 0) {
      badges.push({ text: fmtTokens(total), color: 'rgba(167, 243, 208, 0.92)' })
    }
  }
  if (!badges.length) return

  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let bx = node.x + node.r * 0.5
  let by = node.y - node.r - 10
  for (const badge of badges) {
    const w = ctx.measureText(badge.text).width + 12
    // 胶囊背景
    ctx.fillStyle = 'rgba(9, 11, 13, 0.85)'
    roundRect(ctx, bx, by - 8, w, 16, 8)
    ctx.fill()
    ctx.strokeStyle = badge.color
    ctx.lineWidth = 0.8
    roundRect(ctx, bx, by - 8, w, 16, 8)
    ctx.stroke()
    ctx.fillStyle = badge.color
    ctx.fillText(badge.text, bx + 6, by)
    bx += w + 4
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ============================================================================
// Canvas 尺寸与视口
// ============================================================================

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

function fitCanvasGraph(): void {
  const nodes = canvasNodes.value
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!nodes.length || !rect) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r)
    maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r)
  }
  const pad = 80
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2
  zoom = Math.min(1.2, Math.min(rect.width / w, rect.height / h))
  panX = rect.width / 2 - ((minX + maxX) / 2) * zoom
  panY = rect.height / 2 - ((minY + maxY) / 2) * zoom
}

// ============================================================================
// 交互：pan / zoom / 拖拽 / 点击 / hover
// ============================================================================

function canvasPoint(evt: MouseEvent): CanvasPoint {
  const rect = canvasRef.value!.getBoundingClientRect()
  return {
    x: (evt.clientX - rect.left - panX) / zoom,
    y: (evt.clientY - rect.top - panY) / zoom,
  }
}

function nodeAt(point: CanvasPoint): RuntimeNode | null {
  for (const n of canvasNodes.value) {
    if (Math.hypot(n.x - point.x, n.y - point.y) <= n.r + 4) return n
  }
  return null
}

function onMouseDown(evt: MouseEvent): void {
  const point = canvasPoint(evt)
  const hit = nodeAt(point)
  if (hit) {
    dragNode = hit
  } else {
    panDrag = { x: evt.clientX - panX, y: evt.clientY - panY }
  }
}

function onMouseMove(evt: MouseEvent): void {
  if (dragNode) {
    const point = canvasPoint(evt)
    dragNode.x = point.x
    dragNode.y = point.y
    dragNode.vx = 0
    dragNode.vy = 0
    wakeLayout()
    return
  }
  if (panDrag) {
    panX = evt.clientX - panDrag.x
    panY = evt.clientY - panDrag.y
    return
  }
  const point = canvasPoint(evt)
  const hit = nodeAt(point)
  const newHover = hit?.id ?? null
  if (newHover !== hoverNodeId.value) {
    hoverNodeId.value = newHover
    if (canvasRef.value) {
      canvasRef.value.style.cursor = hit ? 'pointer' : 'grab'
    }
  }
}

function onMouseUp(evt: MouseEvent): void {
  // 点击（未拖动）→ 焦点 + 选中
  if (dragNode) {
    const point = canvasPoint(evt)
    const moved = Math.hypot(dragNode.x - point.x, dragNode.y - point.y)
    if (moved < 2) {
      // 点击同一节点：选中它（同时设焦点）
      emit('focus-node', dragNode.id)
      const newId = selectedNodeId.value === dragNode.id ? null : dragNode.id
      emit('select-node', newId)
    }
    dragNode = null
    return
  }
  if (panDrag) {
    panDrag = null
    return
  }
  // 空白点击 → 取消选中
  const point = canvasPoint(evt)
  if (!nodeAt(point) && selectedNodeId.value) {
    emit('select-node', null)
  }
}

function onWheel(evt: WheelEvent): void {
  evt.preventDefault()
  const rect = canvasRef.value!.getBoundingClientRect()
  const mx = evt.clientX - rect.left
  const my = evt.clientY - rect.top
  const delta = evt.deltaY > 0 ? 0.88 : 1.14
  const newZoom = Math.max(0.2, Math.min(2.5, zoom * delta))
  // 以鼠标为中心缩放
  panX = mx - (mx - panX) * (newZoom / zoom)
  panY = my - (my - panY) * (newZoom / zoom)
  zoom = newZoom
}

// ============================================================================
// 生命周期
// ============================================================================

watch(
  () => [store.nodes, store.edges, props.metrics],
  () => { rebuildGraph(false) },
  { deep: true },
)

onMounted(() => {
  rebuildGraph(true)
  resizeCanvas()
  rafId = requestAnimationFrame(drawGraph)
  window.addEventListener('resize', resizeCanvas)
})

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  window.removeEventListener('resize', resizeCanvas)
})

// setFocus: 焦点由 prop 驱动（focusedNodeId），此方法保留为兼容入口
function setFocus(_nodeId: string | null): void {
  /* no-op: focus is prop-driven */
}

// 手柄连续控制：左摇杆 pan
function applyPan(dx: number, dy: number): void {
  panX += dx
  panY += dy
}

// 手柄连续控制：L2/R2 zoom（以画布屏幕中心为锚点，符合直觉）
function applyZoom(delta: number): void {
  const newZoom = Math.max(0.2, Math.min(2.5, zoom + delta))
  if (newZoom === zoom) return
  // 以屏幕中心 (cx, cy) 为锚点缩放：保持该点对应的世界坐标不变。
  // 数学同 onWheel，只是锚点固定为画布中心而非鼠标位置。
  const rect = canvasRef.value?.getBoundingClientRect()
  const cx = rect ? rect.width / 2 : 0
  const cy = rect ? rect.height / 2 : 0
  const scale = newZoom / zoom
  panX = cx - (cx - panX) * scale
  panY = cy - (cy - panY) * scale
  zoom = newZoom
}

defineExpose({ fitCanvasGraph, freezeLayout, wakeLayout, setFocus, applyPan, applyZoom })
</script>

<template>
  <canvas
    ref="canvasRef"
    class="dag-runtime-canvas absolute inset-0 h-full w-full"
    style="cursor: grab"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="panDrag = null; dragNode = null"
    @wheel="onWheel"
  />
</template>

<style scoped>
.dag-runtime-canvas {
  display: block;
  touch-action: none;
}
</style>

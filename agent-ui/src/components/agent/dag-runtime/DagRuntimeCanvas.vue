<script setup lang="ts">
/**
 * DagRuntimeCanvas — 全屏 Canvas 分层 DAG 可视化。
 *
 * Dagre 负责稳定的从左到右分层，完整节点视觉边界参与布局；Canvas
 * 保留阻尼缓动 / pan / zoom / 拖拽 / hover / 选中。节点视觉使用 agent
 * 角色色填充 + 状态光晕 + 工具调用 / 失败 / token 徽章；边在 active
 * 时叠加沿边流动的数据粒子。
 *
 * 数据源：useAgentStore 的 nodes/edges（实时 WS）+ useDagRuntime 的 metrics。
 */

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent-store'
import { getAgentPersona, fmtTokens } from '@/lib/agentPersonas'
import type { DAGNodeMetrics, DAGRunMetrics } from '@/api/types/dag.types'
import type { DAGTaskNode, DAGEdge } from '@/api/types/dag.types'
import {
  observeCanvasAppearance,
  readCanvasAppearancePalette,
  type CanvasAppearancePalette,
} from '@/appearance/canvas-appearance'
import { isDagCanvasClick, pinDagCanvasNode } from './dagRuntimeInteraction'
import { dedupeDagRuntimeEdges, layoutDagRuntimeGraph } from './dagRuntimeLayout'

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
  targetX: number
  targetY: number
  layoutWidth: number
  layoutHeight: number
  manuallyPositioned: boolean
  metrics?: DAGNodeMetrics
}

interface CanvasPoint { x: number; y: number }

const props = defineProps<{
  metrics: DAGRunMetrics | null
  focusedNodeId: string | null
  selectedNodeId: string | null
  reducedMotion?: boolean
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
let dragStart: CanvasPoint | null = null
let dragOffset: CanvasPoint | null = null
let dragMoved = false
let panDrag: CanvasPoint | null = null
let layoutEnergy = 0
let layoutFrozen = false
let metricsFitComplete = false
let flowTick = 0
let stopObservingAppearance: (() => void) | null = null
let canvasPalette: CanvasAppearancePalette = readCanvasAppearancePalette()

function refreshCanvasPalette(): void {
  canvasPalette = readCanvasAppearancePalette()
}

// ============================================================================
// 状态 → 视觉
// ============================================================================

function statusGlow(status: string): { color: string; pulse: boolean } {
  switch (status) {
    case 'running': return { color: canvasPalette.success, pulse: true }
    case 'waiting_for_command': return { color: canvasPalette.warning, pulse: false }
    case 'completed': return { color: canvasPalette.info, pulse: false }
    case 'failed': return { color: canvasPalette.danger, pulse: false }
    case 'ready': return { color: canvasPalette.info, pulse: false }
    case 'skipped': return { color: canvasPalette.warning, pulse: false }
    default: return { color: canvasPalette.text2, pulse: false }
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

function badgeTexts(metrics?: DAGNodeMetrics): string[] {
  if (!metrics) return []
  const badges: string[] = []
  if (metrics.tool_calls > 0) badges.push(`🔧${metrics.tool_calls}`)
  if (metrics.tool_failures > 0) badges.push(`✗${metrics.tool_failures}`)
  if (metrics.tokens) {
    const total = metrics.tokens.input + metrics.tokens.output + metrics.tokens.cache_read
    if (total > 0) badges.push(fmtTokens(total))
  }
  return badges
}

function measuredTextWidth(
  ctx: CanvasRenderingContext2D | null | undefined,
  text: string,
  font: string,
): number {
  if (!ctx) return text.length * 7
  ctx.save()
  ctx.font = font
  const width = ctx.measureText(text).width
  ctx.restore()
  return width
}

function nodeVisualSize(
  agentName: string,
  radius: number,
  metrics: DAGNodeMetrics | undefined,
  ctx: CanvasRenderingContext2D | null | undefined,
): { width: number; height: number } {
  const label = getAgentPersona(agentName).name
  const labelWidth = measuredTextWidth(ctx, label, '600 11px Inter, ui-sans-serif, system-ui, sans-serif')
  const badges = badgeTexts(metrics)
  const badgeWidth = badges.reduce((total, badge, index) => (
    total
    + measuredTextWidth(ctx, badge, '600 11px ui-monospace, SFMono-Regular, Menlo, monospace')
    + 12
    + (index > 0 ? 4 : 0)
  ), 0)

  // 徽章组在节点上方居中，完整边界仍参与布局，但不会因为右侧徽章
  // 被镜像成双倍空白，从而在复杂 DAG 中制造过宽的列间距。
  const horizontalReach = Math.max(radius + 8, labelWidth / 2 + 8, badgeWidth / 2 + 8)
  return {
    width: Math.max(88, horizontalReach * 2),
    height: Math.max(92, (radius + 21) * 2),
  }
}

// ============================================================================
// 图构建（store.nodes/edges + metrics → RuntimeNode[]）
// ============================================================================

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
  const ctx = canvasRef.value?.getContext('2d')
  const nodeIds = new Set(storeNodes.map(node => node.id))
  const validEdges = storeEdges.filter(edge => (
    nodeIds.has(edge.source) && nodeIds.has(edge.target)
  ))
  const displayEdges = dedupeDagRuntimeEdges(validEdges)

  const drafts = storeNodes.map((node) => {
    const old = previous.get(node.id)
    const m = metricsMap[node.id]
    const radius = nodeRadius(node, m)
    const visualSize = nodeVisualSize(node.agent_name, radius, m, ctx)
    return {
      id: node.id,
      label: node.name,
      agentName: node.agent_name,
      status: node.status,
      x: old?.x ?? centerX,
      y: old?.y ?? centerY,
      vx: old?.vx ?? 0,
      vy: old?.vy ?? 0,
      r: radius,
      targetX: old?.targetX ?? centerX,
      targetY: old?.targetY ?? centerY,
      layoutWidth: visualSize.width,
      layoutHeight: visualSize.height,
      manuallyPositioned: old?.manuallyPositioned ?? false,
      metrics: m,
    }
  })

  const positions = layoutDagRuntimeGraph(
    drafts.map(node => ({ id: node.id, width: node.layoutWidth, height: node.layoutHeight })),
    displayEdges,
  )
  const nodes = drafts.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 }
    // Metrics and status refreshes rebuild the runtime graph frequently. Once
    // a user has moved a node, retain that manual anchor instead of replacing
    // it with the freshly calculated Dagre position.
    if (!node.manuallyPositioned) {
      node.targetX = centerX + position.x
      node.targetY = centerY + position.y
    }
    if (!previous.has(node.id)) {
      node.x = node.targetX
      node.y = node.targetY
    }
    return node
  })

  canvasNodes.value = nodes
  nodeById = new Map(nodes.map(n => [n.id, n]))
  canvasEdges.value = displayEdges
  scheduleLayout()
  if (fit) {
    if (props.metrics) metricsFitComplete = true
    void nextTick(() => {
      resizeCanvas()
      fitCanvasGraph(true)
    })
  }
}

function scheduleLayout(): void {
  if (!layoutFrozen) layoutEnergy = 1
}

function wakeLayout(): void {
  layoutFrozen = false
  layoutEnergy = 1
}

function freezeLayout(): void {
  layoutFrozen = true
  layoutEnergy = 0
  for (const n of canvasNodes.value) { n.vx = 0; n.vy = 0 }
}

// ============================================================================
// 布局动画（Dagre 锚点 + 完整视觉边界碰撞 + 阻尼）
// ============================================================================

function tickLayout(): void {
  const nodes = canvasNodes.value
  if (layoutFrozen || layoutEnergy <= 0 || panDrag || dragNode || nodes.length === 0) return

  for (const n of nodes) {
    if (n.manuallyPositioned) continue
    n.vx += (n.targetX - n.x) * 0.045 * layoutEnergy
    n.vy += (n.targetY - n.y) * 0.045 * layoutEnergy
  }

  // 动画途中或手动拖拽后也不允许完整视觉包围盒互相穿透。
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i], b = nodes[j]
      // A manually placed node is an explicit user override. Do not let the
      // automatic collision pass move it (or endlessly fight its anchor).
      if (a.manuallyPositioned || b.manuallyPositioned) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const overlapX = (a.layoutWidth + b.layoutWidth) / 2 - Math.abs(dx)
      const overlapY = (a.layoutHeight + b.layoutHeight) / 2 - Math.abs(dy)
      if (overlapX <= 0 || overlapY <= 0) continue

      if (overlapX < overlapY) {
        const direction = dx === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dx)
        const impulse = overlapX * 0.08 * layoutEnergy
        a.vx -= direction * impulse
        b.vx += direction * impulse
      } else {
        const direction = dy === 0 ? (a.id < b.id ? 1 : -1) : Math.sign(dy)
        const impulse = overlapY * 0.08 * layoutEnergy
        a.vy -= direction * impulse
        b.vy += direction * impulse
      }
    }
  }

  let maxVelocity = 0
  let maxDistance = 0
  for (const n of nodes) {
    if (n === dragNode || n.manuallyPositioned) continue
    n.vx *= 0.72; n.vy *= 0.72
    maxVelocity = Math.max(maxVelocity, Math.hypot(n.vx, n.vy))
    n.x += n.vx; n.y += n.vy
    maxDistance = Math.max(maxDistance, Math.hypot(n.targetX - n.x, n.targetY - n.y))
  }
  if (maxVelocity < 0.02 && maxDistance < 0.25) {
    for (const n of nodes) {
      if (n.manuallyPositioned) continue
      n.x = n.targetX
      n.y = n.targetY
      n.vx = 0
      n.vy = 0
    }
    layoutEnergy = 0
  }
}

// ============================================================================
// 渲染
// ============================================================================

function drawGraph(): void {
  tickLayout()
  if (!props.reducedMotion) flowTick += 1
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

    // Canvas 不能直接解析 CSS var，因此在 appearance 变化时读取语义令牌。
    ctx.strokeStyle = targetRunning
      ? canvasPalette.successBorder
      : active ? canvasPalette.accentBorder : canvasPalette.borderStrong
    ctx.lineWidth = targetRunning ? 2 : active ? 1.8 : 1.1
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()

    // 箭头
    drawArrowHead(ctx, source.x, source.y, target.x, target.y, target.r)

    // 数据流动粒子（目标 running 时，沿边运动的发光点）
    if (targetRunning && !props.reducedMotion) {
      const phase = ((flowTick * 0.012) + (i * 0.31)) % 1
      const px = source.x + (target.x - source.x) * phase
      const py = source.y + (target.y - source.y) * phase
      ctx.shadowColor = canvasPalette.success
      ctx.shadowBlur = 12
      ctx.fillStyle = canvasPalette.success
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
  ctx.fillStyle = canvasPalette.text2
  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5)
  ctx.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5)
  ctx.closePath()
  ctx.fill()
}

function drawNodes(ctx: CanvasRenderingContext2D): void {
  const pulse = props.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(flowTick * 0.08)
  for (const node of canvasNodes.value) {
    const persona = getAgentPersona(node.agentName)
    const glow = statusGlow(node.status)
    const active = selectedNodeId.value === node.id
    const focused = focusedNodeId.value === node.id
    const hovering = hoverNodeId.value === node.id
    // 焦点节点轻微放大（手柄导航反馈）
    const renderR = focused ? node.r * 1.12 : node.r

    // 焦点外圈脉冲环（accent 色，手柄/键盘导航的醒目标记）
    if (focused) {
      ctx.strokeStyle = canvasPalette.focusRing
      ctx.globalAlpha = 0.7 + pulse * 0.3
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(node.x, node.y, renderR + 7 + pulse * 3, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // 外层光晕（running 时脉冲呼吸）
    if (glow.pulse) {
      ctx.shadowColor = glow.color
      ctx.shadowBlur = 18 + pulse * 14
    } else {
      ctx.shadowColor = glow.color
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
      ? canvasPalette.text1
      : focused
        ? canvasPalette.accent
        : glow.color
    ctx.stroke()

    if (zoom < 0.45) continue

    // 节点中心：agent 名首字
    ctx.fillStyle = canvasPalette.onStrong
    ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(persona.name.slice(0, 1), node.x, node.y - 1)

    // 节点下方：标签
    if (zoom > 0.5) {
      ctx.fillStyle = active ? canvasPalette.text1 : canvasPalette.text2
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
    badges.push({ text: `🔧${m.tool_calls}`, color: canvasPalette.info })
  }
  if (m.tool_failures > 0) {
    badges.push({ text: `✗${m.tool_failures}`, color: canvasPalette.danger })
  }
  if (m.tokens) {
    const total = m.tokens.input + m.tokens.output + m.tokens.cache_read
    if (total > 0) {
      badges.push({ text: fmtTokens(total), color: canvasPalette.success })
    }
  }
  if (!badges.length) return

  ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const badgeWidths = badges.map(badge => ctx.measureText(badge.text).width + 12)
  const groupWidth = badgeWidths.reduce((total, width) => total + width, 0)
    + Math.max(0, badgeWidths.length - 1) * 4
  let bx = node.x - groupWidth / 2
  let by = node.y - node.r - 10
  for (let index = 0; index < badges.length; index += 1) {
    const badge = badges[index]
    const w = badgeWidths[index]
    ctx.fillStyle = canvasPalette.panel
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

function fitCanvasGraph(useTargets = false): void {
  const nodes = canvasNodes.value
  const canvas = canvasRef.value
  const rect = canvas?.getBoundingClientRect()
  if (!nodes.length || !canvas || !rect) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    const x = useTargets ? n.targetX : n.x
    const y = useTargets ? n.targetY : n.y
    minX = Math.min(minX, x - n.layoutWidth / 2)
    minY = Math.min(minY, y - n.layoutHeight / 2)
    maxX = Math.max(maxX, x + n.layoutWidth / 2)
    maxY = Math.max(maxY, y + n.layoutHeight / 2)
  }
  const pad = 80
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2
  // The canvas fills the overlay and therefore also extends behind its
  // absolute toolbar. Fit into the visible area below the real toolbar box so
  // top badges/edges never disappear beneath it on high-DPI capture screens.
  const toolbar = canvas.closest('.dag-runtime-overlay')?.querySelector('.dag-runtime-toolbar')
  const toolbarRect = toolbar?.getBoundingClientRect()
  const topInset = toolbarRect
    ? Math.max(0, Math.min(rect.height, toolbarRect.bottom - rect.top))
    : 0
  const availableHeight = Math.max(1, rect.height - topInset)
  zoom = Math.min(1.2, Math.min(rect.width / w, availableHeight / h))
  panX = rect.width / 2 - ((minX + maxX) / 2) * zoom
  panY = topInset + availableHeight / 2 - ((minY + maxY) / 2) * zoom
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
    dragStart = { x: evt.clientX, y: evt.clientY }
    dragOffset = { x: point.x - hit.x, y: point.y - hit.y }
    dragMoved = false
  } else {
    panDrag = { x: evt.clientX - panX, y: evt.clientY - panY }
  }
}

function onMouseMove(evt: MouseEvent): void {
  if (dragNode) {
    if (dragStart && isDagCanvasClick(dragStart, { x: evt.clientX, y: evt.clientY })) return
    dragMoved = true
    const point = canvasPoint(evt)
    pinDagCanvasNode(dragNode, {
      x: point.x - (dragOffset?.x ?? 0),
      y: point.y - (dragOffset?.y ?? 0),
    })
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
    // Compare pointer travel, not pointer-to-node-center distance. The latter
    // made only a few pixels around the visual center clickable even though
    // the whole node correctly advertised a pointer cursor.
    if (!dragMoved && dragStart && isDagCanvasClick(dragStart, { x: evt.clientX, y: evt.clientY })) {
      // 点击同一节点：选中它（同时设焦点）
      emit('focus-node', dragNode.id)
      const newId = selectedNodeId.value === dragNode.id ? null : dragNode.id
      emit('select-node', newId)
    }
    dragNode = null
    dragStart = null
    dragOffset = null
    dragMoved = false
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

function onMouseLeave(): void {
  panDrag = null
  dragNode = null
  dragStart = null
  dragOffset = null
  dragMoved = false
}

// ============================================================================
// 生命周期
// ============================================================================

watch(
  () => [store.nodes, store.edges, props.metrics],
  () => {
    const shouldFitMetrics = Boolean(props.metrics) && !metricsFitComplete
    rebuildGraph(shouldFitMetrics)
  },
  { deep: true },
)

onMounted(() => {
  refreshCanvasPalette()
  stopObservingAppearance = observeCanvasAppearance((palette) => {
    canvasPalette = palette
  })
  rebuildGraph(true)
  resizeCanvas()
  rafId = requestAnimationFrame(drawGraph)
  window.addEventListener('resize', resizeCanvas)
})

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  stopObservingAppearance?.()
  stopObservingAppearance = null
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
    data-testid="dag-runtime-canvas"
    aria-label="DAG runtime graph"
    class="dag-runtime-canvas absolute inset-0 h-full w-full"
    style="cursor: grab"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @mouseleave="onMouseLeave"
    @wheel="onWheel"
  />
</template>

<style scoped>
.dag-runtime-canvas {
  display: block;
  touch-action: none;
}
</style>

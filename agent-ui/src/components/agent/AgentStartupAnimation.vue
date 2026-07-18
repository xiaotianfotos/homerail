<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Target,
  Code2,
  TestTube2,
  ShieldCheck,
  Rocket,
  Bot,
} from 'lucide-vue-next'

// Default demo nodes for animation
interface AnimNode {
  id: string
  label: string
  icon: any
  color: string
  x: number
  y: number
}

interface AnimEdge {
  from: string
  to: string
}

const props = withDefaults(defineProps<{
  nodeCount?: number
}>(), {
  nodeCount: 7,
})

const { t } = useI18n()

const ICONS = [Target, Code2, Code2, TestTube2, TestTube2, ShieldCheck, Rocket]
const COLORS = [
  'var(--hr-speaking)',
  'var(--hr-info)',
  'var(--hr-info)',
  'var(--hr-warning)',
  'var(--hr-warning)',
  'var(--hr-success)',
  'var(--hr-danger)',
]
const labels = computed(() => [
  t('shell.startup.roles.scout'),
  t('shell.startup.roles.engineerA'),
  t('shell.startup.roles.engineerB'),
  t('shell.startup.roles.testerA'),
  t('shell.startup.roles.testerB'),
  t('shell.startup.roles.reviewer'),
  t('shell.startup.roles.publisher'),
])

const W = 600
const H = 500
const CX = W / 2
const CY = H / 2

const nodes = computed<AnimNode[]>(() => {
  const positions = [
    { x: CX, y: 50 },
    { x: CX - 160, y: 160 },
    { x: CX + 160, y: 160 },
    { x: CX - 160, y: 270 },
    { x: CX + 160, y: 270 },
    { x: CX, y: 370 },
    { x: CX, y: 460 },
  ]
  return labels.value.slice(0, props.nodeCount).map((label, i) => ({
    id: String(i),
    label,
    icon: ICONS[i] || Bot,
    color: COLORS[i] || 'var(--hr-text-3)',
    x: positions[i]?.x ?? CX,
    y: positions[i]?.y ?? CY,
  }))
})

const edges = computed<AnimEdge[]>(() => [
  { from: '0', to: '1' },
  { from: '0', to: '2' },
  { from: '1', to: '3' },
  { from: '2', to: '4' },
  { from: '3', to: '5' },
  { from: '4', to: '5' },
  { from: '5', to: '6' },
])

// Animation timing
const elapsed = ref(0)
let frame: number | null = null
let lastTime = 0

function tick(now: number) {
  if (lastTime === 0) lastTime = now
  elapsed.value += (now - lastTime) / 1000
  lastTime = now
  frame = requestAnimationFrame(tick)
}

onMounted(() => {
  lastTime = 0
  frame = requestAnimationFrame(tick)
})

onUnmounted(() => {
  if (frame != null) cancelAnimationFrame(frame)
})

function nodeOpacity(i: number): number {
  const appearAt = i * 0.35
  const t = Math.max(0, elapsed.value - appearAt)
  return Math.min(1, t / 0.5)
}

function nodeScale(i: number): number {
  const appearAt = i * 0.35
  const t = Math.max(0, elapsed.value - appearAt)
  if (t < 0.5) return 0.3 + 0.7 * (t / 0.5)
  return 1
}

function edgeProgress(edgeIdx: number): number {
  const startAt = 2.5 + edgeIdx * 0.3
  const t = Math.max(0, elapsed.value - startAt)
  return Math.min(1, t / 0.6)
}

function pulseOpacity(i: number): number {
  const readyAt = 4 + i * 0.4
  if (elapsed.value < readyAt) return 0
  const cycle = ((elapsed.value - readyAt) % 2.5) / 2.5
  if (cycle < 0.4) return cycle / 0.4 * 0.6
  return 0.6 * (1 - (cycle - 0.4) / 0.6)
}

function pulseRadius(i: number): number {
  const readyAt = 4 + i * 0.4
  if (elapsed.value < readyAt) return 20
  const cycle = ((elapsed.value - readyAt) % 2.5) / 2.5
  return 20 + cycle * 18
}

const edgePath = (from: AnimNode, to: AnimNode) =>
  `M ${from.x} ${from.y + 18} C ${from.x} ${(from.y + to.y) / 2}, ${to.x} ${(from.y + to.y) / 2}, ${to.x} ${to.y - 18}`
</script>

<template>
  <div class="flex items-center justify-center h-full w-full bg-[var(--hr-bg)] overflow-hidden">
    <svg :viewBox="`0 0 ${W} ${H}`" class="max-w-[700px] max-h-[80vh]" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter v-for="n in nodes" :key="'glow-' + n.id" :id="'glow-' + n.id" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur :stdDeviation="pulseOpacity(Number(n.id)) * 6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="edgeGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="var(--hr-info)" stop-opacity="0.5" />
          <stop offset="100%" stop-color="var(--hr-success)" stop-opacity="0.5" />
        </linearGradient>
      </defs>

      <!-- Background grid -->
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--hr-border)" stroke-width="0.5" />
      </pattern>
      <rect width="100%" height="100%" fill="url(#grid)" opacity="0.3" />

      <!-- Edges -->
      <g v-for="(edge, ei) in edges" :key="'e-' + ei">
        <path
          :d="edgePath(nodes[Number(edge.from)], nodes[Number(edge.to)])"
          fill="none"
          stroke="url(#edgeGrad)"
          stroke-width="2"
          :stroke-dasharray="200"
          :stroke-dashoffset="200 * (1 - edgeProgress(ei))"
          stroke-linecap="round"
        />
        <!-- Animated dot along edge -->
        <circle
          v-if="edgeProgress(ei) > 0 && edgeProgress(ei) < 1"
          :cx="nodes[Number(edge.from)].x + (nodes[Number(edge.to)].x - nodes[Number(edge.from)].x) * edgeProgress(ei)"
          :cy="nodes[Number(edge.from)].y + 18 + (nodes[Number(edge.to)].y - 18 - nodes[Number(edge.from)].y - 18) * edgeProgress(ei)"
          r="3"
          :fill="COLORS[Number(edge.from)]"
          opacity="0.8"
        />
      </g>

      <!-- Nodes -->
      <g
        v-for="(node, ni) in nodes"
        :key="'n-' + node.id"
        :opacity="nodeOpacity(ni)"
        :transform="`translate(${node.x}, ${node.y}) scale(${nodeScale(ni)})`"
      >
        <!-- Pulse ring -->
        <circle
          :cx="0"
          :cy="0"
          :r="pulseRadius(ni)"
          fill="none"
          :stroke="node.color"
          :stroke-width="1.5"
          :opacity="pulseOpacity(ni)"
        />

        <!-- Node body -->
        <rect
          x="-22" y="-18" width="44" height="36" rx="10"
          :fill="`color-mix(in srgb, ${node.color} 12%, transparent)`"
          :stroke="node.color"
          stroke-width="1.5"
          :filter="pulseOpacity(ni) > 0.1 ? `url(#glow-${node.id})` : 'none'"
        />

        <!-- Icon placeholder (small dot) -->
        <circle cx="0" cy="-2" r="5" :fill="node.color" opacity="0.8" />

        <!-- Label -->
        <text
          x="0" y="14"
          text-anchor="middle"
          fill="var(--hr-text-3)"
          font-size="9"
          font-family="system-ui, sans-serif"
        >
          {{ node.label }}
        </text>
      </g>

      <!-- Center status text -->
      <text
        v-if="elapsed > 5"
        x="50%" y="95%"
        text-anchor="middle"
        fill="var(--hr-text-4)"
        font-size="11"
        font-family="system-ui, sans-serif"
      >
        {{ t('shell.startup.ready', { count: nodes.length }) }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
svg text {
  user-select: none;
}
</style>

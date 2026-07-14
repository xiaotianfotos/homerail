<script setup lang="ts">
import { computed, type CSSProperties } from 'vue'
import { AlertTriangle, CheckCircle2, Clock3, LoaderCircle } from 'lucide-vue-next'

export interface A2uiDagItem {
  id: string
  title: string
  detail?: string
  status?: string
  tone: string
  progress?: number
  dependsOn: string[]
}

const props = defineProps<{ items: A2uiDagItem[] }>()
const nodeWidth = 154
const nodeHeight = 64
const columnGap = 52
const rowGap = 14

const layout = computed(() => {
  const ids = new Set(props.items.map(item => item.id))
  const levelById = new Map<string, number>()
  const visiting = new Set<string>()
  const byId = new Map(props.items.map(item => [item.id, item]))
  const level = (id: string): number => {
    if (levelById.has(id)) return levelById.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    const item = byId.get(id)
    const dependencies = (item?.dependsOn ?? []).filter(dependency => ids.has(dependency))
    const result = dependencies.length ? Math.max(...dependencies.map(dependency => level(dependency) + 1)) : 0
    visiting.delete(id)
    levelById.set(id, result)
    return result
  }
  props.items.forEach(item => level(item.id))
  const groups = new Map<number, A2uiDagItem[]>()
  props.items.forEach(item => {
    const itemLevel = levelById.get(item.id) ?? 0
    groups.set(itemLevel, [...(groups.get(itemLevel) ?? []), item])
  })
  const maxRows = Math.max(1, ...[...groups.values()].map(group => group.length))
  const maxLevel = Math.max(0, ...levelById.values())
  const width = Math.max(360, (maxLevel + 1) * nodeWidth + maxLevel * columnGap + 28)
  const height = Math.max(190, maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap + 28)
  const positions = new Map<string, { x: number; y: number }>()
  for (const [itemLevel, group] of groups) {
    const groupHeight = group.length * nodeHeight + Math.max(0, group.length - 1) * rowGap
    const startY = (height - groupHeight) / 2
    group.forEach((item, index) => positions.set(item.id, {
      x: 14 + itemLevel * (nodeWidth + columnGap),
      y: startY + index * (nodeHeight + rowGap),
    }))
  }
  const edges = props.items.flatMap(item => item.dependsOn.flatMap(dependency => {
    const from = positions.get(dependency)
    const to = positions.get(item.id)
    if (!from || !to) return []
    const startX = from.x + nodeWidth
    const startY = from.y + nodeHeight / 2
    const endX = to.x
    const endY = to.y + nodeHeight / 2
    const control = Math.max(24, (endX - startX) / 2)
    return [{
      id: `${dependency}:${item.id}`,
      path: `M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}`,
      tone: item.tone,
    }]
  }))
  return { width, height, positions, edges }
})

function nodeStyle(item: A2uiDagItem): CSSProperties {
  const position = layout.value.positions.get(item.id) ?? { x: 0, y: 0 }
  return {
    left: `${position.x}px`,
    top: `${position.y}px`,
    width: `${nodeWidth}px`,
    height: `${nodeHeight}px`,
    '--progress': `${Math.max(0, Math.min(100, item.progress ?? 0))}%`,
  }
}

function statusIcon(status = '') {
  const normalized = status.toLowerCase()
  if (['passed', 'ready', 'resolved', 'verified', 'succeeded', 'completed'].includes(normalized)) return CheckCircle2
  if (['failed', 'blocked', 'critical', 'error'].includes(normalized)) return AlertTriangle
  if (['running', 'active', 'submitting'].includes(normalized)) return LoaderCircle
  return Clock3
}
</script>

<template>
  <div class="hr-a2ui__dag-scroll">
    <div class="hr-a2ui__dag" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
      <svg :viewBox="`0 0 ${layout.width} ${layout.height}`" aria-hidden="true">
        <defs>
          <marker id="hr-a2ui-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" />
          </marker>
        </defs>
        <path
          v-for="edge in layout.edges"
          :key="edge.id"
          :d="edge.path"
          :data-tone="edge.tone"
          marker-end="url(#hr-a2ui-arrow)"
        />
      </svg>
      <article
        v-for="item in items"
        :key="item.id"
        class="hr-a2ui__dag-node"
        :data-tone="item.tone"
        :style="nodeStyle(item)"
      >
        <component :is="statusIcon(item.status)" :size="14" aria-hidden="true" />
        <div><strong>{{ item.title }}</strong><span>{{ item.detail || item.status }}</span></div>
        <i aria-hidden="true"><b /></i>
      </article>
    </div>
  </div>
</template>

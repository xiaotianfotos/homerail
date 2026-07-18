<script setup lang="ts">
import { computed } from 'vue'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@vue-flow/core'
import { useAgentStore } from '@/stores/agent-store'
import { getAgentPersona, contextBarColor, contextUsageText } from '@/lib/agentPersonas'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'

const store = useAgentStore()

const emit = defineEmits<{
  'node-click': [nodeId: string]
}>()

// ============================================================================
// Status → style
// ============================================================================

const statusStyle: Record<string, { dot: string; border: string; shadow?: string; bg?: string; text?: string }> = {
  pending:   { dot: 'bg-[var(--hr-text-3)]', border: 'border-[var(--hr-border-strong)]', bg: 'bg-[var(--hr-surface-1)]', text: 'text-[var(--hr-text-2)]' },
  ready:     { dot: 'bg-[var(--hr-info)]',            border: 'border-[var(--hr-info-border)]',       bg: 'bg-[var(--hr-info-soft)]',  text: 'text-[var(--hr-info)]' },
  running:   { dot: 'bg-[var(--hr-success)] animate-pulse', border: 'border-[var(--hr-success-border)]', shadow: 'shadow-[0_0_18px_var(--hr-success-soft)]', bg: 'bg-[var(--hr-success-soft)]', text: 'text-[var(--hr-success)]' },
  completed: { dot: 'bg-[var(--hr-info)]',            border: 'border-[var(--hr-info-border)]',          bg: 'bg-[var(--hr-info-soft)]', text: 'text-[var(--hr-info)]' },
  failed:    { dot: 'bg-[var(--hr-danger)]',             border: 'border-[var(--hr-danger-border)]',           bg: 'bg-[var(--hr-danger-soft)]',  text: 'text-[var(--hr-danger)]' },
  skipped:   { dot: 'bg-[var(--hr-warning)]',          border: 'border-[var(--hr-warning-border)]',        bg: 'bg-[var(--hr-warning-soft)]', text: 'text-[var(--hr-warning)]' },
}

const edgeStyles: Record<string, { stroke: string; dashed: boolean; label: string }> = {
  always:     { stroke: 'var(--hr-text-3)', dashed: false, label: '' },
  on_success: { stroke: 'var(--hr-success)', dashed: false, label: '✓' },
  on_failure: { stroke: 'var(--hr-danger)', dashed: true,  label: '✗' },
}

// ============================================================================
// Layout
// ============================================================================

function layoutGraph(
  nodes: Array<{ id: string; width: number; height: number }>,
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 160 })

  for (const n of nodes) {
    g.setNode(n.id, { width: n.width, height: n.height })
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const pos = g.node(n.id)
    if (pos) positions.set(n.id, { x: pos.x - n.width / 2, y: pos.y - n.height / 2 })
  }
  return positions
}

// ============================================================================
// VueFlow nodes/edges
// ============================================================================

const flowNodes = computed<Node[]>(() => {
  if (!store.dagExecution) return []

  const layoutItems = store.nodes.map(n => ({
    id: n.id,
    width: 200,
    height: n.context_usage_pct != null ? 90 : 70,
  }))

  const edgeList = store.edges.map(e => ({ source: e.source, target: e.target }))
  const positions = layoutGraph(layoutItems, edgeList)

  return layoutItems.map((item, i) => {
    const node = store.nodes[i]
    return {
      id: item.id,
      type: 'dagNode',
      position: positions.get(item.id) || { x: 0, y: 0 },
      data: {
        label: node.name,
        nodeId: node.id,
        status: node.status,
        agentName: node.agent_name,
        startedAt: node.started_at,
        completedAt: node.completed_at,
        contextUsagePct: node.context_usage_pct,
      },
    }
  })
})

const flowEdges = computed<Edge[]>(() => {
  if (!store.dagExecution) return []

  return store.edges
    .filter(e => e.source && e.target)
    .map((edge, i) => {
      const style = edgeStyles[edge.condition] || edgeStyles.always
      const isAnimated = store.nodes.find(n => n.id === edge.target)?.status === 'running'

      return {
        id: `e-${i}`,
        source: edge.source,
        target: edge.target,
        animated: isAnimated || false,
        style: {
          stroke: style.stroke,
          strokeWidth: 2,
          strokeDasharray: style.dashed ? '5,5' : '',
        },
        label: style.label,
        labelStyle: { fill: style.stroke, fontWeight: 'bold', fontSize: '14px' },
      }
    })
})

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return ''
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const diff = Math.max(0, end - start)
  const minutes = Math.floor(diff / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

function onNodeClick({ node }: { node: Node }) {
  emit('node-click', node.id)
}
</script>

<template>
  <div class="h-full">
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :default-viewport="{ zoom: 0.8 }"
      :min-zoom="0.2"
      :max-zoom="2"
      fit-view-on-init
      :fit-view-options="{ padding: 0.3 }"
      @node-click="onNodeClick"
    >
      <template #node-dagNode="nodeProps">
        <div
          class="px-3 py-2 rounded-lg border-2 bg-[var(--hr-bg-raised)] shadow-md min-w-[160px] transition-all cursor-pointer hover:shadow-lg"
          :class="[
            (statusStyle[nodeProps.data?.status]?.border || 'border-[var(--hr-border-strong)]'),
            statusStyle[nodeProps.data?.status]?.shadow || '',
          ]"
          @click="emit('node-click', nodeProps.id)"
        >
          <!-- Row 1: icon + name -->
          <div class="flex items-center gap-2">
            <component
              :is="getAgentPersona(nodeProps.data?.agentName || '').icon"
              class="h-3.5 w-3.5"
              :style="{ color: getAgentPersona(nodeProps.data?.agentName || '').color }"
            />
            <span class="font-medium text-sm text-[var(--hr-text-1)] truncate">
              {{ nodeProps.data?.label || nodeProps.id }}
            </span>
          </div>

          <!-- Row 2: duration -->
          <div class="flex items-center justify-between mt-1">
            <span
              v-if="nodeProps.data?.startedAt"
              class="text-[10px] font-mono"
              :class="statusStyle[nodeProps.data?.status]?.text || 'text-[var(--hr-text-3)]'"
            >
              {{ formatDuration(nodeProps.data?.startedAt, nodeProps.data?.completedAt) }}
            </span>
            <span v-else class="text-[10px] font-mono text-[var(--hr-text-4)]">--</span>
          </div>

          <!-- Context usage bar -->
          <div v-if="nodeProps.data?.contextUsagePct != null" class="mt-1">
            <div class="flex justify-between text-[9px]">
              <span class="text-[var(--hr-text-3)]">ctx</span>
              <span :class="contextUsageText(nodeProps.data.contextUsagePct)">
                {{ nodeProps.data.contextUsagePct }}%
              </span>
            </div>
            <div class="h-1 rounded-full bg-[var(--hr-surface-2)] mt-0.5">
              <div
                class="h-full rounded-full transition-all"
                :class="contextBarColor(nodeProps.data.contextUsagePct)"
                :style="{ width: `${Math.min(nodeProps.data.contextUsagePct, 100)}%` }"
              />
            </div>
          </div>
        </div>
      </template>

      <Background :gap="16" :size="1" />
    </VueFlow>
  </div>
</template>

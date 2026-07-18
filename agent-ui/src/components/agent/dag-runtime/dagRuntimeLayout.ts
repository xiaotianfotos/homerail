import dagre from '@dagrejs/dagre'

export interface DagRuntimeLayoutNode {
  id: string
  width: number
  height: number
}

export interface DagRuntimeLayoutEdge {
  source: string
  target: string
}

export interface DagRuntimeLayoutPosition {
  x: number
  y: number
}

/**
 * Runtime graphs contain one edge per data/control port. The canvas presents
 * node-to-node topology, so coincident port edges only add visual noise and
 * apply the same layout constraint more than once.
 */
export function dedupeDagRuntimeEdges<T extends DagRuntimeLayoutEdge>(edges: T[]): T[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.target}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Produce stable left-to-right DAG coordinates. Node dimensions are the full
 * rendered bounds (circle, label, badges and breathing room), not just the
 * circle diameter, so Dagre can keep every visible element apart.
 *
 * Coordinates are centred around (0, 0); the canvas chooses the viewport
 * centre without coupling layout to screen size.
 */
export function layoutDagRuntimeGraph(
  nodes: DagRuntimeLayoutNode[],
  edges: DagRuntimeLayoutEdge[],
): Map<string, DagRuntimeLayoutPosition> {
  const positions = new Map<string, DagRuntimeLayoutPosition>()
  if (!nodes.length) return positions

  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({
    rankdir: 'LR',
    ranker: 'network-simplex',
    acyclicer: 'greedy',
    nodesep: 32,
    edgesep: 18,
    ranksep: 72,
    marginx: 24,
    marginy: 24,
  })

  const nodeIds = new Set(nodes.map(node => node.id))
  for (const node of nodes) {
    graph.setNode(node.id, {
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
    })
  }
  for (const edge of dedupeDagRuntimeEdges(edges)) {
    if (edge.source === edge.target || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    graph.setEdge(edge.source, edge.target)
  }

  dagre.layout(graph)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const position = graph.node(node.id)
    if (!position) continue
    const halfWidth = node.width / 2
    const halfHeight = node.height / 2
    minX = Math.min(minX, position.x - halfWidth)
    minY = Math.min(minY, position.y - halfHeight)
    maxX = Math.max(maxX, position.x + halfWidth)
    maxY = Math.max(maxY, position.y + halfHeight)
  }

  const centerX = Number.isFinite(minX) ? (minX + maxX) / 2 : 0
  const centerY = Number.isFinite(minY) ? (minY + maxY) / 2 : 0
  for (const node of nodes) {
    const position = graph.node(node.id)
    if (position) {
      positions.set(node.id, {
        x: position.x - centerX,
        y: position.y - centerY,
      })
    }
  }

  return positions
}

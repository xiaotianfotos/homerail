export interface DagCanvasPointerPoint {
  x: number
  y: number
}

export interface DagCanvasDraggableNode extends DagCanvasPointerPoint {
  targetX: number
  targetY: number
  vx: number
  vy: number
  manuallyPositioned: boolean
}

/** Distinguish a click from a node drag using pointer travel. */
export function isDagCanvasClick(
  start: DagCanvasPointerPoint,
  end: DagCanvasPointerPoint,
  dragThreshold = 2,
): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) < dragThreshold
}

/** Make a manual drag the node's new stable layout anchor. */
export function pinDagCanvasNode(
  node: DagCanvasDraggableNode,
  position: DagCanvasPointerPoint,
): void {
  node.x = position.x
  node.y = position.y
  node.targetX = position.x
  node.targetY = position.y
  node.vx = 0
  node.vy = 0
  node.manuallyPositioned = true
}

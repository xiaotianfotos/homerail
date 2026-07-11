import type { DAGEdge, DAGGraphData } from "./graph.js";

export interface GraphValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  node_count: number;
  edge_count: number;
  entry_nodes: string[];
  terminal_nodes: string[];
}

function _isFailureEdge(edge: DAGEdge): boolean {
  return edge.condition === "on_failure";
}

function _isTerminalEdge(edge: DAGEdge): boolean {
  return edge.to_node === "";
}

function _isLoopFeedbackEdge(graph: DAGGraphData, edge: DAGEdge): boolean {
  if (_isTerminalEdge(edge)) return false;
  const target = graph.nodes.find((node) => node.node_id === edge.to_node);
  if (target?.node_type !== "loop_gateway" && target?.node_type !== "while_gateway") return false;
  const source = graph.nodes.find((node) => node.node_id === edge.from_node);
  return source?.after.includes(target.node_id) ?? false;
}

function _nodeIds(graph: DAGGraphData): string[] {
  return graph.nodes.map((node) => node.node_id);
}

function _adjacency(graph: DAGGraphData): Map<string, string[]> {
  const ids = _nodeIds(graph);
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of graph.edges) {
    if (_isFailureEdge(edge) || _isTerminalEdge(edge) || _isLoopFeedbackEdge(graph, edge)) continue;
    adjacency.get(edge.from_node)?.push(edge.to_node);
  }
  return adjacency;
}

function _entryNodes(graph: DAGGraphData): string[] {
  const ids = new Set(_nodeIds(graph));
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    if (_isFailureEdge(edge) || _isTerminalEdge(edge) || _isLoopFeedbackEdge(graph, edge)) continue;
    if (ids.has(edge.to_node)) incoming.add(edge.to_node);
  }
  return Array.from(ids).filter((id) => !incoming.has(id)).sort();
}

function _terminalNodes(graph: DAGGraphData): string[] {
  const ids = new Set(_nodeIds(graph));
  const outgoing = new Set<string>();
  for (const edge of graph.edges) {
    if (_isFailureEdge(edge) || _isTerminalEdge(edge)) continue;
    if (ids.has(edge.from_node)) outgoing.add(edge.from_node);
  }
  return Array.from(ids).filter((id) => !outgoing.has(id)).sort();
}

function _explicitTerminalNodes(graph: DAGGraphData): Set<string> {
  const terminal = new Set<string>();
  for (const edge of graph.edges) {
    if (_isTerminalEdge(edge)) terminal.add(edge.from_node);
  }
  return terminal;
}

function _detectCycles(graph: DAGGraphData): string[][] {
  const ids = _nodeIds(graph);
  const adjacency = _adjacency(graph);
  const color = new Map(ids.map((id) => [id, 0]));
  const path: string[] = [];
  const cycles: string[][] = [];

  function visit(nodeId: string): void {
    color.set(nodeId, 1);
    path.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (!color.has(next)) continue;
      const nextColor = color.get(next);
      if (nextColor === 1) {
        const idx = path.indexOf(next);
        cycles.push([...path.slice(idx), next]);
      } else if (nextColor === 0) {
        visit(next);
      }
    }
    path.pop();
    color.set(nodeId, 2);
  }

  for (const id of ids) {
    if (color.get(id) === 0) visit(id);
  }
  return cycles;
}

function _isReachable(adjacency: Map<string, string[]>, fromNode: string, toNode: string): boolean {
  const queue = [fromNode];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toNode) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

function _unreachableNodes(graph: DAGGraphData, entryNodes: string[]): string[] {
  const ids = new Set(_nodeIds(graph));
  const adjacency = _adjacency(graph);
  const visited = new Set<string>(entryNodes);
  const queue = [...entryNodes];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return Array.from(ids).filter((id) => !visited.has(id)).sort();
}

function _maxRetries(edge: DAGEdge): number | undefined {
  const raw = edge.retry_policy?.max_retries;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

const JOIN_MODES = new Set(["all", "any", "n_of_m"]);
const WHILE_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "truthy", "falsy"]);

function _validateGatewayConfigs(graph: DAGGraphData, errors: string[]): void {
  for (const node of graph.nodes) {
    const config = node.gateway_config;
    if (node.node_type === "join_gateway") {
      const dependencies = new Set(node.after);
      const routedSources = new Set(
        graph.edges
          .filter((edge) => edge.to_node === node.node_id && edge.label !== "after_dep")
          .map((edge) => edge.from_node),
      );
      if (dependencies.size === 0) {
        errors.push(`Join gateway ${node.node_id} requires at least one after dependency`);
      }
      const missingInputs = Array.from(dependencies).filter((dependency) => !routedSources.has(dependency));
      if (missingInputs.length > 0) {
        errors.push(
          `Join gateway ${node.node_id} is missing routed input from after dependencies: ${missingInputs.sort().join(", ")}`,
        );
      }
      const unawaitedInputs = Array.from(routedSources).filter((source) => !dependencies.has(source));
      if (unawaitedInputs.length > 0) {
        errors.push(
          `Join gateway ${node.node_id} has routed input from undeclared after dependencies: ${unawaitedInputs.sort().join(", ")}`,
        );
      }
      const mode = config?.mode ?? "all";
      if (!JOIN_MODES.has(mode)) {
        errors.push(`Join gateway ${node.node_id} has unsupported mode: ${mode}`);
      }
      if (mode === "n_of_m") {
        const threshold = config?.threshold;
        if (!Number.isInteger(threshold) || (threshold ?? 0) < 1) {
          errors.push(`Join gateway ${node.node_id} requires a positive integer threshold for n_of_m mode`);
        } else if ((threshold ?? 0) > dependencies.size) {
          errors.push(
            `Join gateway ${node.node_id} threshold ${threshold} exceeds its ${dependencies.size} after dependencies`,
          );
        }
      }
    }
    if (node.node_type === "while_gateway") {
      const operator = config?.operator ?? "eq";
      if (!WHILE_OPERATORS.has(operator)) {
        errors.push(`While gateway ${node.node_id} has unsupported operator: ${operator}`);
      }
      const maxIterations = config?.max_iterations ?? 3;
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        errors.push(`While gateway ${node.node_id} requires max_iterations to be a positive integer`);
      }
    }
  }
}

export function validateGraph(graph: DAGGraphData): GraphValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = _nodeIds(graph);
  const idSet = new Set(ids);

  _validateGatewayConfigs(graph, errors);

  if (ids.length === 0) {
    errors.push("Graph has no nodes");
  }

  for (const edge of graph.edges) {
    if (
      edge.retry_policy?.max_retries !== undefined &&
      (!Number.isInteger(edge.retry_policy.max_retries) || edge.retry_policy.max_retries < 0)
    ) {
      errors.push(
        `Edge ${edge.from_node}.${edge.from_port} -> ${edge.to_node}.${edge.to_port} requires max_retries to be a non-negative integer`,
      );
    }
    if (!idSet.has(edge.from_node)) {
      errors.push(`Edge references unknown from_node: ${edge.from_node}`);
    }
    if (!_isTerminalEdge(edge) && !idSet.has(edge.to_node)) {
      errors.push(`Edge references unknown to_node: ${edge.to_node}`);
    }
  }

  for (const cycle of _detectCycles(graph)) {
    errors.push(`Cycle detected: ${cycle.join(" -> ")}`);
  }

  if (ids.length > 1) {
    const connected = new Set<string>();
    for (const edge of graph.edges) {
      if (idSet.has(edge.from_node)) connected.add(edge.from_node);
      if (idSet.has(edge.to_node)) connected.add(edge.to_node);
    }
    for (const id of ids) {
      if (!connected.has(id)) warnings.push(`Orphan node (no edges): ${id}`);
    }
  }

  const entryNodes = _entryNodes(graph);
  for (const id of _unreachableNodes(graph, entryNodes)) {
    errors.push(`Unreachable node from entry: ${id}`);
  }

  const outgoing = new Set<string>();
  const explicitTerminal = _explicitTerminalNodes(graph);
  for (const edge of graph.edges) {
    if (idSet.has(edge.from_node) && !_isFailureEdge(edge)) outgoing.add(edge.from_node);
  }
  for (const id of ids) {
    if (!outgoing.has(id) && !explicitTerminal.has(id)) {
      warnings.push(`Dead-end node (no terminal or outgoing edges): ${id}`);
    }
  }

  const successAdjacency = _adjacency(graph);
  const nodeOrder = new Map(ids.map((id, index) => [id, index]));
  for (const edge of graph.edges) {
    const maxRetries = _maxRetries(edge);
    if (
      !_isFailureEdge(edge) ||
      _isTerminalEdge(edge) ||
      maxRetries === undefined ||
      maxRetries <= 10 ||
      !idSet.has(edge.from_node) ||
      !idSet.has(edge.to_node)
    ) {
      continue;
    }
    const isBackEdge =
      _isReachable(successAdjacency, edge.to_node, edge.from_node) ||
      (nodeOrder.get(edge.from_node) ?? -1) > (nodeOrder.get(edge.to_node) ?? -1);
    if (isBackEdge) {
      warnings.push(
        `Feedback-loop risk: on_failure edge ${edge.from_node}.${edge.from_port} -> ${edge.to_node}.${edge.to_port} has max_retries ${maxRetries}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    node_count: ids.length,
    edge_count: graph.edges.length,
    entry_nodes: entryNodes,
    terminal_nodes: _terminalNodes(graph),
  };
}

export function assertGraphValid(graph: DAGGraphData): void {
  const result = validateGraph(graph);
  if (result.valid) return;
  throw new TypeError(`Invalid DAG graph: ${result.errors.join("; ")}`);
}

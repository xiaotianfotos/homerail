import { readFileSync } from "node:fs";
import YAML from "yaml";
import { FAILURE_PORT_NAMES } from "./graph.js";
import type {
  DAGEdge,
  DAGGraphData,
  DAGGraphNode,
  DAGNodeConfig,
  DAGNodeRequirements,
  DAGOutputRoute,
  ParsedDAG,
  ResolvedWorkflowMeta,
} from "./graph.js";
import { assertGraphValid } from "./graph-validator.js";

function _parseTarget(
  target: string,
  sourcePort: string,
): { to_node: string; to_port: string } {
  if (target === "") {
    return { to_node: "", to_port: "" };
  }
  const match = target.match(/^([^\.]+)(?:\.in:(.*))?$/);
  if (!match) {
    return { to_node: target, to_port: sourcePort };
  }
  const to_node = match[1];
  const to_port = match[2] ?? sourcePort;
  return { to_node, to_port };
}

export function _normalizeOutputsToEdges(
  outputs: Record<string, DAGOutputRoute>,
  nodeId: string,
): DAGEdge[] {
  const edges: DAGEdge[] = [];
  for (const [port, route] of Object.entries(outputs)) {
    const targets = Array.isArray(route.to) ? route.to : [route.to];
    const condition = _normalizeOutputCondition(port, route.condition);
    for (const t of targets) {
      const { to_node, to_port } = _parseTarget(t, port);
      edges.push({
        from_node: nodeId,
        from_port: port,
        to_node,
        to_port,
        condition,
        retry_policy: route.retry_policy,
      });
    }
  }
  return edges;
}

function _normalizeOutputCondition(
  port: string,
  raw: string | undefined,
): "on_success" | "on_failure" | "always" {
  if (raw === "on_success" || raw === "on_failure" || raw === "always") {
    return raw;
  }
  return FAILURE_PORT_NAMES.has(port.toLowerCase()) ? "on_failure" : "on_success";
}

function _normalizeRequirements(value: unknown): DAGNodeRequirements | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities
        .filter((capability): capability is string => typeof capability === "string")
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0)
    : undefined;
  return capabilities && capabilities.length > 0 ? { capabilities } : undefined;
}

function _normalizeNodeType(cfg: DAGNodeConfig): string {
  const rawType = (cfg.node_type ?? cfg.type ?? "").trim();
  const gateway = cfg.gateway_config ?? cfg.gateway;
  const kind = (gateway?.kind ?? gateway?.type ?? "").trim();
  const type = rawType || (gateway ? "gateway" : "agent");
  if (type === "loop" || type === "loop_gateway") return "loop_gateway";
  if (type === "condition" || type === "condition_gateway") return "condition_gateway";
  if (type === "join" || type === "join_gateway") return "join_gateway";
  if (type === "while" || type === "while_gateway") return "while_gateway";
  if (type === "gateway") {
    if (kind === "loop") return "loop_gateway";
    if (kind === "condition") return "condition_gateway";
    if (kind === "join") return "join_gateway";
    if (kind === "while") return "while_gateway";
  }
  return type || "agent";
}

function _isGatewayNodeType(nodeType: string): boolean {
  return nodeType === "loop_gateway" ||
    nodeType === "condition_gateway" ||
    nodeType === "join_gateway" ||
    nodeType === "while_gateway";
}

export function _detectLoopSources(
  edges: DAGEdge[],
  nodes: DAGGraphNode[],
): string[] {
  const nodeIds = nodes.map((n) => n.node_id);
  const nodeIdSet = new Set(nodeIds);
  const yamlOrder = new Map(nodeIds.map((id, i) => [id, i]));

  // Kahn's algorithm on all non-terminal edges
  const validEdges = edges.filter(
    (e) => e.to_node !== "" && nodeIdSet.has(e.from_node) && nodeIdSet.has(e.to_node),
  );

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of validEdges) {
    adj.get(e.from_node)!.push(e.to_node);
    inDegree.set(e.to_node, (inDegree.get(e.to_node) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    topoOrder.push(curr);
    for (const next of adj.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Fallback for cyclic graphs: greedily append remaining nodes by YAML order
  const remaining = new Set(nodeIds.filter((id) => !topoOrder.includes(id)));
  const remainingDegree = new Map<string, number>();
  for (const id of remaining) {
    remainingDegree.set(id, inDegree.get(id) ?? 0);
  }
  while (remaining.size > 0) {
    const best = Array.from(remaining).sort(
      (a, b) => (yamlOrder.get(a) ?? 999) - (yamlOrder.get(b) ?? 999),
    )[0];
    topoOrder.push(best);
    remaining.delete(best);
    for (const e of validEdges) {
      if (e.from_node === best && remaining.has(e.to_node)) {
        remainingDegree.set(e.to_node, (remainingDegree.get(e.to_node) ?? 0) - 1);
      }
    }
  }

  const topoIndex = new Map<string, number>();
  for (let i = 0; i < topoOrder.length; i++) {
    topoIndex.set(topoOrder[i], i);
  }

  const loopSources = new Set<string>();
  const nodeById = new Map(nodes.map((node) => [node.node_id, node]));
  for (const e of edges) {
    if (e.label === "after_dep" || e.to_node === "") continue;
    const target = nodeById.get(e.to_node);
    const source = nodeById.get(e.from_node);
    if (target?.node_type === "loop_gateway" || target?.node_type === "while_gateway") {
      if (source?.after.includes(target.node_id)) loopSources.add(target.node_id);
      continue;
    }
    const fromIdx = topoIndex.get(e.from_node);
    const toIdx = topoIndex.get(e.to_node);
    if (fromIdx !== undefined && toIdx !== undefined && fromIdx > toIdx) {
      loopSources.add(e.to_node);
    }
  }

  return Array.from(loopSources).sort();
}

export function parseDAGYaml(yamlString: string): ParsedDAG {
  const raw = YAML.parse(yamlString);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("YAML root must be an object");
  }

  const meta: ResolvedWorkflowMeta = {
    name: raw.name ?? "",
    workflow_id: raw.workflow_id,
    description: raw.description,
    llm: raw.llm,
    runtime_profiles: raw.runtime_profiles,
    provider_policy: raw.provider_policy,
    scorecard: raw.scorecard,
    pattern: raw.pattern,
    image: raw.image,
    limits: raw.limits,
    git: raw.git,
    workspace: raw.workspace,
    agents: raw.agents,
    nodes: raw.nodes,
  };

  const nodesMap: Record<string, DAGNodeConfig> = raw.nodes ?? {};
  const nodeIds = Object.keys(nodesMap);
  if (nodeIds.length === 0) {
    throw new TypeError("YAML must contain a non-empty 'nodes' section");
  }

  const graphNodes: DAGGraphNode[] = [];
  const graphEdges: DAGEdge[] = [];

  for (const nodeId of nodeIds) {
    const cfg = nodesMap[nodeId];
    const nodeType = _normalizeNodeType(cfg);
    const isGateway = _isGatewayNodeType(nodeType);
    const graphNode: DAGGraphNode = {
      node_id: nodeId,
      name: cfg.name ?? nodeId,
      description: cfg.description ?? "",
      node_type: nodeType,
      agent: cfg.agent ?? (isGateway ? "__gateway__" : ""),
      after: cfg.after ?? [],
      outputs: cfg.outputs ?? {},
      image: isGateway ? cfg.image : cfg.image ?? meta.image,
      container_group: cfg.container_group,
      requires: _normalizeRequirements(cfg.requires),
      gateway_config: cfg.gateway_config ?? cfg.gateway,
      extra: cfg.extra,
    };
    graphNodes.push(graphNode);

    for (const pred of cfg.after ?? []) {
      graphEdges.push({
        from_node: pred,
        from_port: "done",
        to_node: nodeId,
        to_port: "task",
        condition: "on_success",
        label: "after_dep",
      });
    }

    graphEdges.push(..._normalizeOutputsToEdges(cfg.outputs ?? {}, nodeId));
  }

  const graph: DAGGraphData = { nodes: graphNodes, edges: graphEdges };
  assertGraphValid(graph);
  const loop_sources = _detectLoopSources(graphEdges, graphNodes);

  return { meta, graph, loop_sources };
}

export function parseDAGYamlFile(filePath: string): ParsedDAG {
  const content = readFileSync(filePath, "utf-8");
  return parseDAGYaml(content);
}

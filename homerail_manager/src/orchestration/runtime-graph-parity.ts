import type { ParsedDAG } from "./graph.js";

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortObject(entry)]));
}

function normalizeGateway(value: Record<string, unknown> | undefined, nodeType: string): unknown {
  if (!value) return {};
  const { type: _type, kind: _kind, ...rest } = value;
  return sortObject(nodeType === "loop_gateway"
    ? { input: "items", max_items: 10_000, ...rest }
    : rest);
}

export function runtimeGraphSignature(parsed: ParsedDAG): { nodes: unknown[]; edges: unknown[] } {
  const nodes = parsed.graph.nodes
    .map((node) => ({
      id: node.node_id,
      type: node.node_type,
      agent: node.agent,
      after: [...node.after].sort(),
      gateway: normalizeGateway(
        node.gateway_config as Record<string, unknown> | undefined,
        node.node_type,
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = parsed.graph.edges
    .map((edge) => {
      const inferredFeedback = parsed.loop_sources.includes(edge.to_node) &&
        parsed.graph.nodes.find((node) => node.node_id === edge.from_node)?.after.includes(edge.to_node);
      return {
        from_node: edge.from_node,
        from_port: edge.from_port,
        to_node: edge.to_node,
        to_port: edge.to_port,
        condition: edge.condition,
        label: edge.label === "feedback" || inferredFeedback ? "feedback" : edge.label,
        max_retries: edge.retry_policy?.max_retries ?? (inferredFeedback ? 3 : undefined),
      };
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { nodes, edges };
}

export function assertRuntimeGraphParity(label: string, expected: ParsedDAG, actual: ParsedDAG): void {
  const expectedSignature = runtimeGraphSignature(expected);
  const actualSignature = runtimeGraphSignature(actual);
  if (JSON.stringify(expectedSignature) === JSON.stringify(actualSignature)) return;

  const nodeIndex = expectedSignature.nodes.findIndex(
    (node, index) => JSON.stringify(node) !== JSON.stringify(actualSignature.nodes[index]),
  );
  const edgeIndex = expectedSignature.edges.findIndex(
    (edge, index) => JSON.stringify(edge) !== JSON.stringify(actualSignature.edges[index]),
  );
  throw new Error(
    `${label} changed its runtime graph while migrating to WorkflowSpec v1; ` +
    `node_diff=${JSON.stringify([expectedSignature.nodes[nodeIndex], actualSignature.nodes[nodeIndex]])}; ` +
    `edge_diff=${JSON.stringify([expectedSignature.edges[edgeIndex], actualSignature.edges[edgeIndex]])}`,
  );
}

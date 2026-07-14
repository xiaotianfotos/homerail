/**
 * get_graph_context DAG tool — read-only graph position info.
 * @version 0.1.0
 */

import type { GraphContext } from "homerail-protocol";
import type { DagToolDefinition } from "../agent/types.js";
import type { DagToolsState } from "./index.js";

export function createGraphContextTool(state: DagToolsState): DagToolDefinition {
  const ctx: GraphContext = {
    run_id: state.runId,
    node_id: state.nodeId,
    predecessors: state.incomingEdges.map((e) => ({
      node: e.from_node ?? "?",
      from_port: e.from_port,
      to_port: e.to_port,
    })),
    successors: state.outgoingEdges.map((e) => ({
      node: e.to_node ?? "?",
      from_port: e.from_port,
      to_port: e.to_port,
    })),
    available_ports: state.availablePorts,
    graph_nodes: state.graphNodes,
  };

  const text = JSON.stringify(ctx, null, 2);

  return {
    name: "get_graph_context",
    description:
      "查看当前 run ID 和你在 DAG 图中的位置信息，包括上游节点（前驱）、下游节点（后继）" +
      "和可用的输出端口。这是只读工具，不会产生任何副作用。",
    input_schema: {
      type: "object",
      properties: {},
    },
    handler: async () => ({
      content: [{ type: "text" as const, text }],
    }),
  };
}

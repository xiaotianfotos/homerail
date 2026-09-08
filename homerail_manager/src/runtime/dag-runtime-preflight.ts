import type { DAGAgentConfig, DAGGraphData } from "../orchestration/graph.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-resolver.js";
import { normalizeManagerAgentRuntimeAgentType, isDisabledDirectLlmAgentType } from "homerail-protocol";

/** Resolve every reachable role, including advisors, without persisting or
 * exposing the resolved credentials. Run before any native command can spend. */
export function preflightDagAgentRuntimes(graph: DAGGraphData, agents: Record<string, DAGAgentConfig> = {}): void {
  const used = new Set<string>();
  for (const node of graph.nodes) {
    if (node.node_type?.endsWith("_gateway")) continue;
    used.add(node.agent);
    const runtime = node.extra?.agent_runtime as { advisors?: Array<{ agent?: string }> } | undefined;
    for (const advisor of runtime?.advisors ?? []) {
      if (!advisor.agent) throw new Error(`Invalid advisor binding on ${node.node_id}`);
      used.add(advisor.agent);
    }
  }
  for (const id of used) {
    const config = agents[id] ?? {};
    if (isDisabledDirectLlmAgentType(config.agent_type)) throw new Error(`Agent ${id}: direct-llm is disabled`);
    if (normalizeManagerAgentRuntimeAgentType(config.agent_type) === "deterministic") continue;
    try {
      resolveAgentRuntimeConfig({ surface: "dag", settingId: config.llm_setting_id,
        providerName: config.llm?.provider, modelName: config.llm?.model ?? config.model,
        agentType: config.agent_type, reasoningEffort: config.llm?.reasoning_effort, serviceTier: config.llm?.service_tier });
    } catch (error) {
      throw new Error(`Agent ${id} runtime preflight: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

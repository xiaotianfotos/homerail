import type { DAGAgentConfig, ParsedDAG } from "./graph.js";

export interface ProviderPolicyViolation {
  agentId: string;
  provider: string;
  model: string;
  reason: string;
}

function norm(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function effectiveProvider(agent: DAGAgentConfig, dag: ParsedDAG): string {
  if (agent.native_subscription !== undefined) return "openai";
  return agent.llm?.provider ?? dag.meta.llm?.provider ?? "";
}

function effectiveModel(agent: DAGAgentConfig, dag: ParsedDAG): string {
  if (agent.native_subscription !== undefined) return agent.native_subscription.model;
  return agent.llm?.model ?? agent.model ?? dag.meta.llm?.model ?? "";
}

export function findProviderPolicyViolations(dag: ParsedDAG): ProviderPolicyViolation[] {
  const prohibitedProviders = new Set((dag.meta.provider_policy?.prohibited_providers ?? []).map(norm).filter(Boolean));
  const prohibitedModels = new Set((dag.meta.provider_policy?.prohibited_models ?? []).map(norm).filter(Boolean));
  if (prohibitedProviders.size === 0 && prohibitedModels.size === 0) return [];
  const agents = dag.meta.agents ?? {};
  return Object.entries(agents).flatMap(([agentId, agent]) => {
    const provider = effectiveProvider(agent, dag);
    const model = effectiveModel(agent, dag);
    if (!prohibitedProviders.has(norm(provider)) && !prohibitedModels.has(norm(model))) return [];
    return [{
      agentId,
      provider,
      model,
      reason: dag.meta.provider_policy?.reason ?? "provider policy rejected this runtime",
    }];
  });
}

export function assertProviderPolicy(dag: ParsedDAG): void {
  const violations = findProviderPolicyViolations(dag);
  if (violations.length === 0) return;
  const detail = violations
    .map((v) => `${v.agentId}=${v.provider || "<unset>"}/${v.model || "<unset>"}`)
    .join(", ");
  throw new Error(`Provider policy rejected prohibited runtime: ${detail}`);
}

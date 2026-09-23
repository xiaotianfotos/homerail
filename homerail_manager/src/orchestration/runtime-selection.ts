import type { ParsedDAG } from "./graph.js";
import { assertNativeSubscriptionDag } from "../runtime/native-subscription-runtime.js";

export function assertNoYamlProviderRuntime(parsed: ParsedDAG): void {
  assertNativeSubscriptionDag(parsed.graph, parsed.meta.agents);
  const failures: string[] = [];
  const rootLlm = parsed.meta.llm;
  if (rootLlm?.provider) failures.push("llm.provider");
  if (rootLlm?.model) failures.push("llm.model");

  for (const [agentId, agent] of Object.entries(parsed.meta.agents ?? {})) {
    if (agent.model) failures.push(`agents.${agentId}.model`);
    const llm = agent.llm;
    if (!llm) continue;
    for (const key of ["provider", "model", "api_key", "base_url", "protocol"] as const) {
      if (llm[key]) failures.push(`agents.${agentId}.llm.${key}`);
    }
  }

  for (const [profileId, profile] of Object.entries(parsed.meta.runtime_profiles ?? {})) {
    if (profile.llm?.provider) failures.push(`runtime_profiles.${profileId}.llm.provider`);
    if (profile.llm?.model) failures.push(`runtime_profiles.${profileId}.llm.model`);
    for (const [agentId, mapping] of Object.entries(profile.agents ?? {})) {
      if (mapping.provider) failures.push(`runtime_profiles.${profileId}.agents.${agentId}.provider`);
      if (mapping.model) failures.push(`runtime_profiles.${profileId}.agents.${agentId}.model`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `DAG provider/model runtime must be selected from database LLM settings, not YAML. Remove: ${failures.join(", ")}`,
    );
  }
}

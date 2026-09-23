import {
  assertNativeCodexSubscriptionSelection,
  CODEX_SUBSCRIPTION_PROTOCOL,
} from "homerail-protocol";
import type { DAGAgentConfig, DAGGraphData } from "../orchestration/graph.js";

/** This branch never reads database LLM settings or projects account credentials. */
export function resolveNativeSubscriptionAgent(agent: DAGAgentConfig): DAGAgentConfig {
  assertNativeCodexSubscriptionSelection(agent.native_subscription);
  if (agent.llm !== undefined || agent.llm_setting_id !== undefined || agent.model !== undefined
    || (agent.agent_type !== undefined && agent.agent_type !== "codex_appserver")
    || agent.extra !== undefined) {
    throw new Error("native_subscription cannot be combined with API settings, runtime overrides or a different backend");
  }
  return {
    ...agent,
    agent_type: "codex_appserver",
    llm: {
      provider: "openai",
      protocol: CODEX_SUBSCRIPTION_PROTOCOL,
      model: agent.native_subscription.model,
      reasoning_effort: agent.native_subscription.reasoning_effort,
    },
  };
}

export function assertNativeSubscriptionWorkspace(workspace: unknown): void {
  if (workspace === undefined) return;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)
    || Object.keys(workspace).some(key => key !== "mode")
    || !["isolated", "shared"].includes(String((workspace as Record<string, unknown>).mode))) {
    throw new Error("native_subscription workspace accepts only isolated/shared mode; prepare files on the trusted Node before execution");
  }
}

export function assertNativeSubscriptionPolicy(runtime: Record<string, unknown>): void {
  const access = runtime.workspace_access as { writable_paths?: unknown } | undefined;
  if (runtime.codex_sandbox !== "read-only" || !access
    || !Array.isArray(access.writable_paths) || access.writable_paths.length !== 0) {
    throw new Error("native_subscription requires explicit codex_sandbox: read-only and workspace_access.writable_paths: []");
  }
  if (runtime.builtin_tool_policy !== "backend_native" || runtime.allowed_builtin_tools !== undefined) {
    throw new Error("native_subscription requires builtin_tool_policy: backend_native without allowed_builtin_tools");
  }
  if ((Array.isArray(runtime.credentials) && runtime.credentials.length > 0)
    || (Array.isArray(runtime.advisors) && runtime.advisors.length > 0)
    || runtime.session_scope === "dispatch") {
    throw new Error("native_subscription forbids credential injection, advisors and dispatch-scoped sessions");
  }
}

export function assertNativeSubscriptionDag(graph: DAGGraphData, agents: Record<string, DAGAgentConfig> = {}): void {
  for (const agent of Object.values(agents)) {
    if (agent.native_subscription !== undefined) resolveNativeSubscriptionAgent(agent);
  }
  for (const node of graph.nodes) {
    const runtime = (node.extra?.agent_runtime ?? {}) as Record<string, unknown>;
    if (agents[node.agent]?.native_subscription !== undefined) {
      assertNativeSubscriptionPolicy(runtime);
      if (node.image || node.container_group) throw new Error("native_subscription cannot request a container image or group");
    }
    if (node.gateway_config?.worker_agent
      && agents[node.gateway_config.worker_agent]?.native_subscription !== undefined) {
      assertNativeSubscriptionPolicy(node.gateway_config.worker_policy ?? {});
    }
    if (Array.isArray(runtime.advisors) && runtime.advisors.some((value) =>
      value && typeof value === "object" && agents[(value as { agent: string }).agent]?.native_subscription !== undefined)) {
      throw new Error("native_subscription agents must run as dedicated DAG workers, not advisors");
    }
  }
}

/** Check actual worker references as well as declarations; legacy graphs may contain undeclared roles. */
export function usesOnlyNativeSubscriptionWorkers(graph: DAGGraphData | undefined, agents: Record<string, DAGAgentConfig> = {}): boolean {
  const declared = Object.values(agents);
  if (!graph || declared.length === 0 || !declared.every((agent) => agent.native_subscription !== undefined)) return false;
  const used: string[] = [];
  for (const node of graph.nodes) {
    if (!node.node_type.endsWith("_gateway")) used.push(node.agent);
    if (node.gateway_config?.worker_agent) used.push(node.gateway_config.worker_agent);
    const policy = (node.extra?.agent_runtime ?? node.gateway_config?.worker_policy ?? {}) as Record<string, unknown>;
    if (Array.isArray(policy.advisors)) {
      for (const advisor of policy.advisors) {
        if (!advisor || typeof advisor !== "object" || typeof advisor.agent !== "string") return false;
        used.push(advisor.agent);
      }
    }
  }
  return used.length > 0 && used.every((id) => agents[id]?.native_subscription !== undefined);
}

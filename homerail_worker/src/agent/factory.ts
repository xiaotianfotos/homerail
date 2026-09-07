/**
 * Agent client factory — selects backend from AGENT_BACKEND env var.
 * Claude Agent SDK is the default production worker runtime.
 * @version 0.2.0
 */

import type { AgentClient } from "./types.js";
import { DeterministicClient } from "./deterministic.js";
import { ClaudeSdkAdapter } from "./claude-sdk.js";
import { KimiCodeAdapter } from "./kimi-code.js";
import { CodexAppServerAdapter } from "./codex-appserver.js";
import { DeepSeekHarnessAdapter } from "./deepseek-harness.js";
import { ManagerAgentSmokeClient } from "./manager-agent-smoke.js";
import {
  DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  type ManagerAgentRuntimeAgentType,
  normalizeManagerAgentRuntimeAgentType,
} from "homerail-protocol";

const PRODUCTION_REGISTRY: Record<ManagerAgentRuntimeAgentType, () => AgentClient> = {
  "claude-sdk": () => new ClaudeSdkAdapter(),
  codex_appserver: () => new CodexAppServerAdapter(),
  deepseek_harness: () => new DeepSeekHarnessAdapter(),
  kimi_code: () => new KimiCodeAdapter(),
};

const REGISTRY: Record<string, () => AgentClient> = {
  deterministic: () => new DeterministicClient(),
  ...PRODUCTION_REGISTRY,
};

export function workerProductionAgentBackendNamesForTest(): ManagerAgentRuntimeAgentType[] {
  return Object.keys(PRODUCTION_REGISTRY) as ManagerAgentRuntimeAgentType[];
}

export function createAgentClient(backend?: string): AgentClient {
  const raw = backend ?? process.env.AGENT_BACKEND ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE;
  if (raw === "codex") {
    console.warn("[homerail_worker] codex backend is deprecated, use codex_appserver instead");
  }
  const key = normalizeManagerAgentRuntimeAgentType(raw) ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE;
  if (key === "manager-agent-smoke" && process.env.HOMERAIL_MANAGER_AGENT_SMOKE === "1") {
    return new ManagerAgentSmokeClient();
  }
  const factory = REGISTRY[key];
  if (!factory) {
    const available = process.env.HOMERAIL_MANAGER_AGENT_SMOKE === "1"
      ? [...Object.keys(REGISTRY), "manager-agent-smoke"]
      : Object.keys(REGISTRY);
    throw new Error(
      `Unknown agent backend: ${key}. Available: ${available.join(", ")}`,
    );
  }
  return factory();
}

/** Register a custom agent backend at runtime. */
export function registerAgentBackend(name: string, factory: () => AgentClient): void {
  REGISTRY[name] = factory;
}

/**
 * Manager Agent harness and runtime contract.
 * @version 0.1.0
 */

export const ManagerAgentHarness = {
  CLAUDE_AGENT_SDK: "claude_agent_sdk",
  CODEX_APPSERVER: "codex_appserver",
  KIMI_CODE: "kimi_code",
} as const;
export type ManagerAgentHarness = (typeof ManagerAgentHarness)[keyof typeof ManagerAgentHarness];

export const ManagerAgentRuntimePlacement = {
  HOST: "host",
  HOST_SHELL: "host_shell",
  CONTAINER: "container",
} as const;
export type ManagerAgentRuntimePlacement =
  (typeof ManagerAgentRuntimePlacement)[keyof typeof ManagerAgentRuntimePlacement];

// Canonical agent_type strings are intentionally stable because they can appear
// in env vars and persisted runtime config. Aliases accept common spelling
// variants, but these canonical values should not be renamed casually.
export type ManagerAgentRuntimeAgentType = "claude-sdk" | "codex_appserver" | "kimi_code";

// app-server advertises model-specific, forward-compatible effort strings via model/list.
export type ManagerAgentReasoningEffort = string;
export type ManagerAgentServiceTier = string | null;

export interface ManagerAgentHarnessDefinition {
  harness: ManagerAgentHarness;
  agent_type: ManagerAgentRuntimeAgentType;
  runtime_placement: ManagerAgentRuntimePlacement;
}

export const MANAGER_AGENT_HARNESSES: Record<ManagerAgentHarness, ManagerAgentHarnessDefinition> = {
  [ManagerAgentHarness.CODEX_APPSERVER]: {
    harness: ManagerAgentHarness.CODEX_APPSERVER,
    agent_type: "codex_appserver",
    runtime_placement: ManagerAgentRuntimePlacement.HOST,
  },
  [ManagerAgentHarness.KIMI_CODE]: {
    harness: ManagerAgentHarness.KIMI_CODE,
    agent_type: "kimi_code",
    runtime_placement: ManagerAgentRuntimePlacement.CONTAINER,
  },
  [ManagerAgentHarness.CLAUDE_AGENT_SDK]: {
    harness: ManagerAgentHarness.CLAUDE_AGENT_SDK,
    agent_type: "claude-sdk",
    runtime_placement: ManagerAgentRuntimePlacement.CONTAINER,
  },
};

export const DEFAULT_MANAGER_AGENT_HARNESS: ManagerAgentHarness = ManagerAgentHarness.CLAUDE_AGENT_SDK;
export const DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE: ManagerAgentRuntimeAgentType = "claude-sdk";
export const MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES = Object.values(MANAGER_AGENT_HARNESSES)
  .map((definition) => definition.agent_type);

const MANAGER_AGENT_HARNESS_ALIASES: Record<string, ManagerAgentHarness> = {
  claude: ManagerAgentHarness.CLAUDE_AGENT_SDK,
  "claude-sdk": ManagerAgentHarness.CLAUDE_AGENT_SDK,
  claude_agent_sdk: ManagerAgentHarness.CLAUDE_AGENT_SDK,
  "claude-agent-sdk": ManagerAgentHarness.CLAUDE_AGENT_SDK,
  codex: ManagerAgentHarness.CODEX_APPSERVER,
  codex_appserver: ManagerAgentHarness.CODEX_APPSERVER,
  "codex-appserver": ManagerAgentHarness.CODEX_APPSERVER,
  kimi: ManagerAgentHarness.KIMI_CODE,
  kimi_code: ManagerAgentHarness.KIMI_CODE,
  "kimi-code": ManagerAgentHarness.KIMI_CODE,
};

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export interface KimiCodeModelSettingDescriptor {
  providerId?: unknown;
  providerSource?: unknown;
  planType?: unknown;
  protocol?: unknown;
  endpointId?: unknown;
  endpointName?: unknown;
}

const KIMI_CODE_PROVIDER_IDS = new Set(["kimi", "kimi_cn"]);

/** Keep Kimi Code setting compatibility consistent across runtime and setup checks. */
export function isKimiCodeCompatibleModelSetting(
  setting: KimiCodeModelSettingDescriptor,
): boolean {
  const providerId = normalizedString(setting.providerId);
  if (KIMI_CODE_PROVIDER_IDS.has(providerId)) return true;

  const providerSource = normalizedString(setting.providerSource);
  if (providerSource === "builtin") return false;
  if (providerSource === "custom") return true;

  return normalizedString(setting.planType) === "custom" ||
    normalizedString(setting.protocol) === "custom" ||
    normalizedString(setting.endpointId) === "custom" ||
    normalizedString(setting.endpointName) === "custom";
}

export function isManagerAgentHarness(value: unknown): value is ManagerAgentHarness {
  return value === ManagerAgentHarness.CLAUDE_AGENT_SDK ||
    value === ManagerAgentHarness.CODEX_APPSERVER ||
    value === ManagerAgentHarness.KIMI_CODE;
}

export function normalizeManagerAgentHarness(value: unknown): ManagerAgentHarness | undefined {
  const normalized = normalizedString(value);
  return normalized ? MANAGER_AGENT_HARNESS_ALIASES[normalized] : undefined;
}

export function managerAgentHarnessDefinition(harness: ManagerAgentHarness): ManagerAgentHarnessDefinition {
  return MANAGER_AGENT_HARNESSES[harness];
}

export function managerAgentRuntimePlacementForHarness(
  harness: ManagerAgentHarness,
): ManagerAgentRuntimePlacement {
  return managerAgentHarnessDefinition(harness).runtime_placement;
}

export function managerAgentRuntimeAgentTypeForHarness(
  harness: ManagerAgentHarness,
): ManagerAgentRuntimeAgentType {
  return managerAgentHarnessDefinition(harness).agent_type;
}

export function isDisabledDirectLlmAgentType(value: unknown): boolean {
  const normalized = normalizedString(value);
  return normalized === "direct_llm" || normalized === "direct-llm";
}

export function normalizeManagerAgentRuntimeAgentType(value: unknown): string | undefined {
  const normalized = normalizedString(value);
  if (!normalized) return undefined;
  const harness = normalizeManagerAgentHarness(normalized);
  return harness ? managerAgentRuntimeAgentTypeForHarness(harness) : normalized;
}

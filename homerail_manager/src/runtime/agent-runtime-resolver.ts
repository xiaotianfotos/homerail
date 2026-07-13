import {
  findActiveClaudeSdkCompatibleSetting,
  findActiveLlmRuntimeSetting,
  findActiveSetting,
  getProvider,
  getSetting,
  isVoiceServiceSetting,
  resolveClaudeSdkBaseUrlForSetting,
  type LLMSetting,
} from "../persistence/llm-settings.js";
import {
  canonicalModelNameForEndpoint,
  isKimiProviderId,
  KIMI_CN_PROVIDER_ID,
  KIMI_PROVIDER_ID,
} from "../persistence/provider-catalog.js";
import {
  DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  ManagerAgentRuntimePlacement,
  isDisabledDirectLlmAgentType,
  managerAgentHarnessDefinition,
  normalizeManagerAgentHarness,
  normalizeManagerAgentRuntimeAgentType,
  type ManagerAgentHarness,
  type ManagerAgentRuntimePlacement as ManagerAgentRuntimePlacementValue,
} from "homerail-protocol";

export type AgentRuntimeSurface = "manager_agent" | "dag";

export interface AgentRuntimeResolutionInput {
  surface: AgentRuntimeSurface;
  providerName?: string;
  modelName?: string;
  settingId?: string;
  harness?: ManagerAgentHarness | string | null;
  agentType?: string | null;
}

export interface AgentRuntimeResolution {
  provider_name: string;
  model: string;
  api_key: string;
  base_url: string;
  protocol: string;
  agent_type: string;
  runtime_placement: ManagerAgentRuntimePlacementValue;
  llm_setting_id?: string;
}

function runtimePlacementForAgentType(agentType: string, surface: AgentRuntimeSurface): ManagerAgentRuntimePlacementValue {
  if (agentType === managerAgentHarnessDefinition("codex_appserver").agent_type) {
    return managerAgentHarnessDefinition("codex_appserver").runtime_placement;
  }
  if (surface !== "manager_agent") return ManagerAgentRuntimePlacement.CONTAINER;
  const raw = (process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT || process.env.HOMERAIL_MANAGER_AGENT_RUNTIME || "auto")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (raw === "host_shell" || raw === "host") return ManagerAgentRuntimePlacement.HOST_SHELL;
  if (raw === "container") return ManagerAgentRuntimePlacement.CONTAINER;
  return process.platform === "win32"
    ? ManagerAgentRuntimePlacement.HOST_SHELL
    : ManagerAgentRuntimePlacement.CONTAINER;
}

function assertLlmSetting(setting: LLMSetting, labels: { disabled: string; capability: string }): void {
  if (!setting.is_active) {
    throw new Error(`${labels.disabled} LLM setting is disabled: ${setting.provider_id}/${setting.model_name}`);
  }
  if (!setting.supports_llm) {
    throw new Error(`${labels.capability} setting must support LLM runtime, got ${setting.provider_id}/${setting.model_name}`);
  }
  if (isVoiceServiceSetting(setting)) {
    throw new Error(`${labels.capability} setting must be a dedicated LLM runtime, got voice service capabilities on ${setting.provider_id}/${setting.model_name}`);
  }
}

function requestedAgentType(input: AgentRuntimeResolutionInput): string | undefined {
  const harness = normalizeManagerAgentHarness(input.harness);
  if (harness) return managerAgentHarnessDefinition(harness).agent_type;
  return normalizeManagerAgentRuntimeAgentType(input.agentType);
}

function isCustomModelSetting(setting: LLMSetting): boolean {
  const provider = getProvider(setting.provider_id);
  if (provider?.source === "builtin") return false;
  if (provider?.source === "custom") return true;
  return (
    setting.plan_type === "custom" ||
    setting.protocol === "custom" ||
    setting.endpoint_id === "custom" ||
    setting.endpoint_name === "custom"
  );
}

function isKimiCodeCompatibleSetting(setting: LLMSetting): boolean {
  return isKimiProviderId(setting.provider_id) || isCustomModelSetting(setting);
}

function findActiveKimiSetting(modelName?: string): LLMSetting | undefined {
  return findActiveSetting(KIMI_CN_PROVIDER_ID, modelName) ??
    findActiveSetting(KIMI_PROVIDER_ID, modelName) ??
    (modelName === "kimi-k2.7-code"
      ? findActiveSetting(KIMI_CN_PROVIDER_ID, "kimi-for-coding")
      : undefined);
}

function settingForInput(input: AgentRuntimeResolutionInput): LLMSetting {
  const label = input.surface === "manager_agent" ? "Manager" : "DAG";
  const requested = requestedAgentType(input);
  const directlyRequestedSetting = input.providerName
    ? findActiveSetting(input.providerName, input.modelName)
    : undefined;
  const setting = input.settingId
    ? getSetting(input.settingId)
    : input.providerName
    ? directlyRequestedSetting ?? (isKimiProviderId(input.providerName) ? findActiveKimiSetting(input.modelName) : undefined)
    : requested === "kimi_code"
    ? findActiveKimiSetting(input.modelName)
    : input.surface === "manager_agent" || requested === "claude-sdk"
    ? findActiveClaudeSdkCompatibleSetting()
    : input.surface === "dag"
    ? findActiveLlmRuntimeSetting()
    : undefined;
  if (!setting) {
    throw new Error(input.settingId
      ? `Active ${label} LLM setting not found: ${input.settingId}`
      : input.providerName
      ? `Active ${label} LLM setting not found: ${input.providerName}/${input.modelName ?? "*"}`
      : requested === "kimi_code"
      ? `Active Kimi ${label} LLM setting not found: ${input.modelName ?? "*"}`
      : `No active ${label} LLM setting found`);
  }
  assertLlmSetting(setting, {
    disabled: label,
    capability: input.surface === "manager_agent" ? "Manager Agent" : label,
  });
  return setting;
}

function agentTypeForSetting(setting: LLMSetting, input: AgentRuntimeResolutionInput): string {
  const explicit = requestedAgentType(input);
  const requested = explicit ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE;
  if (isKimiProviderId(setting.provider_id) && explicit !== managerAgentHarnessDefinition("claude_agent_sdk").agent_type) {
    return managerAgentHarnessDefinition("kimi_code").agent_type;
  }
  if (requested === "kimi_code") {
    if (isKimiCodeCompatibleSetting(setting)) return managerAgentHarnessDefinition("kimi_code").agent_type;
    throw new Error(`Kimi Code ${input.surface === "manager_agent" ? "Manager Agent" : "DAG"} requires a Kimi or custom setting, got ${setting.provider_id}/${setting.model_name}`);
  }
  return requested;
}

function baseUrlForSetting(setting: LLMSetting, agentType: string): string | undefined {
  if (agentType === "claude-sdk") return resolveClaudeSdkBaseUrlForSetting(setting);
  if (agentType === "kimi_code") return setting.base_url ?? setting.chat_completions_base_url;
  return setting.base_url ?? setting.chat_completions_base_url;
}

export function resolveAgentRuntimeConfig(input: AgentRuntimeResolutionInput): AgentRuntimeResolution {
  const requested = requestedAgentType(input);
  if (isDisabledDirectLlmAgentType(input.agentType) || isDisabledDirectLlmAgentType(input.harness)) {
    throw new Error("direct-llm is disabled for HomeRail runtime execution. Configure a supported harness-backed agent_type.");
  }
  if (requested === "codex_appserver" && input.surface === "manager_agent") {
    const definition = managerAgentHarnessDefinition("codex_appserver");
    return {
      provider_name: "",
      model: input.settingId || input.providerName ? "gpt-5.5" : input.modelName || "gpt-5.5",
      api_key: "",
      base_url: "",
      protocol: "codex_appserver",
      agent_type: definition.agent_type,
      runtime_placement: definition.runtime_placement,
    };
  }

  const setting = settingForInput(input);
  const agentType = agentTypeForSetting(setting, input);
  const baseUrl = baseUrlForSetting(setting, agentType);
  const requestedModel = input.modelName
    ? canonicalModelNameForEndpoint(setting.provider_id, setting.endpoint_id, input.modelName)
    : undefined;
  if (!baseUrl) {
    if (agentType === "claude-sdk") {
      throw new Error(`Claude SDK requires an Anthropic-compatible endpoint for ${setting.provider_id}/${setting.model_name}; Chat Completions endpoints are not supported for harness execution. Configure an Anthropic base URL or use the Kimi Code harness for Kimi.`);
    }
    throw new Error(`No compatible base URL for ${input.surface === "manager_agent" ? "Manager Agent" : "DAG"} setting ${setting.provider_id}/${setting.model_name}`);
  }
  return {
    provider_name: setting.provider_id,
    model: input.settingId ? setting.model_name : requestedModel || setting.model_name,
    api_key: setting.api_key,
    base_url: baseUrl,
    protocol: agentType === "claude-sdk" ? "anthropic_compatible" : setting.protocol,
    agent_type: agentType,
    runtime_placement: runtimePlacementForAgentType(agentType, input.surface),
    llm_setting_id: setting.id,
  };
}

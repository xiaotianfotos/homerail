import {
  findActiveCodexCompatibleSetting,
  findActiveDeepSeekHarnessCompatibleSetting,
  findActiveClaudeSdkCompatibleSetting,
  findActiveLlmRuntimeSetting,
  findActiveSetting,
  getProvider,
  getSetting,
  isVoiceServiceSetting,
  resolveCodexResponsesBaseUrlForSetting,
  resolveDeepSeekHarnessBaseUrlForSetting,
  resolveClaudeSdkBaseUrlForSetting,
  resolveClaudeSdkAuthModeForSetting,
  type LLMSetting,
  type ReasoningEffortMap,
} from "../persistence/llm-settings.js";
import {
  canonicalModelNameForEndpoint,
  findCatalogEndpoint,
  findEndpointModel,
  isKimiProviderId,
  KIMI_CN_PROVIDER_ID,
  KIMI_PROVIDER_ID,
} from "../persistence/provider-catalog.js";
import {
  CODEX_RESPONSES_PROTOCOL,
  codexResponsesModelSupport,
  resolveCodexProviderModelProfile,
  DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  ManagerAgentRuntimePlacement,
  isDisabledDirectLlmAgentType,
  isKimiCodeCompatibleModelSetting,
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
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

export interface AgentRuntimeResolution {
  provider_name: string;
  provider_display_name?: string;
  model: string;
  model_display_name?: string;
  api_key: string;
  base_url: string;
  protocol: string;
  anthropic_auth_mode?: "api_key" | "auth_token";
  agent_type: string;
  runtime_placement: ManagerAgentRuntimePlacementValue;
  llm_setting_id?: string;
  reasoning_effort?: string;
  reasoning_effort_map?: ReasoningEffortMap | false;
  service_tier?: string | null;
}

function runtimePlacementForAgentType(agentType: string, surface: AgentRuntimeSurface): ManagerAgentRuntimePlacementValue {
  if (agentType === managerAgentHarnessDefinition("codex_appserver").agent_type && surface === "manager_agent") {
    return managerAgentHarnessDefinition("codex_appserver").runtime_placement;
  }
  return surface === "manager_agent"
    ? ManagerAgentRuntimePlacement.HOST_SHELL
    : ManagerAgentRuntimePlacement.CONTAINER;
}

function assertLlmSetting(setting: LLMSetting, labels: { disabled: string; capability: string }): void {
  if (setting.preset_status === "missing") {
    throw new Error(setting.preset_diagnostic?.message ??
      `Built-in endpoint is unavailable for ${setting.provider_id}/${setting.endpoint_id ?? "unknown"}`);
  }
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

function isKimiCodeCompatibleSetting(setting: LLMSetting): boolean {
  return isKimiCodeCompatibleModelSetting({
    providerId: setting.provider_id,
    providerSource: getProvider(setting.provider_id)?.source,
    planType: setting.plan_type,
    protocol: setting.protocol,
    endpointId: setting.endpoint_id,
    endpointName: setting.endpoint_name,
  });
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
    : requested === "codex_appserver"
    ? findActiveCodexCompatibleSetting()
    : requested === "deepseek_harness"
    ? findActiveDeepSeekHarnessCompatibleSetting()
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
  if (isKimiProviderId(setting.provider_id) && explicit === undefined) {
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
  if (agentType === "codex_appserver") return resolveCodexResponsesBaseUrlForSetting(setting);
  if (agentType === "kimi_code") return setting.base_url ?? setting.chat_completions_base_url;
  if (agentType === "deepseek_harness") {
    return resolveDeepSeekHarnessBaseUrlForSetting(setting);
  }
  return setting.base_url ?? setting.chat_completions_base_url;
}

export function resolveAgentRuntimeConfig(input: AgentRuntimeResolutionInput): AgentRuntimeResolution {
  const requested = requestedAgentType(input);
  if (isDisabledDirectLlmAgentType(input.agentType) || isDisabledDirectLlmAgentType(input.harness)) {
    throw new Error("direct-llm is disabled for HomeRail runtime execution. Configure a supported harness-backed agent_type.");
  }
  if (requested === "codex_appserver" && input.surface === "manager_agent" && !input.settingId && !input.providerName) {
    const definition = managerAgentHarnessDefinition("codex_appserver");
    const model = input.modelName?.trim();
    if (!model) {
      throw new Error("Codex app-server model is not configured; load the account model catalog before starting the Manager Agent");
    }
    return {
      provider_name: "",
      provider_display_name: "OpenAI",
      model,
      model_display_name: model,
      api_key: "",
      base_url: "",
      protocol: "codex_appserver",
      agent_type: definition.agent_type,
      runtime_placement: definition.runtime_placement,
      ...(input.reasoningEffort?.trim() ? { reasoning_effort: input.reasoningEffort.trim() } : {}),
      service_tier: input.serviceTier?.trim() || null,
    };
  }

  const setting = settingForInput(input);
  const agentType = agentTypeForSetting(setting, input);
  if (agentType === "deepseek_harness" && setting.protocol !== "openai_compatible") {
    throw new Error(`DeepSeek Harness requires an OpenAI-compatible setting, got ${setting.provider_id}/${setting.model_name} (${setting.protocol})`);
  }
  const baseUrl = baseUrlForSetting(setting, agentType);
  const requestedModel = input.modelName
    ? canonicalModelNameForEndpoint(setting.provider_id, setting.endpoint_id, input.modelName)
    : undefined;
  const model = input.settingId ? setting.model_name : requestedModel || setting.model_name;
  const catalogModel = findEndpointModel(
    findCatalogEndpoint(setting.provider_id, setting.endpoint_id),
    model,
  );
  const reasoningEffortMap = model === setting.model_name
    ? setting.reasoning_effort_map
    : catalogModel?.reasoning_effort_map;
  const defaultReasoningEffort = model === setting.model_name
    ? setting.default_reasoning_effort
    : catalogModel?.default_reasoning_effort;
  if (agentType === "codex_appserver" && codexResponsesModelSupport(setting.provider_id, model) === "unsupported") {
    throw new Error(`Codex app-server Responses is not supported for ${setting.provider_id}/${model}`);
  }
  if (!baseUrl) {
    if (agentType === "claude-sdk") {
      throw new Error(`Claude SDK requires an Anthropic-compatible endpoint for ${setting.provider_id}/${setting.model_name}; Chat Completions endpoints are not supported for harness execution. Configure an Anthropic base URL or use the Kimi Code harness for Kimi.`);
    }
    if (agentType === "codex_appserver") {
      throw new Error(`Codex app-server requires a Responses endpoint for ${setting.provider_id}/${setting.model_name}`);
    }
    throw new Error(`No compatible base URL for ${input.surface === "manager_agent" ? "Manager Agent" : "DAG"} setting ${setting.provider_id}/${setting.model_name}`);
  }
  let reasoningEffort: string | undefined;
  let serviceTier: string | null | undefined;
  if (agentType === "codex_appserver") {
    const modelProfile = resolveCodexProviderModelProfile(setting.provider_id, model);
    reasoningEffort = input.reasoningEffort?.trim() || modelProfile?.default_reasoning_effort;
    const supportedEfforts = modelProfile?.supported_reasoning_efforts;
    if (reasoningEffort && supportedEfforts && !supportedEfforts.some((effort) => effort === reasoningEffort)) {
      throw new Error(
        `Codex Responses model '${setting.provider_id}/${model}' does not support reasoning effort '${reasoningEffort}'. ` +
        `Supported values: ${supportedEfforts.join(", ")}.`,
      );
    }
    serviceTier = input.serviceTier?.trim() || null;
    const supportedTiers = modelProfile?.supported_service_tiers;
    if (serviceTier && supportedTiers && !supportedTiers.includes(serviceTier)) {
      throw new Error(
        `Codex Responses model '${setting.provider_id}/${model}' does not support service tier '${serviceTier}'.`,
      );
    }
  } else if (agentType === "deepseek_harness") {
    reasoningEffort = input.reasoningEffort?.trim() || defaultReasoningEffort;
    if (reasoningEffort && (reasoningEffortMap === undefined || reasoningEffortMap === false)) {
      throw new Error(
        `DeepSeek Harness model '${setting.provider_id}/${model}' does not declare selectable reasoning efforts.`,
      );
    }
    if (reasoningEffort && reasoningEffortMap !== undefined && reasoningEffortMap !== false
      && !Object.prototype.hasOwnProperty.call(reasoningEffortMap, reasoningEffort)) {
      throw new Error(
        `DeepSeek Harness model '${setting.provider_id}/${model}' does not support reasoning effort '${reasoningEffort}'. `
        + `Supported values: ${Object.keys(reasoningEffortMap).join(", ")}.`,
      );
    }
  }
  return {
    provider_name: setting.provider_id,
    provider_display_name: getProvider(setting.provider_id)?.name ?? setting.provider_id,
    model,
    model_display_name: model === setting.model_name
      ? setting.display_name ?? catalogModel?.display_name ?? catalogModel?.name ?? model
      : catalogModel?.display_name ?? catalogModel?.name ?? model,
    api_key: setting.api_key,
    base_url: baseUrl,
    protocol: agentType === "claude-sdk"
      ? "anthropic_compatible"
      : agentType === "codex_appserver"
      ? CODEX_RESPONSES_PROTOCOL
      : setting.protocol,
    anthropic_auth_mode: agentType === "claude-sdk"
      ? resolveClaudeSdkAuthModeForSetting(setting)
      : undefined,
    agent_type: agentType,
    runtime_placement: runtimePlacementForAgentType(agentType, input.surface),
    llm_setting_id: setting.id,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(agentType === "deepseek_harness" && reasoningEffortMap !== undefined
      ? { reasoning_effort_map: reasoningEffortMap }
      : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
}

/**
 * Provider/model capabilities that Codex needs in addition to the generic
 * Responses transport contract.
 *
 * Provider profiles are intentionally separate from provider endpoint
 * discovery. A provider may expose Responses for only a subset of its models,
 * and Codex model metadata is more specific than the generic LLM catalog.
 * @version 0.1.0
 */

export type CodexProviderReasoningEffort = "none" | "low" | "high" | "max";

export interface CodexProviderReasoningLevel {
  effort: CodexProviderReasoningEffort;
  description: string;
}

export interface CodexProviderModelCatalogMetadata {
  prefer_websockets: boolean;
  support_verbosity: boolean;
  default_verbosity: string;
  apply_patch_tool_type: string;
  web_search_tool_type: string;
  input_modalities: string[];
  supports_image_detail_original: boolean;
  truncation_policy: { mode: "tokens"; limit: number };
  supports_parallel_tool_calls: boolean;
  tool_mode: null;
  multi_agent_version: string;
  use_responses_lite: boolean;
  include_skills_usage_instructions: boolean;
  auto_review_model_override: null;
  context_window: number;
  max_context_window: number;
  effective_context_window_percent: number;
  auto_compact_token_limit: null;
  comp_hash: string;
  reasoning_summary_format: string;
  default_reasoning_summary: string;
  display_name: string;
  description: string;
  default_reasoning_level: CodexProviderReasoningEffort;
  supported_reasoning_levels: CodexProviderReasoningLevel[];
  shell_type: string;
  visibility: string;
  minimal_client_version: string;
  supported_in_api: boolean;
  availability_nux: null;
  upgrade: null;
  priority: number;
  experimental_supported_tools: string[];
  supports_search_tool: boolean;
  default_service_tier: null;
}

export interface CodexProviderModelProfile {
  model: string;
  responses_supported: boolean;
  default_reasoning_effort?: CodexProviderReasoningEffort;
  supported_reasoning_efforts?: CodexProviderReasoningEffort[];
  supported_service_tiers?: string[];
  catalog_metadata?: CodexProviderModelCatalogMetadata;
}

export interface CodexResponsesProviderProfile {
  provider_id: string;
  /** Known providers fail closed when a model is not explicitly listed. */
  unknown_model_policy: "unsupported" | "fallback";
  models: CodexProviderModelProfile[];
}

const DEEPSEEK_REASONING_LEVELS: CodexProviderReasoningLevel[] = [
  { effort: "none", description: "Disable reasoning" },
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "high", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
];

function deepseekCatalogMetadata(
  displayName: string,
  description: string,
  priority: number,
): CodexProviderModelCatalogMetadata {
  return {
    prefer_websockets: false,
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    input_modalities: ["text"],
    supports_image_detail_original: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    tool_mode: null,
    multi_agent_version: "v2",
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    comp_hash: "3000",
    reasoning_summary_format: "experimental",
    default_reasoning_summary: "none",
    display_name: displayName,
    description,
    default_reasoning_level: "high",
    supported_reasoning_levels: DEEPSEEK_REASONING_LEVELS.map((level) => ({ ...level })),
    shell_type: "shell_command",
    visibility: "list",
    minimal_client_version: "0.144.0",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    experimental_supported_tools: [],
    supports_search_tool: true,
    default_service_tier: null,
  };
}

const CODEX_RESPONSES_PROVIDER_PROFILES: CodexResponsesProviderProfile[] = [
  // Source: DeepSeek's official Codex setup catalog, published 2026-07-31.
  // https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh
  {
    provider_id: "deepseek",
    unknown_model_policy: "unsupported",
    models: [
      {
        model: "deepseek-v4-flash",
        responses_supported: true,
        default_reasoning_effort: "high",
        supported_reasoning_efforts: DEEPSEEK_REASONING_LEVELS.map((level) => level.effort),
        supported_service_tiers: [],
        catalog_metadata: deepseekCatalogMetadata(
          "DeepSeek-V4-Flash",
          "Latest frontier agentic coding model.",
          1,
        ),
      },
      {
        model: "deepseek-v4-pro",
        responses_supported: false,
      },
    ],
  },
];

export function resolveCodexResponsesProviderProfile(
  providerId?: string,
): CodexResponsesProviderProfile | undefined {
  const normalized = providerId?.trim().toLowerCase();
  return normalized
    ? CODEX_RESPONSES_PROVIDER_PROFILES.find((profile) => profile.provider_id === normalized)
    : undefined;
}

export function resolveCodexProviderModelProfile(
  providerId?: string,
  model?: string,
): CodexProviderModelProfile | undefined {
  const profile = resolveCodexResponsesProviderProfile(providerId);
  const normalizedModel = model?.trim();
  return profile && normalizedModel
    ? profile.models.find((candidate) => candidate.model === normalizedModel)
    : undefined;
}

export function codexResponsesModelSupport(
  providerId?: string,
  model?: string,
): "supported" | "unsupported" | "fallback" {
  const provider = resolveCodexResponsesProviderProfile(providerId);
  if (!provider) return "fallback";
  const profile = resolveCodexProviderModelProfile(providerId, model);
  if (!profile) return provider.unknown_model_policy;
  return profile.responses_supported ? "supported" : "unsupported";
}

export function buildCodexProviderModelCatalog(
  profile: CodexProviderModelProfile,
  baseInstructions: string,
): { models: Array<Record<string, unknown>> } {
  if (!profile.responses_supported || !profile.catalog_metadata) {
    throw new Error(`Codex Responses model is unavailable: ${profile.model}`);
  }
  const instructions = baseInstructions.trim();
  if (!instructions) throw new Error("Codex bundled base instructions are required");
  return {
    models: [{
      slug: profile.model,
      base_instructions: instructions,
      ...profile.catalog_metadata,
    }],
  };
}

interface BundledCodexModel {
  base_instructions?: unknown;
}

/**
 * Select the current native Codex contract from the installed CLI catalog.
 * The bundled catalog is ordered by Codex preference, so this deliberately
 * avoids coupling provider profiles to an OpenAI model slug.
 */
export function selectCodexBundledBaseInstructions(rawCatalog: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCatalog);
  } catch (cause) {
    throw new Error(`Codex bundled model catalog is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const models = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { models?: unknown }).models
    : undefined;
  if (!Array.isArray(models)) throw new Error("Codex bundled model catalog does not contain models");
  for (const raw of models as BundledCodexModel[]) {
    const instructions = typeof raw?.base_instructions === "string"
      ? raw.base_instructions.trim()
      : "";
    if (instructions) return instructions;
  }
  throw new Error("Codex bundled model catalog does not contain base instructions");
}

export function buildCodexProviderModelCatalogFromBundled(
  providerId: string | undefined,
  model: string,
  bundledCatalog: string,
): { models: Array<Record<string, unknown>> } | undefined {
  const provider = resolveCodexResponsesProviderProfile(providerId);
  if (!provider) return undefined;
  const profile = resolveCodexProviderModelProfile(providerId, model);
  if (!profile?.responses_supported) {
    throw new Error(`Codex Responses model is unavailable: ${providerId}/${model}`);
  }
  return buildCodexProviderModelCatalog(
    profile,
    selectCodexBundledBaseInstructions(bundledCatalog),
  );
}

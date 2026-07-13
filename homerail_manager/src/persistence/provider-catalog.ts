export type LLMPlanType = "api_billing" | "token_plan" | "coding_plan" | "agent_plan" | "subscription" | "custom";
export type LLMProtocol = "openai_compatible" | "anthropic_compatible" | "dashscope_native" | "volcengine_doubao_voice" | "volcengine_ark_voice" | "volcengine_openspeech" | "custom";
export type LLMAuthType = "bearer" | "api-key" | "x-api-key" | "subscription-key" | "custom";

export interface ModelCapabilities {
  supports_llm?: boolean;
  supports_asr?: boolean;
  supports_tts?: boolean;
  supports_audio_input?: boolean;
  supports_image_input?: boolean;
  supports_video_input?: boolean;
}

export interface ProviderModelPreset extends ModelCapabilities {
  id: string;
  name?: string;
  display_name?: string;
  description?: string;
  recommended?: boolean;
  resource_id?: string;
}

export interface ProviderEndpointPreset extends ModelCapabilities {
  id: string;
  provider_id: string;
  name: string;
  plan_type: LLMPlanType;
  protocol: LLMProtocol;
  base_url: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  resource_id?: string;
  voice_adapter?: "openai_audio" | "mimo_audio" | "volcengine_doubao_voice" | "volcengine_ark_voice" | "volcengine_openspeech" | "custom";
  tts_http_url?: string;
  tts_realtime_url?: string;
  tts_bidirectional_url?: string;
  asr_realtime_url?: string;
  asr_async_url?: string;
  tts_voice?: string;
  tts_format?: string;
  tts_sample_rate?: number;
  region?: string;
  region_label?: string;
  auth_type: LLMAuthType;
  key_hint?: string;
  key_prefix_hint?: string;
  docs_url?: string;
  default_model: string;
  models: ProviderModelPreset[];
}

export interface CatalogProviderInfo extends ModelCapabilities {
  id: string;
  name: string;
  status: "active" | "paused";
  default_model: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  docs_url?: string;
  endpoints: ProviderEndpointPreset[];
}

const VOLCENGINE_PROVIDER_ID = "volcengine";
const LEGACY_DOUBAO_SPEECH_PROVIDER_ID = "doubao-speech";
export const DOUBAO_SPEECH_PROVIDER_ID = VOLCENGINE_PROVIDER_ID;
export const DOUBAO_SPEECH_ENDPOINT_ID = "volcengine_openspeech_api";
export const KIMI_PROVIDER_ID = "kimi";
export const KIMI_CN_PROVIDER_ID = "kimi_cn";
export const KIMI_CODING_PLAN_ENDPOINT_ID = "kimi_coding_plan";

export function isKimiProviderId(providerId?: string): boolean {
  return providerId === KIMI_PROVIDER_ID || providerId === KIMI_CN_PROVIDER_ID;
}

const LEGACY_DOUBAO_SPEECH_ENDPOINT_IDS = new Set([
  "volcengine_ark_agent_plan_voice",
  "volcengine_doubao_voice_token",
  "volcengine_ark_voice_api",
  DOUBAO_SPEECH_ENDPOINT_ID,
]);

function isDoubaoSpeechBaseUrl(value?: string): boolean {
  return normalizeBaseUrl(value) === "https://openspeech.bytedance.com/api/v3" ||
    normalizeBaseUrl(value) === "https://openspeech.bytedance.com/api/v3/plan";
}

export function isDoubaoSpeechModelName(modelName?: string): boolean {
  return modelName === "doubao-seed-tts-2.0" ||
    modelName === "doubao-seed-asr-2.0" ||
    modelName === "doubao-bigasr-1.0";
}

export function normalizeCatalogEndpointId(endpointId?: string): string | undefined {
  return LEGACY_DOUBAO_SPEECH_ENDPOINT_IDS.has(endpointId ?? "")
    ? DOUBAO_SPEECH_ENDPOINT_ID
    : endpointId;
}

export function canonicalProviderIdForEndpoint(
  providerId: string,
  endpointId?: string,
  baseUrl?: string,
  modelName?: string,
): string {
  if (
    providerId === KIMI_PROVIDER_ID &&
    (
      endpointId === KIMI_CODING_PLAN_ENDPOINT_ID ||
      normalizeBaseUrl(baseUrl).startsWith("https://api.kimi.com/coding") ||
      modelName === "kimi-for-coding" ||
      modelName === "kimi-for-coding-highspeed"
    )
  ) {
    return KIMI_CN_PROVIDER_ID;
  }
  if (providerId === LEGACY_DOUBAO_SPEECH_PROVIDER_ID) {
    return VOLCENGINE_PROVIDER_ID;
  }
  if (
    providerId === VOLCENGINE_PROVIDER_ID &&
    (
      LEGACY_DOUBAO_SPEECH_ENDPOINT_IDS.has(endpointId ?? "") ||
      isDoubaoSpeechBaseUrl(baseUrl) ||
      isDoubaoSpeechModelName(modelName)
    )
  ) {
    return VOLCENGINE_PROVIDER_ID;
  }
  return providerId;
}

export function canonicalModelNameForEndpoint(
  providerId: string,
  endpointId: string | undefined,
  modelName: string,
): string {
  const canonicalProviderId = canonicalProviderIdForEndpoint(providerId, endpointId, undefined, modelName);
  if (
    canonicalProviderId === KIMI_CN_PROVIDER_ID &&
    endpointId === KIMI_CODING_PLAN_ENDPOINT_ID &&
    modelName === "kimi-k2.7-code"
  ) {
    return "kimi-for-coding";
  }
  return modelName;
}

function model(id: string, capabilities: ModelCapabilities = {}, extra: Partial<ProviderModelPreset> = {}): ProviderModelPreset {
  return {
    id,
    display_name: extra.display_name ?? id,
    supports_llm: capabilities.supports_llm ?? true,
    supports_asr: capabilities.supports_asr ?? false,
    supports_tts: capabilities.supports_tts ?? false,
    supports_audio_input: capabilities.supports_audio_input ?? false,
    supports_image_input: capabilities.supports_image_input ?? false,
    supports_video_input: capabilities.supports_video_input ?? false,
    ...extra,
  };
}

function endpoint(input: Omit<ProviderEndpointPreset, "models"> & { models?: ProviderModelPreset[] }): ProviderEndpointPreset {
  const chatBaseUrl = input.chat_completions_base_url ??
    (input.protocol === "openai_compatible" ? input.base_url : undefined);
  const responsesBaseUrl = input.responses_base_url;
  const anthropicBaseUrl = input.anthropic_base_url ??
    (input.protocol === "anthropic_compatible" ? input.base_url : undefined);
  return {
    supports_llm: true,
    supports_asr: false,
    supports_tts: false,
    supports_audio_input: false,
    supports_image_input: false,
    supports_video_input: false,
    chat_completions_base_url: chatBaseUrl,
    responses_base_url: responsesBaseUrl,
    anthropic_base_url: anthropicBaseUrl,
    models: input.models ?? [model(input.default_model)],
    ...input,
  };
}

export function baseUrlForProtocol(endpoint: ProviderEndpointPreset | undefined, protocol?: LLMProtocol): string | undefined {
  if (!endpoint) return undefined;
  if (protocol === "openai_compatible") return endpoint.chat_completions_base_url || endpoint.base_url;
  if (protocol === "anthropic_compatible") return endpoint.anthropic_base_url || endpoint.base_url;
  return endpoint.base_url || endpoint.chat_completions_base_url || endpoint.responses_base_url || endpoint.anthropic_base_url;
}

function endpointBaseUrls(endpoint: ProviderEndpointPreset): string[] {
  return [
    endpoint.base_url,
    endpoint.chat_completions_base_url,
    endpoint.responses_base_url,
    endpoint.anthropic_base_url,
  ].filter((value): value is string => Boolean(value));
}

export const DEFAULT_PROVIDER_CATALOG: CatalogProviderInfo[] = [
  {
    id: KIMI_CN_PROVIDER_ID,
    name: "Kimi / Moonshot CN",
    status: "active",
    default_model: "kimi-k2.7-code",
    base_url: "https://api.moonshot.cn/v1",
    docs_url: "https://platform.moonshot.cn/docs/api/overview",
    endpoints: [
      endpoint({
        id: "kimi_cn_api",
        provider_id: KIMI_CN_PROVIDER_ID,
        name: "Kimi CN API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.moonshot.cn/v1",
        chat_completions_base_url: "https://api.moonshot.cn/v1",
        anthropic_base_url: "https://api.moonshot.cn/anthropic",
        auth_type: "bearer",
        key_hint: "Moonshot CN API Key (sk-*)",
        default_model: "kimi-k2.7-code",
        docs_url: "https://platform.moonshot.cn/docs/api/overview",
        models: [
          model("kimi-k2.7-code", {}, { recommended: true }),
          model("kimi-k2.6", { supports_image_input: true, supports_video_input: true }),
        ],
      }),
      endpoint({
        id: KIMI_CODING_PLAN_ENDPOINT_ID,
        provider_id: KIMI_CN_PROVIDER_ID,
        name: "Kimi Coding Plan",
        plan_type: "coding_plan",
        protocol: "openai_compatible",
        base_url: "https://api.kimi.com/coding/v1",
        chat_completions_base_url: "https://api.kimi.com/coding/v1",
        anthropic_base_url: "https://api.kimi.com/coding",
        auth_type: "bearer",
        key_hint: "Kimi Coding Plan Key",
        default_model: "kimi-for-coding",
        docs_url: "https://www.kimi.com/code/docs/",
        models: [
          model("kimi-for-coding", {}, { recommended: true }),
          model("kimi-for-coding-highspeed"),
        ],
      }),
    ],
  },
  {
    id: KIMI_PROVIDER_ID,
    name: "Kimi / Moonshot",
    status: "active",
    default_model: "kimi-k2.7-code",
    base_url: "https://api.moonshot.ai/v1",
    docs_url: "https://platform.kimi.ai/docs/api/overview",
    endpoints: [
      endpoint({
        id: "kimi_api",
        provider_id: KIMI_PROVIDER_ID,
        name: "Kimi API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.moonshot.ai/v1",
        chat_completions_base_url: "https://api.moonshot.ai/v1",
        anthropic_base_url: "https://api.moonshot.ai/anthropic",
        auth_type: "bearer",
        key_hint: "Moonshot API Key (sk-*)",
        default_model: "kimi-k2.7-code",
        docs_url: "https://platform.kimi.ai/docs/api/overview",
        models: [
          model("kimi-k2.7-code", {}, { recommended: true }),
          model("kimi-k2.6", { supports_image_input: true, supports_video_input: true }),
        ],
      }),
    ],
  },
  {
    id: "glm",
    name: "智谱 GLM",
    status: "active",
    default_model: "glm-5.2",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    docs_url: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    endpoints: [
      endpoint({
        id: "glm_api",
        provider_id: "glm",
        name: "GLM API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        chat_completions_base_url: "https://open.bigmodel.cn/api/paas/v4",
        anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
        auth_type: "bearer",
        key_hint: "智谱 API Key",
        default_model: "glm-5.2",
        docs_url: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
        models: [
          model("glm-5.2", {}, { recommended: true }),
          model("glm-5v", { supports_image_input: true }),
        ],
      }),
      endpoint({
        id: "glm_coding_plan",
        provider_id: "glm",
        name: "GLM Coding Plan",
        plan_type: "coding_plan",
        protocol: "openai_compatible",
        base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
        chat_completions_base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
        anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
        auth_type: "bearer",
        key_hint: "GLM Coding 套餐 Key",
        default_model: "glm-5.2",
        docs_url: "https://docs.bigmodel.cn/cn/coding-plan/tool/others",
        models: [model("glm-5.2", {}, { recommended: true })],
      }),
    ],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    status: "active",
    default_model: "mimo-v2.5-pro",
    base_url: "https://token-plan-cn.xiaomimimo.com/anthropic",
    docs_url: "https://mimo.mi.com/docs/zh-CN/api/chat/openai-api",
    endpoints: [
      endpoint({
        id: "xiaomi_mimo_api",
        provider_id: "xiaomi",
        name: "MiMo API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.xiaomimimo.com/v1",
        chat_completions_base_url: "https://api.xiaomimimo.com/v1",
        anthropic_base_url: "https://api.xiaomimimo.com/anthropic",
        auth_type: "bearer",
        key_hint: "MiMo API Key (sk-*)",
        key_prefix_hint: "sk-",
        default_model: "mimo-v2.5-pro",
        models: [
          model("mimo-v2.5-pro", { supports_image_input: true, supports_audio_input: true, supports_video_input: true }, { recommended: true }),
          model("mimo-v2.5-asr", { supports_llm: false, supports_asr: true, supports_audio_input: true }),
          model("mimo-v2.5-tts", { supports_llm: false, supports_tts: true }),
        ],
      }),
      endpoint({
        id: "xiaomi_mimo_token_plan",
        provider_id: "xiaomi",
        name: "MiMo Token Plan",
        plan_type: "token_plan",
        protocol: "openai_compatible",
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        chat_completions_base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        anthropic_base_url: "https://token-plan-cn.xiaomimimo.com/anthropic",
        auth_type: "bearer",
        key_hint: "MiMo Token Plan Key (tp-*)",
        key_prefix_hint: "tp-",
        default_model: "mimo-v2.5-pro",
        docs_url: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
        models: [
          model("mimo-v2.5-pro", { supports_image_input: true, supports_audio_input: true, supports_video_input: true }, { recommended: true }),
          model("mimo-v2.5", { supports_image_input: true, supports_audio_input: true, supports_video_input: true }),
          model("mimo-v2.5-flash"),
          model("mimo-v2-pro", { supports_image_input: true }),
          model("mimo-v2-flash"),
          model("mimo-v2.5-asr", { supports_llm: false, supports_asr: true, supports_audio_input: true }),
          model("mimo-v2.5-tts", { supports_llm: false, supports_tts: true }),
        ],
      }),
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    status: "active",
    default_model: "deepseek-chat",
    base_url: "https://api.deepseek.com",
    docs_url: "https://api-docs.deepseek.com/",
    endpoints: [
      endpoint({
        id: "deepseek_api",
        provider_id: "deepseek",
        name: "DeepSeek API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.deepseek.com",
        chat_completions_base_url: "https://api.deepseek.com",
        anthropic_base_url: "https://api.deepseek.com/anthropic",
        auth_type: "bearer",
        key_hint: "DeepSeek API Key (sk-*)",
        default_model: "deepseek-chat",
        docs_url: "https://api-docs.deepseek.com/",
        models: [model("deepseek-chat", {}, { recommended: true }), model("deepseek-reasoner")],
      }),
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    status: "active",
    default_model: "MiniMax-M3",
    base_url: "https://api.minimax.io/v1",
    docs_url: "https://platform.minimax.io/docs/api-reference/text-openai-api",
    endpoints: [
      endpoint({
        id: "minimax_api",
        provider_id: "minimax",
        name: "MiniMax API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.minimax.io/v1",
        chat_completions_base_url: "https://api.minimax.io/v1",
        anthropic_base_url: "https://api.minimax.io/anthropic",
        auth_type: "bearer",
        key_hint: "MiniMax API Key",
        default_model: "MiniMax-M3",
        docs_url: "https://platform.minimax.io/docs/api-reference/text-openai-api",
        models: [model("MiniMax-M3", {}, { recommended: true }), model("MiniMax-M2.7"), model("MiniMax-M2.5")],
      }),
      endpoint({
        id: "minimax_token_plan",
        provider_id: "minimax",
        name: "MiniMax Token Plan",
        plan_type: "token_plan",
        protocol: "openai_compatible",
        base_url: "https://api.minimax.io/v1",
        chat_completions_base_url: "https://api.minimax.io/v1",
        anthropic_base_url: "https://api.minimax.io/anthropic",
        auth_type: "subscription-key",
        key_hint: "MiniMax Subscription Key",
        default_model: "MiniMax-M3",
        docs_url: "https://platform.minimax.io/docs/token-plan/other-tools",
        models: [model("MiniMax-M3", {}, { recommended: true }), model("MiniMax-M2.7"), model("MiniMax-M2.5")],
      }),
    ],
  },
  {
    id: "minimax_cn",
    name: "MiniMax CN",
    status: "active",
    default_model: "MiniMax-M3",
    base_url: "https://api.minimaxi.com/v1",
    docs_url: "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
    endpoints: [
      endpoint({
        id: "minimax_cn_api",
        provider_id: "minimax_cn",
        name: "MiniMax CN API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://api.minimaxi.com/v1",
        chat_completions_base_url: "https://api.minimaxi.com/v1",
        anthropic_base_url: "https://api.minimaxi.com/anthropic",
        auth_type: "bearer",
        key_hint: "MiniMax CN API Key",
        default_model: "MiniMax-M3",
        docs_url: "https://platform.minimaxi.com/docs/api-reference/text-openai-api",
        models: [model("MiniMax-M3", {}, { recommended: true }), model("MiniMax-M2.7"), model("MiniMax-M2.5")],
      }),
      endpoint({
        id: "minimax_cn_token_plan",
        provider_id: "minimax_cn",
        name: "MiniMax CN Token Plan",
        plan_type: "token_plan",
        protocol: "openai_compatible",
        base_url: "https://api.minimaxi.com/v1",
        chat_completions_base_url: "https://api.minimaxi.com/v1",
        anthropic_base_url: "https://api.minimaxi.com/anthropic",
        auth_type: "subscription-key",
        key_hint: "MiniMax CN Subscription Key",
        default_model: "MiniMax-M3",
        docs_url: "https://platform.minimaxi.com/docs/token-plan/other-tools",
        models: [model("MiniMax-M3", {}, { recommended: true }), model("MiniMax-M2.7"), model("MiniMax-M2.5")],
      }),
    ],
  },
  {
    id: "aliyun",
    name: "阿里云百炼 / DashScope",
    status: "active",
    default_model: "qwen-plus",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docs_url: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    endpoints: [
      endpoint({
        id: "aliyun_dashscope_cn_api",
        provider_id: "aliyun",
        name: "DashScope 中国大陆 - API 计费",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        chat_completions_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        anthropic_base_url: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
        region: "cn-beijing",
        region_label: "中国大陆",
        auth_type: "bearer",
        key_hint: "DashScope API Key (sk-*)",
        default_model: "qwen-plus",
        docs_url: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
        models: [
          model("qwen-plus", {}, { recommended: true }),
          model("qwen-max"),
          model("qwen3-coder-plus"),
          model("qwen-turbo"),
          model("qwen3-asr-flash", { supports_llm: false, supports_asr: true, supports_audio_input: true }),
        ],
      }),
      endpoint({
        id: "aliyun_dashscope_cn_coding",
        provider_id: "aliyun",
        name: "DashScope 中国大陆 - Coding Plan",
        plan_type: "coding_plan",
        protocol: "openai_compatible",
        base_url: "https://coding.dashscope.aliyuncs.com/v1",
        chat_completions_base_url: "https://coding.dashscope.aliyuncs.com/v1",
        anthropic_base_url: "https://coding.dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
        region: "cn-beijing",
        region_label: "中国大陆",
        auth_type: "bearer",
        key_hint: "Qwen Code 订阅 Key",
        default_model: "qwen3-coder-plus",
        docs_url: "https://qwenlm.github.io/blog/qwen3-coder/",
        models: [model("qwen3-coder-plus", {}, { recommended: true })],
      }),
    ],
  },
  {
    id: "volcengine",
    name: "火山方舟",
    status: "active",
    default_model: "doubao-1.5-pro-32k",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    docs_url: "https://www.volcengine.com/docs/82379",
    endpoints: [
      endpoint({
        id: "volcengine_ark_openai",
        provider_id: "volcengine",
        name: "方舟 API - OpenAI Compatible",
        plan_type: "api_billing",
        protocol: "openai_compatible",
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        chat_completions_base_url: "https://ark.cn-beijing.volces.com/api/v3",
        anthropic_base_url: "https://ark.cn-beijing.volces.com/api/v3/anthropic",
        auth_type: "bearer",
        key_hint: "火山引擎 API Key",
        default_model: "doubao-1.5-pro-32k",
        docs_url: "https://www.volcengine.com/docs/82379/1544106",
        models: [
          model("doubao-1.5-pro-32k", {}, { recommended: true }),
          model("doubao-1.5-pro-256k"),
          model("doubao-1.5-lite-32k"),
          model("doubao-1.5-thinking-pro"),
        ],
      }),
      endpoint({
        id: "volcengine_ark_anthropic",
        provider_id: "volcengine",
        name: "方舟 API - Anthropic Compatible",
        plan_type: "api_billing",
        protocol: "anthropic_compatible",
        base_url: "https://ark.cn-beijing.volces.com/api/v3/anthropic",
        chat_completions_base_url: "https://ark.cn-beijing.volces.com/api/v3",
        anthropic_base_url: "https://ark.cn-beijing.volces.com/api/v3/anthropic",
        auth_type: "bearer",
        key_hint: "火山引擎 API Key",
        default_model: "doubao-1.5-pro-32k",
        docs_url: "https://www.volcengine.com/docs/82379/1544106",
        models: [
          model("doubao-1.5-pro-32k", {}, { recommended: true }),
          model("doubao-1.5-pro-256k"),
          model("doubao-1.5-lite-32k"),
        ],
      }),
      endpoint({
        id: DOUBAO_SPEECH_ENDPOINT_ID,
        provider_id: "volcengine",
        name: "火山语音 API（openspeech）",
        plan_type: "api_billing",
        protocol: "volcengine_openspeech",
        base_url: "https://openspeech.bytedance.com/api/v3",
        tts_http_url: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        tts_realtime_url: "wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream",
        tts_bidirectional_url: "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
        asr_realtime_url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
        asr_async_url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
        resource_id: "seed-tts-2.0",
        voice_adapter: "volcengine_openspeech",
        auth_type: "x-api-key",
        key_hint: "火山语音控制台 X-Api-Key（不是火山方舟模型 API Key）",
        default_model: "doubao-seed-tts-2.0",
        docs_url: "https://www.volcengine.com/docs/6561/1719100?lang=zh",
        supports_llm: false,
        supports_asr: true,
        supports_tts: true,
        supports_audio_input: true,
        tts_voice: "zh_female_vv_uranus_bigtts",
        tts_format: "mp3",
        tts_sample_rate: 24000,
        models: [
          model("doubao-seed-tts-2.0", {
            supports_llm: false,
            supports_tts: true,
          }, {
            recommended: true,
            resource_id: "seed-tts-2.0",
          }),
          model("doubao-seed-asr-2.0", {
            supports_llm: false,
            supports_asr: true,
            supports_audio_input: true,
          }, {
            recommended: true,
            resource_id: "volc.seedasr.sauc.duration",
          }),
          model("doubao-bigasr-1.0", {
            supports_llm: false,
            supports_asr: true,
            supports_audio_input: true,
          }, {
            display_name: "火山语音识别 1.0",
            resource_id: "volc.bigasr.sauc.duration",
          }),
        ],
      }),
    ],
  },
];

export function cloneProvider(provider: CatalogProviderInfo): CatalogProviderInfo {
  return {
    ...provider,
    endpoints: provider.endpoints.map((ep) => ({
      ...ep,
      models: ep.models.map((item) => ({ ...item })),
    })),
  };
}

export function listCatalogProviders(): CatalogProviderInfo[] {
  return DEFAULT_PROVIDER_CATALOG.map(cloneProvider);
}

export function findCatalogProvider(providerId: string): CatalogProviderInfo | undefined {
  return DEFAULT_PROVIDER_CATALOG.find((provider) => provider.id === providerId);
}

export function findCatalogEndpoint(providerId: string, endpointId?: string): ProviderEndpointPreset | undefined {
  const canonicalProviderId = canonicalProviderIdForEndpoint(providerId, endpointId);
  const provider = findCatalogProvider(canonicalProviderId);
  if (!provider) return undefined;
  const normalizedEndpointId = normalizeCatalogEndpointId(endpointId);
  if (normalizedEndpointId) return provider.endpoints.find((endpoint) => endpoint.id === normalizedEndpointId);
  return provider.endpoints[0];
}

function normalizeBaseUrl(value?: string): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function inferCatalogEndpoint(providerId: string, baseUrl?: string): ProviderEndpointPreset | undefined {
  const canonicalProviderId = canonicalProviderIdForEndpoint(providerId, undefined, baseUrl);
  const provider = findCatalogProvider(canonicalProviderId);
  if (!provider) return undefined;
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return provider.endpoints[0];
  if (canonicalProviderId === VOLCENGINE_PROVIDER_ID && isDoubaoSpeechBaseUrl(baseUrl)) {
    return provider.endpoints.find((endpoint) => endpoint.id === DOUBAO_SPEECH_ENDPOINT_ID) ?? provider.endpoints[0];
  }
  const exactPrimary = provider.endpoints.find((endpoint) => normalizeBaseUrl(endpoint.base_url) === normalized);
  if (exactPrimary) return exactPrimary;
  return provider.endpoints.find((endpoint) =>
    endpointBaseUrls(endpoint).some((url) => normalizeBaseUrl(url) === normalized)
  ) ?? provider.endpoints[0];
}

export function findEndpointModel(endpoint: ProviderEndpointPreset | undefined, modelName?: string): ProviderModelPreset | undefined {
  if (!endpoint || !modelName) return undefined;
  return endpoint.models.find((item) => item.id === modelName || item.name === modelName || item.display_name === modelName);
}

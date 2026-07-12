import * as http from "node:http";
import {
  getDefaultProviders,
  getProvider,
  upsertProvider,
  updateProvider,
  deleteProvider,
  listSettings,
  getSetting,
  createSetting,
  updateSetting,
  deleteSetting,
  maskApiKey,
  type LLMSetting,
  type LLMPlanType,
  type LLMProtocol,
  type LLMAuthType,
  type ProviderInput,
} from "../persistence/llm-settings.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function _notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function _conflict(res: http.ServerResponse, message: string) {
  json(res, 409, { success: false, message, error: message });
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function _isOpenSpeechBaseUrl(value: string): boolean {
  const normalized = _normalizedBaseUrl(value);
  return normalized === "https://openspeech.bytedance.com/api/v3" ||
    normalized === "https://openspeech.bytedance.com/api/v3/plan";
}

function _catalogModelsForBaseUrl(baseUrl: string): string[] | undefined {
  if (!_isOpenSpeechBaseUrl(baseUrl)) return undefined;
  const endpoint = getDefaultProviders()
    .flatMap((provider) => provider.endpoints ?? [])
    .find((candidate) => candidate.protocol === "volcengine_openspeech");
  return endpoint?.models.map((model) => model.id) ?? [];
}

function _created(res: http.ServerResponse, message: string, data: unknown) {
  json(res, 201, { success: true, message, data });
}

async function _readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _capabilities(setting: LLMSetting): string[] {
  const caps: string[] = [];
  if (setting.supports_llm) caps.push("llm");
  if (setting.supports_asr) caps.push("asr");
  if (setting.supports_tts) caps.push("tts");
  if (setting.supports_audio_input) caps.push("audio_input");
  if (setting.supports_image_input) caps.push("vision");
  if (setting.supports_video_input) caps.push("video_input");
  return caps;
}

function _maskSetting(setting: LLMSetting) {
  const provider = getProvider(setting.provider_id);
  const endpoint = provider?.endpoints?.find((item) => item.id === setting.endpoint_id);
  const baseUrl = setting.base_url ?? endpoint?.base_url ?? provider?.base_url;
  const chatBaseUrl = setting.chat_completions_base_url ?? endpoint?.chat_completions_base_url ??
    provider?.chat_completions_base_url;
  const responsesBaseUrl = setting.responses_base_url ?? endpoint?.responses_base_url ?? provider?.responses_base_url;
  const anthropicBaseUrl = setting.anthropic_base_url ?? endpoint?.anthropic_base_url ?? provider?.anthropic_base_url;
  const apiKey = maskApiKey(setting.api_key);
  return {
    ...setting,
    provider_name: provider?.name ?? setting.provider_id,
    provider_source: provider?.source,
    provider_readonly: provider?.readonly,
    provider_base_url: baseUrl,
    chat_completions_base_url: chatBaseUrl,
    responses_base_url: responsesBaseUrl,
    anthropic_base_url: anthropicBaseUrl,
    endpoint_name: setting.endpoint_name ?? endpoint?.name,
    api_key: apiKey,
    api_key_display: apiKey,
    capabilities: _capabilities(setting),
  };
}

const SETTINGS_BASE_PATHS = ["/api/llm-settings", "/api/llm/settings"];

function _isSettingsBasePath(pathname: string): boolean {
  return SETTINGS_BASE_PATHS.includes(pathname);
}

function _settingsIdFromPath(pathname: string): string | undefined {
  for (const basePath of SETTINGS_BASE_PATHS) {
    const prefix = `${basePath}/`;
    if (pathname.startsWith(prefix)) {
      const id = pathname.slice(prefix.length);
      return id && !id.includes("/") ? decodeURIComponent(id) : undefined;
    }
  }
  return undefined;
}

function _requiredString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _planType(value: unknown): LLMPlanType | undefined {
  return value === "api_billing" || value === "token_plan" || value === "coding_plan" ||
      value === "agent_plan" || value === "subscription" || value === "custom"
    ? value
    : undefined;
}

function _protocol(value: unknown): LLMProtocol | undefined {
  return value === "openai_compatible" || value === "anthropic_compatible" || value === "dashscope_native" ||
      value === "volcengine_doubao_voice" || value === "volcengine_ark_voice" ||
      value === "volcengine_openspeech" || value === "custom"
    ? value
    : undefined;
}

function _authType(value: unknown): LLMAuthType | undefined {
  return value === "bearer" || value === "api-key" || value === "x-api-key" || value === "subscription-key" ||
      value === "custom"
    ? value
    : undefined;
}

function _voiceAdapter(value: unknown): ProviderInput["voice_adapter"] {
  return value === "openai_audio" || value === "mimo_audio" ||
      value === "volcengine_doubao_voice" || value === "volcengine_ark_voice" ||
      value === "volcengine_openspeech" || value === "custom"
    ? value
    : undefined;
}

function _providerBody(body: Record<string, unknown>, idOverride?: string): ProviderInput {
  return {
    id: idOverride ?? _requiredString(body, "id") ?? "",
    name: typeof body.name === "string" ? body.name : undefined,
    status: body.status === "paused" ? "paused" as const : body.status === "active" ? "active" as const : undefined,
    default_model: _requiredString(body, "default_model") ??
      (typeof body.defaultModel === "string" ? body.defaultModel.trim() : undefined),
    base_url: typeof body.base_url === "string" ? body.base_url : undefined,
    chat_completions_base_url: typeof body.chat_completions_base_url === "string"
      ? body.chat_completions_base_url
      : undefined,
    responses_base_url: typeof body.responses_base_url === "string" ? body.responses_base_url : undefined,
    anthropic_base_url: typeof body.anthropic_base_url === "string" ? body.anthropic_base_url : undefined,
    voice_adapter: _voiceAdapter(body.voice_adapter),
    tts_http_url: typeof body.tts_http_url === "string" ? body.tts_http_url : undefined,
    tts_realtime_url: typeof body.tts_realtime_url === "string" ? body.tts_realtime_url : undefined,
    asr_realtime_url: typeof body.asr_realtime_url === "string" ? body.asr_realtime_url : undefined,
    asr_async_url: typeof body.asr_async_url === "string" ? body.asr_async_url : undefined,
    supports_llm: typeof body.supports_llm === "boolean" ? body.supports_llm : undefined,
    supports_asr: typeof body.supports_asr === "boolean" ? body.supports_asr : undefined,
    supports_tts: typeof body.supports_tts === "boolean" ? body.supports_tts : undefined,
    supports_audio_input: typeof body.supports_audio_input === "boolean" ? body.supports_audio_input : undefined,
    supports_image_input: typeof body.supports_image_input === "boolean" ? body.supports_image_input : undefined,
    supports_video_input: typeof body.supports_video_input === "boolean" ? body.supports_video_input : undefined,
  };
}

function _settingCreateBody(b: Record<string, unknown>) {
  return {
    provider_id: _requiredString(b, "provider_id"),
    model_name: _requiredString(b, "model_name"),
    // 多模型凭证：models 是字符串数组，第一个作为 model_name（向后兼容）
    models: Array.isArray(b.models) && b.models.every((m) => typeof m === "string")
      ? b.models as string[]
      : undefined,
    api_key: _requiredString(b, "api_key"),
    reuse_existing_api_key: b.reuse_existing_api_key === true,
    display_name: _requiredString(b, "display_name") ?? _requiredString(b, "alias"),
    alias: _requiredString(b, "alias"),
    endpoint_id: _requiredString(b, "endpoint_id"),
    endpoint_name: _requiredString(b, "endpoint_name"),
    plan_type: _planType(b.plan_type),
    protocol: _protocol(b.protocol),
    auth_type: _authType(b.auth_type),
    key_hint: _requiredString(b, "key_hint"),
    base_url: typeof b.base_url === "string" ? b.base_url : undefined,
    chat_completions_base_url: typeof b.chat_completions_base_url === "string" ? b.chat_completions_base_url : undefined,
    responses_base_url: typeof b.responses_base_url === "string" ? b.responses_base_url : undefined,
    anthropic_base_url: typeof b.anthropic_base_url === "string" ? b.anthropic_base_url : undefined,
    resource_id: _requiredString(b, "resource_id"),
    voice_adapter: _requiredString(b, "voice_adapter"),
    tts_http_url: _requiredString(b, "tts_http_url"),
    tts_realtime_url: _requiredString(b, "tts_realtime_url"),
    tts_bidirectional_url: _requiredString(b, "tts_bidirectional_url"),
    asr_realtime_url: _requiredString(b, "asr_realtime_url"),
    asr_async_url: _requiredString(b, "asr_async_url"),
    tts_voice: _requiredString(b, "tts_voice"),
    tts_format: _requiredString(b, "tts_format"),
    tts_sample_rate: typeof b.tts_sample_rate === "number" ? b.tts_sample_rate : undefined,
    is_active: typeof b.is_active === "boolean" ? b.is_active : undefined,
    is_default: typeof b.is_default === "boolean" ? b.is_default : undefined,
    supports_llm: typeof b.supports_llm === "boolean" ? b.supports_llm : undefined,
    supports_asr: typeof b.supports_asr === "boolean" ? b.supports_asr : undefined,
    supports_tts: typeof b.supports_tts === "boolean" ? b.supports_tts : undefined,
    supports_audio_input: typeof b.supports_audio_input === "boolean" ? b.supports_audio_input : undefined,
    supports_image_input: typeof b.supports_image_input === "boolean" ? b.supports_image_input : undefined,
    supports_video_input: typeof b.supports_video_input === "boolean" ? b.supports_video_input : undefined,
  };
}

export function llmSettingsRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;

  // GET /api/providers or frontend-compatible GET /api/llm/providers
  if ((pathname === "/api/providers" || pathname === "/api/llm/providers") && req.method === "GET") {
    const providers = getDefaultProviders();
    _ok(res, `Found ${providers.length} providers`, { providers, total: providers.length });
    return true;
  }

  // POST /api/providers or /api/llm/providers
  if ((pathname === "/api/providers" || pathname === "/api/llm/providers") && req.method === "POST") {
    _readJsonBody(req)
      .then((body) => {
        try {
          const provider = upsertProvider(_providerBody(body as Record<string, unknown>));
          _created(res, "Provider upserted", provider);
        } catch (err) {
          _badRequest(res, err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  const providerModelsMatch = pathname.match(/^\/api\/(?:llm\/)?providers\/([^/]+)\/models$/);
  if (providerModelsMatch && req.method === "GET") {
    const id = decodeURIComponent(providerModelsMatch[1]);
    const provider = getProvider(id);
    if (!provider) {
      _notFound(res, `Provider not found: ${id}`);
      return true;
    }
    const models = Array.from(new Set((provider.endpoints ?? []).flatMap((endpoint) =>
      endpoint.models.length ? endpoint.models.map((model) => model.id) : [endpoint.default_model]
    )));
    _ok(res, "Provider models retrieved", {
      provider_id: provider.id,
      provider_name: provider.name,
      models,
    });
    return true;
  }

  if (pathname === "/api/llm/models/common" && req.method === "GET") {
    const models: Record<string, string[]> = {};
    for (const provider of getDefaultProviders()) {
      models[provider.id] = Array.from(new Set((provider.endpoints ?? []).flatMap((endpoint) =>
        endpoint.models.length ? endpoint.models.map((model) => model.id) : [endpoint.default_model]
      )));
    }
    _ok(res, "Common models retrieved", { models });
    return true;
  }

  // POST /api/llm/models/probe — 动态探测供应商可用模型
  // 后端代理调用供应商的 /v1/models 端点（避免浏览器 CORS），
  // 返回实际可用的模型 ID 列表。用于"填 Key 后自动拉取模型"。
  if (pathname === "/api/llm/models/probe" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        const b = body as Record<string, unknown>;
        const baseUrl = typeof b.base_url === "string" ? b.base_url.trim().replace(/\/+$/, "") : "";
        const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
        if (!baseUrl) {
          _badRequest(res, "Missing required field: base_url");
          return;
        }
        if (!apiKey) {
          _badRequest(res, "Missing required field: api_key");
          return;
        }
        const catalogModels = _catalogModelsForBaseUrl(baseUrl);
        if (catalogModels) {
          _ok(res, `Probed ${catalogModels.length} catalog models`, { models: catalogModels });
          return;
        }
        // 构造 /models 请求 URL
        const modelsUrl = baseUrl.endsWith("/v1")
          ? `${baseUrl}/models`
          : `${baseUrl}/v1/models`;
        try {
          const upstream = await fetch(modelsUrl, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "x-api-key": apiKey,
            },
            signal: AbortSignal.timeout(8000),
          });
          if (!upstream.ok) {
            const text = await upstream.text().catch(() => "");
            _ok(res, "Probe completed with error", {
              models: [],
              error: `HTTP ${upstream.status}: ${text.slice(0, 200)}`,
            });
            return;
          }
          const data = await upstream.json() as { data?: Array<{ id: string }> };
          const models = Array.isArray(data?.data)
            ? data!.data!.map((m) => m.id).filter(Boolean).sort()
            : [];
          _ok(res, `Probed ${models.length} models`, { models });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          _ok(res, "Probe failed", { models: [], error: message });
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  const providerMatch = pathname.match(/^\/api\/(?:llm\/)?providers\/([^/]+)$/);
  if (providerMatch && req.method === "GET") {
    const id = decodeURIComponent(providerMatch[1]);
    const provider = getProvider(id);
    if (!provider) {
      _notFound(res, `Provider not found: ${id}`);
      return true;
    }
    _ok(res, "Provider retrieved", provider);
    return true;
  }

  if (providerMatch && req.method === "PUT") {
    const id = decodeURIComponent(providerMatch[1]);
    _readJsonBody(req)
      .then((body) => {
        try {
          const provider = updateProvider(id, _providerBody(body as Record<string, unknown>, id));
          _ok(res, "Provider updated", provider);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not found")) _notFound(res, message);
          else _badRequest(res, message);
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  if (providerMatch && req.method === "DELETE") {
    const id = decodeURIComponent(providerMatch[1]);
    const cascade = requestUrl.searchParams.get("cascade") === "true";
    try {
      const removed = deleteProvider(id, { cascade });
      if (!removed) {
        _notFound(res, `Provider not found: ${id}`);
        return true;
      }
      _ok(res, "Provider deleted", { id, cascade });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("is referenced by")) _conflict(res, message);
      else _badRequest(res, message);
    }
    return true;
  }

  // GET /api/llm-settings
  if (_isSettingsBasePath(pathname) && req.method === "GET") {
    const url = new URL(req.url || "/", "http://localhost");
    const providerId = url.searchParams.get("provider_id");
    const settings = listSettings()
      .filter((setting) => !providerId || setting.provider_id === providerId)
      .map(_maskSetting);
    _ok(res, `Found ${settings.length} settings`, { settings, total: settings.length });
    return true;
  }

  // POST /api/llm-settings or /api/llm/settings
  if (_isSettingsBasePath(pathname) && req.method === "POST") {
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const parsed = _settingCreateBody(b);

        if (!parsed.provider_id) {
          _badRequest(res, "Missing required field: provider_id");
          return;
        }
        if (!parsed.model_name) {
          _badRequest(res, "Missing required field: model_name");
          return;
        }
        if (parsed.api_key === "__reuse_existing__") {
          _badRequest(res, "Reserved API key value: __reuse_existing__; use reuse_existing_api_key instead");
          return;
        }
        if (parsed.api_key && parsed.reuse_existing_api_key) {
          _badRequest(res, "api_key and reuse_existing_api_key are mutually exclusive");
          return;
        }
        if (!parsed.api_key && !parsed.reuse_existing_api_key) {
          _badRequest(res, "Missing required field: api_key");
          return;
        }

        try {
          const setting = createSetting({
            ...parsed,
            provider_id: parsed.provider_id,
            model_name: parsed.model_name,
            api_key: parsed.api_key ?? "",
          });
          _created(res, "Setting created", _maskSetting(setting));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          _badRequest(res, message);
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // GET /api/llm-settings/:id or /api/llm/settings/:id
  const settingsId = _settingsIdFromPath(pathname);
  if (settingsId && req.method === "GET") {
    const id = settingsId;
    const setting = getSetting(id);
    if (!setting) {
      _notFound(res, `Setting not found: ${id}`);
      return true;
    }
    _ok(res, "Setting retrieved", _maskSetting(setting));
    return true;
  }

  // PUT /api/llm-settings/:id or /api/llm/settings/:id
  if (settingsId && req.method === "PUT") {
    const id = settingsId;
    _readJsonBody(req)
      .then((body) => {
        const b = body as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const field of ["provider_id", "model_name", "api_key"]) {
          if (field in b && !_requiredString(b, field)) {
            _badRequest(res, `Invalid field: ${field}`);
            return;
          }
        }
        if (typeof b.provider_id === "string") patch.provider_id = b.provider_id.trim();
        if (typeof b.model_name === "string") patch.model_name = b.model_name.trim();
        if (Array.isArray(b.models) && b.models.every((m) => typeof m === "string")) {
          patch.models = b.models as string[];
        }
        if (typeof b.api_key === "string") patch.api_key = b.api_key.trim();
        if (typeof b.display_name === "string") patch.display_name = b.display_name.trim();
        if (typeof b.alias === "string") patch.display_name = b.alias.trim();
        if (typeof b.endpoint_id === "string") patch.endpoint_id = b.endpoint_id.trim();
        if (typeof b.endpoint_name === "string") patch.endpoint_name = b.endpoint_name.trim();
        if (_planType(b.plan_type)) patch.plan_type = _planType(b.plan_type);
        if (_protocol(b.protocol)) patch.protocol = _protocol(b.protocol);
        if (_authType(b.auth_type)) patch.auth_type = _authType(b.auth_type);
        if (typeof b.key_hint === "string") patch.key_hint = b.key_hint.trim();
        if (typeof b.base_url === "string") patch.base_url = b.base_url;
        if (typeof b.chat_completions_base_url === "string") {
          patch.chat_completions_base_url = b.chat_completions_base_url;
        }
        if (typeof b.responses_base_url === "string") patch.responses_base_url = b.responses_base_url;
        if (typeof b.anthropic_base_url === "string") patch.anthropic_base_url = b.anthropic_base_url;
        if (typeof b.resource_id === "string") patch.resource_id = b.resource_id.trim();
        if (typeof b.voice_adapter === "string") patch.voice_adapter = b.voice_adapter.trim();
        if (typeof b.tts_http_url === "string") patch.tts_http_url = b.tts_http_url.trim();
        if (typeof b.tts_realtime_url === "string") patch.tts_realtime_url = b.tts_realtime_url.trim();
        if (typeof b.tts_bidirectional_url === "string") patch.tts_bidirectional_url = b.tts_bidirectional_url.trim();
        if (typeof b.asr_realtime_url === "string") patch.asr_realtime_url = b.asr_realtime_url.trim();
        if (typeof b.asr_async_url === "string") patch.asr_async_url = b.asr_async_url.trim();
        if (typeof b.tts_voice === "string") patch.tts_voice = b.tts_voice.trim();
        if (typeof b.tts_format === "string") patch.tts_format = b.tts_format.trim();
        if (typeof b.tts_sample_rate === "number") patch.tts_sample_rate = b.tts_sample_rate;
        if (typeof b.is_active === "boolean") patch.is_active = b.is_active;
        if (typeof b.is_default === "boolean") patch.is_default = b.is_default;
        if (typeof b.supports_llm === "boolean") patch.supports_llm = b.supports_llm;
        if (typeof b.supports_asr === "boolean") patch.supports_asr = b.supports_asr;
        if (typeof b.supports_tts === "boolean") patch.supports_tts = b.supports_tts;
        if (typeof b.supports_audio_input === "boolean") patch.supports_audio_input = b.supports_audio_input;
        if (typeof b.supports_image_input === "boolean") patch.supports_image_input = b.supports_image_input;
        if (typeof b.supports_video_input === "boolean") patch.supports_video_input = b.supports_video_input;

        try {
          const updated = updateSetting(id, patch);
          _ok(res, "Setting updated", _maskSetting(updated));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("not found")) {
            _notFound(res, message);
          } else {
            _badRequest(res, message);
          }
        }
      })
      .catch((err) => {
        _badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  // DELETE /api/llm-settings/:id or /api/llm/settings/:id
  if (settingsId && req.method === "DELETE") {
    const id = settingsId;
    const removed = deleteSetting(id);
    if (!removed) {
      _notFound(res, `Setting not found: ${id}`);
      return true;
    }
    _ok(res, "Setting deleted", { id });
    return true;
  }

  return false;
}

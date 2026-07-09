import * as crypto from "node:crypto";
import { clearTables, encodeJson, getDb, parseJsonRow } from "./db.js";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  type EncryptedSecret,
} from "./secret-store.js";
import { normalizeStatus, type ProviderStatus } from "./status.js";
import { nowIso } from "./time.js";
import {
  baseUrlForProtocol,
  canonicalProviderIdForEndpoint,
  findCatalogProvider,
  findCatalogEndpoint,
  findEndpointModel,
  inferCatalogEndpoint,
  listCatalogProviders,
  type LLMAuthType,
  type LLMPlanType,
  type LLMProtocol,
  type ModelCapabilities,
  type ProviderEndpointPreset,
  type ProviderModelPreset,
} from "./provider-catalog.js";

export type {
  LLMAuthType,
  LLMPlanType,
  LLMProtocol,
  ModelCapabilities,
  ProviderEndpointPreset,
  ProviderModelPreset,
} from "./provider-catalog.js";

export interface ProviderInfo extends ModelCapabilities {
  id: string;
  name: string;
  status: ProviderStatus;
  default_model: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  docs_url?: string;
  source?: "builtin" | "custom";
  readonly?: boolean;
  endpoints?: ProviderEndpointPreset[];
}

export interface ProviderInput extends ModelCapabilities {
  id: string;
  name?: string;
  status?: string;
  default_model?: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
}

export interface LLMSettingInput extends ModelCapabilities {
  provider_id: string;
  model_name: string;
  /** 该凭证可用的模型列表（多模型凭证）。若提供，model_name 取第一个作为主模型。 */
  models?: string[];
  api_key: string;
  display_name?: string;
  alias?: string;
  endpoint_id?: string;
  endpoint_name?: string;
  plan_type?: LLMPlanType;
  protocol?: LLMProtocol;
  auth_type?: LLMAuthType;
  key_hint?: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  resource_id?: string;
  voice_adapter?: string;
  tts_http_url?: string;
  tts_realtime_url?: string;
  tts_bidirectional_url?: string;
  asr_realtime_url?: string;
  asr_async_url?: string;
  tts_voice?: string;
  tts_format?: string;
  tts_sample_rate?: number;
  is_active?: boolean;
  is_default?: boolean;
}

export interface LLMSetting extends Required<ModelCapabilities> {
  id: string;
  provider_id: string;
  model_name: string;
  /** 该凭证（key）可用的模型列表。向后兼容：旧 setting 无此字段时读取派生 [model_name]。 */
  models?: string[];
  api_key: string;
  display_name?: string;
  endpoint_id?: string;
  endpoint_name?: string;
  plan_type: LLMPlanType;
  protocol: LLMProtocol;
  auth_type?: LLMAuthType;
  key_hint?: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  resource_id?: string;
  voice_adapter?: string;
  tts_http_url?: string;
  tts_realtime_url?: string;
  tts_bidirectional_url?: string;
  asr_realtime_url?: string;
  asr_async_url?: string;
  tts_voice?: string;
  tts_format?: string;
  tts_sample_rate?: number;
  is_active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface StoredLLMSetting extends Omit<LLMSetting, "api_key"> {
  api_key_encrypted?: EncryptedSecret;
  api_key?: string;
  secret_storage?: "manager_encrypted" | "legacy_plaintext";
}

const LEGACY_CLAUDE_SDK_COMPATIBLE_PROVIDER_IDS = [
  "anthropic",
  "glm",
  "xiaomi",
  "deepseek",
  "kimi",
  "minimax",
  "minimax_cn",
  "aliyun",
];

export function getDefaultProviders(): ProviderInfo[] {
  return listProviders();
}

function _stringField(rec: Record<string, unknown>, field: string): string | undefined {
  const value = rec[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _normalizeClaudeSdkBaseUrl(value: unknown): string | undefined {
  const raw = _nonEmptyString(value);
  if (!raw) return undefined;
  const trimmed = raw.replace(/\/+$/, "");
  const withoutMessagesVersion = trimmed.replace(/\/v1$/i, "");
  return withoutMessagesVersion || trimmed;
}

function _normalizePlanType(value: unknown, fallback: LLMPlanType = "custom"): LLMPlanType {
  return value === "api_billing" || value === "token_plan" || value === "coding_plan" ||
      value === "agent_plan" || value === "subscription" || value === "custom"
    ? value
    : fallback;
}

function _normalizeProtocol(value: unknown, fallback: LLMProtocol = "custom"): LLMProtocol {
  return value === "openai_compatible" || value === "anthropic_compatible" || value === "dashscope_native" ||
      value === "volcengine_doubao_voice" || value === "volcengine_ark_voice" ||
      value === "volcengine_openspeech" || value === "custom"
    ? value
    : fallback;
}

function _normalizeAuthType(value: unknown, fallback?: LLMAuthType): LLMAuthType | undefined {
  return value === "bearer" || value === "api-key" || value === "x-api-key" || value === "subscription-key" ||
      value === "custom"
    ? value
    : fallback;
}

function _normalizeEndpointFor(providerId: string, endpointId?: string, baseUrl?: string): ProviderEndpointPreset | undefined {
  return (endpointId ? findCatalogEndpoint(providerId, endpointId) : undefined) ?? inferCatalogEndpoint(providerId, baseUrl);
}

function _canonicalProviderId(
  providerId: string,
  endpointId?: string,
  baseUrl?: string,
  modelName?: string,
): string {
  return canonicalProviderIdForEndpoint(providerId, endpointId, baseUrl, modelName);
}

function _isLockedCatalogEndpoint(providerId: string, endpoint?: ProviderEndpointPreset): boolean {
  if (!endpoint) return false;
  return _isReadonlyEndpoint(providerId, endpoint.id) &&
    Boolean(endpoint.base_url || endpoint.chat_completions_base_url || endpoint.responses_base_url || endpoint.anthropic_base_url);
}

function _officialBaseUrlFor(
  providerId: string,
  endpoint: ProviderEndpointPreset | undefined,
  protocol: LLMProtocol | undefined,
): string | undefined {
  if (!_isLockedCatalogEndpoint(providerId, endpoint)) return undefined;
  return baseUrlForProtocol(endpoint, protocol) || undefined;
}

function _capability(
  explicit: unknown,
  modelValue: boolean | undefined,
  endpointValue: boolean | undefined,
  providerValue: boolean | undefined,
  fallback: boolean,
): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (typeof modelValue === "boolean") return modelValue;
  if (typeof endpointValue === "boolean") return endpointValue;
  if (typeof providerValue === "boolean") return providerValue;
  return fallback;
}

function _normalizeProvider(raw: unknown): ProviderInfo | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return undefined;
  const defaultModel = typeof rec.default_model === "string"
    ? rec.default_model.trim()
    : typeof rec.defaultModel === "string"
      ? rec.defaultModel.trim()
      : "";
  return {
    id,
    name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id,
    status: normalizeStatus("provider", typeof rec.status === "string" ? rec.status : undefined, "active"),
    default_model: defaultModel,
    base_url: typeof rec.base_url === "string" ? rec.base_url : undefined,
    chat_completions_base_url: typeof rec.chat_completions_base_url === "string"
      ? rec.chat_completions_base_url
      : undefined,
    responses_base_url: typeof rec.responses_base_url === "string" ? rec.responses_base_url : undefined,
    anthropic_base_url: typeof rec.anthropic_base_url === "string" ? rec.anthropic_base_url : undefined,
    docs_url: typeof rec.docs_url === "string" ? rec.docs_url : undefined,
    supports_llm: typeof rec.supports_llm === "boolean" ? rec.supports_llm : undefined,
    supports_asr: typeof rec.supports_asr === "boolean" ? rec.supports_asr : undefined,
    supports_tts: typeof rec.supports_tts === "boolean" ? rec.supports_tts : undefined,
    supports_audio_input: typeof rec.supports_audio_input === "boolean" ? rec.supports_audio_input : undefined,
    supports_image_input: typeof rec.supports_image_input === "boolean" ? rec.supports_image_input : undefined,
    supports_video_input: typeof rec.supports_video_input === "boolean" ? rec.supports_video_input : undefined,
  };
}

function _jsonObject<T extends Record<string, unknown>>(raw: unknown): T | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = parseJsonRow<unknown>(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function _jsonArray<T>(raw: unknown): T[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = parseJsonRow<unknown>(raw);
    return Array.isArray(parsed) ? parsed as T[] : undefined;
  } catch {
    return undefined;
  }
}

function _rowString(rec: Record<string, unknown>, field: string): string | undefined {
  const value = rec[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _rowNullableString(rec: Record<string, unknown>, field: string): string | undefined {
  const value = rec[field];
  return typeof value === "string" ? value : undefined;
}

function _rowNumber(rec: Record<string, unknown>, field: string): number | undefined {
  const value = rec[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function _rowBool(value: unknown, fallback?: boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value === "1" || value.toLowerCase() === "true") return true;
    if (value === "0" || value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function _boolToInt(value?: boolean): number {
  return value ? 1 : 0;
}

function _legacyCustomProviders(): ProviderInfo[] {
  const rows = getDb()
    .prepare("SELECT data FROM llm_custom_providers ORDER BY id")
    .all() as Array<{ data: string }>;
  return rows
    .map((row) => {
      try {
        return _normalizeProvider(parseJsonRow<unknown>(row.data));
      } catch {
        return undefined;
      }
    })
    .filter((provider): provider is ProviderInfo => provider !== undefined);
}

function _isReadonlyProvider(providerId: string): boolean {
  const row = getDb()
    .prepare("SELECT readonly FROM llm_providers WHERE id = ?")
    .get(providerId) as { readonly?: number } | undefined;
  return _rowBool(row?.readonly, false) === true;
}

function _isReadonlyEndpoint(providerId: string, endpointId?: string): boolean {
  if (!endpointId) return false;
  const row = getDb()
    .prepare("SELECT readonly FROM llm_provider_endpoints WHERE provider_id = ? AND id = ?")
    .get(providerId, endpointId) as { readonly?: number } | undefined;
  return _rowBool(row?.readonly, false) === true;
}

function _providerModelFromDbRow(row: Record<string, unknown>): ProviderModelPreset | undefined {
  const raw = _jsonObject<Partial<ProviderModelPreset> & Record<string, unknown>>(row.data) ?? {};
  const id = _rowString(row, "model_id") ?? _stringField(raw, "id");
  if (!id) return undefined;
  return {
    ...raw,
    id,
    name: _rowString(row, "name") ?? raw.name,
    display_name: _rowNullableString(row, "display_name") ?? raw.display_name ?? id,
    recommended: _rowBool(row.recommended, raw.recommended) ?? false,
    resource_id: _rowNullableString(row, "resource_id") ?? raw.resource_id,
    supports_llm: _rowBool(row.supports_llm, raw.supports_llm ?? true),
    supports_asr: _rowBool(row.supports_asr, raw.supports_asr ?? false),
    supports_tts: _rowBool(row.supports_tts, raw.supports_tts ?? false),
    supports_audio_input: _rowBool(row.supports_audio_input, raw.supports_audio_input ?? false),
    supports_image_input: _rowBool(row.supports_image_input, raw.supports_image_input ?? false),
    supports_video_input: _rowBool(row.supports_video_input, raw.supports_video_input ?? false),
  };
}

function _providerEndpointFromDbRow(
  row: Record<string, unknown>,
  modelRows: Record<string, unknown>[],
): ProviderEndpointPreset | undefined {
  const raw = _jsonObject<Partial<ProviderEndpointPreset> & Record<string, unknown>>(row.data) ?? {};
  const id = _rowString(row, "id") ?? _stringField(raw, "id");
  const providerId = _rowString(row, "provider_id") ?? _stringField(raw, "provider_id");
  if (!id || !providerId) return undefined;
  const modelPresets = modelRows
    .map(_providerModelFromDbRow)
    .filter((model): model is ProviderModelPreset => model !== undefined);
  const rawModels = Array.isArray(raw.models) ? raw.models as ProviderModelPreset[] : [];
  const models = modelPresets.length ? modelPresets : rawModels;
  const defaultModel = _rowString(row, "default_model") ?? raw.default_model ?? models[0]?.id ?? "";
  return {
    ...raw,
    id,
    provider_id: providerId,
    name: _rowString(row, "name") ?? raw.name ?? id,
    plan_type: _normalizePlanType(row.plan_type, raw.plan_type ?? "custom"),
    protocol: _normalizeProtocol(row.protocol, raw.protocol ?? "custom"),
    base_url: _rowNullableString(row, "base_url") ?? raw.base_url ?? "",
    chat_completions_base_url: _rowNullableString(row, "chat_completions_base_url") ?? raw.chat_completions_base_url,
    responses_base_url: _rowNullableString(row, "responses_base_url") ?? raw.responses_base_url,
    anthropic_base_url: _rowNullableString(row, "anthropic_base_url") ?? raw.anthropic_base_url,
    resource_id: _rowNullableString(row, "resource_id") ?? raw.resource_id,
    voice_adapter: (_rowNullableString(row, "voice_adapter") ?? raw.voice_adapter) as ProviderEndpointPreset["voice_adapter"],
    tts_http_url: _rowNullableString(row, "tts_http_url") ?? raw.tts_http_url,
    tts_realtime_url: _rowNullableString(row, "tts_realtime_url") ?? raw.tts_realtime_url,
    tts_bidirectional_url: _rowNullableString(row, "tts_bidirectional_url") ?? raw.tts_bidirectional_url,
    asr_realtime_url: _rowNullableString(row, "asr_realtime_url") ?? raw.asr_realtime_url,
    asr_async_url: _rowNullableString(row, "asr_async_url") ?? raw.asr_async_url,
    tts_voice: _rowNullableString(row, "tts_voice") ?? raw.tts_voice,
    tts_format: _rowNullableString(row, "tts_format") ?? raw.tts_format,
    tts_sample_rate: _rowNumber(row, "tts_sample_rate") ?? raw.tts_sample_rate,
    region: _rowNullableString(row, "region") ?? raw.region,
    region_label: _rowNullableString(row, "region_label") ?? raw.region_label,
    auth_type: _normalizeAuthType(row.auth_type, raw.auth_type ?? "bearer") ?? "bearer",
    key_hint: _rowNullableString(row, "key_hint") ?? raw.key_hint,
    key_prefix_hint: _rowNullableString(row, "key_prefix_hint") ?? raw.key_prefix_hint,
    docs_url: _rowNullableString(row, "docs_url") ?? raw.docs_url,
    default_model: defaultModel,
    models: models.length ? models : defaultModel ? [{ id: defaultModel, display_name: defaultModel, recommended: true }] : [],
    supports_llm: _rowBool(row.supports_llm, raw.supports_llm ?? true),
    supports_asr: _rowBool(row.supports_asr, raw.supports_asr ?? false),
    supports_tts: _rowBool(row.supports_tts, raw.supports_tts ?? false),
    supports_audio_input: _rowBool(row.supports_audio_input, raw.supports_audio_input ?? false),
    supports_image_input: _rowBool(row.supports_image_input, raw.supports_image_input ?? false),
    supports_video_input: _rowBool(row.supports_video_input, raw.supports_video_input ?? false),
  };
}

function _providerFromDbRow(
  row: Record<string, unknown>,
  endpointRows: Record<string, unknown>[],
  modelRowsByEndpoint: Map<string, Record<string, unknown>[]>,
): ProviderInfo | undefined {
  const raw = _jsonObject<Partial<ProviderInfo> & Record<string, unknown>>(row.data) ?? {};
  const id = _rowString(row, "id") ?? _stringField(raw, "id");
  if (!id) return undefined;
  const endpoints = endpointRows
    .map((endpointRow) => _providerEndpointFromDbRow(endpointRow, modelRowsByEndpoint.get(String(endpointRow.id)) ?? []))
    .filter((endpoint): endpoint is ProviderEndpointPreset => endpoint !== undefined);
  const source = _rowString(row, "source") === "builtin" ? "builtin" : "custom";
  const provider: ProviderInfo = {
    ...raw,
    id,
    name: _rowString(row, "name") ?? raw.name ?? id,
    status: normalizeStatus("provider", typeof row.status === "string" ? row.status : raw.status, "active"),
    default_model: _rowString(row, "default_model") ?? raw.default_model ?? endpoints[0]?.default_model ?? "",
    base_url: _rowNullableString(row, "base_url") ?? raw.base_url,
    chat_completions_base_url: _rowNullableString(row, "chat_completions_base_url") ?? raw.chat_completions_base_url,
    responses_base_url: _rowNullableString(row, "responses_base_url") ?? raw.responses_base_url,
    anthropic_base_url: _rowNullableString(row, "anthropic_base_url") ?? raw.anthropic_base_url,
    docs_url: _rowNullableString(row, "docs_url") ?? raw.docs_url,
    source,
    readonly: _rowBool(row.readonly, source === "builtin") ?? false,
    supports_llm: _rowBool(row.supports_llm, raw.supports_llm ?? true),
    supports_asr: _rowBool(row.supports_asr, raw.supports_asr ?? false),
    supports_tts: _rowBool(row.supports_tts, raw.supports_tts ?? false),
    supports_audio_input: _rowBool(row.supports_audio_input, raw.supports_audio_input ?? false),
    supports_image_input: _rowBool(row.supports_image_input, raw.supports_image_input ?? false),
    supports_video_input: _rowBool(row.supports_video_input, raw.supports_video_input ?? false),
    endpoints,
  };
  return _providerWithEndpointFallback(provider);
}

function _readProvidersFromDb(): ProviderInfo[] {
  const db = getDb();
  const providerRows = db.prepare("SELECT * FROM llm_providers ORDER BY id").all() as Record<string, unknown>[];
  const endpointRows = db.prepare("SELECT * FROM llm_provider_endpoints ORDER BY provider_id, id").all() as Record<string, unknown>[];
  const modelRows = db.prepare("SELECT * FROM llm_provider_models ORDER BY endpoint_id, recommended DESC, model_id").all() as Record<string, unknown>[];
  const endpointsByProvider = new Map<string, Record<string, unknown>[]>();
  const modelsByEndpoint = new Map<string, Record<string, unknown>[]>();

  for (const endpoint of endpointRows) {
    const providerId = String(endpoint.provider_id ?? "");
    if (!providerId) continue;
    const endpoints = endpointsByProvider.get(providerId) ?? [];
    endpoints.push(endpoint);
    endpointsByProvider.set(providerId, endpoints);
  }
  for (const model of modelRows) {
    const endpointId = String(model.endpoint_id ?? "");
    if (!endpointId) continue;
    const models = modelsByEndpoint.get(endpointId) ?? [];
    models.push(model);
    modelsByEndpoint.set(endpointId, models);
  }

  return providerRows
    .map((row) => _providerFromDbRow(row, endpointsByProvider.get(String(row.id)) ?? [], modelsByEndpoint))
    .filter((provider): provider is ProviderInfo => provider !== undefined);
}

function _writeCustomProviderToDb(provider: ProviderInfo): void {
  const db = getDb();
  db.transaction(() => {
    const now = nowIso();
    const status = normalizeStatus("provider", provider.status, "active");
    const endpoint = _customEndpointForProvider(provider);
    db.prepare(`
      INSERT INTO llm_providers(
        id, name, status, source, readonly, default_model, base_url,
        chat_completions_base_url, responses_base_url, anthropic_base_url, docs_url,
        supports_llm, supports_asr, supports_tts, supports_audio_input,
        supports_image_input, supports_video_input, updated_at, data
      )
      VALUES (?, ?, ?, 'custom', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        source = 'custom',
        readonly = 0,
        default_model = excluded.default_model,
        base_url = excluded.base_url,
        chat_completions_base_url = excluded.chat_completions_base_url,
        responses_base_url = excluded.responses_base_url,
        anthropic_base_url = excluded.anthropic_base_url,
        docs_url = excluded.docs_url,
        supports_llm = excluded.supports_llm,
        supports_asr = excluded.supports_asr,
        supports_tts = excluded.supports_tts,
        supports_audio_input = excluded.supports_audio_input,
        supports_image_input = excluded.supports_image_input,
        supports_video_input = excluded.supports_video_input,
        updated_at = excluded.updated_at,
        data = excluded.data
    `).run(
      provider.id,
      provider.name,
      status,
      provider.default_model,
      provider.base_url ?? null,
      provider.chat_completions_base_url ?? null,
      provider.responses_base_url ?? null,
      provider.anthropic_base_url ?? null,
      provider.docs_url ?? null,
      _boolToInt(provider.supports_llm ?? true),
      _boolToInt(provider.supports_asr),
      _boolToInt(provider.supports_tts),
      _boolToInt(provider.supports_audio_input),
      _boolToInt(provider.supports_image_input),
      _boolToInt(provider.supports_video_input),
      now,
      encodeJson({ ...provider, status, source: "custom", readonly: false, endpoints: endpoint ? [endpoint] : [] }),
    );

    db.prepare("DELETE FROM llm_provider_models WHERE provider_id = ? AND source = 'custom'").run(provider.id);
    db.prepare("DELETE FROM llm_provider_endpoints WHERE provider_id = ? AND source = 'custom'").run(provider.id);
    if (endpoint) {
      db.prepare(`
        INSERT INTO llm_provider_endpoints(
          id, provider_id, name, source, readonly, plan_type, protocol, auth_type,
          base_url, chat_completions_base_url, responses_base_url, anthropic_base_url, default_model,
          resource_id, voice_adapter, tts_http_url, tts_realtime_url,
          tts_bidirectional_url, asr_realtime_url, asr_async_url, tts_voice,
          tts_format, tts_sample_rate, region, region_label, docs_url,
          key_hint, key_prefix_hint, supports_llm, supports_asr, supports_tts,
          supports_audio_input, supports_image_input, supports_video_input,
          updated_at, data
        )
        VALUES (?, ?, ?, 'custom', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        endpoint.id,
        endpoint.provider_id,
        endpoint.name,
        endpoint.plan_type,
        endpoint.protocol,
        endpoint.auth_type,
        endpoint.base_url,
        endpoint.chat_completions_base_url ?? null,
        endpoint.responses_base_url ?? null,
        endpoint.anthropic_base_url ?? null,
        endpoint.default_model,
        endpoint.resource_id ?? null,
        endpoint.voice_adapter ?? null,
        endpoint.tts_http_url ?? null,
        endpoint.tts_realtime_url ?? null,
        endpoint.tts_bidirectional_url ?? null,
        endpoint.asr_realtime_url ?? null,
        endpoint.asr_async_url ?? null,
        endpoint.tts_voice ?? null,
        endpoint.tts_format ?? null,
        endpoint.tts_sample_rate ?? null,
        endpoint.region ?? null,
        endpoint.region_label ?? null,
        endpoint.docs_url ?? null,
        endpoint.key_hint ?? null,
        endpoint.key_prefix_hint ?? null,
        _boolToInt(endpoint.supports_llm ?? true),
        _boolToInt(endpoint.supports_asr),
        _boolToInt(endpoint.supports_tts),
        _boolToInt(endpoint.supports_audio_input),
        _boolToInt(endpoint.supports_image_input),
        _boolToInt(endpoint.supports_video_input),
        now,
        encodeJson(endpoint),
      );

      const modelStmt = db.prepare(`
        INSERT INTO llm_provider_models(
          id, provider_id, endpoint_id, model_id, source, readonly, display_name,
          recommended, resource_id, supports_llm, supports_asr, supports_tts,
          supports_audio_input, supports_image_input, supports_video_input,
          updated_at, data
        )
        VALUES (?, ?, ?, ?, 'custom', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const model of endpoint.models) {
        modelStmt.run(
          `${endpoint.id}:${model.id}`,
          provider.id,
          endpoint.id,
          model.id,
          model.display_name ?? model.name ?? model.id,
          _boolToInt(model.recommended),
          model.resource_id ?? null,
          _boolToInt(model.supports_llm ?? true),
          _boolToInt(model.supports_asr),
          _boolToInt(model.supports_tts),
          _boolToInt(model.supports_audio_input),
          _boolToInt(model.supports_image_input),
          _boolToInt(model.supports_video_input),
          now,
          encodeJson(model),
        );
      }
    }
    db.prepare("DELETE FROM llm_custom_providers WHERE id = ?").run(provider.id);
  })();
}

function _migrateLegacyCustomProviders(): void {
  const providers = _legacyCustomProviders().filter((provider) => !findCatalogProvider(provider.id) && !_isReadonlyProvider(provider.id));
  if (!providers.length) return;
  for (const provider of providers) {
    _writeCustomProviderToDb(provider);
  }
}

function _normalizeStoredSetting(raw: unknown): { setting?: LLMSetting; needsMigration: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { needsMigration: false };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== "string") return { needsMigration: false };
  if (typeof rec.provider_id !== "string") return { needsMigration: false };
  if (typeof rec.model_name !== "string") return { needsMigration: false };

  let apiKey = "";
  let needsMigration = false;
  if (isEncryptedSecret(rec.api_key_encrypted)) {
    apiKey = decryptSecret(rec.api_key_encrypted);
  } else if (typeof rec.api_key === "string") {
    apiKey = rec.api_key;
    needsMigration = true;
  }
  const storedEndpointId = _stringField(rec, "endpoint_id");
  const storedBaseUrl = _stringField(rec, "base_url");
  const providerId = _canonicalProviderId(rec.provider_id, storedEndpointId, storedBaseUrl, rec.model_name);
  const provider = getProvider(providerId) ?? getProvider(rec.provider_id);
  const endpoint = _normalizeEndpointFor(
    providerId,
    storedEndpointId,
    storedBaseUrl ?? provider?.base_url,
  );
  const modelPreset = findEndpointModel(endpoint, rec.model_name);
  const lockedEndpoint = _isLockedCatalogEndpoint(providerId, endpoint);
  const endpointId = lockedEndpoint
    ? endpoint?.id ?? storedEndpointId ?? "custom"
    : storedEndpointId ?? endpoint?.id ?? "custom";
  const protocol = lockedEndpoint && endpoint?.protocol
    ? endpoint.protocol
    : _normalizeProtocol(rec.protocol, endpoint?.protocol ?? "custom");
  const officialBaseUrl = _officialBaseUrlFor(providerId, endpoint, protocol);
  const inferredBaseUrl = officialBaseUrl ?? (storedBaseUrl
    ? storedBaseUrl
    : baseUrlForProtocol(endpoint, protocol) || provider?.base_url || undefined);
  const storedChatBaseUrl = typeof rec.chat_completions_base_url === "string" ? rec.chat_completions_base_url : undefined;
  const storedResponsesBaseUrl = typeof rec.responses_base_url === "string" ? rec.responses_base_url : undefined;
  const storedAnthropicBaseUrl = typeof rec.anthropic_base_url === "string" ? rec.anthropic_base_url : undefined;
  const inferredChatBaseUrl = lockedEndpoint
    ? endpoint?.chat_completions_base_url ?? storedChatBaseUrl ?? provider?.chat_completions_base_url
    : storedChatBaseUrl ?? endpoint?.chat_completions_base_url ?? provider?.chat_completions_base_url;
  const inferredResponsesBaseUrl = lockedEndpoint
    ? endpoint?.responses_base_url ?? storedResponsesBaseUrl ?? provider?.responses_base_url
    : storedResponsesBaseUrl ?? endpoint?.responses_base_url ?? provider?.responses_base_url;
  const inferredAnthropicBaseUrl = lockedEndpoint
    ? endpoint?.anthropic_base_url ?? storedAnthropicBaseUrl ?? provider?.anthropic_base_url
    : storedAnthropicBaseUrl ?? endpoint?.anthropic_base_url ?? provider?.anthropic_base_url;
  needsMigration = needsMigration || rec.provider_id !== providerId || rec.endpoint_id !== endpointId || typeof rec.plan_type !== "string" ||
    typeof rec.protocol !== "string" || typeof rec.display_name !== "string" ||
    (typeof rec.base_url === "string" && officialBaseUrl !== undefined && rec.base_url !== officialBaseUrl) ||
    (lockedEndpoint && endpoint?.plan_type !== undefined && rec.plan_type !== endpoint.plan_type) ||
    (lockedEndpoint && endpoint?.protocol !== undefined && rec.protocol !== endpoint.protocol);

  // models 向后兼容：旧 setting 无 models 字段时，从 model_name 派生 [model_name]
  const models = Array.isArray(rec.models) && rec.models.every((m) => typeof m === "string")
    ? rec.models as string[]
    : [rec.model_name];

  const setting: LLMSetting = {
    id: rec.id,
    provider_id: providerId,
    model_name: rec.model_name,
    models,
    api_key: apiKey,
    display_name: _stringField(rec, "display_name") ?? _stringField(rec, "alias") ?? rec.model_name,
    endpoint_id: endpointId,
    endpoint_name: _stringField(rec, "endpoint_name") ?? endpoint?.name,
    plan_type: lockedEndpoint && endpoint?.plan_type
      ? endpoint.plan_type
      : _normalizePlanType(rec.plan_type, endpoint?.plan_type ?? "custom"),
    protocol,
    auth_type: _normalizeAuthType(rec.auth_type, endpoint?.auth_type),
    key_hint: _stringField(rec, "key_hint") ?? endpoint?.key_hint,
    base_url: inferredBaseUrl,
    chat_completions_base_url: inferredChatBaseUrl,
    responses_base_url: inferredResponsesBaseUrl,
    anthropic_base_url: inferredAnthropicBaseUrl,
    resource_id: lockedEndpoint
      ? modelPreset?.resource_id ?? endpoint?.resource_id
      : _stringField(rec, "resource_id") ?? modelPreset?.resource_id ?? endpoint?.resource_id,
    voice_adapter: lockedEndpoint ? endpoint?.voice_adapter : _stringField(rec, "voice_adapter") ?? endpoint?.voice_adapter,
    tts_http_url: lockedEndpoint ? endpoint?.tts_http_url : _stringField(rec, "tts_http_url") ?? endpoint?.tts_http_url,
    tts_realtime_url: lockedEndpoint ? endpoint?.tts_realtime_url : _stringField(rec, "tts_realtime_url") ?? endpoint?.tts_realtime_url,
    tts_bidirectional_url: lockedEndpoint
      ? endpoint?.tts_bidirectional_url
      : _stringField(rec, "tts_bidirectional_url") ?? endpoint?.tts_bidirectional_url,
    asr_realtime_url: lockedEndpoint ? endpoint?.asr_realtime_url : _stringField(rec, "asr_realtime_url") ?? endpoint?.asr_realtime_url,
    asr_async_url: lockedEndpoint ? endpoint?.asr_async_url : _stringField(rec, "asr_async_url") ?? endpoint?.asr_async_url,
    tts_voice: lockedEndpoint ? endpoint?.tts_voice : _stringField(rec, "tts_voice") ?? endpoint?.tts_voice,
    tts_format: lockedEndpoint ? endpoint?.tts_format : _stringField(rec, "tts_format") ?? endpoint?.tts_format,
    tts_sample_rate: lockedEndpoint
      ? endpoint?.tts_sample_rate
      : typeof rec.tts_sample_rate === "number"
        ? rec.tts_sample_rate
        : endpoint?.tts_sample_rate,
    is_active: typeof rec.is_active === "boolean" ? rec.is_active : true,
    is_default: typeof rec.is_default === "boolean" ? rec.is_default : false,
    supports_llm: _capability(rec.supports_llm, modelPreset?.supports_llm, endpoint?.supports_llm, provider?.supports_llm, true),
    supports_asr: _capability(rec.supports_asr, modelPreset?.supports_asr, endpoint?.supports_asr, provider?.supports_asr, false),
    supports_tts: _capability(rec.supports_tts, modelPreset?.supports_tts, endpoint?.supports_tts, provider?.supports_tts, false),
    supports_audio_input: _capability(
      rec.supports_audio_input,
      modelPreset?.supports_audio_input,
      endpoint?.supports_audio_input,
      provider?.supports_audio_input,
      false,
    ),
    supports_image_input: _capability(
      rec.supports_image_input,
      modelPreset?.supports_image_input,
      endpoint?.supports_image_input,
      provider?.supports_image_input,
      false,
    ),
    supports_video_input: _capability(
      rec.supports_video_input,
      modelPreset?.supports_video_input,
      endpoint?.supports_video_input,
      provider?.supports_video_input,
      false,
    ),
    created_at: typeof rec.created_at === "string" ? rec.created_at : new Date().toISOString(),
    updated_at: typeof rec.updated_at === "string" ? rec.updated_at : new Date().toISOString(),
  };

  return { setting, needsMigration };
}

function _encryptedSecretFromColumn(value: unknown): EncryptedSecret | undefined {
  if (isEncryptedSecret(value)) return value;
  const parsed = _jsonObject<Record<string, unknown>>(value);
  return isEncryptedSecret(parsed) ? parsed : undefined;
}

function _settingRawFromDbRow(row: Record<string, unknown>): Record<string, unknown> {
  const raw = _jsonObject<Record<string, unknown>>(row.data) ?? {};
  const merged: Record<string, unknown> = { ...raw };
  const stringFields = [
    "id",
    "provider_id",
    "model_name",
    "endpoint_id",
    "endpoint_name",
    "display_name",
    "plan_type",
    "protocol",
    "auth_type",
    "key_hint",
    "base_url",
    "chat_completions_base_url",
    "responses_base_url",
    "anthropic_base_url",
    "resource_id",
    "voice_adapter",
    "tts_http_url",
    "tts_realtime_url",
    "tts_bidirectional_url",
    "asr_realtime_url",
    "asr_async_url",
    "tts_voice",
    "tts_format",
    "created_at",
    "updated_at",
    "secret_storage",
  ];
  for (const field of stringFields) {
    const value = _rowNullableString(row, field);
    if (value !== undefined && value !== "") {
      merged[field] = value;
    }
  }
  const ttsSampleRate = _rowNumber(row, "tts_sample_rate");
  if (ttsSampleRate !== undefined) merged.tts_sample_rate = ttsSampleRate;
  const models = _jsonArray<string>(row.models);
  if (models?.every((model) => typeof model === "string")) {
    merged.models = models;
  }
  for (const field of [
    "supports_llm",
    "supports_asr",
    "supports_tts",
    "supports_audio_input",
    "supports_image_input",
    "supports_video_input",
    "is_active",
    "is_default",
  ]) {
    const value = _rowBool(row[field]);
    if (value !== undefined) merged[field] = value;
  }
  const encrypted = _encryptedSecretFromColumn(row.api_key_encrypted);
  if (encrypted) {
    merged.api_key_encrypted = encrypted;
    delete merged.api_key;
  }
  return merged;
}

function _readSettings(): LLMSetting[] {
  const rows = getDb()
    .prepare("SELECT * FROM llm_settings ORDER BY updated_at DESC, id")
    .all() as Record<string, unknown>[];
  let needsMigration = false;
  const settings = rows
    .map((row) => {
      try {
        const normalized = _normalizeStoredSetting(_settingRawFromDbRow(row));
        needsMigration = needsMigration || normalized.needsMigration;
        return normalized.setting;
      } catch {
        return undefined;
      }
    })
    .filter((setting): setting is LLMSetting => setting !== undefined);
  if (needsMigration) {
    _writeSettings(settings);
  }
  return settings;
}

function _writeSettings(settings: LLMSetting[]): void {
  const stored: StoredLLMSetting[] = settings.map(({ api_key, ...setting }) => {
    const api_key_encrypted = encryptSecret(api_key);
    return {
      ...setting,
      api_key_encrypted,
      secret_storage: "manager_encrypted",
    };
  });
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM llm_settings").run();
    const stmt = db.prepare(`
      INSERT INTO llm_settings(
        id, provider_id, model_name, endpoint_id, endpoint_name, display_name,
        plan_type, protocol, auth_type, key_hint, base_url,
        chat_completions_base_url, responses_base_url, anthropic_base_url, resource_id,
        voice_adapter, tts_http_url, tts_realtime_url, tts_bidirectional_url,
        asr_realtime_url, asr_async_url, tts_voice, tts_format, tts_sample_rate,
        models, supports_llm, supports_asr, supports_tts, supports_audio_input,
        supports_image_input, supports_video_input, is_active, is_default,
        created_at, updated_at, api_key_encrypted, secret_storage, data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const setting of stored) {
      stmt.run(
        setting.id,
        setting.provider_id,
        setting.model_name,
        setting.endpoint_id ?? null,
        setting.endpoint_name ?? null,
        setting.display_name ?? null,
        setting.plan_type,
        setting.protocol,
        setting.auth_type ?? null,
        setting.key_hint ?? null,
        setting.base_url ?? null,
        setting.chat_completions_base_url ?? null,
        setting.responses_base_url ?? null,
        setting.anthropic_base_url ?? null,
        setting.resource_id ?? null,
        setting.voice_adapter ?? null,
        setting.tts_http_url ?? null,
        setting.tts_realtime_url ?? null,
        setting.tts_bidirectional_url ?? null,
        setting.asr_realtime_url ?? null,
        setting.asr_async_url ?? null,
        setting.tts_voice ?? null,
        setting.tts_format ?? null,
        setting.tts_sample_rate ?? null,
        encodeJson(setting.models ?? [setting.model_name]),
        _boolToInt(setting.supports_llm),
        _boolToInt(setting.supports_asr),
        _boolToInt(setting.supports_tts),
        _boolToInt(setting.supports_audio_input),
        _boolToInt(setting.supports_image_input),
        _boolToInt(setting.supports_video_input),
        _boolToInt(setting.is_active),
        _boolToInt(setting.is_default),
        setting.created_at,
        setting.updated_at,
        encodeJson(setting.api_key_encrypted),
        setting.secret_storage ?? "manager_encrypted",
        encodeJson(setting),
      );
    }
  })();
}

export function listSettings(): LLMSetting[] {
  return _readSettings();
}

function _customEndpointForProvider(provider: ProviderInfo): ProviderEndpointPreset | undefined {
  const baseUrl = provider.base_url ?? provider.chat_completions_base_url ?? provider.responses_base_url ??
    provider.anthropic_base_url ?? "";
  if (!baseUrl && !provider.default_model) return undefined;
  return {
    id: `${provider.id}_custom`,
    provider_id: provider.id,
    name: "Custom endpoint",
    plan_type: "custom",
    protocol: "custom",
    base_url: baseUrl,
    chat_completions_base_url: provider.chat_completions_base_url,
    responses_base_url: provider.responses_base_url,
    anthropic_base_url: provider.anthropic_base_url,
    auth_type: "bearer",
    key_hint: "API key",
    default_model: provider.default_model,
    supports_llm: provider.supports_llm ?? true,
    supports_asr: provider.supports_asr ?? false,
    supports_tts: provider.supports_tts ?? false,
    supports_audio_input: provider.supports_audio_input ?? false,
    supports_image_input: provider.supports_image_input ?? false,
    supports_video_input: provider.supports_video_input ?? false,
    models: [
      {
        id: provider.default_model,
        display_name: provider.default_model,
        supports_llm: provider.supports_llm ?? true,
        supports_asr: provider.supports_asr ?? false,
        supports_tts: provider.supports_tts ?? false,
        supports_audio_input: provider.supports_audio_input ?? false,
        supports_image_input: provider.supports_image_input ?? false,
        supports_video_input: provider.supports_video_input ?? false,
        recommended: true,
      },
    ],
  };
}

function _providerWithEndpointFallback(provider: ProviderInfo): ProviderInfo {
  if (provider.endpoints?.length) return provider;
  const endpoint = _customEndpointForProvider(provider);
  return endpoint ? { ...provider, endpoints: [endpoint] } : { ...provider, endpoints: [] };
}

export function listProviders(): ProviderInfo[] {
  _migrateLegacyCustomProviders();
  return _readProvidersFromDb().sort((a, b) => a.id.localeCompare(b.id));
}

export function getProvider(id: string): ProviderInfo | undefined {
  return listProviders().find((provider) => provider.id === id);
}

export function upsertProvider(input: ProviderInput): ProviderInfo {
  const id = input.id.trim();
  if (!id) throw new Error("Missing required field: id");
  if (_isReadonlyProvider(id) || findCatalogProvider(id)) throw new Error(`Cannot override built-in provider: ${id}`);
  const defaultModel = input.default_model?.trim() ?? "";
  if (!defaultModel) throw new Error("Missing required field: default_model");
  const provider: ProviderInfo = {
    id,
    name: input.name?.trim() || id,
    status: normalizeStatus("provider", input.status, "active"),
    default_model: defaultModel,
    base_url: input.base_url,
    chat_completions_base_url: input.chat_completions_base_url,
    responses_base_url: input.responses_base_url,
    anthropic_base_url: input.anthropic_base_url,
    supports_llm: input.supports_llm,
    supports_asr: input.supports_asr,
    supports_tts: input.supports_tts,
    supports_audio_input: input.supports_audio_input,
    supports_image_input: input.supports_image_input,
    supports_video_input: input.supports_video_input,
    source: "custom",
    readonly: false,
  };
  _writeCustomProviderToDb(provider);
  return getProvider(id) ?? _providerWithEndpointFallback(provider);
}

export function deleteProvider(id: string): boolean {
  if (!id.trim()) return false;
  if (_isReadonlyProvider(id) || findCatalogProvider(id)) throw new Error(`Cannot delete built-in provider: ${id}`);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM llm_providers WHERE id = ?").get(id);
  if (!existing) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM llm_settings WHERE provider_id = ?").run(id);
    db.prepare("DELETE FROM llm_provider_models WHERE provider_id = ?").run(id);
    db.prepare("DELETE FROM llm_provider_endpoints WHERE provider_id = ?").run(id);
    db.prepare("DELETE FROM llm_providers WHERE id = ?").run(id);
    db.prepare("DELETE FROM llm_custom_providers WHERE id = ?").run(id);
  })();
  return true;
}

export function getSetting(id: string): LLMSetting | undefined {
  return _readSettings().find((s) => s.id === id);
}

export function findActiveSetting(providerId?: string, modelName?: string): LLMSetting | undefined {
  if (!providerId) return undefined;
  const normalizedProviderId = _canonicalProviderId(providerId, undefined, undefined, modelName);
  const candidates = _readSettings().filter(
    (s) => s.is_active && s.provider_id === normalizedProviderId,
  );
  if (candidates.length === 0) return undefined;
  if (modelName) {
    // 1. 按 model_name 精确匹配（向后兼容旧 setting）
    const exact = candidates
      .filter((s) => s.model_name === modelName)
      .sort((a, b) => {
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      })[0];
    if (exact) return exact;
    // 2. 在 models[] 数组包含该 model 的凭证里找（新多模型凭证）
    const byModelsArray = candidates
      .filter((s) => Array.isArray(s.models) && s.models.includes(modelName))
      .sort((a, b) => {
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      })[0];
    if (byModelsArray) return byModelsArray;
  }
  return candidates.find((s) => s.is_default) ?? candidates[0];
}

export function isVoiceServiceSetting(setting: Pick<LLMSetting, "supports_asr" | "supports_tts">): boolean {
  return Boolean(setting.supports_asr || setting.supports_tts);
}

export function findActiveClaudeSdkCompatibleSetting(): LLMSetting | undefined {
  // Manager Agent requires a dedicated LLM runtime. Dirty legacy voice rows can have supports_llm=true.
  const settings = _readSettings().filter((s) => {
    return s.is_active &&
      s.supports_llm &&
      !isVoiceServiceSetting(s) &&
      Boolean(resolveClaudeSdkBaseUrlForSetting(s));
  });
  for (const providerId of LEGACY_CLAUDE_SDK_COMPATIBLE_PROVIDER_IDS) {
    const candidate = settings.find((s) => s.provider_id === providerId && s.is_default) ??
      settings.find((s) => s.provider_id === providerId);
    if (candidate) return candidate;
  }
  return settings.find((s) => s.is_default) ?? settings[0];
}

export function findActiveLlmRuntimeSetting(): LLMSetting | undefined {
  return _readSettings()
    .filter((s) => s.is_active && s.supports_llm && !isVoiceServiceSetting(s))
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    })[0];
}

function _endpointForSetting(setting: LLMSetting, provider = getProvider(setting.provider_id)): ProviderEndpointPreset | undefined {
  return (setting.endpoint_id
    ? provider?.endpoints?.find((endpoint) => endpoint.id === setting.endpoint_id)
    : undefined) ??
    provider?.endpoints?.find((endpoint) => endpoint.plan_type === setting.plan_type) ??
    provider?.endpoints?.[0];
}

export function resolveClaudeSdkBaseUrlForSetting(setting: LLMSetting): string | undefined {
  const provider = getProvider(setting.provider_id);
  const endpoint = _endpointForSetting(setting, provider);
  const anthropicBaseUrl = _normalizeClaudeSdkBaseUrl(setting.anthropic_base_url) ??
    _normalizeClaudeSdkBaseUrl(endpoint?.anthropic_base_url) ??
    _normalizeClaudeSdkBaseUrl(provider?.anthropic_base_url);
  if (anthropicBaseUrl) return anthropicBaseUrl;
  if (setting.protocol === "anthropic_compatible") {
    return _normalizeClaudeSdkBaseUrl(setting.base_url) ??
      _normalizeClaudeSdkBaseUrl(endpoint?.base_url) ??
      _normalizeClaudeSdkBaseUrl(provider?.base_url);
  }
  if (setting.protocol === "custom" && LEGACY_CLAUDE_SDK_COMPATIBLE_PROVIDER_IDS.includes(setting.provider_id)) {
    return _normalizeClaudeSdkBaseUrl(setting.base_url) ??
      _normalizeClaudeSdkBaseUrl(endpoint?.base_url) ??
      _normalizeClaudeSdkBaseUrl(provider?.base_url);
  }
  return undefined;
}

function _generateId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function _resolveSettingMetadata(
  provider: ProviderInfo,
  input: Partial<LLMSettingInput> & { provider_id: string; model_name: string },
  existing?: LLMSetting,
): {
  endpoint?: ProviderEndpointPreset;
  modelCapabilities?: ModelCapabilities;
  endpoint_id: string;
  endpoint_name?: string;
  plan_type: LLMPlanType;
  protocol: LLMProtocol;
  auth_type?: LLMAuthType;
  key_hint?: string;
  base_url?: string;
  chat_completions_base_url?: string;
  responses_base_url?: string;
  anthropic_base_url?: string;
  resource_id?: string;
  voice_adapter?: string;
  tts_http_url?: string;
  tts_realtime_url?: string;
  tts_bidirectional_url?: string;
  asr_realtime_url?: string;
  asr_async_url?: string;
  tts_voice?: string;
  tts_format?: string;
  tts_sample_rate?: number;
} {
  const catalogEndpoint = input.endpoint_id
    ? (provider.endpoints ?? []).find((endpoint) => endpoint.id === input.endpoint_id) ??
      findCatalogEndpoint(input.provider_id, input.endpoint_id)
    : _normalizeEndpointFor(input.provider_id, existing?.endpoint_id, input.base_url ?? existing?.base_url);
  const endpoint = catalogEndpoint ?? _customEndpointForProvider(provider);
  const modelCapabilities = findEndpointModel(endpoint, input.model_name);
  const lockedEndpoint = _isLockedCatalogEndpoint(input.provider_id, endpoint);
  const protocol = lockedEndpoint && endpoint?.protocol
    ? endpoint.protocol
    : input.protocol ?? endpoint?.protocol ?? existing?.protocol ?? "custom";
  const officialBaseUrl = _officialBaseUrlFor(input.provider_id, endpoint, protocol);
  const endpointBaseUrl = baseUrlForProtocol(endpoint, protocol);
  const chatBaseUrl = lockedEndpoint
    ? endpoint?.chat_completions_base_url ?? input.chat_completions_base_url ??
      existing?.chat_completions_base_url ?? provider.chat_completions_base_url
    : input.chat_completions_base_url ?? existing?.chat_completions_base_url ??
      endpoint?.chat_completions_base_url ?? provider.chat_completions_base_url;
  const responsesBaseUrl = lockedEndpoint
    ? endpoint?.responses_base_url ?? input.responses_base_url ??
      existing?.responses_base_url ?? provider.responses_base_url
    : input.responses_base_url ?? existing?.responses_base_url ??
      endpoint?.responses_base_url ?? provider.responses_base_url;
  const anthropicBaseUrl = lockedEndpoint
    ? endpoint?.anthropic_base_url ?? input.anthropic_base_url ??
      existing?.anthropic_base_url ?? provider.anthropic_base_url
    : input.anthropic_base_url ?? existing?.anthropic_base_url ??
      endpoint?.anthropic_base_url ?? provider.anthropic_base_url;
  return {
    endpoint,
    modelCapabilities,
    endpoint_id: endpoint?.id ?? input.endpoint_id ?? existing?.endpoint_id ?? "custom",
    endpoint_name: lockedEndpoint ? endpoint?.name : input.endpoint_name ?? endpoint?.name ?? existing?.endpoint_name,
    plan_type: lockedEndpoint && endpoint?.plan_type
      ? endpoint.plan_type
      : input.plan_type ?? endpoint?.plan_type ?? existing?.plan_type ?? "custom",
    protocol,
    auth_type: lockedEndpoint ? endpoint?.auth_type : input.auth_type ?? endpoint?.auth_type ?? existing?.auth_type,
    key_hint: lockedEndpoint ? endpoint?.key_hint : input.key_hint ?? endpoint?.key_hint ?? existing?.key_hint,
    base_url: officialBaseUrl ?? input.base_url ?? endpointBaseUrl ?? existing?.base_url ?? provider.base_url,
    chat_completions_base_url: chatBaseUrl,
    responses_base_url: responsesBaseUrl,
    anthropic_base_url: anthropicBaseUrl,
    resource_id: lockedEndpoint
      ? modelCapabilities?.resource_id ?? endpoint?.resource_id
      : input.resource_id ?? modelCapabilities?.resource_id ?? endpoint?.resource_id ?? existing?.resource_id,
    voice_adapter: lockedEndpoint ? endpoint?.voice_adapter : input.voice_adapter ?? endpoint?.voice_adapter ?? existing?.voice_adapter,
    tts_http_url: lockedEndpoint ? endpoint?.tts_http_url : input.tts_http_url ?? endpoint?.tts_http_url ?? existing?.tts_http_url,
    tts_realtime_url: lockedEndpoint
      ? endpoint?.tts_realtime_url
      : input.tts_realtime_url ?? endpoint?.tts_realtime_url ?? existing?.tts_realtime_url,
    tts_bidirectional_url: lockedEndpoint
      ? endpoint?.tts_bidirectional_url
      : input.tts_bidirectional_url ?? endpoint?.tts_bidirectional_url ?? existing?.tts_bidirectional_url,
    asr_realtime_url: lockedEndpoint
      ? endpoint?.asr_realtime_url
      : input.asr_realtime_url ?? endpoint?.asr_realtime_url ?? existing?.asr_realtime_url,
    asr_async_url: lockedEndpoint ? endpoint?.asr_async_url : input.asr_async_url ?? endpoint?.asr_async_url ?? existing?.asr_async_url,
    tts_voice: lockedEndpoint ? endpoint?.tts_voice : input.tts_voice ?? endpoint?.tts_voice ?? existing?.tts_voice,
    tts_format: lockedEndpoint ? endpoint?.tts_format : input.tts_format ?? endpoint?.tts_format ?? existing?.tts_format,
    tts_sample_rate: lockedEndpoint
      ? endpoint?.tts_sample_rate
      : input.tts_sample_rate ?? endpoint?.tts_sample_rate ?? existing?.tts_sample_rate,
  };
}

function _buildSetting(
  provider: ProviderInfo,
  input: LLMSettingInput,
  now: string,
  existing?: LLMSetting,
): LLMSetting {
  const metadata = _resolveSettingMetadata(provider, input, existing);
  const endpoint = metadata.endpoint;
  const modelPreset = metadata.modelCapabilities;
  const models = input.models ?? (
    existing && existing.model_name === input.model_name
      ? existing.models
      : [input.model_name]
  );
  const displayName = input.display_name?.trim() || input.alias?.trim() ||
    (existing && existing.model_name === input.model_name ? existing.display_name : undefined) ||
    input.model_name;
  return {
    id: existing?.id ?? _generateId(),
    provider_id: input.provider_id,
    model_name: input.model_name,
    // 多模型凭证：优先用 input.models；否则保留 existing；否则单元素数组
    models,
    api_key: input.api_key,
    display_name: displayName,
    endpoint_id: metadata.endpoint_id,
    endpoint_name: metadata.endpoint_name,
    plan_type: metadata.plan_type,
    protocol: metadata.protocol,
    auth_type: metadata.auth_type,
    key_hint: metadata.key_hint,
    base_url: metadata.base_url,
    chat_completions_base_url: metadata.chat_completions_base_url,
    responses_base_url: metadata.responses_base_url,
    anthropic_base_url: metadata.anthropic_base_url,
    resource_id: metadata.resource_id,
    voice_adapter: metadata.voice_adapter,
    tts_http_url: metadata.tts_http_url,
    tts_realtime_url: metadata.tts_realtime_url,
    tts_bidirectional_url: metadata.tts_bidirectional_url,
    asr_realtime_url: metadata.asr_realtime_url,
    asr_async_url: metadata.asr_async_url,
    tts_voice: metadata.tts_voice,
    tts_format: metadata.tts_format,
    tts_sample_rate: metadata.tts_sample_rate,
    is_active: input.is_active ?? existing?.is_active ?? true,
    is_default: input.is_default ?? existing?.is_default ?? false,
    supports_llm: input.supports_llm ?? modelPreset?.supports_llm ?? endpoint?.supports_llm ?? provider.supports_llm ?? existing?.supports_llm ?? true,
    supports_asr: input.supports_asr ?? modelPreset?.supports_asr ?? endpoint?.supports_asr ?? provider.supports_asr ?? existing?.supports_asr ?? false,
    supports_tts: input.supports_tts ?? modelPreset?.supports_tts ?? endpoint?.supports_tts ?? provider.supports_tts ?? existing?.supports_tts ?? false,
    supports_audio_input: input.supports_audio_input ?? modelPreset?.supports_audio_input ?? endpoint?.supports_audio_input ??
      provider.supports_audio_input ?? existing?.supports_audio_input ?? false,
    supports_image_input: input.supports_image_input ?? modelPreset?.supports_image_input ?? endpoint?.supports_image_input ??
      provider.supports_image_input ?? existing?.supports_image_input ?? false,
    supports_video_input: input.supports_video_input ?? modelPreset?.supports_video_input ?? endpoint?.supports_video_input ??
      provider.supports_video_input ?? existing?.supports_video_input ?? false,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function createSetting(input: LLMSettingInput): LLMSetting {
  input = {
    ...input,
    provider_id: _canonicalProviderId(input.provider_id, input.endpoint_id, input.base_url, input.model_name),
  };
  const provider = getProvider(input.provider_id);
  if (!provider) {
    throw new Error(`Unknown provider_id: ${input.provider_id}`);
  }
  if (!input.model_name) {
    throw new Error("Missing required field: model_name");
  }

  const now = new Date().toISOString();
  const settings = _readSettings();
  const metadata = _resolveSettingMetadata(provider, input);

  // 只复用同 credential/endpoint 的 key。Provider 相同但计费方式不同
  // （例如 Xiaomi API 计费 vs Token Plan）必须使用不同 key。
  // 占位标记 "local-no-key" 用于本地无鉴权服务，保持原行为不强制复用。
  if (!input.api_key || input.api_key === "__reuse_existing__") {
    const donor = settings.find(
      (s) =>
        s.provider_id === input.provider_id &&
        (s.endpoint_id ?? "custom") === metadata.endpoint_id &&
        s.api_key &&
        s.api_key !== "local-no-key",
    );
    if (!donor?.api_key) {
      throw new Error("Missing required field: api_key (no existing key to reuse for this credential)");
    }
    input = { ...input, api_key: donor.api_key };
  } else if (input.api_key === "local-no-key") {
    // 本地服务无鉴权：允许空 key 占位通过
  }

  const existingIdx = settings.findIndex(
    (s) =>
      s.provider_id === input.provider_id &&
      s.model_name === input.model_name &&
      (s.endpoint_id ?? "custom") === metadata.endpoint_id,
  );
  if (input.is_default) {
    for (const setting of settings) {
      if (setting.provider_id === input.provider_id) {
        setting.is_default = false;
      }
    }
  }

  if (existingIdx !== -1) {
    const existing = settings[existingIdx];
    const updated = _buildSetting(provider, input, now, existing);
    settings[existingIdx] = updated;
    _writeSettings(settings);
    return updated;
  }

  const setting = _buildSetting(provider, input, now);

  settings.push(setting);
  _writeSettings(settings);
  return setting;
}

export function updateSetting(id: string, patch: Partial<Omit<LLMSetting, "id" | "created_at">>): LLMSetting {
  const settings = _readSettings();
  const idx = settings.findIndex((s) => s.id === id);
  if (idx === -1) {
    throw new Error(`Setting not found: ${id}`);
  }

  const existing = settings[idx];
  const providerId = _canonicalProviderId(
    patch.provider_id ?? existing.provider_id,
    patch.endpoint_id ?? existing.endpoint_id,
    patch.base_url ?? existing.base_url,
    patch.model_name ?? existing.model_name,
  );
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown provider_id: ${providerId}`);
  }

  const modelName = patch.model_name ?? existing.model_name;
  const modelChanged = modelName !== existing.model_name;
  const mergedInput: LLMSettingInput = {
    ...existing,
    ...patch,
    provider_id: providerId,
    model_name: modelName,
    api_key: patch.api_key ?? existing.api_key,
  };
  if (modelChanged && patch.models === undefined) {
    mergedInput.models = undefined;
  }
  if (modelChanged && patch.display_name === undefined) {
    mergedInput.display_name = undefined;
  }
  const updated = _buildSetting(provider, mergedInput, new Date().toISOString(), existing);
  if (updated.is_default) {
    for (const setting of settings) {
      if (setting.id !== updated.id && setting.provider_id === updated.provider_id) {
        setting.is_default = false;
      }
    }
  }
  settings[idx] = updated;
  _writeSettings(settings);
  return updated;
}

export function deleteSetting(id: string): boolean {
  const settings = _readSettings();
  const idx = settings.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  settings.splice(idx, 1);
  _writeSettings(settings);
  return true;
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function _clearAllSettings(): void {
  clearTables(["llm_settings", "llm_custom_providers"]);
}

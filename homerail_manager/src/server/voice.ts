import * as http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { encodeJson, getDb, parseJsonRow } from "../persistence/db.js";
import {
  getDefaultProviders,
  getSetting,
  listSettings,
  type LLMSetting,
} from "../persistence/llm-settings.js";
import {
  DEFAULT_ARK_TTS_VOICE,
  arkVoiceRuntimeFromSetting,
  isArkVoiceSetting,
  synthesizeArkTtsHttp,
  transcribeArkAsr,
} from "./ark-voice.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

interface VoiceTranscribeBody {
  audio_data_url?: unknown;
  mode?: unknown;
  asr_llm_setting_id?: unknown;
  llm_setting_id?: unknown;
  base_url?: unknown;
  model?: unknown;
  api_key?: unknown;
}

interface VoiceModelBody {
  service?: unknown;
  llm_setting_id?: unknown;
  base_url?: unknown;
  token?: unknown;
  api_key?: unknown;
  access_token?: unknown;
}

interface VoiceSpeechBody {
  text?: unknown;
  voice?: unknown;
  speed?: unknown;
  stream?: unknown;
}

type AsrRealtimeStrategy = "native_realtime" | "emulated_batch" | "ark_voice";

const MIMO_API_PROVIDER_ID = "xiaomi";
const MIMO_API_ASR_MODEL = "mimo-v2.5-asr";
const MIMO_API_BASE_URL = "https://api.xiaomimimo.com";
const DEFAULT_MIMO_TTS_MODEL = "mimo-v2.5-tts";
const DEFAULT_MIMO_TTS_VOICE = "mimo_default";
const DEFAULT_MIMO_TTS_SAMPLE_RATE = 24_000;
const DEFAULT_OPENAI_TTS_VOICE = "alloy";
const LEGACY_ARK_TTS_DEFAULT_VOICE = "zh_female_shuangkuaisisi_moon_bigtts";
const DEFAULT_TTS_OUTPUT_CHANNELS = ["commentary", "final"];
const TTS_OUTPUT_CHANNELS = new Set(["commentary", "final"]);
const MIMO_TTS_VOICES = new Set(["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]);

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function _serverError(res: http.ServerResponse, message: string) {
  json(res, 502, { success: false, message, error: message });
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

function _stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function _readVoiceSettingsDocument(): Record<string, unknown> | null {
  try {
    const row = getDb()
      .prepare("SELECT data FROM voice_settings WHERE id = ?")
      .get("default") as { data: string } | undefined;
    if (!row) return null;
    const parsed = parseJsonRow<unknown>(row.data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function _writeVoiceSettingsDocument(data: Record<string, unknown>): void {
  getDb()
    .prepare(`
      INSERT INTO voice_settings(id, updated_at, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
    `)
    .run("default", new Date().toISOString(), encodeJson(data));
}

function _joinApiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let suffix = apiPath.replace(/^\/+/, "");
  if (base.endsWith("/v1") && suffix.startsWith("v1/")) {
    suffix = suffix.slice(3);
  }
  return `${base}/${suffix}`;
}

function _providerBaseUrl(providerId: string): string | undefined {
  return getDefaultProviders().find((provider) => provider.id === providerId)?.base_url;
}

function _authHeaders(token: string, baseUrl: string): Record<string, string> {
  if (!token) return {};
  if (baseUrl.includes("api.xiaomimimo.com")) {
    return { "api-key": token };
  }
  return { Authorization: `Bearer ${token}` };
}

function _httpToWsUrl(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

function _sendWsJson(client: WebSocket, event: Record<string, unknown>): void {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(event));
  }
}

function _normalizeTtsOutputChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TTS_OUTPUT_CHANNELS];
  const channels: string[] = [];
  for (const item of value) {
    const channel = typeof item === "string" ? item.trim() : "";
    if (TTS_OUTPUT_CHANNELS.has(channel) && !channels.includes(channel)) {
      channels.push(channel);
    }
  }
  return channels.length ? channels : ["final"];
}

function _findActiveCapabilitySetting(
  capability: "supports_asr" | "supports_tts",
  modelName?: string,
  providerId?: string,
): LLMSetting | undefined {
  const candidates = listSettings().filter((setting) =>
    setting.is_active &&
    setting[capability] &&
    (!providerId || setting.provider_id === providerId)
  );
  if (candidates.length === 0) {
    return providerId ? _findActiveCapabilitySetting(capability, modelName) : undefined;
  }
  if (modelName) {
    const exact = candidates.find((setting) => setting.model_name === modelName);
    if (exact) return exact;
  }
  return candidates.find((setting) => setting.is_default) ?? candidates[0];
}

function _resolveAsrSettingForDefaults(): LLMSetting | undefined {
  return _findActiveCapabilitySetting("supports_asr");
}

function _resolveTtsSetting(settings?: Record<string, unknown>): LLMSetting | undefined {
  const settingId = _stringField(settings?.tts_llm_setting_id);
  if (settingId) {
    const setting = getSetting(settingId);
    if (setting?.is_active && setting.supports_tts) return setting;
  }
  return _findActiveCapabilitySetting("supports_tts");
}

function _resolveLlmSettingForDefaults(): LLMSetting | undefined {
  return listSettings().find((setting) => setting.is_active && setting.supports_llm && setting.is_default) ??
    listSettings().find((setting) => setting.is_active && setting.supports_llm);
}

function _defaultTtsVoiceFor(runtime: { baseUrl: string; model: string }): string {
  return _isMimoTts(runtime) ? DEFAULT_MIMO_TTS_VOICE : DEFAULT_OPENAI_TTS_VOICE;
}

function _isGenericDefaultTtsVoice(voice: string | undefined): boolean {
  return !voice ||
    voice === DEFAULT_MIMO_TTS_VOICE ||
    voice === DEFAULT_OPENAI_TTS_VOICE ||
    voice === LEGACY_ARK_TTS_DEFAULT_VOICE;
}

function _defaultTtsVoiceForSetting(
  setting: LLMSetting | undefined,
  runtime: { baseUrl: string; model: string },
): string {
  if (isArkVoiceSetting(setting)) {
    return setting.tts_voice || DEFAULT_ARK_TTS_VOICE;
  }
  return _defaultTtsVoiceFor(runtime);
}

function _defaultVoiceSettings() {
  const asrSetting = _resolveAsrSettingForDefaults();
  const llmSetting = _resolveLlmSettingForDefaults();
  const ttsSetting = _resolveTtsSetting();
  const ttsBaseUrl = ttsSetting?.base_url ?? (ttsSetting ? _providerBaseUrl(ttsSetting.provider_id) : undefined) ?? "";
  const ttsModel = ttsSetting?.model_name ?? "";
  return {
    recognition_mode: "asr",
    omni_base_url: "",
    omni_model: "",
    omni_llm_setting_id: "",
    omni_token_set: false,
    llm_base_url: llmSetting?.base_url ?? _providerBaseUrl(llmSetting?.provider_id ?? "") ?? "",
    llm_model: llmSetting?.model_name ?? "",
    llm_setting_id: llmSetting?.id ?? "",
    llm_token_set: Boolean(llmSetting?.api_key),
    asr_base_url: asrSetting?.base_url ?? (asrSetting ? _providerBaseUrl(asrSetting.provider_id) : undefined) ?? "",
    asr_realtime_url: "/api/voice/asr/realtime",
    asr_model: asrSetting?.model_name ?? "",
    asr_llm_setting_id: asrSetting?.id ?? "",
    asr_token_set: Boolean(asrSetting?.api_key),
    tts_base_url: ttsBaseUrl,
    tts_model: ttsModel,
    tts_llm_setting_id: ttsSetting?.id ?? "",
    tts_voice: ttsModel
      ? _defaultTtsVoiceForSetting(ttsSetting, { baseUrl: ttsBaseUrl, model: ttsModel })
      : DEFAULT_MIMO_TTS_VOICE,
    tts_speed: null,
    tts_token_set: Boolean(ttsSetting?.api_key || process.env.HOMERAIL_TTS_API_KEY),
    tts_stream: false,
    tts_output_channels: [...DEFAULT_TTS_OUTPUT_CHANNELS],
  };
}

function _voiceSettingsWithCapabilityDefaults(settings?: Record<string, unknown>): Record<string, unknown> {
  const hasStoredSettings = Boolean(settings);
  const data: Record<string, unknown> = {
    ..._defaultVoiceSettings(),
    ...(settings ?? {}),
  };

  const asrSettingId = _stringField(settings?.asr_llm_setting_id);
  const configuredAsr = asrSettingId ? getSetting(asrSettingId) : undefined;
  const asrSetting = configuredAsr?.is_active && configuredAsr.supports_asr
    ? configuredAsr
    : hasStoredSettings && !asrSettingId
      ? undefined
      : _resolveAsrSettingForDefaults();
  if (asrSetting) {
    data.asr_base_url = asrSetting.base_url ?? _providerBaseUrl(asrSetting.provider_id) ?? MIMO_API_BASE_URL;
    data.asr_model = asrSetting.model_name;
    data.asr_llm_setting_id = asrSetting.id;
  }
  data.asr_token_set = Boolean(asrSetting?.api_key || process.env.HOMERAIL_MIMO_API_KEY);

  const ttsSetting = _resolveTtsSetting(data);
  const hasStoredTtsSettingId = Boolean(_stringField(settings?.tts_llm_setting_id));
  const storedTtsModel = _stringField(settings?.tts_model);
  const shouldApplyTtsSetting = Boolean(ttsSetting) &&
    (!hasStoredSettings || hasStoredTtsSettingId || !storedTtsModel || !storedTtsModel.toLowerCase().includes("tts"));
  if (ttsSetting && shouldApplyTtsSetting) {
    data.tts_base_url = ttsSetting.base_url ?? _providerBaseUrl(ttsSetting.provider_id) ?? "";
    data.tts_model = ttsSetting.model_name;
    data.tts_llm_setting_id = ttsSetting.id;
    const storedTtsVoice = _stringField(settings?.tts_voice);
    if (!storedTtsVoice || (isArkVoiceSetting(ttsSetting) && _isGenericDefaultTtsVoice(storedTtsVoice))) {
      data.tts_voice = _defaultTtsVoiceForSetting(ttsSetting, {
        baseUrl: String(data.tts_base_url ?? ""),
        model: String(data.tts_model ?? ""),
      });
    }
  }
  data.tts_token_set = Boolean(ttsSetting?.api_key || process.env.HOMERAIL_TTS_API_KEY);
  data.tts_output_channels = _normalizeTtsOutputChannels(data.tts_output_channels);
  delete data.omni_token;
  delete data.llm_token;
  delete data.asr_token;
  delete data.tts_token;
  return data;
}

let _storedVoiceSettings: Record<string, unknown> | null = null;
let _voiceSettingsLoaded = false;

/** Reset file-backed store — used by tests / harness cleanup. */
export function _clearStoredVoiceSettings(): void {
  _storedVoiceSettings = null;
  _voiceSettingsLoaded = false;
  getDb().prepare("DELETE FROM voice_settings WHERE id = ?").run("default");
}

export function _clearStoredVoiceSettingsCache(): void {
  _storedVoiceSettings = null;
  _voiceSettingsLoaded = false;
}

function _loadRawVoiceSettings(): Record<string, unknown> | undefined {
  if (!_voiceSettingsLoaded) {
    _storedVoiceSettings = _readVoiceSettingsDocument();
    _voiceSettingsLoaded = true;
  }
  return _storedVoiceSettings ?? undefined;
}

function _loadVoiceSettings(): Record<string, unknown> {
  return _voiceSettingsWithCapabilityDefaults(_loadRawVoiceSettings());
}

function _mergeVoiceSettingsUpdate(body: Record<string, unknown>): Record<string, unknown> {
  const previous = _loadVoiceSettings();
  const merged: Record<string, unknown> = {
    ..._defaultVoiceSettings(),
    ...previous,
    ...body,
  };
  const explicitTtsSettingId = _stringField(body.tts_llm_setting_id);
  const previousTtsSettingId = _stringField(previous.tts_llm_setting_id);
  if (explicitTtsSettingId && explicitTtsSettingId !== previousTtsSettingId && !_stringField(body.tts_voice)) {
    const nextTtsSetting = getSetting(explicitTtsSettingId);
    if (nextTtsSetting?.is_active && nextTtsSetting.supports_tts) {
      const baseUrl = nextTtsSetting.base_url ?? _providerBaseUrl(nextTtsSetting.provider_id) ?? "";
      merged.tts_voice = _defaultTtsVoiceForSetting(nextTtsSetting, {
        baseUrl,
        model: nextTtsSetting.model_name,
      });
    }
  }
  for (const field of ["omni_token", "llm_token", "asr_token", "tts_token"]) {
    delete merged[field];
  }
  const mode = _stringField(merged.recognition_mode);
  merged.recognition_mode = mode === "omni" ? "omni" : "asr";
  merged.tts_output_channels = _normalizeTtsOutputChannels(merged.tts_output_channels);
  return merged;
}

function _saveVoiceSettings(body: Record<string, unknown>): Record<string, unknown> {
  _storedVoiceSettings = _mergeVoiceSettingsUpdate(body);
  _voiceSettingsLoaded = true;
  _writeVoiceSettingsDocument(_storedVoiceSettings);
  return _loadVoiceSettings();
}

function _canonicalVoicePath(pathname: string): string {
  if (pathname === "/api/settings/voice" || pathname === "/api/settings/voice/") {
    return "/api/voice";
  }
  if (pathname.startsWith("/api/settings/voice/")) {
    return `/api/voice/${pathname.slice("/api/settings/voice/".length)}`;
  }
  return pathname;
}

function _resolveAsrSetting(body: VoiceTranscribeBody): LLMSetting | undefined {
  const settingId = _stringField(body.asr_llm_setting_id) ?? _stringField(body.llm_setting_id);
  if (settingId) {
    const setting = getSetting(settingId);
    if (setting?.is_active && setting.supports_asr) return setting;
  }
  return _resolveAsrSettingForDefaults();
}

function _resolveAsrRuntime(body: VoiceTranscribeBody): {
  baseUrl: string;
  model: string;
  apiKey: string;
  setting?: LLMSetting;
} {
  const settings = _loadVoiceSettings();
  const explicitSettingId = _stringField(body.asr_llm_setting_id) ?? _stringField(body.llm_setting_id);
  const savedSettingId = _stringField(settings.asr_llm_setting_id);
  const settingId = explicitSettingId ?? savedSettingId;
  const configuredSetting = settingId ? getSetting(settingId) : undefined;
  const setting = configuredSetting?.is_active && configuredSetting.supports_asr
    ? configuredSetting
    : explicitSettingId
      ? undefined
      : _resolveAsrSetting(body);
  const model =
    _stringField(body.model) ??
    setting?.model_name ??
    _stringField(settings.asr_model) ??
    MIMO_API_ASR_MODEL;
  const baseUrl =
    _stringField(body.base_url) ??
    setting?.base_url ??
    (setting ? _providerBaseUrl(setting.provider_id) : undefined) ??
    _stringField(settings.asr_base_url) ??
    MIMO_API_BASE_URL;
  const apiKey =
    _stringField(body.api_key) ??
    setting?.api_key ??
    process.env.HOMERAIL_MIMO_API_KEY ??
    "";
  if (!apiKey) {
    throw new Error("Missing ASR API key");
  }
  return { baseUrl, model, apiKey, setting };
}

function _isMimoApiAsr(runtime: { baseUrl: string; model: string }): boolean {
  return runtime.model === MIMO_API_ASR_MODEL || runtime.baseUrl.includes("api.xiaomimimo.com");
}

function _mimoAsrPayload(model: string, audioDataUrl: string): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: audioDataUrl },
          },
        ],
      },
    ],
    asr_options: { language: "auto" },
  };
}

function _extractTranscript(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.trim();
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first && typeof first.message === "object" && first.message
    ? first.message as Record<string, unknown>
    : undefined;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

async function _transcribeMimoApiAsr(body: VoiceTranscribeBody): Promise<unknown> {
  const audioDataUrl = _stringField(body.audio_data_url);
  if (!audioDataUrl) {
    throw new Error("Missing required field: audio_data_url");
  }
  const runtime = _resolveAsrRuntime(body);
  const response = await fetch(_joinApiUrl(runtime.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ..._authHeaders(runtime.apiKey, runtime.baseUrl),
    },
    body: JSON.stringify(_mimoAsrPayload(runtime.model, audioDataUrl)),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `ASR request failed with status ${response.status}`);
  }
  return text ? JSON.parse(text) : {};
}

function _decodeAudioDataUrl(audioDataUrl: string): { buffer: Buffer; contentType: string; filename: string } {
  const match = audioDataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw new Error("Invalid audio_data_url");
  const contentType = match[1] || "audio/wav";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf-8");
  const ext = contentType.includes("mpeg") ? "mp3" : contentType.includes("webm") ? "webm" : "wav";
  return { buffer, contentType, filename: `voice.${ext}` };
}

async function _transcribeOpenAiCompatibleAsr(body: VoiceTranscribeBody): Promise<unknown> {
  const audioDataUrl = _stringField(body.audio_data_url);
  if (!audioDataUrl) {
    throw new Error("Missing required field: audio_data_url");
  }
  const runtime = _resolveAsrRuntime(body);
  const configuredTranscriptionUrl = _stringField(runtime.setting?.asr_async_url);
  if (isArkVoiceSetting(runtime.setting)) {
    const result = await transcribeArkAsr(arkVoiceRuntimeFromSetting(runtime.setting, "asr"), audioDataUrl);
    return { text: result.text, raw: result.raw };
  }
  if (_isMimoApiAsr(runtime)) {
    return _transcribeMimoApiAsr(body);
  }
  const audio = _decodeAudioDataUrl(audioDataUrl);
  const form = new FormData();
  form.set("model", runtime.model);
  form.set("file", new Blob([new Uint8Array(audio.buffer)], { type: audio.contentType }), audio.filename);
  const transcriptionUrl = configuredTranscriptionUrl?.match(/^https?:\/\//)
    ? configuredTranscriptionUrl
    : _joinApiUrl(runtime.baseUrl, "/v1/audio/transcriptions");
  const response = await fetch(transcriptionUrl, {
    method: "POST",
    headers: _authHeaders(runtime.apiKey, runtime.baseUrl),
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `ASR request failed with status ${response.status}`);
  }
  return text ? JSON.parse(text) : {};
}

function _resolveModelsRuntime(body: VoiceModelBody): {
  service: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  setting?: LLMSetting;
} {
  const service = _stringField(body.service) ?? "";
  const settingId = _stringField(body.llm_setting_id);
  if (settingId) {
    const setting = getSetting(settingId);
    if (!setting?.is_active) throw new Error(`Unknown or inactive setting: ${settingId}`);
    return {
      service,
      baseUrl: setting.base_url ?? _providerBaseUrl(setting.provider_id) ?? "",
      model: setting.model_name,
      apiKey: setting.api_key,
      setting,
    };
  }
  const baseUrl = _stringField(body.base_url);
  const apiKey = _stringField(body.token)
    ?? _stringField(body.api_key)
    ?? _stringField(body.access_token)
    ?? "";
  if (!baseUrl) throw new Error("Missing required field: base_url");
  return { service, baseUrl, model: service, apiKey };
}

function _hasExplicitVoiceRuntime(body: VoiceModelBody): boolean {
  return Boolean(_stringField(body.llm_setting_id) || _stringField(body.base_url));
}

async function _requestJson(baseUrl: string, apiPath: string, apiKey: string, payload?: unknown): Promise<unknown> {
  const response = await fetch(_joinApiUrl(baseUrl, apiPath), {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ..._authHeaders(apiKey, baseUrl),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Voice request failed with status ${response.status}`);
  }
  return text ? JSON.parse(text) : {};
}

function _extractModelIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const items = Array.isArray((data as Record<string, unknown>).data)
    ? (data as Record<string, unknown>).data as unknown[]
    : [];
  return items
    .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined)
    .filter((id): id is string => typeof id === "string" && Boolean(id));
}

function _normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function _isOpenSpeechBaseUrl(value: string): boolean {
  const normalized = _normalizedBaseUrl(value);
  return normalized === "https://openspeech.bytedance.com/api/v3" ||
    normalized === "https://openspeech.bytedance.com/api/v3/plan";
}

function _catalogVoiceModelsForRuntime(runtime: ReturnType<typeof _resolveModelsRuntime>): string[] | undefined {
  if (!isArkVoiceSetting(runtime.setting) && !_isOpenSpeechBaseUrl(runtime.baseUrl)) return undefined;
  const endpoint = getDefaultProviders()
    .flatMap((provider) => provider.endpoints ?? [])
    .find((candidate) => candidate.protocol === "volcengine_openspeech");
  if (!endpoint) return [];
  const models = endpoint.models.filter((model) => {
    if (runtime.service === "asr") return model.supports_asr;
    if (runtime.service === "tts") return model.supports_tts;
    return model.supports_llm;
  });
  return models.map((model) => model.id);
}

function _catalogVoiceConnectionNotVerified(models: string[]): Record<string, unknown> {
  return {
    models,
    verified: false,
    verification_status: "not_verified",
    warning: "内置模型列表已加载；openspeech 没有无成本连接测试，密钥将在实际 ASR/TTS 调用时验证。",
  };
}

function _isMimoTts(runtime: { baseUrl: string; model: string }): boolean {
  return runtime.model.startsWith(DEFAULT_MIMO_TTS_MODEL)
    || (runtime.baseUrl.includes("xiaomimimo.com") && runtime.model.includes("tts"));
}

function _resolveTtsRuntime(settings?: Record<string, unknown>): {
  baseUrl: string;
  model: string;
  apiKey: string;
  voice: string;
  stream: boolean;
  speed: number | null;
  setting?: LLMSetting;
} {
  const explicitSettingId = _stringField(settings?.tts_llm_setting_id);
  const configuredModel = _stringField(settings?.tts_model);
  const setting = explicitSettingId || !configuredModel || !configuredModel.toLowerCase().includes("tts")
    ? _resolveTtsSetting(settings)
    : undefined;
  const rawBaseUrl =
    setting?.base_url ??
    (setting ? _providerBaseUrl(setting.provider_id) : undefined) ??
    _stringField(settings?.tts_base_url) ??
    "";
  const baseUrl = rawBaseUrl.replace(/\/anthropic\/?$/, "");
  const model = setting?.model_name ?? _stringField(settings?.tts_model) ?? "";
  const apiKey = setting?.api_key ?? process.env.HOMERAIL_TTS_API_KEY ?? "";
  const rawSpeed = settings?.tts_speed;
  const storedVoice = _stringField(settings?.tts_voice);
  const voice = isArkVoiceSetting(setting) && _isGenericDefaultTtsVoice(storedVoice)
    ? setting.tts_voice || DEFAULT_ARK_TTS_VOICE
    : storedVoice ?? _defaultTtsVoiceForSetting(setting, { baseUrl, model });
  return {
    baseUrl,
    model,
    apiKey,
    voice,
    stream: typeof settings?.tts_stream === "boolean" ? settings.tts_stream : false,
    speed: typeof rawSpeed === "number" ? rawSpeed : null,
    setting,
  };
}

function _buildTtsPayload(
  runtime: ReturnType<typeof _resolveTtsRuntime>,
  body: VoiceSpeechBody,
): Record<string, unknown> {
  const text = _stringField(body.text);
  if (!text) throw new Error("Missing required field: text");
  if (!runtime.baseUrl) throw new Error("Missing TTS base URL");
  if (!runtime.model) throw new Error("Missing TTS model");
  const voice = _stringField(body.voice) ?? runtime.voice;
  const speed = typeof body.speed === "number" ? body.speed : runtime.speed;
  if (_isMimoTts(runtime)) {
    if (!MIMO_TTS_VOICES.has(voice)) {
      throw new Error(`Invalid mimo-v2.5-tts voice '${voice}'`);
    }
    return {
      model: runtime.model,
      messages: [
        { role: "user", content: "Read the assistant message aloud in the specified voice." },
        { role: "assistant", content: text },
      ],
      audio: { format: "wav", voice },
    };
  }
  const payload: Record<string, unknown> = {
    model: runtime.model,
    input: text,
    stream: typeof body.stream === "boolean" ? body.stream : runtime.stream,
  };
  if (voice) payload.voice = voice;
  if (speed !== null) payload.speed = speed;
  if (runtime.model === "qwen3-tts") {
    payload.stream = false;
    payload.seed = 20260523;
  }
  return payload;
}

function _extractMimoAudio(data: unknown): Buffer {
  const choices = data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).choices)
    ? (data as Record<string, unknown>).choices as unknown[]
    : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first && typeof first.message === "object" && first.message
    ? first.message as Record<string, unknown>
    : undefined;
  const audio = message && typeof message.audio === "object" && message.audio
    ? message.audio as Record<string, unknown>
    : undefined;
  const encoded = typeof audio?.data === "string" ? audio.data.trim() : "";
  if (!encoded) throw new Error("MiMo TTS response did not include audio.data");
  return Buffer.from(encoded, "base64");
}

export function voiceRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const pathname = _canonicalVoicePath(new URL(req.url || "/", "http://localhost").pathname);

  if ((pathname === "/api/voice" || pathname === "/api/voice/") && req.method === "GET") {
    _ok(res, "Voice settings retrieved", _loadVoiceSettings());
    return true;
  }

  if ((pathname === "/api/voice" || pathname === "/api/voice/") && req.method === "PUT") {
    _readJsonBody(req)
      .then((body) => {
        const settings = typeof body === "object" && body !== null
          ? body as Record<string, unknown>
          : {};
        _ok(res, "Voice settings updated", _saveVoiceSettings(settings));
      })
      .catch((err) => {
        _serverError(res, err instanceof Error ? err.message : String(err));
      });
    return true;
  }

  if (pathname === "/api/voice/models" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        if (!_hasExplicitVoiceRuntime(body as VoiceModelBody)) {
          _ok(res, "Voice models retrieved", { models: [] });
          return;
        }
        const runtime = _resolveModelsRuntime(body as VoiceModelBody);
        if (!runtime.baseUrl || !runtime.apiKey) {
          _ok(res, "Voice models retrieved", { models: [] });
          return;
        }
        const catalogModels = _catalogVoiceModelsForRuntime(runtime);
        if (catalogModels) {
          _ok(res, "Voice models retrieved", { models: catalogModels });
          return;
        }
        const data = await _requestJson(runtime.baseUrl, "/v1/models", runtime.apiKey);
        _ok(res, "Voice models retrieved", { models: _extractModelIds(data), raw: data });
      })
      .catch((err) => {
        _serverError(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  if (pathname === "/api/voice/test" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        if (!_hasExplicitVoiceRuntime(body as VoiceModelBody)) {
          _ok(res, "Voice connection test result", { models: [] });
          return;
        }
        const runtime = _resolveModelsRuntime(body as VoiceModelBody);
        if (!runtime.baseUrl || !runtime.apiKey) {
          _ok(res, "Voice connection test result", { models: [] });
          return;
        }
        const catalogModels = _catalogVoiceModelsForRuntime(runtime);
        if (catalogModels) {
          _ok(res, "Voice connection not verified", _catalogVoiceConnectionNotVerified(catalogModels));
          return;
        }
        const data = await _requestJson(runtime.baseUrl, "/v1/models", runtime.apiKey);
        _ok(res, "Voice connection test result", {
          models: _extractModelIds(data),
          raw: data,
          verified: true,
          verification_status: "verified",
        });
      })
      .catch((err) => {
        _serverError(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  if (pathname === "/api/voice/speech" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        const runtime = _resolveTtsRuntime(_loadVoiceSettings());
        const configuredSpeechUrl = _stringField(runtime.setting?.tts_http_url);
        if (!runtime.apiKey) throw new Error("Missing TTS API key");
        if (isArkVoiceSetting(runtime.setting)) {
          const text = _stringField((body as VoiceSpeechBody).text);
          if (!text) throw new Error("Missing required field: text");
          const result = await synthesizeArkTtsHttp(arkVoiceRuntimeFromSetting(runtime.setting, "tts"), {
            text,
            voice: _stringField((body as VoiceSpeechBody).voice) ?? runtime.voice,
          });
          res.writeHead(200, {
            "Content-Type": result.contentType,
            "Cache-Control": "no-store",
          });
          res.end(result.audio);
          return;
        }
        const payload = _buildTtsPayload(runtime, body as VoiceSpeechBody);
        if (_isMimoTts(runtime)) {
          const data = await _requestJson(runtime.baseUrl, "/v1/chat/completions", runtime.apiKey, payload);
          const audio = _extractMimoAudio(data);
          const wav = _looksLikeWav(audio) ? audio : _wavFromPcm16(audio, DEFAULT_MIMO_TTS_SAMPLE_RATE);
          res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
          res.end(wav);
          return;
        }
        const speechUrl = configuredSpeechUrl?.match(/^https?:\/\//)
          ? configuredSpeechUrl
          : _joinApiUrl(runtime.baseUrl, "/v1/audio/speech");
        const upstream = await fetch(speechUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ..._authHeaders(runtime.apiKey, runtime.baseUrl),
          },
          body: JSON.stringify(payload),
        });
        if (!upstream.ok) {
          _serverError(res, await upstream.text());
          return;
        }
        res.writeHead(200, {
          "Content-Type": upstream.headers.get("content-type") ?? "audio/wav",
          "Cache-Control": "no-store",
        });
        const bodyStream = upstream.body;
        if (!bodyStream) {
          res.end();
          return;
        }
        for await (const chunk of bodyStream as unknown as AsyncIterable<Uint8Array>) {
          res.write(Buffer.from(chunk));
        }
        res.end();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Missing required field")) {
          _badRequest(res, message);
          return;
        }
        _serverError(res, message);
      });
    return true;
  }

  if (pathname === "/api/voice/transcribe" && req.method === "POST") {
    _readJsonBody(req)
      .then(async (body) => {
        const b = body as VoiceTranscribeBody;
        const data = await _transcribeOpenAiCompatibleAsr(b);
        _ok(res, "语音转写成功", {
          text: _extractTranscript(data),
          raw: data,
          mode: _stringField(b.mode) ?? "asr",
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("Missing ")) {
          _badRequest(res, message);
          return;
        }
        _serverError(res, message);
      });
    return true;
  }

  return false;
}

function _looksLikeWav(buffer: Buffer): boolean {
  return buffer.byteLength >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE";
}

function _wavFromPcm16(pcm: Buffer, sampleRate = 16_000): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

function _pcm16ChunksToWavDataUrl(chunks: Buffer[]): string {
  const pcm = Buffer.concat(chunks);
  if (!pcm.byteLength) {
    throw new Error("No ASR audio received");
  }
  const wav = _wavFromPcm16(pcm);
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

function _wsBinaryToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function _resolveAsrRealtimeRuntime(): {
  realtimeUrl: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  strategy: AsrRealtimeStrategy;
  setting?: LLMSetting;
} {
  const settings = _loadVoiceSettings();
  const settingId = _stringField(settings.asr_llm_setting_id);
  const configuredSetting = settingId ? getSetting(settingId) : undefined;
  const setting = configuredSetting?.is_active && configuredSetting.supports_asr
    ? configuredSetting
    : _resolveAsrSettingForDefaults();
  const baseUrl =
    setting?.base_url ??
    (setting ? _providerBaseUrl(setting.provider_id) : undefined) ??
    _stringField(settings.asr_base_url) ??
    MIMO_API_BASE_URL;
  const model = setting?.model_name ?? _stringField(settings.asr_model) ?? MIMO_API_ASR_MODEL;
  const apiKey = setting?.api_key ?? process.env.HOMERAIL_MIMO_API_KEY ?? "";
  const explicitRealtimeUrl = _stringField(setting?.asr_realtime_url) ??
    _stringField(settings.asr_realtime_url);
  const strategy: AsrRealtimeStrategy = isArkVoiceSetting(setting)
    ? "ark_voice"
    : _isMimoApiAsr({ baseUrl, model })
      ? "emulated_batch"
      : "native_realtime";
  return {
    realtimeUrl: explicitRealtimeUrl && !explicitRealtimeUrl.startsWith("/api/")
      ? explicitRealtimeUrl
      : _httpToWsUrl(_joinApiUrl(baseUrl, "/v1/realtime")),
    model,
    apiKey,
    baseUrl,
    strategy,
    setting,
  };
}

function _setupEmulatedAsrSession(client: WebSocket, runtime: ReturnType<typeof _resolveAsrRealtimeRuntime>): void {
  const audioChunks: Buffer[] = [];
  let finishing = false;
  _sendWsJson(client, { type: "ready" });
  _sendWsJson(client, {
    type: "session.ready",
    strategy: runtime.strategy,
    model: runtime.model,
  });

  const finish = async () => {
    if (finishing) return;
    finishing = true;
    try {
      _sendWsJson(client, {
        type: "transcription.processing",
        strategy: runtime.strategy,
      });
      const audioDataUrl = _pcm16ChunksToWavDataUrl(audioChunks);
      const text = isArkVoiceSetting(runtime.setting)
        ? (await transcribeArkAsr(arkVoiceRuntimeFromSetting(runtime.setting, "asr"), audioDataUrl)).text
        : _extractTranscript(await _transcribeMimoApiAsr({
          audio_data_url: audioDataUrl,
          mode: "asr",
        }));
      _sendWsJson(client, {
        type: "transcription.done",
        strategy: runtime.strategy,
        model: runtime.model,
        text,
        transcript: text,
      });
    } catch (err) {
      _sendWsJson(client, {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        code: "asr_emulated_realtime_error",
      });
    }
  };

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      audioChunks.push(_wsBinaryToBuffer(data));
      return;
    }
    try {
      const event = JSON.parse(data.toString());
      if (event?.type === "finish") {
        void finish();
      } else if (event?.type === "start") {
        audioChunks.length = 0;
        finishing = false;
        _sendWsJson(client, { type: "session.started", strategy: runtime.strategy });
      } else {
        _sendWsJson(client, { type: "error", error: `Unknown ASR realtime event: ${event?.type ?? ""}` });
      }
    } catch (err) {
      _sendWsJson(client, { type: "error", error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function setupVoiceRealtimeWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = _canonicalVoicePath(new URL(req.url || "/", "http://localhost").pathname);
    if (pathname !== "/api/voice/asr/realtime") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (client: WebSocket) => {
    let upstream: WebSocket | null = null;
    client.on("error", () => {
      upstream?.close();
    });
    try {
      const runtime = _resolveAsrRealtimeRuntime();
      if (!runtime.apiKey) throw new Error("Missing ASR API key");
      if (runtime.strategy === "emulated_batch" || runtime.strategy === "ark_voice") {
        _setupEmulatedAsrSession(client, runtime);
        return;
      }
      upstream = new WebSocket(runtime.realtimeUrl, {
        headers: _authHeaders(runtime.apiKey, runtime.baseUrl),
        maxPayload: 20 * 1024 * 1024,
      });
      upstream.on("open", () => {
        _sendWsJson(client, { type: "ready" });
        upstream?.send(JSON.stringify({ type: "session.update", model: runtime.model }));
        upstream?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      });
      upstream.on("message", (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        client.send(data, { binary: isBinary });
        if (!isBinary) {
          try {
            const event = JSON.parse(data.toString());
            if (event?.type === "transcription.done") {
              upstream?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            }
          } catch {
            // Ignore non-JSON upstream text frames.
          }
        }
      });
      upstream.on("error", (err) => {
        _sendWsJson(client, { type: "error", error: err.message, code: "asr_realtime_proxy_error" });
      });
      upstream.on("close", () => {
        if (client.readyState === WebSocket.OPEN) client.close();
      });
      client.on("message", (data, isBinary) => {
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        if (isBinary) {
          upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: _wsBinaryToBuffer(data).toString("base64") }));
          return;
        }
        try {
          const event = JSON.parse(data.toString());
          if (event?.type === "finish") {
            upstream.send(JSON.stringify({ type: "input_audio_buffer.commit", final: true }));
          } else if (event?.type === "start") {
            upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          } else {
            _sendWsJson(client, { type: "error", error: `Unknown ASR realtime event: ${event?.type ?? ""}` });
          }
        } catch (err) {
          _sendWsJson(client, { type: "error", error: err instanceof Error ? err.message : String(err) });
        }
      });
      client.on("close", () => upstream?.close());
    } catch (err) {
      _sendWsJson(client, {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        code: "asr_realtime_proxy_error",
      });
      client.close();
    }
  });

  return wss;
}

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _clearAllSettings,
  createSetting,
  findActiveClaudeSdkCompatibleSetting,
  findActiveSetting,
  listProviders,
  listSettings,
  resolveClaudeSdkBaseUrlForSetting,
  updateSetting,
} from "../src/persistence/llm-settings.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function storedLlmSettingsText(): string {
  return JSON.stringify(getDb().prepare("SELECT api_key_encrypted, secret_storage, data FROM llm_settings").all());
}

describe("custom LLM providers", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-llm-providers-"));
    process.env.HOMERAIL_HOME = tmpHome;
    _clearAllSettings();
    server = createServer(0, undefined, undefined, false);
  });

  it("separates Kimi CN and international credentials and migrates the legacy Coding Plan", () => {
    const providers = listProviders();
    const kimiCn = providers.find((provider) => provider.id === "kimi_cn");
    const kimiInternational = providers.find((provider) => provider.id === "kimi");

    expect(kimiCn).toMatchObject({
      name: "Kimi / Moonshot CN",
      base_url: "https://api.moonshot.cn/v1",
    });
    expect(kimiCn?.endpoints).toContainEqual(expect.objectContaining({
      id: "kimi_cn_api",
      base_url: "https://api.moonshot.cn/v1",
      default_model: "kimi-k2.7-code",
    }));
    expect(kimiCn?.endpoints).toContainEqual(expect.objectContaining({
      id: "kimi_coding_plan",
      base_url: "https://api.kimi.com/coding/v1",
      default_model: "kimi-for-coding",
    }));
    expect(kimiInternational).toMatchObject({
      name: "Kimi / Moonshot",
      base_url: "https://api.moonshot.ai/v1",
    });
    expect(kimiInternational?.endpoints).toHaveLength(1);

    const migrated = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-legacy-kimi-coding-plan",
      is_active: true,
      is_default: true,
    });
    expect(migrated).toMatchObject({
      provider_id: "kimi_cn",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-for-coding",
      base_url: "https://api.kimi.com/coding/v1",
    });
  });

  afterEach(async () => {
    _clearAllSettings();
    await close(server);
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    closeDb();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("upserts a custom provider and accepts settings that reference it", async () => {
    const port = await listen(server);

    const providerResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "kimi-fast",
        name: "Kimi Fast",
        default_model: "kimi-for-coding",
        base_url: "https://api.kimi.com/coding/v1",
      }),
    });
    const providerBody = await providerResponse.json() as {
      success: boolean;
      data: { id: string; default_model: string };
    };
    expect(providerResponse.status).toBe(201);
    expect(providerBody.success).toBe(true);
    expect(providerBody.data).toMatchObject({
      id: "kimi-fast",
      default_model: "kimi-for-coding",
    });

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`);
    const listBody = await listResponse.json() as {
      data: {
        providers: Array<{
          id: string;
          name?: string;
          base_url?: string;
          supports_llm?: boolean;
          supports_asr?: boolean;
          supports_tts?: boolean;
          endpoints?: Array<{
            id: string;
            provider_id?: string;
            plan_type?: string;
            protocol?: string;
            auth_type?: string;
            resource_id?: string;
            base_url?: string;
            tts_http_url?: string;
            asr_realtime_url?: string;
          }>;
        }>;
      };
    };
    expect(listBody.data.providers.find((provider) => provider.id === "kimi-fast")).toMatchObject({
      base_url: "https://api.kimi.com/coding/v1",
    });
    expect(listBody.data.providers.find((provider) => provider.id === "xiaomi")).toBeTruthy();
    expect(listBody.data.providers.find((provider) => provider.id === "xiaomi")?.endpoints?.length).toBeGreaterThan(1);
    expect(listBody.data.providers.find((provider) => provider.id === "aliyun")?.endpoints?.[0]).toMatchObject({
      protocol: "openai_compatible",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const volcengine = listBody.data.providers.find((provider) => provider.id === "volcengine");
    expect(listBody.data.providers.find((provider) => provider.id === "doubao-speech")).toBeUndefined();
    expect(volcengine).toMatchObject({ id: "volcengine", name: "火山方舟" });
    expect(volcengine?.endpoints).toContainEqual(
      expect.objectContaining({
        id: "volcengine_openspeech_api",
        provider_id: "volcengine",
        plan_type: "api_billing",
        protocol: "volcengine_openspeech",
        auth_type: "x-api-key",
        resource_id: "seed-tts-2.0",
        tts_http_url: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        asr_realtime_url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
      }),
    );

    const settingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "kimi-fast",
        model_name: "kimi-for-coding",
        display_name: "Kimi Fast Alias",
        base_url: "https://api.kimi.com/coding/v1",
        api_key: "pk-kimi-secret-123456",
        is_active: true,
        is_default: true,
      }),
    });
    const settingBody = await settingResponse.json() as {
      success: boolean;
      data: { id: string; provider_id: string; api_key: string; display_name: string; api_key_display: string };
    };
    expect(settingResponse.status).toBe(201);
    expect(settingBody.success).toBe(true);
    expect(settingBody.data).toMatchObject({
      provider_id: "kimi-fast",
      api_key: "pk-k****3456",
      api_key_display: "pk-k****3456",
      display_name: "Kimi Fast Alias",
    });

    const active = findActiveSetting("kimi-fast", "kimi-for-coding");
    expect(active).toMatchObject({
      provider_id: "kimi-fast",
      model_name: "kimi-for-coding",
      base_url: "https://api.kimi.com/coding/v1",
      api_key: "pk-kimi-secret-123456",
    });

    const stored = storedLlmSettingsText();
    expect(stored).not.toContain("pk-kimi-secret-123456");
    expect(stored).toContain("api_key_encrypted");
    expect(stored).toContain("manager_encrypted");
  });

  it("updates custom providers without clearing omitted fields", async () => {
    const port = await listen(server);
    const createResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "editable-provider",
        name: "Editable Provider",
        default_model: "model-v1",
        base_url: "http://provider.test/v1",
        supports_llm: true,
        supports_asr: true,
      }),
    });
    expect(createResponse.status).toBe(201);

    const settingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "editable-provider",
        model_name: "model-v1",
        api_key: "local-no-key",
        supports_llm: false,
        supports_asr: true,
      }),
    });
    expect(settingResponse.status).toBe(201);

    const overrideResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "editable-provider",
        model_name: "model-v2",
        base_url: "http://model-override.test/v1",
        api_key: "local-no-key",
        supports_llm: true,
      }),
    });
    expect(overrideResponse.status).toBe(201);

    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers/editable-provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Provider",
        base_url: "http://provider-new.test/v1",
        voice_adapter: "openai_audio",
        asr_async_url: "http://provider-new.test/v1/audio/transcriptions",
        asr_realtime_url: "ws://provider-new.test/v1/realtime",
      }),
    });
    expect(updateResponse.status).toBe(200);
    const body = (await updateResponse.json()) as {
      data: {
        id: string;
        name: string;
        default_model: string;
        base_url: string;
        supports_asr: boolean;
        asr_async_url: string;
        asr_realtime_url: string;
      };
    };
    expect(body.data).toMatchObject({
      id: "editable-provider",
      name: "Renamed Provider",
      default_model: "model-v1",
      base_url: "http://provider-new.test/v1",
      supports_asr: true,
      asr_async_url: "http://provider-new.test/v1/audio/transcriptions",
      asr_realtime_url: "ws://provider-new.test/v1/realtime",
    });
    expect(findActiveSetting("editable-provider", "model-v1")).toMatchObject({
      base_url: "http://provider-new.test/v1",
      voice_adapter: "openai_audio",
      asr_async_url: "http://provider-new.test/v1/audio/transcriptions",
      asr_realtime_url: "ws://provider-new.test/v1/realtime",
    });
    expect(findActiveSetting("editable-provider", "model-v2")).toMatchObject({
      base_url: "http://model-override.test/v1",
    });
  });

  it("rejects provider changes on model edits and protects referenced providers", async () => {
    const port = await listen(server);
    for (const id of ["provider-a", "provider-b"]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          name: id,
          default_model: "model-v1",
          base_url: `http://${id}.test/v1`,
        }),
      });
      expect(response.status).toBe(201);
    }

    const settingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "provider-a",
        model_name: "model-v1",
        api_key: "secret-a",
      }),
    });
    const setting = (await settingResponse.json()) as { data: { id: string } };
    expect(settingResponse.status).toBe(201);

    const moveResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings/${setting.data.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "provider-b" }),
    });
    expect(moveResponse.status).toBe(400);
    expect(findActiveSetting("provider-a", "model-v1")).toBeTruthy();
    expect(findActiveSetting("provider-b", "model-v1")).toBeUndefined();

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers/provider-a`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(409);
    expect(findActiveSetting("provider-a", "model-v1")).toBeTruthy();

    const cascadeResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers/provider-a?cascade=true`, {
      method: "DELETE",
    });
    expect(cascadeResponse.status).toBe(200);
    expect(findActiveSetting("provider-a", "model-v1")).toBeUndefined();

    const missingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers/provider-a`);
    expect(missingResponse.status).toBe(404);
  });

  it("returns catalog models for openspeech provider probes", async () => {
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/llm/models/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: "https://openspeech.bytedance.com/api/v3",
        api_key: "openspeech-secret-never-used",
      }),
    });
    const body = await response.json() as { data?: { models?: string[]; error?: string } };

    expect(response.status).toBe(200);
    expect(body.data?.models).toEqual(expect.arrayContaining([
      "doubao-seed-tts-2.0",
      "doubao-seed-asr-2.0",
      "doubao-bigasr-1.0",
    ]));
    expect(body.data?.models).toHaveLength(3);
    expect(body.data?.error).toBeUndefined();
  });

  it("migrates legacy plaintext DB settings to Manager-encrypted storage", () => {
    getDb().prepare(`
      INSERT INTO llm_settings(id, provider_id, model_name, updated_at, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "legacy-setting",
      "xiaomi",
      "mimo-v2.5-pro",
      "2026-01-01T00:00:00.000Z",
      JSON.stringify(
      {
        id: "legacy-setting",
        provider_id: "xiaomi",
        model_name: "mimo-v2.5-pro",
        api_key: "legacy-secret-token",
        is_active: true,
        is_default: true,
        supports_llm: true,
        supports_asr: false,
        supports_tts: false,
        supports_audio_input: false,
        supports_image_input: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      ),
    );

    const active = findActiveSetting("xiaomi", "mimo-v2.5-pro");

    expect(active?.api_key).toBe("legacy-secret-token");
    expect(active?.endpoint_id).toBe("xiaomi_mimo_token_plan");
    expect(active?.plan_type).toBe("token_plan");
    const migrated = storedLlmSettingsText();
    expect(migrated).not.toContain("legacy-secret-token");
    expect(migrated).toContain("api_key_encrypted");
    expect(migrated).toContain("manager_encrypted");
    expect(migrated).toContain("endpoint_id");
  });

  it("locks built-in provider base URLs while keeping custom providers editable", async () => {
    const port = await listen(server);

    const providerOverrideResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "xiaomi",
        name: "Overridden Xiaomi",
        default_model: "mimo-v2.5-pro",
        base_url: "https://override.example/v1",
      }),
    });
    const providerOverrideBody = await providerOverrideResponse.json() as { error?: string };
    expect(providerOverrideResponse.status).toBe(400);
    expect(providerOverrideBody.error).toContain("Cannot override built-in provider");

    const settingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_token_plan",
        model_name: "mimo-v2.5-pro",
        base_url: "https://override.example/anthropic",
        api_key: "tp-locked-url",
        is_active: true,
      }),
    });
    const settingBody = await settingResponse.json() as {
      data: {
        base_url: string;
        provider_base_url: string;
        chat_completions_base_url: string;
        anthropic_base_url: string;
      };
    };
    expect(settingResponse.status).toBe(201);
    expect(settingBody.data.base_url).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(settingBody.data.provider_base_url).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(settingBody.data.chat_completions_base_url).toBe("https://token-plan-cn.xiaomimimo.com/v1");
    expect(settingBody.data.anthropic_base_url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic");
    expect(findActiveSetting("xiaomi", "mimo-v2.5-pro")?.base_url).toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

  it("reuses API keys only within the same credential endpoint", async () => {
    const port = await listen(server);

    const apiBillingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_api",
        model_name: "mimo-v2.5-pro",
        api_key: "api-billing-secret",
        is_active: true,
      }),
    });
    expect(apiBillingResponse.status).toBe(201);

    const sameCredentialResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_api",
        model_name: "mimo-v2.5-tts",
        reuse_existing_api_key: true,
        is_active: true,
        supports_llm: false,
        supports_tts: true,
      }),
    });
    expect(sameCredentialResponse.status).toBe(201);
    expect(findActiveSetting("xiaomi", "mimo-v2.5-tts")?.api_key).toBe("api-billing-secret");

    const tokenPlanResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_token_plan",
        model_name: "mimo-v2.5-pro",
        reuse_existing_api_key: true,
        is_active: true,
      }),
    });
    const tokenPlanBody = await tokenPlanResponse.json() as { success: boolean; error?: string };
    expect(tokenPlanResponse.status).toBe(400);
    expect(tokenPlanBody.success).toBe(false);
    expect(tokenPlanBody.error).toContain("no existing key to reuse for this credential");

    const reservedSentinelResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_api",
        model_name: "mimo-reserved-key",
        api_key: "__reuse_existing__",
      }),
    });
    const reservedSentinelBody = await reservedSentinelResponse.json() as { error?: string };
    expect(reservedSentinelResponse.status).toBe(400);
    expect(reservedSentinelBody.error).toContain("Reserved API key value");
  });

  it("stores Doubao Speech API billing settings without returning plaintext API keys", async () => {
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "volcengine",
        endpoint_id: "volcengine_ark_voice_api",
        model_name: "doubao-seed-tts-2.0",
        display_name: "豆包语音 TTS",
        api_key: "openspeech-token-voice-secret-123456",
        is_active: true,
        supports_llm: false,
        supports_tts: true,
      }),
    });
    const body = await response.json() as {
      data: {
        api_key: string;
        api_key_display: string;
        protocol: string;
        plan_type: string;
        resource_id: string;
        voice_adapter: string;
        tts_http_url: string;
      };
    };

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      api_key: "open****3456",
      api_key_display: "open****3456",
      provider_id: "volcengine",
      provider_name: "火山方舟",
      endpoint_id: "volcengine_openspeech_api",
      protocol: "volcengine_openspeech",
      plan_type: "api_billing",
      resource_id: "seed-tts-2.0",
      voice_adapter: "volcengine_openspeech",
      tts_http_url: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    });

    const active = findActiveSetting("volcengine", "doubao-seed-tts-2.0");
    expect(active).toMatchObject({
      provider_id: "volcengine",
      endpoint_id: "volcengine_openspeech_api",
      protocol: "volcengine_openspeech",
      plan_type: "api_billing",
      resource_id: "seed-tts-2.0",
      api_key: "openspeech-token-voice-secret-123456",
    });
    expect(findActiveSetting("doubao-speech", "doubao-seed-tts-2.0")?.id).toBe(active?.id);

    const stored = storedLlmSettingsText();
    expect(stored).not.toContain("openspeech-token-voice-secret-123456");
    expect(stored).toContain("api_key_encrypted");
  });

  it("refreshes locked Doubao Speech metadata when switching ASR resource models", async () => {
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "volcengine",
        endpoint_id: "volcengine_openspeech_api",
        model_name: "doubao-seed-asr-2.0",
        display_name: "doubao-seed-asr-2.0",
        endpoint_name: "legacy endpoint name",
        key_hint: "legacy key hint",
        api_key: "openspeech-asr-secret-123456",
        is_active: true,
        supports_llm: false,
        supports_asr: true,
        supports_audio_input: true,
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { id: string } };

    const updated = updateSetting(body.data.id, { model_name: "doubao-bigasr-1.0" });

    expect(updated).toMatchObject({
      provider_id: "volcengine",
      model_name: "doubao-bigasr-1.0",
      models: ["doubao-bigasr-1.0"],
      display_name: "doubao-bigasr-1.0",
      endpoint_name: "火山语音 API（openspeech）",
      key_hint: "火山语音控制台 X-Api-Key（不是火山方舟模型 API Key）",
      resource_id: "volc.bigasr.sauc.duration",
    });
  });

  it("updates an existing provider/model setting instead of creating competing defaults", async () => {
    const port = await listen(server);

    const providerResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "custom-local-fast",
        name: "Custom Local Fast",
        default_model: "custom-model-v1",
        base_url: "http://model-endpoint.test:5000",
      }),
    });
    expect(providerResponse.status).toBe(201);

    const firstResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "custom-local-fast",
        model_name: "custom-model-v1",
        base_url: "http://model-endpoint.test:5000/v1",
        api_key: "old-key",
        is_active: true,
        is_default: true,
      }),
    });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { data: { id: string } };

    const secondResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "custom-local-fast",
        model_name: "custom-model-v1",
        base_url: "http://model-endpoint.test:5000",
        api_key: "new-key",
        is_active: true,
        is_default: true,
      }),
    });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as { data: { id: string } };

    expect(second.data.id).toBe(first.data.id);
    const settings = listSettings().filter(
      (setting) => setting.provider_id === "custom-local-fast" && setting.model_name === "custom-model-v1",
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      api_key: "new-key",
      base_url: "http://model-endpoint.test:5000",
      is_default: true,
    });
    expect(findActiveSetting("custom-local-fast", "custom-model-v1")?.base_url).toBe("http://model-endpoint.test:5000");
  });

  it("keeps endpoint-specific settings separate for the same provider and model", async () => {
    const port = await listen(server);

    const openaiResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_api",
        model_name: "mimo-v2.5-pro",
        api_key: "pk-api-billing",
        is_active: true,
        is_default: false,
      }),
    });
    expect(openaiResponse.status).toBe(201);

    const anthropicResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        endpoint_id: "xiaomi_mimo_token_plan",
        model_name: "mimo-v2.5-pro",
        api_key: "tp-token-plan",
        is_active: true,
        is_default: true,
      }),
    });
    expect(anthropicResponse.status).toBe(201);

    const xiaomiSettings = listSettings().filter((setting) =>
      setting.provider_id === "xiaomi" && setting.model_name === "mimo-v2.5-pro"
    );
    expect(xiaomiSettings).toHaveLength(2);
    expect(xiaomiSettings.map((setting) => setting.endpoint_id).sort()).toEqual([
      "xiaomi_mimo_api",
      "xiaomi_mimo_token_plan",
    ]);
    // Claude SDK 不支持 Chat Completions；合并 endpoint 上必须解析到
    // Anthropic URL，不能把 chat completions base URL 传给 SDK。
    const claudeCompatible = findActiveClaudeSdkCompatibleSetting();
    expect(claudeCompatible?.endpoint_id).toBe("xiaomi_mimo_token_plan");
    expect(resolveClaudeSdkBaseUrlForSetting(claudeCompatible!)).toBe("https://token-plan-cn.xiaomimimo.com/anthropic");
    expect(resolveClaudeSdkBaseUrlForSetting(claudeCompatible!)).not.toBe("https://token-plan-cn.xiaomimimo.com/v1");
  });

  it("lets Claude SDK Manager Agent settings inherit Anthropic URLs from the provider", async () => {
    const port = await listen(server);

    const providerResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "local-qwen-fast",
        name: "Local Qwen Fast",
        default_model: "qwen3.6",
        base_url: "http://127.0.0.1:5000",
        chat_completions_base_url: "http://127.0.0.1:5000/v1",
        anthropic_base_url: "http://127.0.0.1:5000/anthropic",
      }),
    });
    expect(providerResponse.status).toBe(201);

    const settingResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "local-qwen-fast",
        endpoint_id: "local-qwen-fast_custom",
        model_name: "qwen3.6",
        api_key: "pk-local-qwen",
        protocol: "openai_compatible",
        chat_completions_base_url: "http://127.0.0.1:5000/v1",
        is_active: true,
        is_default: true,
      }),
    });
    expect(settingResponse.status).toBe(201);

    const setting = listSettings().find((item) => item.provider_id === "local-qwen-fast");
    expect(setting).toBeTruthy();
    expect(resolveClaudeSdkBaseUrlForSetting({
      ...setting!,
      anthropic_base_url: undefined,
    })).toBe("http://127.0.0.1:5000/anthropic");
  });

  it("normalizes Claude SDK base URLs so OpenAI-compatible /v1 endpoints do not double-prefix messages", () => {
    const setting = {
      id: "local-qwen-setting",
      provider_id: "local-harness",
      model_name: "qwen3.6",
      models: ["qwen3.6"],
      api_key: "local-vllm",
      display_name: "Local Qwen",
      plan_type: "custom",
      protocol: "anthropic_compatible",
      auth_type: "bearer",
      base_url: "http://127.0.0.1:5000/v1/",
      anthropic_base_url: "http://127.0.0.1:5000/v1",
      supports_llm: true,
      supports_asr: false,
      supports_tts: false,
      supports_audio_input: false,
      supports_image_input: false,
      supports_video_input: false,
      is_active: true,
      is_default: false,
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
    } satisfies Parameters<typeof resolveClaudeSdkBaseUrlForSetting>[0];

    expect(resolveClaudeSdkBaseUrlForSetting(setting)).toBe("http://127.0.0.1:5000");
    expect(resolveClaudeSdkBaseUrlForSetting({
      ...setting,
      anthropic_base_url: undefined,
    })).toBe("http://127.0.0.1:5000");
    expect(resolveClaudeSdkBaseUrlForSetting({
      ...setting,
      anthropic_base_url: "http://127.0.0.1:5000/anthropic",
    })).toBe("http://127.0.0.1:5000/anthropic");
  });

  it("keeps custom setting Anthropic URLs ahead of provider defaults when settings are updated", async () => {
    const port = await listen(server);

    const providerResponse = await fetch(`http://127.0.0.1:${port}/api/llm/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "local-qwen-sdk",
        name: "Local Qwen SDK",
        default_model: "qwen3.6",
        base_url: "http://127.0.0.1:5000/v1",
        anthropic_base_url: "http://127.0.0.1:5000/v1",
      }),
    });
    expect(providerResponse.status).toBe(201);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "local-qwen-sdk",
        endpoint_id: "local-qwen-sdk_custom",
        model_name: "qwen3.6",
        api_key: "local-vllm",
        protocol: "anthropic_compatible",
        base_url: "http://127.0.0.1:5000",
        anthropic_base_url: "http://127.0.0.1:5000",
        is_active: true,
        is_default: false,
      }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json() as { data: { id: string; anthropic_base_url?: string } };
    expect(createBody.data.anthropic_base_url).toBe("http://127.0.0.1:5000");

    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/llm/settings/${createBody.data.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropic_base_url: "http://127.0.0.1:5000/anthropic",
      }),
    });
    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json() as { data: { anthropic_base_url?: string } };
    expect(updateBody.data.anthropic_base_url).toBe("http://127.0.0.1:5000/anthropic");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb } from "../src/persistence/db.js";
import {
  _clearAllSettings as clearLlmSettings,
  createSetting,
  upsertProvider,
} from "../src/persistence/llm-settings.js";
import { resolveAgentRuntimeConfig } from "../src/runtime/agent-runtime-resolver.js";

describe("agent runtime resolver", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldManagerRuntime: string | undefined;
  let oldManagerRuntimePlacement: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldManagerRuntime = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    oldManagerRuntimePlacement = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-agent-runtime-resolver-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "container";
    delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT;
    closeDb();
    clearLlmSettings();
  });

  afterEach(() => {
    clearLlmSettings();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldManagerRuntime === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    else process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = oldManagerRuntime;
    if (oldManagerRuntimePlacement === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT;
    else process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT = oldManagerRuntimePlacement;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("keeps Codex as the host runtime without HomeRail LLM credentials", () => {
    const resolved = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      providerName: "qwen36",
      modelName: "qwen3.6",
      settingId: "ignored-setting",
      harness: "codex_appserver",
    });

    expect(resolved).toMatchObject({
      provider_name: "",
      model: "gpt-5.5",
      api_key: "",
      base_url: "",
      protocol: "codex_appserver",
      agent_type: "codex_appserver",
      runtime_placement: "host",
    });
  });

  it("resolves Kimi settings to the container Kimi Code harness for both surfaces", () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-kimi",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    const manager = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      providerName: "kimi",
      modelName: "kimi-k2.7-code",
    });
    const dag = resolveAgentRuntimeConfig({
      surface: "dag",
      providerName: "kimi",
      modelName: "kimi-k2.7-code",
    });

    for (const resolved of [manager, dag]) {
      expect(resolved).toMatchObject({
        provider_name: "kimi_cn",
        model: "kimi-for-coding",
        api_key: "pk-test-kimi",
        base_url: "https://api.kimi.com/coding/v1",
        protocol: "openai_compatible",
        agent_type: "kimi_code",
        runtime_placement: "container",
        llm_setting_id: setting.id,
      });
    }
  });

  it("uses the active default DB setting for DAG runtime when YAML does not name a provider", () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-kimi",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    const resolved = resolveAgentRuntimeConfig({ surface: "dag" });

    expect(resolved).toMatchObject({
      provider_name: "kimi_cn",
      model: "kimi-for-coding",
      api_key: "pk-test-kimi",
      base_url: "https://api.kimi.com/coding/v1",
      protocol: "openai_compatible",
      agent_type: "kimi_code",
      runtime_placement: "container",
      llm_setting_id: setting.id,
    });
  });

  it("allows explicit Claude SDK harness with Kimi Anthropic-compatible endpoints", () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-kimi",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    const resolved = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "claude_agent_sdk",
    });

    expect(resolved).toMatchObject({
      provider_name: "kimi_cn",
      model: "kimi-for-coding",
      api_key: "pk-test-kimi",
      base_url: "https://api.kimi.com/coding",
      protocol: "anthropic_compatible",
      agent_type: "claude-sdk",
      runtime_placement: "container",
      llm_setting_id: setting.id,
    });
  });

  it("allows explicit Kimi Code harness with custom settings", () => {
    upsertProvider({
      id: "local-qwen",
      name: "Local Qwen",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000/v1",
      chat_completions_base_url: "http://127.0.0.1:5000/v1",
    });
    const setting = createSetting({
      provider_id: "local-qwen",
      endpoint_id: "local-qwen_custom",
      endpoint_name: "custom",
      model_name: "qwen3.6",
      api_key: "local-no-key",
      protocol: "openai_compatible",
      plan_type: "custom",
      base_url: "http://127.0.0.1:5000/v1",
      chat_completions_base_url: "http://127.0.0.1:5000/v1",
      is_active: true,
      is_default: true,
    });

    const resolved = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "kimi_code",
    });

    expect(resolved).toMatchObject({
      provider_name: "local-qwen",
      model: "qwen3.6",
      api_key: "local-no-key",
      base_url: "http://127.0.0.1:5000/v1",
      protocol: "openai_compatible",
      agent_type: "kimi_code",
      runtime_placement: "container",
      llm_setting_id: setting.id,
    });
  });

  it("rejects explicit Kimi Code harness with built-in non-Kimi providers", () => {
    const setting = createSetting({
      provider_id: "glm",
      endpoint_id: "glm_coding_plan",
      model_name: "glm-5.2",
      api_key: "pk-test-glm",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
      is_default: true,
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "kimi_code",
    })).toThrow(/Kimi Code Manager Agent requires a Kimi or custom setting/);
  });

  it("rejects explicit Kimi Code harness with built-in non-Kimi custom settings", () => {
    const setting = createSetting({
      provider_id: "glm",
      endpoint_id: "glm_custom",
      endpoint_name: "custom",
      model_name: "glm-5.2",
      api_key: "pk-test-glm",
      protocol: "custom",
      plan_type: "custom",
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      chat_completions_base_url: "https://open.bigmodel.cn/api/paas/v4",
      is_active: true,
      is_default: true,
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "kimi_code",
    })).toThrow(/Kimi Code Manager Agent requires a Kimi or custom setting/);
  });

  it("uses the Anthropic-compatible endpoint for Claude SDK on both surfaces", () => {
    upsertProvider({
      id: "dual-url-provider",
      name: "Dual URL Provider",
      default_model: "dual-model",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
    });
    createSetting({
      provider_id: "dual-url-provider",
      model_name: "dual-model",
      api_key: "pk-test-dual",
      protocol: "openai_compatible",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
      is_active: true,
      is_default: true,
    });

    const manager = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      providerName: "dual-url-provider",
      modelName: "dual-model",
    });
    const dag = resolveAgentRuntimeConfig({
      surface: "dag",
      providerName: "dual-url-provider",
      modelName: "dual-model",
      agentType: "claude_agent_sdk",
    });

    for (const resolved of [manager, dag]) {
      expect(resolved).toMatchObject({
        provider_name: "dual-url-provider",
        model: "dual-model",
        base_url: "https://dual.example/anthropic",
        protocol: "anthropic_compatible",
        agent_type: "claude-sdk",
        runtime_placement: "container",
      });
    }
  });

  it("can route Manager Agent Kimi and Claude harnesses through host-shell without changing DAG placement", () => {
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "host-shell";
    upsertProvider({
      id: "dual-url-provider",
      name: "Dual URL Provider",
      default_model: "dual-model",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
    });
    const claudeSetting = createSetting({
      provider_id: "dual-url-provider",
      model_name: "dual-model",
      api_key: "pk-test-dual",
      protocol: "openai_compatible",
      base_url: "https://dual.example/v1",
      chat_completions_base_url: "https://dual.example/v1",
      anthropic_base_url: "https://dual.example/anthropic",
      is_active: true,
      is_default: true,
    });
    const kimiSetting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-kimi",
      protocol: "openai_compatible",
      plan_type: "coding_plan",
      is_active: true,
    });

    expect(resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: claudeSetting.id,
      harness: "claude_agent_sdk",
    }).runtime_placement).toBe("host_shell");
    expect(resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: kimiSetting.id,
      harness: "kimi_code",
    }).runtime_placement).toBe("host_shell");
    expect(resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: claudeSetting.id,
      agentType: "claude_agent_sdk",
    }).runtime_placement).toBe("container");
  });

  it("rejects Claude SDK when only a Chat Completions endpoint is configured", () => {
    upsertProvider({
      id: "chat-only-provider",
      name: "Chat Only Provider",
      default_model: "chat-model",
      base_url: "https://chat-only.example/v1",
      chat_completions_base_url: "https://chat-only.example/v1",
    });
    createSetting({
      provider_id: "chat-only-provider",
      model_name: "chat-model",
      api_key: "pk-test-chat",
      protocol: "openai_compatible",
      base_url: "https://chat-only.example/v1",
      chat_completions_base_url: "https://chat-only.example/v1",
      is_active: true,
      is_default: true,
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      providerName: "chat-only-provider",
      modelName: "chat-model",
      agentType: "claude-sdk",
    })).toThrow(/Claude SDK requires an Anthropic-compatible endpoint/);
  });

  it("rejects direct-llm and non-LLM or disabled settings before runtime dispatch", () => {
    upsertProvider({
      id: "voice-only-provider",
      name: "Voice Only Provider",
      default_model: "voice-model",
      base_url: "https://voice.example/v1",
      anthropic_base_url: "https://voice.example/anthropic",
    });
    const voiceOnly = createSetting({
      provider_id: "voice-only-provider",
      model_name: "voice-model",
      api_key: "pk-test-voice",
      protocol: "anthropic_compatible",
      base_url: "https://voice.example/anthropic",
      supports_llm: false,
      supports_tts: true,
      is_active: true,
      is_default: true,
    });
    const dirtyVoiceService = createSetting({
      provider_id: "voice-only-provider",
      model_name: "dirty-tts-model",
      api_key: "pk-test-dirty-voice",
      protocol: "anthropic_compatible",
      base_url: "https://voice.example/anthropic",
      anthropic_base_url: "https://voice.example/anthropic",
      supports_llm: true,
      supports_tts: true,
      is_active: true,
    });
    const disabled = createSetting({
      provider_id: "voice-only-provider",
      model_name: "disabled-model",
      api_key: "pk-test-disabled",
      protocol: "anthropic_compatible",
      base_url: "https://voice.example/anthropic",
      is_active: false,
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      harness: "direct-llm",
    })).toThrow(/direct-llm is disabled/);
    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: voiceOnly.id,
    })).toThrow(/Manager Agent setting must support LLM runtime/);
    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: dirtyVoiceService.id,
    })).toThrow(/Manager Agent setting must be a dedicated LLM runtime/);
    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
    })).toThrow(/No active Manager LLM setting found/);
    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: disabled.id,
    })).toThrow(/DAG LLM setting is disabled/);
  });
});

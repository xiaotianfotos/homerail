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

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-agent-runtime-resolver-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    clearLlmSettings();
  });

  afterEach(() => {
    clearLlmSettings();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("keeps Codex as the host runtime and uses the explicitly catalog-selected model", () => {
    const resolved = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      modelName: "codex-account-model",
      harness: "codex_appserver",
    });

    expect(resolved).toMatchObject({
      provider_name: "",
      provider_display_name: "OpenAI",
      model: "codex-account-model",
      model_display_name: "codex-account-model",
      api_key: "",
      base_url: "",
      protocol: "codex_appserver",
      agent_type: "codex_appserver",
      runtime_placement: "host",
    });
  });

  it("runs a HomeRail Responses setting through Codex without treating it as an account model", () => {
    upsertProvider({
      id: "local-responses",
      name: "Local Responses",
      default_model: "local-coder",
      responses_base_url: "http://127.0.0.1:8000/v1",
    });
    const setting = createSetting({
      provider_id: "local-responses",
      endpoint_id: "local-responses_custom",
      model_name: "local-coder",
      api_key: "local-no-key",
      protocol: "custom",
      responses_base_url: "http://127.0.0.1:8000/v1",
      is_active: true,
      is_default: true,
    });

    const resolved = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      providerName: "local-responses",
      modelName: "local-coder",
      settingId: setting.id,
      harness: "codex_appserver",
    });

    expect(resolved).toMatchObject({
      provider_name: "local-responses",
      model: "local-coder",
      api_key: "local-no-key",
      base_url: "http://127.0.0.1:8000/v1",
      protocol: "responses_compatible",
      agent_type: "codex_appserver",
      runtime_placement: "host",
      llm_setting_id: setting.id,
    });
  });

  it("keeps provider-backed DAG Codex execution containerized", () => {
    upsertProvider({
      id: "local-responses",
      default_model: "local-coder",
      responses_base_url: "http://127.0.0.1:8000/v1",
    });
    const setting = createSetting({
      provider_id: "local-responses",
      endpoint_id: "local-responses_custom",
      model_name: "local-coder",
      api_key: "local-no-key",
      protocol: "custom",
      responses_base_url: "http://127.0.0.1:8000/v1",
      is_active: true,
      is_default: true,
    });
    expect(resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "codex_appserver",
    })).toMatchObject({
      protocol: "responses_compatible",
      runtime_placement: "container",
    });
  });

  it("applies DeepSeek Codex capabilities to both Manager and DAG resolution", () => {
    const setting = createSetting({
      provider_id: "deepseek",
      endpoint_id: "deepseek_api",
      model_name: "deepseek-v4-flash",
      api_key: "sk-test-deepseek",
      is_active: true,
      is_default: true,
    });

    const defaults = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "codex_appserver",
    });
    expect(defaults).toMatchObject({
      protocol: "responses_compatible",
      base_url: "https://api.deepseek.com",
      reasoning_effort: "high",
      service_tier: null,
    });

    expect(resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "codex_appserver",
      reasoningEffort: "none",
    })).toMatchObject({
      reasoning_effort: "none",
      runtime_placement: "container",
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "codex_appserver",
      reasoningEffort: "medium",
    })).toThrow("Supported values: none, low, high, max");

    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "codex_appserver",
      serviceTier: "priority",
    })).toThrow("does not support service tier 'priority'");
  });

  it("fails closed for DeepSeek models without Responses support", () => {
    const setting = createSetting({
      provider_id: "deepseek",
      endpoint_id: "deepseek_api",
      model_name: "deepseek-v4-pro",
      api_key: "sk-test-deepseek",
      is_active: true,
      is_default: true,
    });
    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "codex_appserver",
    })).toThrow("Responses is not supported for deepseek/deepseek-v4-pro");
  });

  it("does not invent a Codex model when the catalog selection is missing", () => {
    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      harness: "codex_appserver",
    })).toThrow("Codex app-server model is not configured");
  });

  it("runs Kimi Manager on the host while keeping DAG execution containerized", () => {
    const setting = createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      display_name: "Kimi Coding",
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
        provider_display_name: expect.any(String),
        model: "kimi-for-coding",
        model_display_name: "Kimi Coding",
        api_key: "pk-test-kimi",
        base_url: "https://api.kimi.com/coding/v1",
        protocol: "openai_compatible",
        agent_type: "kimi_code",
        llm_setting_id: setting.id,
      });
    }
    expect(manager.runtime_placement).toBe("host_shell");
    expect(dag.runtime_placement).toBe("container");
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
      anthropic_auth_mode: "api_key",
      agent_type: "claude-sdk",
      runtime_placement: "host_shell",
      llm_setting_id: setting.id,
    });
  });

  it("does not silently replace an explicit Codex harness with Kimi Code", () => {
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

    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "codex_appserver",
    })).toThrow("Codex app-server requires a Responses endpoint");
  });

  it("uses Bearer auth for the Aliyun Token Plan Anthropic gateway", () => {
    const setting = createSetting({
      provider_id: "aliyun",
      endpoint_id: "aliyun_dashscope_cn_token_plan",
      model_name: "qwen3.8-max",
      api_key: "sk-sp-test-qwen",
      is_active: true,
      is_default: true,
    });

    const resolved = resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "claude-sdk",
    });

    expect(resolved).toMatchObject({
      provider_name: "aliyun",
      model: "qwen3.8-max",
      base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
      protocol: "anthropic_compatible",
      anthropic_auth_mode: "auth_token",
      agent_type: "claude-sdk",
      runtime_placement: "container",
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
      runtime_placement: "host_shell",
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
      });
    }
    expect(manager.runtime_placement).toBe("host_shell");
    expect(dag.runtime_placement).toBe("container");
  });

  it("keeps Manager execution on the host without changing DAG placement", () => {
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

  it("resolves DeepSeek Harness against OpenAI-compatible settings on both surfaces", () => {
    upsertProvider({
      id: "dsh-provider",
      name: "DSH Provider",
      default_model: "dsh-model",
      base_url: "https://dsh.example/v1",
      chat_completions_base_url: "https://dsh.example/v1",
    });
    const setting = createSetting({
      provider_id: "dsh-provider",
      model_name: "dsh-model",
      api_key: "dsh-secret",
      protocol: "openai_compatible",
      base_url: "https://dsh.example/v1",
      chat_completions_base_url: "https://dsh.example/v1",
      reasoning_effort_map: { off: null, medium: "balanced", high: "deep" },
      default_reasoning_effort: "medium",
      is_active: true,
      is_default: true,
    });

    const manager = resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "dsh",
    });
    const dag = resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "deepseek-harness",
      reasoningEffort: "high",
    });

    expect(manager).toMatchObject({
      agent_type: "deepseek_harness",
      protocol: "openai_compatible",
      base_url: "https://dsh.example/v1",
      reasoning_effort: "medium",
      reasoning_effort_map: { off: null, medium: "balanced", high: "deep" },
      runtime_placement: "host_shell",
    });
    expect(dag).toMatchObject({
      agent_type: "deepseek_harness",
      protocol: "openai_compatible",
      base_url: "https://dsh.example/v1",
      reasoning_effort: "high",
      reasoning_effort_map: { off: null, medium: "balanced", high: "deep" },
      runtime_placement: "container",
    });
    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "deepseek-harness",
      reasoningEffort: "ultra",
    })).toThrow(/does not support reasoning effort 'ultra'/);
  });

  it("preserves provider defaults when a DSH model declares no selectable reasoning", () => {
    upsertProvider({
      id: "dsh-provider-default",
      default_model: "provider-default-model",
      base_url: "https://dsh-default.example/v1",
      chat_completions_base_url: "https://dsh-default.example/v1",
    });
    const setting = createSetting({
      provider_id: "dsh-provider-default",
      model_name: "provider-default-model",
      api_key: "dsh-secret",
      protocol: "openai_compatible",
      base_url: "https://dsh-default.example/v1",
      chat_completions_base_url: "https://dsh-default.example/v1",
      is_active: true,
      is_default: true,
    });

    expect(resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "deepseek_harness",
    })).not.toHaveProperty("reasoning_effort");
    expect(() => resolveAgentRuntimeConfig({
      surface: "dag",
      settingId: setting.id,
      agentType: "deepseek_harness",
      reasoningEffort: "medium",
    })).toThrow(/does not declare selectable reasoning efforts/);
  });

  it("rejects DeepSeek Harness for non-Chat-Completions settings", () => {
    upsertProvider({
      id: "dsh-anthropic-only",
      default_model: "anthropic-model",
      anthropic_base_url: "https://dsh.example/anthropic",
    });
    const setting = createSetting({
      provider_id: "dsh-anthropic-only",
      model_name: "anthropic-model",
      api_key: "dsh-secret",
      protocol: "anthropic_compatible",
      anthropic_base_url: "https://dsh.example/anthropic",
      is_active: true,
      is_default: true,
    });

    expect(() => resolveAgentRuntimeConfig({
      surface: "manager_agent",
      settingId: setting.id,
      harness: "deepseek_harness",
    })).toThrow(/requires an OpenAI-compatible setting/);
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

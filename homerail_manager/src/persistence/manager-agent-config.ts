import { encodeJson, getDb, parseJsonRow } from "./db.js";
import { getSetting } from "./llm-settings.js";
import { nowIso } from "./time.js";
import {
  normalizeManagerAgentHarness,
  type ManagerAgentHarness,
  type ManagerAgentReasoningEffort,
  type ManagerAgentServiceTier,
} from "homerail-protocol";
import {
  DEFAULT_GENERATIVE_UI_MODE,
  parseGenerativeUiMode,
  type GenerativeUiMode,
} from "../generative-ui/mode.js";
import {
  DEFAULT_CODEX_LIVE_VOICE_V3_VOICE,
  parseCodexLiveVoiceV3Voice,
  type CodexLiveVoiceV3Voice,
} from "../domain/codex-live-voice.js";

export interface ManagerAgentConfig {
  agent_type: "manager_agent";
  harness: ManagerAgentHarness;
  live_voice_enabled: boolean;
  live_voice_voice: CodexLiveVoiceV3Voice;
  llm_setting_id: string | null;
  provider_name: string | null;
  model_name: string | null;
  reasoning_effort: ManagerAgentReasoningEffort;
  service_tier: ManagerAgentServiceTier;
  generative_ui_mode: GenerativeUiMode;
  system_prompt: string;
  session_policy: Record<string, unknown>;
}

export const DEFAULT_MANAGER_AGENT_CONFIG: ManagerAgentConfig = {
  agent_type: "manager_agent",
  harness: "claude_agent_sdk",
  live_voice_enabled: false,
  live_voice_voice: DEFAULT_CODEX_LIVE_VOICE_V3_VOICE,
  llm_setting_id: null,
  provider_name: null,
  model_name: null,
  reasoning_effort: "low",
  service_tier: null,
  generative_ui_mode: DEFAULT_GENERATIVE_UI_MODE,
  system_prompt: "",
  session_policy: {
    persist_conversation: true,
    max_conversation_messages: 40,
    persist_sdk_client: false,
    repair_attempts: 0,
    codex_loop_mode: "structured",
  },
};

function _string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function _reasoningEffort(value: unknown): ManagerAgentConfig["reasoning_effort"] {
  return _string(value) ?? DEFAULT_MANAGER_AGENT_CONFIG.reasoning_effort;
}

function _serviceTier(value: unknown): ManagerAgentConfig["service_tier"] {
  const tier = _string(value);
  return tier === "fast" ? "priority" : tier;
}

function _harness(value: unknown): ManagerAgentHarness {
  return normalizeManagerAgentHarness(value) ?? DEFAULT_MANAGER_AGENT_CONFIG.harness;
}

function _normalize(raw?: Record<string, unknown> | null): ManagerAgentConfig {
  const base = { ...DEFAULT_MANAGER_AGENT_CONFIG, ...(raw ?? {}) };
  const sessionPolicy = typeof raw?.session_policy === "object" && raw.session_policy && !Array.isArray(raw.session_policy)
    ? raw.session_policy as Record<string, unknown>
    : {};
  const harness = _harness(base.harness);
  if (harness === "codex_appserver") {
    const rawModel = _string(base.model_name);
    // Legacy provider references belong to HomeRail-managed runtimes and must
    // not be converted into a guessed Codex model. A null model lets the
    // app-server catalog select the account's real default during bootstrap.
    const modelName = raw?.llm_setting_id || raw?.provider_name ? null : rawModel;
    return {
      agent_type: "manager_agent",
      harness,
      live_voice_enabled: base.live_voice_enabled === true,
      live_voice_voice: parseCodexLiveVoiceV3Voice(base.live_voice_voice),
      llm_setting_id: null,
      provider_name: null,
      model_name: modelName,
      reasoning_effort: _reasoningEffort(base.reasoning_effort),
      service_tier: _serviceTier(base.service_tier),
      generative_ui_mode: parseGenerativeUiMode(base.generative_ui_mode),
      system_prompt: typeof base.system_prompt === "string" ? base.system_prompt : "",
      session_policy: {
        ...DEFAULT_MANAGER_AGENT_CONFIG.session_policy,
        ...sessionPolicy,
      },
    };
  }
  return {
    agent_type: "manager_agent",
    harness,
    live_voice_enabled: base.live_voice_enabled === true,
    live_voice_voice: parseCodexLiveVoiceV3Voice(base.live_voice_voice),
    llm_setting_id: _string(base.llm_setting_id),
    provider_name: _string(base.provider_name),
    model_name: _string(base.model_name),
    reasoning_effort: _reasoningEffort(base.reasoning_effort),
    service_tier: _serviceTier(base.service_tier),
    generative_ui_mode: parseGenerativeUiMode(base.generative_ui_mode),
    system_prompt: typeof base.system_prompt === "string" ? base.system_prompt : "",
    session_policy: {
      ...DEFAULT_MANAGER_AGENT_CONFIG.session_policy,
      ...sessionPolicy,
    },
  };
}

function _withSettingMetadata(config: ManagerAgentConfig): ManagerAgentConfig {
  if (!config.llm_setting_id) return config;
  const setting = getSetting(config.llm_setting_id);
  if (!setting) return config;
  return {
    ...config,
    provider_name: setting.provider_id,
    model_name: setting.model_name,
  };
}

export function readManagerAgentConfig(): ManagerAgentConfig {
  const row = getDb()
    .prepare("SELECT data FROM manager_agent_config WHERE id = ?")
    .get("default") as { data: string } | undefined;
  if (row) return _withSettingMetadata(_normalize(parseJsonRow<Record<string, unknown>>(row.data)));
  return DEFAULT_MANAGER_AGENT_CONFIG;
}

export function hasManagerAgentConfig(): boolean {
  return Boolean(getDb()
    .prepare("SELECT 1 FROM manager_agent_config WHERE id = ?")
    .get("default"));
}

export function saveManagerAgentConfig(patch: Record<string, unknown>): ManagerAgentConfig {
  const current = readManagerAgentConfig();
  const next = _normalize({
    ...current,
    ...patch,
    session_policy: {
      ...current.session_policy,
      ...(typeof patch.session_policy === "object" && patch.session_policy && !Array.isArray(patch.session_policy)
        ? patch.session_policy as Record<string, unknown>
        : {}),
    },
  });
  const saved = _withSettingMetadata(next);
  getDb()
    .prepare(`
      INSERT INTO manager_agent_config(id, updated_at, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
    `)
    .run("default", nowIso(), encodeJson(saved));
  return saved;
}

export function clearManagerAgentConfig(): void {
  getDb().prepare("DELETE FROM manager_agent_config WHERE id = ?").run("default");
}

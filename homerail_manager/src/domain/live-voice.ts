import type { ManagerAgentHarness } from "homerail-protocol";

export type LiveVoiceBackend = "codex" | "gemini";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_GEMINI_LIVE_VOICE = "Aoede";
export const GEMINI_LIVE_INPUT_SAMPLE_RATE = 16_000;
export const GEMINI_LIVE_OUTPUT_SAMPLE_RATE = 24_000;

export interface LiveVoiceManagerSelection {
  harness: ManagerAgentHarness;
  provider_name?: string | null;
  llm_setting_id?: string | null;
}

/** Resolve the Live implementation from the authoritative Manager selection. */
export function resolveLiveVoiceBackend(
  config: LiveVoiceManagerSelection,
): LiveVoiceBackend | null {
  if (
    config.harness === "codex_appserver"
    && !config.provider_name
    && !config.llm_setting_id
  ) return "codex";
  if (config.harness === "kimi_code" && config.provider_name === "gemini") {
    return "gemini";
  }
  return null;
}

export function configuredGeminiLiveModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOMERAIL_GEMINI_LIVE_MODEL?.trim() || DEFAULT_GEMINI_LIVE_MODEL;
}

export function configuredGeminiLiveVoice(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOMERAIL_GEMINI_LIVE_VOICE?.trim() || DEFAULT_GEMINI_LIVE_VOICE;
}

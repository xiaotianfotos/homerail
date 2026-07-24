export const CODEX_LIVE_VOICE_V3_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;

export type CodexLiveVoiceV3Voice = typeof CODEX_LIVE_VOICE_V3_VOICES[number];

export const DEFAULT_CODEX_LIVE_VOICE_V3_VOICE: CodexLiveVoiceV3Voice = "cove";

export function parseCodexLiveVoiceV3Voice(value: unknown): CodexLiveVoiceV3Voice {
  if (
    typeof value === "string"
    && CODEX_LIVE_VOICE_V3_VOICES.includes(
      value.trim().toLowerCase() as CodexLiveVoiceV3Voice,
    )
  ) {
    return value.trim().toLowerCase() as CodexLiveVoiceV3Voice;
  }
  return DEFAULT_CODEX_LIVE_VOICE_V3_VOICE;
}

export function isCodexLiveVoiceV3Voice(value: unknown): value is CodexLiveVoiceV3Voice {
  return (
    typeof value === "string"
    && CODEX_LIVE_VOICE_V3_VOICES.includes(
      value.trim().toLowerCase() as CodexLiveVoiceV3Voice,
    )
  );
}

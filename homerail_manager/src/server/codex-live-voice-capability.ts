import * as fs from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import {
  resolveCodexBinary,
  runCodexCommandSync,
  type CodexBinaryResolution,
} from "./codex-binary.js";
import {
  CODEX_LIVE_VOICE_V3_VOICES,
  DEFAULT_CODEX_LIVE_VOICE_V3_VOICE,
  type CodexLiveVoiceV3Voice,
} from "../domain/codex-live-voice.js";

export const CODEX_LIVE_VOICE_MINIMUM_VERSION = "0.145.0";
export const CODEX_LIVE_VOICE_FEATURE = "realtime_conversation";

export type CodexLiveVoiceUnsupportedReason =
  | "missing"
  | "unparseable"
  | "too_old"
  | "feature_missing";

export interface CodexLiveVoiceCapability {
  supported: boolean;
  minimum_version: typeof CODEX_LIVE_VOICE_MINIMUM_VERSION;
  protocol: "v3";
  transport: "webrtc";
  feature: typeof CODEX_LIVE_VOICE_FEATURE;
  voices?: CodexLiveVoiceV3Voice[];
  default_voice?: CodexLiveVoiceV3Voice;
  stage?: string;
  reason?: CodexLiveVoiceUnsupportedReason;
}

export interface CodexInstallationStatus {
  available: boolean;
  version?: string;
  semantic_version?: string;
  binary: string;
  live_voice: CodexLiveVoiceCapability;
}

export interface InspectCodexInstallationOptions {
  requested?: string;
  resolveBinary?: (requested?: string) => CodexBinaryResolution | null;
  runCommand?: (
    command: string,
    args: string[],
  ) => SpawnSyncReturns<string>;
  statMtimeMs?: (filePath: string) => number | undefined;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  raw: string;
}

interface CachedFeatureProbe {
  stage?: string;
  present: boolean;
}

const featureCache = new Map<string, CachedFeatureProbe>();

function emptyCapability(reason: CodexLiveVoiceUnsupportedReason): CodexLiveVoiceCapability {
  return {
    supported: false,
    minimum_version: CODEX_LIVE_VOICE_MINIMUM_VERSION,
    protocol: "v3",
    transport: "webrtc",
    feature: CODEX_LIVE_VOICE_FEATURE,
    voices: [...CODEX_LIVE_VOICE_V3_VOICES],
    default_voice: DEFAULT_CODEX_LIVE_VOICE_V3_VOICE,
    reason,
  };
}

function parseCodexVersion(raw: string): SemanticVersion | undefined {
  const match = raw.match(/\bcodex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\b/i);
  if (!match) return undefined;
  const prerelease = match[4] || undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: `${match[1]}.${match[2]}.${match[3]}${prerelease ? `-${prerelease}` : ""}`,
  };
}

function versionAtLeast(
  actual: SemanticVersion,
  minimum: SemanticVersion,
): boolean {
  if (actual.major !== minimum.major) return actual.major > minimum.major;
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
  if (actual.patch !== minimum.patch) return actual.patch > minimum.patch;
  return !actual.prerelease || Boolean(minimum.prerelease);
}

function parseFeatureProbe(stdout: string): CachedFeatureProbe {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/).filter(Boolean);
    if (parts[0] !== CODEX_LIVE_VOICE_FEATURE || parts.length < 2) continue;
    const maybeEnabled = parts.at(-1);
    const stageParts = maybeEnabled === "true" || maybeEnabled === "false"
      ? parts.slice(1, -1)
      : parts.slice(1);
    const stage = stageParts.join(" ").trim() || undefined;
    return {
      present: stage?.toLowerCase() !== "removed",
      stage,
    };
  }
  return { present: false };
}

function defaultStatMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

export function inspectCodexInstallation(
  options: InspectCodexInstallationOptions = {},
): CodexInstallationStatus {
  const requested = options.requested
    ?? process.env.HOMERAIL_CODEX_BIN
    ?? process.env.CODEX_BIN_PATH
    ?? "codex";
  const resolveBinary = options.resolveBinary ?? ((value?: string) => resolveCodexBinary(value));
  const runCommand = options.runCommand ?? ((command, args) => runCodexCommandSync(command, args));
  const resolved = resolveBinary(requested);
  if (!resolved) {
    return {
      available: false,
      binary: requested,
      live_voice: emptyCapability("missing"),
    };
  }

  const versionResult = runCommand(resolved.command, ["--version"]);
  const version = (versionResult.stdout || "").trim().split(/\r?\n/)[0] || undefined;
  if (versionResult.status !== 0) {
    return {
      available: false,
      version,
      binary: resolved.command,
      live_voice: emptyCapability("missing"),
    };
  }

  const semantic = parseCodexVersion(version ?? "");
  if (!semantic) {
    return {
      available: true,
      version,
      binary: resolved.command,
      live_voice: emptyCapability("unparseable"),
    };
  }

  const minimum = parseCodexVersion(`codex-cli ${CODEX_LIVE_VOICE_MINIMUM_VERSION}`)!;
  if (!versionAtLeast(semantic, minimum)) {
    return {
      available: true,
      version,
      semantic_version: semantic.raw,
      binary: resolved.command,
      live_voice: emptyCapability("too_old"),
    };
  }

  const mtime = (options.statMtimeMs ?? defaultStatMtimeMs)(resolved.command);
  const cacheKey = `${resolved.command}\u0000${mtime ?? "unknown"}\u0000${semantic.raw}`;
  let feature = featureCache.get(cacheKey);
  if (!feature) {
    const result = runCommand(resolved.command, ["features", "list"]);
    feature = result.status === 0 ? parseFeatureProbe(result.stdout || "") : { present: false };
    featureCache.set(cacheKey, feature);
    if (featureCache.size > 16) {
      const oldest = featureCache.keys().next().value;
      if (oldest) featureCache.delete(oldest);
    }
  }
  if (!feature.present) {
    return {
      available: true,
      version,
      semantic_version: semantic.raw,
      binary: resolved.command,
      live_voice: {
        ...emptyCapability("feature_missing"),
        ...(feature.stage ? { stage: feature.stage } : {}),
      },
    };
  }

  return {
    available: true,
    version,
    semantic_version: semantic.raw,
    binary: resolved.command,
    live_voice: {
      supported: true,
      minimum_version: CODEX_LIVE_VOICE_MINIMUM_VERSION,
      protocol: "v3",
      transport: "webrtc",
      feature: CODEX_LIVE_VOICE_FEATURE,
      voices: [...CODEX_LIVE_VOICE_V3_VOICES],
      default_voice: DEFAULT_CODEX_LIVE_VOICE_V3_VOICE,
      ...(feature.stage ? { stage: feature.stage } : {}),
    },
  };
}

export function _clearCodexLiveVoiceCapabilityCacheForTest(): void {
  featureCache.clear();
}

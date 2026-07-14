import * as fs from "node:fs";
import * as path from "node:path";

import { getDataRoot } from "../config/env.js";

export interface WorkspaceRetentionSettings {
  enabled: boolean;
  success_days: number;
  failure_days: number;
}

export const DEFAULT_WORKSPACE_RETENTION_SETTINGS: WorkspaceRetentionSettings = {
  enabled: true,
  success_days: 7,
  failure_days: 7,
};

const SETTINGS_FILE = "workspace-retention.json";
const MAX_RETENTION_DAYS = 3_650;

function settingsPath(): string {
  return path.join(getDataRoot(), SETTINGS_FILE);
}

function normalizeDays(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_RETENTION_DAYS) {
    throw new Error(`${field} must be an integer between 0 and ${MAX_RETENTION_DAYS}`);
  }
  return value;
}

export function normalizeWorkspaceRetentionSettings(
  input: Record<string, unknown>,
): WorkspaceRetentionSettings {
  if (typeof input.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  return {
    enabled: input.enabled,
    success_days: normalizeDays(input.success_days, "success_days"),
    failure_days: normalizeDays(input.failure_days, "failure_days"),
  };
}

function legacyEnvironmentDefaults(env: NodeJS.ProcessEnv): WorkspaceRetentionSettings {
  const days = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_RETENTION_DAYS
      ? parsed
      : fallback;
  };
  return {
    enabled: env.HOMERAIL_WORKSPACE_CLEANUP_ENABLED !== "0",
    success_days: days(
      env.HOMERAIL_WORKSPACE_RETENTION_SUCCESS_DAYS,
      DEFAULT_WORKSPACE_RETENTION_SETTINGS.success_days,
    ),
    failure_days: days(
      env.HOMERAIL_WORKSPACE_RETENTION_FAILURE_DAYS,
      DEFAULT_WORKSPACE_RETENTION_SETTINGS.failure_days,
    ),
  };
}

export function loadWorkspaceRetentionSettings(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRetentionSettings {
  const file = settingsPath();
  if (!fs.existsSync(file)) return legacyEnvironmentDefaults(env);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return normalizeWorkspaceRetentionSettings(raw);
  } catch (error) {
    console.warn(
      `[workspace-retention] Ignoring invalid settings file '${file}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return legacyEnvironmentDefaults(env);
  }
}

export function saveWorkspaceRetentionSettings(
  input: Record<string, unknown>,
): WorkspaceRetentionSettings {
  const settings = normalizeWorkspaceRetentionSettings(input);
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temp, file);
  return settings;
}

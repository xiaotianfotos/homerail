/**
 * Generative UI rollout modes that are safe to use before the new UI becomes
 * authoritative. `prefer` keeps the legacy workspace as a fallback while an
 * available canonical Document becomes authoritative. `strict` remains
 * reserved until the legacy production path can be retired explicitly.
 */
export const GENERATIVE_UI_MODES = ["off", "shadow", "prefer"] as const;

export type GenerativeUiMode = (typeof GENERATIVE_UI_MODES)[number];

export const DEFAULT_GENERATIVE_UI_MODE: GenerativeUiMode = "off";
export const GENERATIVE_UI_MODE_ENV = "HOMERAIL_GENERATIVE_UI_MODE";

export type GenerativeUiModeSource = "configured" | "environment";

export interface ResolvedGenerativeUiMode {
  configured_mode: GenerativeUiMode;
  effective_mode: GenerativeUiMode;
  source: GenerativeUiModeSource;
}

export class GenerativeUiModeValidationError extends Error {
  readonly value: unknown;
  readonly source: string;

  constructor(value: unknown, source: string) {
    const rendered = typeof value === "string" ? value.trim() : String(value);
    const detail = rendered === "strict"
      ? `Generative UI mode '${rendered}' is reserved and is not available in this release.`
      : `Generative UI mode must be one of: ${GENERATIVE_UI_MODES.join(", ")}. Received: '${rendered}'.`;
    super(`${source}: ${detail}`);
    this.name = "GenerativeUiModeValidationError";
    this.value = value;
    this.source = source;
  }
}

/** Parse one persisted, environment, or session-snapshot value. */
export function parseGenerativeUiMode(
  value: unknown,
  source = "generative_ui_mode",
): GenerativeUiMode {
  if (value === undefined || value === null) return DEFAULT_GENERATIVE_UI_MODE;
  if (typeof value !== "string") throw new GenerativeUiModeValidationError(value, source);
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_GENERATIVE_UI_MODE;
  if (normalized === "off" || normalized === "shadow" || normalized === "prefer") return normalized;
  throw new GenerativeUiModeValidationError(normalized, source);
}

/**
 * Resolve the global rollout selection. A non-empty environment value takes
 * precedence over persisted configuration, making `off` an operational kill
 * switch without rewriting the saved setting.
 */
export function resolveConfiguredGenerativeUiMode(
  configuredValue: unknown,
  environmentValue: unknown = process.env[GENERATIVE_UI_MODE_ENV],
): GenerativeUiMode {
  return resolveConfiguredGenerativeUiModeDetails(configuredValue, environmentValue).effective_mode;
}

/**
 * Resolve both the persisted selection and the operationally effective mode.
 * A non-empty environment value is the final operator override; API responses
 * expose this source so persisted `off` can never be mistaken for effective
 * `off` while an environment override is active.
 */
export function resolveConfiguredGenerativeUiModeDetails(
  configuredValue: unknown,
  environmentValue: unknown = process.env[GENERATIVE_UI_MODE_ENV],
): ResolvedGenerativeUiMode {
  const configuredMode = parseGenerativeUiMode(configuredValue, "generative_ui_mode");
  const hasEnvironmentOverride = typeof environmentValue === "string"
    ? environmentValue.trim().length > 0
    : environmentValue !== undefined && environmentValue !== null;
  return hasEnvironmentOverride
    ? {
        configured_mode: configuredMode,
        effective_mode: parseGenerativeUiMode(environmentValue, GENERATIVE_UI_MODE_ENV),
        source: "environment",
      }
    : {
        configured_mode: configuredMode,
        effective_mode: configuredMode,
        source: "configured",
      };
}

/**
 * Resolve an existing session without silently upgrading it. Sessions created
 * before the snapshot field existed remain off. A current global `off` always
 * wins so operators can disable projection work immediately.
 */
export function resolveSessionGenerativeUiMode(
  sessionSnapshotValue: unknown,
  globalModeValue: unknown,
): GenerativeUiMode {
  const globalMode = parseGenerativeUiMode(globalModeValue, "global generative_ui_mode");
  if (globalMode === "off") return "off";
  return parseGenerativeUiMode(sessionSnapshotValue, "session generative_ui_mode");
}

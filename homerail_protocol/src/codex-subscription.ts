/**
 * Explicit account-backed Codex selection; never inferred from missing API credentials.
 * @version 0.1.0
 */
export const CODEX_SUBSCRIPTION_PROTOCOL = "codex_subscription" as const;
export const NATIVE_CODEX_SUBSCRIPTION_EXECUTION_MODE = "native_codex_subscription" as const;
export const NATIVE_CODEX_SUBSCRIPTION_CAPABILITY = "native-codex-subscription" as const;

export interface NativeCodexSubscriptionSelection {
  provider: "codex";
  model: string;
  reasoning_effort: string;
}

/** Keep the exact requested identities. Account support is checked by the native executor. */
export function assertNativeCodexSubscriptionSelection(value: unknown): asserts value is NativeCodexSubscriptionSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native_subscription must explicitly select provider, model and reasoning_effort");
  }
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).some((key) => !["provider", "model", "reasoning_effort"].includes(key))) {
    throw new Error("native_subscription permits only provider, model and reasoning_effort; credentials and endpoints are forbidden");
  }
  if (selection.provider !== "codex") throw new Error("native_subscription.provider must be codex");
  for (const key of ["model", "reasoning_effort"] as const) {
    if (typeof selection[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selection[key])) {
      throw new Error(`native_subscription.${key} must be an explicit exact identifier`);
    }
  }
}

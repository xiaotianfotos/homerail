import * as http from "node:http";
import {
  hasManagerAgentConfig,
  readManagerAgentConfig,
  saveManagerAgentConfig,
} from "../persistence/manager-agent-config.js";
import {
  findActiveCodexCompatibleSetting,
  findActiveClaudeSdkCompatibleSetting,
  findActiveLlmRuntimeSetting,
  getSetting,
} from "../persistence/llm-settings.js";
import { resolveManagerAgentConfig } from "./manager-agent-runtime-config.js";
import {
  normalizeManagerAgentHarness,
  resolveCodexProviderModelProfile,
} from "homerail-protocol";
import { listCodexModels, type CodexModel, type CodexModelCatalog } from "./codex-models.js";
import type { ManagerAgentConfig } from "../persistence/manager-agent-config.js";
import {
  parseGenerativeUiMode,
  resolveConfiguredGenerativeUiModeDetails,
} from "../generative-ui/mode.js";
import {
  inspectCodexInstallation,
  type CodexLiveVoiceCapability,
} from "./codex-live-voice-capability.js";
import {
  CODEX_LIVE_VOICE_V3_VOICES,
  isCodexLiveVoiceV3Voice,
} from "../domain/codex-live-voice.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

export interface ManagerAgentConfigRoutesOptions {
  loadCodexModels?: () => Promise<CodexModelCatalog>;
  loadCodexLiveVoiceCapability?: () => CodexLiveVoiceCapability | Promise<CodexLiveVoiceCapability>;
  autoDetectCodex?: boolean;
}

export class ManagerAgentConfigValidationError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ManagerAgentConfigValidationError";
    this.cause = cause;
  }
}

function json(res: http.ServerResponse, status: number, body: BaseResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res: http.ServerResponse, message: string, data?: unknown): void {
  json(res, 200, { success: true, message, data });
}

function badRequest(res: http.ServerResponse, message: string): void {
  json(res, 400, { success: false, message, error: message });
}

function serverError(res: http.ServerResponse, message: string): void {
  json(res, 500, { success: false, message, error: message });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _string(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function autoDetectCodex(options: ManagerAgentConfigRoutesOptions): boolean {
  return options.autoDetectCodex ?? process.env.NODE_ENV !== "test";
}

function validateManagerConfig(config: ReturnType<typeof readManagerAgentConfig>): void {
  if (!config.llm_setting_id && !config.provider_name && config.harness !== "kimi_code") return;
  resolveManagerAgentConfig(
    undefined,
    config.provider_name ?? undefined,
    config.model_name ?? undefined,
    config.llm_setting_id ?? undefined,
    config.harness,
    config.reasoning_effort,
    config.service_tier,
  );
}

function normalizedServiceTier(value: string | null): string | null {
  return value === "fast" ? "priority" : value;
}

function providerDefaultReasoningEffort(providerId?: string, model?: string): string | undefined {
  return resolveCodexProviderModelProfile(providerId, model)?.default_reasoning_effort;
}

function patchedConfig(patch: Record<string, unknown>): ManagerAgentConfig {
  const current = readManagerAgentConfig();
  const settingId = _string(patch.llm_setting_id);
  const providerName = _string(patch.provider_name);
  const modelName = _string(patch.model_name);
  const reasoningEffort = _string(patch.reasoning_effort);
  const harness = normalizeManagerAgentHarness(patch.harness) ?? current.harness;
  const hasReasoningEffortPatch = Object.prototype.hasOwnProperty.call(patch, "reasoning_effort");
  const explicitReasoningEffort = hasReasoningEffortPatch
    ? reasoningEffort ?? (harness === "deepseek_harness" ? "" : undefined)
    : undefined;
  const serviceTier = _string(patch.service_tier);
  const generativeUiMode = patch.generative_ui_mode === undefined
    ? current.generative_ui_mode
    : parseGenerativeUiMode(patch.generative_ui_mode);
  if (patch.live_voice_enabled !== undefined && typeof patch.live_voice_enabled !== "boolean") {
    throw new Error("live_voice_enabled must be a boolean");
  }
  if (
    patch.live_voice_voice !== undefined
    && !isCodexLiveVoiceV3Voice(patch.live_voice_voice)
  ) {
    throw new Error(
      `live_voice_voice must be one of: ${CODEX_LIVE_VOICE_V3_VOICES.join(", ")}`,
    );
  }
  const liveVoiceEnabled = patch.live_voice_enabled === undefined
    ? current.live_voice_enabled
    : patch.live_voice_enabled;
  const liveVoiceVoice = patch.live_voice_voice === undefined
    ? current.live_voice_voice
    : patch.live_voice_voice as ManagerAgentConfig["live_voice_voice"];
  const mergedSettingId = settingId === undefined ? current.llm_setting_id : settingId;
  const mergedProviderName = providerName === undefined ? current.provider_name : providerName;
  const mergedModelName = modelName === undefined ? current.model_name : modelName;
  const mergedReasoningEffort = explicitReasoningEffort ?? current.reasoning_effort;
  const mergedServiceTier = serviceTier === undefined
    ? current.service_tier
    : normalizedServiceTier(serviceTier);
  if (harness === "codex_appserver") {
    const switchingToCodex = current.harness !== "codex_appserver";
    const useExplicitSubscriptionModel = switchingToCodex && modelName !== undefined &&
      settingId === undefined && providerName === undefined;
    const useAutomaticProvider = switchingToCodex && settingId === undefined &&
      providerName === undefined && modelName === undefined;
    const preferredSetting = useAutomaticProvider
      ? findActiveCodexCompatibleSetting()
      : undefined;
    const explicitSetting = typeof settingId === "string" ? getSetting(settingId) : undefined;
    const providerSelectionChanged = switchingToCodex || settingId !== undefined ||
      providerName !== undefined || modelName !== undefined;
    const selectedProviderId = preferredSetting?.provider_id ?? explicitSetting?.provider_id ??
      (typeof providerName === "string" ? providerName : undefined);
    const selectedModel = preferredSetting?.model_name ?? explicitSetting?.model_name ??
      (typeof modelName === "string" ? modelName : undefined);
    const selectedProviderDefault = providerSelectionChanged && !useExplicitSubscriptionModel
      ? providerDefaultReasoningEffort(selectedProviderId, selectedModel)
      : undefined;
    return {
      ...current,
      harness,
      live_voice_enabled: liveVoiceEnabled,
      live_voice_voice: liveVoiceVoice,
      llm_setting_id: preferredSetting?.id ?? (useAutomaticProvider || useExplicitSubscriptionModel ? null : mergedSettingId),
      provider_name: preferredSetting?.provider_id ?? (useAutomaticProvider || useExplicitSubscriptionModel ? null : mergedProviderName),
      model_name: preferredSetting?.model_name ?? (useAutomaticProvider && modelName === undefined ? null : mergedModelName),
      reasoning_effort: explicitReasoningEffort ?? selectedProviderDefault ?? mergedReasoningEffort,
      service_tier: mergedServiceTier,
      generative_ui_mode: generativeUiMode,
    };
  }
  const dshRuntimeSelectionChanged = harness === "deepseek_harness" && (
    current.harness !== "deepseek_harness"
    || settingId !== undefined
    || providerName !== undefined
    || modelName !== undefined
  );
  const dshSetting = harness === "deepseek_harness" && typeof mergedSettingId === "string"
    ? getSetting(mergedSettingId)
    : undefined;
  return {
    ...current,
    harness,
    live_voice_enabled: liveVoiceEnabled,
    live_voice_voice: liveVoiceVoice,
    llm_setting_id: mergedSettingId,
    provider_name: mergedProviderName,
    model_name: mergedModelName,
    reasoning_effort: explicitReasoningEffort
      ?? (dshRuntimeSelectionChanged ? dshSetting?.default_reasoning_effort ?? "" : mergedReasoningEffort),
    service_tier: mergedServiceTier,
    generative_ui_mode: generativeUiMode,
  };
}

function codexModelMatches(model: CodexModel, modelName: string): boolean {
  return model.model === modelName || model.id === modelName;
}

function requiredCodexModelName(config: ManagerAgentConfig): string {
  if (config.model_name) return config.model_name;
  throw new Error("Codex app-server did not provide an available model for the current account.");
}

function validateCodexReasoningEffort(config: ManagerAgentConfig, catalog: CodexModelCatalog): void {
  if (config.harness !== "codex_appserver") return;
  const modelName = requiredCodexModelName(config);
  const model = catalog.models.find((item) => codexModelMatches(item, modelName));
  if (!model) {
    throw new Error(`Codex model '${modelName}' is not available for the current account.`);
  }
  const supported = model.supported_reasoning_efforts;
  if (supported.length > 0 && !supported.includes(config.reasoning_effort)) {
    throw new Error(
      `Codex model '${modelName}' does not support reasoning effort '${config.reasoning_effort}'. Supported values: ${supported.join(", ")}.`,
    );
  }
}

function validateCodexServiceTier(config: ManagerAgentConfig, catalog: CodexModelCatalog): void {
  if (config.harness !== "codex_appserver" || !config.service_tier) return;
  const modelName = requiredCodexModelName(config);
  const model = catalog.models.find((item) => codexModelMatches(item, modelName));
  if (!model) return;
  const supported = model.service_tiers.map((tier) => tier.id);
  if (!supported.includes(config.service_tier)) {
    throw new Error(
      `Codex model '${modelName}' does not support service tier '${config.service_tier}'. Supported values: standard${supported.length ? `, ${supported.join(", ")}` : ""}.`,
    );
  }
}

function preferredCodexConfig(
  catalog: CodexModelCatalog,
  currentModelName?: string,
): Pick<ManagerAgentConfig, "model_name" | "reasoning_effort" | "service_tier"> | null {
  const candidates = catalog.models.flatMap((model) => {
    const supported = model.supported_reasoning_efforts;
    const defaultEffort = model.default_reasoning_effort &&
      (supported.length === 0 || supported.includes(model.default_reasoning_effort))
      ? model.default_reasoning_effort
      : supported.includes("medium")
        ? "medium"
        : supported[0] ?? "medium";
    return [{ model, reasoning_effort: defaultEffort }];
  });
  const selected = currentModelName
    ? candidates.find(({ model }) => codexModelMatches(model, currentModelName))
    : candidates.find(({ model }) => model.is_default) ?? candidates[0];
  return selected
    ? { model_name: selected.model.model, reasoning_effort: selected.reasoning_effort, service_tier: null }
    : null;
}

function validationError(error: unknown): ManagerAgentConfigValidationError {
  if (error instanceof ManagerAgentConfigValidationError) return error;
  return new ManagerAgentConfigValidationError(
    error instanceof Error ? error.message : String(error),
    error,
  );
}

function configResponse(config: ManagerAgentConfig): Record<string, unknown> {
  const mode = resolveConfiguredGenerativeUiModeDetails(config.generative_ui_mode);
  return {
    ...config,
    effective_generative_ui_mode: mode.effective_mode,
    generative_ui_mode_source: mode.source,
  };
}

export async function validateAndSaveManagerAgentConfig(
  patch: Record<string, unknown>,
  options: ManagerAgentConfigRoutesOptions = {},
): Promise<ManagerAgentConfig> {
  let next: ManagerAgentConfig;
  try {
    next = patchedConfig(patch);
  } catch (error) {
    throw validationError(error);
  }
  if (next.harness === "codex_appserver") {
    const modelSelectionChanged = [
      "harness",
      "llm_setting_id",
      "provider_name",
      "model_name",
      "reasoning_effort",
      "service_tier",
    ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
    try {
      const providerBacked = Boolean(next.llm_setting_id || next.provider_name);
      if (providerBacked) {
        validateManagerConfig(next);
      } else if (!next.model_name || modelSelectionChanged) {
        const catalog = await (options.loadCodexModels ?? listCodexModels)();
        if (!next.model_name) {
          const selected = preferredCodexConfig(catalog);
          if (!selected) throw new Error("Codex app-server returned an empty model catalog.");
          next = {
            ...next,
            ...selected,
            reasoning_effort: _string(patch.reasoning_effort) ? next.reasoning_effort : selected.reasoning_effort,
            service_tier: patch.service_tier === undefined ? selected.service_tier : next.service_tier,
          };
        }
        validateCodexReasoningEffort(next, catalog);
        validateCodexServiceTier(next, catalog);
      }
      if (!providerBacked) validateManagerConfig(next);
    } catch (error) {
      throw validationError(error);
    }
  } else {
    try {
      validateManagerConfig(next);
    } catch (error) {
      throw validationError(error);
    }
  }
  const providerBackedCodex = next.harness === "codex_appserver"
    && Boolean(next.llm_setting_id || next.provider_name);
  if (next.live_voice_enabled && providerBackedCodex) {
    throw validationError(new Error(
      "Live Voice is not supported for provider-backed Codex Responses runtimes. Disable Live Voice or use subscription Codex.",
    ));
  }
  if (patch.live_voice_enabled === true) {
    if (next.harness !== "codex_appserver") {
      throw validationError(new Error("Live Voice requires the Codex app-server Manager runtime."));
    }
    const capability = await (options.loadCodexLiveVoiceCapability
      ? options.loadCodexLiveVoiceCapability()
      : inspectCodexInstallation().live_voice);
    if (!capability.supported) {
      throw validationError(new Error(
        `Codex Live Voice requires Codex ${capability.minimum_version} or newer with ${capability.feature}.`,
      ));
    }
  }
  // Validate the operational override before the persistence boundary. An
  // invalid environment value is a server configuration error, but it must
  // never turn a successful write into a post-commit 500 response.
  resolveConfiguredGenerativeUiModeDetails(next.generative_ui_mode);
  return saveManagerAgentConfig(next as unknown as Record<string, unknown>);
}

export async function ensurePreferredManagerAgentConfig(
  options: ManagerAgentConfigRoutesOptions = {},
): Promise<ManagerAgentConfig> {
  const current = readManagerAgentConfig();
  if (hasManagerAgentConfig()) {
    if (current.harness === "codex_appserver" && (current.llm_setting_id || current.provider_name)) {
      try {
        validateManagerConfig(current);
        return current;
      } catch {
        // Fall through to another available runtime when the provider-backed config is stale.
      }
    } else if (current.harness === "codex_appserver" && autoDetectCodex(options)) {
      try {
        const catalog = await (options.loadCodexModels ?? listCodexModels)();
        try {
          validateManagerConfig(current);
          validateCodexReasoningEffort(current, catalog);
          validateCodexServiceTier(current, catalog);
          return current;
        } catch {
          const selected = preferredCodexConfig(catalog, current.model_name ?? undefined) ??
            preferredCodexConfig(catalog);
          if (selected) {
            return saveManagerAgentConfig({
              harness: "codex_appserver",
              llm_setting_id: null,
              provider_name: null,
              ...selected,
            });
          }
        }
      } catch {
        // Fall through to another available runtime when app-server is unavailable.
      }
    } else {
      try {
        validateManagerConfig(current);
        return current;
      } catch {
        // Fall through to an available runtime when a stored config is stale.
      }
    }
  }

  const codexSetting = findActiveCodexCompatibleSetting();
  if (codexSetting) {
    const next = saveManagerAgentConfig({
      harness: "codex_appserver",
      llm_setting_id: codexSetting.id,
      provider_name: codexSetting.provider_id,
      model_name: codexSetting.model_name,
      reasoning_effort: providerDefaultReasoningEffort(codexSetting.provider_id, codexSetting.model_name),
      service_tier: null,
    });
    validateManagerConfig(next);
    return next;
  }

  const claudeSetting = findActiveClaudeSdkCompatibleSetting();
  if (claudeSetting) {
    const next = saveManagerAgentConfig({
      harness: "claude_agent_sdk",
      llm_setting_id: claudeSetting.id,
      provider_name: claudeSetting.provider_id,
      model_name: claudeSetting.model_name,
    });
    validateManagerConfig(next);
    return next;
  }

  if (autoDetectCodex(options)) {
    try {
      const catalog = await (options.loadCodexModels ?? listCodexModels)();
      const selected = preferredCodexConfig(catalog);
      if (selected) {
        return saveManagerAgentConfig({
          harness: "codex_appserver",
          llm_setting_id: null,
          provider_name: null,
          ...selected,
        });
      }
    } catch {
      // Codex is optional; continue to other configured runtimes.
    }
  }

  const fallbackSetting = findActiveLlmRuntimeSetting();
  if (fallbackSetting) {
    try {
      resolveManagerAgentConfig(
        undefined,
        fallbackSetting.provider_id,
        fallbackSetting.model_name,
        fallbackSetting.id,
        "kimi_code",
      );
      return saveManagerAgentConfig({
        harness: "kimi_code",
        llm_setting_id: fallbackSetting.id,
        provider_name: fallbackSetting.provider_id,
        model_name: fallbackSetting.model_name,
      });
    } catch {
      // No supported harness can execute this setting.
    }
  }

  return current;
}

export function managerAgentConfigRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ManagerAgentConfigRoutesOptions = {},
): boolean {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  const method = req.method || "GET";

  if (pathname === "/api/manager-agent/codex-models") {
    if (method !== "GET") {
      badRequest(res, "Unsupported Codex models method");
      return true;
    }
    (options.loadCodexModels ?? listCodexModels)()
      .then((catalog) => ok(res, "Codex models loaded", catalog))
      .catch((error) => serverError(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  if (pathname !== "/api/manager-agent/config") return false;

  if (method === "GET") {
    void ensurePreferredManagerAgentConfig(options)
      .then((config) => ok(res, "Manager Agent config loaded", configResponse(config)))
      .catch((error) => serverError(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  if (method === "PUT") {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const next = await validateAndSaveManagerAgentConfig(body, options);
          ok(res, "Manager Agent config saved", configResponse(next));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ManagerAgentConfigValidationError) badRequest(res, message);
          else serverError(res, message);
        }
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  badRequest(res, "Unsupported Manager Agent config method");
  return true;
}

import * as http from "node:http";
import {
  hasManagerAgentConfig,
  readManagerAgentConfig,
  saveManagerAgentConfig,
} from "../persistence/manager-agent-config.js";
import {
  findActiveClaudeSdkCompatibleSetting,
  findActiveLlmRuntimeSetting,
} from "../persistence/llm-settings.js";
import { resolveManagerAgentConfig } from "./manager-agent-container.js";
import { normalizeManagerAgentHarness } from "homerail-protocol";
import { listCodexModels, type CodexModel, type CodexModelCatalog } from "./codex-models.js";
import type { ManagerAgentConfig } from "../persistence/manager-agent-config.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

export interface ManagerAgentConfigRoutesOptions {
  loadCodexModels?: () => Promise<CodexModelCatalog>;
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

function isReasoningEffort(value: string): value is ManagerAgentConfig["reasoning_effort"] {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
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
  );
}

function patchedConfig(patch: Record<string, unknown>): ManagerAgentConfig {
  const current = readManagerAgentConfig();
  const settingId = _string(patch.llm_setting_id);
  const providerName = _string(patch.provider_name);
  const modelName = _string(patch.model_name);
  const reasoningEffort = _string(patch.reasoning_effort);
  if (reasoningEffort !== undefined && reasoningEffort !== null && !isReasoningEffort(reasoningEffort)) {
    throw new Error(`Unsupported Manager Agent reasoning effort '${reasoningEffort}'. Supported values: minimal, low, medium, high, xhigh.`);
  }
  const harness = normalizeManagerAgentHarness(patch.harness) ?? current.harness;
  const mergedSettingId = settingId === undefined ? current.llm_setting_id : settingId;
  const mergedProviderName = providerName === undefined ? current.provider_name : providerName;
  const mergedModelName = modelName === undefined ? current.model_name : modelName;
  const mergedReasoningEffort = reasoningEffort && isReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : current.reasoning_effort;
  if (harness === "codex_appserver") {
    return {
      ...current,
      harness,
      llm_setting_id: null,
      provider_name: null,
      model_name: mergedSettingId || mergedProviderName ? "gpt-5.5" : mergedModelName ?? "gpt-5.5",
      reasoning_effort: mergedReasoningEffort,
    };
  }
  return {
    ...current,
    harness,
    llm_setting_id: mergedSettingId,
    provider_name: mergedProviderName,
    model_name: mergedModelName,
    reasoning_effort: mergedReasoningEffort,
  };
}

function codexModelMatches(model: CodexModel, modelName: string): boolean {
  return model.model === modelName || model.id === modelName;
}

function validateCodexReasoningEffort(config: ManagerAgentConfig, catalog: CodexModelCatalog): void {
  if (config.harness !== "codex_appserver") return;
  const modelName = config.model_name || "gpt-5.5";
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

function preferredCodexConfig(catalog: CodexModelCatalog): Pick<ManagerAgentConfig, "model_name" | "reasoning_effort"> | null {
  const candidates = catalog.models.flatMap((model) => {
    const supported = model.supported_reasoning_efforts.filter(isReasoningEffort);
    if (model.supported_reasoning_efforts.length > 0 && supported.length === 0) return [];
    const defaultEffort = isReasoningEffort(model.default_reasoning_effort) &&
      (supported.length === 0 || supported.includes(model.default_reasoning_effort))
      ? model.default_reasoning_effort
      : supported.includes("medium")
        ? "medium"
        : supported[0] ?? "medium";
    return [{ model, reasoning_effort: defaultEffort }];
  });
  const selected = candidates.find(({ model }) => model.is_default) ?? candidates[0];
  return selected
    ? { model_name: selected.model.model, reasoning_effort: selected.reasoning_effort }
    : null;
}

function validationError(error: unknown): ManagerAgentConfigValidationError {
  if (error instanceof ManagerAgentConfigValidationError) return error;
  return new ManagerAgentConfigValidationError(
    error instanceof Error ? error.message : String(error),
    error,
  );
}

export async function validateAndSaveManagerAgentConfig(
  patch: Record<string, unknown>,
  options: ManagerAgentConfigRoutesOptions = {},
): Promise<ManagerAgentConfig> {
  let next: ManagerAgentConfig;
  try {
    next = patchedConfig(patch);
    validateManagerConfig(next);
  } catch (error) {
    throw validationError(error);
  }
  if (next.harness === "codex_appserver") {
    const catalog = await (options.loadCodexModels ?? listCodexModels)();
    try {
      validateCodexReasoningEffort(next, catalog);
    } catch (error) {
      throw validationError(error);
    }
  }
  return saveManagerAgentConfig(next as unknown as Record<string, unknown>);
}

export async function ensurePreferredManagerAgentConfig(
  options: ManagerAgentConfigRoutesOptions = {},
): Promise<ManagerAgentConfig> {
  const current = readManagerAgentConfig();
  if (hasManagerAgentConfig()) {
    try {
      validateManagerConfig(current);
      return current;
    } catch {
      // Fall through to an available runtime when a stored config is stale.
    }
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
      .then((config) => ok(res, "Manager Agent config loaded", config))
      .catch((error) => serverError(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  if (method === "PUT") {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const next = await validateAndSaveManagerAgentConfig(body, options);
          ok(res, "Manager Agent config saved", next);
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

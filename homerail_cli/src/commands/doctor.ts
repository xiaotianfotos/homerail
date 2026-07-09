import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { getClient } from "../index.js";
import type { BaseResponse } from "../client.js";
import { dockerNotFoundDetail, resolveDockerBinary } from "../docker-bin.js";
import {
  DEFAULT_MANAGER_AGENT_HARNESS,
  normalizeManagerAgentHarness,
} from "homerail-protocol";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface GlobalOpts {
  json?: boolean;
  baseUrl?: string;
  requestTimeout?: number;
}

interface DoctorOpts {
  docker?: boolean;
}

type CommandRunner = (
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; stdio?: "ignore" },
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

interface LlmSettingSummary {
  id?: unknown;
  provider_id?: unknown;
  providerId?: unknown;
  model_name?: unknown;
  modelName?: unknown;
  protocol?: unknown;
  base_url?: unknown;
  baseUrl?: unknown;
  anthropic_base_url?: unknown;
  anthropicBaseUrl?: unknown;
  is_active?: unknown;
  isActive?: unknown;
  is_default?: unknown;
  isDefault?: unknown;
  supports_llm?: unknown;
  supportsLlm?: unknown;
  supports_asr?: unknown;
  supportsAsr?: unknown;
  supports_tts?: unknown;
  supportsTts?: unknown;
}

interface ManagerAgentConfigSummary {
  harness?: unknown;
  llm_setting_id?: unknown;
  llmSettingId?: unknown;
  provider_name?: unknown;
  providerName?: unknown;
  model_name?: unknown;
  modelName?: unknown;
}

const CLAUDE_SDK_COMPATIBLE_PROVIDER_IDS = new Set([
  "anthropic",
  "glm",
  "xiaomi",
  "deepseek",
  "kimi",
  "minimax",
  "minimax_cn",
  "aliyun",
]);

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function settingsFromResponse(resp: BaseResponse): LlmSettingSummary[] {
  const data = resp.data as { settings?: LlmSettingSummary[] } | undefined;
  return Array.isArray(data?.settings) ? data.settings : [];
}

function settingId(setting: LlmSettingSummary): string {
  return stringValue(setting.id);
}

function providerId(setting: LlmSettingSummary): string {
  return stringValue(setting.provider_id ?? setting.providerId);
}

function modelName(setting: LlmSettingSummary): string {
  return stringValue(setting.model_name ?? setting.modelName);
}

function settingLabel(setting: LlmSettingSummary): string {
  const provider = providerId(setting) || "?";
  const model = modelName(setting) || "?";
  return `${provider}/${model}`;
}

function isActiveLlmSetting(setting: LlmSettingSummary): boolean {
  return boolValue(setting.is_active ?? setting.isActive, true) &&
    boolValue(setting.supports_llm ?? setting.supportsLlm, true);
}

function isDefaultSetting(setting: LlmSettingSummary): boolean {
  return boolValue(setting.is_default ?? setting.isDefault, false);
}

function anthropicCompatibleBaseUrl(setting: LlmSettingSummary): string {
  const anthropicBaseUrl = stringValue(setting.anthropic_base_url ?? setting.anthropicBaseUrl);
  if (anthropicBaseUrl) return anthropicBaseUrl;
  const protocol = stringValue(setting.protocol);
  const baseUrl = stringValue(setting.base_url ?? setting.baseUrl);
  if (protocol === "anthropic_compatible") return baseUrl;
  if (protocol === "custom" && CLAUDE_SDK_COMPATIBLE_PROVIDER_IDS.has(providerId(setting))) {
    return baseUrl;
  }
  return "";
}

function modelRuntimeBaseUrl(setting: LlmSettingSummary): string {
  return stringValue(setting.base_url ?? setting.baseUrl);
}

const defaultCommandRunner: CommandRunner = (file, args, options) => spawnSync(file, args, options);

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function commandErrorDetail(result: ReturnType<CommandRunner>): string {
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return "command not found";
    return err.message;
  }
  return (outputText(result.stderr) || outputText(result.stdout) || "command failed").trim();
}

export function dockerReadiness(
  runner: CommandRunner = defaultCommandRunner,
  dockerBin = resolveDockerBinary(),
): CheckResult[] {
  const checks: CheckResult[] = [];
  const version = runner(dockerBin, ["--version"], { encoding: "utf-8" });
  if (version.error || version.status !== 0) {
    checks.push({
      name: "docker-cli",
      ok: false,
      detail: version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT"
        ? dockerNotFoundDetail(dockerBin)
        : commandErrorDetail(version),
    });
    checks.push({ name: "docker-daemon", ok: false, detail: "docker CLI unavailable" });
    checks.push({ name: "worker-image", ok: false, detail: "docker CLI unavailable" });
    return checks;
  }

  checks.push({
    name: "docker-cli",
    ok: true,
    detail: (outputText(version.stdout) || "docker available").trim(),
  });

  const serverOs = runner(dockerBin, ["version", "--format", "{{.Server.Os}}"], { encoding: "utf-8" });
  if (serverOs.error || serverOs.status !== 0) {
    checks.push({
      name: "docker-daemon",
      ok: false,
      detail: commandErrorDetail(serverOs),
    });
    checks.push({ name: "worker-image", ok: false, detail: "docker daemon unavailable" });
    return checks;
  }

  const dockerOs = outputText(serverOs.stdout).trim().toLowerCase();
  if (dockerOs !== "linux") {
    checks.push({
      name: "docker-daemon",
      ok: false,
      detail: `Docker daemon is ${dockerOs || "unknown"}; switch Docker Desktop to Linux containers`,
    });
    checks.push({ name: "worker-image", ok: false, detail: "Linux container daemon required" });
    return checks;
  }

  checks.push({ name: "docker-daemon", ok: true, detail: "Linux containers" });

  const image = runner(dockerBin, ["image", "inspect", "homerail-worker:latest"], { stdio: "ignore" });
  checks.push({
    name: "worker-image",
    ok: image.status === 0,
    detail: image.status === 0
      ? "homerail-worker:latest present"
      : "run: hr start --rebuild-worker-image",
  });
  return checks;
}

export function configuredModel(resp: BaseResponse): string | null {
  const settings = settingsFromResponse(resp).filter(isActiveLlmSetting);
  const selected = settings.find(isDefaultSetting) ?? settings[0];
  return selected ? settingLabel(selected) : null;
}

export function managerAgentReadiness(
  config: ManagerAgentConfigSummary,
  settingsResp: BaseResponse,
): CheckResult {
  const settings = settingsFromResponse(settingsResp).filter(isActiveLlmSetting);
  const harness = normalizeManagerAgentHarness(config.harness) ?? DEFAULT_MANAGER_AGENT_HARNESS;
  if (harness === "codex_appserver") {
    return { name: "manager-agent", ok: true, detail: "codex_appserver configured" };
  }

  const configSettingId = stringValue(config.llm_setting_id ?? config.llmSettingId);
  const configProvider = stringValue(config.provider_name ?? config.providerName);
  const configModel = stringValue(config.model_name ?? config.modelName);
  let selected: LlmSettingSummary | undefined;

  if (configSettingId) {
    selected = settings.find((setting) => settingId(setting) === configSettingId);
  } else if (configProvider || configModel) {
    selected = settings.find((setting) =>
      (!configProvider || providerId(setting) === configProvider) &&
      (!configModel || modelName(setting) === configModel),
    );
  } else if (harness === "kimi_code") {
    const compatible = settings.filter((setting) => providerId(setting) === "kimi");
    selected = compatible.find(isDefaultSetting) ?? compatible[0];
  } else {
    const compatible = settings.filter((setting) => Boolean(anthropicCompatibleBaseUrl(setting)));
    selected = compatible.find(isDefaultSetting) ?? compatible[0];
  }

  if (!selected) {
    return {
      name: "manager-agent",
      ok: false,
      detail: harness === "kimi_code"
        ? "run: hr model configure or hr llm-settings add with an active Kimi setting"
        : "run: hr model configure or hr llm-settings add with an Anthropic-compatible endpoint",
    };
  }
  if (harness === "kimi_code") {
    if (providerId(selected) !== "kimi") {
      return {
        name: "manager-agent",
        ok: false,
        detail: `${settingLabel(selected)} is not a Kimi setting for kimi_code`,
      };
    }
    if (!modelRuntimeBaseUrl(selected)) {
      return {
        name: "manager-agent",
        ok: false,
        detail: `${settingLabel(selected)} has no runtime base URL for kimi_code`,
      };
    }
    return { name: "manager-agent", ok: true, detail: `${settingLabel(selected)} via kimi_code` };
  }
  if (!anthropicCompatibleBaseUrl(selected)) {
    return {
      name: "manager-agent",
      ok: false,
      detail: `${settingLabel(selected)} is not Anthropic-compatible for claude_agent_sdk`,
    };
  }
  return { name: "manager-agent", ok: true, detail: `${settingLabel(selected)} via claude_agent_sdk` };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check whether the local HomeRail runtime is ready")
    .option("--docker", "Also check Docker Desktop readiness for container-backed DAG workers")
    .action(async (opts: DoctorOpts) => {
      const globalOpts = program.opts() as GlobalOpts;
      const client = getClient(globalOpts);
      const checks: CheckResult[] = [];
      let settingsResp: BaseResponse | undefined;

      try {
        await client.get("/health");
        checks.push({ name: "manager", ok: true, detail: client.baseUrl });
      } catch (err) {
        checks.push({
          name: "manager",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const runtime = await client.get<BaseResponse | Record<string, unknown>>("/runtime/status");
        const runtimeData = runtime && typeof runtime === "object" && "data" in runtime
          ? (runtime as BaseResponse).data
          : runtime;
        const data = runtimeData && typeof runtimeData === "object"
          ? runtimeData as Record<string, unknown>
          : {};
        const connectedNodes = Number(data.connected_nodes ?? 0);
        checks.push({
          name: "runtime",
          ok: true,
          detail: JSON.stringify(runtime),
        });
        checks.push({
          name: "node",
          ok: connectedNodes > 0,
          detail: connectedNodes > 0
            ? `${connectedNodes} connected`
            : "run: hr start",
        });
      } catch (err) {
        checks.push({
          name: "runtime",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
        checks.push({
          name: "node",
          ok: false,
          detail: "runtime unavailable",
        });
      }

      try {
        settingsResp = await client.get<BaseResponse>("/api/llm/settings");
        const model = configuredModel(settingsResp);
        checks.push({
          name: "model",
          ok: Boolean(model),
          detail: model
            ? `${model} configured`
            : "run: hr model configure <provider-or-endpoint-alias>",
        });
      } catch (err) {
        checks.push({
          name: "model",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        if (!settingsResp) throw new Error("LLM settings unavailable");
        const configResp = await client.get<BaseResponse>("/api/manager-agent/config");
        const config = (configResp.data ?? {}) as ManagerAgentConfigSummary;
        checks.push(managerAgentReadiness(config, settingsResp));
      } catch (err) {
        checks.push({
          name: "manager-agent",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      if (opts.docker) {
        checks.push(...dockerReadiness());
      }

      const ok = checks.every((check) => check.ok);
      if (globalOpts.json) {
        console.log(JSON.stringify({ ok, checks }));
      } else {
        for (const check of checks) {
          console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
        }
        console.log(ok ? "HomeRail is ready." : "HomeRail is not ready yet.");
      }
      if (!ok) process.exitCode = 1;
    });
}

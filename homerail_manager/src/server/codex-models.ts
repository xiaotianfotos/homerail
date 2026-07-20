import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import {
  codexBinaryNotFoundMessage,
  resolveCodexBinary,
  type CodexBinaryResolution,
} from "./codex-binary.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexReasoningEffortOption {
  reasoning_effort: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  display_name: string;
  description: string;
  is_default: boolean;
  default_reasoning_effort: string;
  supported_reasoning_efforts: string[];
  reasoning_effort_options?: CodexReasoningEffortOption[];
  service_tiers: CodexModelServiceTier[];
}

export interface CodexModelCatalog {
  binary: string;
  models: CodexModel[];
}

export interface CodexModelListOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  resolution?: CodexBinaryResolution | null;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReasoningEffortOptions(value: unknown): CodexReasoningEffortOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = record(item);
    const reasoningEffort = stringValue(raw?.reasoningEffort ?? item);
    if (!reasoningEffort) return [];
    return [{
      reasoning_effort: reasoningEffort,
      description: stringValue(raw?.description),
    }];
  });
}

function normalizeServiceTiers(value: unknown): CodexModelServiceTier[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = record(item);
    if (!raw) return [];
    const id = stringValue(raw.id);
    if (!id) return [];
    return [{
      id,
      name: stringValue(raw.name) || id,
      description: stringValue(raw.description),
    }];
  });
}

function normalizeModel(value: unknown): CodexModel | null {
  const raw = record(value);
  if (!raw || raw.hidden === true) return null;
  const id = stringValue(raw.id) || stringValue(raw.model);
  if (!id) return null;
  const model = stringValue(raw.model) || id;
  const reasoningEffortOptions = normalizeReasoningEffortOptions(raw.supportedReasoningEfforts);
  return {
    id,
    model,
    display_name: stringValue(raw.displayName) || model,
    description: stringValue(raw.description),
    is_default: raw.isDefault === true,
    default_reasoning_effort: stringValue(raw.defaultReasoningEffort),
    supported_reasoning_efforts: reasoningEffortOptions.map((option) => option.reasoning_effort),
    reasoning_effort_options: reasoningEffortOptions,
    service_tiers: normalizeServiceTiers(raw.serviceTiers),
  };
}

function errorMessage(value: unknown): string {
  const raw = record(value);
  return stringValue(raw?.message) || stringValue(value) || "Codex app-server request failed";
}

function terminateCodexProcess(
  child: ChildProcessWithoutNullStreams,
  resolution: CodexBinaryResolution,
): void {
  if (process.platform === "win32" && resolution.needsShell && child.pid) {
    const result = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  if (!child.killed) child.kill();
}

function queryCodexModels(
  resolution: CodexBinaryResolution,
  options: CodexModelListOptions,
): Promise<CodexModelCatalog> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const spawnOptions: SpawnOptionsWithoutStdio = {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: resolution.needsShell,
        windowsHide: true,
      };
      child = (options.spawnImpl ?? spawn)(resolution.command, ["app-server"], {
        ...spawnOptions,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    let nextRequestId = 2;
    let pendingModelRequestId = 0;
    const modelsByName = new Map<string, CodexModel>();
    const seenCursors = new Set<string>();
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out while loading Codex models after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();

    function finish(error?: Error, catalog?: CodexModelCatalog): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateCodexProcess(child, resolution);
      if (error) reject(error);
      else resolve(catalog ?? { binary: resolution.command, models: [] });
    }

    function send(id: number, method: string, params: Record<string, unknown>): void {
      if (settled || child.stdin.destroyed || !child.stdin.writable) {
        finish(new Error("Codex app-server stdin closed before the request could be sent"));
        return;
      }
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (error) finish(error);
        },
      );
    }

    function requestModelPage(cursor?: string): void {
      pendingModelRequestId = nextRequestId;
      nextRequestId += 1;
      send(pendingModelRequestId, "model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(errorMessage(message.error)));
            return;
          }
          requestModelPage();
          continue;
        }
        if (message.id !== pendingModelRequestId) continue;
        if (message.error) {
          finish(new Error(errorMessage(message.error)));
          return;
        }
        const result = record(message.result);
        const models = Array.isArray(result?.data)
          ? result.data.map(normalizeModel).filter((model): model is CodexModel => Boolean(model))
          : [];
        for (const model of models) {
          if (!modelsByName.has(model.model)) modelsByName.set(model.model, model);
        }
        const nextCursor = stringValue(result?.nextCursor);
        if (nextCursor) {
          if (seenCursors.has(nextCursor)) {
            finish(new Error(`Codex app-server returned a repeated model catalog cursor: ${nextCursor}`));
            return;
          }
          seenCursors.add(nextCursor);
          requestModelPage(nextCursor);
          continue;
        }
        finish(undefined, { binary: resolution.command, models: [...modelsByName.values()] });
        return;
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        const message = code === 0
          ? "Codex app-server exited without returning a model catalog"
          : `Codex app-server exited before returning models (code ${code ?? "unknown"})`;
        finish(new Error(stderr.trim() || message));
      }
    });

    send(1, "initialize", {
      clientInfo: {
        name: "homerail_codex_model_catalog",
        title: "HomeRail Codex Model Catalog",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    });
  });
}

export async function listCodexModels(
  options: CodexModelListOptions = {},
): Promise<CodexModelCatalog> {
  const resolution = options.resolution === undefined
    ? resolveCodexBinary(undefined, { env: options.env ?? process.env })
    : options.resolution;
  if (!resolution) throw new Error(codexBinaryNotFoundMessage(undefined, { env: options.env ?? process.env }));
  return queryCodexModels(resolution, options);
}

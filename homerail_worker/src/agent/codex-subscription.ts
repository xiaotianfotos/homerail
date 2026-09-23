import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentRunContext } from "./types.js";

/** Native auth stays in Codex. This file stores only the HomeRail/native ID association. */
export interface NativeCodexSession {
  version: 1;
  threadId: string;
  binding: string;
}

export interface NativeCodexRuntime {
  bin: string;
  home: string;
  stateDir: string;
  sessionKey: string;
  workspace: string;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function directory(value: string | undefined, name: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be a trusted absolute directory`);
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${name} must be a directory`);
  return real;
}

export function nativeCodexRuntime(context: AgentRunContext, env = process.env): NativeCodexRuntime {
  if (env.HOMERAIL_CODEX_SUBSCRIPTION_ENABLED !== "1") throw new Error("Native Codex subscription is not enabled on this Worker");
  if (context.provider !== "openai" || !context.model.trim() || !context.reasoningEffort?.trim()) {
    throw new Error("Native Codex subscription requires the exact OpenAI model and reasoning effort");
  }
  if (context.apiKey || context.baseUrl || Object.keys(context.environmentVariables ?? {}).length > 0 || context.serviceTier) {
    throw new Error("Native Codex subscription does not accept API credentials, endpoints, environment projections, or service-tier overrides");
  }
  if (context.codexSandbox !== "read-only" || !context.workspaceAccess || context.workspaceAccess.writable_paths.length !== 0) {
    throw new Error("Native Codex subscription requires an explicitly read-only workspace and sandbox");
  }
  if (!context.sessionId?.trim()) throw new Error("Native Codex subscription requires a stable HomeRail session identity");
  const workspace = directory(context.workspace, "Native Codex workspace");
  const home = directory(env.HOMERAIL_CODEX_SUBSCRIPTION_HOME, "Native Codex home");
  const stateDir = directory(env.HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR, "Native Codex session directory");
  if (contains(workspace, home) || contains(workspace, stateDir) || contains(home, workspace)) {
    throw new Error("Native Codex home and session directory must be outside the readable workspace");
  }
  const bin = env.HOMERAIL_CODEX_SUBSCRIPTION_BIN;
  if (!bin || !path.isAbsolute(bin) || !fs.statSync(bin).isFile()) throw new Error("Native Codex requires a trusted absolute binary path");
  return { bin, home, stateDir, sessionKey: context.sessionId, workspace };
}

export function nativeCodexEnvironment(runtime: NativeCodexRuntime, source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"]) {
    if (source[key]) env[key] = source[key];
  }
  env.CODEX_HOME = runtime.home;
  return env;
}

/** Process-local overrides; never write the user's Codex configuration. */
export function nativeCodexArgs(runtime?: NativeCodexRuntime, scratch?: string, permissionProfile?: string): string[] {
  const extra: string[] = [];
  const config: Record<string, unknown> = {
    model_provider: "openai", forced_login_method: "chatgpt", approval_policy: "never",
    sandbox_mode: "read-only", web_search: "disabled", project_doc_max_bytes: 0,
    notify: [],
    "features.hooks": false, "features.apps": false, "features.browser_use": false,
    "features.browser_use_external": false, "features.browser_use_full_cdp_access": false,
    "features.computer_use": false, "features.in_app_browser": false,
    "features.multi_agent": false, "features.multi_agent_v2": false,
    "features.memories": false, "features.image_generation": false,
    // Current native models route their sandboxed tools through this host.
    // It must remain enabled; filesystem/network permissions still apply.
    "features.code_mode_host": true,
    "features.remote_control": false, "features.remote_models": false,
  };
  if (runtime && scratch && permissionProfile) {
    config.default_permissions = permissionProfile;
    delete config.sandbox_mode;
    const filesystem: Record<string, string> = {
      ":root": "deny", ":minimal": "read", [runtime.workspace]: "read", [scratch]: "read",
      [runtime.home]: "deny", [runtime.stateDir]: "deny",
    };
    // CLI dotted-key parsing splits dots even inside quoted path components.
    // Set the whole inline TOML table to preserve filesystem keys exactly.
    extra.push("-c", `permissions.${permissionProfile}.filesystem={${Object.entries(filesystem).map(([root, mode]) => `${JSON.stringify(root)}=${JSON.stringify(mode)}`).join(",")}}`);
    config[`permissions.${permissionProfile}.network.enabled`] = false;
  }
  return ["app-server", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), ...extra];
}

export function nativeCodexThreadConfig(
  resolved: Record<string, unknown>,
  skillPaths: string[],
  scratch: string,
  effort: string,
  runtime?: NativeCodexRuntime,
  permissionProfile?: string,
): Record<string, unknown> {
  for (const field of ["model_instructions_file", "responses_api_endpoint", "experimental_instructions_file"]) {
    if (resolved[field]) throw new Error(`Native Codex subscription refuses inherited ${field}`);
  }
  if (resolved.chatgpt_base_url && !["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/"].includes(String(resolved.chatgpt_base_url))) {
    throw new Error("Native Codex subscription refuses an overridden ChatGPT endpoint");
  }
  if (Array.isArray(resolved.notify) && resolved.notify.length > 0) {
    throw new Error("Native Codex subscription requires host notifications to be disabled");
  }
  const providers = resolved.model_providers as Record<string, unknown> | undefined;
  if (providers?.openai && Object.keys(providers.openai as object).length > 0) {
    throw new Error("Native Codex subscription refuses an overridden OpenAI provider");
  }
  const servers = resolved.mcp_servers as Record<string, unknown> | undefined;
  const plugins = resolved.plugins as Record<string, unknown> | undefined;
  return {
    model_provider: "openai", model_reasoning_effort: effort,
    mcp_servers: Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }])),
    plugins: Object.fromEntries(Object.keys(plugins ?? {}).map(name => [name, { enabled: false }])),
    skills: { config: skillPaths.map(p => ({ path: p, enabled: false })) },
    web_search: "disabled", project_doc_max_bytes: 0, developer_instructions: "",
    ...(runtime && permissionProfile ? {
      default_permissions: permissionProfile,
      permissions: { [permissionProfile]: {
        filesystem: {
          ":root": "deny", ":minimal": "read",
          [runtime.workspace]: "read", [scratch]: "read",
          [runtime.home]: "deny", [runtime.stateDir]: "deny",
        },
        network: { enabled: false },
      } },
    } : {}),
    shell_environment_policy: {
      inherit: "none", include_only: [],
      set: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: scratch, CODEX_HOME: scratch, TMPDIR: scratch },
    },
  };
}

/** A lease prevents concurrent writers to one native transcript, not run deduplication. */
export class NativeCodexSessionStore {
  private readonly file: string;
  private readonly lock: string;
  private readonly owner = randomUUID();
  private readonly binding: string;

  constructor(runtime: NativeCodexRuntime, context: AgentRunContext, tools: unknown) {
    const key = createHash("sha256").update(runtime.sessionKey).digest("hex");
    this.file = path.join(runtime.stateDir, `${key}.json`);
    this.lock = `${this.file}.lock`;
    this.binding = createHash("sha256").update(JSON.stringify({
      home: runtime.home, workspace: runtime.workspace, model: context.model,
      effort: context.reasoningEffort, tools,
    })).digest("hex");
    try {
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, owner: this.owner }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = JSON.parse(fs.readFileSync(this.lock, "utf8")) as { pid: number };
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("Invalid native Codex session lease");
      try {
        process.kill(previous.pid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
        // Unlink/recreate has a race between two recoverers. Keep history
        // closed until the operator confirms the previous Worker has exited.
        throw new Error("Stale native Codex session lease requires explicit recovery; history was preserved");
      }
      throw new Error("Native Codex session is already in use");
    }
  }

  read(): NativeCodexSession | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    const record = JSON.parse(fs.readFileSync(this.file, "utf8")) as NativeCodexSession;
    if (record.version !== 1 || !record.threadId || record.binding !== this.binding) {
      throw new Error("Native Codex session binding changed; refusing to replace its history");
    }
    return record;
  }

  save(threadId: string): void {
    const temp = `${this.file}.${this.owner}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, threadId, binding: this.binding }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  release(): void {
    const current = JSON.parse(fs.readFileSync(this.lock, "utf8")) as { owner: string };
    if (current.owner === this.owner) fs.unlinkSync(this.lock);
  }
}

export const WORKER_BUILD_APT_MIRROR_ENV_KEY = "HOMERAIL_WORKER_BUILD_APT_MIRROR";
export const WORKER_BUILD_APT_SECURITY_MIRROR_ENV_KEY = "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR";
export const WORKER_BUILD_NPM_REGISTRY_ENV_KEY = "HOMERAIL_WORKER_BUILD_NPM_REGISTRY";
export const WORKER_BUILD_DSH_GIT_REMOTE_ENV_KEY = "HOMERAIL_WORKER_BUILD_DSH_GIT_REMOTE";

export const WORKER_BUILD_APT_MIRROR_BUILD_ARG = "HOMERAIL_WORKER_BUILD_APT_MIRROR";
export const WORKER_BUILD_APT_SECURITY_MIRROR_BUILD_ARG = "HOMERAIL_WORKER_BUILD_APT_SECURITY_MIRROR";
export const WORKER_BUILD_NPM_REGISTRY_BUILD_ARG = "NPM_CONFIG_REGISTRY";
export const WORKER_BUILD_DSH_GIT_REMOTE_BUILD_ARG = "HOMERAIL_DSH_FORK_REPOSITORY";

// Uppercase and lowercase spellings are recognized; values are never read
// beyond an emptiness check and stay solely in the Docker child environment.
export const WORKER_BUILD_PROXY_VARIABLE_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

export type WorkerBuildNetworkSourceMode = "default" | "custom";
export type WorkerBuildNetworkProxyMode = "environment" | "docker-managed";

export interface WorkerBuildNetworkSummary {
  apt_main: WorkerBuildNetworkSourceMode;
  apt_security: WorkerBuildNetworkSourceMode;
  npm: WorkerBuildNetworkSourceMode;
  dsh_git: WorkerBuildNetworkSourceMode;
  proxy: WorkerBuildNetworkProxyMode;
}

export interface WorkerBuildNetworkConfig {
  aptMirror?: string;
  aptSecurityMirror?: string;
  npmRegistry?: string;
  dshGitRemote?: string;
  proxyVariableNames: string[];
}

export const DEFAULT_WORKER_BUILD_NETWORK_SUMMARY: WorkerBuildNetworkSummary = {
  apt_main: "default",
  apt_security: "default",
  npm: "default",
  dsh_git: "default",
  proxy: "docker-managed",
};

export class WorkerBuildNetworkError extends Error {
  readonly envKey: string;

  constructor(envKey: string, reason: string) {
    // The message names the configuration key but never the rejected value.
    super(`Invalid ${envKey} configuration: ${reason}`);
    this.name = "WorkerBuildNetworkError";
    this.envKey = envKey;
  }
}

const NON_PRINTABLE_OR_NON_ASCII_SOURCE_CHARACTERS = /[^\u0021-\u007e]/;
const URL_REWRITE_SOURCE_CHARACTERS = /["$()%<>`^{}|\\]/;
const URL_PATH_BRACKETS = /[\[\]]/;
const URL_AUTHORITY_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

function normalizeTrailingSlashes(href: string): string {
  return href.replace(/\/+$/, "");
}

function resolveSourceUrl(envKey: string, raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Match the Worker helper's fail-closed contract before WHATWG parsing:
  // source URLs are printable ASCII and must not contain characters that the
  // parser would percent-encode or rewrite.
  if (NON_PRINTABLE_OR_NON_ASCII_SOURCE_CHARACTERS.test(trimmed)) {
    throw new WorkerBuildNetworkError(
      envKey,
      "value must not contain control characters, whitespace, or non-ASCII characters.",
    );
  }
  if (URL_REWRITE_SOURCE_CHARACTERS.test(trimmed)) {
    throw new WorkerBuildNetworkError(
      envKey,
      "value must not contain unsupported URL characters.",
    );
  }
  // Check raw authority text as WHATWG parsing drops an empty userinfo marker
  // (`https://@host/`) before username/password can expose it.
  if (URL_AUTHORITY_USERINFO.test(trimmed)) {
    throw new WorkerBuildNetworkError(envKey, "credential-bearing URLs are not supported.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WorkerBuildNetworkError(envKey, "value must be an absolute http: or https: URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WorkerBuildNetworkError(envKey, "only http: and https: URLs are supported.");
  }
  if (!parsed.hostname) {
    throw new WorkerBuildNetworkError(envKey, "value must include a hostname.");
  }
  if (parsed.username || parsed.password) {
    throw new WorkerBuildNetworkError(envKey, "credential-bearing URLs are not supported.");
  }
  if (parsed.search || parsed.hash) {
    throw new WorkerBuildNetworkError(envKey, "value must not include a query or fragment.");
  }
  // Brackets are required around IPv6 hosts, but are not useful in public
  // mirror paths and have varied normalization behavior across Node releases.
  if (URL_PATH_BRACKETS.test(parsed.pathname)) {
    throw new WorkerBuildNetworkError(
      envKey,
      "value must not contain path characters that require URL encoding.",
    );
  }
  return normalizeTrailingSlashes(parsed.toString());
}

function resolveProxyVariableNames(env: NodeJS.ProcessEnv): string[] {
  const names: string[] = [];
  for (const name of WORKER_BUILD_PROXY_VARIABLE_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) names.push(name);
  }
  return names;
}

export function resolveWorkerBuildNetwork(
  env: NodeJS.ProcessEnv = process.env,
): WorkerBuildNetworkConfig {
  return {
    aptMirror: resolveSourceUrl(WORKER_BUILD_APT_MIRROR_ENV_KEY, env[WORKER_BUILD_APT_MIRROR_ENV_KEY]),
    aptSecurityMirror: resolveSourceUrl(
      WORKER_BUILD_APT_SECURITY_MIRROR_ENV_KEY,
      env[WORKER_BUILD_APT_SECURITY_MIRROR_ENV_KEY],
    ),
    npmRegistry: resolveSourceUrl(WORKER_BUILD_NPM_REGISTRY_ENV_KEY, env[WORKER_BUILD_NPM_REGISTRY_ENV_KEY]),
    dshGitRemote: resolveSourceUrl(
      WORKER_BUILD_DSH_GIT_REMOTE_ENV_KEY,
      env[WORKER_BUILD_DSH_GIT_REMOTE_ENV_KEY],
    ),
    proxyVariableNames: resolveProxyVariableNames(env),
  };
}

export function workerBuildNetworkDockerArgs(config: WorkerBuildNetworkConfig): string[] {
  const args: string[] = [];
  if (config.aptMirror) {
    args.push("--build-arg", `${WORKER_BUILD_APT_MIRROR_BUILD_ARG}=${config.aptMirror}`);
  }
  if (config.aptSecurityMirror) {
    args.push("--build-arg", `${WORKER_BUILD_APT_SECURITY_MIRROR_BUILD_ARG}=${config.aptSecurityMirror}`);
  }
  if (config.npmRegistry) {
    args.push("--build-arg", `${WORKER_BUILD_NPM_REGISTRY_BUILD_ARG}=${config.npmRegistry}`);
  }
  if (config.dshGitRemote) {
    args.push("--build-arg", `${WORKER_BUILD_DSH_GIT_REMOTE_BUILD_ARG}=${config.dshGitRemote}`);
  }
  // Value-less entries let Docker resolve the value from the child
  // environment; HomeRail never places proxy values in argv.
  for (const name of config.proxyVariableNames) {
    args.push("--build-arg", name);
  }
  return args;
}

export function workerBuildNetworkSummary(config: WorkerBuildNetworkConfig): WorkerBuildNetworkSummary {
  return {
    apt_main: config.aptMirror ? "custom" : "default",
    apt_security: config.aptSecurityMirror ? "custom" : "default",
    npm: config.npmRegistry ? "custom" : "default",
    dsh_git: config.dshGitRemote ? "custom" : "default",
    proxy: config.proxyVariableNames.length > 0 ? "environment" : "docker-managed",
  };
}

export function normalizeWorkerBuildNetworkSummary(
  value: unknown,
): WorkerBuildNetworkSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    apt_main: record.apt_main === "custom" ? "custom" : "default",
    apt_security: record.apt_security === "custom" ? "custom" : "default",
    npm: record.npm === "custom" ? "custom" : "default",
    dsh_git: record.dsh_git === "custom" ? "custom" : "default",
    proxy: record.proxy === "environment" ? "environment" : "docker-managed",
  };
}

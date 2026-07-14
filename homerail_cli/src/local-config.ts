import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LocalHomeRailConfig {
  manager?: {
    url?: string;
    port?: number;
    host?: string;
    publicUrl?: string;
  };
  node?: {
    projectId?: string;
    nodeId?: string;
    provider?: string;
    capabilities?: string[];
  };
  ui?: {
    host?: string;
    port?: number;
    httpPort?: number;
    publicUrl?: string;
  };
  model?: {
    preset?: string;
    endpoint?: string;
    setDefault?: boolean;
  };
  runtime?: {
    buildWorkerImage?: boolean;
  };
  assets?: {
    root?: string;
  };
}

export const DEFAULT_MANAGER_PORT = 19191;
export const DEFAULT_MANAGER_HOST = "127.0.0.1";
export const DEFAULT_MANAGER_URL = `http://localhost:${DEFAULT_MANAGER_PORT}`;
export const DEFAULT_MANAGER_WS_URL = `ws://localhost:${DEFAULT_MANAGER_PORT}`;
export const DEFAULT_UI_HOST = "127.0.0.1";
export const DEFAULT_UI_PORT = 19192;
export const DEFAULT_UI_HTTP_PORT = 19193;
export const DEFAULT_UI_URL = `https://localhost:${DEFAULT_UI_PORT}`;
export const HOMERAIL_MANAGER_ADMIN_TOKEN = "HOMERAIL_MANAGER_ADMIN_TOKEN";

export function getHomerailHome(): string {
  return process.env.HOMERAIL_HOME?.trim() || path.join(os.homedir(), ".homerail");
}

export function getConfigPath(): string {
  return process.env.HOMERAIL_CONFIG_PATH?.trim() || path.join(getHomerailHome(), "config.json");
}

export function getSecretsPath(): string {
  return process.env.HOMERAIL_SECRETS_PATH?.trim() || path.join(getHomerailHome(), "secrets", "env");
}

export function ensureHomerailHome(): void {
  fs.mkdirSync(getHomerailHome(), { recursive: true });
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.mkdirSync(path.dirname(getSecretsPath()), { recursive: true, mode: 0o700 });
}

export function defaultLocalConfig(): LocalHomeRailConfig {
  return {
    manager: {
      url: DEFAULT_MANAGER_URL,
      port: DEFAULT_MANAGER_PORT,
      host: DEFAULT_MANAGER_HOST,
    },
    node: {
      projectId: "p1",
      nodeId: "local-docker-node",
      provider: "docker-cli",
      capabilities: ["docker-cli"],
    },
    ui: {
      host: DEFAULT_UI_HOST,
      port: DEFAULT_UI_PORT,
      httpPort: DEFAULT_UI_HTTP_PORT,
    },
    model: {
      setDefault: true,
    },
    runtime: {
      buildWorkerImage: true,
    },
  };
}

export function loadLocalConfig(): LocalHomeRailConfig {
  const defaults = defaultLocalConfig();
  const filePath = getConfigPath();
  if (!fs.existsSync(filePath)) return defaults;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as LocalHomeRailConfig;
    return mergeConfig(defaults, raw);
  } catch {
    return defaults;
  }
}

export function saveLocalConfig(config: LocalHomeRailConfig): void {
  ensureHomerailHome();
  const filePath = getConfigPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function loadLocalSecrets(): Record<string, string> {
  const filePath = getSecretsPath();
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of readPrivateSecretsFile(filePath).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    out[key] = parseEnvValue(rawValue);
  }
  return out;
}

export function getLocalSecret(key: string): string | undefined {
  return process.env[key] || loadLocalSecrets()[key];
}

/** Resolve the Manager mutation credential without ever reading config.json. */
export function resolveConfiguredManagerAdminToken(): string | undefined {
  const fromEnvironment = process.env[HOMERAIL_MANAGER_ADMIN_TOKEN];
  if (fromEnvironment !== undefined) return fromEnvironment || undefined;

  const filePath = getSecretsPath();
  if (!fs.existsSync(filePath)) return undefined;
  const value = loadLocalSecrets()[HOMERAIL_MANAGER_ADMIN_TOKEN];
  return value || undefined;
}

export function saveLocalSecret(key: string, value: string): void {
  ensureHomerailHome();
  const secrets = loadLocalSecrets();
  secrets[key] = value;
  writeSecrets(secrets);
}

export function resolveConfiguredManagerUrl(override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (process.env.HOMERAIL_MANAGER_URL?.trim()) {
    return process.env.HOMERAIL_MANAGER_URL.trim().replace(/\/+$/, "");
  }
  const cfg = loadLocalConfig();
  return (cfg.manager?.url || DEFAULT_MANAGER_URL).replace(/\/+$/, "");
}

export function configuredManagerHost(config = loadLocalConfig(), override?: string): string {
  if (override?.trim()) return override.trim();
  if (process.env.HOMERAIL_MANAGER_HOST?.trim()) return process.env.HOMERAIL_MANAGER_HOST.trim();
  return config.manager?.host?.trim() || DEFAULT_MANAGER_HOST;
}

export function configuredManagerAccessUrl(config = loadLocalConfig(), override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (process.env.HOMERAIL_MANAGER_PUBLIC_URL?.trim()) {
    return process.env.HOMERAIL_MANAGER_PUBLIC_URL.trim().replace(/\/+$/, "");
  }
  if (config.manager?.publicUrl?.trim()) {
    return config.manager.publicUrl.trim().replace(/\/+$/, "");
  }
  return (config.manager?.url || DEFAULT_MANAGER_URL).replace(/\/+$/, "");
}

export function configuredManagerLocalUrl(config = loadLocalConfig(), override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (process.env.HOMERAIL_MANAGER_URL?.trim()) {
    return process.env.HOMERAIL_MANAGER_URL.trim().replace(/\/+$/, "");
  }
  return (config.manager?.url || DEFAULT_MANAGER_URL).replace(/\/+$/, "");
}

export function configuredManagerPort(config = loadLocalConfig()): number {
  const explicitPort = Number(process.env.HOMERAIL_MANAGER_PORT?.trim() || "");
  if (Number.isInteger(explicitPort) && explicitPort > 0 && explicitPort <= 65535) return explicitPort;
  const url = process.env.HOMERAIL_MANAGER_URL?.trim() || config.manager?.url || DEFAULT_MANAGER_URL;
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_MANAGER_PORT;
  } catch {
    const fromConfig = config.manager?.port;
    if (Number.isInteger(fromConfig) && Number(fromConfig) > 0) return Number(fromConfig);
    return DEFAULT_MANAGER_PORT;
  }
}

export function managerWsUrl(config = loadLocalConfig()): string {
  const url = config.manager?.url || DEFAULT_MANAGER_URL;
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
}

export function configuredUiHost(config = loadLocalConfig(), override?: string): string {
  if (override?.trim()) return override.trim();
  if (process.env.HOMERAIL_UI_HOST?.trim()) return process.env.HOMERAIL_UI_HOST.trim();
  return config.ui?.host?.trim() || DEFAULT_UI_HOST;
}

export function configuredUiPort(
  config = loadLocalConfig(),
  override?: string | number,
): number {
  const raw =
    override !== undefined && override !== null && String(override).trim()
      ? override
      : process.env.HOMERAIL_UI_PORT?.trim() || config.ui?.port || DEFAULT_UI_PORT;
  const port = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_UI_PORT;
}

export function configuredUiHttpPort(
  config = loadLocalConfig(),
  override?: string | number,
): number {
  const raw =
    override !== undefined && override !== null && String(override).trim()
      ? override
      : process.env.HOMERAIL_UI_HTTP_PORT?.trim() || config.ui?.httpPort || DEFAULT_UI_HTTP_PORT;
  const port = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_UI_HTTP_PORT;
}

export function uiUrl(host: string, port: number, scheme: "http" | "https" = "http"): string {
  const displayHost = host === "0.0.0.0" || host === "::" || host === "127.0.0.1" ? "localhost" : host;
  return `${scheme}://${displayHost}:${port}`;
}

export function detectedMachineHost(override?: string): string {
  if (override?.trim()) return override.trim();
  if (process.env.HOMERAIL_PUBLIC_HOST?.trim()) return process.env.HOMERAIL_PUBLIC_HOST.trim();
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (!addresses || isVirtualInterfaceName(name)) continue;
    for (const address of addresses) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push({ name, address: address.address });
      }
    }
  }
  const preferred = candidates.find((candidate) => isPreferredLanAddress(candidate.address)) ?? candidates[0];
  return preferred?.address ?? "localhost";
}

export function configuredUiPublicUrl(
  config = loadLocalConfig(),
  bindHost = configuredUiHost(config),
  port = configuredUiPort(config),
  override?: string,
): string {
  if (override?.trim()) return override.trim().replace(/\/+$/, "");
  if (process.env.HOMERAIL_UI_PUBLIC_URL?.trim()) return process.env.HOMERAIL_UI_PUBLIC_URL.trim().replace(/\/+$/, "");
  if (config.ui?.publicUrl?.trim()) return config.ui.publicUrl.trim().replace(/\/+$/, "");
  if (bindHost === "0.0.0.0" || bindHost === "::") return uiUrl(detectedMachineHost(), port, "https");
  return uiUrl(bindHost, port, "https");
}

export function configuredUiHttpPublicUrl(
  config = loadLocalConfig(),
  bindHost = configuredUiHost(config),
  port = configuredUiHttpPort(config),
): string {
  if (bindHost === "0.0.0.0" || bindHost === "::") return uiUrl(detectedMachineHost(), port, "http");
  return uiUrl(bindHost, port, "http");
}

export function configuredAssetRoot(config = loadLocalConfig()): string | undefined {
  const explicit = process.env.HOMERAIL_ASSET_DIR?.trim() || config.assets?.root?.trim();
  if (explicit) return path.resolve(explicit);
  const homeAssetRoot = path.join(getHomerailHome(), "asset");
  return fs.existsSync(homeAssetRoot) ? homeAssetRoot : undefined;
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

function isVirtualInterfaceName(name: string): boolean {
  return /^(?:lo|docker|br-|veth|virbr|tailscale|zt)/i.test(name);
}

function isPreferredLanAddress(address: string): boolean {
  return address.startsWith("192.168.") ||
    address.startsWith("10.") ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(address);
}

export function redactConfig(config: LocalHomeRailConfig): LocalHomeRailConfig & { secrets: Record<string, string> } {
  const secrets = loadLocalSecrets();
  return {
    ...config,
    secrets: Object.fromEntries(Object.keys(secrets).sort().map((key) => [key, "set"])),
  };
}

export function setConfigPathValue(config: LocalHomeRailConfig, key: string, value: unknown): LocalHomeRailConfig {
  const parts = key.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("config key is required");
  let cursor = config as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return config;
}

function mergeConfig(defaults: LocalHomeRailConfig, raw: LocalHomeRailConfig): LocalHomeRailConfig {
  return {
    manager: { ...defaults.manager, ...(raw.manager ?? {}) },
    node: { ...defaults.node, ...(raw.node ?? {}) },
    ui: { ...defaults.ui, ...(raw.ui ?? {}) },
    model: { ...defaults.model, ...(raw.model ?? {}) },
    runtime: { ...defaults.runtime, ...(raw.runtime ?? {}) },
    assets: raw.assets ? { ...raw.assets } : defaults.assets,
  };
}

function writeSecrets(secrets: Record<string, string>): void {
  const filePath = getSecretsPath();
  const lines = Object.entries(secrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
}

function assertPrivateSecretsFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Refusing to load Manager admin token from a non-regular secrets file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Refusing to load Manager admin token from a group/world-accessible secrets file");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Refusing to load Manager admin token from a secrets file owned by another user");
  }
  return stat;
}

function readPrivateSecretsFile(filePath: string): string {
  const before = assertPrivateSecretsFile(filePath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("Refusing to load a secrets file that changed while opening");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

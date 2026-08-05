import {
  spawnSync,
  type ChildProcess,
  type SpawnSyncReturns,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CODEX_BIN = "codex";
const WINDOWS_SHELL_UNSAFE_PATH_PATTERN = /["^&|<>()%!]/;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export interface CodexBinaryResolution {
  command: string;
  requested: string;
  needsShell: boolean;
  probe?: CodexBinaryProbeResult;
}

export interface CodexBinaryProbeResult {
  status: number | null;
  stdout?: string;
}

export interface CodexBinaryResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (filePath: string) => boolean;
  readDirNames?: (directoryPath: string) => string[];
}

export interface CodexCommandRunOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  spawnSyncImpl?: typeof spawnSync;
}

export interface CodexCommandEnvironmentOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
}

export interface CodexProcessTerminateOptions {
  platform?: NodeJS.Platform;
  spawnSyncImpl?: typeof spawnSync;
}

export interface CodexUsableBinaryResolveOptions extends CodexBinaryResolveOptions {
  nodeExecPath?: string;
  runCommand?: (
    command: string,
    args: string[],
  ) => CodexBinaryProbeResult;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return isWindows(platform) ? path.win32 : path.posix;
}

function isPathLike(command: string, platform: NodeJS.Platform): boolean {
  return pathApi(platform).isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function windowsCommandNeedsShell(command: string, platform = process.platform): boolean {
  return isWindows(platform) && /\.(cmd|bat)$/i.test(command);
}

function windowsShellCommandIsSafe(
  command: string,
  platform: NodeJS.Platform,
): boolean {
  return !windowsCommandNeedsShell(command, platform)
    || !WINDOWS_SHELL_UNSAFE_PATH_PATTERN.test(command);
}

export function codexCommandForSpawn(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!windowsShellCommandIsSafe(command, platform)) {
    throw new Error("Codex Windows shim path contains unsupported shell metacharacters");
  }
  if (!windowsCommandNeedsShell(command, platform) || !/\s/.test(command)) return command;
  return `"${command}"`;
}

export function terminateCodexProcess(
  child: ChildProcess,
  needsShell: boolean,
  options: CodexProcessTerminateOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (isWindows(platform) && needsShell && child.pid) {
    const result = (options.spawnSyncImpl ?? spawnSync)(
      "taskkill.exe",
      ["/pid", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.status === 0) return;
  }
  if (!child.killed) child.kill("SIGTERM");
}

function windowsExecutableNames(command: string, platform: NodeJS.Platform): string[] {
  if (!isWindows(platform)) return [command];
  if (/\.(exe|cmd|bat)$/i.test(command)) return [command];
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function pathCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (!isWindows(platform)) return [command];
  const paths = pathApi(platform);
  const parsed = paths.parse(command);
  if (/\.(exe|cmd|bat)$/i.test(parsed.base)) return [command];
  return windowsExecutableNames(parsed.base, platform).map((name) => paths.join(parsed.dir, name));
}

function existingFile(filePath: string, fileExists: (filePath: string) => boolean): string | null {
  try {
    return fileExists(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function defaultFileExists(filePath: string, platform: NodeJS.Platform): boolean {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  if (!isWindows(platform)) fs.accessSync(filePath, fs.constants.X_OK);
  return true;
}

function defaultReadDirNames(directoryPath: string): string[] {
  return fs.readdirSync(directoryPath);
}

function existingDirectoryEntries(
  directoryPath: string,
  readDirNames: (directoryPath: string) => string[],
): string[] {
  try {
    return readDirNames(directoryPath)
      .slice(0, 64)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function pathEnvironmentEntries(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const paths = pathApi(platform);
  const values = isWindows(platform)
    ? Object.entries(env)
      .filter(([key, value]) => key.toLowerCase() === "path" && typeof value === "string")
      .map(([, value]) => value as string)
    : [env.PATH ?? env.Path ?? env.path ?? ""];
  return values.flatMap((value) => value.split(paths.delimiter));
}

function findExecutablesOnPath(command: string, options: Required<CodexBinaryResolveOptions>): string[] {
  const paths = pathApi(options.platform);
  const names = windowsExecutableNames(command, options.platform);
  const found: string[] = [];
  for (const rawDir of pathEnvironmentEntries(options.env, options.platform)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const name of names) {
      const candidate = paths.join(dir, name);
      const existing = existingFile(candidate, options.fileExists);
      if (existing) found.push(existing);
    }
  }
  return found;
}

function codexCandidatesInDirectory(
  directoryPath: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (!directoryPath) return [];
  const paths = pathApi(platform);
  if (!paths.isAbsolute(directoryPath)) return [];
  return pathCandidates(paths.join(directoryPath, DEFAULT_CODEX_BIN), platform);
}

function versionedCodexCandidates(
  root: string,
  childPath: string[],
  options: Required<CodexBinaryResolveOptions>,
): string[] {
  const paths = pathApi(options.platform);
  return existingDirectoryEntries(root, options.readDirNames).flatMap((version) => (
    codexCandidatesInDirectory(paths.join(root, version, ...childPath), options.platform)
  ));
}

function commonCodexCandidates(options: Required<CodexBinaryResolveOptions>): string[] {
  const paths = pathApi(options.platform);
  const home = options.homeDir;
  const candidates: string[] = [];

  const addDirectory = (directoryPath: string | undefined): void => {
    candidates.push(...codexCandidatesInDirectory(directoryPath, options.platform));
  };

  addDirectory(paths.join(home, ".codex", "bin"));
  addDirectory(paths.join(home, ".local", "bin"));
  addDirectory(paths.join(home, ".npm-global", "bin"));
  addDirectory(paths.join(home, ".volta", "bin"));
  addDirectory(paths.join(home, ".bun", "bin"));
  addDirectory(paths.join(home, ".asdf", "shims"));
  addDirectory(paths.join(home, ".local", "share", "pnpm"));

  addDirectory(options.env.NVM_BIN);
  addDirectory(options.env.PNPM_HOME);
  addDirectory(options.env.VOLTA_HOME ? paths.join(options.env.VOLTA_HOME, "bin") : undefined);
  addDirectory(options.env.BUN_INSTALL ? paths.join(options.env.BUN_INSTALL, "bin") : undefined);
  const npmPrefix = options.env.npm_config_prefix ?? options.env.NPM_CONFIG_PREFIX;
  addDirectory(npmPrefix
    ? paths.join(npmPrefix, isWindows(options.platform) ? "" : "bin")
    : undefined);

  if (isWindows(options.platform)) {
    const appData = options.env.APPDATA;
    const localAppData = options.env.LOCALAPPDATA;
    if (appData) addDirectory(paths.join(appData, "npm"));
    if (localAppData) {
      addDirectory(paths.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
      addDirectory(paths.join(localAppData, "Microsoft", "WindowsApps"));
      addDirectory(paths.join(localAppData, "pnpm"));
      addDirectory(paths.join(localAppData, "Volta", "bin"));
    }
    addDirectory(paths.join(home, ".volta", "bin"));
  } else {
    if (options.platform === "darwin") {
      addDirectory(paths.join(home, "Library", "pnpm"));
      candidates.push(
        paths.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
        paths.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
      );
    }
    candidates.push("/usr/local/bin/codex", "/usr/bin/codex");
    // Scan every regular user home under /home for common codex locations.
    // This covers NAS / multi-user Linux hosts where HomeRail runs as root
    // (HOME=/root) while codex was installed into a different user's home
    // (e.g. /home/<user>/.npm-global/bin). The same glob also matches the
    // current home, so it is safe to add unconditionally.
    try {
      const homeRoot = "/home";
      const entries = options.readDirNames(homeRoot);
      for (const entry of entries) {
        if (entry === "." || entry === ".." || entry.startsWith(".")) continue;
        const userHome = paths.join(homeRoot, entry);
        addDirectory(paths.join(userHome, ".codex", "bin"));
        addDirectory(paths.join(userHome, ".local", "bin"));
        addDirectory(paths.join(userHome, ".npm-global", "bin"));
        addDirectory(paths.join(userHome, ".volta", "bin"));
        addDirectory(paths.join(userHome, ".bun", "bin"));
        addDirectory(paths.join(userHome, ".asdf", "shims"));
        addDirectory(paths.join(userHome, ".local", "share", "pnpm"));
      }
    } catch {
      // /home may not exist or be unreadable; fall through to standard paths.
    }
    candidates.push(
      ...versionedCodexCandidates(paths.join(home, ".nvm", "versions", "node"), ["bin"], options),
      ...versionedCodexCandidates(
        paths.join(home, ".local", "share", "fnm", "node-versions"),
        ["installation", "bin"],
        options,
      ),
      ...versionedCodexCandidates(
        paths.join(home, ".local", "share", "mise", "installs", "node"),
        ["bin"],
        options,
      ),
      ...versionedCodexCandidates(paths.join(home, ".asdf", "installs", "nodejs"), ["bin"], options),
    );
    if (options.platform === "darwin") {
      candidates.push(...versionedCodexCandidates(
        paths.join(home, "Library", "Application Support", "fnm", "node-versions"),
        ["installation", "bin"],
        options,
      ));
    }
  }

  return Array.from(new Set(candidates));
}

function resolveOptions(options: CodexBinaryResolveOptions): Required<CodexBinaryResolveOptions> {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
    fileExists: options.fileExists ?? ((filePath) => defaultFileExists(filePath, platform)),
    readDirNames: options.readDirNames ?? defaultReadDirNames,
  };
}

function requestedCodexBinary(options: Required<CodexBinaryResolveOptions>, requested?: string): string {
  const values = [requested, options.env.HOMERAIL_CODEX_BIN, options.env.CODEX_BIN_PATH];
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? DEFAULT_CODEX_BIN;
}

export function resolveCodexBinary(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): CodexBinaryResolution | null {
  return resolveCodexBinaryCandidates(requested, resolveOptionsInput)[0] ?? null;
}

export function resolveCodexBinaryCandidates(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): CodexBinaryResolution[] {
  const options = resolveOptions(resolveOptionsInput);
  const trimmed = requestedCodexBinary(options, requested);
  const candidates: string[] = [];

  if (isPathLike(trimmed, options.platform)) {
    for (const candidate of pathCandidates(trimmed, options.platform)) {
      const found = existingFile(candidate, options.fileExists);
      if (found) candidates.push(found);
    }
  } else {
    candidates.push(...findExecutablesOnPath(trimmed, options));
    if (trimmed === DEFAULT_CODEX_BIN) {
      for (const candidate of commonCodexCandidates(options)) {
        const found = existingFile(candidate, options.fileExists);
        if (found) candidates.push(found);
      }
    }
  }

  const seen = new Set<string>();
  return candidates.flatMap((command) => {
    if (!windowsShellCommandIsSafe(command, options.platform)) return [];
    const key = isWindows(options.platform) ? command.toLowerCase() : command;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      command,
      requested: trimmed,
      needsShell: windowsCommandNeedsShell(command, options.platform),
    }];
  });
}

function hasExplicitCodexBinaryRequest(
  requested: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (typeof requested === "string" && requested.trim() && requested.trim() !== DEFAULT_CODEX_BIN) {
    return true;
  }
  return [env.HOMERAIL_CODEX_BIN, env.CODEX_BIN_PATH]
    .some((value) => typeof value === "string" && Boolean(value.trim()));
}

export function resolveUsableCodexBinary(
  requested?: string,
  options: CodexUsableBinaryResolveOptions = {},
): CodexBinaryResolution | null {
  const candidates = resolveCodexBinaryCandidates(requested, options);
  if (candidates.length === 0) return null;

  const env = options.env ?? process.env;
  if (hasExplicitCodexBinaryRequest(requested, env)) {
    return candidates[0] ?? null;
  }

  const runCommand = options.runCommand
    ?? ((command: string, args: string[]) => runCodexCommandSync(command, args, {
      env,
      platform: options.platform,
      nodeExecPath: options.nodeExecPath,
    }));
  let fallbackProbe: CodexBinaryProbeResult | undefined;
  for (const candidate of candidates) {
    const probe = runCommand(candidate.command, ["--version"]);
    const storedProbe = {
      status: probe.status,
      stdout: probe.stdout,
    };
    fallbackProbe ??= storedProbe;
    if (probe.status === 0) {
      return {
        ...candidate,
        probe: storedProbe,
      };
    }
  }
  return candidates[0] && fallbackProbe
    ? { ...candidates[0], probe: fallbackProbe }
    : candidates[0] ?? null;
}

export function redactCodexDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .replace(/([?&](?:access_token|api[_-]?key|password|token)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function codexBinaryDisplayPath(
  command: string,
  resolveOptionsInput: Pick<CodexBinaryResolveOptions, "platform" | "homeDir"> = {},
): string {
  const platform = resolveOptionsInput.platform ?? process.platform;
  const homeDir = resolveOptionsInput.homeDir ?? os.homedir();
  const paths = pathApi(platform);
  let display = command;
  if (paths.isAbsolute(command)) {
    const relative = paths.relative(homeDir, command);
    if (relative && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
      display = `~${paths.sep}${relative}`;
    }
  }
  return redactCodexDiagnosticText(display).slice(0, 512);
}

export function codexBinaryNotFoundMessage(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): string {
  const options = resolveOptions(resolveOptionsInput);
  const trimmed = requestedCodexBinary(options, requested);
  if (!windowsShellCommandIsSafe(trimmed, options.platform)) {
    return "Codex Windows shim path contains unsupported shell metacharacters. Choose a different install path or set HOMERAIL_CODEX_BIN.";
  }
  if (isPathLike(trimmed, options.platform)) {
    return `Codex binary not found at: ${codexBinaryDisplayPath(trimmed, options)}. Install codex or set HOMERAIL_CODEX_BIN.`;
  }
  return "Codex binary not found. Install codex or set HOMERAIL_CODEX_BIN.";
}

export function codexCommandEnvironment(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
  options: CodexCommandEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const directories = [
    isPathLike(command, platform) ? paths.dirname(command) : undefined,
    paths.dirname(options.nodeExecPath ?? process.execPath),
    ...pathEnvironmentEntries(source, platform),
  ].filter((directory): directory is string => Boolean(directory));
  const seen = new Set<string>();
  const normalized = directories.filter((directory) => {
    const key = isWindows(platform) ? directory.toLowerCase() : directory;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const env: NodeJS.ProcessEnv = { ...source };
  if (isWindows(platform)) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
  }
  env.PATH = normalized.join(paths.delimiter);
  return env;
}

function failedSpawnResult(error: unknown): SpawnSyncReturns<string> {
  const message = error instanceof Error ? error.message : String(error);
  const result: SpawnSyncReturns<string> = {
    pid: 0,
    output: [null, "", message],
    stdout: "",
    stderr: message,
    status: null,
    signal: null,
  };
  if (error instanceof Error) result.error = error;
  return result;
}

export function runCodexCommandSync(
  command: string,
  args: string[],
  optionsOrTimeout: number | CodexCommandRunOptions = 5_000,
): SpawnSyncReturns<string> {
  const options: CodexCommandRunOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  try {
    return (options.spawnSyncImpl ?? spawnSync)(codexCommandForSpawn(
      command,
      options.platform ?? process.platform,
    ), args, {
      timeout: options.timeoutMs ?? 5_000,
      encoding: "utf-8",
      env: codexCommandEnvironment(command, options.env ?? process.env, {
        platform: options.platform,
        nodeExecPath: options.nodeExecPath,
      }),
      shell: windowsCommandNeedsShell(command, options.platform ?? process.platform),
      windowsHide: true,
    });
  } catch (error) {
    return failedSpawnResult(error);
  }
}

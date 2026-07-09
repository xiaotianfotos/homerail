import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CODEX_BIN = "codex";

export interface CodexBinaryResolution {
  command: string;
  requested: string;
  needsShell: boolean;
}

export interface CodexBinaryResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (filePath: string) => boolean;
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

function defaultFileExists(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function findExecutableOnPath(command: string, options: Required<CodexBinaryResolveOptions>): string | null {
  const pathEnv = options.env.PATH ?? "";
  const paths = pathApi(options.platform);
  const names = windowsExecutableNames(command, options.platform);
  for (const dir of pathEnv.split(paths.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = paths.join(dir, name);
      const found = existingFile(candidate, options.fileExists);
      if (found) return found;
    }
  }
  return null;
}

function commonCodexCandidates(options: Required<CodexBinaryResolveOptions>): string[] {
  const paths = pathApi(options.platform);
  const home = options.homeDir;
  const candidates = [
    paths.join(home, ".codex", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];

  if (isWindows(options.platform)) {
    const appData = options.env.APPDATA;
    const localAppData = options.env.LOCALAPPDATA;
    candidates.push(...pathCandidates(paths.join(home, ".codex", "bin", "codex"), options.platform));
    if (appData) candidates.push(...pathCandidates(paths.join(appData, "npm", "codex"), options.platform));
    if (localAppData) {
      candidates.push(...pathCandidates(paths.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex"), options.platform));
      candidates.push(...pathCandidates(paths.join(localAppData, "Microsoft", "WindowsApps", "codex"), options.platform));
      candidates.push(...pathCandidates(paths.join(localAppData, "pnpm", "codex"), options.platform));
      candidates.push(...pathCandidates(paths.join(localAppData, "Volta", "bin", "codex"), options.platform));
    }
  }

  return Array.from(new Set(candidates));
}

function resolveOptions(options: CodexBinaryResolveOptions): Required<CodexBinaryResolveOptions> {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
    fileExists: options.fileExists ?? defaultFileExists,
  };
}

export function resolveCodexBinary(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): CodexBinaryResolution | null {
  const options = resolveOptions(resolveOptionsInput);
  const effectiveRequested = requested ?? options.env.HOMERAIL_CODEX_BIN ?? options.env.CODEX_BIN_PATH ?? DEFAULT_CODEX_BIN;
  const trimmed = effectiveRequested.trim() || DEFAULT_CODEX_BIN;

  if (isPathLike(trimmed, options.platform)) {
    for (const candidate of pathCandidates(trimmed, options.platform)) {
      const found = existingFile(candidate, options.fileExists);
      if (found) return { command: found, requested: trimmed, needsShell: windowsCommandNeedsShell(found, options.platform) };
    }
    return null;
  }

  for (const candidate of commonCodexCandidates(options)) {
    const found = existingFile(candidate, options.fileExists);
    if (found) return { command: found, requested: trimmed, needsShell: windowsCommandNeedsShell(found, options.platform) };
  }

  const fromPath = findExecutableOnPath(trimmed, options);
  if (fromPath) return { command: fromPath, requested: trimmed, needsShell: windowsCommandNeedsShell(fromPath, options.platform) };
  return null;
}

export function runCodexCommandSync(command: string, args: string[], timeoutMs = 5_000): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    timeout: timeoutMs,
    encoding: "utf-8",
    env: process.env,
    shell: windowsCommandNeedsShell(command),
  });
}

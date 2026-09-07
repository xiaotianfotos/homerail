import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";

import { getHomerailHome } from "../config/env.js";

const FIXED_MANAGER_GIT_CONFIG = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "core.askPass=",
  "diff.external=",
  "credential.helper=",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "submodule.recurse=false",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "protocol.file.allow=never",
] as const;

function disabledHooksDirectory(): string {
  const directory = path.join(getHomerailHome(), "runtime", "disabled-git-hooks");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function managerGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    // Git for Windows rejects Node's `os.devNull` value (`\\.\nul`) as a
    // config-file path, even though Node itself accepts that device spelling.
    // The native DOS device name keeps the global config empty without
    // weakening the fixed `-c` policy below.
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
  };
}

/**
 * Run Git from the Manager without inheriting host Git configuration or
 * repository-configured command hooks. Model-owned worktree bytes are
 * untrusted even when the operation itself is read-only.
 */
export function spawnManagerGitSync(
  workspace: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "env" | "shell"> = {},
): SpawnSyncReturns<string> {
  const configArgs = [
    `core.hooksPath=${disabledHooksDirectory()}`,
    ...FIXED_MANAGER_GIT_CONFIG,
  ].flatMap((entry) => ["-c", entry]);
  return spawnSync("git", [...configArgs, "-C", workspace, ...args], {
    ...options,
    encoding: "utf8",
    env: managerGitEnv(),
    shell: false,
  });
}

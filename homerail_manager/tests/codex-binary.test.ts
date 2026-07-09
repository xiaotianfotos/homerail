import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  codexBinaryNotFoundMessage,
  resolveCodexBinary,
  runCodexCommandSync,
} from "../src/server/codex-binary.js";

function fakeExistingFiles(files: string[]): (filePath: string) => boolean {
  const normalized = new Set(files.map((filePath) => path.win32.normalize(filePath)));
  return (filePath: string) => normalized.has(path.win32.normalize(filePath));
}

describe("resolveCodexBinary", () => {
  it("resolves Windows npm cmd shims from an explicit path and marks them shell-backed", () => {
    const appData = "C:\\Users\\alice\\AppData\\Roaming";
    const requested = path.win32.join(appData, "npm", "codex");
    const shim = path.win32.join(appData, "npm", "codex.cmd");

    expect(resolveCodexBinary(requested, {
      platform: "win32",
      env: {},
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([shim]),
    })).toEqual({
      command: shim,
      requested,
      needsShell: true,
    });
  });

  it("uses HOMERAIL_CODEX_BIN before CODEX_BIN_PATH", () => {
    const preferred = "/custom/codex";
    const fallback = "/fallback/codex";

    expect(resolveCodexBinary(undefined, {
      platform: "darwin",
      env: {
        HOMERAIL_CODEX_BIN: preferred,
        CODEX_BIN_PATH: fallback,
      },
      homeDir: "/Users/alice",
      fileExists: fakeExistingFiles([preferred, fallback]),
    })).toEqual({
      command: preferred,
      requested: preferred,
      needsShell: false,
    });
  });

  it("finds Windows PATH executables with supported extensions", () => {
    const binDir = "C:\\Tools\\Codex";
    const exe = path.win32.join(binDir, "codex.exe");

    expect(resolveCodexBinary("codex", {
      platform: "win32",
      env: { PATH: binDir },
      homeDir: "C:\\Users\\alice",
      fileExists: fakeExistingFiles([exe]),
    })).toEqual({
      command: exe,
      requested: "codex",
      needsShell: false,
    });
  });

  it("includes explicit missing paths in not-found messages", () => {
    expect(codexBinaryNotFoundMessage("/wrong/path/codex", {
      platform: "linux",
      env: {},
      homeDir: "/home/alice",
    })).toBe("Codex binary not found at: /wrong/path/codex. Install codex or set HOMERAIL_CODEX_BIN.");
  });

  it("returns a failed result instead of throwing when spawnSync throws", () => {
    const error = new Error("spawn exploded");
    const result = runCodexCommandSync("C:\\Tools\\codex.cmd", ["--version"], {
      platform: "win32",
      env: {},
      spawnSyncImpl: (() => {
        throw error;
      }) as typeof import("node:child_process").spawnSync,
    });

    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("spawn exploded");
    expect(result.error).toBe(error);
  });
});

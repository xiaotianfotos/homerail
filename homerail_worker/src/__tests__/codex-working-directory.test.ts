import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resolveCodexSandboxModeForTest,
  _resolveCodexWorkingDirectoryForTest,
} from "../agent/codex-appserver.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex DAG working directory", () => {
  it("uses a declared nested Git worktree instead of the workspace container root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "homerail-codex-cwd-"));
    roots.push(workspace);
    mkdirSync(join(workspace, "repository"));
    writeFileSync(join(workspace, "repository", ".git"), "gitdir: /tmp/example\n");
    mkdirSync(join(workspace, "review-evidence"));

    expect(_resolveCodexWorkingDirectoryForTest({
      model: "deepseek-v4-flash",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      workspace,
      workspaceAccess: {
        writable_paths: [],
        readonly_paths: ["repository", "review-evidence"],
      },
    })).toBe(join(workspace, "repository"));
  });

  it("does not select declared paths that escape the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "homerail-codex-cwd-"));
    roots.push(workspace);

    expect(_resolveCodexWorkingDirectoryForTest({
      model: "model",
      apiKey: "test",
      baseUrl: "https://example.test",
      workspace,
      workspaceAccess: { writable_paths: ["../outside"] },
    })).toBe(workspace);
  });

  it("maps an outer read-only DAG workspace to Codex read-only sandboxing", () => {
    expect(_resolveCodexSandboxModeForTest({
      model: "deepseek-v4-flash",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      workspaceAccess: {
        writable_paths: [],
        readonly_paths: ["repository", "review-evidence"],
      },
    })).toBe("read-only");

    expect(_resolveCodexSandboxModeForTest({
      model: "model",
      apiKey: "test",
      baseUrl: "https://example.test",
      workspaceAccess: { writable_paths: ["output"] },
    })).toBe("workspace-write");
  });

  it("honors explicit maximum Codex permissions only for a writable DAG workspace", () => {
    expect(_resolveCodexSandboxModeForTest({
      model: "deepseek-v4-flash",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      codexSandbox: "danger-full-access",
      workspaceAccess: { writable_paths: ["repo"], readonly_paths: ["input"] },
    })).toBe("danger-full-access");

    expect(() => _resolveCodexSandboxModeForTest({
      model: "deepseek-v4-flash",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      codexSandbox: "danger-full-access",
      workspaceAccess: { writable_paths: [], readonly_paths: ["input"] },
    })).toThrow("requires a writable DAG workspace");
  });
});

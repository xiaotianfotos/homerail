import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePath } from "../../platform/paths.js";
import { prepareWorkerWorkspace } from "../workspace-prepare.js";

describe("prepareWorkerWorkspace", () => {
  let homerailHome: string;

  beforeEach(() => {
    homerailHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-workspace-"));
    process.env.HOMERAIL_HOME = homerailHome;
  });

  afterEach(() => {
    delete process.env.HOMERAIL_HOME;
    fs.rmSync(homerailHome, { recursive: true, force: true });
  });

  it("does nothing when no workspace spec is provided", async () => {
    const result = await prepareWorkerWorkspace("run-1/triage", undefined);
    const expectedRoot = normalizePath(path.join(homerailHome, "workspace", "run-1", "triage"));

    expect(result).toEqual({
      root: expectedRoot,
      prepared: false,
    });
    expect(fs.existsSync(result.root)).toBe(false);
  });

  it("clones git workspace into repo under the worker workspace root", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const expectedRoot = normalizePath(path.join(homerailHome, "workspace", "run-1", "triage"));
    const expectedRepoPath = path.join(expectedRoot, "repo");

    const result = await prepareWorkerWorkspace(
      "run-1/triage",
      {
        mode: "git_clone",
        repo_url: "https://example.com/acme/project.git",
        branch: "dev",
      },
      {
        runCommand: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
        },
      },
    );

    expect(result.prepared).toBe(true);
    expect(result.root).toBe(expectedRoot);
    expect(result.repoPath).toBe(expectedRepoPath);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "clone",
          "--branch",
          "dev",
          "--single-branch",
          "https://example.com/acme/project.git",
          expectedRepoPath,
        ],
        cwd: expectedRoot,
      },
    ]);
  });

  it("creates an empty workspace for isolated mode", async () => {
    const result = await prepareWorkerWorkspace("run-1", { mode: "isolated" });
    const expectedRoot = normalizePath(path.join(homerailHome, "workspace", "run-1"));

    expect(result).toEqual({
      root: expectedRoot,
      prepared: true,
    });
    expect(fs.existsSync(result.root)).toBe(true);
  });

  it("creates one run-scoped workspace for shared mode", async () => {
    const result = await prepareWorkerWorkspace("run-shared", { mode: "shared" });
    const expectedRoot = normalizePath(path.join(homerailHome, "workspace", "run-shared"));

    expect(result).toEqual({
      root: expectedRoot,
      prepared: true,
    });
    expect(fs.existsSync(result.root)).toBe(true);
  });

  it("copies an allowed local worktree into repo under the worker workspace root", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-source-worktree-"));
    fs.mkdirSync(path.join(source, ".git"), { recursive: true });
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.mkdirSync(path.join(source, "node_modules", "ignored"), { recursive: true });
    fs.mkdirSync(path.join(source, "dist"), { recursive: true });
    fs.writeFileSync(path.join(source, ".git", "HEAD"), "ref: refs/heads/test\n");
    fs.writeFileSync(path.join(source, "src", "index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(source, "node_modules", "ignored", "pkg.js"), "ignored\n");
    fs.writeFileSync(path.join(source, "dist", "bundle.js"), "ignored\n");

    try {
      const result = await prepareWorkerWorkspace(
        "run-local-copy",
        { mode: "local_copy", source_path: "." },
        { cwd: source },
      );

      expect(result.prepared).toBe(true);
      expect(result.repoPath).toBe(path.join(
        normalizePath(path.join(homerailHome, "workspace", "run-local-copy")),
        "repo",
      ));
      expect(fs.readFileSync(path.join(result.repoPath!, "src", "index.ts"), "utf-8")).toContain("value");
      expect(fs.existsSync(path.join(result.repoPath!, ".git", "HEAD"))).toBe(true);
      expect(fs.existsSync(path.join(result.repoPath!, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(result.repoPath!, "dist"))).toBe(false);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("rejects local_copy source paths outside the allowed local roots", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-allowed-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-outside-root-"));
    try {
      await expect(
        prepareWorkerWorkspace(
          "run-local-copy-denied",
          { mode: "local_copy", source_path: outside },
          { cwd },
        ),
      ).rejects.toThrow("outside allowed roots");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not reclone an existing git workspace", async () => {
    const root = normalizePath(path.join(homerailHome, "workspace", "run-1"));
    const repoPath = path.join(root, "repo");
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await prepareWorkerWorkspace(
      "run-1",
      {
        mode: "git_clone",
        repo_url: "https://example.com/acme/project.git",
        branch: "dev",
      },
      {
        runCommand: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
        },
      },
    );

    expect(result).toEqual({
      root,
      repoPath,
      prepared: true,
    });
    expect(calls).toEqual([]);
  });

  it("rejects unsupported workspace modes", async () => {
    await expect(
      prepareWorkerWorkspace("run-1/triage", { mode: "host_mount" }),
    ).rejects.toThrow("unsupported workspace mode");
  });
});

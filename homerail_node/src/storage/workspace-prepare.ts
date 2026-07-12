import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homerailWorkerWorkspacePath } from "./homerail-home.js";

const execFile = promisify(execFileCb);

export interface WorkspaceSpec {
  mode?: string;
  repo_url?: string;
  branch?: string;
  source_path?: string;
  source_path_env?: string;
  exclude?: string[];
}

export interface PrepareWorkspaceDeps {
  runCommand?: (
    command: string,
    args: string[],
    options: { cwd: string },
  ) => Promise<void>;
  cwd?: string;
  allowedLocalRoots?: string[];
}

export interface PreparedWorkspace {
  root: string;
  repoPath?: string;
  prepared: boolean;
}

function asWorkspaceSpec(value: unknown): WorkspaceSpec | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    mode: typeof raw.mode === "string" ? raw.mode : undefined,
    repo_url: typeof raw.repo_url === "string" ? raw.repo_url : undefined,
    branch: typeof raw.branch === "string" ? raw.branch : undefined,
    source_path: typeof raw.source_path === "string" ? raw.source_path : undefined,
    source_path_env: typeof raw.source_path_env === "string" ? raw.source_path_env : undefined,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.filter((item): item is string => typeof item === "string") : undefined,
  };
}

function assertSafeGitCloneSpec(spec: WorkspaceSpec): { repoUrl: string; branch: string } {
  if (spec.mode !== "git_clone") {
    throw new Error(`unsupported workspace mode: ${spec.mode ?? "<missing>"}`);
  }
  const repoUrl = spec.repo_url ?? "";
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(repoUrl)) {
    throw new Error("workspace.repo_url must be an http(s) URL");
  }
  const branch = spec.branch ?? "dev";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
    throw new Error("workspace.branch contains unsupported characters");
  }
  return { repoUrl, branch };
}

function assertInsideRoot(root: string, child: string): void {
  const rel = path.relative(root, child);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("workspace target escaped workspace root");
  }
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<void> {
  await execFile(command, args, {
    cwd: options.cwd,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

const DEFAULT_LOCAL_COPY_EXCLUDES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  ".DS_Store",
]);

const prepareLocks = new Map<string, Promise<PreparedWorkspace>>();

function splitPathList(value: string | undefined): string[] {
  return (value ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

async function resolveLocalCopySource(
  spec: WorkspaceSpec,
  deps: PrepareWorkspaceDeps,
): Promise<string> {
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const fromEnv = spec.source_path_env ? process.env[spec.source_path_env] : undefined;
  const rawSource = (fromEnv && fromEnv.trim()) || spec.source_path || ".";
  const source = path.resolve(cwd, rawSource);
  const sourceReal = await realpathOrResolve(source);
  const stat = await fs.stat(sourceReal);
  if (!stat.isDirectory()) {
    throw new Error("workspace.local_copy source_path must be a directory");
  }

  const configuredRoots = [
    ...splitPathList(process.env.HOMERAIL_ALLOWED_LOCAL_WORKSPACE_ROOTS),
    ...(deps.allowedLocalRoots ?? []),
    cwd,
  ];
  const allowedRoots = await Promise.all(configuredRoots.map((root) => realpathOrResolve(path.resolve(root))));
  if (!allowedRoots.some((root) => isInside(root, sourceReal))) {
    throw new Error(`workspace.local_copy source_path is outside allowed roots: ${sourceReal}`);
  }
  return sourceReal;
}

async function copyLocalWorkspace(source: string, target: string, spec: WorkspaceSpec): Promise<void> {
  const excludes = new Set([
    ...DEFAULT_LOCAL_COPY_EXCLUDES,
    ...(spec.exclude ?? []).map((item) => item.trim()).filter(Boolean),
  ]);
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (src) => {
      const rel = path.relative(source, src);
      if (!rel) return true;
      return !rel.split(path.sep).some((part) => excludes.has(part));
    },
  });
}

async function prepareWorkerWorkspaceInternal(
  workspaceId: string,
  rawSpec: unknown,
  deps: PrepareWorkspaceDeps = {},
): Promise<PreparedWorkspace> {
  const spec = asWorkspaceSpec(rawSpec);
  const root = homerailWorkerWorkspacePath(workspaceId);
  if (!spec) return { root, prepared: false };

  if (spec.mode === "isolated" || spec.mode === "shared") {
    await fs.mkdir(root, { recursive: true });
    return { root, prepared: true };
  }

  if (spec.mode === "local_copy") {
    const source = await resolveLocalCopySource(spec, deps);
    const repoPath = path.join(root, "repo");
    assertInsideRoot(root, repoPath);
    await fs.mkdir(root, { recursive: true });
    try {
      const stat = await fs.stat(repoPath);
      if (stat.isDirectory()) return { root, repoPath, prepared: true };
    } catch {
      // Copy below.
    }
    await copyLocalWorkspace(source, repoPath, spec);
    return { root, repoPath, prepared: true };
  }

  const { repoUrl, branch } = assertSafeGitCloneSpec(spec);
  const repoPath = path.join(root, "repo");
  assertInsideRoot(root, repoPath);

  await fs.mkdir(root, { recursive: true });
  try {
    const stat = await fs.stat(path.join(repoPath, ".git"));
    if (stat.isDirectory()) {
      return { root, repoPath, prepared: true };
    }
  } catch {
    await fs.rm(repoPath, { recursive: true, force: true });
  }

  const runCommand = deps.runCommand ?? defaultRunCommand;
  await runCommand("git", [
    "clone",
    "--branch",
    branch,
    "--single-branch",
    repoUrl,
    repoPath,
  ], { cwd: root });

  return { root, repoPath, prepared: true };
}

export async function prepareWorkerWorkspace(
  workspaceId: string,
  rawSpec: unknown,
  deps: PrepareWorkspaceDeps = {},
): Promise<PreparedWorkspace> {
  const key = path.resolve(homerailWorkerWorkspacePath(workspaceId));
  const existing = prepareLocks.get(key);
  if (existing) return existing;
  const promise = prepareWorkerWorkspaceInternal(workspaceId, rawSpec, deps)
    .finally(() => prepareLocks.delete(key));
  prepareLocks.set(key, promise);
  return promise;
}

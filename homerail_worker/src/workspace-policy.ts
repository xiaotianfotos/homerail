import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DagWorkspaceAccess } from "homerail-protocol";

export interface WorkspaceSnapshot {
  files: Record<string, string>;
}

export interface WorkspacePolicyResult {
  valid: boolean;
  changed_paths: string[];
  protected_changes: string[];
  unauthorized_changes: string[];
  before_hash: string;
  after_hash: string;
}

// Runtime-owned metadata lives in .homerail-runtime on the host-backed
// workspace mount. It is not model output and must not trip readonly policy
// checks when audit writers append transcripts or raw SDK traces.
const IGNORED_DIRECTORIES = new Set([".git", ".homerail-runtime", "node_modules"]);

function normalizedPolicyPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`workspace policy path must be relative and traversal-free: ${value}`);
  }
  return normalized;
}

function includesPath(prefixes: string[], candidate: string): boolean {
  return prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
}

function digestFiles(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(name).update("\0").update(files[name]).update("\0");
  return hash.digest("hex");
}

export function snapshotWorkspace(root: string, policy: DagWorkspaceAccess): WorkspaceSnapshot {
  const resolvedRoot = realpathSync(path.resolve(root));
  const maxFiles = policy.max_snapshot_files ?? 20_000;
  const files: Record<string, string> = {};
  const visit = (absolute: string, relative: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      if (relative && IGNORED_DIRECTORIES.has(path.posix.basename(relative))) return;
      for (const name of readdirSync(absolute).sort()) {
        const childRelative = relative ? `${relative}/${name}` : name;
        visit(path.join(absolute, name), childRelative.replace(/\\/g, "/"));
      }
      return;
    }
    if (Object.keys(files).length >= maxFiles) throw new Error(`workspace snapshot exceeds max_snapshot_files (${maxFiles})`);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`workspace symlink escapes root: ${relative}`);
      }
      files[relative] = `symlink:${readlinkSync(absolute)}`;
    } else {
      files[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  };
  visit(path.resolve(root), "");
  return { files };
}

export function verifyWorkspacePolicy(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  policy: DagWorkspaceAccess,
): WorkspacePolicyResult {
  const writable = policy.writable_paths.map(normalizedPolicyPath);
  const readonly = (policy.readonly_paths ?? []).map(normalizedPolicyPath);
  const names = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changed = [...names].filter((name) => before.files[name] !== after.files[name]).sort();
  const protectedChanges = changed.filter((name) => includesPath(readonly, name));
  const unauthorizedChanges = changed.filter((name) => !includesPath(writable, name));
  return {
    valid: protectedChanges.length === 0 && unauthorizedChanges.length === 0,
    changed_paths: changed,
    protected_changes: protectedChanges,
    unauthorized_changes: unauthorizedChanges,
    before_hash: digestFiles(before.files),
    after_hash: digestFiles(after.files),
  };
}

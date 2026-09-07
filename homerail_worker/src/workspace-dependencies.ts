import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { DagWorkspaceAccess } from "homerail-protocol";

const DEFAULT_CACHE_ROOT = "/opt/homerail-dependency-cache";

const TRUSTED_PACKAGES = [
  "agent-ui",
  "homerail_protocol",
  "homerail_plugin_sdk",
  "homerail_manager",
  "homerail_worker",
  "homerail_node",
  "homerail_cli",
] as const;

const LOCAL_DEPENDENCIES: Partial<Record<(typeof TRUSTED_PACKAGES)[number], Record<string, string>>> = {
  "agent-ui": {
    "homerail-protocol": "homerail_protocol",
  },
  homerail_plugin_sdk: {
    "homerail-protocol": "homerail_protocol",
  },
  homerail_manager: {
    "homerail-plugin-sdk": "homerail_plugin_sdk",
    "homerail-protocol": "homerail_protocol",
  },
  homerail_worker: {
    "homerail-protocol": "homerail_protocol",
  },
  homerail_node: {
    "homerail-protocol": "homerail_protocol",
  },
  homerail_cli: {
    "homerail-plugin-sdk": "homerail_plugin_sdk",
    "homerail-protocol": "homerail_protocol",
  },
};

export interface WorkspaceDependencyProjection {
  repository?: string;
  projected: string[];
  already_present: string[];
  skipped: Array<{ package: string; reason: string }>;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function regularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function directory(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function followedDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function dependencyMetadata(filePath: string, packageLock: boolean): string | Buffer {
  const content = fs.readFileSync(filePath);
  try {
    const parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
    delete parsed.version;
    if (packageLock && typeof parsed.packages === "object" && parsed.packages !== null) {
      const packages = parsed.packages as Record<string, unknown>;
      for (const workspacePath of ["", "../homerail_protocol", "../homerail_plugin_sdk"]) {
        const metadata = packages[workspacePath];
        if (typeof metadata === "object" && metadata !== null) {
          delete (metadata as Record<string, unknown>).version;
        }
      }
    }
    return stableJson(parsed);
  } catch {
    return content;
  }
}

function dependencyFingerprint(packageRoot: string): string | undefined {
  const packageJson = path.join(packageRoot, "package.json");
  const packageLock = path.join(packageRoot, "package-lock.json");
  if (!regularFile(packageJson) || !regularFile(packageLock)) return undefined;
  return createHash("sha256")
    .update(dependencyMetadata(packageJson, false))
    .update("\0")
    .update(dependencyMetadata(packageLock, true))
    .digest("hex");
}

function projectionMarkerMatches(targetModules: string, packageName: string, fingerprint: string): boolean {
  if (!directory(targetModules)) return false;
  const marker = path.join(targetModules, ".homerail-dependency-projection.json");
  if (!regularFile(marker)) return false;
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>;
    return value.version === 1 && value.package === packageName && value.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

function repositoryFromAccess(
  workspace: string,
  access: DagWorkspaceAccess | undefined,
): string | undefined {
  if (!access || access.writable_paths.length === 0) return undefined;
  const workspaceRoot = path.resolve(workspace);
  for (const declared of access.writable_paths) {
    const candidate = path.resolve(workspaceRoot, declared);
    if (!isInside(workspaceRoot, candidate)) continue;
    if (regularFile(path.join(candidate, ".git")) || directory(path.join(candidate, ".git"))) {
      return candidate;
    }
  }
  return undefined;
}

function symlinkPath(source: string, target: string, forceDirectory = false): void {
  const type = forceDirectory || fs.statSync(source).isDirectory()
    ? (process.platform === "win32" ? "junction" : "dir")
    : "file";
  fs.symlinkSync(source, target, type);
}

function populateFacade(
  repository: string,
  packageName: (typeof TRUSTED_PACKAGES)[number],
  cachePackageRoot: string,
  targetPackageRoot: string,
  fingerprint: string,
): void {
  const cacheModules = path.join(cachePackageRoot, "node_modules");
  const targetModules = path.join(targetPackageRoot, "node_modules");
  fs.mkdirSync(targetModules, { mode: 0o755 });
  try {
    for (const entry of fs.readdirSync(cacheModules).sort()) {
      symlinkPath(path.join(cacheModules, entry), path.join(targetModules, entry));
    }
    for (const [dependency, localPackage] of Object.entries(LOCAL_DEPENDENCIES[packageName] ?? {})) {
      const target = path.join(targetModules, dependency);
      fs.rmSync(target, { recursive: true, force: true });
      const localRoot = path.join(repository, localPackage);
      if (!directory(localRoot)) {
        throw new Error(`local dependency ${localPackage} is unavailable`);
      }
      symlinkPath(localRoot, target, true);
    }
    fs.writeFileSync(
      path.join(targetModules, ".homerail-dependency-projection.json"),
      `${JSON.stringify({ version: 1, package: packageName, fingerprint })}\n`,
      { mode: 0o444 },
    );
  } catch (error) {
    fs.rmSync(targetModules, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Project immutable, image-owned dependencies into one writable Git worktree.
 * Dependency-relevant normalized package metadata must exactly match the
 * metadata baked into the Worker image. Release-only versions are ignored; a
 * dependency change never receives stale dependencies and never causes a
 * network install from an agent turn.
 */
export function materializeTrustedWorkspaceDependencies(
  workspace: string,
  access: DagWorkspaceAccess | undefined,
  cacheRoot = process.env.HOMERAIL_WORKSPACE_DEPENDENCY_CACHE_ROOT?.trim() || DEFAULT_CACHE_ROOT,
): WorkspaceDependencyProjection {
  const result: WorkspaceDependencyProjection = {
    projected: [],
    already_present: [],
    skipped: [],
  };
  const repository = repositoryFromAccess(workspace, access);
  if (!repository) return result;
  result.repository = repository;

  for (const packageName of TRUSTED_PACKAGES) {
    const targetPackageRoot = path.join(repository, packageName);
    const cachePackageRoot = path.join(cacheRoot, packageName);
    if (!directory(targetPackageRoot)) {
      result.skipped.push({ package: packageName, reason: "package directory is absent" });
      continue;
    }
    if (!followedDirectory(cachePackageRoot) || !followedDirectory(path.join(cachePackageRoot, "node_modules"))) {
      result.skipped.push({ package: packageName, reason: "trusted dependency cache is absent" });
      continue;
    }
    const targetFingerprint = dependencyFingerprint(targetPackageRoot);
    const cacheFingerprint = dependencyFingerprint(cachePackageRoot);
    if (!targetFingerprint || !cacheFingerprint || targetFingerprint !== cacheFingerprint) {
      result.skipped.push({ package: packageName, reason: "package metadata does not match the trusted cache" });
      continue;
    }

    const targetModules = path.join(targetPackageRoot, "node_modules");
    if (fs.existsSync(targetModules)) {
      if (projectionMarkerMatches(targetModules, packageName, targetFingerprint)) {
        result.already_present.push(packageName);
      } else {
        result.skipped.push({ package: packageName, reason: "existing node_modules is not a trusted projection" });
      }
      continue;
    }
    populateFacade(repository, packageName, cachePackageRoot, targetPackageRoot, targetFingerprint);
    result.projected.push(packageName);
  }
  return result;
}

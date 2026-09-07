import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materializeTrustedWorkspaceDependencies } from "../workspace-dependencies.js";

const PACKAGES = [
  "agent-ui",
  "homerail_protocol",
  "homerail_plugin_sdk",
  "homerail_manager",
  "homerail_worker",
  "homerail_node",
  "homerail_cli",
] as const;

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-workspace-deps-"));
  roots.push(root);
  return root;
}

function writePackage(root: string, name: string, version = "1"): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name, version })}\n`);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name, lockfileVersion: 3 })}\n`);
}

function fixture(): { workspace: string; repository: string; cache: string } {
  const root = temporaryRoot();
  const workspace = path.join(root, "workspace");
  const repository = path.join(workspace, "workers", "item-1");
  const cache = path.join(root, "cache");
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, ".git"), "gitdir: /trusted/worktree\n");
  for (const packageName of PACKAGES) {
    writePackage(path.join(repository, packageName), packageName);
    const linkedCache = packageName === "homerail_protocol" || packageName === "homerail_worker";
    const cachePackage = linkedCache
      ? path.join(root, "cache-backing", packageName)
      : path.join(cache, packageName);
    writePackage(cachePackage, packageName);
    fs.mkdirSync(path.join(cachePackage, "node_modules", "typescript"), { recursive: true });
    fs.writeFileSync(path.join(cachePackage, "node_modules", "typescript", "package.json"), "{}\n");
    fs.writeFileSync(path.join(cachePackage, "node_modules", ".package-lock.json"), "{}\n");
    if (linkedCache) {
      fs.mkdirSync(cache, { recursive: true });
      fs.symlinkSync(
        cachePackage,
        path.join(cache, packageName),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
  return { workspace, repository, cache };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted workspace dependency projection", () => {
  it("projects matching immutable caches and binds local packages to the current worktree", () => {
    const { workspace, repository, cache } = fixture();
    const result = materializeTrustedWorkspaceDependencies(workspace, {
      writable_paths: ["workers/item-1"],
      readonly_paths: [],
    }, cache);

    expect(result.projected).toEqual(PACKAGES);
    expect(result.skipped).toEqual([]);
    expect(fs.realpathSync(path.join(repository, "homerail_manager", "node_modules", "typescript")))
      .toBe(fs.realpathSync(path.join(cache, "homerail_manager", "node_modules", "typescript")));
    expect(fs.realpathSync(path.join(repository, "homerail_manager", "node_modules", "homerail-protocol")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_protocol")));
    expect(fs.realpathSync(path.join(repository, "homerail_manager", "node_modules", "homerail-plugin-sdk")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_plugin_sdk")));
    expect(fs.realpathSync(path.join(repository, "agent-ui", "node_modules", "homerail-protocol")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_protocol")));
    expect(fs.realpathSync(path.join(repository, "homerail_node", "node_modules", "homerail-protocol")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_protocol")));
    expect(fs.realpathSync(path.join(repository, "homerail_cli", "node_modules", "homerail-protocol")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_protocol")));
    expect(fs.realpathSync(path.join(repository, "homerail_cli", "node_modules", "homerail-plugin-sdk")))
      .toBe(fs.realpathSync(path.join(repository, "homerail_plugin_sdk")));
  });

  it("fails closed on changed metadata and an untrusted existing dependency tree", () => {
    const { workspace, repository, cache } = fixture();
    fs.writeFileSync(
      path.join(repository, "homerail_manager", "package-lock.json"),
      `${JSON.stringify({ name: "homerail_manager", lockfileVersion: 3, changed: true })}\n`,
    );
    fs.mkdirSync(path.join(repository, "homerail_worker", "node_modules"));
    fs.writeFileSync(path.join(repository, "homerail_worker", "node_modules", "owned.txt"), "keep\n");

    const result = materializeTrustedWorkspaceDependencies(workspace, {
      writable_paths: ["workers/item-1"],
      readonly_paths: [],
    }, cache);

    expect(result.skipped).toContainEqual({
      package: "homerail_manager",
      reason: "package metadata does not match the trusted cache",
    });
    expect(result.skipped).toContainEqual({
      package: "homerail_worker",
      reason: "existing node_modules is not a trusted projection",
    });
    expect(fs.existsSync(path.join(repository, "homerail_manager", "node_modules"))).toBe(false);
    expect(fs.readFileSync(path.join(repository, "homerail_worker", "node_modules", "owned.txt"), "utf8"))
      .toBe("keep\n");
  });

  it("does nothing for a read-only dispatch", () => {
    const { workspace, repository, cache } = fixture();
    const result = materializeTrustedWorkspaceDependencies(workspace, {
      writable_paths: [],
      readonly_paths: ["workers/item-1"],
    }, cache);

    expect(result).toEqual({ projected: [], already_present: [], skipped: [] });
    expect(fs.existsSync(path.join(repository, "homerail_protocol", "node_modules"))).toBe(false);
  });

  it("ignores release-only package versions while retaining the dependency fence", () => {
    const { workspace, repository, cache } = fixture();
    writePackage(path.join(repository, "homerail_protocol"), "homerail_protocol", "2");

    const result = materializeTrustedWorkspaceDependencies(workspace, {
      writable_paths: ["workers/item-1"],
      readonly_paths: [],
    }, cache);

    expect(result.projected).toContain("homerail_protocol");
  });
});

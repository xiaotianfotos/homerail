import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { e2eFixDigest, immutableE2eFixFile } from "./e2e-fix-candidates.js";
import { E2E_FIX_STAGES, type E2eFixStage } from "../orchestration/e2e-fix-workflow.js";

export interface E2eFixFrozenRuntime {
  directory: string;
  sha256: string;
  node: string;
  bootstrap: string;
}
interface RuntimeEntry { path: string; sha256?: string; executable?: boolean; link?: string }

/** Copy the built Manager, production dependency closure and Node binary.
 * Per-package internal links preserve nested versions without referring to the
 * live installation. No npm scripts, downloads or candidate code execute here. */
export function freezeE2eFixRuntime(directory: string,
  managerPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")): E2eFixFrozenRuntime {
  if (process.platform !== "linux" || !path.isAbsolute(directory)) throw new Error("frozen E2E Fix runtime requires an absolute Linux directory");
  if (fs.existsSync(directory)) throw new Error("runtime destination already exists; reuse its pinned manifest instead");
  const source = fs.realpathSync(managerPackage);
  if (directory === source || directory.startsWith(source + path.sep)) throw new Error("runtime destination must be outside its source package");
  const temporary = directory + "." + randomUUID() + ".tmp";
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const inventory: RuntimeEntry[] = [];
  const packages = new Map<string, string>();
  let bytes = 0;
  const put = (relative: string, content: Buffer, executable = false) => {
    bytes += content.length;
    if (bytes > 512 * 1024 * 1024 || inventory.length >= 20000) throw new Error("runtime snapshot exceeds size budget");
    const file = path.join(temporary, relative);
    immutableE2eFixFile(file, content);
    // Some storage ACLs add owner-execute even when open requested 0600.
    // Normalize both kinds before recording/publishing the inventory.
    fs.chmodSync(file, executable ? 0o700 : 0o600);
    inventory.push({ path: relative, sha256: e2eFixDigest(content), executable });
  };
  const copy = (from: string, to: string) => {
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(from).sort()) {
        if (["node_modules", ".git"].includes(name)) continue;
        if (name === ".env" || name.startsWith(".env.")) throw new Error("private environment file in runtime package");
        copy(path.join(from, name), to + "/" + name);
      }
    } else if (stat.isFile()) put(to, fs.readFileSync(from), Boolean(stat.mode & 0o111));
    else throw new Error("runtime package contains unsupported special file or link");
  };
  const resolveDependency = (from: string, name: string): string | undefined => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error("unsafe runtime dependency name");
    const require = createRequire(path.join(from, "package.json"));
    // Some installed npm packages share a builtin name (e.g. buffer). Ask for
    // ordinary package search roots rather than resolving the builtin itself.
    for (const root of require.resolve.paths("__homerail_runtime_dependency__") ?? []) {
      const candidate = path.join(root, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    }
  };
  const visit = (from: string): string => {
    const existing = packages.get(from); if (existing) return existing;
    const target = "packages/" + e2eFixDigest(from).slice(0, 24);
    packages.set(from, target);
    const pkg = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8"));
    if (from === source || ["homerail-protocol", "homerail-plugin-sdk"].includes(pkg.name)) {
      copy(path.join(from, "package.json"), target + "/package.json");
      copy(path.join(from, "dist"), target + "/dist");
    } else copy(from, target);
    const optional = pkg.optionalDependencies ?? {};
    const dependencies = { ...(pkg.peerDependencies ?? {}), ...(pkg.dependencies ?? {}), ...optional };
    for (const name of Object.keys(dependencies).sort()) {
      const resolved = resolveDependency(from, name);
      if (!resolved) {
        if (Object.prototype.hasOwnProperty.call(optional, name) || pkg.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`missing production runtime dependency: ${name}`);
      }
      const child = visit(resolved);
      const location = target + "/node_modules/" + name;
      const link = path.relative(path.dirname(location), child);
      fs.mkdirSync(path.dirname(path.join(temporary, location)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(link, path.join(temporary, location));
      inventory.push({ path: location, link });
    }
    return target;
  };
  try {
    const root = visit(source);
    const entry = root + "/dist/runtime/e2e-fix-stage-cli.js";
    if (!fs.existsSync(path.join(temporary, entry))) throw new Error("build the Manager before freezing runtime");
    put("node", fs.readFileSync(process.execPath), true);
    put("bootstrap.mjs", fs.readFileSync(new URL("./e2e-fix-runtime-bootstrap.mjs", import.meta.url)));
    inventory.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = JSON.stringify({ version: 1, entry, node_version: process.version, entries: inventory });
    immutableE2eFixFile(path.join(temporary, "manifest.json"), manifest);
    // Persist each directory, including the dependency links, before publishing.
    const syncDirectories = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) syncDirectories(path.join(dir, e.name));
      const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    syncDirectories(temporary);
    fs.renameSync(temporary, directory);
    const fd = fs.openSync(path.dirname(directory), "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { directory, sha256: e2eFixDigest(manifest), node: path.join(directory, "node"), bootstrap: path.join(directory, "bootstrap.mjs") };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function frozenE2eFixStageCommands(runtime: E2eFixFrozenRuntime, taskDirectory: string): Record<E2eFixStage, string[]> {
  if (!path.isAbsolute(taskDirectory) || !/^[a-f0-9]{64}$/.test(runtime.sha256)) throw new Error("pin runtime digest and absolute task directory");
  return Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage,
    [runtime.node, runtime.bootstrap, runtime.sha256, taskDirectory, stage]])) as Record<E2eFixStage, string[]>;
}

/** Recovery loads the previously pinned digest; it never follows a live build. */
export function loadFrozenE2eFixRuntime(directory: string, sha256: string): E2eFixFrozenRuntime {
  if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(sha256)
    || e2eFixDigest(fs.readFileSync(path.join(directory, "manifest.json"))) !== sha256) throw new Error("frozen runtime manifest identity mismatch");
  return { directory, sha256, node: path.join(directory, "node"), bootstrap: path.join(directory, "bootstrap.mjs") };
}

export function frozenE2eFixHostCodexCommands(runtime: E2eFixFrozenRuntime, taskDirectory: string) {
  // Apply the same path/digest validation as program stages.
  frozenE2eFixStageCommands(runtime, taskDirectory);
  return Object.fromEntries(["plan", "judge_candidate", "judge_ci"].map(role => [role,
    [runtime.node, runtime.bootstrap, runtime.sha256, taskDirectory, "host-codex", role]])) as Record<"plan" | "judge_candidate" | "judge_ci", string[]>;
}

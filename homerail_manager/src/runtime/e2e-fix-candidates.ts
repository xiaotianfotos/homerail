import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { E2eFixCandidateSchema, type E2eFixCandidate } from "homerail-protocol";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const revision = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const e2eFixDigest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function e2eFixPath(name: string): string {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/.test(name)
    || name.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("unsafe repository path");
  return name;
}
export function immutableE2eFixFile(file: string, bytes: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temporary, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { fs.unlinkSync(temporary); }
  if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(Buffer.from(bytes))) throw new Error("immutable E2E Fix artifact changed");
  const dir = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export interface E2eFixEdit { path: string; old: string; new: string }
export class E2eFixProposalError extends Error {}
interface TreeEntry { path: string; mode: string; sha: string; bytes: Buffer }

/** Host-owned Git object store. No checkout, hooks, index or branches in the
 * caller's repository are changed. Models never get this directory mounted. */
export class E2eFixCandidates {
  readonly gitDir: string;
  constructor(readonly directory: string) {
    if (process.platform !== "linux") throw new Error("E2E Fix candidate custody requires Linux");
    if (!path.isAbsolute(directory)) throw new Error("candidate store requires an absolute directory");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || (fs.statSync(directory).mode & 0o077)) throw new Error("candidate store must be private");
    this.gitDir = path.join(directory, "objects.git");
  }
  private git(args: string[], input?: string | Buffer, extraEnv: NodeJS.ProcessEnv = {}): Buffer {
    const result = spawnSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
      "--git-dir", this.gitDir, ...args], {
      input, encoding: null, timeout: 30000, maxBuffer: MAX_SNAPSHOT_BYTES * 2,
      env: { PATH: process.env.PATH, HOME: this.directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extraEnv },
    });
    if (result.error || result.status !== 0) throw new Error(`candidate git ${args[0]} failed: ${String(result.stderr || result.error).slice(-1000)}`);
    return result.stdout;
  }
  seed(sourceRepository: string, base: string): void {
    if (!path.isAbsolute(sourceRepository) || !revision.test(base)) throw new Error("pin source repository and base");
    const seed = JSON.stringify({ source: fs.realpathSync(sourceRepository), base });
    immutableE2eFixFile(path.join(this.directory, "seed.json"), seed);
    if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) this.git(["init", "--bare"]);
    // Fetch only the frozen base; never follow a moving branch or execute a
    // checkout filter. A repeated fetch writes the same content-addressed objects.
    this.git(["fetch", "--no-tags", "--no-write-fetch-head", sourceRepository, base]);
    if (this.git(["rev-parse", `${base}^{commit}`]).toString().trim() !== base) throw new Error("base is not a commit");
  }
  entries(tree: string): TreeEntry[] {
    if (!revision.test(tree)) throw new Error("invalid tree identity");
    const rows = this.git(["ls-tree", "-rz", tree]).toString().split("\0").filter(Boolean);
    if (rows.length > 10000) throw new Error("candidate has too many files");
    const entries: TreeEntry[] = rows.map(row => {
      const tab = row.indexOf("\t");
      const [mode, type, sha] = row.slice(0, tab).split(" ");
      const name = e2eFixPath(row.slice(tab + 1));
      if (type !== "blob" || !["100644", "100755"].includes(mode) || !revision.test(sha)) throw new Error("candidate supports regular files only");
      return { path: name, mode, sha, bytes: Buffer.alloc(0) };
    });
    if (!entries.length) return entries;
    const batch = this.git(["cat-file", "--batch"], entries.map(e => e.sha).join("\n") + "\n");
    let offset = 0; let total = 0;
    for (const entry of entries) {
      const end = batch.indexOf(10, offset);
      const [sha, type, length] = batch.subarray(offset, end).toString().split(" ");
      const size = Number(length); total += size;
      if (end < offset || sha !== entry.sha || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || total > MAX_SNAPSHOT_BYTES) throw new Error("invalid or excessive candidate blob");
      entry.bytes = batch.subarray(end + 1, end + 1 + size);
      offset = end + size + 2;
      if (entry.bytes.length !== size || batch[offset - 1] !== 10) throw new Error("truncated candidate blob");
    }
    if (offset !== batch.length) throw new Error("unexpected candidate blob bytes");
    return entries;
  }
  source(head: string, allowedPaths: string[]): Record<string, string> {
    const entries = new Map(this.entries(head).map(e => [e.path, e]));
    return Object.fromEntries(allowedPaths.map(name => {
      e2eFixPath(name);
      const bytes = entries.get(name)?.bytes ?? Buffer.alloc(0);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes) || text.includes("\0")) throw new Error("model edits require UTF-8 source");
      return [name, text];
    }));
  }
  verifyCandidate(candidate: E2eFixCandidate): void {
    E2eFixCandidateSchema.parse(candidate);
    const seed = JSON.parse(fs.readFileSync(path.join(this.directory, "seed.json"), "utf8"));
    if (candidate.base !== seed.base) throw new Error("candidate base differs from frozen seed");
    if (this.git(["rev-parse", `${candidate.head}^{tree}`]).toString().trim() !== candidate.tree) throw new Error("candidate head/tree mismatch");
    this.git(["merge-base", "--is-ancestor", candidate.base, candidate.head]);
    if (candidate.head !== candidate.base) {
      const stored = JSON.parse(fs.readFileSync(path.join(this.directory, "candidates", `${candidate.round}.json`), "utf8"));
      if (JSON.stringify(E2eFixCandidateSchema.parse(stored.candidate)) !== JSON.stringify(E2eFixCandidateSchema.parse(candidate))) throw new Error("candidate identity differs from captured record");
    }
  }
  capture(input: {
    task_id: string; root_run_id: string; round: number; plan_sha256: string; policy_sha256: string;
    repo: string; base: string; parent: string; allowed_paths: string[]; protected_paths: string[];
    summary: string; edits: E2eFixEdit[];
  }): E2eFixCandidate {
    if (!revision.test(input.parent) || !revision.test(input.base) || !Number.isSafeInteger(input.round) || input.round < 1) throw new Error("invalid candidate identity");
    if (input.base !== JSON.parse(fs.readFileSync(path.join(this.directory, "seed.json"), "utf8")).base) throw new Error("candidate base differs from frozen seed");
    this.git(["merge-base", "--is-ancestor", input.base, input.parent]);
    if (!input.allowed_paths.length || new Set(input.allowed_paths).size !== input.allowed_paths.length) throw new Error("invalid write scope");
    [...input.allowed_paths, ...input.protected_paths].forEach(e2eFixPath);
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 20
      || Buffer.byteLength(JSON.stringify(input.edits)) > 1_000_000) throw new E2eFixProposalError("invalid patch size");
    const current = new Map(this.entries(input.parent).map(e => [e.path, e]));
    const seen = new Set<string>();
    const replacements: Array<{ path: string; bytes: string; mode: string }> = [];
    for (const edit of input.edits) {
      try { e2eFixPath(edit.path); } catch { throw new E2eFixProposalError("unsafe repository path in proposal"); }
      if (!input.allowed_paths.includes(edit.path) || seen.has(edit.path)
        || input.protected_paths.some(p => edit.path === p || edit.path.startsWith(p + "/"))) throw new E2eFixProposalError("patch exceeds frozen scope");
      seen.add(edit.path);
      if (typeof edit.old !== "string" || typeof edit.new !== "string" || edit.old.includes("\0") || edit.new.includes("\0") || edit.old === edit.new) throw new E2eFixProposalError("invalid or unchanged edit");
      const previous = current.get(edit.path);
      const source = previous?.bytes.toString("utf8") ?? "";
      if (previous && !Buffer.from(source).equals(previous.bytes)) throw new Error("patch targets non-UTF-8 source");
      if (previous ? !edit.old || source.indexOf(edit.old) < 0 || source.indexOf(edit.old) !== source.lastIndexOf(edit.old) : edit.old !== "") throw new E2eFixProposalError("stale or ambiguous patch");
      replacements.push({ path: edit.path, mode: previous?.mode ?? "100644", bytes: previous ? source.replace(edit.old, () => edit.new) : edit.new });
    }
    const index = path.join(this.directory, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    let tree: string;
    try {
      this.git(["read-tree", input.parent], undefined, env);
      for (const entry of replacements) {
        const blob = this.git(["hash-object", "-w", "--stdin"], entry.bytes).toString().trim();
        this.git(["update-index", "--add", "--cacheinfo", entry.mode, blob, entry.path], undefined, env);
      }
      tree = this.git(["write-tree"], undefined, env).toString().trim();
    } finally { fs.rmSync(index, { force: true }); fs.rmSync(index + ".lock", { force: true }); }
    const date = `${Number(this.git(["show", "-s", "--format=%ct", input.base]).toString().trim()) + input.round} +0000`;
    const message = `E2E Fix: ${input.summary.slice(0, 200)}\n\nTask: ${input.task_id}\nRoot: ${input.root_run_id}\nRound: ${input.round}\nPlan: ${input.plan_sha256}\nPolicy: ${input.policy_sha256}\n`;
    const head = this.git(["commit-tree", tree, "-p", input.parent], message, {
      GIT_AUTHOR_NAME: "E2E Fix", GIT_AUTHOR_EMAIL: "e2e-fix@localhost.invalid", GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "E2E Fix", GIT_COMMITTER_EMAIL: "e2e-fix@localhost.invalid", GIT_COMMITTER_DATE: date,
    }).toString().trim();
    const candidate = E2eFixCandidateSchema.parse({ task_id: input.task_id, root_run_id: input.root_run_id, round: input.round,
      plan_sha256: input.plan_sha256, policy_sha256: input.policy_sha256, repo: input.repo, base: input.base, head, tree });
    immutableE2eFixFile(path.join(this.directory, "candidates", `${input.round}.json`), JSON.stringify({ candidate, parent: input.parent, edits_sha256: e2eFixDigest(JSON.stringify(input.edits)) }));
    return candidate;
  }
  snapshot(tree: string): string {
    if (!revision.test(tree)) throw new Error("invalid tree identity");
    const destination = path.join(this.directory, "snapshots", tree);
    if (fs.existsSync(destination)) { this.verifySnapshot(tree, destination); return destination; }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    fs.mkdirSync(temporary, { recursive: true, mode: 0o755 });
    try {
      for (const entry of this.entries(tree)) {
        const file = path.join(temporary, entry.path);
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
        const fd = fs.openSync(file, "wx", entry.mode === "100755" ? 0o555 : 0o444);
        try { fs.writeFileSync(fd, entry.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      try { fs.renameSync(temporary, destination); }
      catch (error) { if (!fs.existsSync(destination)) throw error; }
      this.verifySnapshot(tree, destination);
      return destination;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  verifySnapshot(tree: string, directory: string): void {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("snapshot must be a real directory");
    const entries = new Map(this.entries(tree).map(e => [e.path, e]));
    const seen = new Set<string>();
    const walk = (relative: string) => {
      for (const name of fs.readdirSync(path.join(directory, relative))) {
        const key = relative ? relative + "/" + name : name;
        const file = path.join(directory, key); const stat = fs.lstatSync(file);
        if (stat.isDirectory()) {
          if (![...entries.keys()].some(p => p.startsWith(key + "/"))) throw new Error("unexpected snapshot directory");
          walk(key);
        } else {
          const entry = entries.get(key);
          if (!stat.isFile() || !entry || !fs.readFileSync(file).equals(entry.bytes)
            || Boolean(stat.mode & 0o111) !== (entry.mode === "100755")) throw new Error("snapshot inventory/content changed");
          seen.add(key);
        }
      }
    };
    walk("");
    if (seen.size !== entries.size) throw new Error("snapshot file missing");
  }
}

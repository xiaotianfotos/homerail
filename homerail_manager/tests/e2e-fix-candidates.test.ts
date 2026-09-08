import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { E2eFixCandidates } from "../src/runtime/e2e-fix-candidates.js";
import { projectE2eFixReviewContext } from "../src/runtime/e2e-fix-review-context.js";

describe.skipIf(process.platform !== "linux")("E2E Fix frozen candidates", () => {
  let root: string; let repo: string; let store: E2eFixCandidates; let base: string;
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-candidates-")); repo = path.join(root, "source");
    fs.mkdirSync(repo); git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(repo, "sum.cjs"), "module.exports = (a,b) => a-b;\n");
    fs.mkdirSync(path.join(repo, "tests", "nested"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests", "frozen.cjs"), "trusted test\n");
    fs.writeFileSync(path.join(repo, "tests", "nested", "executable.sh"), "#!/bin/sh\nprintf 'executable preserved\\n'\n", { mode: 0o755 });
    git("add", "."); git("update-index", "--chmod=+x", "tests/nested/executable.sh");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base"); base = git("rev-parse", "HEAD");
    store = new E2eFixCandidates(path.join(root, "private")); store.seed(repo, base);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  function request() {
    return { task_id: "issue-1", root_run_id: "root", round: 1, plan_sha256: "a".repeat(64), policy_sha256: "b".repeat(64),
      repo: "fixture/repo", base, parent: base, allowed_paths: ["sum.cjs"], protected_paths: ["tests"], summary: "add correctly",
      edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" }] };
  }
  it("creates a real deterministic commit without changing a dirty caller checkout/index", () => {
    fs.writeFileSync(path.join(repo, "untracked"), "keep me"); fs.appendFileSync(path.join(repo, "sum.cjs"), "// local edit\n");
    const before = git("status", "--porcelain");
    const candidate = store.capture(request());
    expect(store.capture(request())).toEqual(candidate);
    expect(candidate.head).not.toBe(base);
    expect(store.source(candidate.head, ["sum.cjs"])["sum.cjs"]).toBe("module.exports = (a,b) => a+b;\n");
    expect(git("rev-parse", "HEAD")).toBe(base); expect(git("status", "--porcelain")).toBe(before);
  });
  it("retains previous candidates and rejects a different proposal for the same round", () => {
    const first = store.capture(request());
    const second = store.capture({ ...request(), round: 2, parent: first.head, edits: [{ path: "sum.cjs", old: "a+b", new: "Number(a)+Number(b)" }] });
    expect(second.head).not.toBe(first.head);
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "a-b", new: "a*b" }] })).toThrow(/immutable/);
    expect(store.source(first.head, ["sum.cjs"])["sum.cjs"]).toContain("a+b");
  });
  it("projects large unchanged source while preserving every review concern and the complete issue", () => {
    fs.writeFileSync(path.join(repo, "sum.cjs"), "// unchanged context\n".repeat(2500) + "module.exports = (a,b) => a-b;\n");
    git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "large base"); base = git("rev-parse", "HEAD");
    store = new E2eFixCandidates(path.join(root, "large-private")); store.seed(repo, base);
    const first = store.capture(request());
    const candidate = store.capture({ ...request(), round: 2, parent: first.head,
      allowed_paths: ["sum.cjs", "new.cjs"], edits: [{ path: "new.cjs", old: "", new: "module.exports = 'new file';\n" }] });
    const evidence = { candidate, sources: store.source(candidate.head, ["sum.cjs", "new.cjs"]),
      issue: { body: "Preserve signed numbers, exact scope and all requirements" },
      reports: [{ vote: "request_changes", finding_ids: ["concern"] }], findings: [{ id: "concern", message: "Do not hide this concern" }] };
    const original = JSON.stringify(evidence);
    const projected = projectE2eFixReviewContext(evidence, store, 5000);
    expect(JSON.stringify(evidence)).toBe(original);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(5000);
    expect(projected.issue).toEqual(evidence.issue); expect(projected.reports).toEqual(evidence.reports);
    expect(projected.findings).toEqual(evidence.findings);
    expect("source_context" in projected).toBe(true);
    if (!("source_context" in projected)) throw new Error("expected diff projection");
    // Cumulative diff must include the previous round's fix and a new file.
    expect(projected.source_context.diff).toContain("-module.exports = (a,b) => a-b;");
    expect(projected.source_context.diff).toContain("+module.exports = (a,b) => a+b;");
    expect(projected.source_context.diff).toContain("+module.exports = 'new file';");
    expect(projected.source_context.limitation).toContain("Unchanged source");
    expect(projectE2eFixReviewContext(evidence, store, 96000)).toBe(evidence);
    const huge = { ...evidence, findings: [{ id: "concern", message: "Must preserve every finding. ".repeat(3000) }] };
    const stillLarge = projectE2eFixReviewContext(huge, store, 5000);
    expect(stillLarge.findings).toEqual(huge.findings);
    expect(Buffer.byteLength(JSON.stringify(stillLarge))).toBeGreaterThan(5000);
    expect(() => store.reviewDiff({ ...candidate, tree: "e".repeat(40) }, ["sum.cjs"])).toThrow(/head\/tree/);
  });
  it("rejects a candidate relabeled with a different plan or Git tree", () => {
    const value = store.capture(request()); store.verifyCandidate(value);
    expect(() => store.verifyCandidate({ ...value, plan_sha256: "c".repeat(64) })).toThrow(/identity/);
    expect(() => store.verifyCandidate({ ...value, tree: "e".repeat(40) })).toThrow(/head\/tree/);
  });
  it.each(["../outside", "/tmp/outside", ".git/config", "x/.GIT/hooks", "sum.cjs/../x"])("rejects unsafe path %s", name => {
    expect(() => store.capture({ ...request(), allowed_paths: [name], edits: [{ path: name, old: "", new: "evil" }] })).toThrow(/unsafe/);
  });
  it("rejects edits to frozen test definitions even if a model puts them in its plan", () => {
    expect(() => store.capture({ ...request(), allowed_paths: ["tests/frozen.cjs"],
      edits: [{ path: "tests/frozen.cjs", old: "trusted test", new: "always pass" }] })).toThrow(/scope/);
  });
  it("rejects stale, ambiguous, duplicate and no-op edits", () => {
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "missing", new: "x" }] })).toThrow(/stale/);
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "a", new: "x" }] })).toThrow(/ambiguous/);
    expect(() => store.capture({ ...request(), edits: [...request().edits, ...request().edits] })).toThrow(/overlapping|duplicate/);
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "a-b", new: "a-b" }] })).toThrow(/unchanged/);
  });
  it("applies multiple disjoint snippets in one file against the frozen parent regardless of order", () => {
    const edits = [{ path: "sum.cjs", old: "module.exports", new: "// literal $& is preserved\nmodule.exports" },
      { path: "sum.cjs", old: "a-b", new: "a+b" }];
    const candidate = store.capture({ ...request(), edits: [...edits].reverse() });
    expect(store.source(candidate.head, ["sum.cjs"])["sum.cjs"]).toBe("// literal $& is preserved\nmodule.exports = (a,b) => a+b;\n");
    const other = new E2eFixCandidates(path.join(root, "other")); other.seed(repo, base);
    expect(other.capture({ ...request(), edits })).toEqual(candidate);
  });
  it("rejects overlapping snippets, including identical ranges, before saving a candidate", () => {
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" },
      { path: "sum.cjs", old: "a-b;", new: "a*b;" }] })).toThrow(/overlapping/);
    expect(fs.existsSync(path.join(store.directory, "candidates", "1.json"))).toBe(false);
  });
  it("rejects a chained edit that only matches newly introduced text", () => {
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" },
      { path: "sum.cjs", old: "a+b", new: "a*b" }] })).toThrow(/stale/);
  });
  it("rejects duplicate new files and combined no-op changes", () => {
    expect(() => store.capture({ ...request(), allowed_paths: ["new.cjs"], edits: [
      { path: "new.cjs", old: "", new: "first" }, { path: "new.cjs", old: "", new: "second" }] })).toThrow(/duplicate/);
    expect(() => store.capture({ ...request(), edits: [{ path: "sum.cjs", old: "module.", new: "module" },
      { path: "sum.cjs", old: "exports", new: ".exports" }] })).toThrow(/unchanged combined/);
  });
  it("preserves literal dollar substitutions and only permits explicit new-file scope", () => {
    const candidate = store.capture({ ...request(), allowed_paths: ["new.cjs"], edits: [{ path: "new.cjs", old: "", new: "module.exports='$&';" }] });
    expect(store.source(candidate.head, ["new.cjs"])["new.cjs"]).toBe("module.exports='$&';");
  });
  it("builds and reuses an exact regular-file snapshot", () => {
    const candidate = store.capture(request()); const dir = store.snapshot(candidate.tree);
    expect(store.snapshot(candidate.tree)).toBe(dir);
    expect(fs.readFileSync(path.join(dir, "sum.cjs"), "utf8")).toContain("a+b");
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
  });
  it("normalizes inherited file and directory modes before publishing the snapshot", () => {
    const candidate = store.capture(request());
    const open = fs.openSync;
    let injected = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (typeof file === "string" && file.includes(".tmp/") && flags === "wx") {
        injected++;
        fs.fchmodSync(fd, 0o700);
        for (let dir = path.dirname(file); dir.includes(".tmp"); dir = path.dirname(dir)) fs.chmodSync(dir, 0o700);
      }
      return fd;
    });
    const dir = store.snapshot(candidate.tree);
    expect(injected).toBe(3);
    expect(fs.statSync(dir).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(path.join(dir, "tests", "nested")).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(path.join(dir, "sum.cjs")).mode & 0o7777).toBe(0o444);
    expect(fs.statSync(path.join(dir, "tests", "nested", "executable.sh")).mode & 0o7777).toBe(0o555);
    expect(fs.statSync(store.directory).mode & 0o077).toBe(0);
    expect(store.snapshot(candidate.tree)).toBe(dir);
  });
  it("rejects malformed temporary bytes without publishing and permits a clean retry", () => {
    const candidate = store.capture(request());
    const destination = path.join(store.directory, "snapshots", candidate.tree);
    const verify = store.verifySnapshot.bind(store);
    vi.spyOn(store, "verifySnapshot").mockImplementationOnce((tree, dir) => {
      const file = path.join(dir, "sum.cjs"); fs.chmodSync(file, 0o644); fs.writeFileSync(file, "corrupted");
      verify(tree, dir);
    });
    expect(() => store.snapshot(candidate.tree)).toThrow(/snapshot/);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
    expect(fs.readFileSync(path.join(store.snapshot(candidate.tree), "sum.cjs"), "utf8")).toContain("a+b");
  });
  it("never replaces a published dangling symlink", () => {
    const candidate = store.capture(request());
    const destination = path.join(store.directory, "snapshots", candidate.tree);
    fs.mkdirSync(path.dirname(destination)); fs.symlinkSync(path.join(root, "missing"), destination);
    expect(() => store.snapshot(candidate.tree)).toThrow(/snapshot/);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
  });
  it.each(["content", "missing", "extra", "symlink", "directory", "writable", "unreadable", "untraversable"])("rejects snapshot %s drift", kind => {
    const candidate = store.capture(request()); const dir = store.snapshot(candidate.tree); const file = path.join(dir, "sum.cjs");
    if (kind === "content") { fs.chmodSync(file, 0o644); fs.writeFileSync(file, "forged"); }
    if (kind === "missing") fs.unlinkSync(file);
    if (kind === "extra") fs.writeFileSync(path.join(dir, "forged-receipt.json"), "{}");
    if (kind === "directory") fs.mkdirSync(path.join(dir, "extra"));
    if (kind === "writable") fs.chmodSync(file, 0o644);
    if (kind === "unreadable") fs.chmodSync(file, 0o400);
    if (kind === "untraversable") fs.chmodSync(path.join(dir, "tests"), 0o700);
    if (kind === "symlink") { fs.unlinkSync(file); fs.symlinkSync(path.join(repo, "sum.cjs"), file); }
    expect(() => store.snapshot(candidate.tree)).toThrow(/snapshot/);
  });
  it("rejects a malicious snapshot path before creating any directory", () => {
    expect(() => store.snapshot("../../escape")).toThrow(/identity/);
    expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
  });
});

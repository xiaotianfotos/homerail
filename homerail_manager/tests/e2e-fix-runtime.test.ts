import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeE2eFixRuntime, frozenE2eFixStageCommands, loadFrozenE2eFixRuntime, type E2eFixFrozenRuntime } from "../src/runtime/e2e-fix-runtime.js";
import { freezeE2eFixTask } from "../src/runtime/e2e-fix-stage.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { _clearActiveRuns, getActiveRun } from "../src/runtime/active-runs.js";
import { closeDb } from "../src/persistence/db.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import { subscribe } from "../src/events/bus.js";

describe.skipIf(process.platform !== "linux")("frozen E2E Fix runtime", () => {
  let root: string; let source: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-e2e-runtime-")); source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "dist/runtime"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ type: "module", dependencies: { example: "1" }, optionalDependencies: { absent: "1" } }));
    fs.writeFileSync(path.join(source, "dist/runtime/e2e-fix-stage-cli.js"), "import value from 'example'; console.log(JSON.stringify({value,args:process.argv.slice(2)}));");
    fs.mkdirSync(path.join(source, "node_modules/example"), { recursive: true });
    fs.writeFileSync(path.join(source, "node_modules/example/package.json"), JSON.stringify({ name: "example", version: "1", main: "index.cjs" }));
    fs.writeFileSync(path.join(source, "node_modules/example/index.cjs"), "module.exports='original dependency';");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const execute = (runtime: E2eFixFrozenRuntime) => {
    const argv = frozenE2eFixStageCommands(runtime, "/private/task").context;
    return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } });
  };
  it("continues with the pinned interpreter and dependencies after the live source is removed", () => {
    const runtime = freezeE2eFixRuntime(path.join(root, "frozen"), source);
    fs.rmSync(source, { recursive: true });
    expect(() => loadFrozenE2eFixRuntime(runtime.directory, "0".repeat(64))).toThrow(/identity mismatch/);
    const result = execute(loadFrozenE2eFixRuntime(runtime.directory, runtime.sha256));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ value: "original dependency", args: ["/private/task", "context"] });
  });
  it("normalizes execute bits added by inherited filesystem ACLs before freezing", () => {
    const link = fs.linkSync;
    const inherited = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      link(from, to); fs.chmodSync(to, 0o700);
    });
    let runtime: E2eFixFrozenRuntime;
    try { runtime = freezeE2eFixRuntime(path.join(root, "frozen"), source); }
    finally { inherited.mockRestore(); }
    expect(fs.statSync(path.join(runtime.directory, "bootstrap.mjs")).mode & 0o111).toBe(0);
    const result = execute(runtime); expect(result.status, result.stderr).toBe(0);
  });
  it("preserves different nested dependency versions", () => {
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ type: "module", dependencies: { example: "1", shared: "1" } }));
    fs.writeFileSync(path.join(source, "dist/runtime/e2e-fix-stage-cli.js"), "import a from 'example'; import b from 'shared';console.log(JSON.stringify([a,b]));");
    fs.writeFileSync(path.join(source, "node_modules/example/package.json"), JSON.stringify({ name: "example", main: "index.cjs", dependencies: { shared: "2" } }));
    fs.writeFileSync(path.join(source, "node_modules/example/index.cjs"), "module.exports=require('shared');");
    for (const [name, version] of [["node_modules/shared", 1], ["node_modules/example/node_modules/shared", 2]] as const) {
      const dir = path.join(source, name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "shared", main: "index.cjs", version: String(version) }));
      fs.writeFileSync(path.join(dir, "index.cjs"), `module.exports=${version};`);
    }
    const runtime = freezeE2eFixRuntime(path.join(root, "frozen"), source);
    fs.rmSync(source, { recursive: true });
    const result = execute(runtime); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual([2, 1]);
  });
  it.each(["manifest", "module", "extra-file", "dependency-link"])("rejects %s tampering before loading the entrypoint", kind => {
    const runtime = freezeE2eFixRuntime(path.join(root, "frozen"), source);
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime.directory, "manifest.json"), "utf8"));
    if (kind === "manifest") fs.appendFileSync(path.join(runtime.directory, "manifest.json"), " ");
    else if (kind === "module") fs.appendFileSync(path.join(runtime.directory, manifest.entry), "console.log('unexpected');");
    else if (kind === "extra-file") fs.writeFileSync(path.join(runtime.directory, "extra.cjs"), "");
    else {
      const link = path.join(runtime.directory, manifest.entries.find((e: any) => e.link).path);
      fs.unlinkSync(link); fs.symlinkSync(path.join(source, "node_modules/example"), link);
    }
    const result = execute(runtime);
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toMatch(/Frozen E2E Fix runtime rejected/);
  });
  it("rejects missing required dependencies and does not publish a partial runtime", () => {
    fs.rmSync(path.join(source, "node_modules"), { recursive: true });
    expect(() => freezeE2eFixRuntime(path.join(root, "frozen"), source)).toThrow(/missing production runtime dependency/);
    expect(fs.existsSync(path.join(root, "frozen"))).toBe(false);
  });
  it.skipIf(!process.env.HOMERAIL_E2E_FIX_RUNTIME_PROOF)("runs the actual frozen CLI with native stage identity and rejects a different task runtime", async () => {
    const runtime = freezeE2eFixRuntime(path.join(root, "frozen"));
    const result = execute(runtime);
    // The real CLI has loaded all its dependencies and rejects missing native
    // command authority, before touching task data or making external calls.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("E2E Fix stages require native durable command authority");
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|NODE_MODULE_VERSION/);
    const evidence = process.env.HOMERAIL_E2E_FIX_RUNTIME_PROOF!;
    fs.mkdirSync(evidence, { recursive: true });
    fs.copyFileSync(path.join(runtime.directory, "manifest.json"), path.join(evidence, "manifest.json"));
    const oldHome = process.env.HOMERAIL_HOME; const oldAllow = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    process.env.HOMERAIL_HOME = path.join(root, "home"); process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = runtime.node.toLowerCase();
    _clearActiveRuns(); closeDb();
    const snapshots: unknown[] = [];
    try {
      const repo = path.join(root, "repo"); fs.mkdirSync(repo);
      const git = (...args: string[]) => {
        const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
      };
      git("init"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.invalid");
      fs.writeFileSync(path.join(repo, "source.cjs"), "module.exports=1;"); git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      for (const mismatch of [false, true]) {
        const run = mismatch ? "wrong-runtime" : "frozen-runtime"; const task = path.join(root, run);
        freezeE2eFixTask(task, { version: 1, mode: "simulation", task_id: run, root_run_id: run,
          runtime_sha256: mismatch ? "0".repeat(64) : runtime.sha256,
          source_repo: repo, repo: "fixture/repo", base: git("rev-parse", "HEAD"), issue: { number: 1, title: "fixture", body: "fixture" },
          allowed_paths: ["source.cjs"], protected_paths: [], max_rounds: 1, max_infra_retries: 0, context_bytes: 96000, total_timeout_ms: 60000,
          tests: [{ id: "check", image: "sha256:" + "1".repeat(64), argv: ["node", "-e", "void 0"], cwd: ".", files: {},
            timeout_ms: 1000, memory_mb: 128, workspace_mb: 32, cpus: 1, pids_limit: 64 }],
          policy: { required_tests: ["check"], required_ci_jobs: ["ci"], reviewer_ids: ["review_a", "review_b", "review_c"], review_approvals: 2, ci_workflow_path: "ci.yml" } });
        const graph = { api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: run, name: run }, spec: {
          agents: {}, contracts: { Task: { type: "object" } }, nodes: {
            initialize: { kind: "command", inputs: { task: { contract: "Task" } }, outputs: { ready: {}, failed: {} }, config: {
              command: frozenE2eFixStageCommands(runtime, task).initialize, durable: true, stdin_field: "$inputs", timeout_ms: 15000,
              parse_stdout: "json", result_payload: "value", success_port: "ready", failure_port: "failed" } },
            done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
            failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
          }, edges: [{ from: "$run.input", to: "initialize.task" }, { from: "initialize.ready", to: "done.result" },
            { from: "initialize.failed", to: "failed.result", condition: "on_failure" }] } };
        const subscriptions: Array<() => void> = [];
        const done = new Promise<void>(resolve => {
          for (const name of ["dag:run_completed", "dag:run_failed"] as const) subscriptions.push(subscribe(name, event => { if (event.runId === run) resolve(); }));
        });
        try {
          const executor = new GraphExecutor(new FakeDAGDispatcher());
          executor.createRun(run, parseWorkflowSource(JSON.stringify(graph)), JSON.stringify({ task_id: run })); executor.tick(run);
          await done;
          const snapshot = loadRunSnapshot(run)!; snapshots.push(snapshot);
          expect(getActiveRun(run)?.status, JSON.stringify(snapshot.handoffs)).toBe(mismatch ? "failed" : "completed");
          expect(fs.existsSync(path.join(task, "candidates/seed.json"))).toBe(!mismatch);
        } finally { subscriptions.forEach(close => close()); }
      }
    } finally {
      fs.writeFileSync(path.join(evidence, "proof.json"), JSON.stringify({ runtime_digest: runtime.sha256, snapshots,
        scope: "actual frozen production dependency closure and native initialize; matching runtime executes, mismatched runtime rejects before Git; no model/GitHub calls" }));
      _clearActiveRuns(); closeDb();
      if (oldHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = oldHome;
      if (oldAllow === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST; else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllow;
    }
  }, 60000);
});

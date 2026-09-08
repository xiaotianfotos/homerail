import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../src/persistence/db.js";
import { loadRunSnapshot } from "../src/persistence/store.js";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { _clearActiveRuns, getActiveRun, recoverAllActiveRuns, cancelActiveRun } from "../src/runtime/active-runs.js";

describe.skipIf(process.platform !== "linux")("native durable command gateway", () => {
  let root: string;
  let env: { home?: string; allow?: string };
  const executor = new GraphExecutor(new FakeDAGDispatcher());
  const children: ChildProcess[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-durable-workflow-"));
    env = { home: process.env.HOMERAIL_HOME, allow: process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST };
    process.env.HOMERAIL_HOME = root; process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
    _clearActiveRuns(); closeDb();
  });
  afterEach(() => {
    children.splice(0).forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    _clearActiveRuns(); closeDb();
    if (env.home === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = env.home;
    if (env.allow === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST; else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = env.allow;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function graph(code: string) {
    return { api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "durable-test", name: "durable test" }, spec: {
      agents: {}, contracts: { Task: { type: "string" } }, nodes: {
        command: { kind: "command", inputs: { input: { contract: "Task" } }, outputs: { ready: {}, failed: {} },
          config: { command: [process.execPath, "-e", code], cwd: "$run_workspace", durable: true, timeout_ms: 5000,
            success_port: "ready", failure_port: "failed", parse_stdout: "json", result_payload: "value" } },
        done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
        failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      }, edges: [{ from: "$run.input", to: "command.input" }, { from: "command.ready", to: "done.result" },
        { from: "command.failed", to: "failed.result", condition: "on_failure" }] } };
  }
  function start(code: string) {
    executor.createRun("root", parseWorkflowSource(JSON.stringify(graph(code))), JSON.stringify("input"));
    executor.tick("root");
  }
  async function completed() { await vi.waitFor(() => expect(getActiveRun("root")?.status).toBe("completed"), { timeout: 8000 }); }
  it("returns immediately, then advances to terminal without an external tick", async () => {
    start("setTimeout(()=>console.log(JSON.stringify({ok: true})),300)");
    expect(getActiveRun("root")?.dagRun.nodeStates.get("command")).toBe("RUNNING");
    await completed();
    expect(loadRunSnapshot("root")!.handoffs).toHaveLength(1);
  });
  it("restores a RUNNING command and consumes its original result once", async () => {
    start("require('fs').appendFileSync('count','x'); setTimeout(()=>console.log('{}'),500)");
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "workspace", "root", "count"))).toBe(true));
    const oldSession = getActiveRun("root")!.nodeSessions.get("command")!.sessionId;
    _clearActiveRuns(); closeDb();
    expect(recoverAllActiveRuns()).toMatchObject({ recovered: ["root"], failed: [] });
    expect(getActiveRun("root")?.dagRun.nodeStates.get("command")).toBe("RUNNING");
    executor.tick("root"); // Normal startup scheduler hook, not a repair-stage command.
    executor.tick("root");
    await completed();
    expect(getActiveRun("root")!.nodeSessions.get("command")!.sessionId).toBe(oldSession);
    expect(fs.readFileSync(path.join(root, "workspace", "root", "count"), "utf8")).toBe("x");
    expect(loadRunSnapshot("root")!.handoffs).toHaveLength(1);
    expect(getDb().prepare("SELECT consumed, owner_epoch FROM dag_durable_commands").get()).toMatchObject({ consumed: 1, owner_epoch: 2 });
  });
  it("recovers a finished but unconsumed receipt without starting another process", async () => {
    start("require('fs').appendFileSync('count','x'); setTimeout(()=>console.log('{}'),100)");
    _clearActiveRuns(); closeDb();
    await vi.waitFor(() => {
      const dir = path.join(root, "trusted-commands");
      expect(fs.readdirSync(dir).some(id => fs.existsSync(path.join(dir, id, "receipt.json")))).toBe(true);
    }, { timeout: 8000 });
    expect(recoverAllActiveRuns().recovered).toEqual(["root"]);
    executor.tick("root"); await completed();
    expect(fs.readFileSync(path.join(root, "workspace", "root", "count"), "utf8")).toBe("x");
  }, 10000);
  it("routes invalid JSON to failure and never pretends the test stage passed", async () => {
    // A legal command can exceed Vitest's default one-second observation
    // window. Wait for its bounded terminal result, not subsecond scheduling.
    start("setTimeout(()=>console.log('not-json'),1100)");
    await vi.waitFor(() => expect(getActiveRun("root")?.status).toBe("failed"), { timeout: 8000 });
    expect(loadRunSnapshot("root")!.handoffs[0].content).toMatchObject({ parse_failed: true });
  }, 10000);
  it("cancellation fences a late completion", async () => {
    start("setInterval(()=>{},1000)");
    cancelActiveRun("root");
    await vi.waitFor(() => {
      const dir = path.join(root, "trusted-commands");
      expect(fs.readdirSync(dir).some(id => fs.existsSync(path.join(dir, id, "receipt.json")))).toBe(true);
    });
    expect(getActiveRun("root")?.status).toBe("cancelled");
    expect(loadRunSnapshot("root")!.handoffs).toHaveLength(0);
  });
  it("rejects model-selected durable executables at compilation", () => {
    const workflow = graph("console.log('{}')");
    const config = workflow.spec.nodes.command.config as Record<string, unknown>;
    delete config.command; config.command_field = "argv";
    expect(() => parseWorkflowSource(JSON.stringify(workflow))).toThrow(/durable commands require/);
  });
  it("survives SIGKILL of the Manager process while the original test continues", async () => {
    function manager(mode: string) {
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/durable-command-manager.ts"), root, mode], { stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let log = "";
      child.stderr.on("data", bytes => { log += bytes; });
      return { child, log: () => log };
    }
    const first = manager("start");
    await vi.waitFor(() => {
      if (first.child.exitCode !== null) throw new Error(first.log());
      expect(fs.existsSync(path.join(root, "workspace", "root", "count"))).toBe(true);
    }, { timeout: 8000 });
    const before = JSON.parse(fs.readFileSync(path.join(root, "start-manager.json"), "utf8"));
    const ended = new Promise(resolve => first.child.once("exit", resolve));
    first.child.kill("SIGKILL"); await ended;
    expect(first.child.signalCode).toBe("SIGKILL");
    const second = manager("recover");
    await vi.waitFor(() => {
      if (second.child.exitCode !== null) throw new Error(second.log());
      expect(fs.existsSync(path.join(root, "recover-manager.json"))).toBe(true);
    }, { timeout: 8000 });
    const recovered = JSON.parse(fs.readFileSync(path.join(root, "recover-manager.json"), "utf8"));
    expect(recovered.pid).not.toBe(before.pid);
    expect(recovered.session.sessionId).toBe(before.session.sessionId);
    fs.writeFileSync(path.join(root, "workspace", "root", "release"), "finish the existing process");
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "recovered-proof.json"))).toBe(true), { timeout: 5000 });
    const proof = JSON.parse(fs.readFileSync(path.join(root, "recovered-proof.json"), "utf8"));
    expect(proof).toMatchObject({ status: "completed", count: "x" });
    expect(proof.snapshot.handoffs).toHaveLength(1);
    expect(proof.snapshot.handoffs[0].content).toEqual({ executed: true });
    expect(getDb().prepare("SELECT consumed, owner_epoch FROM dag_durable_commands").get()).toMatchObject({ consumed: 1, owner_epoch: 2 });
    const exportDir = process.env.HOMERAIL_E2E_FIX_EVIDENCE_DIR;
    if (exportDir) {
      const destination = path.join(exportDir, "manager-sigkill", path.basename(root));
      fs.mkdirSync(destination, { recursive: true });
      for (const file of ["start-manager.json", "recover-manager.json", "recovered-proof.json"]) fs.copyFileSync(path.join(root, file), path.join(destination, file));
      fs.cpSync(path.join(root, "trusted-commands"), path.join(destination, "trusted-commands"), { recursive: true });
    }
  }, 20000);
});

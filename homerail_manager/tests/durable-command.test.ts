import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "../src/persistence/db.js";
import {
  prepareDurableCommand, claimDurableCommand, startDurableCommand, observeDurableCommand,
  durableCommandDirectory, consumeDurableCommand, cancelDurableCommand, watchDurableCommand,
  type DurableCommandRecord, type DurableCommandSpec,
} from "../src/runtime/durable-command.js";

describe.skipIf(process.platform !== "linux")("durable host command execution", () => {
  let root: string;
  let oldHome: string | undefined;
  const observers: Array<() => void> = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-durable-command-"));
    oldHome = process.env.HOMERAIL_HOME; process.env.HOMERAIL_HOME = root; closeDb();
  });
  afterEach(() => {
    observers.splice(0).forEach(close => close());
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const identity = { run_id: "root", node_id: "test", session_id: "fresh-1", round_id: "round-1", attempt: 1 };
  function prepare(code = "console.log(JSON.stringify({passed: true}))", extra: Partial<DurableCommandSpec> = {}) {
    return prepareDurableCommand(identity, { argv: [process.execPath, "-e", code], cwd: root,
      timeout_ms: 3000, capture_limit: 1000, ...extra });
  }
  async function finished(record: DurableCommandRecord) {
    await vi.waitFor(() => expect(observeDurableCommand(record).status).toBe("finished"), { timeout: 5000, interval: 20 });
    const result = observeDurableCommand(record);
    if (result.status !== "finished") throw new Error(JSON.stringify(result));
    return result;
  }
  it("executes an intent prepared before restart exactly once despite duplicate launches", async () => {
    const record = prepare("require('fs').appendFileSync('count','x'); console.log('real test')");
    expect(fs.existsSync(path.join(root, "count"))).toBe(false);
    closeDb();
    startDurableCommand(record); startDurableCommand(record); startDurableCommand(record);
    expect(await finished(record)).toMatchObject({ exit_code: 0, stdout: "real test\n", timed_out: false });
    startDurableCommand(record);
    expect(fs.readFileSync(path.join(root, "count"), "utf8")).toBe("x");
  });
  it("reattaches after lost acknowledgement without replaying a running child", async () => {
    const record = prepare("require('fs').appendFileSync('count','x'); setTimeout(()=>console.log('done'),400)");
    startDurableCommand(record);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "count"))).toBe(true));
    closeDb();
    startDurableCommand(record);
    expect(await finished(record)).toMatchObject({ exit_code: 0, stdout: "done\n" });
    expect(fs.readFileSync(path.join(root, "count"), "utf8")).toBe("x");
  });
  it("fences superseded owners and consumes a completion only once", async () => {
    const prepared = prepare(); startDurableCommand(prepared); await finished(prepared);
    const first = claimDurableCommand(prepared.execution_id);
    const second = claimDurableCommand(prepared.execution_id);
    const effects: string[] = [];
    expect(second.owner_epoch).toBe(first.owner_epoch + 1);
    expect(consumeDurableCommand(first, () => effects.push("stale"))).toBe(false);
    expect(consumeDurableCommand(second, () => effects.push("current"))).toBe(true);
    expect(consumeDurableCommand(second, () => effects.push("duplicate"))).toBe(false);
    expect(effects).toEqual(["current"]);
  });
  it("does not consume a failed handoff transaction", () => {
    const record = claimDurableCommand(prepare().execution_id);
    expect(() => consumeDurableCommand(record, () => { throw new Error("DB failure"); })).toThrow("DB failure");
    expect(consumeDurableCommand(record, () => {})).toBe(true);
  });
  it.each(["receipt.json", "stdout.log", "intent.json", "runner.mjs"])("rejects altered %s without executing again", async name => {
    const record = prepare("require('fs').appendFileSync('count','x'); console.log('done')");
    startDurableCommand(record); await finished(record);
    fs.appendFileSync(path.join(durableCommandDirectory(record.execution_id), name), " ");
    expect(observeDurableCommand(record).status).toBe("unknown");
    expect(fs.readFileSync(path.join(root, "count"), "utf8")).toBe("x");
  });
  it("does not accept a model-written report in place of an executed command", () => {
    const record = prepare();
    fs.writeFileSync(path.join(durableCommandDirectory(record.execution_id), "receipt.json"), JSON.stringify({ passed: true, spec_digest: record.spec_digest }));
    expect(observeDurableCommand(record).status).toBe("unknown");
  });
  it("rejects a changed command for the same execution identity", () => {
    prepare("console.log('first')");
    expect(() => prepare("console.log('different')")).toThrow("intent conflict");
  });
  it("reports timeout and terminates the command group", async () => {
    const record = prepare("setInterval(()=>{},1000)", { timeout_ms: 100 });
    startDurableCommand(record);
    expect(await finished(record)).toMatchObject({ exit_code: null, signal: "SIGKILL", timed_out: true });
  });
  it("reports a real assertion failure instead of a provider success claim", async () => {
    const record = prepare("require('node:assert/strict').equal(1,2)", { capture_limit: 20000 });
    startDurableCommand(record);
    expect(await finished(record)).toMatchObject({ exit_code: 1, timed_out: false, overflow: false });
  });
  it("fails excessive output rather than silently accepting truncated JSON", async () => {
    const record = prepare("console.log('x'.repeat(50000))", { capture_limit: 32 });
    startDurableCommand(record);
    const result = await finished(record);
    expect(result.overflow).toBe(true); expect(Buffer.byteLength(result.stdout)).toBe(32);
  });
  it("cancels a running execution and retains the actual killed-process receipt", async () => {
    const record = prepare("require('fs').writeFileSync('started','1'); setInterval(()=>{},1000)");
    startDurableCommand(record);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "started"))).toBe(true));
    cancelDurableCommand(record.execution_id); cancelDurableCommand(record.execution_id);
    expect(await finished(record)).toMatchObject({ cancelled: true, signal: "SIGKILL" });
  });
  it("does not start a command cancelled before its launch", async () => {
    const record = prepare("require('fs').appendFileSync('count','x')");
    cancelDurableCommand(record.execution_id);
    startDurableCommand(record);
    expect(await finished(record)).toMatchObject({ cancelled: true, exit_code: null });
    expect(fs.existsSync(path.join(root, "count"))).toBe(false);
  });
  it("marks a lost runner unknown and does not relaunch the already claimed command", async () => {
    const record = prepare("require('fs').appendFileSync('count','x'); setInterval(()=>{},1000)");
    startDurableCommand(record);
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "count"))).toBe(true));
    const dir = durableCommandDirectory(record.execution_id);
    const started = JSON.parse(fs.readFileSync(path.join(dir, "started.json"), "utf8"));
    const child = JSON.parse(fs.readFileSync(path.join(dir, "child.json"), "utf8"));
    process.kill(Number(started.runner_identity.split(":")[1]), "SIGKILL");
    try {
      await vi.waitFor(() => expect(observeDurableCommand(record).status).toBe("unknown"));
      startDurableCommand(record);
      expect(fs.readFileSync(path.join(root, "count"), "utf8")).toBe("x");
      cancelDurableCommand(record.execution_id);
      expect(observeDurableCommand(record).status).toBe("unknown");
    } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  });
  it("delivers one terminal notification and none while the state is unchanged", async () => {
    const prepared = prepare("setTimeout(()=>console.log('done'),1100)");
    const record = claimDurableCommand(prepared.execution_id);
    const results: unknown[] = [];
    observers.push(watchDurableCommand(record, result => results.push(result)));
    expect(results).toEqual([]);
    startDurableCommand(record);
    // Includes the command's 3s budget and the 1s observation fallback.
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 5000 });
    expect(results[0]).toMatchObject({ status: "finished", exit_code: 0 });
    fs.writeFileSync(path.join(durableCommandDirectory(record.execution_id), "late-event"), "duplicate");
    await new Promise(resolve => setImmediate(resolve));
    expect(results).toHaveLength(1);
  }, 8000);
});

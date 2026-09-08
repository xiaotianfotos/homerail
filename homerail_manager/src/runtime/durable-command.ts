import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { getHomerailHome } from "../config/env.js";
import { getDb } from "../persistence/db.js";

export interface DurableCommandIdentity {
  run_id: string; node_id: string; session_id: string; round_id: string; attempt: number;
}
export interface DurableCommandSpec {
  argv: string[]; cwd: string; stdin?: string; timeout_ms: number; capture_limit: number;
}
export interface DurableCommandRecord {
  execution_id: string; run_id: string; identity_json: string; spec_json: string;
  spec_digest: string; runner_digest: string; owner: string | null; owner_epoch: number;
  receipt_digest: string | null; consumed: number;
}
export type DurableCommandResult =
  | { status: "waiting" }
  | { status: "unknown"; error: string }
  | { status: "finished"; receipt_digest: string; stdout: string; stderr: string;
      exit_code: number | null; signal: string | null; timed_out: boolean; cancelled: boolean;
      overflow: boolean; error?: string; duration_ms: number };

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function durableCommandId(identity: DurableCommandIdentity): string {
  return hash(JSON.stringify([identity.run_id, identity.node_id, identity.session_id, identity.round_id, identity.attempt]));
}
export function durableCommandDirectory(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid execution identity");
  return path.join(getHomerailHome(), "trusted-commands", id);
}
export function getDurableCommand(id: string): DurableCommandRecord | undefined {
  return getDb().prepare("SELECT * FROM dag_durable_commands WHERE execution_id = ?").get(id) as DurableCommandRecord | undefined;
}
function immutableFile(file: string, bytes: string | Buffer): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temporary, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { fs.unlinkSync(temporary); }
  if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(Buffer.from(bytes))) throw new Error("immutable command artifact changed");
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Intent is durable before any process can start. Repeated calls must match
 * the original bytes. This is a host-private executor, not a sandbox for patches. */
export function prepareDurableCommand(identity: DurableCommandIdentity, spec: DurableCommandSpec): DurableCommandRecord {
  if (process.platform !== "linux") throw new Error("durable commands require Linux");
  if (!spec.argv.length || spec.argv.some(s => typeof s !== "string" || s.includes("\0"))
    || !path.isAbsolute(spec.cwd) || !Number.isSafeInteger(spec.timeout_ms) || spec.timeout_ms < 100 || spec.timeout_ms > 3_600_000
    || !Number.isSafeInteger(spec.capture_limit) || spec.capture_limit < 1 || spec.capture_limit > 1_000_000
    || Buffer.byteLength(spec.stdin ?? "") > 1_000_000) throw new Error("invalid durable command spec");
  const id = durableCommandId(identity);
  const specJson = JSON.stringify(spec);
  const runner = fs.readFileSync(new URL("./durable-command-runner.mjs", import.meta.url));
  const record = getDb().transaction(() => {
    const previous = getDurableCommand(id);
    if (previous) {
      if (previous.spec_json !== specJson) throw new Error("durable command intent conflict");
      return previous;
    }
    getDb().prepare(`INSERT INTO dag_durable_commands
      (execution_id, run_id, identity_json, spec_json, spec_digest, runner_digest) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, identity.run_id, JSON.stringify(identity), specJson, hash(specJson), hash(runner));
    return getDurableCommand(id)!;
  }).immediate();
  const dir = durableCommandDirectory(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || (fs.statSync(dir).mode & 0o077)) throw new Error("durable command directory must be private");
  immutableFile(path.join(dir, "intent.json"), record.spec_json);
  // An old intent must use the old runner. Updating code cannot silently change
  // a prepared job. Already materialized copies remain valid across upgrades.
  const runnerPath = path.join(dir, "runner.mjs");
  if (!fs.existsSync(runnerPath)) {
    if (hash(runner) !== record.runner_digest) throw new Error("prepared runner version unavailable");
    immutableFile(runnerPath, runner);
  }
  if (hash(fs.readFileSync(runnerPath)) !== record.runner_digest) throw new Error("runner digest mismatch");
  return record;
}

export function claimDurableCommand(id: string): DurableCommandRecord {
  const owner = randomUUID();
  getDb().prepare("UPDATE dag_durable_commands SET owner = ?, owner_epoch = owner_epoch + 1 WHERE execution_id = ? AND consumed = 0").run(owner, id);
  const record = getDurableCommand(id);
  if (!record || record.consumed || record.owner !== owner) throw new Error("command already consumed or unavailable");
  return record;
}
export function ownsDurableCommand(record: DurableCommandRecord): boolean {
  const current = getDurableCommand(record.execution_id);
  return !!current && !current.consumed && current.owner === record.owner && current.owner_epoch === record.owner_epoch;
}
/** Execute the DAG handoff and receipt consumption inside one DB transaction.
 * A superseded Manager callback cannot publish state after a new owner claim. */
export function consumeDurableCommand(record: DurableCommandRecord, apply: () => void): boolean {
  return getDb().transaction(() => {
    if (!ownsDurableCommand(record)) return false;
    apply();
    getDb().prepare("UPDATE dag_durable_commands SET consumed = 1 WHERE execution_id = ?").run(record.execution_id);
    return true;
  }).immediate();
}
export function startDurableCommand(record: DurableCommandRecord): void {
  const dir = durableCommandDirectory(record.execution_id);
  for (const [name, digest] of [["intent.json", record.spec_digest], ["runner.mjs", record.runner_digest]]) {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== digest) throw new Error(`${name} digest mismatch`);
  }
  if (fs.existsSync(path.join(dir, "claim")) || fs.existsSync(path.join(dir, "receipt.json"))) return;
  const log = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [path.join(dir, "runner.mjs"), dir, record.spec_digest], {
      detached: true, shell: false, stdio: ["ignore", log, log],
    });
    child.on("error", () => { /* Observation reports absence; never replay a claimed execution. */ });
    child.unref();
  } finally { fs.closeSync(log); }
}
function liveIdentity(expected: string): boolean {
  const [boot, pid, start] = expected.split(":");
  if (!/^\d+$/.test(pid)) return false;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[19] === start && fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() === boot;
  } catch { return false; }
}

export function observeDurableCommand(record: DurableCommandRecord): DurableCommandResult {
  try {
    const dir = durableCommandDirectory(record.execution_id);
    const read = (name: string, limit = 1_100_000) => {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > limit) throw new Error(`invalid ${name} artifact`);
      return fs.readFileSync(file);
    };
    if (hash(read("intent.json", 2_000_000)) !== record.spec_digest) throw new Error("intent digest mismatch");
    if (hash(read("runner.mjs")) !== record.runner_digest) throw new Error("runner digest mismatch");
    if (!fs.existsSync(path.join(dir, "receipt.json"))) {
      if (!fs.existsSync(path.join(dir, "claim"))) return { status: "waiting" };
      if (!fs.existsSync(path.join(dir, "started.json"))) {
        // Give the atomic claim→started write a short delivery window.
        if (Date.now() - fs.statSync(path.join(dir, "claim")).mtimeMs < 5_000) return { status: "waiting" };
        throw new Error("execution claimed without start acknowledgement; outcome unknown");
      }
      const started = JSON.parse(read("started.json").toString());
      if (started.spec_digest !== record.spec_digest || !Number.isFinite(started.started_at)
        || typeof started.runner_identity !== "string") throw new Error("start acknowledgement identity mismatch");
      if (!liveIdentity(started.runner_identity)) {
        // The receipt can have arrived between the initial existence check and
        // process exit. Re-read it before classifying a lost execution.
        if (fs.existsSync(path.join(dir, "receipt.json"))) return observeDurableCommand(record);
        throw new Error("runner lost without receipt; outcome unknown");
      }
      const spec = JSON.parse(record.spec_json) as DurableCommandSpec;
      if (Date.now() > started.started_at + spec.timeout_ms + 10_000) throw new Error("runner exceeded execution deadline; outcome unknown");
      return { status: "waiting" };
    }
    const bytes = read("receipt.json");
    const receiptDigest = hash(bytes);
    const current = getDurableCommand(record.execution_id)!;
    if (current.receipt_digest && current.receipt_digest !== receiptDigest) throw new Error("completed receipt changed");
    const receipt = JSON.parse(bytes.toString());
    if (receipt.spec_digest !== record.spec_digest) throw new Error("receipt intent mismatch");
    const stdout = read("stdout.log"); const stderr = read("stderr.log");
    const spec = JSON.parse(record.spec_json) as DurableCommandSpec;
    if (stdout.length > spec.capture_limit || stderr.length > spec.capture_limit) throw new Error("receipt exceeds frozen capture limit");
    if (hash(stdout) !== receipt.stdout_digest || hash(stderr) !== receipt.stderr_digest) throw new Error("command log digest mismatch");
    if (!(receipt.exit_code === null || (Number.isInteger(receipt.exit_code) && receipt.exit_code >= 0 && receipt.exit_code <= 255))
      || !(receipt.signal === null || typeof receipt.signal === "string")
      || ![receipt.timed_out, receipt.cancelled, receipt.overflow].every(v => typeof v === "boolean")
      || !Number.isFinite(receipt.started_at) || !Number.isFinite(receipt.finished_at) || receipt.finished_at < receipt.started_at) throw new Error("invalid receipt contract");
    getDb().prepare("UPDATE dag_durable_commands SET receipt_digest = COALESCE(receipt_digest, ?) WHERE execution_id = ?").run(receiptDigest, record.execution_id);
    if (getDurableCommand(record.execution_id)?.receipt_digest !== receiptDigest) throw new Error("conflicting receipt");
    return { ...receipt, status: "finished", receipt_digest: receiptDigest, stdout: stdout.toString(), stderr: stderr.toString(), duration_ms: receipt.finished_at - receipt.started_at };
  } catch (error) { return { status: "unknown", error: error instanceof Error ? error.message : String(error) }; }
}

export function cancelDurableCommand(id: string): void {
  const dir = durableCommandDirectory(id);
  immutableFile(path.join(dir, "cancel.json"), "{}");
  // If the runner itself died, its cancellation watcher cannot clean up the
  // child. Kill only a positively identified original process group; PID alone
  // is insufficient after reboot/reuse. Its outcome remains UNKNOWN.
  const startedFile = path.join(dir, "started.json");
  const childFile = path.join(dir, "child.json");
  if (fs.existsSync(startedFile) && fs.existsSync(childFile)) {
    const started = JSON.parse(fs.readFileSync(startedFile, "utf8"));
    const child = JSON.parse(fs.readFileSync(childFile, "utf8"));
    const record = getDurableCommand(id);
    if (record && started.spec_digest === record.spec_digest && child.spec_digest === record.spec_digest
      && typeof started.runner_identity === "string" && typeof child.child_identity === "string"
      && !liveIdentity(started.runner_identity) && liveIdentity(child.child_identity)
      && String(child.pid) === child.child_identity.split(":")[1]) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
}

/** Filesystem completion events plus a cheap liveness timer, never model polling.
 * Closing an observer leaves the execution alive for cold recovery. */
export function watchDurableCommand(record: DurableCommandRecord, onResult: (result: Exclude<DurableCommandResult, { status: "waiting" }>) => void): () => void {
  let closed = false;
  const began = Date.now();
  let watcher: fs.FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => { closed = true; watcher?.close(); if (timer) clearInterval(timer); };
  const check = () => {
    if (closed) return;
    if (!ownsDurableCommand(record)) { close(); return; }
    let result = observeDurableCommand(record);
    if (result.status === "waiting" && !fs.existsSync(path.join(durableCommandDirectory(record.execution_id), "claim")) && Date.now() - began > 10_000) {
      result = { status: "unknown", error: "runner did not acknowledge startup" };
    }
    if (result.status !== "waiting") { close(); onResult(result); }
  };
  watcher = fs.watch(durableCommandDirectory(record.execution_id), check);
  watcher.on("error", () => { watcher?.close(); }); // Timer still verifies liveness.
  timer = setInterval(check, 1000); timer.unref();
  queueMicrotask(check);
  return close;
}

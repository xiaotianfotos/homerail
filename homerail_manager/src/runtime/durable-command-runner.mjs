// Detached Linux executor. No DAG routing or model calls belong in this file.
// The Manager pins these bytes before launch; only trusted host code may write
// this directory. Candidate code must execute in a separate sandbox/container.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const dir = process.argv[2];
const expectedDigest = process.argv[3];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function atomic(name, value) {
  const target = path.join(dir, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(temporary, target); } finally { fs.unlinkSync(temporary); }
  const directory = fs.openSync(dir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function identity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
}

async function execute() {
  if (process.platform !== "linux") throw new Error("durable commands require Linux");
  const bytes = fs.readFileSync(path.join(dir, "intent.json"));
  if (hash(bytes) !== expectedDigest) throw new Error("intent digest mismatch");
  const spec = JSON.parse(bytes);
  // The mkdir is the one-way execution claim. Never steal it after a crash:
  // lack of a receipt is UNKNOWN, not proof that the child did not run.
  try { fs.mkdirSync(path.join(dir, "claim"), { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") return; throw error; }
  const startedAt = Date.now();
  atomic("started.json", { spec_digest: expectedDigest, runner_identity: identity(process.pid), started_at: startedAt });
  let child;
  let error;
  let timedOut = false;
  let cancelled = false;
  let overflow = false;
  const output = { stdout: [], stderr: [] };
  const lengths = { stdout: 0, stderr: 0 };
  function kill() {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; }
    }
  }
  function capture(name, chunk) {
    const remaining = spec.capture_limit - lengths[name];
    if (remaining > 0) output[name].push(chunk.subarray(0, remaining));
    lengths[name] += chunk.length;
    if (lengths[name] > spec.capture_limit) { overflow = true; kill(); }
  }
  let result;
  let timeout;
  let cancelCheck;
  try {
    if (fs.existsSync(path.join(dir, "cancel.json"))) {
      cancelled = true;
      result = { exit_code: null, signal: null };
    } else {
    child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, env: process.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", bytes => capture("stdout", bytes));
    child.stderr.on("data", bytes => capture("stderr", bytes));
    child.stdin.on("error", err => { if (err.code !== "EPIPE") error = err.message; });
    child.once("spawn", () => {
      try { atomic("child.json", { spec_digest: expectedDigest, child_identity: identity(child.pid), pid: child.pid }); }
      catch (err) { error = err.message; kill(); }
    });
    timeout = setTimeout(() => { timedOut = true; kill(); }, spec.timeout_ms);
    cancelCheck = setInterval(() => {
      if (fs.existsSync(path.join(dir, "cancel.json"))) { cancelled = true; kill(); }
    }, 100);
    const closed = new Promise(resolve => {
      child.once("error", err => { error = err.message; });
      child.once("close", (code, signal) => resolve({ exit_code: code, signal }));
    });
    child.stdin.end(spec.stdin ?? "");
    result = await closed;
    }
  } finally {
    clearTimeout(timeout); clearInterval(cancelCheck);
    // A successful shell must not leave descendants running after its receipt.
    kill();
  }
  const digests = {};
  for (const name of ["stdout", "stderr"]) {
    const bytes = Buffer.concat(output[name]);
    const fd = fs.openSync(path.join(dir, `${name}.log`), "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    digests[`${name}_digest`] = hash(bytes);
  }
  atomic("receipt.json", {
    spec_digest: expectedDigest, ...result, ...digests, started_at: startedAt, finished_at: Date.now(),
    timed_out: timedOut, cancelled, overflow, ...(error ? { error } : {}),
  });
}
execute().catch(error => { process.stderr.write(`durable command runner: ${error.message}\n`); process.exitCode = 1; });

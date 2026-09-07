import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, identity, digest } from './evidence.mjs';

const MODULE = fileURLToPath(import.meta.url);

export function ensureTestJob(directory, spec) {
  fs.mkdirSync(directory, { recursive: true });
  const jp = path.join(directory, 'job.json');
  const sp = path.join(directory, 'started.json');
  const rp = path.join(directory, 'receipt.json');

  if (fs.existsSync(jp)) {
    if (identity(JSON.parse(fs.readFileSync(jp, 'utf8'))) !== identity(spec))
      throw new Error('job identity mismatch: spec changed');
  } else atomic(jp, spec);

  if (fs.existsSync(rp)) {
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    validate(r, spec);
    return r;
  }

  // Live worker: don't spawn another, return null (poller will retry)
  if (fs.existsSync(sp)) {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (alive(s.worker_pid, s.worker_start)) return null;
  }
  // Stale marker or fresh: delegate to locked executor (never write receipt outside lock)
  const c = spawn('flock', ['-n', path.join(directory, 'job.lock'),
    process.execPath, MODULE, '--execute', directory], { detached: true, stdio: 'ignore' });
  c.on('error', (e) => {
    try { atomic(rp, infraReceipt(spec, new Date().toISOString(), null, `spawn error: ${e.message}`)); } catch {}
  });
  c.unref();
  return null;
}

function validate(r, spec) {
  if (r.job_digest !== identity(spec))
    throw new Error('job_digest mismatch');
  if (r.name !== spec.name)
    throw new Error('name mismatch');
  if (r.commit !== spec.commit || r.tree !== spec.tree)
    throw new Error('identity mismatch');
  if (r.spec_digest !== identity(spec.check))
    throw new Error('spec_digest mismatch');
  if (r.runner_digest !== digest(fs.readFileSync(MODULE)))
    throw new Error('runner_digest mismatch');
  if (JSON.stringify(r.argv) !== JSON.stringify(spec.check.argv))
    throw new Error('argv mismatch');
  if (r.log_path) {
    try {
      const st = fs.statSync(r.log_path);
      if (!st.isFile()) throw new Error('log_path not a regular file');
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('log_path missing: ENOENT ' + r.log_path);
      throw e;
    }
    if (digest(fs.readFileSync(r.log_path)) !== r.log_digest)
      throw new Error('log_digest mismatch');
  }
  if (r.status === 'passed') {
    if (r.exit_code !== 0) throw new Error('passed receipt requires exit_code 0');
    if (r.signal != null) throw new Error('passed receipt must have no signal');
    if (!r.log_path) throw new Error('passed receipt requires log_path');
  }
}

export function processIdentity(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const idx = raw.lastIndexOf(') ');
    if (idx < 0) return null;
    const fields = raw.slice(idx + 2).split(' ');
    if (fields[0] === 'Z') return null;
    const starttime = fields[19] || null;
    if (!starttime) return null;
    const boot_id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `${boot_id}:${starttime}`;
  } catch { return null; }
}

function alive(pid, start) {
  try { process.kill(pid, 0); } catch { return false; }
  if (start == null) return false;
  const current = processIdentity(pid);
  if (current === null) return false;
  return String(current) === String(start);
}

// Direct-entry guard: import never executes
if (process.argv[2] === '--execute' && process.argv[1] && path.resolve(process.argv[1]) === MODULE) {
  try { execute(process.argv[3]); }
  catch (e) {
    try {
      const dir = process.argv[3];
      const spec = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
      atomic(path.join(dir, 'receipt.json'), infraReceipt(spec, new Date().toISOString(), null, `CLI error: ${e.message}`));
    } catch {}
  }
}

function execute(dir) {
  const rp = path.join(dir, 'receipt.json');
  if (fs.existsSync(rp)) return; // double-check inside lock
  const sp = path.join(dir, 'started.json');
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));

  if (fs.existsSync(sp)) {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (alive(s.worker_pid, s.worker_start)) return; // worker still running
    // Stale: recover inside lock
    let surviving_child = null;
    if (s.child_pid != null) {
      const cStart = processIdentity(s.child_pid);
      if (cStart !== null && (s.child_start == null || String(cStart) === String(s.child_start)))
        surviving_child = { pid: s.child_pid, start: s.child_start ?? null };
    }
    const error = surviving_child
      ? `interrupted: surviving child pid ${surviving_child.pid}`
      : 'interrupted worker: recovered';
    const receipt = infraReceipt(spec, s.started_at, null, error);
    if (surviving_child) receipt.surviving_child = surviving_child;
    atomic(rp, receipt);
    return;
  }

  const startedAt = new Date().toISOString();
  const myStart = processIdentity(process.pid);
  atomic(sp, { worker_pid: process.pid, worker_start: myStart, started_at: startedAt });

  // Pre-test source check
  let preClean;
  try { preClean = sourceClean(spec); } catch (e) {
    atomic(rp, infraReceipt(spec, startedAt, null, `pre-test git error: ${e.message}`));
    return;
  }
  if (!preClean) {
    atomic(rp, infraReceipt(spec, startedAt, null, 'source drift: pre-test dirty or HEAD/tree mismatch'));
    return;
  }

  fs.mkdirSync(spec.home, { recursive: true });
  const log = path.join(dir, 'test.log');
  const fd = fs.openSync(log, 'w');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: spec.home,
    TMPDIR: process.env.TMPDIR || '/tmp', CI: '1',
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS || '4'
  };
  const timeoutMs = spec.check.timeout_ms ?? 600000;
  const cwd = path.resolve(spec.repo, spec.check.cwd ?? '.');

  let child;
  try {
    child = spawn(spec.check.argv[0], spec.check.argv.slice(1), {
      cwd, env, detached: true, stdio: ['ignore', fd, fd]
    });
  } catch (e) {
    fs.fsyncSync(fd); fs.closeSync(fd);
    atomic(rp, infraReceipt(spec, startedAt, log, `spawn failed: ${e.message}`));
    return;
  }

  atomic(sp, { worker_pid: process.pid, worker_start: myStart, started_at: startedAt, child_pid: child.pid, child_start: processIdentity(child.pid) });

  let timedOut = false, done = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, timeoutMs);

  child.on('error', e => {
    if (done) return; done = true; clearTimeout(timer);
    try { fs.fsyncSync(fd); } catch {}
    try { fs.closeSync(fd); } catch {}
    atomic(rp, infraReceipt(spec, startedAt, log, `spawn error: ${e.message}`));
  });

  child.on('close', (code, signal) => {
    if (done) return; done = true; clearTimeout(timer);
    fs.fsyncSync(fd); fs.closeSync(fd);
    // Kill remaining process group members to prevent leaks
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    let postClean;
    try { postClean = sourceClean(spec); } catch (e) {
      atomic(rp, infraReceipt(spec, startedAt, log, `post-test git error: ${e.message}`));
      return;
    }
    const status = timedOut ? 'infrastructure_failed'
      : signal != null ? 'infrastructure_failed'
      : !postClean ? 'infrastructure_failed'
      : code === 0 ? 'passed' : 'failed';
    const buf = fs.readFileSync(log);
    atomic(rp, {
      name: spec.name, commit: spec.commit, tree: spec.tree,
      spec_digest: identity(spec.check), job_digest: identity(spec),
      runner_digest: digest(fs.readFileSync(MODULE)), argv: spec.check.argv,
      started_at: startedAt, finished_at: new Date().toISOString(),
      log_path: log, log_digest: digest(buf), tail: buf.slice(-2000).toString(),
      exit_code: code, signal, status,
      error: timedOut ? 'timeout' : signal != null ? `killed by signal ${signal}` : !postClean ? 'source drift' : undefined
    });
  });
}

function git(spec, ...args) {
  const r = spawnSync('git', ['-C', spec.repo, ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout || '';
}

function sourceClean(spec) {
  if (git(spec, 'status', '--porcelain').trim() !== '') return false;
  if (git(spec, 'rev-parse', 'HEAD').trim() !== spec.commit) return false;
  if (git(spec, 'rev-parse', 'HEAD^{tree}').trim() !== spec.tree) return false;
  return true;
}

function infraReceipt(spec, startedAt, logPath, error) {
  const r = {
    name: spec.name, commit: spec.commit, tree: spec.tree,
    spec_digest: identity(spec.check), job_digest: identity(spec),
    runner_digest: digest(fs.readFileSync(MODULE)), argv: spec.check.argv,
    started_at: startedAt, finished_at: new Date().toISOString(),
    exit_code: null, signal: null, status: 'infrastructure_failed', error
  };
  if (logPath && fs.existsSync(logPath)) {
    const buf = fs.readFileSync(logPath);
    r.log_path = logPath; r.log_digest = digest(buf); r.tail = buf.slice(-2000).toString();
  }
  return r;
}

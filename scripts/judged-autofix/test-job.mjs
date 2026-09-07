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

  if (fs.existsSync(sp)) {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (alive(s.worker_pid)) return null;
    const childAlive = s.child_pid != null && alive(s.child_pid);
    const r = {
      name: spec.name, commit: spec.commit, tree: spec.tree,
      spec_digest: identity(spec.check), job_digest: identity(spec),
      runner_digest: digest(fs.readFileSync(MODULE)), argv: spec.check.argv,
      started_at: s.started_at, finished_at: new Date().toISOString(),
      exit_code: null, signal: null, status: 'infrastructure_failed',
      error: childAlive ? `interrupted: surviving child pid ${s.child_pid}` : 'interrupted worker'
    };
    atomic(rp, r);
    return r;
  }

  const c = spawn('flock', ['-n', path.join(directory, 'job.lock'),
    process.execPath, MODULE, '--execute', directory], { detached: true, stdio: 'ignore' });
  c.unref();
  return null;
}

function validate(r, spec) {
  if (r.commit !== spec.commit || r.tree !== spec.tree)
    throw new Error('identity mismatch');
  if (r.spec_digest !== identity(spec.check))
    throw new Error('spec_digest mismatch');
  if (r.log_path && fs.existsSync(r.log_path) && digest(fs.readFileSync(r.log_path)) !== r.log_digest)
    throw new Error('log_digest mismatch');
  if (digest(fs.readFileSync(MODULE)) !== r.runner_digest)
    throw new Error('runner_digest mismatch');
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

if (process.argv[2] === '--execute') execute(process.argv[3]);

function execute(dir) {
  const rp = path.join(dir, 'receipt.json');
  if (fs.existsSync(rp)) return;
  const sp = path.join(dir, 'started.json');
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));

  if (fs.existsSync(sp)) {
    const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
    atomic(rp, infraReceipt(spec, s.started_at, null, 'interrupted worker: recovered'));
    return;
  }

  const startedAt = new Date().toISOString();
  atomic(sp, { worker_pid: process.pid, started_at: startedAt });

  if (git(spec, 'rev-parse', 'HEAD').trim() !== spec.commit ||
      git(spec, 'rev-parse', 'HEAD^{tree}').trim() !== spec.tree) {
    atomic(rp, infraReceipt(spec, startedAt, null, 'source drift: pre-test git state mismatch'));
    return;
  }

  fs.mkdirSync(spec.home, { recursive: true });
  const log = path.join(dir, 'test.log');
  const fd = fs.openSync(log, 'w');
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin', HOME: spec.home,
    TMPDIR: process.env.TMPDIR || '/tmp', CI: '1',
    VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS || '1'
  };

  let child;
  try {
    child = spawn(spec.check.argv[0], spec.check.argv.slice(1), {
      cwd: path.resolve(spec.repo, spec.check.cwd), env,
      detached: true, stdio: ['ignore', fd, fd]
    });
  } catch (e) {
    fs.fsyncSync(fd); fs.closeSync(fd);
    atomic(rp, infraReceipt(spec, startedAt, log, `spawn failed: ${e.message}`));
    return;
  }

  atomic(sp, { worker_pid: process.pid, started_at: startedAt, child_pid: child.pid });

  let timedOut = false, done = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, spec.check.timeout_ms);

  child.on('error', e => {
    if (done) return; done = true; clearTimeout(timer);
    try { fs.fsyncSync(fd); } catch {}
    try { fs.closeSync(fd); } catch {}
    atomic(rp, infraReceipt(spec, startedAt, log, `spawn error: ${e.message}`));
  });

  child.on('close', (code, signal) => {
    if (done) return; done = true; clearTimeout(timer);
    fs.fsyncSync(fd); fs.closeSync(fd);
    const clean = sourceClean(spec);
    const status = timedOut || !clean ? 'infrastructure_failed' : code === 0 ? 'passed' : 'failed';
    const buf = fs.readFileSync(log);
    atomic(rp, {
      name: spec.name, commit: spec.commit, tree: spec.tree,
      spec_digest: identity(spec.check), job_digest: identity(spec),
      runner_digest: digest(fs.readFileSync(MODULE)), argv: spec.check.argv,
      started_at: startedAt, finished_at: new Date().toISOString(),
      log_path: log, log_digest: digest(buf), tail: buf.slice(-2000).toString(),
      exit_code: code, signal, status,
      error: timedOut ? 'timeout' : !clean ? 'source drift' : undefined
    });
  });
}

function git(spec, ...args) {
  const r = spawnSync('git', ['-C', spec.repo, ...args], { encoding: 'utf8' });
  return r.stdout || '';
}

function sourceClean(spec) {
  return git(spec, 'status', '--porcelain').trim() === '';
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

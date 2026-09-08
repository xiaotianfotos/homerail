#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ALLOWED = ['evidence.mjs', 'model.mjs', 'loop.mjs', 'test-job.mjs'];

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function assertClean(repo) {
  const status = git(repo, 'status', '--porcelain');
  if (status) throw new Error(`repository dirty: ${status.slice(0, 200)}`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function identity(files) {
  const keys = Object.keys(files).sort();
  return sha256(Buffer.from(keys.map(k => `${k}\0${files[k]}`).join('\0')));
}

export function freezeEngine(taskRoot) {
  taskRoot = path.resolve(taskRoot);
  const config = JSON.parse(fs.readFileSync(path.join(taskRoot, 'config.json'), 'utf8'));
  if (!path.isAbsolute(config.repo)) throw new Error('repo must be an absolute path');
  const repo = fs.realpathSync(config.repo);
  taskRoot = fs.realpathSync(taskRoot);

  const rel = path.relative(repo, taskRoot);
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep))) throw new Error('taskRoot must be outside repository');

  assertClean(repo);

  if (fs.lstatSync(taskRoot).isSymbolicLink()) throw new Error('taskRoot is a symlink');
  { const _ep = path.join(taskRoot, 'engines'); try { if (fs.lstatSync(_ep).isSymbolicLink()) throw new Error('engines parent is a symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const stateFile = path.join(taskRoot, 'state.json');
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.phase && !['ready', 'judging'].includes(state.phase)) {
      throw new Error(`cannot freeze during active phase: ${state.phase}`);
    }
  }

  const sourceCommit = git(repo, 'rev-parse', 'HEAD');

  const srcDir = path.join(repo, 'scripts', 'judged-autofix');
  const files = {};
  const buffers = {};
  for (const name of ALLOWED) {
    const fp = path.join(srcDir, name);
    let stat;
    try { stat = fs.lstatSync(fp); } catch { throw new Error(`${name} not found in source`); }
    if (stat.isSymbolicLink()) throw new Error(`${name} is a symlink in source`);
    if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
    const buf = fs.readFileSync(fp);
    files[name] = sha256(buf);
    buffers[name] = buf;
  }

  const id = identity(files);
  const engineDir = path.join(taskRoot, 'engines', id);

  if (fs.existsSync(engineDir)) {
    for (const name of ALLOWED) {
      const ep = path.join(engineDir, name);
      let st;
      try { st = fs.lstatSync(ep); } catch { throw new Error(`existing engine file missing: ${name}`); }
      if (st.isSymbolicLink()) throw new Error(`existing engine file ${name} is a symlink`);
      if (!st.isFile()) throw new Error(`existing engine file ${name} is not regular`);
      if (sha256(fs.readFileSync(ep)) !== files[name]) throw new Error(`version directory collision for ${name}`);
    }
  } else {
    const tmpDir = path.join(taskRoot, 'engines', `.${id}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    for (const name of ALLOWED) {
      const fp = path.join(tmpDir, name);
      fs.writeFileSync(fp, buffers[name], { mode: 0o600 });
      const fd = fs.openSync(fp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    { const fd = fs.openSync(tmpDir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    fs.mkdirSync(path.dirname(engineDir), { recursive: true, mode: 0o700 });
    fs.renameSync(tmpDir, engineDir);
    { const fd = fs.openSync(path.dirname(engineDir), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }

  const entrySrc = path.join(srcDir, 'entry.mjs');
  const entryBuf = fs.readFileSync(entrySrc);

  assertClean(repo);
  const headAfter = git(repo, 'rev-parse', 'HEAD');
  if (headAfter !== sourceCommit) throw new Error('HEAD changed during freeze');

  const runTmp = path.join(taskRoot, `.run.mjs.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(runTmp, entryBuf, { mode: 0o600 });
  { const fd = fs.openSync(runTmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  fs.renameSync(runTmp, path.join(taskRoot, 'run.mjs'));

  const manifest = { directory: engineDir, files, source_commit: sourceCommit };
  const manifestTmp = path.join(taskRoot, `.engine.json.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  { const fd = fs.openSync(manifestTmp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  fs.renameSync(manifestTmp, path.join(taskRoot, 'engine.json'));
  { const fd = fs.openSync(taskRoot, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

  return manifest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const arg = process.argv[2];
  if (!arg) { process.stderr.write('usage: freeze.mjs <taskRoot>\n'); process.exit(1); }
  const manifest = freezeEngine(arg);
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

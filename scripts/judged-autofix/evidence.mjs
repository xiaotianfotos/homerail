import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
}
export const identity = value => digest(JSON.stringify(stable(value)));
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args[0]} failed (${result.status}): ${String(result.stderr || result.error).slice(-1500)}`);
  return result.stdout;
}
export function safePath(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/.test(name) || name.split('/').some(x => !x || x === '..' || x === '.' || x === '.git')) throw new Error('invalid repository path');
  return name;
}
export function validatePlan(plan) {
  if (plan.version !== 1 || !/^[a-z][a-z0-9-]{0,60}$/.test(plan.id)) throw new Error('invalid plan identity');
  if (!/^[a-f0-9]{40}$/.test(plan.base_sha)) throw new Error('pin base_sha');
  if (!/^sha256:[a-f0-9]{64}$/.test(plan.image)) throw new Error('pin Docker image by immutable ID');
  if (!Array.isArray(plan.writable_paths) || !plan.writable_paths.length || plan.writable_paths.length > 8) throw new Error('invalid write scope');
  plan.writable_paths.forEach(safePath);
  if (new Set(plan.writable_paths).size !== plan.writable_paths.length) throw new Error('duplicate write scope');
  if (!plan.objective || !plan.setting_id || !plan.manager_url) throw new Error('missing model task configuration');
  if (!Array.isArray(plan.test_argv) || !plan.test_argv.length || !plan.test_argv.every(x => typeof x === 'string' && x && !x.includes('\0'))) throw new Error('invalid test argv');
  if (!Number.isInteger(plan.test_timeout_seconds) || plan.test_timeout_seconds < 1 || plan.test_timeout_seconds > 120) throw new Error('invalid test timeout');
  if (!Number.isInteger(plan.max_model_attempts) || plan.max_model_attempts < 1 || plan.max_model_attempts > 20) throw new Error('invalid attempt allowance');
  if (!/^refs\/heads\/[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$/.test(plan.publish_ref)) throw new Error('invalid publication ref');
  if (!path.isAbsolute(plan.source_repo) || !path.isAbsolute(plan.publish_repo)) throw new Error('local repositories must be absolute');
  return plan;
}
export class Repository {
  constructor(root, gitBin = 'git') { this.root = root; this.gitBin = gitBin; }
  git(args, options = {}) { return command(this.gitBin, ['-C', this.root, ...args], options).trimEnd(); }
  entries(tree) {
    return this.git(['ls-tree', '-rz', tree]).split('\0').filter(Boolean).map(line => {
      const [meta, name] = line.split('\t'); const [mode, type, sha] = meta.split(' ');
      safePath(name);
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('POC accepts only regular source files');
      return { path: name, mode, sha };
    });
  }
  bytes(sha) { return command(this.gitBin, ['-C', this.root, 'cat-file', 'blob', sha], { encoding: 'buffer' }); }
  manifest(tree) { return this.entries(tree).map(({ path: name, mode, sha }) => ({ path: name, mode, content: this.bytes(sha).toString('utf8') })); }
  apply(baseTree, proposal, allowed) {
    if (!proposal || !Array.isArray(proposal.files) || proposal.files.length < 1 || proposal.files.length > allowed.length) throw new Error('invalid candidate files');
    const names = new Set(); let bytes = 0;
    for (const file of proposal.files) {
      safePath(file.path);
      if (!allowed.includes(file.path) || names.has(file.path) || typeof file.content !== 'string') throw new Error('candidate outside scope or duplicate');
      names.add(file.path); bytes += Buffer.byteLength(file.content);
    }
    if (bytes > 10 * 1024 * 1024) throw new Error('candidate exceeds 10 MiB');
    const index = path.resolve(this.root, this.git(['rev-parse', '--git-path', `judged-index-${crypto.randomUUID()}`]));
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      this.git(['read-tree', baseTree], { env });
      const modes = new Map(this.entries(baseTree).map(x => [x.path, x.mode]));
      for (const file of proposal.files) {
        const blob = this.git(['hash-object', '-w', '--stdin'], { input: file.content });
        this.git(['update-index', '--add', '--cacheinfo', modes.get(file.path) ?? '100644', blob, file.path], { env });
      }
      return this.git(['write-tree'], { env });
    } finally { fs.rmSync(index, { force: true }); }
  }
  snapshot(tree, root) {
    if (fs.existsSync(root)) { this.verify(tree, root); return; }
    const tmp = root + '.' + crypto.randomUUID(); fs.mkdirSync(tmp, { recursive: true });
    for (const e of this.entries(tree)) {
      const target = path.join(tmp, e.path); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, this.bytes(e.sha), { mode: e.mode === '100755' ? 0o755 : 0o644 });
    }
    fs.renameSync(tmp, root); this.verify(tree, root);
  }
  verify(tree, root) {
    const expected = this.entries(tree); const found = [];
    function walk(dir, prefix = '') {
      for (const name of fs.readdirSync(dir)) {
        const relative = prefix + name; const stat = fs.lstatSync(path.join(dir, name));
        if (stat.isSymbolicLink()) throw new Error('snapshot symlink');
        if (stat.isDirectory()) walk(path.join(dir, name), relative + '/');
        else if (stat.isFile()) found.push(relative); else throw new Error('snapshot special file');
      }
    }
    walk(root);
    if (JSON.stringify(found.sort()) !== JSON.stringify(expected.map(e => e.path).sort())) throw new Error('snapshot inventory mismatch');
    for (const e of expected) {
      const file = path.join(root, e.path);
      if (!fs.readFileSync(file).equals(this.bytes(e.sha))) throw new Error('snapshot content mismatch');
    }
  }
}
export function assertReceipt(receipt, candidate, planDigest, image, testArgv) {
  if (!receipt || receipt.status !== 'passed' || receipt.exit_code !== 0 || receipt.tree !== candidate.tree || receipt.plan_digest !== planDigest || receipt.image !== image || identity(receipt.argv) !== identity(testArgv)) throw new Error('no trusted passing receipt for candidate');
}

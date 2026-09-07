import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomic, identity, command, Repository, assertReceipt, validatePlan } from './core.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-resume-tests-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = path.join(root, 'source');
command('git', ['init', source]);
const repo = new Repository(source);
repo.git(['config', 'user.name', 'test']); repo.git(['config', 'user.email', 'test@localhost']);
fs.writeFileSync(path.join(source, 'code.mjs'), 'export const value = 0;\n');
fs.writeFileSync(path.join(source, 'tests.mjs'), 'immutable tests\n');
repo.git(['add', '.']); repo.git(['update-index', '--chmod=+x', 'tests.mjs']); repo.git(['commit', '-m', 'base']);
const base = repo.git(['rev-parse', 'HEAD^{tree}']);
const candidate = { files: [{ path: 'code.mjs', content: 'export const value = 1;\n' }], summary: 'fixed' };

test('trusted proposal application preserves exact bytes and index modes', () => {
  const tree = repo.apply(base, candidate, ['code.mjs']);
  assert.notEqual(tree, base);
  const files = repo.manifest(tree);
  assert.equal(files.find(f => f.path === 'code.mjs').content, candidate.files[0].content);
  assert.equal(files.find(f => f.path === 'tests.mjs').content, 'immutable tests\n');
  assert.equal(files.find(f => f.path === 'tests.mjs').mode, '100755');
  assert.equal(repo.git(['rev-parse', 'HEAD^{tree}']), base);
});
for (const [name, files] of [
  ['scope', [{ path: 'tests.mjs', content: 'weakened' }]],
  ['traversal', [{ path: '../receipt.json', content: '{}' }]],
  ['metadata', [{ path: '.git/config', content: 'unsafe' }]],
  ['duplicates', [candidate.files[0], candidate.files[0]]],
  ['oversize', [{ path: 'code.mjs', content: 'x'.repeat(65537) }]],
]) test(`rejects ${name} without changing source`, () => {
  assert.throws(() => repo.apply(base, { files }, ['code.mjs']));
  assert.equal(repo.git(['rev-parse', 'HEAD^{tree}']), base);
});
test('snapshot revalidation detects changed bytes, injected files and symlinks', () => {
  const tree = repo.apply(base, candidate, ['code.mjs']);
  for (const kind of ['bytes', 'file', ...(process.platform === 'win32' ? [] : ['symlink'])]) {
    const target = path.join(root, kind); repo.snapshot(tree, target);
    if (kind === 'bytes') fs.writeFileSync(path.join(target, 'code.mjs'), 'tampered');
    if (kind === 'file') fs.writeFileSync(path.join(target, 'receipt.json'), '{"status":"passed"}');
    if (kind === 'symlink') { fs.unlinkSync(path.join(target, 'code.mjs')); fs.symlinkSync('/etc/passwd', path.join(target, 'code.mjs')); }
    assert.throws(() => repo.verify(tree, target));
  }
});
test('passing receipt is bound to source, plan, image and exact argv', () => {
  const c = { tree: 'tree' }, args = ['node', '--test'];
  const r = { status: 'passed', exit_code: 0, tree: 'tree', plan_digest: 'plan', image: 'image', argv: args };
  assert.doesNotThrow(() => assertReceipt(r, c, 'plan', 'image', args));
  for (const patch of [{ status: 'failed' }, { exit_code: 1 }, { tree: 'other' }, { plan_digest: 'other' }, { image: 'other' }, { argv: ['true'] }]) {
    assert.throws(() => assertReceipt({ ...r, ...patch }, c, 'plan', 'image', args));
  }
});
test('atomic replacement preserves readable complete JSON and stable identity', () => {
  const file = path.join(root, 'state.json');
  atomic(file, { previous: 1 }); atomic(file, { next: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { next: 2 });
  assert.equal(identity({ a: 1, b: 2 }), identity({ b: 2, a: 1 }));
});
test('rejects unpinned test runtime and mutable path scope', () => {
  assert.throws(() => validatePlan({ version: 1, id: 'test', base_sha: 'a'.repeat(40), image: 'node:latest' }));
});

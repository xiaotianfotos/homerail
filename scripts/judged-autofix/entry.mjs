#!/usr/bin/env node
// Frozen engine entry point. Uses only Node builtins—no project imports.
// Copied verbatim as taskRoot/run.mjs by freeze.mjs.
// Usage: run.mjs <taskRoot> <operation> [...args]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ALLOWED = ['evidence.mjs', 'model.mjs', 'loop.mjs', 'test-job.mjs'];

function fail(msg) {
  process.stderr.write(`frozen engine integrity failure: ${msg}\n`);
  process.exit(1);
}

const taskRoot = process.argv[2];
if (!taskRoot) fail('missing taskRoot argument');

const root = fs.realpathSync(path.resolve(taskRoot));
const manifestFile = path.join(root, 'engine.json');
if (!fs.existsSync(manifestFile)) fail('engine.json not found');

let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
catch (e) { fail(`engine.json parse error: ${e.message}`); }

// Validate engine directory is not a symlink and is inside real taskRoot/engines
const enginesBase = path.join(root, 'engines');
try { if (fs.lstatSync(root).isSymbolicLink()) fail('taskRoot is a symlink'); } catch (e) { fail('taskRoot not accessible'); }
try { if (fs.lstatSync(enginesBase).isSymbolicLink()) fail('engines parent is a symlink'); } catch (e) { fail('engines base not accessible'); }
const resolvedDir = path.resolve(manifest.directory);
let dirStat;
try { dirStat = fs.lstatSync(resolvedDir); } catch { fail('engine directory not found'); }
if (dirStat.isSymbolicLink()) fail('engine directory is a symlink');
const realEngines = fs.realpathSync(enginesBase);
const realDir = fs.realpathSync(resolvedDir);
if (!realDir.startsWith(realEngines + path.sep)) fail('engine directory outside engines base');

// Validate files are exactly the four allowlisted modules
const fileKeys = Object.keys(manifest.files).sort();
const expected = [...ALLOWED].sort();
if (fileKeys.length !== expected.length || fileKeys.some((k, i) => k !== expected[i])) {
  fail('file set mismatch');
}

// Validate each file: regular, non-symlink, hash matches
for (const name of ALLOWED) {
  const fp = path.join(resolvedDir, name);
  let stat;
  try { stat = fs.lstatSync(fp); } catch { fail(`${name} not found`); }
  if (stat.isSymbolicLink()) fail(`${name} is a symlink`);
  if (!stat.isFile()) fail(`${name} is not a regular file`);
  const buf = fs.readFileSync(fp);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (hash !== manifest.files[name]) fail(`${name} hash mismatch`);
}

// Run frozen loop.mjs with inherited stdio and env
const loopPath = path.join(resolvedDir, 'loop.mjs');
const args = process.argv.slice(3);
const result = spawnSync(process.execPath, [loopPath, root, ...args], {
  stdio: 'inherit'
});

if (result.error) fail(`spawn error: ${result.error.message}`);
process.exit(result.status ?? 1);

// Only Node builtins load before the full frozen runtime inventory is verified.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = relative => {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split('/').some(s => !s || s === '.' || s === '..') || relative.includes('\\')) throw new Error('unsafe runtime inventory path');
  return path.join(root, relative);
};
try {
  const expected = process.argv[2];
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'));
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || digest(bytes) !== expected) throw new Error('frozen runtime manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.node_version !== process.version || !Array.isArray(manifest.entries)) throw new Error('unsupported frozen runtime');
  const entries = new Map();
  for (const entry of manifest.entries) {
    const file = inside(entry.path);
    if (entries.has(entry.path)) throw new Error('duplicate runtime inventory path');
    entries.set(entry.path, entry);
    const stat = fs.lstatSync(file);
    if (entry.link !== undefined) {
      const target = path.resolve(path.dirname(file), entry.link);
      if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.link || !target.startsWith(root + path.sep)) throw new Error('runtime dependency link changed');
    } else if (!stat.isFile() || digest(fs.readFileSync(file)) !== entry.sha256
      || Boolean(stat.mode & 0o111) !== entry.executable) throw new Error('frozen runtime file changed: ' + entry.path);
  }
  const walk = (dir, relative = '') => {
    for (const name of fs.readdirSync(dir)) {
      const key = relative ? relative + '/' + name : name;
      if (key === 'manifest.json') continue;
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isDirectory()) walk(file, key);
      else if (!entries.has(key)) throw new Error('unexpected frozen runtime file: ' + key);
    }
  };
  walk(root);
  if (!entries.has(manifest.entry) || fs.realpathSync(process.execPath) !== path.join(root, 'node')) throw new Error('runtime entry/interpreter mismatch');
  process.argv = [process.execPath, inside(manifest.entry), ...process.argv.slice(3)];
  process.env.HOMERAIL_E2E_FIX_RUNTIME_SHA256 = expected;
  await import(pathToFileURL(inside(manifest.entry)).href);
} catch (error) {
  process.stderr.write('Frozen E2E Fix runtime rejected: ' + String(error) + '\n');
  process.exitCode = 1;
}

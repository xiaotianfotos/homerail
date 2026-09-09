import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './event-supervisor/test_e2e_fix_observation.mjs';

test('Linux durable event supervisor lifecycle and process contracts', {
  skip: process.platform !== 'linux' && 'Requires Linux flock, /proc and user-systemd semantics',
  timeout: 90_000,
}, () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-v'], {
    cwd: fileURLToPath(new URL('./event-supervisor/', import.meta.url)),
    encoding: 'utf8', timeout: 80_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

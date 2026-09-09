import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('local model token admission transport contracts', { skip: process.platform !== 'linux', timeout: 30_000 }, () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_e2e_fix_token_gateway.py', import.meta.url))],
    { encoding: 'utf8', timeout: 25_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

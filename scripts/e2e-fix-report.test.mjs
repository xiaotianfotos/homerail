import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reportTask, summarizeUsage } from './e2e-fix-report.mjs';

const worker = (at, input, output, execution = 'one') => ({ timestamp: at,
  scope: { session_id: 's', round_id: 'r', generation: 1, execution_id: execution },
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 30 } });
test('cumulative snapshots and cached input are not counted twice', () => {
  const rows = [worker(2, 100, 40), worker(1, 80, 20), worker(2, 100, 40), worker(3, 120, 50, 'two')];
  assert.deepEqual(summarizeUsage(rows, 'worker'), { status: 'reported', executions: 2, unknown_records: 0,
    input_tokens: 220, output_tokens: 90, cache_read_input_tokens: 60, total_tokens: 310 });
});
test('host thread totals are cumulative across events, even when turn changes', () => {
  const row = (at, input) => ({ at, thread_id: 't', turn_id: String(at),
    usage: { total: { inputTokens: input, outputTokens: 20, cachedInputTokens: 5 }, last: { inputTokens: 1 } } });
  assert.equal(summarizeUsage([row(1, 10), row(2, 30)], 'host').total_tokens, 50);
});
test('missing, invalid, and conflicting usage never become complete zero-cost claims', () => {
  assert.equal(summarizeUsage([], 'worker').status, 'incomplete');
  assert.equal(summarizeUsage([worker(1, 10, 2), { usage: {} }], 'worker').unknown_records, 2);
  assert.throws(() => summarizeUsage([worker(1, 100, 2), worker(1, 100, 3)], 'worker'), /Conflicting/);
  assert.throws(() => summarizeUsage([worker(2, 100, 2), worker(1, 100, 3)], 'worker'), /decreased/);
  assert.throws(() => summarizeUsage([worker(1, Number.MAX_SAFE_INTEGER, 2)], 'worker'), /safe integer/);
});
test('retained failed Worker attempts contribute known usage without inventing timestamps', () => {
  const row = { session_id: 's', round_id: 'r', execution_id: 'e',
    usage: { input_tokens: 101, output_tokens: 8191, cache_read_input_tokens: 80 } };
  const result = summarizeUsage([row, row], 'worker_failure');
  assert.equal(result.total_tokens, 8292); assert.equal(result.executions, 1);
});
test('report preserves failed host cost and omits private config, prompts and model content', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cost-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { root_run_id: 'root', issue: { number: 289, body: 'private issue' }, secret: 'private credential' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'config.sha256'), createHash('sha256').update(JSON.stringify(config)).digest('hex'));
  const folder = path.join(dir, 'rounds/1/host-codex/plan'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'claim.json'), JSON.stringify({ identity: { session_id: 'session' } }));
  fs.writeFileSync(path.join(folder, 'failure.json'), JSON.stringify({ started: 100, finished: 200, error: 'private output' }));
  fs.writeFileSync(path.join(folder, 'events.jsonl'), JSON.stringify({ event: 'token_usage', at: 150, thread_id: 'thread',
    usage: { total: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 20 } } }) + '\n');
  const report = reportTask(dir), role = report.rounds[0].models[0];
  assert.equal(role.outcome, 'failure_artifact_present'); assert.equal(role.duration_ms, 100);
  assert.equal(role.usage.total_tokens, 60); assert.equal(role.model, null);
  assert.equal(JSON.stringify(report).includes('private '), false);
  fs.writeFileSync(path.join(dir, 'config.sha256'), 'bad');
  assert.throws(() => reportTask(dir), /Policy digest mismatch/);
});

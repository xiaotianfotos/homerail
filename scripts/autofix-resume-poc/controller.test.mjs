import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import { Task, TEST_BOOTSTRAP, RUNNER_DIGEST } from './controller.mjs';
import { atomic, command, Repository, identity, digest } from './core.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-controller-tests-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
  const dir = path.join(root, String(++sequence)); fs.mkdirSync(dir);
  const source = path.join(dir, 'source'), published = path.join(dir, 'published.git');
  command('git', ['init', '--initial-branch=main', source]); const repo = new Repository(source);
  repo.git(['config', 'user.name', 'test']); repo.git(['config', 'user.email', 'test@localhost']);
  fs.writeFileSync(path.join(source, 'code.mjs'), 'export const value = 0;\n');
  fs.writeFileSync(path.join(source, 'test.mjs'), 'immutable acceptance\n');
  repo.git(['add', '.']); repo.git(['commit', '-m', 'baseline']); command('git', ['clone', '--bare', source, published]);
  const plan = { version: 1, id: `test-${sequence}`, source_repo: source, publish_repo: published, base_sha: repo.git(['rev-parse','HEAD']), publish_ref: 'refs/heads/main', image: `sha256:${'a'.repeat(64)}`, writable_paths: ['code.mjs'], objective: 'fix value', setting_id: 'test', manager_url: 'http://localhost:1', test_argv: ['node','--test','test.mjs'], test_timeout_seconds: 10, max_model_attempts: 3 };
  atomic(path.join(dir, 'plan.json'), plan); const task = new Task(dir); task.initialize(); return task;
}
function active(task, state = 'running') {
  const a = { index: 1, kind: 'propose', state, workflow_id: 'workflow', requested_run_id: 'run', run_id: state === 'running' ? 'run' : undefined };
  task.s.phase = 'propose'; task.s.attempts = [a]; task.s.active_model = a; task.save('unit_fixture'); return a;
}
function modelReplies(t, result, { terminal = true, listed = [] } = {}) {
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname; calls.push({ route, method: options.method });
    let value;
    if (route === '/api/runs') value = { runs: listed };
    else if (route.endsWith('/status')) value = { terminal, status: terminal ? 'completed' : 'active', created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z', counters: {} };
    else if (route.endsWith('/chat')) value = { messages: [] };
    else if (route.endsWith('/artifacts')) value = { artifacts: [{ name: 'result.json', status: 'ready' }] };
    else if (route.endsWith('/content')) return new Response(JSON.stringify(result));
    else throw new Error(`unexpected ${route}`);
    return new Response(JSON.stringify({ data: value }));
  }); return calls;
}
test('lost submission response adopts existing run without a second POST', async t => {
  const task = fixture(); active(task, 'submitting');
  const calls = modelReplies(t, null, { terminal: false, listed: [{ workflowId: 'workflow', runId: 'run' }] });
  await task.step(); assert.equal(task.s.active_model.run_id, 'run'); assert.equal(task.s.attempts.length, 1);
  assert(calls.every(c => c.method === 'GET'));
});
test('unresolvable submission pauses durably instead of blind model resubmission', async t => {
  const task = fixture(); const original = task.s.candidate.tree; active(task, 'submitting');
  const calls = modelReplies(t, null);
  for (let n = 0; n < 3; n++) await new Task(task.root).step();
  const resumed = new Task(task.root); await resumed.step();
  assert.equal(resumed.s.phase, 'needs_attention'); assert.equal(resumed.s.candidate.tree, original);
  assert.equal(resumed.s.attempts.length, 1); assert(calls.every(c => c.method === 'GET'));
});
test('accepted proposal survives a new controller process with exact candidate bytes', async t => {
  const task = fixture(); active(task);
  modelReplies(t, { files: [{ path: 'code.mjs', content: 'export const value = 1;\n' }], summary: 'fix' });
  await task.step(); const resumed = new Task(task.root); resumed.initialize();
  assert.equal(resumed.s.phase, 'test'); assert.equal(resumed.s.attempts.length, 1);
  assert.equal(resumed.repo.manifest(resumed.s.candidate.tree).find(f => f.path === 'code.mjs').content, 'export const value = 1;\n');
});
test('invalid model result keeps candidate and provides next-attempt feedback', async t => {
  const task = fixture(); const tree = task.s.candidate.tree; active(task);
  modelReplies(t, { files: [{ path: 'test.mjs', content: 'weakened' }], summary: 'bad' });
  await task.step(); assert.equal(task.s.candidate.tree, tree); assert.equal(task.s.attempts[0].state, 'rejected');
  assert.equal(task.s.feedback.category, 'invalid_model_result'); assert.equal(task.s.active_model, undefined);
});
test('identical proposal pauses without consuming the remaining allowance', async t => {
  const task = fixture(); active(task);
  modelReplies(t, { files: [{ path: 'code.mjs', content: 'export const value = 0;\n' }], summary: 'no change' });
  await task.step(); assert.equal(task.s.phase, 'needs_attention'); assert.equal(task.s.events.at(-1).event, 'stagnation');
});
test('attempt exhaustion retains the current candidate without another request', async () => {
  const task = fixture(); task.s.phase = 'propose'; task.s.attempts = [{},{},{}]; task.save('unit_fixture');
  await task.step(); assert.equal(task.s.phase, 'needs_attention'); assert.equal(task.s.events.at(-1).event, 'model_allowance_exhausted');
});
function ready(task) {
  const tree = task.repo.apply(task.s.candidate.tree, { files: [{ path: 'code.mjs', content: 'export const value = 1;\n' }] }, ['code.mjs']);
  task.s.candidate = { tree }; task.repo.snapshot(tree, path.join(task.root, 'snapshots', tree));
  const log = 'unit fixture only; not live evidence\n';
  const receipt = { version: 1, runner_digest: RUNNER_DIGEST, tree, plan_digest: task.planDigest, image: task.plan.image, argv: task.plan.test_argv, status: 'passed', exit_code: 0, log_sha256: digest(log) };
  const file = path.join(task.root, 'receipt.json'); atomic(file, receipt); fs.writeFileSync(file + '.log', log);
  task.s.best_verified = { tree, receipt_path: file, receipt_digest: identity(receipt) };
  task.s.reviews = [{ tree, result: { verdict: 'clean', findings: [] } }]; task.s.phase = 'publish'; task.save('unit_fixture');
}
test('publication re-entry creates one commit and reuses the persisted publication intent', async () => {
  const task = fixture(); ready(task); await task.step(); const commit = task.s.publication.commit;
  // Simulate controller state before acknowledgment while actual ref already changed.
  task.s.phase = 'publish'; task.save('unit_lost_ack'); const resumed = new Task(task.root); await resumed.step();
  assert.equal(resumed.s.publication.commit, commit); assert.equal(resumed.s.events.at(-1).event, 'publication_reconciled');
  assert.equal(new Repository(task.plan.publish_repo).git(['rev-list','--count',task.plan.base_sha+'..main']), '1');
  await resumed.step(); assert.equal(resumed.s.publication.commit, commit);
});
for (const kind of ['log', 'receipt', 'snapshot']) test(`publication rejects changed ${kind}`, async () => {
  const task = fixture(); ready(task);
  const file = kind === 'log' ? task.s.best_verified.receipt_path + '.log' : kind === 'receipt' ? task.s.best_verified.receipt_path : path.join(task.root,'snapshots',task.s.candidate.tree,'code.mjs');
  fs.appendFileSync(file, kind === 'receipt' ? '\n{}' : 'tamper');
  await assert.rejects(task.step()); assert.equal(new Repository(task.plan.publish_repo).git(['rev-parse','main']), task.plan.base_sha);
});
test('publication head drift pauses without overwriting another commit', async () => {
  const task = fixture(); ready(task);
  const drift = task.repo.git(['commit-tree',task.s.candidate.tree,'-p',task.plan.base_sha],{input:'external change\n'});
  const remote = new Repository(task.plan.publish_repo); remote.git(['fetch',task.repo.root,drift]); remote.git(['update-ref',task.plan.publish_ref,drift]);
  await task.step(); assert.equal(task.s.phase,'needs_attention'); assert.equal(remote.git(['rev-parse','main']),drift);
});
test('changed immutable plan is rejected on resume', async () => {
  const task = fixture(); atomic(path.join(task.root,'plan.json'), {...task.plan,test_argv:['true']});
  await assert.rejects(new Task(task.root).step(), /immutable plan changed/);
});
test('bootstrap reports setup/spawn failures as infrastructure and restores Git modes inside tmpfs', () => {
  for (const kind of ['setup', 'spawn', 'pass']) {
    const modes = []; let exit; let spawned = false;
    const source = { cpSync() { if (kind === 'setup') throw new Error('EACCES'); }, chmodSync(file, mode) { modes.push([file,mode]); } };
    const cp = { spawnSync(bin,args,opts) { spawned = true; assert.equal(opts.cwd,'/work/repo'); return kind === 'spawn' ? {status:null,error:new Error('ENOENT')} : {status:0}; } };
    try { vm.runInNewContext(TEST_BOOTSTRAP, {require: n => n === 'fs' ? source : cp,console:{error(){}},process:{argv:['node',JSON.stringify(['node','--test']),JSON.stringify([{path:'code.mjs',mode:'100644'}])],exit(code){exit=code;throw new Error('exit');}}}); }
    catch(e) { assert.equal(e.message,'exit'); }
    assert.equal(exit,kind === 'pass' ? 0 : 125); assert.equal(spawned,kind !== 'setup');
    if(kind !== 'setup') assert.deepEqual(modes,[['/work/repo/code.mjs',0o644]]);
  }
});

test('a second CLI controller cannot acquire an already-held task lock', {skip:process.platform !== 'linux'}, async t => {
  const task = fixture(); const before = fs.readFileSync(task.stateFile);
  const lock = spawn('flock',['-n',path.join(task.root,'controller.lock'),process.execPath,'-e',"process.stdout.write('locked');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
  t.after(()=>lock.kill()); await once(lock.stdout,'data');
  const r = spawnSync(process.execPath,[fileURLToPath(new URL('./controller.mjs',import.meta.url)),task.root],{encoding:'utf8',timeout:3000});
  assert.equal(r.status,1); assert(fs.readFileSync(task.stateFile).equals(before));
  // Terminate the lock holder's child, too: flock alone does not forward SIGTERM.
  const descendants = command('pgrep',['-P',String(lock.pid)]).trim().split('\n').filter(Boolean);
  for(const pid of descendants) process.kill(Number(pid),'SIGTERM');
});

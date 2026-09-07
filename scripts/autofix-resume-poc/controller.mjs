#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomic, identity, digest, command, Repository, validatePlan, assertReceipt } from './core.mjs';
import { api, prepareModel, reconcileSubmission, collectModel } from './model.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stamp = () => new Date().toISOString();
export const TEST_BOOTSTRAP = "const fs=require('fs'),cp=require('child_process');try{fs.cpSync('/source','/work/repo',{recursive:true});for(const f of JSON.parse(process.argv[2]))fs.chmodSync('/work/repo/'+f.path,f.mode==='100755'?0o755:0o644);}catch(e){console.error('test setup failed:',e.message);process.exit(125);}const a=JSON.parse(process.argv[1]);const r=cp.spawnSync(a[0],a.slice(1),{cwd:'/work/repo',stdio:'inherit'});if(r.error)console.error(r.error.message);process.exit(r.status===null?125:r.status);";
export const RUNNER_DIGEST = identity({ bootstrap: TEST_BOOTSTRAP, tmpfs: "/work:rw,exec,nosuid,size=64m,mode=1777", network: "none", memory: "256m", cpus: 1 });
function inspect(name) {
  const r = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
  if (r.status === 0) return JSON.parse(r.stdout)[0];
  if (/No such (object|container)/i.test(r.stderr)) return null;
  throw new Error(`Docker unavailable: ${r.stderr.slice(-500)}`);
}
export class Task {
  constructor(root) {
    this.root = path.resolve(root); this.plan = validatePlan(read(path.join(this.root, 'plan.json')));
    this.planDigest = identity(this.plan); this.stateFile = path.join(this.root, 'state.json');
    this.repo = new Repository(path.join(this.root, 'objects'));
  }
  save(event, extra = {}) {
    this.s.events.push({ at: stamp(), event, ...extra });
    atomic(this.stateFile, this.s);
  }
  initialize() {
    if (fs.existsSync(this.stateFile)) {
      this.s = read(this.stateFile);
      if (this.s.version !== 1 || this.s.plan_digest !== this.planDigest) throw new Error('immutable plan changed');
      return;
    }
    if (!fs.existsSync(this.repo.root)) command('git', ['clone', '--no-checkout', '--', this.plan.source_repo, this.repo.root]);
    this.repo.git(['config', 'user.name', 'HomeRail continuation POC']);
    this.repo.git(['config', 'user.email', 'poc@localhost']);
    const baseTree = this.repo.git(['rev-parse', this.plan.base_sha + '^{tree}']);
    const publication = new Repository(this.plan.publish_repo, this.plan.publication_git_bin ?? 'git');
    const remoteHead = publication.git(['rev-parse', this.plan.publish_ref]);
    if (remoteHead !== this.plan.base_sha) throw new Error('publication base drift');
    this.s = { version: 1, task_nonce: crypto.randomUUID().slice(0,8), plan_digest: this.planDigest, phase: 'test', created_at: stamp(), candidate: { tree: baseTree, source: 'baseline' }, candidates: [], attempts: [], tests: [], reviews: [], events: [], expected_head: remoteHead };
    this.save('initialized');
  }
  modelInput(kind) {
    return { objective: this.plan.objective, writable_paths: this.plan.writable_paths, files: this.repo.manifest(this.s.candidate.tree), candidate_tree: this.s.candidate.tree, test_receipt: this.s.receipt ?? null, failure: this.s.feedback ?? null,
      previous_attempts: this.s.candidates.slice(-4).map(c => ({ tree: c.tree, summary: c.summary, validation: c.validation })), kind };
  }
  async model(kind) {
    let a = this.s.active_model;
    if (!a) {
      if (this.s.attempts.length >= this.plan.max_model_attempts) { this.s.phase = 'needs_attention'; this.save('model_allowance_exhausted'); return; }
      a = { index: this.s.attempts.length + 1, kind, workflow_id: `resume-${this.plan.id}-${this.s.task_nonce}-${this.s.attempts.length + 1}`, state: 'prepared', created_at: stamp(), input_tree: this.s.candidate.tree };
      this.s.attempts.push(a); this.s.active_model = a; this.save('model_intent', { workflow_id: a.workflow_id });
    }
    const dir = path.join(this.root, 'runs', a.workflow_id); fs.mkdirSync(dir, { recursive: true });
    // All attempts and active_model serialize separately; persist both references on each step.
    this.s.attempts[a.index - 1] = a;
    if (a.state === 'prepared') {
      await prepareModel(this.plan, a, this.modelInput(kind));
      atomic(path.join(dir, 'request.json'), a.payload);
      a.state = 'submitting'; this.save('model_submission_intent');
      const started = await api(this.plan, '/api/runs/create-and-run', a.payload);
      a.run_id = started.run_id ?? started.runId;
      if (!a.run_id) throw new Error('Manager omitted run id');
      a.state = 'running'; this.save('model_submitted', { run_id: a.run_id }); return;
    }
    if (a.state === 'submitting') {
      a.run_id = await reconcileSubmission(this.plan, a);
      if (!a.run_id) {
        a.missing_observations = (a.missing_observations ?? 0) + 1;
        if (a.missing_observations >= 3) this.s.phase = 'needs_attention';
        this.save('submission_unresolved', { observations: a.missing_observations, reason: 'Manager create API has no verified idempotency guarantee; never blindly resubmit' }); return;
      }
      a.state = 'running'; this.save('submission_reconciled', { run_id: a.run_id });
    }
    const completed = await collectModel(this.plan, a, dir);
    if (!completed) return;
    a.finished_at = stamp(); a.state = 'completed'; delete this.s.active_model;
    if (completed.failed) {
      a.state = 'failed'; this.s.infrastructure_failures = (this.s.infrastructure_failures ?? 0) + 1;
      if (this.s.infrastructure_failures >= 3) this.s.phase = 'needs_attention';
      this.save('model_run_failed', { run_id: a.run_id }); return;
    }
    a.result_digest = identity(completed.value);
    try {
    if (kind === 'review') {
      const v = completed.value;
      if (!['clean', 'changes_requested'].includes(v.verdict) || (v.verdict === 'clean') !== (v.findings.length === 0)) throw new Error('inconsistent review verdict');
      this.s.reviews.push({ tree: this.s.candidate.tree, result: v, run_id: a.run_id });
      if (v.verdict === 'clean') { this.s.phase = 'publish'; }
      else { this.s.feedback = { category: 'review', findings: v.findings }; this.s.phase = 'propose'; }
      this.save('review_accepted'); return;
    }
    const tree = this.repo.apply(this.s.candidate.tree, completed.value, this.plan.writable_paths);
    if (tree === this.s.candidate.tree || this.s.candidates.some(c => c.tree === tree && c.validation === 'failed')) {
      this.s.phase = 'needs_attention'; this.save('stagnation', { tree, run_id: a.run_id }); return;
    }
    this.s.candidate = { tree, run_id: a.run_id, summary: completed.value.summary };
    this.s.candidates.push(this.s.candidate); this.s.receipt = null; this.s.phase = 'test';
    this.save('candidate_accepted', { tree });
    } catch (e) {
      a.state = 'rejected'; a.rejection = e.message;
      this.s.feedback = { category: 'invalid_model_result', message: e.message, run_id: a.run_id };
      this.save('model_result_rejected', { run_id: a.run_id, message: e.message });
    }
  }
  test() {
    const tree = this.s.candidate.tree; const snapshot = path.join(this.root, 'snapshots', tree);
    this.repo.snapshot(tree, snapshot);
    let t = this.s.active_test;
    if (!t) {
      t = { index: this.s.tests.length + 1, name: `hr-resume-${this.plan.id}-${this.s.task_nonce}-${this.s.tests.length + 1}`, tree, runner_digest: RUNNER_DIGEST, intent_at: stamp() };
      this.s.tests.push(t); this.s.active_test = t; this.save('test_intent', { name: t.name, tree });
    }
    this.s.tests[t.index - 1] = t;
    let container = inspect(t.name);
    if (!container) {

      command('docker', ['create', '--name', t.name, '--label', `homerail.poc.plan=${this.planDigest}`, '--label', `homerail.poc.tree=${tree}`, '--label', `homerail.poc.runner=${RUNNER_DIGEST}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '256m', '--cpus', '1', '--tmpfs', '/work:rw,exec,nosuid,size=64m,mode=1777', '--mount', `type=bind,source=${snapshot},target=/source,readonly`, '--workdir', '/work', '--entrypoint', 'node', this.plan.image, '-e', TEST_BOOTSTRAP, JSON.stringify(this.plan.test_argv), JSON.stringify(this.repo.entries(tree).map(({path,mode})=>({path,mode}))) ]);
      container = inspect(t.name);
    }
    if (container.Config.Labels?.['homerail.poc.plan'] !== this.planDigest || container.Config.Labels?.['homerail.poc.tree'] !== tree || container.Image !== this.plan.image) throw new Error('test container identity mismatch');
    t.container_id = container.Id;
    if (container.Config.Labels?.['homerail.poc.runner'] !== RUNNER_DIGEST) {
      if (container.State.Running) command('docker', ['kill', t.name]);
      t.superseded = 'trusted runner changed; revalidate same candidate';
      delete this.s.active_test; this.save('test_runner_changed'); return;
    }
    if (container.State.Status === 'created') { command('docker', ['start', t.name]); this.save('test_started'); return; }
    if (container.State.Running) {
      if (Date.now() - Date.parse(container.State.StartedAt) > this.plan.test_timeout_seconds * 1000) {
        t.timed_out = true; this.save('test_timeout_intent'); command('docker', ['kill', t.name]);
      }
      return;
    }
    if (container.State.Status !== 'exited') throw new Error('unrecognized test lifecycle');
    this.repo.verify(tree, snapshot);
    const r = spawnSync('docker', ['logs', '--tail', '100', t.name], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('test log collection failed');
    const log = (r.stdout + r.stderr).slice(-16000); const code = container.State.ExitCode;
    const status = t.timed_out ? 'timed_out' : (container.State.OOMKilled || [125, 137].includes(code)) ? 'infrastructure_failed' : code === 0 ? 'passed' : 'failed';
    const receipt = { version: 1, runner_digest: RUNNER_DIGEST, tree, plan_digest: this.planDigest, image: this.plan.image, argv: this.plan.test_argv, status, exit_code: code, started_at: container.State.StartedAt, finished_at: container.State.FinishedAt, container_id: container.Id, log_sha256: digest(log) };
    const receiptPath = path.join(this.root, 'receipts', `${t.index}.json`);
    atomic(receiptPath, receipt); fs.writeFileSync(receiptPath + '.log', log);
    t.receipt = receipt; t.receipt_path = receiptPath; t.receipt_digest = identity(receipt);
    delete this.s.active_test; this.s.receipt = receipt;
    if (status === 'infrastructure_failed') {
      this.s.test_infra_failures = (this.s.test_infra_failures ?? 0) + 1;
      if (this.s.test_infra_failures >= 3) this.s.phase = 'needs_attention';
    } else if (status === 'passed') {
      this.s.best_verified = { ...this.s.candidate, receipt_path: receiptPath, receipt_digest: t.receipt_digest };
      this.s.phase = 'review';
    } else {
      const c = this.s.candidates.find(c => c.tree === tree); if (c) c.validation = 'failed';
      this.s.feedback = { category: 'test', status, log, tree }; this.s.phase = 'propose';
    }
    this.save('test_recorded', { status, tree });
  }
  publish() {
    const c = this.s.candidate; const verified = this.s.best_verified;
    if (!verified || verified.tree !== c.tree) throw new Error('candidate differs from tested tree');
    const receipt = read(verified.receipt_path);
    if (identity(receipt) !== verified.receipt_digest || receipt.runner_digest !== RUNNER_DIGEST) throw new Error('receipt bytes changed');
    if (digest(fs.readFileSync(verified.receipt_path + '.log')) !== receipt.log_sha256) throw new Error('test log bytes changed');
    assertReceipt(receipt, c, this.planDigest, this.plan.image, this.plan.test_argv);
    if (!this.s.reviews.some(v => v.tree === c.tree && v.result.verdict === 'clean')) throw new Error('missing semantic review');
    this.repo.verify(c.tree, path.join(this.root, 'snapshots', c.tree));
    const remote = new Repository(this.plan.publish_repo, this.plan.publication_git_bin ?? 'git');
    if (!this.s.publication) {
      const commit = this.repo.git(['commit-tree', c.tree, '-p', this.s.expected_head], { input: `HomeRail continuation ${this.plan.id}\n` });
      this.s.publication = { commit, tree: c.tree, previous_head: this.s.expected_head }; this.save('publication_intent');
    }
    const p = this.s.publication; const head = remote.git(['rev-parse', this.plan.publish_ref]);
    if (head !== p.commit && head !== p.previous_head) { this.s.phase = 'needs_attention'; this.save('head_drift', { head }); return; }
    if (head === p.previous_head) {
      remote.git(['fetch', '--no-tags', this.repo.root, p.commit]);
      remote.git(['update-ref', this.plan.publish_ref, p.commit, p.previous_head]);
    }
    if (remote.git(['rev-parse', this.plan.publish_ref]) !== p.commit) throw new Error('publication verification failed');
    this.s.phase = 'completed'; this.save(head === p.commit ? 'publication_reconciled' : 'published');
  }
  async step() {
    this.initialize();
    if (this.s.phase === 'completed') { this.publish(); return this.s; }
    if (this.s.phase === 'needs_attention') return this.s;
    try {
      if (this.s.phase === 'test') this.test();
      else if (['propose', 'review'].includes(this.s.phase)) await this.model(this.s.phase);
      else if (this.s.phase === 'publish') this.publish();
      else throw new Error('invalid task phase');
    } catch (e) { this.s.last_error = { at: stamp(), message: e.message }; this.save('step_error'); throw e; }
    return this.s;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]; if (!root) throw new Error('Usage: controller.mjs <task-directory>');
  // A kernel lock is released even by SIGKILL; all CLI steps use this entry path.
  if (process.argv[3] !== '--locked') {
    fs.mkdirSync(root, { recursive: true });
    const r = spawnSync('flock', ['-n', path.join(root, 'controller.lock'), process.execPath, fileURLToPath(import.meta.url), root, '--locked'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  try { const s = await new Task(root).step(); console.log(JSON.stringify({ phase: s.phase, models: s.attempts.length, tests: s.tests.length, last_event: s.events.at(-1), active_model: s.active_model?.run_id, active_test: s.active_test?.name })); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

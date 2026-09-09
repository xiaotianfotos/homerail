// Deterministic stage transport fixture, NOT a production trusted executor.
// GitHub and model providers are simulated; candidate Git and tests are real.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { evaluateE2eFixAcceptance } from '../../../homerail_protocol/dist/e2e-fix.js';
const [root, stage] = process.argv.slice(2);
const bytes = fs.readFileSync(0, 'utf8');
const input = JSON.parse(bytes);
const one = key => input[key]?.at(-1);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = path.join(root, 'ledger.json');
const repo = path.join(root, 'repo');
const git = args => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
let state;
if (stage === 'initialize') {
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'codex/fixture']);
  git(['config', 'user.email', 'e2e-fixture@example.invalid']);
  git(['config', 'user.name', 'E2E Fixture']);
  fs.mkdirSync(path.join(root, 'empty-hooks'));
  git(['config', 'core.hooksPath', path.join(root, 'empty-hooks')]);
  fs.writeFileSync(path.join(repo, 'sum.cjs'), 'module.exports = (a, b) => 0;\n');
  git(['add', 'sum.cjs']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture base']);
  state = { task_id: 'fixture', root_run_id: one('task').root_run_id, round: 0,
    require_type_guard: one('task').require_type_guard === true,
    status: 'next', base: git(['rev-parse', 'HEAD']), rounds: [], calls: [] };
} else state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls.push(stage);
let r = state.rounds.at(-1);
let result;
const reference = () => ({ task_id: state.task_id, round: state.round, candidate: r?.candidate });
const receipt = (value) => ({ candidate: r.candidate, artifact_sha256: hash(value) });
const fail = message => { throw new Error(message); };
switch (stage) {
  case 'initialize': result = { task_id: state.task_id, status: 'next' }; break;
  case 'context': {
    state.round = one('cycle').iteration;
    r = { round: state.round, events: [], source: fs.readFileSync(path.join(repo, 'sum.cjs'), 'utf8') };
    state.rounds.push(r);
    result = { ...reference(), source: r.source, allowed_paths: ['sum.cjs'] };
    break;
  }
  case 'freeze_plan':
    r.plan = one('plan');
    if (JSON.stringify(r.plan.allowed_paths) !== '["sum.cjs"]') fail('plan escaped fixture scope');
    r.plan_digest = hash(r.plan);
    result = { ...reference(), plan: r.plan, source: r.source };
    break;
  case 'capture': {
    const patch = one('patch');
    for (const edit of patch.edits) {
      if (edit.path !== 'sum.cjs' || edit.old !== r.source) fail('patch outside scope or stale');
      fs.writeFileSync(path.join(repo, 'sum.cjs'), edit.new);
    }
    git(['add', 'sum.cjs']); git(['-c', 'commit.gpgsign=false', 'commit', '-m', `candidate ${state.round}`]);
    r.candidate = { task_id: state.task_id, root_run_id: state.root_run_id, round: state.round,
      plan_sha256: r.plan_digest, policy_sha256: hash('frozen-fixture-policy'), repo: 'fixture/repo',
      base: state.base, head: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
    result = reference();
    break;
  }
  case 'test': {
    // This command is fixed outside the model-owned candidate directory.
    const x = spawnSync(process.execPath, ['-e', "require('node:assert/strict').equal(require(process.argv[1])(2,3),5)", path.join(repo, 'sum.cjs')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(root, `test-${state.round}.log`), x.stdout + x.stderr);
    r.test = { ...receipt({ code: x.status, log: x.stdout + x.stderr }), check_id: 'addition',
      execution_id: `test-${state.round}`, result: x.status === 0 ? 'passed' : 'failed', exit_code: x.status, signal: x.signal };
    result = { ...reference(), outcome: x.status === 0 ? 'passed' : 'code_failure',
      source: fs.readFileSync(path.join(repo, 'sum.cjs'), 'utf8'), test: r.test };
    break;
  }
  case 'review_evidence':
    r.reviews = one('reports').values;
    result = { ...reference(), outcome: 'reviewed', approvals: r.reviews.filter(x => x.vote === 'approve').length,
      findings: r.reviews.flatMap(x => x.findings), reports: r.reviews };
    break;
  case 'record_candidate_judgment': {
    r.judgment = one('judgment');
    const clean = r.test.result === 'passed' && r.reviews?.filter(x => x.vote === 'approve').length >= 2
      && r.reviews.every(x => x.findings.length === 0);
    result = { ...reference(), action: r.judgment.verdict === 'revise' ? 'revise'
      : r.judgment.verdict === 'accept' && clean ? 'publish' : 'pause' };
    r.action = result.action;
    break;
  }
  case 'publish':
    // Deliberately simulated publication; P1 cannot prove GitHub E2E.
    state.publication_count = (state.publication_count ?? 0) + 1;
    r.publication = { ...receipt('fixture-pr'), pr: 7, observed_head: r.candidate.head, state: 'open' };
    result = { ...reference(), publication: r.publication };
    break;
  case 'ci': {
    const check = spawnSync(process.execPath, ['-e', state.require_type_guard
      ? "require('node:assert/strict').throws(()=>require(process.argv[1])('2',3),TypeError)"
      : "require('node:assert/strict').equal(require(process.argv[1])(2,3),5)", path.join(repo, 'sum.cjs')], { encoding: 'utf8' });
    fs.writeFileSync(path.join(root, `ci-${state.round}.log`), check.stdout + check.stderr);
    r.ci = { ...receipt('fixture-ci'), workflow_run_id: 'fixture-ci', workflow_attempt: 1, pr: 7,
      workflow_path: '.github/workflows/ci.yml', observed_pr_head: r.candidate.head, status: 'completed',
      jobs: [{ key: 'fixture-ci', conclusion: check.status === 0 ? 'success' : 'failure' }] };
    result = { ...reference(), outcome: check.status === 0 ? 'ci_passed' : 'code_failure', ci: r.ci };
    break;
  }
  case 'complete': {
    const reviews = r.reviews.map((value, i) => ({ ...receipt(value), reviewer_id: `reviewer-${i}`,
      dispatch_id: `review-${i}-${state.round}`, session_id: `review-session-${i}-${state.round}`,
      status: 'complete', vote: value.vote, finding_ids: value.findings.map(hash) }));
    const evidence = {
      candidate: r.candidate,
      policy: { sha256: r.candidate.policy_sha256, required_tests: ['addition'], required_ci_jobs: ['fixture-ci'],
        ci_workflow_path: '.github/workflows/ci.yml', reviewer_ids: reviews.map(x => x.reviewer_id), review_approvals: 2 },
      fixer_dispatch_id: `fix-${state.round}`, fixer_session_id: `fix-session-${state.round}`,
      tests: [r.test], reviews,
      judgment: { ...receipt(one('judgment')), dispatch_id: `judge-${state.round}`, session_id: `judge-session-${state.round}`,
        verdict: one('judgment').verdict, review_artifact_sha256: reviews.map(x => x.artifact_sha256), dispositions: [] },
      publication: r.publication, ci: r.ci,
    };
    r.acceptance = evaluateE2eFixAcceptance(evidence);
    result = { ...reference(), action: one('judgment').verdict === 'revise' ? 'revise' : r.acceptance.eligible ? 'complete' : 'pause', acceptance: r.acceptance };
    break;
  }
  default: fail('unknown fixture stage');
}
if (r) { r.events.push(stage); write(`round-${state.round}.json`, r); }
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(result));

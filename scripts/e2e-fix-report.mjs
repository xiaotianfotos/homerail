import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const roles = { planner: 'plan', fixer: 'fix', review_a: 'review_a', review_b: 'review_b',
  review_c: 'review_c', candidate_judger: 'judge_candidate', ci_judger: 'judge_ci' };

/** Usage is cumulative within an execution, not additive across snapshots.
 * Cache reads are a subset of input tokens; never add them to total tokens. */
export function summarizeUsage(records, kind) {
  const executions = new Map();
  let unknown = 0;
  for (const record of records) {
    const scope = kind === 'host' ? [record.thread_id] : kind === 'worker_failure'
      ? [record.session_id, record.round_id, record.execution_id]
      : [record.scope?.session_id, record.scope?.round_id, record.scope?.generation, record.scope?.execution_id];
    const usage = kind === 'host' ? record.usage?.total : record.usage;
    const input = kind === 'host' ? usage?.inputTokens : usage?.input_tokens;
    const output = kind === 'host' ? usage?.outputTokens : usage?.output_tokens;
    const cache = kind === 'host' ? usage?.cachedInputTokens : usage?.cache_read_input_tokens;
    const at = kind === 'host' ? record.at : kind === 'worker_failure' ? 0 : record.timestamp;
    if (scope.some(v => v === undefined || v === null || v === '') || !count(input) || !count(output)
      || !count(cache) || cache > input || !count(at)) { unknown++; continue; }
    const key = JSON.stringify(scope);
    const value = { input, output, cache_read: cache };
    const previous = executions.get(key);
    if (previous && at === previous.at && JSON.stringify(previous.value) !== JSON.stringify(value)) {
      throw new Error('Conflicting usage snapshots for the same execution and timestamp');
    }
    if (previous) {
      const older = at < previous.at ? value : previous.value;
      const newer = at < previous.at ? previous.value : value;
      if (newer.input < older.input || newer.output < older.output) throw new Error('Cumulative usage decreased within an execution');
    }
    if (!previous || at > previous.at) executions.set(key, { at, value });
  }
  const values = [...executions.values()].map(v => v.value);
  const sum = key => {
    const total = values.reduce((n, v) => n + v[key], 0);
    if (!count(total)) throw new Error('Usage total exceeds safe integer range');
    return total;
  };
  if (!count(sum('input') + sum('output'))) throw new Error('Usage total exceeds safe integer range');
  return { status: unknown || !values.length ? 'incomplete' : 'reported', executions: values.length,
    unknown_records: unknown, input_tokens: sum('input'), output_tokens: sum('output'),
    cache_read_input_tokens: sum('cache_read'), total_tokens: sum('input') + sum('output') };
}

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 8_388_608) throw new Error('Invalid report artifact: ' + file);
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes), sha256: digest(bytes) };
}

/** Local accounting inventory, NOT an execution or acceptance verifier.
 * It never loads live credentials, starts a DAG, runs tests or writes a PR. */
export function reportTask(directory) {
  if (!path.isAbsolute(directory)) throw new Error('An absolute task directory is required');
  const config = read(path.join(directory, 'config.json')).value;
  const policy = digest(JSON.stringify(config));
  if (policy !== fs.readFileSync(path.join(directory, 'config.sha256'), 'utf8')) throw new Error('Policy digest mismatch');
  const roundRoot = path.join(directory, 'rounds');
  const roundNames = fs.existsSync(roundRoot) ? fs.readdirSync(roundRoot).filter(n => /^[1-9][0-9]*$/.test(n)) : [];
  const rounds = [], usageRows = [], missing = [];
  for (const name of roundNames.sort((a, b) => Number(a) - Number(b))) {
    const folder = path.join(roundRoot, name), refs = [];
    const optional = relative => {
      const file = path.join(folder, relative);
      if (!fs.existsSync(file)) return null;
      const artifact = read(file);
      refs.push({ path: `rounds/${name}/${relative}`, sha256: artifact.sha256 });
      return artifact.value;
    };
    const context = optional('context.json'), capture = optional('capture.json'), test = optional('test.json');
    const decision = optional('record_candidate_judgment.json'), publication = optional('publish.json');
    const ci = optional('ci.json'), complete = optional('complete.json');
    const models = [];
    for (const [file, role] of Object.entries(roles)) {
      const evidence = optional(file + '.json');
      const receipt = optional(`host-codex/${role}/receipt.json`);
      const failure = optional(`host-codex/${role}/failure.json`);
      const claim = optional(`host-codex/${role}/claim.json`);
      let hostEvents = null;
      const eventPath = path.join(folder, 'host-codex', role, 'events.jsonl');
      if (fs.existsSync(eventPath)) {
        if (fs.lstatSync(eventPath).isSymbolicLink() || fs.statSync(eventPath).size > 1_048_576) throw new Error('Invalid host event journal');
        const bytes = fs.readFileSync(eventPath);
        hostEvents = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        refs.push({ path: `rounds/${name}/host-codex/${role}/events.jsonl`, sha256: digest(bytes) });
      }
      const workerFailure = role === 'fix' ? optional('fixer_failure.json') : null;
      if (!evidence && !claim && !receipt && !failure && !workerFailure) continue;
      const host = Boolean(claim || receipt || failure);
      // Failure projections may omit executions. Do not manufacture a zero cost.
      const projection = !host && !evidence && workerFailure;
      const records = host ? (hostEvents ?? []).filter(e => e.event === 'token_usage')
        : projection ? (workerFailure.attempts ?? []).map(a => ({ session_id: workerFailure.session_id,
          round_id: workerFailure.round_id, execution_id: a.execution_id, usage: a })) : evidence?.usages ?? [];
      const usage = summarizeUsage(records, host ? 'host' : projection ? 'worker_failure' : 'worker');
      if (projection) missing.push({ round: Number(name), role,
        reason: 'Counted retained failure projection; original Worker journal needed to audit completeness and provenance' });
      const timing = receipt ?? failure;
      const duration = count(timing?.started) && count(timing?.finished) && timing.finished >= timing.started
        ? timing.finished - timing.started : null;
      models.push({ role, transport: host ? 'host_codex' : evidence?.agent_type ?? 'unknown',
        model: evidence?.model ?? receipt?.model ?? null,
        session_id: evidence?.session_id ?? claim?.identity?.session_id ?? workerFailure?.session_id ?? null,
        outcome: failure || workerFailure ? 'failure_artifact_present' : evidence ? 'role_artifact_present' : 'unconfirmed',
        duration_ms: duration, usage_source: projection ? 'failure_projection' : host ? 'host_journal' : 'role_artifact', usage });
      usageRows.push(usage);
    }
    rounds.push({ round: Number(name), parent: context?.parent ?? null, head: capture?.candidate?.head ?? null,
      plan_sha256: capture?.candidate?.plan_sha256 ?? null, tests: (test?.tests ?? []).map(t => ({ check_id: t.check_id,
        result: t.result, execution_id: t.execution_id })), candidate_action: decision?.action ?? null,
      pr: publication?.publication?.pr ?? null, ci_outcome: ci?.outcome ?? null, completion_action: complete?.action ?? null,
      models, evidence: refs });
  }
  const sum = key => usageRows.reduce((n, r) => n + r[key], 0);
  return { schema_version: 1, root_run_id: config.root_run_id, issue: config.issue?.number, policy_sha256: policy,
    scope: 'Accounting from retained artifacts; not native provenance, complete billing, or E2E acceptance proof',
    source_directory: directory, budget: { max_rounds: config.max_rounds, total_timeout_ms: config.total_timeout_ms,
      context_bytes: config.context_bytes }, rounds, missing_evidence: missing,
    reported_usage: { status: usageRows.length && usageRows.every(u => u.status === 'reported') && !missing.length ? 'reported_artifacts_only' : 'incomplete',
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_input_tokens: sum('cache_read_input_tokens'),
      total_tokens: sum('total_tokens') } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length < 3) throw new Error('Usage: node scripts/e2e-fix-report.mjs /absolute/trial/task [...]');
  const directories = process.argv.slice(2).map(p => fs.realpathSync(p));
  if (new Set(directories).size !== directories.length) throw new Error('Duplicate task directory');
  const reports = directories.map(reportTask);
  if (new Set(reports.map(r => r.root_run_id)).size !== reports.length) throw new Error('Duplicate root run; choose one evidence copy');
  console.log(JSON.stringify({ schema_version: 1, tasks: reports }, null, 2));
}

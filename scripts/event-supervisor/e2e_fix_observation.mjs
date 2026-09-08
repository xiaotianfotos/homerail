import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1_048_576) throw new Error('invalid E2E observation artifact');
  return fs.readFileSync(file);
}

/** Read-only observation of a trusted host failure stranded in a RUNNING
 * command. The caller owns waiting/notification; this never advances a DAG.
 * Expected handled Worker Fixer failures are deliberately excluded. */
export function observeE2eFixHostFailure(taskDirectory, status, now = Date.now()) {
  if (!path.isAbsolute(taskDirectory)) throw new Error('absolute trusted task directory required');
  if (status?.terminal || status?.status !== 'active') return null;
  const config = JSON.parse(read(path.join(taskDirectory, 'config.json')));
  if (hash(JSON.stringify(config)) !== read(path.join(taskDirectory, 'config.sha256')).toString()) {
    throw new Error('E2E observation policy digest mismatch');
  }
  if (config.root_run_id !== status.run_id || !config.host_codex) return null;
  const round = status.current_round;
  if (!Number.isSafeInteger(round?.ordinal) || round.ordinal < 1 || round.ordinal > config.max_rounds) return null;
  const iteration = status.counters?.gateway_iterations?.cycle ?? round.ordinal;
  if (!Number.isSafeInteger(iteration) || iteration < 1 || iteration > config.max_rounds) return null;
  for (const role of ['plan', 'judge_candidate', 'judge_ci', ...(config.host_codex.fixer === true ? ['fix'] : [])]) {
    if (status.node_states?.[role] !== 'RUNNING') continue;
    const dir = path.join(taskDirectory, 'rounds', String(iteration), 'host-codex', role);
    const file = path.join(dir, 'failure.json');
    if (!fs.existsSync(file)) continue;
    const bytes = read(file), failure = JSON.parse(bytes), claim = JSON.parse(read(path.join(dir, 'claim.json')));
    const identity = failure.identity;
    if (!identity || identity.run_id !== config.root_run_id || identity.node_id !== role
      || identity.round_id !== round.round_id || typeof identity.session_id !== 'string' || !identity.session_id
      || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
      || !isDeepStrictEqual(identity, claim.identity) || claim.command_id !== failure.command_id
      || !/^[a-f0-9]{64}$/.test(failure.command_id ?? '')
      || !Number.isFinite(failure.started) || !Number.isFinite(failure.finished)
      || failure.finished < failure.started || typeof failure.error !== 'string') {
      throw new Error('E2E host failure identity mismatch');
    }
    // Allow the normal process-exit/receipt-consumption path to finish first.
    if (now - failure.finished < 5000) continue;
    return {kind: 'host_stage_failed_while_running', run_id: config.root_run_id, role,
      round_id: round.round_id, command_id: failure.command_id, failure_sha256: hash(bytes),
      event_key: hash(JSON.stringify({identity, command_id: failure.command_id, failure_sha256: hash(bytes)}))};
  }
  return null;
}

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {observeE2eFixHostFailure} from './e2e_fix_observation.mjs';

/** Program-only waiting. A supervisor queues the one completion/error wake. */
export async function watchE2eFix(options) {
  const {manager_url, task_directory, evidence_directory, timeout_ms, poll_ms = 15000} = options;
  const url = new URL(manager_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !path.isAbsolute(task_directory) || !path.isAbsolute(evidence_directory)
    || !Number.isSafeInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 86_400_000
    || !Number.isSafeInteger(poll_ms) || poll_ms < 20 || poll_ms > 60000) throw new Error('invalid E2E watch options');
  const config = JSON.parse(fs.readFileSync(path.join(task_directory, 'config.json'), 'utf8'));
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.root_run_id)) throw new Error('invalid E2E watch run identity');
  fs.mkdirSync(evidence_directory, {recursive:true, mode:0o700});
  const save = (name, value) => fs.writeFileSync(path.join(evidence_directory,name), JSON.stringify(value,null,2)+'\n', {mode:0o600,flag:'wx'});
  const start = Date.now(); let errors = 0;
  while (Date.now() - start < timeout_ms) {
    let status;
    try {
      const response = await fetch(new URL('/api/runs/'+encodeURIComponent(config.root_run_id)+'/status',url), {
        signal:AbortSignal.timeout(Math.min(15000, Math.max(1, timeout_ms-(Date.now()-start)))),
      });
      if (!response.ok) throw new Error('status HTTP '+response.status);
      const body = await response.json(); status = body.data ?? body;
      if (status.run_id !== config.root_run_id) throw new Error('observed run identity mismatch');
      errors = 0;
    } catch {
      if (++errors >= 12) {save('attention.json',{kind:'observation_unavailable',run_id:config.root_run_id});return 2;}
    }
    if (status) {
      if (status.terminal) {
        save('terminal-status.json',status);
        return 0; // Terminal observed, not a claim of successful E2E.
      }
      const attention = observeE2eFixHostFailure(task_directory,status);
      if (attention) {save('attention.json',attention);save('attention-status.json',status);return 2;}
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(poll_ms,Math.max(1,timeout_ms-(Date.now()-start)))));
  }
  save('attention.json',{kind:'observation_deadline',run_id:config.root_run_id,run_outcome:'unknown'});
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.exitCode=await watchE2eFix(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));}
  catch(error){console.error('E2E observation failed:',error.message);process.exitCode=2;}
}

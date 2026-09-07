#!/usr/bin/env node
// Explicit opt-in live experiment. No GitHub write and no dependency installation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomic, command, Repository, validatePlan } from './core.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export function initializeExperiment(root, config) {
  root = path.resolve(root);
  if (fs.existsSync(root)) throw new Error('choose a new task directory; never overwrite evidence');
  const plan = validatePlan({ version: 1, id: path.basename(root), source_repo: path.join(root,'fixture'), publish_repo: path.join(root,'published.git'), publish_ref: 'refs/heads/main', base_sha: '0'.repeat(40), image: config.image, writable_paths: ['mode.mjs'], test_argv: ['node','--test','acceptance.test.mjs'], test_timeout_seconds: 15, max_model_attempts: 8, manager_url: config.manager_url, setting_id: config.setting_id, reasoning_effort: config.reasoning_effort ?? 'low', objective: 'Fix publicationMode to match git add file-mode semantics: with core.filemode=false preserve tracked mode and default new files to regular 100644; with true use the owner executable bit of fsMode. Return only mode.mjs. Inputs are boolean coreFileMode, optional trackedMode 100644/100755, and numeric fsMode. Do not weaken or modify acceptance tests.' });
  fs.mkdirSync(root,{recursive:true}); command('git',['init','--initial-branch=main',plan.source_repo]); const repo = new Repository(plan.source_repo);
  repo.git(['config','user.name','HomeRail experiment']); repo.git(['config','user.email','experiment@localhost']);
  // Some NAS mounts report every file as executable. Git is the authority for modes.
  repo.git(['config','core.filemode','false']);
  fs.writeFileSync(path.join(plan.source_repo,'mode.mjs'), 'export function publicationMode({coreFileMode, trackedMode, fsMode}) {\n  return (fsMode & 0o111) ? "100755" : "100644";\n}\n');
  fs.writeFileSync(path.join(plan.source_repo,'acceptance.test.mjs'), `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicationMode} from './mode.mjs';
await new Promise(r=>setTimeout(r,2000));
for (const coreFileMode of [false,true]) for (const trackedMode of [undefined,'100644','100755']) for (const fsMode of [0o644,0o755,0o700,0o654,0o645,0o000]) {
 test(JSON.stringify({coreFileMode,trackedMode,fsMode}),()=>{
  const expected=coreFileMode ? ((fsMode & 0o100) ? '100755':'100644') : (trackedMode ?? '100644');
  assert.equal(publicationMode({coreFileMode,trackedMode,fsMode}),expected);
 });
}
`);
  repo.git(['add','.']); repo.git(['commit','-m','fixture: publication mode regression']); plan.base_sha = repo.git(['rev-parse','HEAD']);
  command('git',['clone','--bare',plan.source_repo,plan.publish_repo]); atomic(path.join(root,'plan.json'),plan); return plan;
}
export async function drive(root) {
  let last, failures = 0;
  for (let n = 0; n < 300; n++) {
    const r = spawnSync(process.execPath,[path.join(here,'controller.mjs'),root],{encoding:'utf8',timeout:60000});
    if (r.error || r.status !== 0) {
      console.error(r.error?.message ?? r.stderr.trim());
      if (++failures >= 5) throw new Error('observer stopped after errors; task evidence remains intact');
    } else {
      failures = 0; const state = JSON.parse(r.stdout);
      const key = JSON.stringify([state.phase,state.models,state.tests,state.last_event?.event]);
      if (key !== last) { console.log(JSON.stringify(state)); last = key; }
      if (state.phase === 'completed') return;
      if (state.phase === 'needs_attention') throw new Error('task paused with evidence; see state.json');
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('bounded observer expired; invoke run again to continue');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation,root] = process.argv.slice(2);
  if (!root || !['init','run'].includes(operation)) throw new Error('Usage: experiment.mjs init|run <new-task-directory>');
  if (operation === 'init') { initializeExperiment(root,{ image: process.env.HR_POC_IMAGE, manager_url: process.env.HOMERAIL_MANAGER_URL, setting_id: process.env.HR_POC_SETTING_ID, reasoning_effort: process.env.HR_POC_REASONING }); console.log(path.resolve(root)); }
  else await drive(path.resolve(root));
}

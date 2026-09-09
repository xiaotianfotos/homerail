import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {observeE2eFixHostFailure} from './e2e_fix_observation.mjs';
import {watchE2eFix} from './watch_e2e_fix.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-observation-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const config = {root_run_id:'root', max_rounds:3, host_codex:{model:'fixture'}};
  const raw = JSON.stringify(config);
  fs.writeFileSync(path.join(dir,'config.json'), raw);
  fs.writeFileSync(path.join(dir,'config.sha256'), createHash('sha256').update(raw).digest('hex'));
  const folder = path.join(dir,'rounds/1/host-codex/judge_candidate'); fs.mkdirSync(folder,{recursive:true});
  const identity = {run_id:'root',node_id:'judge_candidate',round_id:'round-0001',session_id:'session',attempt:1};
  const failure = {command_id:'a'.repeat(64),identity,started:1000,finished:2000,error:'private provider detail'};
  fs.writeFileSync(path.join(folder,'claim.json'),JSON.stringify({command_id:failure.command_id,identity}));
  const save = () => fs.writeFileSync(path.join(folder,'failure.json'),JSON.stringify(failure)); save();
  const status = {run_id:'root',status:'active',terminal:false,current_round:{round_id:'round-0001',ordinal:1},node_states:{judge_candidate:'RUNNING'}};
  return {dir,folder,failure,save,status};
}
test('alerts on an actual stranded host failure with a stable key and no raw error', t => {
  const f=fixture(t), a=observeE2eFixHostFailure(f.dir,f.status,8000);
  assert.equal(a.kind,'host_stage_failed_while_running');
  assert.equal(a.event_key,observeE2eFixHostFailure(f.dir,f.status,9000).event_key);
  assert.ok(!JSON.stringify(a).includes('private provider detail'));
});
test('stays quiet during normal receipt delivery and after native termination', t => {
  const f=fixture(t);assert.equal(observeE2eFixHostFailure(f.dir,f.status,6000),null);
  assert.equal(observeE2eFixHostFailure(f.dir,{...f.status,terminal:true},9000),null);
  assert.equal(observeE2eFixHostFailure(f.dir,{...f.status,node_states:{fix:'FAILED',judge_candidate:'COMPLETED'}},9000),null);
});
test('observes the current repair iteration instead of the lifecycle round ordinal', t => {
  const f=fixture(t), current=path.join(f.dir,'rounds/2/host-codex/judge_candidate');
  fs.mkdirSync(current,{recursive:true});
  fs.cpSync(f.folder,current,{recursive:true});fs.rmSync(f.folder,{recursive:true});
  const status={...f.status,counters:{gateway_iterations:{cycle:2}}};
  assert.equal(observeE2eFixHostFailure(f.dir,status,9000).role,'judge_candidate');
  assert.equal(observeE2eFixHostFailure(f.dir,{...status,counters:{gateway_iterations:{cycle:4}}},9000),null);
});
test('observes opted-in host Fixer failures without treating Worker failures as host evidence', t => {
  const f=fixture(t), folder=path.join(f.dir,'rounds/1/host-codex/fix');
  fs.mkdirSync(folder,{recursive:true});
  const failure={...f.failure,identity:{...f.failure.identity,node_id:'fix'}};
  fs.writeFileSync(path.join(folder,'claim.json'),JSON.stringify({command_id:failure.command_id,identity:failure.identity}));
  fs.writeFileSync(path.join(folder,'failure.json'),JSON.stringify(failure));
  const status={...f.status,node_states:{fix:'RUNNING'}};
  assert.equal(observeE2eFixHostFailure(f.dir,status,9000),null);
  const config=JSON.parse(fs.readFileSync(path.join(f.dir,'config.json')));config.host_codex.fixer=true;
  const raw=JSON.stringify(config);fs.writeFileSync(path.join(f.dir,'config.json'),raw);
  fs.writeFileSync(path.join(f.dir,'config.sha256'),createHash('sha256').update(raw).digest('hex'));
  assert.equal(observeE2eFixHostFailure(f.dir,status,9000).role,'fix');
});
test('rejects mismatched claims and old-round identities', t => {
  const f=fixture(t);f.failure.identity.session_id='stale';f.save();
  assert.throws(()=>observeE2eFixHostFailure(f.dir,f.status,9000),/identity/);
});
test('does not observe another root and rejects a modified frozen policy', t => {
  const f=fixture(t);assert.equal(observeE2eFixHostFailure(f.dir,{...f.status,run_id:'other'},9000),null);
  fs.appendFileSync(path.join(f.dir,'config.sha256'),'tampered');
  assert.throws(()=>observeE2eFixHostFailure(f.dir,f.status,9000),/digest/);
});
test('real HTTP watch wakes for stranded host failure, makes no mutation request', async t => {
  const f=fixture(t), requests=[];
  const server=createServer((req,res)=>{requests.push([req.method,req.url]);res.setHeader('content-type','application/json');res.end(JSON.stringify({data:f.status}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const evidence=path.join(f.dir,'watch');
  assert.equal(await watchE2eFix({manager_url:'http://127.0.0.1:'+server.address().port,task_directory:f.dir,evidence_directory:evidence,timeout_ms:3000,poll_ms:20}),2);
  assert.deepEqual(requests,[['GET','/api/runs/root/status']]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,'attention.json'))).kind,'host_stage_failed_while_running');
});

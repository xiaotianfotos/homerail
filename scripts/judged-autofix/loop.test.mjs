import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareModel, reconcileSubmission } from './model.mjs';

// Judger-owned acceptance oracle: no real provider or GitHub calls.
test('submission freezes definition pins and replays the exact saved POST after lost acknowledgement', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({url, body});
    const data = url.endsWith('/workflows/sync') ? {workflow:{head_revision:7,canonical_hash:'a'.repeat(64)}}
      : url.endsWith('/profiles/sync') ? {profile:{updated_at:'2026-09-07T01:02:03.000Z'}}
      : {run_id:body.runId,dispatched:0};
    return new Response(JSON.stringify({success:true,data}));
  };
  try {
    const config={manager_url:'http://manager.invalid',setting_id:'local'};
    const attempt={workflow_id:'judged-unique',kind:'propose'};
    await prepareModel(config,attempt,{objective:'repair'});
    assert.equal(attempt.payload.workflow_revision,7);
    assert.equal(attempt.payload.canonical_hash,'a'.repeat(64));
    assert.equal(attempt.payload.profile_updated_at,'2026-09-07T01:02:03.000Z');
    const durable=JSON.parse(JSON.stringify(attempt));
    assert.equal(await reconcileSubmission(config,durable),attempt.requested_run_id);
    assert.equal(await reconcileSubmission(config,durable),attempt.requested_run_id);
    assert.deepEqual(calls.slice(-2).map(c=>c.body),[attempt.payload,attempt.payload]);
    assert.ok(calls.slice(-2).every(c=>c.url.endsWith('/api/runs/create-and-run')));
    assert.equal(calls.length,4,'recovery must not re-sync mutable definitions');
  } finally { globalThis.fetch=saved; }
});

test('retry conflicts and a receipt for another run are rejected',async()=>{
  const saved=globalThis.fetch;
  const attempt={requested_run_id:'expected',payload:{runId:'expected'}};
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({data:{run_id:'wrong'}}));
    await assert.rejects(reconcileSubmission({manager_url:'http://manager.invalid'},attempt),/identity|run|mismatch/i);
    globalThis.fetch=async()=>new Response('request_mismatch',{status:409});
    await assert.rejects(reconcileSubmission({manager_url:'http://manager.invalid'},attempt),/409/);
  } finally {globalThis.fetch=saved;}
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {ensureTestJob} from './test-job.mjs';
import {digest,identity} from './evidence.mjs';

async function finished(dir,spec){for(let i=0;i<100;i++){const r=ensureTestJob(dir,spec);if(r)return r;await delay(100);}throw new Error('job did not finish');}
function fixture(t,code,timeout_ms=5000){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'judged-job-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo');fs.mkdirSync(repo);
 const git=args=>{const p=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
 git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);fs.writeFileSync(path.join(repo,'source.txt'),'original\n');git(['add','.']);git(['commit','-qm','initial']);
 return {root,repo,dir:path.join(root,'job'),spec:{name:'oracle',repo,commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),check:{cwd:'.',argv:[process.execPath,'-e',code],timeout_ms},home:path.join(root,'home')}};
}
test('trusted job survives controller SIGKILL and is adopted without another execution',async t=>{
 const f=fixture(t,"require('fs').appendFileSync(process.env.HOME+'/count','x');setTimeout(()=>console.log('finished once'),700)");
 const moduleUrl=new URL('./test-job.mjs',import.meta.url).href;
 const code=`import {ensureTestJob} from ${JSON.stringify(moduleUrl)};ensureTestJob(${JSON.stringify(f.dir)},${JSON.stringify(f.spec)});setInterval(()=>{},1000);`;
 const controller=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
 for(let i=0;i<100&&!fs.existsSync(path.join(f.spec.home,'count'));i++)await delay(30);
 assert.ok(fs.existsSync(path.join(f.spec.home,'count')),'test actually started');controller.kill('SIGKILL');
 const receipt=await finished(f.dir,f.spec);assert.equal(receipt.status,'passed');assert.equal(receipt.exit_code,0);
 assert.equal(fs.readFileSync(path.join(f.spec.home,'count'),'utf8'),'x');assert.equal(receipt.tree,f.spec.tree);assert.equal(receipt.commit,f.spec.commit);assert.equal(receipt.spec_digest,identity(f.spec.check));
 assert.equal(receipt.log_digest,digest(fs.readFileSync(receipt.log_path)));assert.match(receipt.runner_digest,/^[a-f0-9]{64}$/);
 assert.deepEqual(ensureTestJob(f.dir,f.spec),receipt);
 assert.throws(()=>ensureTestJob(f.dir,{...f.spec,tree:'other'}),/changed|mismatch|identity/i);
});
test('test failures, timeouts and source mutations cannot become passing receipts',async t=>{
 for(const [code,timeout,status] of [["process.exit(3)",5000,'failed'],["setTimeout(()=>{},10000)",100,'infrastructure_failed'],["require('fs').writeFileSync('source.txt','modified')",5000,'infrastructure_failed']]){
  const f=fixture(t,code,timeout);const r=await finished(f.dir,f.spec);assert.equal(r.status,status);
 }
});

test('receipt cannot survive deleted log or changed job identity',async t=>{
 const f=fixture(t,"console.log('ok')");const receipt=await finished(f.dir,f.spec);
 const original=JSON.parse(fs.readFileSync(path.join(f.dir,'receipt.json'),'utf8'));
 fs.writeFileSync(path.join(f.dir,'receipt.json'),JSON.stringify({...original,job_digest:'wrong'}));
 assert.throws(()=>ensureTestJob(f.dir,f.spec),/job|identity|digest/i);
 fs.writeFileSync(path.join(f.dir,'receipt.json'),JSON.stringify(original));fs.unlinkSync(receipt.log_path);
 assert.throws(()=>ensureTestJob(f.dir,f.spec),/log|evidence|ENOENT/i);
});
test('committing a source change during tests still invalidates the tested candidate',async t=>{
 const f=fixture(t,"const fs=require('fs'),cp=require('child_process');fs.writeFileSync('source.txt','changed');cp.execFileSync('git',['add','.']);cp.execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','mutation'])");
 assert.equal((await finished(f.dir,f.spec)).status,'infrastructure_failed');
});
test('dirty candidate is rejected before any test command executes',async t=>{
 const f=fixture(t,"require('fs').writeFileSync('source.txt','original\\n');require('fs').writeFileSync(process.env.HOME+'/executed','bad')");
 fs.writeFileSync(path.join(f.repo,'source.txt'),'dirty');assert.equal((await finished(f.dir,f.spec)).status,'infrastructure_failed');assert.ok(!fs.existsSync(path.join(f.spec.home,'executed')));
});

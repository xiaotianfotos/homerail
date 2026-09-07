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
import {JudgedLoop} from './loop.mjs';
function loopFixture(t,code="console.log('trusted')"){
 const f=fixture(t,code);const root=path.join(f.root,'task');fs.mkdirSync(root);
 const config={id:'test',repo:f.repo,checks:{oracle:f.spec.check},publish_checks:['oracle']};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));const loop=new JudgedLoop(root);
 loop.state.phase='test';loop.state.rounds=[{index:1,plan:{checks:['oracle']},plan_digest:'plan',candidate_commit:f.spec.commit,candidate_tree:f.spec.tree}];loop.save('fixture');return {...f,root,loop};
}
test('loop records durable receipts and refuses acceptance after evidence tampering',async t=>{
 const f=loopFixture(t);await f.loop.test();const r=f.loop.round;
 assert.equal(f.loop.state.phase,'judging');assert.equal(r.receipts[0].status,'passed');assert.ok(r.receipts[0].runner_digest);
 const judgment=path.join(f.root,'judgment.json');fs.writeFileSync(judgment,JSON.stringify({round:1,plan_digest:'plan',verdict:'accept',reason:'reviewed',tree:r.candidate_tree}));
 fs.appendFileSync(r.receipts[0].log_path,'tampered');assert.throws(()=>f.loop.judge(judgment),/evidence|log|receipt/i);
});
test('controller restarts after a saved test intent adopt the same trusted job',async t=>{
 const f=loopFixture(t,"require('fs').appendFileSync(process.env.HOME+'/count','x');setTimeout(()=>{},650)");
 const entry=new URL('./loop.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {JudgedLoop} from ${JSON.stringify(entry)};await new JudgedLoop(${JSON.stringify(f.root)}).test();`],{stdio:'ignore'});
 for(let i=0;i<100&&!fs.existsSync(path.join(f.root,'test-home','count'));i++)await delay(30);
 assert.ok(fs.existsSync(path.join(f.root,'test-home','count')));child.kill('SIGKILL');
 const restored=new JudgedLoop(f.root);await restored.test();assert.equal(restored.round.receipts.length,1);assert.equal(restored.round.receipts[0].status,'passed');
 assert.equal(fs.readFileSync(path.join(f.root,'test-home','count'),'utf8'),'x');
});
test('missing flock produces a durable infrastructure failure instead of hanging',async t=>{
 const f=fixture(t,"console.log('never')");const old=process.env.PATH;
 try{process.env.PATH='/nonexistent-judged-test-bin';const r=await finished(f.dir,f.spec);assert.equal(r.status,'infrastructure_failed');assert.match(r.error,/spawn|flock|ENOENT/i);}finally{process.env.PATH=old;}
});
import {freezeEngine} from './freeze.mjs';
test('frozen entry uses approved copy and rejects tampering or unsafe promotion',t=>{
 const f=loopFixture(t);f.loop.state.phase='judging';f.loop.save('ready_for_promotion');
 const src=path.join(f.repo,'scripts','judged-autofix');fs.mkdirSync(src,{recursive:true});
 for(const n of ['evidence.mjs','model.mjs','loop.mjs','test-job.mjs','entry.mjs'])fs.copyFileSync(fileURLToPath(new URL(n,import.meta.url)),path.join(src,n));
 const git=args=>{const p=spawnSync('git',['-C',f.repo,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};git(['add','.']);git(['commit','-qm','engine']);
 freezeEngine(f.root);assert.ok(fs.existsSync(path.join(f.root,'run.mjs')));
 const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'engine.json'),'utf8'));assert.equal(manifest.source_commit,git(['rev-parse','HEAD']));
 fs.writeFileSync(path.join(src,'model.mjs'),'throw new Error("mutable candidate executed")');
 const run=()=>spawnSync(process.execPath,[path.join(f.root,'run.mjs'),f.root,'status'],{encoding:'utf8'});
 assert.equal(run().status,0,'candidate changes must not change active engine');assert.throws(()=>freezeEngine(f.root),/dirty|clean/i);
 fs.appendFileSync(path.join(manifest.directory,'model.mjs'),'\n//tamper');assert.notEqual(run().status,0,'frozen hash mismatch must stop before execution');
 git(['restore','scripts/judged-autofix/model.mjs']);f.loop.state.phase='model';f.loop.save('active');assert.throws(()=>freezeEngine(f.root),/active|phase|running|round/i);
});
test('a different requested check cannot overwrite a pending test intent',async t=>{
 const f=loopFixture(t);f.loop.config.checks.other={...f.spec.check};
 const spec={name:'other',repo:f.repo,commit:f.spec.commit,tree:f.spec.tree,check:f.loop.config.checks.other,home:path.join(f.root,'test-home')};
 const intent={name:'other',directory:path.join(f.root,'pending'),spec};f.loop.round.test_intent=intent;f.loop.save('intent');
 await assert.rejects(f.loop.test(['oracle']),/pending|intent/i);assert.deepEqual(f.loop.round.test_intent,intent);
});
test('surviving test process blocks retries until explicit verified recovery',async t=>{
 const f=loopFixture(t);f.loop.state.phase='judging';f.loop.state.blocked_test={pid:process.pid,start:null};f.loop.save('blocked');
 await assert.rejects(f.loop.test(),/recovery|surviving|blocked/i);assert.throws(()=>f.loop.recoverTests(),/alive|running|surviving/i);
 f.loop.state.blocked_test={pid:999999999,start:'nonexistent'};f.loop.recoverTests();assert.equal(f.loop.state.blocked_test,undefined);assert.equal(f.loop.state.phase,'judging');
});
test('freezer rejects task paths inside the candidate including dot prefixes and symlink aliases',t=>{
 const f=loopFixture(t);const inside=path.join(f.repo,'..task');fs.mkdirSync(inside);fs.writeFileSync(path.join(inside,'config.json'),JSON.stringify({repo:f.repo}));
 assert.throws(()=>freezeEngine(inside),/outside/i);
 const alias=path.join(f.root,'alias');fs.symlinkSync(inside,alias,'dir');assert.throws(()=>freezeEngine(alias),/outside/i);
});
test('publication reconciles a lost create acknowledgement and refuses changed intent or wrong head',async t=>{
 const f=loopFixture(t);f.loop.config.github_repo='owner/repo';f.loop.config.base_branch='main';f.loop.config.pr_title='Reviewed repair';f.loop.state.config_digest=identity(f.loop.config);f.loop.save('config');
 spawnSync('git',['-C',f.repo,'switch','-c','codex/oracle'],{encoding:'utf8'});
 await f.loop.test();const r=f.loop.round;const judge=path.join(f.root,'approve.json');fs.writeFileSync(judge,JSON.stringify({round:1,plan_digest:'plan',verdict:'accept',reason:'reviewed',tree:r.candidate_tree}));f.loop.judge(judge);
 const body=path.join(f.root,'body.md');fs.writeFileSync(body,'Verified repair\n');
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);const storage=path.join(f.root,'remote.json');const calls=path.join(f.root,'calls.jsonl');
 const row={url:'https://github.com/owner/repo/pull/1',state:'OPEN',headRefName:'codex/oracle',headRefOid:r.candidate_commit,baseRefName:'main',headRepository:{name:'repo'},headRepositoryOwner:{login:'owner'},title:f.loop.config.pr_title,body:'Verified repair\n'};
 fs.writeFileSync(path.join(bin,'gh'),`#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2),store=${JSON.stringify(storage)},calls=${JSON.stringify(calls)};fs.appendFileSync(calls,JSON.stringify(args)+'\\n');if(args[1]==='list'){console.log(fs.existsSync(store)?'['+fs.readFileSync(store,'utf8')+']':'[]');}else if(args[1]==='create'){fs.writeFileSync(store,JSON.stringify(${JSON.stringify(row)}));console.error('simulated lost acknowledgement');process.exit(1);}else{throw Error('unexpected gh operation')}`,{mode:0o755});
 const git=f.loop.repo.git.bind(f.loop.repo);let pushes=0;f.loop.repo.git=(args,options)=>{if(args[0]==='push'){pushes++;assert.ok(args.some(a=>a.includes(r.candidate_commit)),'push exact accepted SHA');return '';}return git(args,options);};
 const old=process.env.PATH;process.env.PATH=bin+path.delimiter+old;
 try{
  assert.throws(()=>f.loop.publish(body),/lost acknowledgement/);assert.ok(f.loop.state.publication);
  fs.writeFileSync(body,'changed');assert.throws(()=>f.loop.publish(body),/intent|body|changed/i);assert.equal(pushes,1);
  fs.writeFileSync(body,'Verified repair\n');fs.writeFileSync(storage,JSON.stringify({...row,headRefOid:'wrong'}));assert.throws(()=>f.loop.publish(body),/head|mismatch|receipt/i);
  fs.writeFileSync(storage,JSON.stringify(row));assert.equal(f.loop.publish(body),row.url);
  const operations=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(operations.filter(a=>a[1]==='create').length,1);
 }finally{process.env.PATH=old;}
});
test('candidate application recovers staged changes and a lost HEAD-update acknowledgement',t=>{
 const f=loopFixture(t);const git=args=>{const p=spawnSync('git',['-C',f.repo,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
 const base=git(['rev-parse','HEAD']),baseTree=git(['rev-parse','HEAD^{tree}']);fs.writeFileSync(path.join(f.repo,'source.txt'),'candidate\n');git(['add','source.txt']);const tree=git(['write-tree']);const commit=git(['commit-tree',tree,'-p',base,'-m','candidate']);
 f.loop.round.base=base;f.loop.round.base_tree=baseTree;f.loop.round.candidate_tree=tree;f.loop.round.candidate_commit=commit;f.loop.state.phase='apply';f.loop.save('candidate_intent');const durable=fs.readFileSync(path.join(f.root,'state.json'));
 f.loop.apply();assert.equal(git(['rev-parse','HEAD']),commit);assert.equal(f.loop.state.phase,'test');
 fs.writeFileSync(path.join(f.root,'state.json'),durable);const restored=new JudgedLoop(f.root);restored.apply();assert.equal(git(['rev-list','--count','HEAD']),'2');assert.equal(git(['status','--porcelain']),'');
});
test('a second CLI controller cannot enter while the task lock is held',async t=>{
 const f=loopFixture(t);const lock=path.join(f.root,'lock');
 const holder=spawn('flock',[lock,process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(path.join(f.root,'locked'))},'1');setInterval(()=>{},1000)`],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-holder.pid,'SIGKILL');}catch{}});
 for(let i=0;i<100&&!fs.existsSync(path.join(f.root,'locked'));i++)await delay(20);
 assert.ok(fs.existsSync(path.join(f.root,'locked')));const before=fs.readFileSync(path.join(f.root,'state.json'),'utf8');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./loop.mjs',import.meta.url)),f.root,'status'],{encoding:'utf8',env:{...process.env,HR_JUDGED_LOCKED:''}});
 assert.notEqual(result.status,0);assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),before);
});

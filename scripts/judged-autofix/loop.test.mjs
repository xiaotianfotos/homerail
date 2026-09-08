import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import { prepareModel, reconcileSubmission } from './model.mjs';

// Judger-owned acceptance oracle: no real provider or GitHub calls.
nodeTest('submission freezes definition pins and replays the exact saved POST after lost acknowledgement', async () => {
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

nodeTest('retry conflicts and a receipt for another run are rejected',async()=>{
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
function loopFixture(t,code="console.log('trusted')",overrides={}){
 const f=fixture(t,code);const root=path.join(f.root,'task');fs.mkdirSync(root);
 const config={id:'test',repo:f.repo,checks:{oracle:f.spec.check},publish_checks:['oracle'],...overrides};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));const loop=new JudgedLoop(root);
 loop.state.phase='test';loop.state.rounds=[{index:1,plan:{checks:['oracle']},plan_digest:'plan',candidate_commit:f.spec.commit,candidate_tree:f.spec.tree}];loop.save('fixture');return {...f,root,loop};
}
function terminalModelFixture(t, options={}) {
 const f=loopFixture(t,"console.log('trusted')",{manager_url:'http://manager.invalid'});
 const r=f.loop.round;
 r.plan.allowed_paths=['source.txt'];
 Object.assign(r,{base:r.candidate_commit,base_tree:r.candidate_tree,run_id:'saved-run',state:'running',kind:'propose'});
 delete r.candidate_commit;delete r.candidate_tree;
 f.loop.state.phase='model';f.loop.save('terminal_model_fixture');
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  calls.push({url,method:init?.method});
  if(url.endsWith('/status'))return new Response(JSON.stringify({data:{terminal:true,status:options.status??'completed',created_at:'2026-09-08T00:00:00Z',completed_at:'2026-09-08T00:00:10Z'}}));
  if(url.endsWith('/chat'))return new Response(JSON.stringify({data:{messages:[{content:{type:'usage',execution_id:'first',usage:{input_tokens:10,output_tokens:5}}},{content:{text:'Saved candidate draft'}}]}}));
  if(url.endsWith('/artifacts'))return new Response(JSON.stringify({data:{artifacts:options.raw===undefined?[]:[{name:'result.json',status:'ready'}]}}));
  if(url.endsWith('/content'))return options.httpError?new Response('temporarily unavailable',{status:503}):new Response(options.raw);
  throw new Error('unexpected request '+url);
 });
 return {...f,calls};
}
test('terminal run without result enters durable judgment instead of polling forever',async t=>{
 const f=terminalModelFixture(t);
 await f.loop.step();
 assert.equal(f.loop.state.phase,'judging');
 assert.equal(f.loop.round.failure.category,'model_result');
 assert.equal(f.loop.round.failure.code,'missing_result_artifact');
 assert.equal(f.loop.round.failure.status,'completed');
 assert.equal(f.loop.round.metrics.tokens,15);
 assert.equal(f.loop.round.candidate_commit,undefined);
 assert.ok(fs.existsSync(path.join(f.root,'rounds/1/chat.json')));
 const restarted=new JudgedLoop(f.root),count=f.calls.length;
 assert.deepEqual(restarted.round.failure,f.loop.round.failure);
 await restarted.step();assert.equal(f.calls.length,count,'terminal evidence gap must not keep polling');
 const j=path.join(f.root,'revise.json');fs.writeFileSync(j,JSON.stringify({round:1,plan_digest:'plan',verdict:'revise',reason:'Saved terminal evidence inspected; authorize a new scoped attempt'}));
 restarted.judge(j);
 const p=path.join(f.root,'plan.json');fs.writeFileSync(p,JSON.stringify({objective:'repair remaining issue',strategy:'Edit only source.txt using a fresh context',allowed_paths:['source.txt'],checks:['oracle'],context:[{path:'source.txt'}]}));
 restarted.plan(p);
 assert.equal(restarted.round.index,2);assert.equal(restarted.round.base,f.spec.commit);
 const input=JSON.parse(fs.readFileSync(path.join(f.root,'rounds/2/input.json'),'utf8'));
 assert.equal(input.previous[0].failure.code,'missing_result_artifact');
 assert.equal(f.calls.length,count,'authorizing next round must not resubmit the completed run');
});
test('invalid JSON result is retained verbatim and reaches judgment',async t=>{
 const raw='{"edits":[{"path":"source.txt","old":"original"';
 const f=terminalModelFixture(t,{raw});await f.loop.step();
 assert.equal(f.loop.state.phase,'judging');
 assert.equal(f.loop.round.failure.category,'model_result');
 assert.equal(f.loop.round.failure.code,'invalid_result_json');
 assert.equal(f.loop.round.failure.status,'completed');
 assert.equal(fs.readFileSync(path.join(f.root,'rounds/1/result.json'),'utf8'),raw);
 assert.equal(f.loop.round.candidate_commit,undefined);
 assert.equal(new JudgedLoop(f.root).round.failure.code,'invalid_result_json');
});
test('JSON null and invalid summary proposals reach judgment without escaping the collection boundary',async t=>{
 for(const value of [null,{edits:[{path:'source.txt',old:'original',new:'changed'}],summary:null}])await t.test(JSON.stringify(value),async child=>{
  const f=terminalModelFixture(child,{raw:JSON.stringify(value)});await f.loop.step();
  assert.equal(f.loop.state.phase,'judging');assert.equal(f.loop.round.failure.category,'proposal');
  assert.equal(f.loop.round.candidate_commit,undefined);
  assert.equal(new JudgedLoop(f.root).round.failure.category,'proposal');
  assert.equal(fs.readFileSync(path.join(f.root,'rounds/1/result.json'),'utf8'),JSON.stringify(value));
 });
});
test('failed or cancelled terminal runs cannot apply a ready proposal',async t=>{
 for(const status of ['failed','cancelled'])await t.test(status,async child=>{
  const raw=JSON.stringify({edits:[{path:'source.txt',old:'original',new:'unexpected'}],summary:'must remain a draft'});
  const f=terminalModelFixture(child,{status,raw});await f.loop.step();
  assert.equal(f.loop.state.phase,'judging');assert.equal(f.loop.round.failure.status,status);
  assert.equal(f.loop.round.failure.category,'model_terminal');assert.equal(f.loop.round.candidate_commit,undefined);
  assert.equal(fs.readFileSync(path.join(f.repo,'source.txt'),'utf8'),'original\n');
  assert.equal(fs.readFileSync(path.join(f.root,'rounds/1/result.json'),'utf8'),raw);
 });
});
test('transient result fetch failure remains retryable on the same run',async t=>{
 const f=terminalModelFixture(t,{raw:'{}',httpError:true});
 await assert.rejects(f.loop.step(),/503/);
 const restarted=new JudgedLoop(f.root);assert.equal(restarted.state.phase,'model');assert.equal(restarted.round.run_id,'saved-run');
 assert.equal(restarted.round.failure,undefined);
 assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('proposal persistence failure propagates and resumes the saved run after controller restart',async t=>{
 const raw=JSON.stringify({edits:[{path:'source.txt',old:'original',new:'recovered'}],summary:'saved valid proposal'});
 const f=terminalModelFixture(t,{raw});
 const rename=fs.renameSync;let fail=true;
 t.mock.method(fs,'renameSync',(from,to)=>{
  if(fail&&String(to).endsWith('/proposal.json')){fail=false;throw Object.assign(new Error('simulated proposal persistence ENOSPC'),{code:'ENOSPC'});}
  return rename(from,to);
 });
 await assert.rejects(f.loop.step(),/ENOSPC/);
 // The CLI persists controller_error before exiting; exercise that same
 // save, so retry cannot depend on discarding in-memory mutations.
 f.loop.save('controller_error',{message:'simulated proposal persistence ENOSPC'});
 const restarted=new JudgedLoop(f.root);
 assert.equal(restarted.state.phase,'model');assert.equal(restarted.round.failure,undefined);
 assert.equal(restarted.round.run_id,'saved-run');
 assert.equal(fs.readFileSync(path.join(f.root,'rounds/1/result.json'),'utf8'),raw);
 await restarted.step();assert.equal(restarted.state.phase,'apply');
 assert.equal(restarted.round.run_id,'saved-run');assert.equal(restarted.round.failure,undefined);
 restarted.apply();assert.equal(fs.readFileSync(path.join(f.repo,'source.txt'),'utf8'),'recovered\n');
 assert.ok(f.calls.every(c=>c.method==='GET'),'recovery must not create another model run');
});
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
 const f=loopFixture(t,undefined,{publish_checks:undefined});f.loop.config.github_repo='owner/repo';f.loop.config.base_branch='main';f.loop.config.pr_title='Reviewed repair';f.loop.state.config_digest=identity(f.loop.config);f.loop.save('config');
 spawnSync('git',['-C',f.repo,'switch','-c','codex/oracle'],{encoding:'utf8'});
 await f.loop.test();const r=f.loop.round;const judge=path.join(f.root,'approve.json');fs.writeFileSync(judge,JSON.stringify({round:1,plan_digest:'plan',verdict:'accept',reason:'reviewed',tree:r.candidate_tree}));f.loop.judge(judge);
 const body=path.join(f.root,'body.md');fs.writeFileSync(body,'Verified repair\n');
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);const storage=path.join(f.root,'remote.json');const calls=path.join(f.root,'calls.jsonl');
 const row={url:'https://github.com/owner/repo/pull/1',state:'OPEN',headRefName:'codex/oracle',headRefOid:r.candidate_commit,baseRefName:'main',headRepository:{name:'repo'},headRepositoryOwner:{login:'owner'},title:f.loop.config.pr_title,body:'Verified repair\n'};
 fs.writeFileSync(path.join(bin,'gh'),`#!${process.execPath}\nconst fs=require('fs'),args=process.argv.slice(2),store=${JSON.stringify(storage)},calls=${JSON.stringify(calls)};fs.appendFileSync(calls,JSON.stringify(args)+'\\n');if(args[1]==='list'){console.log(fs.existsSync(store)?'['+fs.readFileSync(store,'utf8')+']':'[]');}else if(args[1]==='create'){const b=args[args.indexOf('--body-file')+1];if(!require('path').isAbsolute(b))throw Error('body-file must be absolute');fs.readFileSync(b);fs.writeFileSync(store,JSON.stringify(${JSON.stringify(row)}));console.error('simulated lost acknowledgement');process.exit(1);}else{throw Error('unexpected gh operation')}`,{mode:0o755});
 const git=f.loop.repo.git.bind(f.loop.repo);let pushes=0;f.loop.repo.git=(args,options)=>{if(args[0]==='push'){pushes++;assert.ok(args.some(a=>a.includes(r.candidate_commit)),'push exact accepted SHA');return '';}return git(args,options);};
 const old=process.env.PATH;process.env.PATH=bin+path.delimiter+old;
 try{
  assert.throws(()=>f.loop.publish(path.relative(process.cwd(),body)),/lost acknowledgement/);assert.ok(f.loop.state.publication);
  fs.writeFileSync(body,'changed');assert.throws(()=>f.loop.publish(path.relative(process.cwd(),body)),/intent|body|changed/i);assert.equal(pushes,1);
  fs.writeFileSync(body,'Verified repair\n');fs.writeFileSync(storage,JSON.stringify({...row,headRefOid:'wrong'}));assert.throws(()=>f.loop.publish(path.relative(process.cwd(),body)),/head|mismatch|receipt/i);
  fs.writeFileSync(storage,JSON.stringify(row));assert.equal(f.loop.publish(path.relative(process.cwd(),body)),row.url);
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
for (const trailing of ['\n', 'keep with trailing spaces   \n']) {
 test(`unstaged candidate application preserves raw final patch context ${JSON.stringify(trailing)}`, t => {
  const f=loopFixture(t);const git=args=>{const p=spawnSync('git',['-C',f.repo,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
  const original='original\nkeep-a\nkeep-b\n'+trailing;
  const updated='candidate\nkeep-a\nkeep-b\n'+trailing;
  fs.writeFileSync(path.join(f.repo,'source.txt'),original);git(['add','source.txt']);git(['commit','-qm','trailing-context-base']);
  const base=git(['rev-parse','HEAD']),baseTree=git(['rev-parse','HEAD^{tree}']);
  fs.writeFileSync(path.join(f.repo,'source.txt'),updated);git(['add','source.txt']);const tree=git(['write-tree']);const commit=git(['commit-tree',tree,'-p',base,'-m','saved candidate']);
  // Unlike the existing staged-index recovery fixture, force the normal
  // application path to generate a patch and apply it from the base index.
  git(['read-tree',baseTree]);fs.writeFileSync(path.join(f.repo,'source.txt'),original);
  assert.equal(git(['status','--porcelain']),'');
  Object.assign(f.loop.round,{base,base_tree:baseTree,candidate_tree:tree,candidate_commit:commit});
  f.loop.state.phase='apply';f.loop.save('candidate_intent');const durable=fs.readFileSync(path.join(f.root,'state.json'));
  const resumed=new JudgedLoop(f.root);resumed.apply();
  assert.equal(git(['rev-parse','HEAD']),commit);assert.equal(git(['write-tree']),tree);
  assert.equal(fs.readFileSync(path.join(f.repo,'source.txt'),'utf8'),updated);assert.equal(git(['status','--porcelain']),'');
  fs.writeFileSync(path.join(f.root,'state.json'),durable);
  new JudgedLoop(f.root).apply();assert.equal(git(['rev-parse','HEAD']),commit);
  assert.equal(git(['rev-list','--count','HEAD']),'3','restart must not create another candidate commit');
 });
}

test('a second CLI controller cannot enter while the task lock is held',async t=>{
 const f=loopFixture(t);const lock=path.join(f.root,'lock');
 const holder=spawn('flock',[lock,process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(path.join(f.root,'locked'))},'1');setInterval(()=>{},1000)`],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-holder.pid,'SIGKILL');}catch{}});
 for(let i=0;i<100&&!fs.existsSync(path.join(f.root,'locked'));i++)await delay(20);
 assert.ok(fs.existsSync(path.join(f.root,'locked')));const before=fs.readFileSync(path.join(f.root,'state.json'),'utf8');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./loop.mjs',import.meta.url)),f.root,'status'],{encoding:'utf8',env:{...process.env,HR_JUDGED_LOCKED:''}});
 assert.notEqual(result.status,0);assert.equal(fs.readFileSync(path.join(f.root,'state.json'),'utf8'),before);
});
test('Judger can retain valid edits from a rejected result without another model request',t=>{
 const f=loopFixture(t);const r=f.loop.round;r.base=f.spec.commit;r.base_tree=f.spec.tree;delete r.candidate_commit;delete r.candidate_tree;
 r.plan={allowed_paths:['source.txt'],checks:['oracle']};r.plan_digest=identity(r.plan);r.failure={category:'proposal',message:'bad anchor'};r.run_id='saved-model-run';r.summary='Retained model proposal';f.loop.state.phase='judging';f.loop.save('rejected');
 const proposal={summary:'model result',edits:[{path:'source.txt',old:'original\n',new:'retained\n'},{path:'source.txt',old:'nonexistent',new:'invalid'}]};fs.mkdirSync(f.loop.directory(),{recursive:true});const file=path.join(f.loop.directory(),'proposal.json');fs.writeFileSync(file,JSON.stringify(proposal));const original=fs.readFileSync(file,'utf8');
 const selection={round:1,plan_digest:r.plan_digest,proposal_digest:identity(proposal),base:r.base,indices:[0],reason:'Judger reviewed valid retained edit; invalid optional edit deferred'};const decision=path.join(f.root,'selection.json');
 fs.writeFileSync(decision,JSON.stringify({...selection,indices:[1]}));assert.throws(()=>f.loop.selectEdits(decision),/anchor|match/i);assert.equal(f.loop.state.phase,'judging');
 fs.writeFileSync(decision,JSON.stringify({...selection,proposal_digest:'wrong'}));assert.throws(()=>f.loop.selectEdits(decision),/digest|identity|proposal/i);
 fs.writeFileSync(decision,JSON.stringify(selection));f.loop.selectEdits(decision);assert.equal(f.loop.state.phase,'apply');assert.equal(r.proposal_failure.category,'proposal');assert.equal(r.failure,undefined);assert.equal(fs.readFileSync(file,'utf8'),original);
 f.loop.apply();assert.equal(fs.readFileSync(path.join(f.repo,'source.txt'),'utf8'),'retained\n');assert.deepEqual(r.selection.indices,[0]);
});

test('Judger can revoke acceptance after a publication failure without losing evidence',async t=>{
 const f=loopFixture(t);await f.loop.test();const r=f.loop.round;const decision=path.join(f.root,'decision.json');
 const accept={round:1,plan_digest:'plan',verdict:'accept',reason:'reviewed',tree:r.candidate_tree};fs.writeFileSync(decision,JSON.stringify(accept));f.loop.judge(decision);
 const accepted=r.judgment;const receipts=JSON.stringify(r.receipts);const publication={head:r.candidate_commit,branch:'codex/oracle',body_digest:'saved'};f.loop.state.publication=publication;f.loop.save('publication_intent');
 fs.writeFileSync(decision,JSON.stringify({round:1,plan_digest:'wrong',verdict:'revise',reason:'invalid'}));assert.throws(()=>f.loop.judge(decision));assert.equal(f.loop.state.phase,'accepted');
 fs.writeFileSync(decision,JSON.stringify({round:1,plan_digest:'plan',verdict:'revise',reason:'new publication finding; reopen for repair'}));f.loop.judge(decision);
 assert.equal(f.loop.state.phase,'judging');assert.equal(r.judgment.verdict,'revise');assert.deepEqual(r.judgment_history.at(-1),accepted);assert.deepEqual(f.loop.state.publication_history.at(-1),publication);assert.equal(f.loop.state.publication,undefined);assert.equal(JSON.stringify(r.receipts),receipts);
});


test('omitted publication checks resume immutable task state and still require all plan evidence',async t=>{
 const f=loopFixture(t,undefined,{publish_checks:undefined});
 const raw=fs.readFileSync(path.join(f.root,'config.json'),'utf8');
 const initialDigest=f.loop.state.config_digest;
 assert.throws(()=>f.loop.assertEvidence(),/missing trusted passing receipt/i);
 await f.loop.test();
 const restored=new JudgedLoop(f.root);
 assert.equal(restored.state.config_digest,initialDigest);
 const receipts=JSON.stringify(restored.round.receipts);
 const decision=path.join(f.root,'decision.json');
 fs.writeFileSync(decision,JSON.stringify({round:1,plan_digest:'plan',tree:restored.round.candidate_tree,verdict:'accept',reason:'reviewed omitted optional config'}));
 restored.judge(decision);
 assert.equal(restored.state.phase,'accepted');
 assert.equal(JSON.stringify(restored.round.receipts),receipts);
 assert.equal(fs.readFileSync(path.join(f.root,'config.json'),'utf8'),raw);
 assert.equal(restored.state.config_digest,identity(JSON.parse(raw)));
});

test('invalid explicit publication checks fail before task state or model work exists',t=>{
 for(const bad of [null,'oracle',{},['missing'],[1],['toString'],['constructor']]){
  const f=fixture(t,"console.log('unused')");
  const task=path.join(f.root,'task');fs.mkdirSync(task);
  fs.writeFileSync(path.join(task,'config.json'),JSON.stringify({id:'bad-config',repo:f.repo,checks:{oracle:f.spec.check},publish_checks:bad}));
  assert.throws(()=>new JudgedLoop(task),/publish_checks/i,JSON.stringify(bad));
  assert.ok(!fs.existsSync(path.join(task,'state.json')));
  assert.ok(!fs.existsSync(path.join(task,'rounds')));
 }
});


async function publicationUpdateFixture(t, mode='normal') {
 const f=loopFixture(t,undefined,{publish_checks:undefined});
 Object.assign(f.loop.config,{github_repo:'owner/repo',base_branch:'main',pr_title:'Reviewed repair'});
 fs.writeFileSync(path.join(f.root,'config.json'),JSON.stringify(f.loop.config));
 f.loop.state.config_digest=identity(f.loop.config);f.loop.save('config');
 spawnSync('git',['-C',f.repo,'switch','-c','codex/oracle'],{encoding:'utf8'});
 await f.loop.test();const r=f.loop.round;
 const judge=path.join(f.root,'approve.json');fs.writeFileSync(judge,JSON.stringify({round:1,plan_digest:'plan',verdict:'accept',reason:'reviewed',tree:r.candidate_tree}));f.loop.judge(judge);
 const previousBody='Previously verified repair\n',nextBody='Verified follow-up\n';
 const body=path.join(f.root,'body.md');fs.writeFileSync(body,nextBody);
 const row={url:'https://github.com/owner/repo/pull/1',state:'OPEN',headRefName:'codex/oracle',headRefOid:r.candidate_commit,baseRefName:'main',headRepository:{name:'repo'},headRepositoryOwner:{login:'owner'},title:f.loop.config.pr_title,body:previousBody};
 const previous={head:'a'.repeat(40),branch:'codex/oracle',repo:'owner/repo',base:'main',title:row.title,body_digest:digest(Buffer.from(previousBody)),url:row.url};
 f.loop.state.publication_history=[previous];f.loop.save('previous_publication');
 const bin=path.join(f.root,'bin');fs.mkdirSync(bin);const storage=path.join(f.root,'remote.json'),calls=path.join(f.root,'calls.jsonl'),updates=path.join(f.root,'updates'),stale=path.join(f.root,'stale');fs.writeFileSync(storage,JSON.stringify(row));
 const setup={storage,calls,updates,stale,mode,state:f.loop.file,old:row,targetFile:body};
 fs.writeFileSync(path.join(bin,'gh'),`#!${process.execPath}\nconst fs=require('fs'),assert=require('assert/strict'),crypto=require('crypto');const cfg=${JSON.stringify(setup)};const args=process.argv.slice(2);fs.appendFileSync(cfg.calls,JSON.stringify(args)+'\\n');
 if(args[0]==='pr'&&args[1]==='list'){
  if(cfg.mode==='stale'&&fs.existsSync(cfg.updates)&&!fs.existsSync(cfg.stale)){fs.writeFileSync(cfg.stale,'1');console.log(JSON.stringify([cfg.old]));}
  else console.log('['+fs.readFileSync(cfg.storage,'utf8')+']');
 }else if(args[0]==='api'){
  assert.ok(args.includes('PATCH'));assert.ok(args.includes('repos/owner/repo/pulls/1'));
  const p=args[args.indexOf('--input')+1];assert.ok(require('path').isAbsolute(p));const input=JSON.parse(fs.readFileSync(p,'utf8'));assert.deepEqual(input,{body:fs.readFileSync(cfg.targetFile,'utf8')});
  const state=JSON.parse(fs.readFileSync(cfg.state,'utf8'));const intent=state.publication.body_update;
  const current=JSON.parse(fs.readFileSync(cfg.storage,'utf8'));
  const sha=s=>crypto.createHash('sha256').update(s).digest('hex');assert.equal(intent.url,cfg.old.url);assert.equal(intent.from_body_digest,sha(current.body));assert.equal(intent.to_body_digest,sha(input.body));assert.equal(intent.attempted,true);
  current.body=input.body;fs.writeFileSync(cfg.storage,JSON.stringify(current));fs.appendFileSync(cfg.updates,'x');
  if(cfg.mode==='lost_ack'){console.error('simulated lost update acknowledgement');process.exit(1);}console.log(JSON.stringify(current));
 }else{throw Error('unexpected GitHub mutation: '+JSON.stringify(args));}`,{mode:0o755});
 const originalPath=process.env.PATH;process.env.PATH=bin+path.delimiter+originalPath;t.after(()=>{process.env.PATH=originalPath;});
 const attach=loop=>{const git=loop.repo.git.bind(loop.repo);loop.repo.git=(args,options)=>args[0]==='push'?'':git(args,options);return loop;};attach(f.loop);
 return {...f,body,row,previous,storage,calls,updates,attach};
}

test('owned PR description updates through a durable approved intent',async t=>{
 const f=await publicationUpdateFixture(t);assert.equal(f.loop.publish(f.body),f.row.url);
 assert.equal(JSON.parse(fs.readFileSync(f.storage)).body,fs.readFileSync(f.body,'utf8'));
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
 const state=JSON.parse(fs.readFileSync(f.loop.file));assert.equal(state.publication.url,f.row.url);assert.deepEqual(state.publication_history,[f.previous]);
});
for(const mode of ['lost_ack','stale'])test(`owned PR update reconciles ${mode} after controller reopen without another write`,async t=>{
 const f=await publicationUpdateFixture(t,mode);assert.throws(()=>f.loop.publish(f.body));
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
 const reopened=f.attach(new JudgedLoop(f.root));assert.equal(reopened.publish(f.body),f.row.url);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(a=>a[0]==='api').length,1);assert.equal(calls.filter(a=>a[1]==='create').length,0);
});
for(const scenario of ['external_body','wrong_head','wrong_base','wrong_url','unconfirmed_history','old_history'])test(`PR description update refuses ${scenario} without a write`,async t=>{
 const f=await publicationUpdateFixture(t);const row={...f.row};
 if(scenario==='external_body')row.body='Externally edited description';
 if(scenario==='wrong_head')row.headRefOid='c'.repeat(40);
 if(scenario==='wrong_base')row.baseRefName='other';
 if(scenario==='wrong_url')row.url='https://github.com/owner/repo/pull/99';
 if(scenario==='unconfirmed_history')delete f.loop.state.publication_history[0].url;
 if(scenario==='old_history')f.loop.state.publication_history.push({...f.previous,body_digest:digest(Buffer.from('Later confirmed body'))});
 f.loop.save('fixture_history');fs.writeFileSync(f.storage,JSON.stringify(row));assert.throws(()=>f.loop.publish(f.body));assert.equal(fs.existsSync(f.updates),false);
});
test('an ambiguous attempted PR body update waits for reconciliation instead of repeating the write',async t=>{
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body));
 fs.writeFileSync(f.storage,JSON.stringify(f.row));const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});
test('pending PR update does not adopt a replacement URL even if its body matches',async t=>{
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body));
 const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.url='https://github.com/owner/repo/pull/99';fs.writeFileSync(f.storage,JSON.stringify(row));
 const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});

test('completed PR body update does not overwrite a later external restoration of the old text',async t=>{
 const f=await publicationUpdateFixture(t);assert.equal(f.loop.publish(f.body),f.row.url);
 fs.writeFileSync(f.storage,JSON.stringify(f.row));const reopened=f.attach(new JudgedLoop(f.root));
 assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});
test('target-visible reconciliation still verifies the persisted body update target digest',async t=>{
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body));
 f.loop.state.publication.body_update.to_body_digest='0'.repeat(64);f.loop.save('mismatched_update_intent');
 const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});

for(const marker of ['legacy_without_marker','confirmed_without_attempt'])test(`confirmed publication with ${marker} refuses body drift without another update`,async t=>{
 const f=await publicationUpdateFixture(t);assert.equal(f.loop.publish(f.body),f.row.url);
 if(marker==='legacy_without_marker')delete f.loop.state.publication.body_update;
 else f.loop.state.publication.body_update.attempted=false;
 f.loop.save('confirmed_fixture');fs.writeFileSync(f.storage,JSON.stringify(f.row));
 const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});

test('legacy confirmed publication refuses a replacement URL with the expected body',async t=>{
 const f=await publicationUpdateFixture(t);assert.equal(f.loop.publish(f.body),f.row.url);
 delete f.loop.state.publication.body_update;f.loop.save('legacy_confirmed');
 const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.url='https://github.com/owner/repo/pull/99';fs.writeFileSync(f.storage,JSON.stringify(row));
 const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});


async function nextPublicationRevision(f) {
 const r=f.loop.round;const file=path.join(f.root,'next-judgment.json');
 fs.writeFileSync(file,JSON.stringify({round:r.index,plan_digest:r.plan_digest,verdict:'revise',reason:'Authorize next repair after response loss'}));f.loop.judge(file);
 fs.writeFileSync(path.join(f.repo,'source.txt'),'next validated revision\n');f.loop.repo.git(['add','source.txt']);f.loop.repo.git(['commit','-qm','next repair']);
 const next={index:r.index+1,plan:{checks:['oracle']},plan_digest:'next-plan',candidate_commit:f.loop.repo.git(['rev-parse','HEAD']),candidate_tree:f.loop.repo.git(['rev-parse','HEAD^{tree}'])};
 f.loop.state.rounds.push(next);f.loop.state.phase='test';f.loop.save('next_candidate');await f.loop.test();
 fs.writeFileSync(file,JSON.stringify({round:next.index,plan_digest:next.plan_digest,tree:next.candidate_tree,verdict:'accept',reason:'Independent oracle accepts next candidate'}));f.loop.judge(file);
 const remote=JSON.parse(fs.readFileSync(f.storage,'utf8'));remote.headRefOid=next.candidate_commit;fs.writeFileSync(f.storage,JSON.stringify(remote));
 fs.writeFileSync(f.body,'Approved description for the next repair\n');
 return f.loop.state.publication_history.at(-1);
}
test('a new accepted revision reconciles an archived landed update before publishing its next body',async t=>{
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body),/lost update acknowledgement/);
 const priorTarget=JSON.parse(fs.readFileSync(f.storage,'utf8')).body;const archived=await nextPublicationRevision(f);assert.equal(archived.url,undefined);
 assert.throws(()=>f.loop.publish(f.body),/lost update acknowledgement/);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'xx');
 const reopened=f.attach(new JudgedLoop(f.root));assert.equal(reopened.publish(f.body),f.row.url);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'xx');assert.equal(reopened.state.publication_history.at(-1).url,f.row.url);
 assert.equal(reopened.state.publication_history.at(-1).body_digest,digest(Buffer.from(priorTarget)));
 assert.equal(reopened.state.publication_history.at(-1).body_update.confirmed,true);
 assert.equal(reopened.state.rounds.length,2);
});
for(const problem of ['wrong_url','wrong_target','not_attempted','invalid_source_hash','pending_target_absent','non_boolean_attempted','array_source_hash','invalid_archived_hash_pending'])test(`archived update reconciliation refuses ${problem} without another write`,async t=>{
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body),/lost update acknowledgement/);
 const archived=await nextPublicationRevision(f);
 if(problem==='wrong_url')archived.body_update.url='https://github.com/owner/repo/pull/99';
 if(problem==='wrong_target')archived.body_update.to_body_digest='0'.repeat(64);
 if(problem==='not_attempted')archived.body_update.attempted=false;
 if(problem==='invalid_source_hash')archived.body_update.from_body_digest='invalid';
 if(problem==='non_boolean_attempted')archived.body_update.attempted='true';
 if(problem==='array_source_hash')archived.body_update.from_body_digest=[archived.body_update.from_body_digest];
 if(problem==='invalid_archived_hash_pending'){archived.body_digest='invalid';const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.body=f.row.body;fs.writeFileSync(f.storage,JSON.stringify(row));}
 if(problem==='pending_target_absent'){const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.body=f.row.body;fs.writeFileSync(f.storage,JSON.stringify(row));}
 f.loop.save('archived_update_fixture');const reopened=f.attach(new JudgedLoop(f.root));assert.throws(()=>reopened.publish(f.body));
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');assert.equal(reopened.state.publication_history.at(-1).url,undefined);
});

function recoveryDecision(f, target='current', overrides={}) {
 const p=target==='current'?f.loop.state.publication:f.loop.state.publication_history[target];
 const r=f.loop.round;
 const j={action:'abandon-body-update-at-source',task_nonce:f.loop.state.task_nonce,round:r.index,plan_digest:r.plan_digest,head:r.candidate_commit,target,publication_digest:identity(p),previous_attempt_settled:true,reason:'Judger verified previous sender has settled; authorize a new publication intent from the observed owned source',...overrides};
 const file=path.join(f.root,'publication-recovery.json');fs.writeFileSync(file,JSON.stringify(j));return file;
}
async function absentUpdateFixture(t, archived=false) {
 const f=await publicationUpdateFixture(t,'lost_ack');assert.throws(()=>f.loop.publish(f.body));
 if(archived)await nextPublicationRevision(f);
 const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.body=f.row.body;fs.writeFileSync(f.storage,JSON.stringify(row));
 return f;
}
for(const archived of [false,true])test(`Judger explicitly resolves ${archived?'archived':'current'} absent update without erasing evidence or repeating authorization`,async t=>{
 const f=await absentUpdateFixture(t,archived),target=archived?f.loop.state.publication_history.length-1:'current';
 const pending=JSON.parse(JSON.stringify(target==='current'?f.loop.state.publication:f.loop.state.publication_history[target]));
 const decision=recoveryDecision(f,target),j=JSON.parse(fs.readFileSync(decision));
 f.loop.recoverPublication(decision);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x','recovery itself must never PATCH');
 const record=f.loop.state.publication_recoveries.at(-1);
 assert.deepEqual(record.publication,pending);assert.deepEqual(record.decision,j);assert.equal(record.decision_digest,identity(j));
 assert.equal(f.loop.state.publication_history.length,1);assert.deepEqual(f.loop.state.publication_history[0],f.previous);
 assert.equal(f.loop.state.publication,undefined);
 const reopened=f.attach(new JudgedLoop(f.root));
 assert.throws(()=>reopened.publish(f.body),/lost update acknowledgement/); // a single new authorized send
 assert.equal(fs.readFileSync(f.updates,'utf8'),'xx');
 const row=JSON.parse(fs.readFileSync(f.storage,'utf8'));row.body=f.row.body;fs.writeFileSync(f.storage,JSON.stringify(row));
 const before=JSON.stringify(reopened.state.publication);
 try{reopened.recoverPublication(decision);}catch{} // replay may be refused or acknowledged, but never reauthorize
 assert.equal(JSON.stringify(reopened.state.publication),before);
 assert.throws(()=>reopened.publish(f.body));assert.equal(fs.readFileSync(f.updates,'utf8'),'xx');
 assert.equal(reopened.state.publication_recoveries.length,1);
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(a=>a[1]==='create').length,0);
});
for(const bad of ['task','round','plan','head','snapshot','not_settled','string_settled','external_body','wrong_url','wrong_remote_head','bad_source','confirmed','missing_baseline','stale_history'])test(`publication recovery rejects ${bad} before changing custody`,async t=>{
 const f=await absentUpdateFixture(t,bad==='stale_history');let target=bad==='stale_history'?f.loop.state.publication_history.length-1:'current';
 if(bad==='bad_source')f.loop.state.publication.body_update.from_body_digest=['a'.repeat(64)];
 if(bad==='confirmed')f.loop.state.publication.body_update.confirmed=true;
 if(bad==='missing_baseline')f.loop.state.publication_history=[];
 if(bad==='stale_history')f.loop.state.publication_history.push({...f.previous});
 f.loop.save('recovery_negative_fixture');
 const override={};if(bad==='task')override.task_nonce='other';if(bad==='round')override.round=99;if(bad==='plan')override.plan_digest='other';if(bad==='head')override.head='a'.repeat(40);if(bad==='snapshot')override.publication_digest='0'.repeat(64);if(bad==='not_settled')override.previous_attempt_settled=false;if(bad==='string_settled')override.previous_attempt_settled='true';
 const decision=recoveryDecision(f,target,override),row=JSON.parse(fs.readFileSync(f.storage));
 if(bad==='external_body')row.body='unowned';if(bad==='wrong_url')row.url='https://github.com/owner/repo/pull/99';if(bad==='wrong_remote_head')row.headRefOid='b'.repeat(40);fs.writeFileSync(f.storage,JSON.stringify(row));
 const before=JSON.stringify(f.loop.state);assert.throws(()=>f.loop.recoverPublication(decision));assert.equal(JSON.stringify(f.loop.state),before);assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});

// The real CLI sequence first attempts publish in the new round, leaving a
// prepared current intent before it encounters the unresolved archived update.
test('archived recovery remains reachable after the next publish has already failed',async t=>{
 const f=await absentUpdateFixture(t,true);
 assert.throws(()=>f.loop.publish(f.body),/archived update reconciliation/);
 const active=JSON.parse(JSON.stringify(f.loop.state.publication));
 assert.equal(active.body_update,undefined);assert.equal(active.url,undefined);
 const target=f.loop.state.publication_history.length-1;
 const decision=recoveryDecision(f,target);
 f.loop.recoverPublication(decision);
 assert.deepEqual(f.loop.state.publication,active,'preserve current approved intent');
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
 const reopened=f.attach(new JudgedLoop(f.root));
 assert.throws(()=>reopened.publish(f.body),/lost update acknowledgement/);
 assert.equal(reopened.publish(f.body),f.row.url);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'xx');
 assert.equal(reopened.state.publication_recoveries.length,1);
});
for(const marker of [false,'true'])test(`recovery cannot skip intervening unresolved history with attempted=${marker}`,async t=>{
 const f=await absentUpdateFixture(t);
 const pending=JSON.parse(JSON.stringify(f.loop.state.publication));pending.body_update.attempted=marker;
 f.loop.state.publication_history.push(pending);f.loop.save('intervening_pending');
 const decision=recoveryDecision(f),before=JSON.stringify(f.loop.state);
 assert.throws(()=>f.loop.recoverPublication(decision));assert.equal(JSON.stringify(f.loop.state),before);
 assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});
for(const bad of ['attempted_update','confirmed_url','wrong_head','invalid_body_digest'])test(`archived recovery rejects an unsafe current intent: ${bad}`,async t=>{
 const f=await absentUpdateFixture(t,true);assert.throws(()=>f.loop.publish(f.body));
 const current=f.loop.state.publication;
 if(bad==='attempted_update')current.body_update={attempted:true};
 if(bad==='confirmed_url')current.url=f.row.url;
 if(bad==='wrong_head')current.head='0'.repeat(40);
 if(bad==='invalid_body_digest')current.body_digest=[current.body_digest];
 f.loop.save('unsafe_active_intent');const decision=recoveryDecision(f,f.loop.state.publication_history.length-1),before=JSON.stringify(f.loop.state);
 assert.throws(()=>f.loop.recoverPublication(decision));assert.equal(JSON.stringify(f.loop.state),before);assert.equal(fs.readFileSync(f.updates,'utf8'),'x');
});

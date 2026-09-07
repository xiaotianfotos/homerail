#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomic,identity,digest,Repository,safePath} from './evidence.mjs';
import {api,prepareModel,reconcileSubmission,collectModel} from './model.mjs';
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const now = () => new Date().toISOString();
export class JudgedLoop {
  constructor(root) {
    this.root=path.resolve(root);this.config=read(path.join(this.root,'config.json'));
    this.repo=new Repository(this.config.repo);this.file=path.join(this.root,'state.json');
    if(!path.isAbsolute(this.config.repo)||!this.config.id||!this.config.checks)throw new Error('invalid task configuration');
    this.state=fs.existsSync(this.file)?read(this.file):{version:1,config_digest:identity(this.config),phase:'ready',rounds:[],events:[]};
    if(this.state.config_digest!==identity(this.config))throw new Error('task configuration changed');
  }
  save(event,detail={}){this.state.events.push({at:now(),event,...detail});atomic(this.file,this.state);}
  get round(){return this.state.rounds.at(-1);}
  directory(r=this.round){return path.join(this.root,'rounds',String(r.index));}
  assertHead(expected){if(this.repo.git(['rev-parse','HEAD'])!==expected)throw new Error('candidate HEAD drift');}
  plan(file) {
    if(!['ready','judging'].includes(this.state.phase))throw new Error('finish current round before another plan');
    if(this.round&&!this.round.judgment)throw new Error('Judger must assess the previous round first');
    const plan=read(file);
    if(!plan.strategy||!plan.objective||!Array.isArray(plan.allowed_paths)||!plan.allowed_paths.length)throw new Error('Judger plan needs strategy/objective/scope');
    plan.allowed_paths.forEach(safePath);
    if(!Array.isArray(plan.checks)||!plan.checks.length||plan.checks.some(c=>!this.config.checks[c]))throw new Error('unknown or empty checks');
    if(this.repo.git(['status','--porcelain','--untracked-files=normal']))throw new Error('owned worktree must be clean before a round');
    const base=this.repo.git(['rev-parse','HEAD']),tree=this.repo.git(['rev-parse','HEAD^{tree}']);
    const context=(plan.context??[]).map(c=>{
      safePath(c.path);const lines=this.repo.git(['show',`${base}:${c.path}`]).split('\n');
      const start=c.start??1,end=c.end??lines.length;
      return {path:c.path,start,end,content:lines.slice(start-1,end).join('\n')};
    });
    const index=this.state.rounds.length+1;
    const input={objective:plan.objective,judger_strategy:plan.strategy,allowed_paths:plan.allowed_paths,source_commit:base,context,previous:this.state.rounds.slice(-3).map(r=>({round:r.index,summary:r.summary,judgment:r.judgment,failure:r.failure,checks:r.receipts?.map(x=>({name:x.name,status:x.status,tail:x.tail?.slice(-3000)}))}))};
    if(Buffer.byteLength(JSON.stringify(input))>96000)throw new Error('context exceeds 96 KiB; narrow the Judger plan');
    const r={index,base,base_tree:tree,plan,plan_digest:identity(plan),input_digest:identity(input),input_bytes:Buffer.byteLength(JSON.stringify(input)),workflow_id:`judged-${this.config.id}-${index}-${identity({base,plan}).slice(0,8)}`,kind:'propose',state:'prepared',created_at:now()};
    this.state.rounds.push(r);atomic(path.join(this.directory(r),'input.json'),input);this.state.phase='model';this.save('judger_plan_recorded');
  }
  async step() {
    const r=this.round;if(this.state.phase!=='model')return;
    const dir=this.directory();
    if(r.state==='prepared') {
      await prepareModel(this.config,r,read(path.join(dir,'input.json')));
      r.state='submitting';atomic(path.join(dir,'request.json'),r.payload);this.save('submission_intent');
      const response=await api(this.config,'/api/runs/create-and-run',r.payload);
      r.run_id=response.run_id??response.runId;r.state='running';this.save('submitted');return;
    }
    if(r.state==='submitting') {
      r.run_id=await reconcileSubmission(this.config,r);
      if(!r.run_id){this.save('submission_uncertain');return;}
      r.state='running';this.save('submission_recovered');
    }
    const result=await collectModel(this.config,r,dir);if(!result)return;
    r.state='finished';r.finished_at=now();
    if(result.failed){r.failure={category:'model_transport',status:result.status};this.state.phase='judging';this.save('model_failed');return;}
    atomic(path.join(dir,'proposal.json'),result.value);r.summary=result.value.summary;
    try {
      this.assertHead(r.base);
      const edits=result.value.edits;
      if(!Array.isArray(edits)||!edits.length||edits.length>20)throw new Error('invalid edits');
      const current=new Map(this.repo.entries(r.base_tree).filter(f=>r.plan.allowed_paths.includes(f.path)).map(f=>[f.path,this.repo.bytes(f.sha).toString('utf8')]));const output=new Map();
      if(Buffer.byteLength(JSON.stringify(result.value))>96000)throw new Error('proposal exceeds 96 KiB');
      for(const e of edits){
        safePath(e.path);if(!r.plan.allowed_paths.includes(e.path)||typeof e.old!=='string'||typeof e.new!=='string')throw new Error('edit outside Judger scope');
        const source=output.has(e.path)?output.get(e.path):current.get(e.path);
        if(e.old===''){if(source!==undefined)throw new Error('empty old is only for new files');output.set(e.path,e.new);}
        else {if(source===undefined||source.split(e.old).length!==2)throw new Error(`old text must match exactly once: ${e.path}`);output.set(e.path,source.replace(e.old,()=>e.new));}
      }
      const candidate=this.repo.apply(r.base_tree,{files:[...output].map(([path,content])=>({path,content}))},r.plan.allowed_paths);
      if(candidate===r.base_tree)throw new Error('no source change; Judger must revise plan');
      r.candidate_tree=candidate;r.candidate_commit=this.repo.git(['commit-tree',candidate,'-p',r.base],{input:`fix: ${r.summary.slice(0,150)}\n\nJudged-DAG-Run: ${r.run_id}\n`});
      this.state.phase='apply';this.save('candidate_intent');
    }catch(e){r.failure={category:'proposal',message:e.message};this.state.phase='judging';this.save('proposal_rejected');}
  }
  apply(){
    if(this.state.phase!=='apply')throw new Error('no candidate to apply');const r=this.round;
    const head=this.repo.git(['rev-parse','HEAD']);
    if(head===r.base){
      const index=this.repo.git(['write-tree']);
      if(index===r.base_tree){const patch=this.repo.git(['diff','--binary',r.base_tree,r.candidate_tree]);this.repo.git(['apply','--index','--binary','-'],{input:patch+'\n'});}
      else if(index!==r.candidate_tree)throw new Error('index drift during recovery');
      if(this.repo.git(['diff','--name-only']))throw new Error('worktree drift during recovery');
      this.repo.git(['update-ref','HEAD',r.candidate_commit,r.base]);
    }else if(head!==r.candidate_commit)throw new Error('HEAD drift during candidate recovery');
    this.state.phase='test';this.save('candidate_saved');
  }
  test(names=this.round.plan.checks){
    const r=this.round;if(!['test','judging','accepted'].includes(this.state.phase))throw new Error('candidate unavailable for testing');
    this.assertHead(r.candidate_commit);if(this.repo.git(['status','--porcelain']))throw new Error('candidate is dirty');
    r.receipts??=[];
    for(const name of names){
      const check=this.config.checks[name];if(!check)throw new Error('unknown check');
      const spec=identity(check);const prior=r.receipts.find(t=>t.name===name&&t.tree===r.candidate_tree&&t.spec_digest===spec&&t.status==='passed');
      if(prior){if(digest(fs.readFileSync(prior.log_path))!==prior.log_digest)throw new Error('test evidence changed');continue;}
      const attempt=r.receipts.length+1,log=path.join(this.directory(),`test-${attempt}-${name}.log`);
      const started=now();r.test_intent={name,tree:r.candidate_tree,spec_digest:spec,started_at:started};this.save('test_intent');
      const fd=fs.openSync(log,'w',0o600);
      const env={PATH:process.env.PATH,HOME:path.join(this.root,'test-home'),TMPDIR:process.env.TMPDIR??'/tmp',CI:'1',VITEST_MAX_WORKERS:'4'};fs.mkdirSync(env.HOME,{recursive:true});
      let result;try{result=spawnSync(check.argv[0],check.argv.slice(1),{cwd:path.resolve(this.config.repo,check.cwd??'.'),env,stdio:['ignore',fd,fd],timeout:check.timeout_ms??600000,killSignal:'SIGKILL'});}finally{fs.closeSync(fd);}
      const bytes=fs.readFileSync(log);const receipt={name,tree:r.candidate_tree,commit:r.candidate_commit,spec_digest:spec,argv:check.argv,started_at:started,finished_at:now(),status:result.error||result.signal?'infrastructure_failed':result.status===0?'passed':'failed',exit_code:result.status,signal:result.signal,error:result.error?.message,log_path:log,log_digest:digest(bytes),tail:bytes.toString('utf8').slice(-6000)};
      r.receipts.push(receipt);atomic(path.join(this.directory(),`receipt-${attempt}.json`),receipt);delete r.test_intent;this.save('test_recorded');
    }
    this.state.phase='judging';this.save('awaiting_judger');
  }
  judge(file){
    if(this.state.phase!=='judging')throw new Error('not awaiting judgment');const j=read(file),r=this.round;
    if(!['accept','revise'].includes(j.verdict)||!j.reason||j.round!==r.index||j.plan_digest!==r.plan_digest)throw new Error('invalid Judger decision');
    if(j.verdict==='accept'){
      if(!r.candidate_commit||j.tree!==r.candidate_tree)throw new Error('Judger must bind the exact candidate');
      this.assertHead(r.candidate_commit);
      for(const n of [...r.plan.checks,...this.config.publish_checks])if(!r.receipts?.some(t=>t.name===n&&t.status==='passed'&&t.tree===r.candidate_tree))throw new Error(`missing trusted passing check: ${n}`);
      this.state.phase='accepted';
    }
    r.judgment={...j,at:now()};atomic(path.join(this.directory(),'judgment.json'),r.judgment);this.save('judger_decision');
  }
  publish(bodyFile){
    if(this.state.phase!=='accepted')throw new Error('Judger acceptance required');const r=this.round;this.assertHead(r.candidate_commit);
    if(this.repo.git(['status','--porcelain']))throw new Error('dirty candidate');
    for(const t of r.receipts)if(digest(fs.readFileSync(t.log_path))!==t.log_digest)throw new Error('test log changed');
    const branch=this.repo.git(['branch','--show-current']);if(!branch.startsWith('codex/'))throw new Error('publication requires an isolated codex branch');
    this.state.publication??={head:r.candidate_commit,branch,body_digest:digest(fs.readFileSync(bodyFile))};this.save('publication_intent');
    this.repo.git(['push','-u','origin',branch]);
    const gh=args=>{const x=spawnSync('gh',args,{encoding:'utf8',cwd:this.config.repo});if(x.status!==0)throw new Error(x.stderr);return x.stdout;};
    const prs=JSON.parse(gh(['pr','list','--repo',this.config.github_repo,'--head',branch,'--state','open','--json','url']));
    const url=prs[0]?.url??gh(['pr','create','--repo',this.config.github_repo,'--head',branch,'--base',this.config.base_branch??'main','--title',this.config.pr_title,'--body-file',bodyFile]).trim();
    this.state.publication.url=url;this.save('published');return url;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,op,...args]=process.argv.slice(2);if(!root||!op)throw new Error('Usage: loop.mjs <task-directory> plan|step|apply|test|judge|publish|status [file/check]');
  if(!process.env.HR_JUDGED_LOCKED){const r=spawnSync('flock',['-n',path.join(root,'lock'),process.execPath,fileURLToPath(import.meta.url),root,op,...args],{env:{...process.env,HR_JUDGED_LOCKED:'1'},stdio:'inherit'});process.exit(r.status??1);}
  const loop=new JudgedLoop(root);
  try{if(op==='plan')loop.plan(args[0]);else if(op==='step')await loop.step();else if(op==='apply')loop.apply();else if(op==='test')loop.test(args.length?args:undefined);else if(op==='judge')loop.judge(args[0]);else if(op==='publish')loop.publish(args[0]);else if(op!=='status')throw new Error('unknown operation');}
  catch(e){loop.save('controller_error',{message:e.message});console.error(e.message);process.exitCode=1;}
  console.log(JSON.stringify({phase:loop.state.phase,round:loop.round?.index,run_id:loop.round?.run_id,failure:loop.round?.failure,checks:loop.round?.receipts?.map(x=>({name:x.name,status:x.status})),publication:loop.state.publication}));
}
